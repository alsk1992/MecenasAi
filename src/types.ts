/**
 * Mecenas - Core Type Definitions
 * Polski asystent prawny AI
 */

// =============================================================================
// MESSAGING
// =============================================================================

export type Platform = 'telegram' | 'webchat' | 'system';

export interface IncomingMessage {
  id: string;
  platform: string;
  userId: string;
  chatId: string;
  chatType: 'dm' | 'group';
  text: string;
  timestamp: Date;
  replyToId?: string;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
}

export interface OutgoingMessage {
  platform: string;
  chatId: string;
  text: string;
  parseMode?: 'Markdown' | 'HTML' | 'MarkdownV2';
  replyToId?: string;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
}

export interface ReactionMessage {
  platform: string;
  chatId: string;
  messageId: string;
  emoji: string;
}

export interface PollMessage {
  platform: string;
  chatId: string;
  question: string;
  options: string[];
}

export interface Attachment {
  type: 'file' | 'image' | 'document';
  url?: string;
  data?: Buffer;
  mimeType?: string;
  filename?: string;
}

// =============================================================================
// SESSIONS & USERS
// =============================================================================

export interface User {
  id: string;
  name?: string;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
}

export interface Session {
  key: string;
  userId: string;
  accountId?: string;
  channel: string;
  chatId: string;
  model?: string;
  thinking?: string;
  messages: ConversationMessage[];
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

// =============================================================================
// LEGAL DOMAIN TYPES
// =============================================================================

export type ClientType = 'osoba_fizyczna' | 'osoba_prawna';

export interface LegalClient {
  id: string;
  name: string;
  type: ClientType;
  pesel?: string;
  nip?: string;
  regon?: string;
  krs?: string;
  email?: string;
  phone?: string;
  address?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type LawArea =
  | 'cywilne'
  | 'karne'
  | 'pracy'
  | 'rodzinne'
  | 'administracyjne'
  | 'gospodarcze'
  | 'podatkowe'
  | 'egzekucyjne'
  | 'inne';

export type CaseStatus =
  | 'nowa'
  | 'w_toku'
  | 'oczekuje_na_termin'
  | 'oczekuje_na_dokument'
  | 'zawieszona'
  | 'zamknieta'
  | 'wygrana'
  | 'przegrana'
  | 'ugoda';

export interface LegalCase {
  id: string;
  clientId: string;
  title: string;
  sygnatura?: string;         // case number e.g. "I C 123/26"
  court?: string;             // e.g. "Sąd Rejonowy w Warszawie"
  lawArea: LawArea;
  status: CaseStatus;
  description?: string;
  opposingParty?: string;
  opposingCounsel?: string;
  valueOfDispute?: number;    // wartość przedmiotu sporu (WPS)
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type DocumentType =
  | 'pozew'                   // statement of claim
  | 'odpowiedz_na_pozew'     // answer to claim
  | 'apelacja'               // appeal
  | 'zarzuty'                // objections (nakaz zapłaty)
  | 'sprzeciw'               // opposition
  | 'wezwanie_do_zaplaty'    // payment demand
  | 'wniosek'                // motion/application
  | 'pismo_procesowe'        // procedural letter
  | 'umowa'                  // contract
  | 'opinia_prawna'          // legal opinion
  | 'notatka'                // internal note
  | 'inne';

export type DocumentStatus = 'szkic' | 'do_sprawdzenia' | 'zatwierdzony' | 'zlozony';

export interface LegalDocument {
  id: string;
  caseId?: string;
  type: DocumentType;
  title: string;
  content: string;
  status: DocumentStatus;
  version: number;
  parentVersionId?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type DeadlineType = 'procesowy' | 'ustawowy' | 'umowny' | 'wewnetrzny';

export interface Deadline {
  id: string;
  caseId: string;
  title: string;
  date: Date;
  type: DeadlineType;
  completed: boolean;
  reminderDaysBefore: number;
  notes?: string;
  createdAt: Date;
}

// =============================================================================
// LEGAL KNOWLEDGE (RAG)
// =============================================================================

export type LegalCodeName =
  | 'KC'    // Kodeks cywilny
  | 'KPC'   // Kodeks postępowania cywilnego
  | 'KK'    // Kodeks karny
  | 'KPK'   // Kodeks postępowania karnego
  | 'KP'    // Kodeks pracy
  | 'KRO'   // Kodeks rodzinny i opiekuńczy
  | 'KSH'   // Kodeks spółek handlowych
  | 'KPA'   // Kodeks postępowania administracyjnego
  | 'KW'    // Kodeks wykroczeń
  | string; // other acts

export interface LegalArticle {
  id: string;
  codeName: LegalCodeName;
  articleNumber: string;     // e.g. "415", "471 § 2"
  title?: string;            // article title if any
  content: string;           // full article text
  chapter?: string;
  section?: string;
  embeddingId?: string;
  updatedAt: Date;
}

// =============================================================================
// DOCUMENT TEMPLATES
// =============================================================================

export interface DocumentTemplate {
  id: string;
  name: string;
  type: DocumentType;
  content: string;
  description?: string;
  lawArea?: LawArea;
  tags?: string;           // comma-separated for search
  useCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// BILLING
// =============================================================================

export interface TimeEntry {
  id: string;
  caseId: string;
  description: string;
  durationMinutes: number;
  hourlyRate?: number;
  date: Date;
  createdAt: Date;
}

export interface Invoice {
  id: string;
  clientId: string;
  caseId?: string;
  number: string;           // e.g. "FV/2026/001"
  amount: number;
  currency: string;
  status: 'szkic' | 'wystawiona' | 'oplacona' | 'zalegla';
  issuedAt: Date;
  dueAt: Date;
  paidAt?: Date;
  notes?: string;
  createdAt: Date;
}

// =============================================================================
// CONFIG
// =============================================================================

export interface Config {
  agent: AgentConfig;
  gateway: GatewayConfig;
  channels: ChannelsConfig;
  session?: SessionConfig;
  http?: HttpConfig;
}

export interface AgentConfig {
  model: string;
  speedModel?: string;          // fast local model for simple queries (e.g. gemma3:4b)
  provider: 'ollama' | 'anthropic';
  maxTokens: number;
  temperature: number;
  ollamaUrl: string;
  anthropicKey?: string;
}

export interface GatewayConfig {
  port: number;
  bind: 'loopback' | 'all';
  cors?: string[];
  auth?: 'off' | 'token' | 'password';
  token?: string;
  password?: string;
}

export interface ChannelsConfig {
  telegram?: {
    token: string;
    allowedUsers?: string[];
  };
  webchat?: {
    enabled: boolean;
    token?: string;
  };
}

export interface SessionConfig {
  maxMessages?: number;
  ttlMs?: number;
}

export interface HttpConfig {
  rateLimitPerMin?: number;
  retryCount?: number;
  retryDelayMs?: number;
}

// =============================================================================
// EXECUTION SERVICE REF (kept for agent compatibility)
// =============================================================================

export interface ExecutionServiceRef {
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}
