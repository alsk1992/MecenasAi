/**
 * Mecenas Database - SQLite (sql.js WASM) for local persistence
 * Legal case management, clients, documents, deadlines, knowledge base
 */

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { join } from 'path';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { logger } from '../utils/logger.js';
import { resolveStateDir } from '../config/index.js';
import type {
  User,
  Session,
  LegalClient,
  LegalCase,
  LegalDocument,
  Deadline,
  LegalArticle,
  TimeEntry,
  ConversationMessage,
} from '../types.js';

/** Bind param type compatible with sql.js SqlValue. undefined → null at boundaries. */
type SqlParam = string | number | null | undefined;
function bindParams(params: SqlParam[]): (string | number | null)[] {
  return params.map(p => p === undefined ? null : p);
}

const DB_DIR = resolveStateDir();
const DB_FILE = join(DB_DIR, 'mecenas.db');
const BACKUP_DIR = join(DB_DIR, 'backups');

let db: SqlJsDatabase | null = null;
let saveTimer: NodeJS.Timeout | null = null;

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveDatabase();
  }, 5000);
}

function saveDatabase(): void {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    const tmpPath = DB_FILE + '.tmp';
    writeFileSync(tmpPath, buffer);
    renameSync(tmpPath, DB_FILE);
  } catch (err) {
    logger.error({ err }, 'Błąd zapisu bazy danych');
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    key TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    account_id TEXT,
    channel TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    model TEXT,
    thinking TEXT,
    messages TEXT NOT NULL DEFAULT '[]',
    metadata TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'osoba_fizyczna',
    pesel TEXT,
    nip TEXT,
    regon TEXT,
    krs TEXT,
    email TEXT,
    phone TEXT,
    address TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    title TEXT NOT NULL,
    sygnatura TEXT,
    court TEXT,
    law_area TEXT NOT NULL DEFAULT 'cywilne',
    status TEXT NOT NULL DEFAULT 'nowa',
    description TEXT,
    opposing_party TEXT,
    opposing_counsel TEXT,
    value_of_dispute REAL,
    notes TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    FOREIGN KEY (client_id) REFERENCES clients(id)
  );

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    case_id TEXT,
    type TEXT NOT NULL DEFAULT 'pismo_procesowe',
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'szkic',
    version INTEGER NOT NULL DEFAULT 1,
    parent_version_id TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    FOREIGN KEY (case_id) REFERENCES cases(id)
  );

  CREATE TABLE IF NOT EXISTS deadlines (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    title TEXT NOT NULL,
    date INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'procesowy',
    completed INTEGER NOT NULL DEFAULT 0,
    reminder_days_before INTEGER NOT NULL DEFAULT 3,
    notes TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    FOREIGN KEY (case_id) REFERENCES cases(id)
  );

  CREATE TABLE IF NOT EXISTS legal_knowledge (
    id TEXT PRIMARY KEY,
    code_name TEXT NOT NULL,
    article_number TEXT NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    chapter TEXT,
    section TEXT,
    embedding_id TEXT,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS time_entries (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    description TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    hourly_rate REAL,
    date INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    FOREIGN KEY (case_id) REFERENCES cases(id)
  );

  CREATE TABLE IF NOT EXISTS embeddings (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    content_hash TEXT,
    vector BLOB,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel, chat_id);
  CREATE INDEX IF NOT EXISTS idx_cases_client ON cases(client_id);
  CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
  CREATE INDEX IF NOT EXISTS idx_documents_case ON documents(case_id);
  CREATE INDEX IF NOT EXISTS idx_deadlines_case ON deadlines(case_id);
  CREATE INDEX IF NOT EXISTS idx_deadlines_date ON deadlines(date);
  CREATE INDEX IF NOT EXISTS idx_legal_knowledge_code ON legal_knowledge(code_name);
  CREATE INDEX IF NOT EXISTS idx_legal_knowledge_article ON legal_knowledge(code_name, article_number);
  CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);
  CREATE INDEX IF NOT EXISTS idx_time_entries_case ON time_entries(case_id);

  CREATE TABLE IF NOT EXISTS _schema_version (
    version INTEGER NOT NULL DEFAULT 1
  );
`;

export async function initDatabase(): Promise<Database> {
  if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });

  const SQL = await initSqlJs();

  if (existsSync(DB_FILE)) {
    try {
      const buffer = readFileSync(DB_FILE);
      db = new SQL.Database(buffer);
    } catch (err) {
      logger.warn({ err }, 'Nie udało się załadować bazy — tworzenie nowej');
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA journal_mode=WAL;');
  db.run('PRAGMA foreign_keys=ON;');

  const stmts = SCHEMA.split(';').map(s => s.trim()).filter(Boolean);
  for (const stmt of stmts) {
    db.run(stmt + ';');
  }

  saveDatabase();

  logger.info({ path: DB_FILE }, 'Baza danych zainicjalizowana');

  return createDatabaseInterface(db);
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export interface Database {
  // Users
  getUser(id: string): User | null;
  upsertUser(id: string, name?: string): User;
  listUsers(): User[];

  // Sessions
  getSession(key: string): Session | null;
  upsertSession(session: Partial<Session> & { key: string; userId: string; channel: string; chatId: string }): void;
  deleteSession(key: string): void;
  getLatestSessionForChat(channel: string, chatId: string): Session | null;
  getLatestSessionForUser(userId: string): Session | null;

  // Clients
  createClient(client: Omit<LegalClient, 'id' | 'createdAt' | 'updatedAt'>): LegalClient;
  getClient(id: string): LegalClient | null;
  listClients(): LegalClient[];
  updateClient(id: string, updates: Partial<LegalClient>): LegalClient | null;
  searchClients(query: string): LegalClient[];

  // Cases
  createCase(legalCase: Omit<LegalCase, 'id' | 'createdAt' | 'updatedAt'>): LegalCase;
  getCase(id: string): LegalCase | null;
  listCases(filters?: { clientId?: string; status?: string; lawArea?: string }): LegalCase[];
  updateCase(id: string, updates: Partial<LegalCase>): LegalCase | null;

  // Documents
  createDocument(doc: Omit<LegalDocument, 'id' | 'createdAt' | 'updatedAt'>): LegalDocument;
  getDocument(id: string): LegalDocument | null;
  listDocuments(filters?: { caseId?: string; status?: string; type?: string }): LegalDocument[];
  updateDocument(id: string, updates: Partial<LegalDocument>): LegalDocument | null;
  getDocumentVersions(id: string): LegalDocument[];

  // Deadlines
  createDeadline(deadline: Omit<Deadline, 'id' | 'createdAt'>): Deadline;
  listDeadlines(filters?: { caseId?: string; upcoming?: boolean; completed?: boolean }): Deadline[];
  completeDeadline(id: string): void;

  // Legal Knowledge
  upsertArticle(article: Omit<LegalArticle, 'id' | 'updatedAt'>): LegalArticle;
  getArticle(codeName: string, articleNumber: string): LegalArticle | null;
  searchArticles(query: string, codeName?: string, limit?: number): LegalArticle[];
  listArticles(codeName: string): LegalArticle[];
  countArticles(codeName?: string): number;

  // Time Entries
  createTimeEntry(entry: Omit<TimeEntry, 'id' | 'createdAt'>): TimeEntry;
  listTimeEntries(caseId: string): TimeEntry[];

  // Embeddings
  storeEmbedding(id: string, sourceType: string, sourceId: string, vector: Float32Array, contentHash?: string): void;
  getEmbedding(id: string): { id: string; vector: Float32Array } | null;
  findSimilarEmbeddings(vector: Float32Array, sourceType: string, limit?: number): Array<{ id: string; sourceId: string; similarity: number }>;

  // Raw
  raw(): SqlJsDatabase;
  close(): void;
}

function createDatabaseInterface(sqlDb: SqlJsDatabase): Database {
  const now = () => Date.now();

  return {
    // ===== USERS =====
    getUser(id: string): User | null {
      const rows = sqlDb.exec('SELECT * FROM users WHERE id = ?', [id]);
      if (!rows.length || !rows[0].values.length) return null;
      const r = rows[0];
      const v = r.values[0];
      return {
        id: v[0] as string,
        name: v[1] as string | undefined,
        createdAt: new Date(v[3] as number),
        updatedAt: new Date(v[4] as number),
      };
    },

    upsertUser(id: string, name?: string): User {
      const existing = this.getUser(id);
      if (existing) {
        if (name) {
          sqlDb.run('UPDATE users SET name = ?, updated_at = ? WHERE id = ?', [name, now(), id]);
          scheduleSave();
        }
        return { ...existing, name: name ?? existing.name, updatedAt: new Date() };
      }
      sqlDb.run('INSERT INTO users (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
        [id, name ?? null, now(), now()]);
      scheduleSave();
      return { id, name, createdAt: new Date(), updatedAt: new Date() };
    },

    listUsers(): User[] {
      const rows = sqlDb.exec('SELECT id, name, created_at, updated_at FROM users');
      if (!rows.length) return [];
      return rows[0].values.map(v => ({
        id: v[0] as string,
        name: v[1] as string | undefined,
        createdAt: new Date(v[2] as number),
        updatedAt: new Date(v[3] as number),
      }));
    },

    // ===== SESSIONS =====
    getSession(key: string): Session | null {
      const rows = sqlDb.exec('SELECT * FROM sessions WHERE key = ?', [key]);
      if (!rows.length || !rows[0].values.length) return null;
      const v = rows[0].values[0];
      return {
        key: v[0] as string,
        userId: v[1] as string,
        accountId: v[2] as string | undefined,
        channel: v[3] as string,
        chatId: v[4] as string,
        model: v[5] as string | undefined,
        thinking: v[6] as string | undefined,
        messages: JSON.parse((v[7] as string) || '[]'),
        createdAt: new Date(v[9] as number),
        updatedAt: new Date(v[10] as number),
      };
    },

    upsertSession(session) {
      const existing = this.getSession(session.key);
      if (existing) {
        sqlDb.run(
          'UPDATE sessions SET messages = ?, model = ?, thinking = ?, updated_at = ? WHERE key = ?',
          [JSON.stringify(session.messages ?? existing.messages), session.model ?? existing.model ?? null, session.thinking ?? existing.thinking ?? null, now(), session.key]
        );
      } else {
        sqlDb.run(
          'INSERT INTO sessions (key, user_id, account_id, channel, chat_id, model, thinking, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [session.key, session.userId, session.accountId ?? null, session.channel, session.chatId, session.model ?? null, session.thinking ?? null, JSON.stringify(session.messages ?? []), now(), now()]
        );
      }
      scheduleSave();
    },

    deleteSession(key: string) {
      sqlDb.run('DELETE FROM sessions WHERE key = ?', [key]);
      scheduleSave();
    },

    getLatestSessionForChat(channel: string, chatId: string): Session | null {
      const rows = sqlDb.exec('SELECT key FROM sessions WHERE channel = ? AND chat_id = ? ORDER BY updated_at DESC LIMIT 1', [channel, chatId]);
      if (!rows.length || !rows[0].values.length) return null;
      return this.getSession(rows[0].values[0][0] as string);
    },

    getLatestSessionForUser(userId: string): Session | null {
      const rows = sqlDb.exec('SELECT key FROM sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1', [userId]);
      if (!rows.length || !rows[0].values.length) return null;
      return this.getSession(rows[0].values[0][0] as string);
    },

    // ===== CLIENTS =====
    createClient(client) {
      const id = generateId();
      const ts = now();
      sqlDb.run(
        'INSERT INTO clients (id, name, type, pesel, nip, regon, krs, email, phone, address, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, client.name, client.type, client.pesel ?? null, client.nip ?? null, client.regon ?? null, client.krs ?? null, client.email ?? null, client.phone ?? null, client.address ?? null, client.notes ?? null, ts, ts]
      );
      scheduleSave();
      return { id, ...client, createdAt: new Date(ts), updatedAt: new Date(ts) };
    },

    getClient(id: string) {
      const rows = sqlDb.exec('SELECT * FROM clients WHERE id = ?', [id]);
      if (!rows.length || !rows[0].values.length) return null;
      const v = rows[0].values[0];
      return {
        id: v[0] as string, name: v[1] as string, type: v[2] as any,
        pesel: v[3] as string | undefined, nip: v[4] as string | undefined,
        regon: v[5] as string | undefined, krs: v[6] as string | undefined,
        email: v[7] as string | undefined, phone: v[8] as string | undefined,
        address: v[9] as string | undefined, notes: v[10] as string | undefined,
        createdAt: new Date(v[11] as number), updatedAt: new Date(v[12] as number),
      };
    },

    listClients() {
      const rows = sqlDb.exec('SELECT * FROM clients ORDER BY name');
      if (!rows.length) return [];
      return rows[0].values.map(v => ({
        id: v[0] as string, name: v[1] as string, type: v[2] as any,
        pesel: v[3] as string | undefined, nip: v[4] as string | undefined,
        regon: v[5] as string | undefined, krs: v[6] as string | undefined,
        email: v[7] as string | undefined, phone: v[8] as string | undefined,
        address: v[9] as string | undefined, notes: v[10] as string | undefined,
        createdAt: new Date(v[11] as number), updatedAt: new Date(v[12] as number),
      }));
    },

    updateClient(id: string, updates: Partial<LegalClient>) {
      const existing = this.getClient(id);
      if (!existing) return null;
      const fields: string[] = [];
      const values: SqlParam[] = [];
      for (const [key, val] of Object.entries(updates)) {
        if (key === 'id' || key === 'createdAt' || key === 'updatedAt') continue;
        fields.push(`${key} = ?`);
        values.push(val as SqlParam);
      }
      if (fields.length === 0) return existing;
      fields.push('updated_at = ?');
      values.push(now());
      values.push(id);
      sqlDb.run(`UPDATE clients SET ${fields.join(', ')} WHERE id = ?`, bindParams(values));
      scheduleSave();
      return this.getClient(id);
    },

    searchClients(query: string) {
      const pattern = `%${query}%`;
      const rows = sqlDb.exec(
        'SELECT * FROM clients WHERE name LIKE ? OR pesel LIKE ? OR nip LIKE ? OR email LIKE ? ORDER BY name',
        [pattern, pattern, pattern, pattern]
      );
      if (!rows.length) return [];
      return rows[0].values.map(v => ({
        id: v[0] as string, name: v[1] as string, type: v[2] as any,
        pesel: v[3] as string | undefined, nip: v[4] as string | undefined,
        regon: v[5] as string | undefined, krs: v[6] as string | undefined,
        email: v[7] as string | undefined, phone: v[8] as string | undefined,
        address: v[9] as string | undefined, notes: v[10] as string | undefined,
        createdAt: new Date(v[11] as number), updatedAt: new Date(v[12] as number),
      }));
    },

    // ===== CASES =====
    createCase(legalCase) {
      const id = generateId();
      const ts = now();
      sqlDb.run(
        'INSERT INTO cases (id, client_id, title, sygnatura, court, law_area, status, description, opposing_party, opposing_counsel, value_of_dispute, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, legalCase.clientId, legalCase.title, legalCase.sygnatura ?? null, legalCase.court ?? null, legalCase.lawArea, legalCase.status, legalCase.description ?? null, legalCase.opposingParty ?? null, legalCase.opposingCounsel ?? null, legalCase.valueOfDispute ?? null, legalCase.notes ?? null, ts, ts]
      );
      scheduleSave();
      return { id, ...legalCase, createdAt: new Date(ts), updatedAt: new Date(ts) };
    },

    getCase(id: string) {
      const rows = sqlDb.exec('SELECT * FROM cases WHERE id = ?', [id]);
      if (!rows.length || !rows[0].values.length) return null;
      const v = rows[0].values[0];
      return {
        id: v[0] as string, clientId: v[1] as string, title: v[2] as string,
        sygnatura: v[3] as string | undefined, court: v[4] as string | undefined,
        lawArea: v[5] as any, status: v[6] as any,
        description: v[7] as string | undefined,
        opposingParty: v[8] as string | undefined, opposingCounsel: v[9] as string | undefined,
        valueOfDispute: v[10] as number | undefined, notes: v[11] as string | undefined,
        createdAt: new Date(v[12] as number), updatedAt: new Date(v[13] as number),
      };
    },

    listCases(filters) {
      let sql = 'SELECT * FROM cases WHERE 1=1';
      const params: SqlParam[] = [];
      if (filters?.clientId) { sql += ' AND client_id = ?'; params.push(filters.clientId); }
      if (filters?.status) { sql += ' AND status = ?'; params.push(filters.status); }
      if (filters?.lawArea) { sql += ' AND law_area = ?'; params.push(filters.lawArea); }
      sql += ' ORDER BY updated_at DESC';
      const rows = sqlDb.exec(sql, bindParams(params));
      if (!rows.length) return [];
      return rows[0].values.map(v => ({
        id: v[0] as string, clientId: v[1] as string, title: v[2] as string,
        sygnatura: v[3] as string | undefined, court: v[4] as string | undefined,
        lawArea: v[5] as any, status: v[6] as any,
        description: v[7] as string | undefined,
        opposingParty: v[8] as string | undefined, opposingCounsel: v[9] as string | undefined,
        valueOfDispute: v[10] as number | undefined, notes: v[11] as string | undefined,
        createdAt: new Date(v[12] as number), updatedAt: new Date(v[13] as number),
      }));
    },

    updateCase(id: string, updates: Partial<LegalCase>) {
      const existing = this.getCase(id);
      if (!existing) return null;
      const fieldMap: Record<string, string> = {
        clientId: 'client_id', title: 'title', sygnatura: 'sygnatura',
        court: 'court', lawArea: 'law_area', status: 'status',
        description: 'description', opposingParty: 'opposing_party',
        opposingCounsel: 'opposing_counsel', valueOfDispute: 'value_of_dispute', notes: 'notes',
      };
      const fields: string[] = [];
      const values: SqlParam[] = [];
      for (const [key, val] of Object.entries(updates)) {
        const col = fieldMap[key];
        if (!col) continue;
        fields.push(`${col} = ?`);
        values.push(val as SqlParam);
      }
      if (fields.length === 0) return existing;
      fields.push('updated_at = ?');
      values.push(now());
      values.push(id);
      sqlDb.run(`UPDATE cases SET ${fields.join(', ')} WHERE id = ?`, bindParams(values));
      scheduleSave();
      return this.getCase(id);
    },

    // ===== DOCUMENTS =====
    createDocument(doc) {
      const id = generateId();
      const ts = now();
      sqlDb.run(
        'INSERT INTO documents (id, case_id, type, title, content, status, version, parent_version_id, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, doc.caseId ?? null, doc.type, doc.title, doc.content, doc.status, doc.version, doc.parentVersionId ?? null, doc.notes ?? null, ts, ts]
      );
      scheduleSave();
      return { id, ...doc, createdAt: new Date(ts), updatedAt: new Date(ts) };
    },

    getDocument(id: string) {
      const rows = sqlDb.exec('SELECT * FROM documents WHERE id = ?', [id]);
      if (!rows.length || !rows[0].values.length) return null;
      const v = rows[0].values[0];
      return {
        id: v[0] as string, caseId: v[1] as string | undefined,
        type: v[2] as any, title: v[3] as string,
        content: v[4] as string, status: v[5] as any,
        version: v[6] as number, parentVersionId: v[7] as string | undefined,
        notes: v[8] as string | undefined,
        createdAt: new Date(v[9] as number), updatedAt: new Date(v[10] as number),
      };
    },

    listDocuments(filters) {
      let sql = 'SELECT * FROM documents WHERE 1=1';
      const params: SqlParam[] = [];
      if (filters?.caseId) { sql += ' AND case_id = ?'; params.push(filters.caseId); }
      if (filters?.status) { sql += ' AND status = ?'; params.push(filters.status); }
      if (filters?.type) { sql += ' AND type = ?'; params.push(filters.type); }
      sql += ' ORDER BY updated_at DESC';
      const rows = sqlDb.exec(sql, bindParams(params));
      if (!rows.length) return [];
      return rows[0].values.map(v => ({
        id: v[0] as string, caseId: v[1] as string | undefined,
        type: v[2] as any, title: v[3] as string,
        content: v[4] as string, status: v[5] as any,
        version: v[6] as number, parentVersionId: v[7] as string | undefined,
        notes: v[8] as string | undefined,
        createdAt: new Date(v[9] as number), updatedAt: new Date(v[10] as number),
      }));
    },

    updateDocument(id: string, updates: Partial<LegalDocument>) {
      const existing = this.getDocument(id);
      if (!existing) return null;
      const fieldMap: Record<string, string> = {
        caseId: 'case_id', type: 'type', title: 'title', content: 'content',
        status: 'status', version: 'version', parentVersionId: 'parent_version_id', notes: 'notes',
      };
      const fields: string[] = [];
      const values: SqlParam[] = [];
      for (const [key, val] of Object.entries(updates)) {
        const col = fieldMap[key];
        if (!col) continue;
        fields.push(`${col} = ?`);
        values.push(val as SqlParam);
      }
      if (fields.length === 0) return existing;
      fields.push('updated_at = ?');
      values.push(now());
      values.push(id);
      sqlDb.run(`UPDATE documents SET ${fields.join(', ')} WHERE id = ?`, bindParams(values));
      scheduleSave();
      return this.getDocument(id);
    },

    getDocumentVersions(id: string) {
      const doc = this.getDocument(id);
      if (!doc) return [];
      const rootId = doc.parentVersionId ?? id;
      const rows = sqlDb.exec(
        'SELECT * FROM documents WHERE id = ? OR parent_version_id = ? ORDER BY version',
        [rootId, rootId]
      );
      if (!rows.length) return [doc];
      return rows[0].values.map(v => ({
        id: v[0] as string, caseId: v[1] as string | undefined,
        type: v[2] as any, title: v[3] as string,
        content: v[4] as string, status: v[5] as any,
        version: v[6] as number, parentVersionId: v[7] as string | undefined,
        notes: v[8] as string | undefined,
        createdAt: new Date(v[9] as number), updatedAt: new Date(v[10] as number),
      }));
    },

    // ===== DEADLINES =====
    createDeadline(deadline) {
      const id = generateId();
      const ts = now();
      sqlDb.run(
        'INSERT INTO deadlines (id, case_id, title, date, type, completed, reminder_days_before, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, deadline.caseId, deadline.title, deadline.date.getTime(), deadline.type, deadline.completed ? 1 : 0, deadline.reminderDaysBefore, deadline.notes ?? null, ts]
      );
      scheduleSave();
      return { id, ...deadline, createdAt: new Date(ts) };
    },

    listDeadlines(filters) {
      let sql = 'SELECT * FROM deadlines WHERE 1=1';
      const params: SqlParam[] = [];
      if (filters?.caseId) { sql += ' AND case_id = ?'; params.push(filters.caseId); }
      if (filters?.upcoming) { sql += ' AND date >= ? AND completed = 0'; params.push(now()); }
      if (filters?.completed !== undefined) { sql += ' AND completed = ?'; params.push(filters.completed ? 1 : 0); }
      sql += ' ORDER BY date ASC';
      const rows = sqlDb.exec(sql, bindParams(params));
      if (!rows.length) return [];
      return rows[0].values.map(v => ({
        id: v[0] as string, caseId: v[1] as string,
        title: v[2] as string, date: new Date(v[3] as number),
        type: v[4] as any, completed: !!(v[5] as number),
        reminderDaysBefore: v[6] as number, notes: v[7] as string | undefined,
        createdAt: new Date(v[8] as number),
      }));
    },

    completeDeadline(id: string) {
      sqlDb.run('UPDATE deadlines SET completed = 1 WHERE id = ?', [id]);
      scheduleSave();
    },

    // ===== LEGAL KNOWLEDGE =====
    upsertArticle(article) {
      const id = `${article.codeName}:${article.articleNumber}`;
      const ts = now();
      const existing = this.getArticle(article.codeName, article.articleNumber);
      if (existing) {
        sqlDb.run(
          'UPDATE legal_knowledge SET content = ?, title = ?, chapter = ?, section = ?, embedding_id = ?, updated_at = ? WHERE id = ?',
          [article.content, article.title ?? null, article.chapter ?? null, article.section ?? null, article.embeddingId ?? null, ts, id]
        );
      } else {
        sqlDb.run(
          'INSERT INTO legal_knowledge (id, code_name, article_number, title, content, chapter, section, embedding_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, article.codeName, article.articleNumber, article.title ?? null, article.content, article.chapter ?? null, article.section ?? null, article.embeddingId ?? null, ts]
        );
      }
      scheduleSave();
      return { id, ...article, updatedAt: new Date(ts) };
    },

    getArticle(codeName: string, articleNumber: string) {
      const rows = sqlDb.exec(
        'SELECT * FROM legal_knowledge WHERE code_name = ? AND article_number = ?',
        [codeName, articleNumber]
      );
      if (!rows.length || !rows[0].values.length) return null;
      const v = rows[0].values[0];
      return {
        id: v[0] as string, codeName: v[1] as any,
        articleNumber: v[2] as string, title: v[3] as string | undefined,
        content: v[4] as string, chapter: v[5] as string | undefined,
        section: v[6] as string | undefined, embeddingId: v[7] as string | undefined,
        updatedAt: new Date(v[8] as number),
      };
    },

    searchArticles(query: string, codeName?: string, limit = 20) {
      const pattern = `%${query}%`;
      let sql = 'SELECT * FROM legal_knowledge WHERE (content LIKE ? OR article_number LIKE ? OR title LIKE ?)';
      const params: SqlParam[] = [pattern, pattern, pattern];
      if (codeName) { sql += ' AND code_name = ?'; params.push(codeName); }
      sql += ` LIMIT ${limit}`;
      const rows = sqlDb.exec(sql, bindParams(params));
      if (!rows.length) return [];
      return rows[0].values.map(v => ({
        id: v[0] as string, codeName: v[1] as any,
        articleNumber: v[2] as string, title: v[3] as string | undefined,
        content: v[4] as string, chapter: v[5] as string | undefined,
        section: v[6] as string | undefined, embeddingId: v[7] as string | undefined,
        updatedAt: new Date(v[8] as number),
      }));
    },

    listArticles(codeName: string) {
      const rows = sqlDb.exec('SELECT * FROM legal_knowledge WHERE code_name = ? ORDER BY article_number', [codeName]);
      if (!rows.length) return [];
      return rows[0].values.map(v => ({
        id: v[0] as string, codeName: v[1] as any,
        articleNumber: v[2] as string, title: v[3] as string | undefined,
        content: v[4] as string, chapter: v[5] as string | undefined,
        section: v[6] as string | undefined, embeddingId: v[7] as string | undefined,
        updatedAt: new Date(v[8] as number),
      }));
    },

    countArticles(codeName?: string) {
      const sql = codeName
        ? 'SELECT COUNT(*) FROM legal_knowledge WHERE code_name = ?'
        : 'SELECT COUNT(*) FROM legal_knowledge';
      const rows = sqlDb.exec(sql, codeName ? [codeName] : []);
      if (!rows.length) return 0;
      return rows[0].values[0][0] as number;
    },

    // ===== TIME ENTRIES =====
    createTimeEntry(entry) {
      const id = generateId();
      const ts = now();
      sqlDb.run(
        'INSERT INTO time_entries (id, case_id, description, duration_minutes, hourly_rate, date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, entry.caseId, entry.description, entry.durationMinutes, entry.hourlyRate ?? null, entry.date.getTime(), ts]
      );
      scheduleSave();
      return { id, ...entry, createdAt: new Date(ts) };
    },

    listTimeEntries(caseId: string) {
      const rows = sqlDb.exec('SELECT * FROM time_entries WHERE case_id = ? ORDER BY date DESC', [caseId]);
      if (!rows.length) return [];
      return rows[0].values.map(v => ({
        id: v[0] as string, caseId: v[1] as string,
        description: v[2] as string, durationMinutes: v[3] as number,
        hourlyRate: v[4] as number | undefined, date: new Date(v[5] as number),
        createdAt: new Date(v[6] as number),
      }));
    },

    // ===== EMBEDDINGS =====
    storeEmbedding(id, sourceType, sourceId, vector, contentHash) {
      const buffer = Buffer.from(vector.buffer);
      sqlDb.run(
        'INSERT OR REPLACE INTO embeddings (id, source_type, source_id, vector, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, sourceType, sourceId, buffer as any, contentHash ?? null, now()]
      );
      scheduleSave();
    },

    getEmbedding(id) {
      const rows = sqlDb.exec('SELECT id, vector FROM embeddings WHERE id = ?', [id]);
      if (!rows.length || !rows[0].values.length) return null;
      const v = rows[0].values[0];
      const buf = v[1] as Uint8Array;
      return { id: v[0] as string, vector: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4) };
    },

    findSimilarEmbeddings(vector, sourceType, limit = 10) {
      const rows = sqlDb.exec(
        'SELECT id, source_id, vector FROM embeddings WHERE source_type = ?',
        [sourceType]
      );
      if (!rows.length) return [];

      const results: Array<{ id: string; sourceId: string; similarity: number }> = [];
      for (const row of rows[0].values) {
        const buf = row[2] as Uint8Array;
        const stored = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        const sim = cosineSimilarity(vector, stored);
        results.push({ id: row[0] as string, sourceId: row[1] as string, similarity: sim });
      }
      results.sort((a, b) => b.similarity - a.similarity);
      return results.slice(0, limit);
    },

    raw() { return sqlDb; },

    close() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      saveDatabase();
      sqlDb.close();
    },
  };
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export { createDatabaseInterface };
