/**
 * Mecenas HTTP + WebSocket Server
 * Health, sessions, documents API, WebChat WebSocket
 */

import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Footer, PageNumber } from 'docx';
import { logger } from '../utils/logger.js';
import type { Config, IncomingMessage } from '../types.js';
import type { Database } from '../db/index.js';

interface WebChatCallbacks {
  onWebChatMessage: (message: IncomingMessage) => Promise<void>;
  setWebChatSend: (fn: (chatId: string, text: string) => void) => void;
}

export interface HttpServer {
  start(port: number, bind: string, callbacks: WebChatCallbacks): Promise<void>;
  stop(): Promise<void>;
}

export function createServer(config: Config, db: Database): HttpServer {
  let server: http.Server | null = null;
  let wss: WebSocketServer | null = null;
  const clients = new Map<string, WebSocket>();

  return {
    async start(port, bind, callbacks) {
      server = http.createServer((req, res) => {
        // CORS
        const corsOrigins = config.gateway.cors ?? ['*'];
        const origin = req.headers.origin ?? '';
        if (corsOrigins.includes('*') || corsOrigins.includes(origin)) {
          res.setHeader('Access-Control-Allow-Origin', origin || '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        }
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        const pathname = url.pathname;

        // Static files for WebChat
        if (pathname.startsWith('/webchat')) {
          serveWebChat(req, res, pathname);
          return;
        }

        // API routes
        if (pathname === '/health' || pathname === '/api/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', service: 'mecenas', timestamp: new Date().toISOString() }));
          return;
        }

        // Documents API
        if (pathname === '/api/documents' && req.method === 'GET') {
          const status = url.searchParams.get('status') ?? undefined;
          const caseId = url.searchParams.get('caseId') ?? undefined;
          const type = url.searchParams.get('type') ?? undefined;
          const docs = db.listDocuments({ status, caseId, type });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(docs));
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
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
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
              const data = body ? JSON.parse(body) : {};
              const doc = db.updateDocument(id, { status: 'szkic', notes: data.notes });
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
          const status = url.searchParams.get('status') ?? undefined;
          const clientId = url.searchParams.get('clientId') ?? undefined;
          const cases = db.listCases({ status, clientId });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(cases));
          return;
        }

        // Deadlines API
        if (pathname === '/api/deadlines' && req.method === 'GET') {
          const upcoming = url.searchParams.get('upcoming') === 'true';
          const deadlines = db.listDeadlines({ upcoming });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(deadlines));
          return;
        }

        // Clients API
        if (pathname === '/api/clients' && req.method === 'GET') {
          const q = url.searchParams.get('q');
          const clientList = q ? db.searchClients(q) : db.listClients();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(clientList));
          return;
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

        // 404
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      });

      // WebSocket for WebChat
      wss = new WebSocketServer({ server, path: '/ws' });

      wss.on('connection', (ws) => {
        const chatId = `webchat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        clients.set(chatId, ws);

        logger.info({ chatId }, 'WebChat client connected');

        ws.send(JSON.stringify({
          type: 'connected',
          chatId,
          message: 'Witaj w Mecenasie! Jestem Twoim asystentem prawnym AI.',
        }));

        ws.on('message', async (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'message' && msg.text) {
              await callbacks.onWebChatMessage({
                id: `wc_${Date.now()}`,
                platform: 'webchat',
                userId: chatId,
                chatId,
                chatType: 'dm',
                text: msg.text,
                timestamp: new Date(),
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
  let filePath: string;
  if (pathname === '/webchat' || pathname === '/webchat/') {
    filePath = join(process.cwd(), 'public', 'webchat', 'index.html');
  } else {
    const relative = pathname.replace('/webchat/', '');
    filePath = join(process.cwd(), 'public', 'webchat', relative);
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

async function generateDocx(doc: { title: string; content: string; type: string; status: string; caseId?: string }, db: Database): Promise<Buffer> {
  // Build paragraphs from content
  const lines = doc.content.split('\n');
  const children: Paragraph[] = [];

  // Title
  children.push(new Paragraph({
    text: doc.title,
    heading: HeadingLevel.HEADING_1,
    alignment: AlignmentType.CENTER,
    spacing: { after: 400 },
  }));

  // Case info if linked
  if (doc.caseId) {
    const legalCase = db.getCase(doc.caseId);
    if (legalCase) {
      const caseInfo = [
        legalCase.sygnatura ? `Sygnatura: ${legalCase.sygnatura}` : null,
        legalCase.court ? `Sąd: ${legalCase.court}` : null,
      ].filter(Boolean).join(' | ');
      if (caseInfo) {
        children.push(new Paragraph({
          children: [new TextRun({ text: caseInfo, italics: true, size: 20 })],
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
        }));
      }
    }
  }

  // Separator
  children.push(new Paragraph({ text: '', spacing: { after: 200 } }));

  // Content
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      children.push(new Paragraph({ text: '' }));
      continue;
    }

    // Section headers (uppercase or starting with Roman numerals)
    if (/^(I{1,3}V?|V|VI{0,3}|IX|X{0,3})\.\s/.test(trimmed) || trimmed === trimmed.toUpperCase() && trimmed.length > 3) {
      children.push(new Paragraph({
        text: trimmed,
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 200, after: 100 },
      }));
      continue;
    }

    children.push(new Paragraph({
      children: [new TextRun({ text: trimmed, size: 24, font: 'Times New Roman' })],
      spacing: { after: 80, line: 360 },
    }));
  }

  // Draft watermark
  if (doc.status === 'szkic' || doc.status === 'do_sprawdzenia') {
    children.push(new Paragraph({ text: '', spacing: { before: 400 } }));
    children.push(new Paragraph({
      children: [new TextRun({
        text: 'PROJEKT — wymaga weryfikacji prawnika',
        bold: true, italics: true, size: 20, color: 'FF0000',
      })],
      alignment: AlignmentType.CENTER,
    }));
  }

  const document = new Document({
    sections: [{
      properties: {
        page: {
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      children,
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: 'Mecenas — Asystent Prawny AI | Strona ', size: 16, color: '999999' }),
              new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '999999' }),
            ],
          })],
        }),
      },
    }],
  });

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
        if (msg.type === 'connected') { chatId = msg.chatId; addMsg(msg.message, 'system'); }
        else if (msg.type === 'message') { addMsg(msg.text, 'assistant'); sendBtn.disabled = false; }
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
