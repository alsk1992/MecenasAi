/**
 * Mecenas Database - SQLite (sql.js WASM) for local persistence
 * Legal case management, clients, documents, deadlines, knowledge base
 */

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { join } from 'path';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, copyFileSync } from 'fs';
import { logger } from '../utils/logger.js';
import { resolveStateDir } from '../config/index.js';
import { generateId as secureId } from '../utils/id.js';
import { getEncryptionKey, encryptBuffer, decryptBuffer, isEncryptedFile } from '../privacy/encryption.js';
import type { PrivacyMode } from '../types.js';
import { initAuditLog } from '../privacy/audit.js';
import type {
  User,
  Session,
  LegalClient,
  LegalCase,
  LegalDocument,
  Deadline,
  LegalArticle,
  TimeEntry,
  DocumentTemplate,
  Invoice,
  ConversationMessage,
} from '../types.js';

/** Bind param type compatible with sql.js SqlValue. undefined → null at boundaries. */
type SqlParam = string | number | null | undefined;
function bindParams(params: SqlParam[]): (string | number | null)[] {
  return params.map(p => p === undefined ? null : p);
}

/** Safe JSON.parse with fallback on error (prevents corrupt DB data from crashing) */
function safeJsonParse<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
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

let _encKey: Buffer | null = null;

function saveDatabase(): void {
  if (!db) return;
  try {
    const data = db.export();
    let buffer: Buffer = Buffer.from(data) as Buffer;
    if (_encKey) {
      buffer = encryptBuffer(buffer, _encKey) as Buffer;
    }
    const tmpPath = DB_FILE + '.tmp';
    writeFileSync(tmpPath, buffer);
    renameSync(tmpPath, DB_FILE);
  } catch (err) {
    logger.error({ err }, 'Błąd zapisu bazy danych');
  }
}

const MAX_BACKUPS = 7;
function performBackup(): void {
  if (!existsSync(DB_FILE)) return;
  try {
    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const backupFile = join(BACKUP_DIR, `mecenas-${dateStr}.db`);
    if (existsSync(backupFile)) return; // already backed up today
    copyFileSync(DB_FILE, backupFile);
    logger.info({ backup: backupFile }, 'Kopia zapasowa bazy danych utworzona');
    // Prune old backups — keep only last MAX_BACKUPS
    const files = readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('mecenas-') && f.endsWith('.db'))
      .sort();
    while (files.length > MAX_BACKUPS) {
      const old = files.shift()!;
      try { unlinkSync(join(BACKUP_DIR, old)); } catch { /* best effort */ }
    }
  } catch (err) {
    logger.warn({ err }, 'Nie udało się utworzyć kopii zapasowej');
  }
}
function scheduleBackup(): void {
  performBackup(); // immediate on startup
  setInterval(performBackup, 24 * 60 * 60 * 1000); // then every 24h
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
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
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
    FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE
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
    FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE
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
    FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'pismo_procesowe',
    content TEXT NOT NULL DEFAULT '',
    description TEXT,
    law_area TEXT,
    tags TEXT,
    use_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_templates_type ON templates(type);

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
  CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
  CREATE INDEX IF NOT EXISTS idx_cases_client ON cases(client_id);
  CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
  CREATE INDEX IF NOT EXISTS idx_documents_case ON documents(case_id);
  CREATE INDEX IF NOT EXISTS idx_deadlines_case ON deadlines(case_id);
  CREATE INDEX IF NOT EXISTS idx_deadlines_date ON deadlines(date);
  CREATE INDEX IF NOT EXISTS idx_legal_knowledge_code ON legal_knowledge(code_name);
  CREATE INDEX IF NOT EXISTS idx_legal_knowledge_article ON legal_knowledge(code_name, article_number);
  CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);
  CREATE INDEX IF NOT EXISTS idx_time_entries_case ON time_entries(case_id);
  CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(email);
  CREATE INDEX IF NOT EXISTS idx_clients_nip ON clients(nip);

  CREATE TABLE IF NOT EXISTS _schema_version (
    version INTEGER NOT NULL DEFAULT 1
  );
`;

// =============================================================================
// SCHEMA MIGRATIONS
// =============================================================================

/** Current schema version — increment when adding migrations */
const CURRENT_SCHEMA_VERSION = 4;

/** Each migration upgrades from (version - 1) to version */
const MIGRATIONS: Record<number, string[]> = {
  // Version 2: add sessions.updated_at index + enable foreign keys
  2: [
    'CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at)',
    'PRAGMA foreign_keys = ON',
  ],
  3: [
    `CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      case_id TEXT,
      number TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'PLN',
      status TEXT NOT NULL DEFAULT 'szkic',
      issued_at INTEGER NOT NULL,
      due_at INTEGER NOT NULL,
      paid_at INTEGER,
      notes TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE SET NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id)',
    'CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status)',
  ],
  4: [
    // Privacy audit log — compliance trail (never stores actual PII)
    `CREATE TABLE IF NOT EXISTS privacy_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      session_key TEXT,
      user_id TEXT,
      case_id TEXT,
      reason TEXT NOT NULL,
      pii_match_count INTEGER NOT NULL DEFAULT 0,
      pii_types TEXT,
      anonymization_count INTEGER NOT NULL DEFAULT 0,
      privacy_mode TEXT,
      provider TEXT,
      timestamp INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON privacy_audit_log(timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_audit_action ON privacy_audit_log(action)',
    'CREATE INDEX IF NOT EXISTS idx_audit_session ON privacy_audit_log(session_key)',
    // AI consent tracking per case
    `CREATE TABLE IF NOT EXISTS ai_consent (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      acknowledged_by TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'local_only',
      notes TEXT,
      acknowledged_at INTEGER NOT NULL,
      revoked_at INTEGER,
      FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE
    )`,
    'CREATE INDEX IF NOT EXISTS idx_consent_case ON ai_consent(case_id)',
    // Per-case privacy mode override (handled specially in runMigrations for idempotency)
    `__ADD_COLUMN_IF_NOT_EXISTS__ cases privacy_mode TEXT DEFAULT NULL`,
  ],
};

function getSchemaVersion(sqlDb: import('sql.js').Database): number {
  try {
    const rows = sqlDb.exec('SELECT version FROM _schema_version LIMIT 1');
    if (rows.length && rows[0].values.length) {
      return rows[0].values[0][0] as number;
    }
  } catch {
    // Table may not exist yet
  }
  return 0;
}

function runMigrations(sqlDb: import('sql.js').Database): void {
  let version = getSchemaVersion(sqlDb);

  if (version === 0) {
    // Fresh database — set to current version after schema creation
    sqlDb.run('INSERT INTO _schema_version (version) VALUES (?)', [CURRENT_SCHEMA_VERSION]);
    logger.info({ version: CURRENT_SCHEMA_VERSION }, 'Schema initialized');
    return;
  }

  if (version >= CURRENT_SCHEMA_VERSION) return;

  logger.info({ from: version, to: CURRENT_SCHEMA_VERSION }, 'Running schema migrations');

  for (let v = version + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
    const stmts = MIGRATIONS[v];
    if (!stmts) continue;
    try {
      sqlDb.run('BEGIN');
      for (const stmt of stmts) {
        if (stmt.startsWith('__ADD_COLUMN_IF_NOT_EXISTS__')) {
          // Parse: __ADD_COLUMN_IF_NOT_EXISTS__ <table> <column> <type> [DEFAULT ...]
          const parts = stmt.replace('__ADD_COLUMN_IF_NOT_EXISTS__', '').trim().split(/\s+/);
          const table = parts[0];
          const col = parts[1];
          const colDef = parts.slice(1).join(' ');
          // Validate identifiers to prevent SQL injection in DDL
          if (!/^[a-z_][a-z0-9_]*$/.test(table) || !/^[a-z_][a-z0-9_]*$/.test(col)) {
            throw new Error(`Invalid migration identifier: ${table}.${col}`);
          }
          const existing = sqlDb.exec(`SELECT COUNT(*) FROM pragma_table_info('${table}') WHERE name = '${col}'`);
          const exists = existing.length && existing[0].values[0][0] as number > 0;
          if (!exists) {
            sqlDb.run(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
          }
        } else {
          sqlDb.run(stmt);
        }
      }
      sqlDb.run('UPDATE _schema_version SET version = ?', [v]);
      sqlDb.run('COMMIT');
      logger.info({ migration: v }, 'Migration applied');
    } catch (err) {
      try { sqlDb.run('ROLLBACK'); } catch { /* rollback best-effort */ }
      logger.error({ err, migration: v }, 'Migration failed — rolled back');
      throw new Error(`Schema migration ${v} failed: ${(err as Error).message}`);
    }
  }

  logger.info({ version: CURRENT_SCHEMA_VERSION }, 'Schema migrations complete');
}

export async function initDatabase(): Promise<Database> {
  if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });

  // Initialize encryption key (null = disabled)
  _encKey = getEncryptionKey();
  if (_encKey) {
    logger.info('Szyfrowanie bazy danych aktywne (AES-256-GCM)');
  }

  const SQL = await initSqlJs();

  if (existsSync(DB_FILE)) {
    try {
      let buffer = readFileSync(DB_FILE);
      // Decrypt if file is encrypted
      if (_encKey && isEncryptedFile(buffer)) {
        const decrypted = decryptBuffer(buffer, _encKey);
        if (!decrypted) {
          throw new Error('Nie udało się odszyfrować bazy — zły klucz?');
        }
        buffer = Buffer.from(decrypted) as Buffer<ArrayBuffer>;
      } else if (!_encKey && isEncryptedFile(buffer)) {
        throw new Error('Baza jest zaszyfrowana ale brak klucza — ustaw MECENAS_DB_KEY');
      }
      db = new SQL.Database(buffer);
    } catch (err) {
      logger.warn({ err }, 'Nie udało się załadować bazy — tworzenie nowej');
      try {
        const corruptedPath = DB_FILE + '.corrupted.' + Date.now();
        renameSync(DB_FILE, corruptedPath);
        logger.warn({ backup: corruptedPath }, 'Uszkodzona baza przeniesiona do kopii zapasowej');
      } catch { /* best effort */ }
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

  // Run schema migrations
  runMigrations(db);

  // VACUUM to reclaim space on startup
  try {
    db.run('VACUUM;');
  } catch (err) {
    logger.warn({ err }, 'VACUUM nie powiódł się — kontynuuję');
  }

  // Initialize audit log with DB reference
  initAuditLog(db, scheduleSave);

  saveDatabase();

  // Daily backup — copy DB file to backups/ with date stamp, keep last 7
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  scheduleBackup();

  logger.info({ path: DB_FILE, encrypted: !!_encKey }, 'Baza danych zainicjalizowana');

  return createDatabaseInterface(db);
}

function generateId(): string {
  return secureId();
}

export interface Database {
  // Users
  getUser(id: string): User | null;
  upsertUser(id: string, name?: string): User;
  listUsers(): User[];

  // Sessions
  getSession(key: string): Session | null;
  upsertSession(session: Partial<Session> & { key: string; userId: string; channel: string; chatId: string }): void;
  updateSessionTitle(key: string, title: string): void;
  deleteSession(key: string): void;
  listSessionsForUser(userId: string): Array<{ id: string; title: string | null; lastMessage: string | null; updatedAt: number }>;
  getLatestSessionForChat(channel: string, chatId: string): Session | null;
  getLatestSessionForUser(userId: string): Session | null;

  // Clients
  createClient(client: Omit<LegalClient, 'id' | 'createdAt' | 'updatedAt'>): LegalClient;
  getClient(id: string): LegalClient | null;
  listClients(): LegalClient[];
  updateClient(id: string, updates: Partial<LegalClient>): LegalClient | null;
  deleteClient(id: string): void;
  searchClients(query: string): LegalClient[];

  // Cases
  createCase(legalCase: Omit<LegalCase, 'id' | 'createdAt' | 'updatedAt'>): LegalCase;
  getCase(id: string): LegalCase | null;
  listCases(filters?: { clientId?: string; status?: string; lawArea?: string }): LegalCase[];
  searchCases(query: string): LegalCase[];
  updateCase(id: string, updates: Partial<LegalCase>): LegalCase | null;
  deleteCase(id: string): void;

  // Documents
  createDocument(doc: Omit<LegalDocument, 'id' | 'createdAt' | 'updatedAt'>): LegalDocument;
  getDocument(id: string): LegalDocument | null;
  listDocuments(filters?: { caseId?: string; status?: string; type?: string }): LegalDocument[];
  updateDocument(id: string, updates: Partial<LegalDocument>): LegalDocument | null;
  getDocumentVersions(id: string): LegalDocument[];

  // Documents (delete)
  deleteDocument(id: string): void;

  // Deadlines
  createDeadline(deadline: Omit<Deadline, 'id' | 'createdAt'>): Deadline;
  getDeadline(id: string): Deadline | null;
  listDeadlines(filters?: { caseId?: string; upcoming?: boolean; completed?: boolean }): Deadline[];
  completeDeadline(id: string): void;
  updateDeadline(id: string, updates: Partial<Pick<Deadline, 'title' | 'date' | 'type' | 'notes' | 'reminderDaysBefore'>>): Deadline | null;
  deleteDeadline(id: string): void;

  // Legal Knowledge
  upsertArticle(article: Omit<LegalArticle, 'id' | 'updatedAt'>): LegalArticle;
  getArticle(codeName: string, articleNumber: string): LegalArticle | null;
  searchArticles(query: string, codeName?: string, limit?: number): LegalArticle[];
  listArticles(codeName: string): LegalArticle[];
  countArticles(codeName?: string): number;

  // Invoices
  createInvoice(invoice: Omit<Invoice, 'id' | 'createdAt'>): Invoice;
  getInvoice(id: string): Invoice | null;
  listInvoices(filters?: { clientId?: string; caseId?: string; status?: string }): Invoice[];
  updateInvoice(id: string, updates: Partial<Pick<Invoice, 'status' | 'amount' | 'paidAt' | 'notes'>>): Invoice | null;

  // Time Entries
  createTimeEntry(entry: Omit<TimeEntry, 'id' | 'createdAt'>): TimeEntry;
  listTimeEntries(caseId: string): TimeEntry[];

  // Templates
  createTemplate(template: Omit<DocumentTemplate, 'id' | 'useCount' | 'createdAt' | 'updatedAt'>): DocumentTemplate;
  getTemplate(id: string): DocumentTemplate | null;
  listTemplates(filters?: { type?: string; lawArea?: string; query?: string }): DocumentTemplate[];
  incrementTemplateUseCount(id: string): void;
  deleteTemplate(id: string): void;

  // Embeddings
  storeEmbedding(id: string, sourceType: string, sourceId: string, vector: Float32Array, contentHash?: string): void;
  getEmbedding(id: string): { id: string; vector: Float32Array } | null;
  findSimilarEmbeddings(vector: Float32Array, sourceType: string, limit?: number): Array<{ id: string; sourceId: string; similarity: number }>;

  // Privacy & Compliance
  purgeExpiredSessions(maxAgeMs: number): number;
  lockInactiveSessions(maxInactiveMs: number): string[];
  recordAiConsent(caseId: string, acknowledgedBy: string, scope?: string, notes?: string): { id: string };
  getAiConsent(caseId: string): { id: string; caseId: string; acknowledgedBy: string; scope: string; acknowledgedAt: Date; revokedAt?: Date } | null;
  revokeAiConsent(caseId: string): boolean;
  gdprDeleteClient(clientId: string): { deletedCases: number; deletedDocuments: number; scrubbedSessions: number; scrubbedSessionKeys: string[] };

  // Callbacks
  onSessionsScrubbed(cb: (keys: string[]) => void): void;

  // Raw
  raw(): SqlJsDatabase;
  close(): void;
}

function createDatabaseInterface(sqlDb: SqlJsDatabase): Database {
  const now = () => Date.now();
  const sessionScrubCallbacks: Array<(keys: string[]) => void> = [];

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
      const rows = sqlDb.exec('SELECT id, name, created_at, updated_at FROM users LIMIT 1000');
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
        messages: safeJsonParse(v[7] as string, []),
        metadata: v[8] ? safeJsonParse(v[8] as string, undefined) : undefined,
        createdAt: new Date(v[9] as number),
        updatedAt: new Date(v[10] as number),
      };
    },

    upsertSession(session) {
      const existing = this.getSession(session.key);
      const metaJson = session.metadata ? JSON.stringify(session.metadata) : existing?.metadata ? JSON.stringify(existing.metadata) : null;
      if (existing) {
        sqlDb.run(
          'UPDATE sessions SET messages = ?, model = ?, thinking = ?, metadata = ?, updated_at = ? WHERE key = ?',
          [JSON.stringify(session.messages ?? existing.messages), session.model ?? existing.model ?? null, session.thinking ?? existing.thinking ?? null, metaJson, now(), session.key]
        );
      } else {
        sqlDb.run(
          'INSERT INTO sessions (key, user_id, account_id, channel, chat_id, model, thinking, messages, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [session.key, session.userId, session.accountId ?? null, session.channel, session.chatId, session.model ?? null, session.thinking ?? null, JSON.stringify(session.messages ?? []), metaJson, now(), now()]
        );
      }
      scheduleSave();
    },

    updateSessionTitle(key: string, title: string) {
      const session = this.getSession(key);
      if (!session) return;
      const meta = session.metadata ?? {};
      meta.title = title;
      sqlDb.run('UPDATE sessions SET metadata = ?, updated_at = ? WHERE key = ?', [JSON.stringify(meta), now(), key]);
      scheduleSave();
    },

    deleteSession(key: string) {
      sqlDb.run('DELETE FROM sessions WHERE key = ?', [key]);
      scheduleSave();
    },

    listSessionsForUser(userId: string) {
      const rows = sqlDb.exec(
        'SELECT key, metadata, messages, updated_at FROM sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100',
        [userId]
      );
      if (!rows.length) return [];
      return rows[0].values.map(v => {
        const meta = safeJsonParse(v[1] as string, {} as Record<string, unknown>);
        const msgs = safeJsonParse(v[2] as string, [] as Array<{ role: string; content: string }>);
        const lastUserMsg = [...msgs].reverse().find(m => m.role === 'user');
        return {
          id: v[0] as string,
          title: (meta.title as string) ?? null,
          lastMessage: lastUserMsg?.content?.slice(0, 100) ?? null,
          updatedAt: v[3] as number,
        };
      });
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
      const rows = sqlDb.exec('SELECT * FROM clients ORDER BY name LIMIT 200');
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
      const fieldMap: Record<string, string> = {
        name: 'name', type: 'type', pesel: 'pesel', nip: 'nip',
        regon: 'regon', krs: 'krs', email: 'email', phone: 'phone',
        address: 'address', notes: 'notes',
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
      sqlDb.run(`UPDATE clients SET ${fields.join(', ')} WHERE id = ?`, bindParams(values));
      scheduleSave();
      return this.getClient(id);
    },

    deleteClient(id: string) {
      // Cascade: remove linked cases (which cascades to documents, deadlines, time entries)
      // Single transaction for atomicity — avoid partial deletion leaving orphans
      const cases = this.listCases({ clientId: id });
      sqlDb.run('BEGIN');
      try {
        for (const c of cases) {
          // Inline case deletion (deleteCase has its own BEGIN/COMMIT which would conflict)
          const docs = sqlDb.exec('SELECT id FROM documents WHERE case_id = ?', [c.id]);
          if (docs.length) {
            for (const row of docs[0].values) {
              sqlDb.run("DELETE FROM embeddings WHERE source_type = 'document' AND source_id = ?", [row[0] as string]);
            }
          }
          sqlDb.run('DELETE FROM documents WHERE case_id = ?', [c.id]);
          sqlDb.run('DELETE FROM deadlines WHERE case_id = ?', [c.id]);
          sqlDb.run('DELETE FROM time_entries WHERE case_id = ?', [c.id]);
          sqlDb.run('DELETE FROM ai_consent WHERE case_id = ?', [c.id]);
          sqlDb.run('DELETE FROM cases WHERE id = ?', [c.id]);
        }
        sqlDb.run('DELETE FROM invoices WHERE client_id = ?', [id]);
        sqlDb.run('DELETE FROM clients WHERE id = ?', [id]);
        sqlDb.run('COMMIT');
      } catch (err) {
        sqlDb.run('ROLLBACK');
        throw err;
      }
      scheduleSave();
    },

    searchClients(query: string) {
      const escaped = query.trim().replace(/[%_]/g, '\\$&');
      const pattern = `%${escaped}%`;
      const rows = sqlDb.exec(
        "SELECT * FROM clients WHERE name LIKE ? ESCAPE '\\' OR pesel LIKE ? ESCAPE '\\' OR nip LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' ORDER BY name LIMIT 200",
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
        'INSERT INTO cases (id, client_id, title, sygnatura, court, law_area, status, description, opposing_party, opposing_counsel, value_of_dispute, notes, created_at, updated_at, privacy_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, legalCase.clientId, legalCase.title, legalCase.sygnatura ?? null, legalCase.court ?? null, legalCase.lawArea, legalCase.status, legalCase.description ?? null, legalCase.opposingParty ?? null, legalCase.opposingCounsel ?? null, legalCase.valueOfDispute ?? null, legalCase.notes ?? null, ts, ts, legalCase.privacyMode ?? null]
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
        privacyMode: (v[14] as string | undefined) as PrivacyMode | undefined,
      };
    },

    listCases(filters) {
      let sql = 'SELECT * FROM cases WHERE 1=1';
      const params: SqlParam[] = [];
      if (filters?.clientId) { sql += ' AND client_id = ?'; params.push(filters.clientId); }
      if (filters?.status) { sql += ' AND status = ?'; params.push(filters.status); }
      if (filters?.lawArea) { sql += ' AND law_area = ?'; params.push(filters.lawArea); }
      sql += ' ORDER BY updated_at DESC LIMIT 500';
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
        privacyMode: (v[14] as string | undefined) as PrivacyMode | undefined,
      }));
    },

    searchCases(query: string) {
      const escaped = query.trim().replace(/[%_]/g, '\\$&');
      const pattern = `%${escaped}%`;
      const rows = sqlDb.exec(
        `SELECT * FROM cases WHERE (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR opposing_party LIKE ? ESCAPE '\\' OR sygnatura LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT 50`,
        bindParams([pattern, pattern, pattern, pattern])
      );
      if (!rows.length) return [];
      return rows[0].values.map(v => ({
        id: v[0] as string, clientId: v[1] as string, title: v[2] as string,
        sygnatura: v[3] as string | undefined, court: v[4] as string | undefined,
        lawArea: v[5] as any, status: v[6] as any,
        description: v[7] as string | undefined,
        opposingParty: v[8] as string | undefined, opposingCounsel: v[9] as string | undefined,
        valueOfDispute: v[10] as number | undefined, notes: v[11] as string | undefined,
        createdAt: new Date(v[12] as number), updatedAt: new Date(v[13] as number),
        privacyMode: (v[14] as string | undefined) as PrivacyMode | undefined,
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
        privacyMode: 'privacy_mode',
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

    deleteCase(id: string) {
      // Cascade: delete all data linked to this case (transaction for atomicity)
      sqlDb.run('BEGIN');
      try {
        const docs = sqlDb.exec('SELECT id FROM documents WHERE case_id = ?', [id]);
        if (docs.length) {
          for (const row of docs[0].values) {
            sqlDb.run("DELETE FROM embeddings WHERE source_type = 'document' AND source_id = ?", [row[0] as string]);
          }
        }
        sqlDb.run('DELETE FROM documents WHERE case_id = ?', [id]);
        sqlDb.run('DELETE FROM deadlines WHERE case_id = ?', [id]);
        sqlDb.run('DELETE FROM time_entries WHERE case_id = ?', [id]);
        sqlDb.run('DELETE FROM ai_consent WHERE case_id = ?', [id]);
        sqlDb.run('DELETE FROM cases WHERE id = ?', [id]);
        sqlDb.run('COMMIT');
      } catch (err) {
        sqlDb.run('ROLLBACK');
        throw err;
      }
      scheduleSave();
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
      sql += ' ORDER BY updated_at DESC LIMIT 200';
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

    deleteDocument(id: string) {
      sqlDb.run('BEGIN');
      try {
        sqlDb.run("DELETE FROM embeddings WHERE source_type = 'document' AND source_id = ?", [id]);
        sqlDb.run('DELETE FROM documents WHERE id = ?', [id]);
        sqlDb.run('COMMIT');
      } catch (err) {
        sqlDb.run('ROLLBACK');
        throw err;
      }
      scheduleSave();
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

    getDeadline(id: string): Deadline | null {
      const rows = sqlDb.exec('SELECT * FROM deadlines WHERE id = ?', [id]);
      if (!rows.length || !rows[0].values.length) return null;
      const v = rows[0].values[0];
      return {
        id: v[0] as string, caseId: v[1] as string,
        title: v[2] as string, date: new Date(v[3] as number),
        type: v[4] as any, completed: !!(v[5] as number),
        reminderDaysBefore: v[6] as number, notes: v[7] as string | undefined,
        createdAt: new Date(v[8] as number),
      };
    },

    listDeadlines(filters) {
      let sql = 'SELECT * FROM deadlines WHERE 1=1';
      const params: SqlParam[] = [];
      if (filters?.caseId) { sql += ' AND case_id = ?'; params.push(filters.caseId); }
      if (filters?.upcoming) { sql += ' AND date >= ? AND completed = 0'; params.push(now()); }
      if (filters?.completed !== undefined) { sql += ' AND completed = ?'; params.push(filters.completed ? 1 : 0); }
      sql += ' ORDER BY date ASC LIMIT 500';
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

    updateDeadline(id: string, updates: Partial<Pick<Deadline, 'title' | 'date' | 'type' | 'notes' | 'reminderDaysBefore'>>) {
      const rows = sqlDb.exec('SELECT * FROM deadlines WHERE id = ?', [id]);
      if (!rows.length || !rows[0].values.length) return null;
      const fieldMap: Record<string, string> = {
        title: 'title', date: 'date', type: 'type',
        notes: 'notes', reminderDaysBefore: 'reminder_days_before',
      };
      const fields: string[] = [];
      const values: SqlParam[] = [];
      for (const [key, val] of Object.entries(updates)) {
        const col = fieldMap[key];
        if (!col) continue;
        if (key === 'date' && val instanceof Date) {
          fields.push(`${col} = ?`);
          values.push(val.getTime());
        } else {
          fields.push(`${col} = ?`);
          values.push(val as SqlParam);
        }
      }
      if (!fields.length) return null;
      values.push(id);
      sqlDb.run(`UPDATE deadlines SET ${fields.join(', ')} WHERE id = ?`, bindParams(values));
      scheduleSave();
      const updated = sqlDb.exec('SELECT * FROM deadlines WHERE id = ?', [id]);
      if (!updated.length || !updated[0].values.length) return null;
      const v = updated[0].values[0];
      return {
        id: v[0] as string, caseId: v[1] as string,
        title: v[2] as string, date: new Date(v[3] as number),
        type: v[4] as any, completed: !!(v[5] as number),
        reminderDaysBefore: v[6] as number, notes: v[7] as string | undefined,
        createdAt: new Date(v[8] as number),
      };
    },

    deleteDeadline(id: string) {
      sqlDb.run('DELETE FROM deadlines WHERE id = ?', [id]);
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
      const escaped = query.trim().replace(/[%_]/g, '\\$&');
      const pattern = `%${escaped}%`;
      let sql = "SELECT * FROM legal_knowledge WHERE (content LIKE ? ESCAPE '\\' OR article_number LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')";
      const params: SqlParam[] = [pattern, pattern, pattern];
      if (codeName) { sql += ' AND code_name = ?'; params.push(codeName); }
      const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
      sql += ' LIMIT ?';
      params.push(safeLimit);
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
    // ===== INVOICES =====
    createInvoice(invoice) {
      const id = generateId();
      const ts = now();
      sqlDb.run(
        'INSERT INTO invoices (id, client_id, case_id, number, amount, currency, status, issued_at, due_at, paid_at, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, invoice.clientId, invoice.caseId ?? null, invoice.number, invoice.amount, invoice.currency, invoice.status,
         invoice.issuedAt.getTime(), invoice.dueAt.getTime(), invoice.paidAt ? invoice.paidAt.getTime() : null,
         (invoice as any).notes ?? null, ts]
      );
      scheduleSave();
      return { id, ...invoice, createdAt: new Date(ts) };
    },

    getInvoice(id: string): Invoice | null {
      const rows = sqlDb.exec('SELECT * FROM invoices WHERE id = ?', [id]);
      if (!rows.length || !rows[0].values.length) return null;
      const v = rows[0].values[0];
      return {
        id: v[0] as string, clientId: v[1] as string,
        caseId: v[2] as string | undefined, number: v[3] as string,
        amount: v[4] as number, currency: v[5] as string,
        status: v[6] as any, issuedAt: new Date(v[7] as number),
        dueAt: new Date(v[8] as number),
        paidAt: v[9] ? new Date(v[9] as number) : undefined,
        notes: v[10] as string | undefined,
        createdAt: new Date(v[11] as number),
      };
    },

    listInvoices(filters) {
      let sql = 'SELECT * FROM invoices WHERE 1=1';
      const params: SqlParam[] = [];
      if (filters?.clientId) { sql += ' AND client_id = ?'; params.push(filters.clientId); }
      if (filters?.caseId) { sql += ' AND case_id = ?'; params.push(filters.caseId); }
      if (filters?.status) { sql += ' AND status = ?'; params.push(filters.status); }
      sql += ' ORDER BY issued_at DESC LIMIT 500';
      const rows = sqlDb.exec(sql, bindParams(params));
      if (!rows.length) return [];
      return rows[0].values.map(v => ({
        id: v[0] as string, clientId: v[1] as string,
        caseId: v[2] as string | undefined, number: v[3] as string,
        amount: v[4] as number, currency: v[5] as string,
        status: v[6] as any, issuedAt: new Date(v[7] as number),
        dueAt: new Date(v[8] as number),
        paidAt: v[9] ? new Date(v[9] as number) : undefined,
        notes: v[10] as string | undefined,
        createdAt: new Date(v[11] as number),
      }));
    },

    updateInvoice(id: string, updates: Partial<Pick<Invoice, 'status' | 'amount' | 'paidAt'> & { notes?: string }>) {
      const existing = this.getInvoice(id);
      if (!existing) return null;
      const fieldMap: Record<string, string> = {
        status: 'status', amount: 'amount', notes: 'notes',
      };
      const fields: string[] = [];
      const values: SqlParam[] = [];
      for (const [key, val] of Object.entries(updates)) {
        if (key === 'paidAt') {
          fields.push('paid_at = ?');
          values.push(val instanceof Date ? val.getTime() : val as SqlParam);
          continue;
        }
        const col = fieldMap[key];
        if (!col) continue;
        fields.push(`${col} = ?`);
        values.push(val as SqlParam);
      }
      if (!fields.length) return null;
      values.push(id);
      sqlDb.run(`UPDATE invoices SET ${fields.join(', ')} WHERE id = ?`, bindParams(values));
      scheduleSave();
      return this.getInvoice(id);
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
      const rows = sqlDb.exec('SELECT * FROM time_entries WHERE case_id = ? ORDER BY date DESC LIMIT 500', [caseId]);
      if (!rows.length) return [];
      return rows[0].values.map(v => ({
        id: v[0] as string, caseId: v[1] as string,
        description: v[2] as string, durationMinutes: v[3] as number,
        hourlyRate: v[4] as number | undefined, date: new Date(v[5] as number),
        createdAt: new Date(v[6] as number),
      }));
    },

    // ===== TEMPLATES =====
    createTemplate(template) {
      const id = generateId();
      const ts = now();
      sqlDb.run(
        'INSERT INTO templates (id, name, type, content, description, law_area, tags, use_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
        [id, template.name, template.type, template.content, template.description ?? null, template.lawArea ?? null, template.tags ?? null, ts, ts]
      );
      scheduleSave();
      return { id, ...template, useCount: 0, createdAt: new Date(ts), updatedAt: new Date(ts) };
    },

    getTemplate(id: string) {
      const rows = sqlDb.exec('SELECT * FROM templates WHERE id = ?', [id]);
      if (!rows.length || !rows[0].values.length) return null;
      const v = rows[0].values[0];
      return {
        id: v[0] as string, name: v[1] as string, type: v[2] as any,
        content: v[3] as string, description: v[4] as string | undefined,
        lawArea: v[5] as any, tags: v[6] as string | undefined,
        useCount: v[7] as number,
        createdAt: new Date(v[8] as number), updatedAt: new Date(v[9] as number),
      };
    },

    listTemplates(filters) {
      let sql = 'SELECT * FROM templates WHERE 1=1';
      const params: SqlParam[] = [];
      if (filters?.type) { sql += ' AND type = ?'; params.push(filters.type); }
      if (filters?.lawArea) { sql += ' AND law_area = ?'; params.push(filters.lawArea); }
      if (filters?.query) {
        const escaped = filters.query.trim().replace(/[%_]/g, '\\$&');
        const pattern = `%${escaped}%`;
        sql += " AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')";
        params.push(pattern, pattern, pattern);
      }
      sql += ' ORDER BY use_count DESC, updated_at DESC LIMIT 200';
      const rows = sqlDb.exec(sql, bindParams(params));
      if (!rows.length) return [];
      return rows[0].values.map(v => ({
        id: v[0] as string, name: v[1] as string, type: v[2] as any,
        content: v[3] as string, description: v[4] as string | undefined,
        lawArea: v[5] as any, tags: v[6] as string | undefined,
        useCount: v[7] as number,
        createdAt: new Date(v[8] as number), updatedAt: new Date(v[9] as number),
      }));
    },

    incrementTemplateUseCount(id: string) {
      sqlDb.run('UPDATE templates SET use_count = use_count + 1, updated_at = ? WHERE id = ?', [now(), id]);
      scheduleSave();
    },

    deleteTemplate(id: string) {
      sqlDb.run('DELETE FROM templates WHERE id = ?', [id]);
      scheduleSave();
    },

    // ===== EMBEDDINGS =====
    storeEmbedding(id, sourceType, sourceId, vector, contentHash) {
      const buffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
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
      if (buf.byteLength % 4 !== 0) return null;
      // Copy the buffer to avoid sharing sql.js Emscripten heap memory
      const copy = new Uint8Array(buf).buffer;
      return { id: v[0] as string, vector: new Float32Array(copy) };
    },

    findSimilarEmbeddings(vector, sourceType, limit = 10) {
      // Cap the scan to prevent loading unbounded embeddings into memory.
      // For exact nearest-neighbor over larger sets, use a vector DB instead.
      const MAX_SCAN = 5000;
      const rows = sqlDb.exec(
        'SELECT id, source_id, vector FROM embeddings WHERE source_type = ? LIMIT ?',
        [sourceType, MAX_SCAN]
      );
      if (!rows.length) return [];

      const results: Array<{ id: string; sourceId: string; similarity: number }> = [];
      for (const row of rows[0].values) {
        const buf = row[2] as Uint8Array;
        if (buf.byteLength % 4 !== 0) continue;
        // Copy the buffer to avoid sharing sql.js Emscripten heap memory
        const stored = new Float32Array(new Uint8Array(buf).buffer);
        const sim = cosineSimilarity(vector, stored);
        results.push({ id: row[0] as string, sourceId: row[1] as string, similarity: sim });
      }
      results.sort((a, b) => b.similarity - a.similarity);
      return results.slice(0, limit);
    },

    // ===== PRIVACY & COMPLIANCE =====

    purgeExpiredSessions(maxAgeMs: number): number {
      const cutoff = now() - maxAgeMs;
      const countRows = sqlDb.exec('SELECT COUNT(*) FROM sessions WHERE updated_at < ?', [cutoff]);
      const count = countRows.length ? (countRows[0].values[0][0] as number) : 0;
      if (count > 0) {
        sqlDb.run('DELETE FROM sessions WHERE updated_at < ?', [cutoff]);
        scheduleSave();
        logger.info({ count, maxAgeMs }, 'Wyczyszczono wygasłe sesje');
      }
      return count;
    },

    lockInactiveSessions(maxInactiveMs: number): string[] {
      const cutoff = now() - maxInactiveMs;
      const rows = sqlDb.exec(
        "SELECT key, metadata FROM sessions WHERE updated_at < ? AND metadata LIKE '%activeCaseId%'",
        [cutoff]
      );
      if (!rows.length) return [];
      const locked: string[] = [];
      for (const v of rows[0].values) {
        const key = v[0] as string;
        const meta = safeJsonParse(v[1] as string, {} as Record<string, unknown>);
        if (meta.activeCaseId) {
          delete meta.activeCaseId;
          meta._lockedAt = now();
          sqlDb.run('UPDATE sessions SET metadata = ? WHERE key = ?', [JSON.stringify(meta), key]);
          locked.push(key);
        }
      }
      if (locked.length) {
        scheduleSave();
        logger.info({ count: locked.length }, 'Zablokowano nieaktywne sesje (usunięto kontekst sprawy)');
      }
      return locked;
    },

    recordAiConsent(caseId: string, acknowledgedBy: string, scope = 'local_only', notes?: string) {
      const id = generateId();
      sqlDb.run(
        'INSERT OR REPLACE INTO ai_consent (id, case_id, acknowledged_by, scope, notes, acknowledged_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, caseId, acknowledgedBy, scope, notes ?? null, now()]
      );
      scheduleSave();
      return { id };
    },

    getAiConsent(caseId: string) {
      const rows = sqlDb.exec(
        'SELECT id, case_id, acknowledged_by, scope, acknowledged_at, revoked_at FROM ai_consent WHERE case_id = ? AND revoked_at IS NULL ORDER BY acknowledged_at DESC LIMIT 1',
        [caseId]
      );
      if (!rows.length || !rows[0].values.length) return null;
      const v = rows[0].values[0];
      return {
        id: v[0] as string,
        caseId: v[1] as string,
        acknowledgedBy: v[2] as string,
        scope: v[3] as string,
        acknowledgedAt: new Date(v[4] as number),
        revokedAt: v[5] ? new Date(v[5] as number) : undefined,
      };
    },

    revokeAiConsent(caseId: string): boolean {
      const existing = this.getAiConsent(caseId);
      if (!existing) return false;
      sqlDb.run('UPDATE ai_consent SET revoked_at = ? WHERE case_id = ? AND revoked_at IS NULL', [now(), caseId]);
      scheduleSave();
      return true;
    },

    gdprDeleteClient(clientId: string) {
      // Read client BEFORE any deletes (needed for session scrubbing below)
      const client = this.getClient(clientId);
      const cases = this.listCases({ clientId });
      let deletedDocuments = 0;
      let deletedSessions = 0;
      const scrubbedSessionKeys: string[] = [];

      // Transaction for atomicity — partial GDPR deletion is worse than none
      sqlDb.run('BEGIN');
      try {
        // Delete all case-linked data (including embeddings derived from documents)
        for (const c of cases) {
          const docs = sqlDb.exec('SELECT id FROM documents WHERE case_id = ?', [c.id]);
          if (docs.length) {
            deletedDocuments += docs[0].values.length;
            for (const row of docs[0].values) {
              sqlDb.run("DELETE FROM embeddings WHERE source_type = 'document' AND source_id = ?", [row[0] as string]);
            }
          }
          sqlDb.run('DELETE FROM documents WHERE case_id = ?', [c.id]);
          sqlDb.run('DELETE FROM deadlines WHERE case_id = ?', [c.id]);
          sqlDb.run('DELETE FROM time_entries WHERE case_id = ?', [c.id]);
          sqlDb.run('DELETE FROM ai_consent WHERE case_id = ?', [c.id]);
        }

        // Delete invoices
        sqlDb.run('DELETE FROM invoices WHERE client_id = ?', [clientId]);

        // Delete cases
        sqlDb.run('DELETE FROM cases WHERE client_id = ?', [clientId]);
        if (client) {
          const allSessions = sqlDb.exec('SELECT key, messages, metadata FROM sessions');
          if (allSessions.length) {
            for (const row of allSessions[0].values) {
              const key = row[0] as string;
              const messagesStr = row[1] as string;
              const metadataStr = (row[2] as string) ?? '';
              // Check ALL client PII fields to avoid missing sessions that only contain NIP/phone/etc.
              const piiFields = [client.name, client.pesel, client.nip, client.regon, client.krs, client.email, client.phone, client.address].filter(Boolean) as string[];
              const hasPii = piiFields.some(field => messagesStr.includes(field) || metadataStr.includes(field));
              if (hasPii) {
                // Replace client PII in messages with [USUNIĘTO]
                let cleanedMsg = messagesStr;
                let cleanedMeta = metadataStr;
                const scrub = (text: string) => {
                  let t = text.split(client!.name).join('[USUNIĘTO-KLIENT]');
                  if (client!.pesel) t = t.split(client!.pesel).join('[USUNIĘTO-PESEL]');
                  if (client!.nip) t = t.split(client!.nip).join('[USUNIĘTO-NIP]');
                  if (client!.regon) t = t.split(client!.regon).join('[USUNIĘTO-REGON]');
                  if (client!.krs) t = t.split(client!.krs).join('[USUNIĘTO-KRS]');
                  if (client!.phone) t = t.split(client!.phone).join('[USUNIĘTO-TEL]');
                  if (client!.email) t = t.split(client!.email).join('[USUNIĘTO-EMAIL]');
                  if (client!.address) t = t.split(client!.address).join('[USUNIĘTO-ADRES]');
                  return t;
                };
                cleanedMsg = scrub(cleanedMsg);
                cleanedMeta = metadataStr ? scrub(cleanedMeta) : metadataStr;
                sqlDb.run('UPDATE sessions SET messages = ?, metadata = ? WHERE key = ?', [cleanedMsg, cleanedMeta || null, key]);
                scrubbedSessionKeys.push(key);
                deletedSessions++;
              }
            }
          }
        }

        // Delete the client record
        sqlDb.run('DELETE FROM clients WHERE id = ?', [clientId]);
        sqlDb.run('COMMIT');
      } catch (err) {
        sqlDb.run('ROLLBACK');
        throw err;
      }

      scheduleSave();
      logger.info({ clientId, deletedCases: cases.length, deletedDocuments, scrubbedSessions: deletedSessions }, 'RODO: usunięto dane klienta');

      // Notify listeners to invalidate in-memory caches
      if (scrubbedSessionKeys.length > 0) {
        for (const cb of sessionScrubCallbacks) {
          try { cb(scrubbedSessionKeys); } catch { /* ignore callback errors */ }
        }
      }

      return { deletedCases: cases.length, deletedDocuments, scrubbedSessions: deletedSessions, scrubbedSessionKeys };
    },

    onSessionsScrubbed(cb: (keys: string[]) => void) {
      sessionScrubCallbacks.push(cb);
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
  if (Math.abs(denom) < 1e-10) return 0;
  const result = dot / denom;
  return Number.isFinite(result) ? result : 0;
}

export { createDatabaseInterface };
