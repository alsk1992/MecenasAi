/**
 * Mecenas HTTP + WebSocket Server
 * Health, sessions, documents API, WebChat WebSocket
 */

import * as http from 'http';
import { timingSafeEqual } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { join, resolve, normalize } from 'path';
import { existsSync, readFileSync } from 'fs';
import { Document, Packer, Paragraph, TextRun, AlignmentType, Footer, Header, PageNumber, SectionType } from 'docx';
import { logger } from '../utils/logger.js';
import { generateId } from '../utils/id.js';
import type { Config, IncomingMessage } from '../types.js';
import type { Database } from '../db/index.js';
import { detectPii } from '../privacy/detector.js';
import { queryAuditLog } from '../privacy/audit.js';

interface WebChatCallbacks {
  onWebChatMessage: (message: IncomingMessage) => Promise<void>;
  onCancel?: (chatId: string) => boolean;
  onSessionExpired?: (key: string) => void;
  setWebChatSend: (fn: (chatId: string, text: string) => void) => void;
  setWebChatBroadcast: (fn: (text: string) => void) => void;
}

export interface HttpServer {
  start(port: number, bind: string, callbacks: WebChatCallbacks): Promise<void>;
  stop(): Promise<void>;
}

export function createServer(config: Config, db: Database): HttpServer {
  let server: http.Server | null = null;
  let wss: WebSocketServer | null = null;
  const clients = new Map<string, WebSocket>();
  let sessionTtlTimer: NodeJS.Timeout | null = null;
  let wsPingTimer: NodeJS.Timeout | null = null;

  /** Constant-time string comparison to prevent timing attacks */
  function safeCompare(a: string, b: string): boolean {
    try {
      const bufA = Buffer.from(a);
      const bufB = Buffer.from(b);
      // Pad shorter buffer so timingSafeEqual always runs (no length leak)
      if (bufA.length !== bufB.length) {
        const padded = Buffer.alloc(bufA.length);
        bufB.copy(padded, 0, 0, Math.min(bufB.length, bufA.length));
        return timingSafeEqual(bufA, padded) && bufA.length === bufB.length;
      }
      return timingSafeEqual(bufA, bufB);
    } catch {
      return false;
    }
  }

  /** Check if a request has a valid auth token (for API endpoints) */
  function checkApiAuth(req: http.IncomingMessage): boolean {
    const authMode = config.gateway.auth ?? 'off';
    if (authMode === 'off') return true;

    const token = config.gateway.token;
    if (!token) return true; // no token configured = open access

    const authHeader = req.headers.authorization ?? '';
    if (authHeader.startsWith('Bearer ')) {
      return safeCompare(authHeader.slice(7), token);
    }
    // Also check query param for simple access
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
    return safeCompare(url.searchParams.get('token') ?? '', token);
  }

  /** Read JSON body from request with size limit and error handling */
  function readJsonBody(req: http.IncomingMessage, res: http.ServerResponse, cb: (data: Record<string, unknown>) => void): void {
    let body = '';
    let size = 0;
    const MAX = 1_048_576;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) { req.destroy(); return; }
      body += chunk;
    });
    req.on('error', () => {
      if (!res.headersSent) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Błąd odczytu' })); }
    });
    req.on('end', () => {
      if (res.headersSent) return;
      let data: Record<string, unknown> = {};
      if (body) {
        try { data = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Nieprawidłowy JSON' }));
          return;
        }
      }
      // Enforce field-level string length limits to prevent oversized inputs
      const MAX_FIELD_LEN = 100_000;
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string' && v.length > MAX_FIELD_LEN) {
          data[k] = v.slice(0, MAX_FIELD_LEN);
        }
      }
      cb(data);
    });
  }

  /** Parse pagination params from URL. Returns paginated result wrapper. */
  function paginate<T>(items: T[], url: URL): { data: T[]; total: number; page: number; limit: number } {
    const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50));
    const start = (page - 1) * limit;
    return { data: items.slice(start, start + limit), total: items.length, page, limit };
  }

  return {
    async start(port, bind, callbacks) {
      server = http.createServer((req, res) => {
        // Security headers
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self'");
        res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
        if (config.privacy.hstsEnabled) {
          res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        }

        // CORS
        const corsOrigins = config.gateway.cors ?? ['*'];
        const origin = req.headers.origin ?? '';
        if (corsOrigins.includes('*')) {
          res.setHeader('Access-Control-Allow-Origin', '*');
        } else if (origin && corsOrigins.includes(origin)) {
          res.setHeader('Access-Control-Allow-Origin', origin);
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        const pathname = url.pathname;

        // Static files for WebChat — no auth required
        if (pathname.startsWith('/webchat')) {
          serveWebChat(req, res, pathname);
          return;
        }

        // Health — no auth required
        if (pathname === '/health' || pathname === '/api/health') {
          let dbOk = false;
          try { dbOk = !!db.raw().exec('SELECT 1'); } catch { /* db down */ }
          const articleCount = dbOk ? db.countArticles() : 0;
          const wsClients = wss?.clients?.size ?? 0;
          const telegramConfigured = !!config.channels.telegram?.token;
          const overall = dbOk ? 'ok' : 'degraded';
          res.writeHead(overall === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: overall,
            service: 'mecenas',
            timestamp: new Date().toISOString(),
            uptime: Math.floor(process.uptime()),
            components: {
              database: dbOk ? 'ok' : 'error',
              knowledgeBase: articleCount > 0 ? `ok (${articleCount} artykułów)` : 'empty',
              telegram: telegramConfigured ? 'configured' : 'not-configured',
              websocket: `ok (${wsClients} połączeń)`,
            },
          }));
          return;
        }

        // Auth check for API routes
        if (pathname.startsWith('/api/') && !checkApiAuth(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Brak autoryzacji. Podaj token w nagłówku Authorization: Bearer <token>.' }));
          return;
        }

        // ===== CHAT SESSIONS API =====

        // List sessions for user
        if (pathname === '/api/chat/sessions' && req.method === 'GET') {
          const userId = url.searchParams.get('userId') ?? '';
          const sessions = db.listSessionsForUser(userId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ sessions }));
          return;
        }

        // Create new session
        if (pathname === '/api/chat/sessions' && req.method === 'POST') {
          readJsonBody(req, res, (data) => {
            const userId = (data.userId as string) ?? `anon_${Date.now()}`;
            const key = `webchat:${generateId('wc')}`;
            db.upsertUser(userId);
            db.upsertSession({
              key,
              userId,
              channel: 'webchat',
              chatId: key.replace('webchat:', ''),
              messages: [],
              createdAt: new Date(),
              updatedAt: new Date(),
            });
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: key, title: null }));
          });
          return;
        }

        // Get, Update, Delete single session
        if (pathname.startsWith('/api/chat/sessions/') && pathname.split('/').length === 5) {
          const sessionKey = decodeURIComponent(pathname.split('/')[4]);

          if (req.method === 'GET') {
            const session = db.getSession(sessionKey);
            if (!session) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Sesja nie znaleziona' }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: session.key,
              messages: session.messages,
              title: (session.metadata as Record<string, unknown>)?.title ?? null,
              updatedAt: session.updatedAt.getTime(),
            }));
            return;
          }

          if (req.method === 'PATCH') {
            readJsonBody(req, res, (data) => {
              if (data.title) {
                db.updateSessionTitle(sessionKey, String(data.title));
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
            });
            return;
          }

          if (req.method === 'DELETE') {
            db.deleteSession(sessionKey);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            return;
          }
        }

        // Document Upload API
        if (pathname === '/api/documents/upload' && req.method === 'POST') {
          // Accept file as raw binary body. Metadata via query params.
          // Max 10MB for uploaded documents.
          const MAX_UPLOAD = 10 * 1024 * 1024;
          const chunks: Buffer[] = [];
          let totalSize = 0;
          let aborted = false;
          req.on('data', (chunk: Buffer) => {
            totalSize += chunk.length;
            if (totalSize > MAX_UPLOAD) {
              aborted = true;
              req.destroy();
              if (!res.headersSent) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Plik zbyt duży (max 10MB)' }));
              }
              return;
            }
            chunks.push(chunk);
          });
          req.on('end', async () => {
            if (aborted || res.headersSent) return;
            const buffer = Buffer.concat(chunks);
            const filename = decodeURIComponent(url.searchParams.get('filename') ?? 'dokument');
            const caseId = url.searchParams.get('caseId') ?? undefined;
            const ext = filename.split('.').pop()?.toLowerCase() ?? '';

            let extractedText = '';
            try {
              if (ext === 'pdf') {
                const { extractText } = await import('unpdf');
                const pdfResult = await extractText(buffer);
                const pdfText = pdfResult.text;
                extractedText = Array.isArray(pdfText) ? pdfText.join('\n') : String(pdfText ?? '');
              } else if (ext === 'docx') {
                const mammoth = await import('mammoth') as any;
                const result = await mammoth.extractRawText({ buffer });
                extractedText = result.value ?? '';
              } else if (ext === 'txt' || ext === 'md' || ext === 'csv') {
                extractedText = buffer.toString('utf-8');
              } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Nieobsługiwany format pliku: .${ext}. Obsługiwane: PDF, DOCX, TXT.` }));
                return;
              }
            } catch (err: any) {
              logger.warn({ err, filename }, 'Document parsing error');
              res.writeHead(422, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Nie udało się odczytać pliku: ${err?.message?.slice(0, 200) ?? 'nieznany błąd'}` }));
              return;
            }

            if (!extractedText.trim()) {
              res.writeHead(422, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Plik nie zawiera tekstu (może być zeskanowany obraz — OCR nie jest jeszcze obsługiwany).' }));
              return;
            }

            // Store as document in DB
            const doc = db.createDocument({
              caseId,
              type: 'inne',
              title: `[Przesłany] ${filename}`,
              content: extractedText.slice(0, 200_000), // cap at 200K chars
              status: 'szkic',
              version: 1,
            });

            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              document: { id: doc.id, title: doc.title, chars: extractedText.length },
              message: `Plik "${filename}" przesłany i przetworzony. ${extractedText.length} znaków wyodrębnionego tekstu.`,
            }));
          });
          req.on('error', () => {
            if (!res.headersSent) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Błąd przesyłania pliku' }));
            }
          });
          return;
        }

        // Documents API
        if (pathname === '/api/documents' && req.method === 'GET') {
          const status = url.searchParams.get('status') ?? undefined;
          const caseId = url.searchParams.get('caseId') ?? undefined;
          const type = url.searchParams.get('type') ?? undefined;
          const docs = db.listDocuments({ status, caseId, type });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(paginate(docs, url)));
          return;
        }

        if (pathname.startsWith('/api/documents/') && req.method === 'GET') {
          const parts = pathname.split('/');
          const id = parts[3];
          if (parts[4] === 'versions') {
            const versions = db.getDocumentVersions(id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(versions));
            return;
          }
          const doc = db.getDocument(id);
          if (!doc) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Dokument nie znaleziony' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(doc));
          return;
        }

        if (pathname.startsWith('/api/documents/') && req.method === 'POST') {
          const parts = pathname.split('/');
          const id = parts[3];
          const action = parts[4];

          let body = '';
          let bodySize = 0;
          const MAX_BODY = 1_048_576; // 1 MB
          req.on('data', (chunk) => {
            bodySize += chunk.length;
            if (bodySize > MAX_BODY) {
              res.writeHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Zbyt duże żądanie' }));
              req.destroy();
              return;
            }
            body += chunk;
          });
          req.on('error', () => {
            if (!res.headersSent) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Błąd odczytu żądania' }));
            }
          });
          req.on('end', () => {
            if (res.headersSent) return;
            if (action === 'approve') {
              const doc = db.updateDocument(id, { status: 'zatwierdzony' });
              if (!doc) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Dokument nie znaleziony' }));
                return;
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(doc));
            } else if (action === 'reject') {
              let data: Record<string, unknown> = {};
              if (body) {
                try { data = JSON.parse(body); } catch {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'Nieprawidłowy JSON' }));
                  return;
                }
              }
              const doc = db.updateDocument(id, { status: 'szkic', notes: data.notes as string | undefined });
              if (!doc) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Dokument nie znaleziony' }));
                return;
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(doc));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Nieznana akcja' }));
            }
          });
          return;
        }

        // Document DELETE
        if (pathname.startsWith('/api/documents/') && req.method === 'DELETE') {
          const parts = pathname.split('/');
          const id = parts[3];
          const doc = db.getDocument(id);
          if (!doc) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Dokument nie znaleziony' }));
            return;
          }
          if (doc.status === 'zatwierdzony' || doc.status === 'zlozony') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Nie można usunąć dokumentu o statusie "${doc.status}"` }));
            return;
          }
          db.deleteDocument(id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          return;
        }

        // Document DOCX export
        if (pathname.startsWith('/api/documents/') && pathname.endsWith('/export') && req.method === 'GET') {
          const parts = pathname.split('/');
          const id = parts[3];
          const doc = db.getDocument(id);
          if (!doc) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Dokument nie znaleziony' }));
            return;
          }
          generateDocx(doc, db).then((buffer) => {
            const filename = `${doc.title.replace(/[^a-zA-Z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ\s_-]/g, '').trim().replace(/\s+/g, '_')}.docx`;
            res.writeHead(200, {
              'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'Content-Disposition': `attachment; filename="${filename}"`,
              'Content-Length': buffer.length,
            });
            res.end(buffer);
          }).catch((err) => {
            logger.error({ err, docId: id }, 'DOCX export failed');
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Błąd generowania DOCX' }));
          });
          return;
        }

        // Cases API
        if (pathname === '/api/cases' && req.method === 'GET') {
          const search = url.searchParams.get('search');
          let cases;
          if (search) {
            cases = db.searchCases(search);
          } else {
            const status = url.searchParams.get('status') ?? undefined;
            const clientId = url.searchParams.get('clientId') ?? undefined;
            const lawArea = url.searchParams.get('lawArea') ?? undefined;
            cases = db.listCases({ status, clientId, lawArea });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(paginate(cases, url)));
          return;
        }
        if (pathname === '/api/cases' && req.method === 'POST') {
          readJsonBody(req, res, (data) => {
            if (!data.clientId || !data.title) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'clientId i title są wymagane' }));
              return;
            }
            const c = db.createCase({
              clientId: data.clientId as string,
              title: data.title as string,
              lawArea: ((data.lawArea as string) ?? 'cywilne') as any,
              status: 'nowa',
              sygnatura: data.sygnatura as string | undefined,
              court: data.court as string | undefined,
              description: data.description as string | undefined,
              opposingParty: data.opposingParty as string | undefined,
              valueOfDispute: data.valueOfDispute as number | undefined,
            });
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(c));
          });
          return;
        }
        if (pathname.startsWith('/api/cases/') && pathname.split('/').length === 4) {
          const caseId = decodeURIComponent(pathname.split('/')[3]);
          if (req.method === 'GET') {
            const c = db.getCase(caseId);
            if (!c) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Sprawa nie znaleziona' })); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(c));
            return;
          }
          if (req.method === 'PATCH') {
            readJsonBody(req, res, (data) => {
              const updated = db.updateCase(caseId, data as any);
              if (!updated) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Sprawa nie znaleziona' })); return; }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(updated));
            });
            return;
          }
          if (req.method === 'DELETE') {
            if (!db.getCase(caseId)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Sprawa nie znaleziona' })); return; }
            db.deleteCase(caseId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            return;
          }
        }

        // Deadlines API
        if (pathname === '/api/deadlines' && req.method === 'GET') {
          const upcoming = url.searchParams.get('upcoming') === 'true';
          const caseId = url.searchParams.get('caseId') ?? undefined;
          const deadlines = db.listDeadlines({ upcoming, caseId });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(paginate(deadlines, url)));
          return;
        }
        if (pathname === '/api/deadlines' && req.method === 'POST') {
          readJsonBody(req, res, (data) => {
            if (!data.caseId || !data.title || !data.date) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'caseId, title i date są wymagane' }));
              return;
            }
            const parsedDate = new Date(data.date as string);
            if (isNaN(parsedDate.getTime())) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Nieprawidłowy format daty' }));
              return;
            }
            const dl = db.createDeadline({
              caseId: data.caseId as string,
              title: data.title as string,
              date: parsedDate,
              type: ((data.type as string) ?? 'procesowy') as any,
              completed: false,
              reminderDaysBefore: (data.reminderDaysBefore as number) ?? 3,
            });
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(dl));
          });
          return;
        }
        if (pathname.match(/^\/api\/deadlines\/[^/]+\/complete$/) && req.method === 'POST') {
          const dlId = decodeURIComponent(pathname.split('/')[3]);
          db.completeDeadline(dlId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          return;
        }
        // Individual deadline: GET, PATCH, DELETE
        if (pathname.match(/^\/api\/deadlines\/[^/]+$/) && !pathname.endsWith('/complete')) {
          const dlId = decodeURIComponent(pathname.split('/')[3]);
          if (req.method === 'GET') {
            const deadlines = db.listDeadlines({});
            const dl = deadlines.find(d => d.id === dlId);
            if (!dl) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Termin nie znaleziony' })); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(dl));
            return;
          }
          if (req.method === 'PATCH') {
            readJsonBody(req, res, (data) => {
              if (data.date) {
                const d = new Date(data.date as string);
                if (isNaN(d.getTime())) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Nieprawidłowy format daty' })); return; }
                data.date = d;
              }
              const updated = db.updateDeadline(dlId, data as any);
              if (!updated) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Termin nie znaleziony' })); return; }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(updated));
            });
            return;
          }
          if (req.method === 'DELETE') {
            db.deleteDeadline(dlId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            return;
          }
        }

        // Clients API
        if (pathname === '/api/clients' && req.method === 'GET') {
          const q = url.searchParams.get('q');
          const clientList = q ? db.searchClients(q) : db.listClients();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(paginate(clientList, url)));
          return;
        }
        if (pathname === '/api/clients' && req.method === 'POST') {
          readJsonBody(req, res, (data) => {
            if (!data.name || !data.type) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'name i type są wymagane' }));
              return;
            }
            const client = db.createClient({
              name: data.name as string,
              type: data.type as any,
              pesel: data.pesel as string | undefined,
              nip: data.nip as string | undefined,
              regon: data.regon as string | undefined,
              krs: data.krs as string | undefined,
              email: data.email as string | undefined,
              phone: data.phone as string | undefined,
              address: data.address as string | undefined,
            });
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(client));
          });
          return;
        }
        if (pathname.startsWith('/api/clients/') && pathname.split('/').length === 4) {
          const clientId = decodeURIComponent(pathname.split('/')[3]);
          if (req.method === 'GET') {
            const client = db.getClient(clientId);
            if (!client) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Klient nie znaleziony' })); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(client));
            return;
          }
          if (req.method === 'PATCH') {
            readJsonBody(req, res, (data) => {
              const updated = db.updateClient(clientId, data as any);
              if (!updated) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Klient nie znaleziony' })); return; }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(updated));
            });
            return;
          }
          if (req.method === 'DELETE') {
            if (!db.getClient(clientId)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Klient nie znaleziony' })); return; }
            db.deleteClient(clientId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            return;
          }
        }

        // Time Entries API
        if (pathname === '/api/time-entries' && req.method === 'GET') {
          const teCaseId = url.searchParams.get('caseId');
          if (!teCaseId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'caseId jest wymagane' })); return; }
          const entries = db.listTimeEntries(teCaseId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(entries));
          return;
        }
        if (pathname === '/api/time-entries' && req.method === 'POST') {
          readJsonBody(req, res, (data) => {
            if (!data.caseId || !data.description || !data.durationMinutes) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'caseId, description i durationMinutes są wymagane' }));
              return;
            }
            const entry = db.createTimeEntry({
              caseId: data.caseId as string,
              description: data.description as string,
              durationMinutes: data.durationMinutes as number,
              hourlyRate: data.hourlyRate as number | undefined,
              date: data.date ? new Date(data.date as string) : new Date(),
            });
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(entry));
          });
          return;
        }

        // Invoices API
        if (pathname === '/api/invoices' && req.method === 'GET') {
          const invoices = db.listInvoices({
            clientId: url.searchParams.get('clientId') ?? undefined,
            caseId: url.searchParams.get('caseId') ?? undefined,
            status: url.searchParams.get('status') ?? undefined,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(paginate(invoices, url)));
          return;
        }
        if (pathname === '/api/invoices' && req.method === 'POST') {
          readJsonBody(req, res, (data) => {
            if (!data.clientId || !data.number || data.amount == null) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'clientId, number i amount są wymagane' }));
              return;
            }
            const amount = Number(data.amount);
            if (!Number.isFinite(amount) || amount < 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Kwota musi być liczbą >= 0' }));
              return;
            }
            const dueDays = Number(data.dueDays ?? 14);
            const issuedAt = new Date();
            const dueAt = new Date(issuedAt.getTime() + dueDays * 24 * 60 * 60 * 1000);
            const invoice = db.createInvoice({
              clientId: data.clientId as string,
              caseId: data.caseId as string | undefined,
              number: data.number as string,
              amount,
              currency: ((data.currency as string) ?? 'PLN').toUpperCase(),
              status: 'szkic',
              issuedAt,
              dueAt,
              notes: data.notes as string | undefined,
            });
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(invoice));
          });
          return;
        }
        if (pathname.startsWith('/api/invoices/') && pathname.split('/').length === 4) {
          const invoiceId = decodeURIComponent(pathname.split('/')[3]);
          if (req.method === 'GET') {
            const inv = db.getInvoice(invoiceId);
            if (!inv) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Faktura nie znaleziona' })); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(inv));
            return;
          }
          if (req.method === 'PATCH') {
            readJsonBody(req, res, (data) => {
              const updated = db.updateInvoice(invoiceId, data as any);
              if (!updated) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Faktura nie znaleziona' })); return; }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(updated));
            });
            return;
          }
        }

        // Knowledge API
        if (pathname === '/api/knowledge/search' && req.method === 'GET') {
          const q = url.searchParams.get('q') ?? '';
          const code = url.searchParams.get('code') ?? undefined;
          const articles = db.searchArticles(q, code, 20);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(articles));
          return;
        }

        if (pathname === '/api/knowledge/stats' && req.method === 'GET') {
          const codes = ['KC', 'KPC', 'KK', 'KP', 'KRO', 'KSH', 'KPA'];
          const stats = codes.map(code => ({
            code,
            count: db.countArticles(code),
          }));
          const total = db.countArticles();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ total, byCodes: stats }));
          return;
        }

        // Templates API
        if (pathname === '/api/templates' && req.method === 'GET') {
          const type = url.searchParams.get('type') ?? undefined;
          const lawArea = url.searchParams.get('lawArea') ?? undefined;
          const q = url.searchParams.get('q') ?? undefined;
          const templates = db.listTemplates({ type, lawArea, query: q });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(templates));
          return;
        }
        if (pathname === '/api/templates' && req.method === 'POST') {
          readJsonBody(req, res, (data) => {
            if (!data.name || !data.type || !data.content) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'name, type i content są wymagane' }));
              return;
            }
            const tmpl = db.createTemplate({
              name: data.name as string,
              type: data.type as any,
              content: data.content as string,
              description: data.description as string | undefined,
              lawArea: (data.lawArea as string | undefined) as any,
              tags: Array.isArray(data.tags) ? (data.tags as string[]).join(',') : data.tags as string | undefined,
            });
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(tmpl));
          });
          return;
        }
        if (pathname.startsWith('/api/templates/') && pathname.split('/').length === 4) {
          const tmplId = decodeURIComponent(pathname.split('/')[3]);
          if (req.method === 'GET') {
            const tmpl = db.getTemplate(tmplId);
            if (!tmpl) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Szablon nie znaleziony' })); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(tmpl));
            return;
          }
          if (req.method === 'DELETE') {
            db.deleteTemplate(tmplId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            return;
          }
        }

        // ── Legal Calculators API (stateless, no auth required) ──
        if (pathname === '/api/calc/court-fee' && req.method === 'GET') {
          const amount = parseFloat(url.searchParams.get('amount') ?? '0');
          const caseType = url.searchParams.get('type') ?? 'cywilna';
          if (!Number.isFinite(amount) || amount < 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Parametr amount jest wymagany (liczba >= 0)' }));
            return;
          }
          let fee = 0;
          let basis = '';
          if (caseType === 'rozwodowa') { fee = 600; basis = 'Art. 26 UKSC'; }
          else if (caseType === 'spadkowa') { fee = 100; basis = 'Art. 49 UKSC'; }
          else if (caseType === 'rejestrowa_krs') { fee = 500; basis = 'Art. 52 UKSC'; }
          else if (caseType === 'wieczystoksiegowa') { fee = 200; basis = 'Art. 42 UKSC'; }
          else if (caseType === 'nakazowa') { fee = Math.max(30, Math.round(amount * 0.05 * 0.25)); basis = 'Art. 13+19 UKSC (1/4)'; }
          else if (caseType === 'zażalenie') { fee = Math.max(30, Math.round(amount * 0.05 * 0.2)); basis = 'Art. 13+19 UKSC (1/5)'; }
          else { fee = Math.min(200000, Math.max(30, Math.round(amount * 0.05))); basis = 'Art. 13 UKSC (5%)'; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ amount, case_type: caseType, court_fee: fee, basis }));
          return;
        }

        if (pathname === '/api/calc/interest' && req.method === 'GET') {
          const principal = parseFloat(url.searchParams.get('principal') ?? '0');
          const startStr = url.searchParams.get('from') ?? '';
          const endStr = url.searchParams.get('to') ?? new Date().toISOString().slice(0, 10);
          const interestType = url.searchParams.get('type') ?? 'za_opoznienie';
          if (!Number.isFinite(principal) || principal <= 0 || !startStr) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Parametry principal i from są wymagane' }));
            return;
          }
          const startMs = Date.parse(startStr);
          const endMs = Date.parse(endStr);
          if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Nieprawidłowe daty' }));
            return;
          }
          const rates: Record<string, number> = { ustawowe: 9.25, za_opoznienie: 11.25, handlowe: 15.75 };
          const rate = rates[interestType] ?? 11.25;
          const days = Math.floor((endMs - startMs) / 86_400_000);
          const interest = principal * (rate / 100) * (days / 365);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ principal, rate, days, interest: +interest.toFixed(2), total: +(principal + interest).toFixed(2) }));
          return;
        }

        if (pathname === '/api/calc/limitation' && req.method === 'GET') {
          const claimType = url.searchParams.get('type') ?? 'ogolne';
          const startStr = url.searchParams.get('from') ?? '';
          if (!startStr) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Parametr from jest wymagany' }));
            return;
          }
          const startMs = Date.parse(startStr);
          if (isNaN(startMs)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Nieprawidłowa data' }));
            return;
          }
          const rules: Record<string, { years: number; eoy: boolean }> = {
            ogolne: { years: 6, eoy: true }, gospodarcze: { years: 3, eoy: true },
            okresowe: { years: 3, eoy: true }, sprzedaz: { years: 2, eoy: true },
            przewoz: { years: 1, eoy: false }, delikt: { years: 3, eoy: true },
            praca: { years: 3, eoy: false }, najem: { years: 1, eoy: false },
            zlecenie: { years: 2, eoy: true }, dzielo: { years: 2, eoy: false },
          };
          const rule = rules[claimType] ?? rules.ogolne;
          const limitDate = new Date(startMs);
          limitDate.setFullYear(limitDate.getFullYear() + rule.years);
          if (rule.eoy) { limitDate.setMonth(11); limitDate.setDate(31); }
          const expired = limitDate < new Date();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ claim_type: claimType, start_date: startStr, limitation_date: limitDate.toISOString().slice(0, 10), expired }));
          return;
        }

        // ── Privacy Status ──
        if (pathname === '/api/privacy/status' && req.method === 'GET') {
          if (!checkApiAuth(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
          }
          // Check if Ollama is reachable (async, use .then)
          const ollamaCheck = new Promise<boolean>((resolve) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => { controller.abort(); resolve(false); }, 3_000);
            fetch(`${config.agent.ollamaUrl}/api/tags`, { signal: controller.signal })
              .then(r => { clearTimeout(timeout); resolve(r.ok); })
              .catch(() => { clearTimeout(timeout); resolve(false); });
          });
          ollamaCheck.then((ollamaUp) => {
            if (res.headersSent) return;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              mode: config.privacy.mode,
              blockCloudOnPii: config.privacy.blockCloudOnPii,
              anonymizeForCloud: config.privacy.anonymizeForCloud,
              stripActiveCaseForCloud: config.privacy.stripActiveCaseForCloud,
              ollamaAvailable: ollamaUp,
              anthropicConfigured: !!config.agent.anthropicKey,
            }));
          });
          return;
        }

        // ── Privacy PII Check (POST) ──
        if (pathname === '/api/privacy/check' && req.method === 'POST') {
          if (!checkApiAuth(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
          }
          readJsonBody(req, res, (data) => {
            const text = String(data.text ?? '').slice(0, 100_000);
            const result = detectPii(text);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              hasPii: result.hasPii,
              hasSensitiveKeywords: result.hasSensitiveKeywords,
              piiTypes: [...new Set(result.matches.map(m => m.type))],
              keywords: result.keywords,
              matchCount: result.matches.length,
            }));
          });
          return;
        }

        // ── Privacy Audit Log ──
        if (pathname === '/api/privacy/audit' && req.method === 'GET') {
          if (!checkApiAuth(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
          }
          const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 500));
          const action = url.searchParams.get('action') ?? undefined;
          const since = url.searchParams.get('since') ? parseInt(url.searchParams.get('since')!, 10) : undefined;
          const entries = queryAuditLog({ action: action as any, since, limit });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ entries, count: entries.length }));
          return;
        }

        // 404
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      });

      // WebSocket for WebChat
      const wssCorsOrigins = config.gateway.cors ?? ['*'];
      wss = new WebSocketServer({
        server,
        path: '/ws',
        maxPayload: 1_048_576, // 1MB max WS message
        verifyClient: (info: { req: http.IncomingMessage }) => {
          if (wssCorsOrigins.includes('*')) return true;
          const reqOrigin = info.req.headers.origin ?? '';
          return wssCorsOrigins.includes(reqOrigin);
        },
      });

      const wsRateLimit = config.http?.rateLimitPerMin ?? 60;
      const webchatToken = config.channels.webchat?.token;
      const requireAuth = !!webchatToken;

      // Server-side ping to detect dead connections (every 30s)
      const WS_PING_INTERVAL = 30_000;
      const WS_PONG_TIMEOUT = 10_000;
      const WS_MAX_MESSAGE_SIZE = 1_048_576; // 1 MB

      wsPingTimer = setInterval(() => {
        for (const [id, ws] of clients) {
          if ((ws as any)._mecenasAlive === false) {
            logger.info({ chatId: id }, 'Dead WebSocket connection removed');
            clients.delete(id);
            try { ws.terminate(); } catch {}
            continue;
          }
          (ws as any)._mecenasAlive = false;
          try { ws.ping(); } catch {}
        }
      }, WS_PING_INTERVAL);

      wss.on('connection', (ws) => {
        const chatId = generateId('webchat');
        let authenticated = !requireAuth; // auto-auth if no token configured
        let msgCount = 0;
        let rateLimitResetAt = Date.now() + 60_000;
        (ws as any)._mecenasAlive = true;

        ws.on('pong', () => { (ws as any)._mecenasAlive = true; });

        logger.info({ chatId, requireAuth }, 'WebChat client connected');

        // If no auth required, immediately register and send authenticated
        if (authenticated) {
          clients.set(chatId, ws);
          ws.send(JSON.stringify({
            type: 'authenticated',
            chatId,
            message: 'Witaj w Mecenasie! Jestem Twoim asystentem prawnym AI.',
            privacyMode: config.privacy.mode,
          }));
        }

        ws.on('message', async (data) => {
          try {
            const raw = data.toString();
            if (raw.length > WS_MAX_MESSAGE_SIZE) {
              ws.send(JSON.stringify({ type: 'error', message: 'Wiadomość za duża (maks. 1 MB).' }));
              return;
            }
            const msg = JSON.parse(raw);

            // Auth handshake
            if (msg.type === 'auth') {
              if (requireAuth && !safeCompare(String(msg.token ?? ''), webchatToken ?? '')) {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
                ws.close(4001, 'Invalid token');
                return;
              }
              if (!authenticated) {
                authenticated = true;
                clients.set(chatId, ws);
                ws.send(JSON.stringify({
                  type: 'authenticated',
                  chatId,
                  message: 'Witaj w Mecenasie! Jestem Twoim asystentem prawnym AI.',
                  privacyMode: config.privacy.mode,
                }));
              }
              return;
            }

            // Ignore pings (keep-alive)
            if (msg.type === 'ping') {
              ws.send(JSON.stringify({ type: 'pong' }));
              return;
            }

            // Reject unauthenticated messages
            if (!authenticated) {
              ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated. Send auth first.' }));
              return;
            }

            // Rate limiting
            const now = Date.now();
            if (now > rateLimitResetAt) {
              msgCount = 0;
              rateLimitResetAt = now + 60_000;
            }
            msgCount++;
            if (msgCount > wsRateLimit) {
              ws.send(JSON.stringify({ type: 'error', message: 'Zbyt wiele wiadomości. Odczekaj chwilę.' }));
              return;
            }

            // Session switch
            if (msg.type === 'switch') {
              const switchId = String(msg.sessionId ?? '').trim();
              if (!switchId) {
                ws.send(JSON.stringify({ type: 'error', message: 'Brak sessionId.' }));
                return;
              }
              ws.send(JSON.stringify({ type: 'switched', sessionId: switchId }));
              return;
            }

            // Cancel current request
            if (msg.type === 'cancel') {
              const cancelled = callbacks.onCancel?.(chatId) ?? false;
              ws.send(JSON.stringify({ type: 'cancelled', success: cancelled }));
              return;
            }

            // Privacy mode toggle (stored in session metadata)
            if (msg.type === 'privacy_mode') {
              let mode = String(msg.mode ?? '').trim();
              if (!['auto', 'strict', 'off'].includes(mode)) {
                ws.send(JSON.stringify({ type: 'error', message: 'Tryb prywatności musi być: auto, strict lub off.' }));
                return;
              }
              // Server-side enforcement: session mode cannot be less restrictive than global config
              // Restrictiveness order: strict > auto > off
              const RESTRICTIVENESS: Record<string, number> = { strict: 2, auto: 1, off: 0 };
              const globalLevel = RESTRICTIVENESS[config.privacy.mode] ?? 1;
              const requestedLevel = RESTRICTIVENESS[mode] ?? 1;
              if (requestedLevel < globalLevel) {
                mode = config.privacy.mode; // enforce floor
                ws.send(JSON.stringify({ type: 'error', message: `Tryb prywatności nie może być mniej restrykcyjny niż ustawienie globalne (${config.privacy.mode}).` }));
              }
              // Store in per-connection metadata — onWebChatMessage will pick it up via session
              (ws as any)._privacyMode = mode;
              ws.send(JSON.stringify({ type: 'privacy_mode_set', mode }));
              logger.info({ chatId, mode }, 'Privacy mode changed');
              return;
            }

            if (msg.type === 'message' && msg.text) {
              // Pass per-connection privacy mode in message metadata
              const privacyMode = (ws as any)._privacyMode as string | undefined;
              await callbacks.onWebChatMessage({
                id: `wc_${Date.now()}`,
                platform: 'webchat',
                userId: chatId,
                chatId,
                chatType: 'dm',
                text: msg.text,
                timestamp: new Date(),
                metadata: privacyMode ? { privacyMode } : undefined,
              });
            }
          } catch (err) {
            logger.warn({ err }, 'Invalid WebChat message');
          }
        });

        ws.on('close', () => {
          clients.delete(chatId);
        });

        ws.on('error', (err) => {
          logger.warn({ err, chatId }, 'WebChat error');
          clients.delete(chatId);
        });
      });

      callbacks.setWebChatSend((chatId: string, text: string) => {
        const ws = clients.get(chatId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'message', text }));
        }
      });

      callbacks.setWebChatBroadcast((text: string) => {
        const msg = JSON.stringify({ type: 'reminder', text });
        for (const [, ws] of clients) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(msg);
          }
        }
      });

      // Session TTL enforcement — clean up expired sessions every hour
      const ttlMs = config.session?.ttlMs ?? 24 * 60 * 60 * 1000;
      sessionTtlTimer = setInterval(() => {
        try {
          const cutoff = Date.now() - ttlMs;
          const expired = db.raw().exec(
            'SELECT key FROM sessions WHERE updated_at < ?', [cutoff]
          );
          if (expired.length && expired[0].values.length) {
            for (const row of expired[0].values) {
              const sessionKey = row[0] as string;
              db.deleteSession(sessionKey);
              callbacks.onSessionExpired?.(sessionKey);
            }
            logger.info({ count: expired[0].values.length }, 'Expired sessions cleaned up');
          }
        } catch (err) {
          logger.warn({ err }, 'Session TTL cleanup failed');
        }
      }, 3_600_000); // every hour

      const host = bind === 'all' ? '0.0.0.0' : '127.0.0.1';
      return new Promise<void>((resolve, reject) => {
        server!.on('error', reject);
        server!.listen(port, host, () => {
          logger.info({ port, host }, 'HTTP server listening');
          resolve();
        });
      });
    },

    async stop() {
      if (sessionTtlTimer) { clearInterval(sessionTtlTimer); sessionTtlTimer = null; }
      if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
      for (const [, ws] of clients) {
        try { ws.close(); } catch {}
      }
      clients.clear();

      if (wss) { wss.close(); wss = null; }

      return new Promise<void>((resolve) => {
        if (server) {
          server.close(() => resolve());
        } else {
          resolve();
        }
      });
    },
  };
}

function serveWebChat(_req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
  const webchatRoot = resolve(process.cwd(), 'public', 'webchat');
  let filePath: string;
  if (pathname === '/webchat' || pathname === '/webchat/') {
    filePath = join(webchatRoot, 'index.html');
  } else {
    const relative = normalize(pathname.replace('/webchat/', '')).replace(/^(\.\.(\/|\\))+/, '');
    filePath = resolve(webchatRoot, relative);
  }

  // Prevent path traversal — resolved path must be within webchatRoot
  if (!filePath.startsWith(webchatRoot)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  if (!existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(INLINE_WEBCHAT_HTML);
    return;
  }

  const content = readFileSync(filePath);
  const ext = filePath.split('.').pop();
  const mimeTypes: Record<string, string> = {
    html: 'text/html; charset=utf-8', css: 'text/css',
    js: 'application/javascript', json: 'application/json',
    png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon',
  };
  res.writeHead(200, { 'Content-Type': mimeTypes[ext ?? ''] ?? 'application/octet-stream' });
  res.end(content);
}

/** Polish date formatter */
function plDate(date: Date): string {
  return date.toLocaleDateString('pl-PL', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Standard paragraph style for court documents: Times New Roman 12pt, 1.5 line spacing */
const COURT_FONT = 'Times New Roman';
const COURT_SIZE = 24; // half-points (24 = 12pt)
const COURT_LINE_SPACING = 360; // 1.5 spacing in twips (240 * 1.5)

/**
 * Parse inline markdown (**bold**, *italic*, ***bold+italic***) into TextRun array.
 * Handles nested formatting. Falls back to plain text on parse issues.
 */
function parseInlineMarkdown(text: string): TextRun[] {
  const runs: TextRun[] = [];
  // Regex to match ***bold+italic***, **bold**, *italic* (non-greedy)
  const re = /(\*{1,3})((?:(?!\1).)+?)\1/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    // Text before the match
    if (match.index > lastIndex) {
      runs.push(new TextRun({ text: text.slice(lastIndex, match.index), font: COURT_FONT, size: COURT_SIZE }));
    }
    const stars = match[1].length;
    const inner = match[2];
    runs.push(new TextRun({
      text: inner,
      font: COURT_FONT,
      size: COURT_SIZE,
      bold: stars >= 2,
      italics: stars === 1 || stars === 3,
    }));
    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last match (or the entire string if no matches)
  if (lastIndex < text.length) {
    runs.push(new TextRun({ text: text.slice(lastIndex), font: COURT_FONT, size: COURT_SIZE }));
  }

  return runs.length > 0 ? runs : [new TextRun({ text, font: COURT_FONT, size: COURT_SIZE })];
}

async function generateDocx(doc: { title: string; content: string; type: string; status: string; caseId?: string }, db: Database): Promise<Buffer> {
  const legalCase = doc.caseId ? db.getCase(doc.caseId) : null;
  const client = legalCase ? db.getClient(legalCase.clientId) : null;
  const isDraft = doc.status === 'szkic' || doc.status === 'do_sprawdzenia';
  const MAX_DOCX_LINES = 10_000;
  const allLines = doc.content.split('\n');
  const lines = allLines.length > MAX_DOCX_LINES ? allLines.slice(0, MAX_DOCX_LINES) : allLines;

  // ===== TITLE PAGE (for formal court documents) =====
  const formalTypes = ['pozew', 'odpowiedz_na_pozew', 'apelacja', 'wezwanie_do_zaplaty', 'wniosek', 'pismo_procesowe'];
  const hasTitlePage = formalTypes.includes(doc.type) && legalCase;

  const titlePageChildren: Paragraph[] = [];

  if (hasTitlePage && legalCase) {
    // Top: Court name
    if (legalCase.court) {
      titlePageChildren.push(new Paragraph({
        children: [new TextRun({ text: legalCase.court, font: COURT_FONT, size: 28, bold: true })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 100 },
      }));
    }
    if (legalCase.sygnatura) {
      titlePageChildren.push(new Paragraph({
        children: [new TextRun({ text: `Sygn. akt: ${legalCase.sygnatura}`, font: COURT_FONT, size: COURT_SIZE, italics: true })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 400 },
      }));
    }

    // Spacer
    for (let i = 0; i < 6; i++) titlePageChildren.push(new Paragraph({ text: '' }));

    // Document type + title
    const typeLabels: Record<string, string> = {
      pozew: 'POZEW', odpowiedz_na_pozew: 'ODPOWIEDZ NA POZEW', apelacja: 'APELACJA',
      wezwanie_do_zaplaty: 'WEZWANIE DO ZAPLATY', wniosek: 'WNIOSEK', pismo_procesowe: 'PISMO PROCESOWE',
    };
    titlePageChildren.push(new Paragraph({
      children: [new TextRun({ text: typeLabels[doc.type] ?? doc.type.toUpperCase(), font: COURT_FONT, size: 36, bold: true })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
    }));
    titlePageChildren.push(new Paragraph({
      children: [new TextRun({ text: doc.title, font: COURT_FONT, size: 28 })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
    }));

    // Spacer
    for (let i = 0; i < 4; i++) titlePageChildren.push(new Paragraph({ text: '' }));

    // Case details
    if (client) {
      titlePageChildren.push(new Paragraph({
        children: [new TextRun({ text: `Klient: ${client.name}`, font: COURT_FONT, size: COURT_SIZE })],
        alignment: AlignmentType.CENTER,
      }));
    }
    titlePageChildren.push(new Paragraph({
      children: [new TextRun({ text: `Dziedzina: ${legalCase.lawArea}`, font: COURT_FONT, size: COURT_SIZE })],
      alignment: AlignmentType.CENTER,
    }));
    if (legalCase.valueOfDispute) {
      titlePageChildren.push(new Paragraph({
        children: [new TextRun({ text: `WPS: ${legalCase.valueOfDispute.toLocaleString('pl-PL')} PLN`, font: COURT_FONT, size: COURT_SIZE })],
        alignment: AlignmentType.CENTER,
      }));
    }

    // Spacer
    for (let i = 0; i < 6; i++) titlePageChildren.push(new Paragraph({ text: '' }));

    // Date
    titlePageChildren.push(new Paragraph({
      children: [new TextRun({ text: plDate(new Date()), font: COURT_FONT, size: COURT_SIZE })],
      alignment: AlignmentType.CENTER,
    }));

    // Draft watermark on title page
    if (isDraft) {
      titlePageChildren.push(new Paragraph({ text: '', spacing: { before: 400 } }));
      titlePageChildren.push(new Paragraph({
        children: [new TextRun({ text: 'PROJEKT — wymaga weryfikacji prawnika', font: COURT_FONT, size: 28, bold: true, color: 'FF0000' })],
        alignment: AlignmentType.CENTER,
      }));
    }
  }

  // ===== CONTENT SECTION =====
  const contentChildren: Paragraph[] = [];

  // Document title (on content page)
  contentChildren.push(new Paragraph({
    children: [new TextRun({ text: doc.title, font: COURT_FONT, size: 28, bold: true })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 300 },
  }));

  // Case info subtitle
  if (legalCase) {
    const infoParts = [
      legalCase.sygnatura ? `Sygn. akt: ${legalCase.sygnatura}` : null,
      legalCase.court ?? null,
    ].filter(Boolean);
    if (infoParts.length) {
      contentChildren.push(new Paragraph({
        children: [new TextRun({ text: infoParts.join(' | '), font: COURT_FONT, size: 20, italics: true })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
      }));
    }
  }

  // Separator line
  contentChildren.push(new Paragraph({ text: '', spacing: { after: 200 } }));

  // Content paragraphs (with markdown support)
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      contentChildren.push(new Paragraph({ text: '', spacing: { after: 80 } }));
      continue;
    }

    // Markdown headings: ## Heading → bold, larger
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingSize = level === 1 ? 32 : level === 2 ? 28 : 24;
      contentChildren.push(new Paragraph({
        children: [new TextRun({ text: headingMatch[2], font: COURT_FONT, size: headingSize, bold: true })],
        spacing: { before: level <= 2 ? 300 : 240, after: 120 },
      }));
      continue;
    }

    // Section headers: Roman numerals or ALL CAPS lines > 3 chars
    if (/^(I{1,3}V?|V|VI{0,3}|IX|X{0,3})\.\s/.test(trimmed) || (trimmed === trimmed.toUpperCase() && trimmed.length > 3 && !/^\d/.test(trimmed))) {
      contentChildren.push(new Paragraph({
        children: [new TextRun({ text: trimmed, font: COURT_FONT, size: COURT_SIZE, bold: true })],
        spacing: { before: 240, after: 120 },
      }));
      continue;
    }

    // Bullet lists: - item or * item
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      contentChildren.push(new Paragraph({
        children: parseInlineMarkdown(bulletMatch[1]),
        spacing: { after: 60, line: COURT_LINE_SPACING },
        indent: { left: 360 },
        bullet: { level: 0 },
      }));
      continue;
    }

    // Numbered items (1. 2. etc.)
    if (/^\d+[\.\)]\s/.test(trimmed)) {
      const numContent = trimmed.replace(/^\d+[\.\)]\s+/, '');
      contentChildren.push(new Paragraph({
        children: parseInlineMarkdown(numContent.length ? numContent : trimmed),
        spacing: { after: 80, line: COURT_LINE_SPACING },
        indent: { left: 360 },
      }));
      continue;
    }

    contentChildren.push(new Paragraph({
      children: parseInlineMarkdown(trimmed),
      spacing: { after: 80, line: COURT_LINE_SPACING },
    }));
  }

  // ===== SIGNATURE BLOCK =====
  contentChildren.push(new Paragraph({ text: '', spacing: { before: 600 } }));
  contentChildren.push(new Paragraph({ text: '', spacing: { before: 200 } }));

  // Right-aligned signature area
  contentChildren.push(new Paragraph({
    children: [new TextRun({ text: '____________________________', font: COURT_FONT, size: COURT_SIZE })],
    alignment: AlignmentType.RIGHT,
    spacing: { after: 40 },
  }));
  contentChildren.push(new Paragraph({
    children: [new TextRun({ text: '(podpis)', font: COURT_FONT, size: 18, italics: true, color: '666666' })],
    alignment: AlignmentType.RIGHT,
    spacing: { after: 40 },
  }));

  // Draft watermark (in content section for non-title-page docs)
  if (isDraft && !hasTitlePage) {
    contentChildren.push(new Paragraph({ text: '', spacing: { before: 400 } }));
    contentChildren.push(new Paragraph({
      children: [new TextRun({ text: 'PROJEKT — wymaga weryfikacji prawnika', font: COURT_FONT, size: 20, bold: true, italics: true, color: 'FF0000' })],
      alignment: AlignmentType.CENTER,
    }));
  }

  // ===== BUILD HEADER =====
  const headerChildren: Paragraph[] = [];
  if (legalCase?.sygnatura) {
    headerChildren.push(new Paragraph({
      children: [
        new TextRun({ text: `Sygn. akt: ${legalCase.sygnatura}`, font: COURT_FONT, size: 16, color: '999999' }),
      ],
      alignment: AlignmentType.RIGHT,
    }));
  }

  // ===== ASSEMBLE DOCUMENT =====
  const sections = [];

  // Title page section (if applicable)
  if (hasTitlePage && titlePageChildren.length) {
    sections.push({
      properties: {
        page: {
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      children: titlePageChildren,
    });
  }

  // Main content section
  sections.push({
    properties: {
      ...(hasTitlePage ? { type: SectionType.NEXT_PAGE } : {}),
      page: {
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      },
    },
    headers: headerChildren.length ? {
      default: new Header({ children: headerChildren }),
    } : undefined,
    children: contentChildren,
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ text: 'Mecenas — Asystent Prawny AI | Strona ', font: COURT_FONT, size: 16, color: '999999' }),
            new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '999999' }),
          ],
        })],
      }),
    },
  });

  const document = new Document({ sections });
  return Buffer.from(await Packer.toBuffer(document));
}

const INLINE_WEBCHAT_HTML = `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mecenas — Asystent Prawny AI</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }
    .header { background: #16213e; padding: 16px 24px; border-bottom: 1px solid #0f3460; display: flex; align-items: center; gap: 12px; }
    .header h1 { font-size: 20px; color: #e94560; }
    .header span { color: #888; font-size: 14px; }
    .messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
    .msg { max-width: 80%; padding: 12px 16px; border-radius: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
    .msg.user { background: #0f3460; align-self: flex-end; border-bottom-right-radius: 4px; }
    .msg.assistant { background: #16213e; align-self: flex-start; border-bottom-left-radius: 4px; border: 1px solid #0f3460; }
    .msg.system { background: transparent; align-self: center; color: #888; font-size: 13px; text-align: center; }
    .input-area { background: #16213e; padding: 16px 24px; border-top: 1px solid #0f3460; display: flex; gap: 12px; }
    .input-area input { flex: 1; background: #1a1a2e; border: 1px solid #0f3460; border-radius: 8px; padding: 12px 16px; color: #e0e0e0; font-size: 15px; outline: none; }
    .input-area input:focus { border-color: #e94560; }
    .input-area button { background: #e94560; color: white; border: none; border-radius: 8px; padding: 12px 20px; font-size: 15px; cursor: pointer; }
    .input-area button:hover { background: #c73e54; }
    .input-area button:disabled { opacity: 0.5; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="header"><h1>Mecenas</h1><span>Asystent Prawny AI</span></div>
  <div class="messages" id="messages"></div>
  <div class="input-area">
    <input type="text" id="input" placeholder="Napisz wiadomość..." autofocus />
    <button id="send" onclick="sendMsg()">Wyślij</button>
  </div>
  <script>
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('input');
    const sendBtn = document.getElementById('send');
    let ws = null, chatId = null;
    function addMsg(text, cls) {
      const div = document.createElement('div');
      div.className = 'msg ' + cls;
      div.textContent = text;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/ws');
      ws.onopen = () => addMsg('Polaczono z Mecenasem', 'system');
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'authenticated') { chatId = msg.chatId; addMsg(msg.message, 'system'); }
        else if (msg.type === 'message' || msg.type === 'reminder') { addMsg(msg.text, 'assistant'); sendBtn.disabled = false; }
      };
      ws.onclose = () => { addMsg('Rozlaczono. Odswiezam...', 'system'); setTimeout(connect, 2000); };
      ws.onerror = () => {};
    }
    function sendMsg() {
      const text = inputEl.value.trim();
      if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
      addMsg(text, 'user');
      ws.send(JSON.stringify({ type: 'message', text }));
      inputEl.value = '';
      sendBtn.disabled = true;
    }
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMsg(); });
    connect();
  </script>
</body>
</html>`;
