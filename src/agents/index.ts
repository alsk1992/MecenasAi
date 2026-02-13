/**
 * Mecenas Agent — Polish legal AI assistant
 * Supports Ollama (Bielik) and Anthropic as LLM providers
 * Tools for case management, document drafting, legal search
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger.js';
import type { Config, Session } from '../types.js';
import type { Database } from '../db/index.js';

// =============================================================================
// SYSTEM PROMPT
// =============================================================================

const SYSTEM_PROMPT = `Jesteś Mecenas — profesjonalny asystent prawny AI dla polskich prawników.

Twoja rola:
- Pomagasz prawnikom (adwokatom, radcom prawnym) w ich codziennej pracy
- NIE udzielasz porad prawnych bezpośrednio klientom — zawsze działasz jako narzędzie dla prawnika
- Wszystkie dokumenty wymagają weryfikacji i zatwierdzenia przez prawnika przed złożeniem

Kompetencje:
1. **Pisma procesowe** — redagujesz projekty pozwów, odpowiedzi na pozew, apelacji, wniosków, wezwań do zapłaty
2. **Zarządzanie sprawami** — tworzysz i śledzisz sprawy, terminy, klientów
3. **Wyszukiwanie przepisów** — przeszukujesz polskie kodeksy (KC, KPC, KK, KP, KRO) i podajesz konkretne artykuły
4. **Analiza prawna** — pomagasz w analizie stanu faktycznego i prawnego

Zasady:
- Odpowiadasz PO POLSKU (chyba że prawnik poprosi inaczej)
- Zawsze podajesz podstawę prawną (numer artykułu, paragraf, ustęp)
- Przy pisaniu pism stosujesz format: rubrum, stan faktyczny, podstawa prawna, wnioski, uzasadnienie
- Ostrzegasz o terminach procesowych i ich konsekwencjach
- Dodajesz zastrzeżenie "PROJEKT — wymaga weryfikacji prawnika" do każdego dokumentu
- Używasz właściwej terminologii prawniczej

Dostępne narzędzia:
- create_client, list_clients, get_client — zarządzanie klientami
- create_case, list_cases, get_case, update_case — zarządzanie sprawami
- add_deadline, list_deadlines — terminy
- draft_document, list_documents, get_document — pisma procesowe
- search_law, lookup_article — wyszukiwanie przepisów
- add_case_note — notatki do spraw

Bądź konkretny, profesjonalny i pomocny. Jeśli czegoś nie wiesz, powiedz to wprost.`;

// =============================================================================
// TOOL DEFINITIONS
// =============================================================================

interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_client',
    description: 'Utwórz nowego klienta w bazie',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Imię i nazwisko / nazwa firmy' },
        type: { type: 'string', enum: ['osoba_fizyczna', 'osoba_prawna'], description: 'Typ klienta' },
        pesel: { type: 'string', description: 'PESEL (osoby fizyczne)' },
        nip: { type: 'string', description: 'NIP (firmy)' },
        email: { type: 'string', description: 'Email kontaktowy' },
        phone: { type: 'string', description: 'Telefon kontaktowy' },
        address: { type: 'string', description: 'Adres' },
      },
      required: ['name', 'type'],
    },
  },
  {
    name: 'list_clients',
    description: 'Listuj klientów (opcjonalnie szukaj)',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Fraza wyszukiwania (imię, PESEL, NIP, email)' },
      },
    },
  },
  {
    name: 'get_client',
    description: 'Pobierz szczegóły klienta',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'ID klienta' } },
      required: ['id'],
    },
  },
  {
    name: 'create_case',
    description: 'Utwórz nową sprawę sądową',
    input_schema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'ID klienta' },
        title: { type: 'string', description: 'Tytuł sprawy' },
        lawArea: { type: 'string', enum: ['cywilne', 'karne', 'pracy', 'rodzinne', 'administracyjne', 'gospodarcze', 'podatkowe', 'egzekucyjne', 'inne'] },
        sygnatura: { type: 'string', description: 'Sygnatura akt (np. I C 123/26)' },
        court: { type: 'string', description: 'Sąd (np. Sąd Rejonowy w Warszawie)' },
        description: { type: 'string', description: 'Opis sprawy' },
        opposingParty: { type: 'string', description: 'Strona przeciwna' },
        valueOfDispute: { type: 'number', description: 'Wartość przedmiotu sporu (WPS) w PLN' },
      },
      required: ['clientId', 'title', 'lawArea'],
    },
  },
  {
    name: 'list_cases',
    description: 'Listuj sprawy (z filtrami)',
    input_schema: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
        status: { type: 'string', enum: ['nowa', 'w_toku', 'oczekuje_na_termin', 'oczekuje_na_dokument', 'zawieszona', 'zamknieta', 'wygrana', 'przegrana', 'ugoda'] },
        lawArea: { type: 'string' },
      },
    },
  },
  {
    name: 'get_case',
    description: 'Pobierz szczegóły sprawy',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'ID sprawy' } },
      required: ['id'],
    },
  },
  {
    name: 'update_case',
    description: 'Zaktualizuj sprawę (status, sygnatura, itp.)',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID sprawy' },
        status: { type: 'string' },
        sygnatura: { type: 'string' },
        court: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'add_deadline',
    description: 'Dodaj termin procesowy/ustawowy',
    input_schema: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: 'ID sprawy' },
        title: { type: 'string', description: 'Opis terminu' },
        date: { type: 'string', description: 'Data (YYYY-MM-DD)' },
        type: { type: 'string', enum: ['procesowy', 'ustawowy', 'umowny', 'wewnetrzny'] },
        reminderDaysBefore: { type: 'number', description: 'Dni przed terminem na przypomnienie' },
      },
      required: ['caseId', 'title', 'date', 'type'],
    },
  },
  {
    name: 'list_deadlines',
    description: 'Listuj terminy (nadchodzące lub dla sprawy)',
    input_schema: {
      type: 'object',
      properties: {
        caseId: { type: 'string' },
        upcoming: { type: 'boolean', description: 'Tylko nadchodzące terminy' },
      },
    },
  },
  {
    name: 'draft_document',
    description: 'Utwórz projekt pisma procesowego i zapisz w bazie',
    input_schema: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: 'ID sprawy (opcjonalne)' },
        type: { type: 'string', enum: ['pozew', 'odpowiedz_na_pozew', 'apelacja', 'zarzuty', 'sprzeciw', 'wezwanie_do_zaplaty', 'wniosek', 'pismo_procesowe', 'umowa', 'opinia_prawna', 'notatka', 'inne'] },
        title: { type: 'string', description: 'Tytuł dokumentu' },
        content: { type: 'string', description: 'Treść dokumentu (pełny tekst pisma)' },
      },
      required: ['type', 'title', 'content'],
    },
  },
  {
    name: 'list_documents',
    description: 'Listuj dokumenty (z filtrami)',
    input_schema: {
      type: 'object',
      properties: {
        caseId: { type: 'string' },
        status: { type: 'string', enum: ['szkic', 'do_sprawdzenia', 'zatwierdzony', 'zlozony'] },
        type: { type: 'string' },
      },
    },
  },
  {
    name: 'get_document',
    description: 'Pobierz treść dokumentu',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'ID dokumentu' } },
      required: ['id'],
    },
  },
  {
    name: 'search_law',
    description: 'Przeszukaj polskie kodeksy (KC, KPC, KK, KP, KRO)',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Fraza wyszukiwania (np. "odszkodowanie", "przedawnienie")' },
        codeName: { type: 'string', description: 'Skrót kodeksu (KC, KPC, KK, KP, KRO, KSH, KPA)', enum: ['KC', 'KPC', 'KK', 'KP', 'KRO', 'KSH', 'KPA'] },
      },
      required: ['query'],
    },
  },
  {
    name: 'lookup_article',
    description: 'Wyszukaj konkretny artykuł kodeksu (np. art. 415 KC)',
    input_schema: {
      type: 'object',
      properties: {
        codeName: { type: 'string', description: 'Skrót kodeksu (np. KC, KPC)' },
        articleNumber: { type: 'string', description: 'Numer artykułu (np. "415", "471")' },
      },
      required: ['codeName', 'articleNumber'],
    },
  },
  {
    name: 'add_case_note',
    description: 'Dodaj notatkę do sprawy',
    input_schema: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: 'ID sprawy' },
        note: { type: 'string', description: 'Treść notatki' },
      },
      required: ['caseId', 'note'],
    },
  },
];

// =============================================================================
// TOOL EXECUTION
// =============================================================================

function executeTool(name: string, input: Record<string, unknown>, db: Database): string {
  try {
    switch (name) {
      case 'create_client': {
        const client = db.createClient({
          name: input.name as string,
          type: (input.type as any) ?? 'osoba_fizyczna',
          pesel: input.pesel as string | undefined,
          nip: input.nip as string | undefined,
          email: input.email as string | undefined,
          phone: input.phone as string | undefined,
          address: input.address as string | undefined,
        });
        return JSON.stringify({ success: true, client });
      }
      case 'list_clients': {
        const clients = input.query
          ? db.searchClients(input.query as string)
          : db.listClients();
        return JSON.stringify({ clients, count: clients.length });
      }
      case 'get_client': {
        const client = db.getClient(input.id as string);
        if (!client) return JSON.stringify({ error: 'Klient nie znaleziony' });
        return JSON.stringify(client);
      }
      case 'create_case': {
        const legalCase = db.createCase({
          clientId: input.clientId as string,
          title: input.title as string,
          lawArea: (input.lawArea as any) ?? 'cywilne',
          status: 'nowa',
          sygnatura: input.sygnatura as string | undefined,
          court: input.court as string | undefined,
          description: input.description as string | undefined,
          opposingParty: input.opposingParty as string | undefined,
          valueOfDispute: input.valueOfDispute as number | undefined,
        });
        return JSON.stringify({ success: true, case: legalCase });
      }
      case 'list_cases': {
        const cases = db.listCases({
          clientId: input.clientId as string | undefined,
          status: input.status as string | undefined,
          lawArea: input.lawArea as string | undefined,
        });
        return JSON.stringify({ cases, count: cases.length });
      }
      case 'get_case': {
        const c = db.getCase(input.id as string);
        if (!c) return JSON.stringify({ error: 'Sprawa nie znaleziona' });
        const deadlines = db.listDeadlines({ caseId: c.id });
        const documents = db.listDocuments({ caseId: c.id });
        const client = db.getClient(c.clientId);
        return JSON.stringify({ case: c, client, deadlines, documents: documents.map(d => ({ id: d.id, title: d.title, type: d.type, status: d.status })) });
      }
      case 'update_case': {
        const id = input.id as string;
        const updates: Record<string, unknown> = {};
        if (input.status) updates.status = input.status;
        if (input.sygnatura) updates.sygnatura = input.sygnatura;
        if (input.court) updates.court = input.court;
        if (input.notes) updates.notes = input.notes;
        const updated = db.updateCase(id, updates as any);
        if (!updated) return JSON.stringify({ error: 'Sprawa nie znaleziona' });
        return JSON.stringify({ success: true, case: updated });
      }
      case 'add_deadline': {
        const deadline = db.createDeadline({
          caseId: input.caseId as string,
          title: input.title as string,
          date: new Date(input.date as string),
          type: (input.type as any) ?? 'procesowy',
          completed: false,
          reminderDaysBefore: (input.reminderDaysBefore as number) ?? 3,
        });
        return JSON.stringify({ success: true, deadline });
      }
      case 'list_deadlines': {
        const deadlines = db.listDeadlines({
          caseId: input.caseId as string | undefined,
          upcoming: input.upcoming as boolean | undefined,
        });
        return JSON.stringify({ deadlines, count: deadlines.length });
      }
      case 'draft_document': {
        const doc = db.createDocument({
          caseId: input.caseId as string | undefined,
          type: (input.type as any) ?? 'pismo_procesowe',
          title: input.title as string,
          content: input.content as string,
          status: 'szkic',
          version: 1,
        });
        return JSON.stringify({ success: true, document: { id: doc.id, title: doc.title, type: doc.type, status: doc.status }, message: 'Dokument zapisany jako SZKIC. Wymaga weryfikacji prawnika.' });
      }
      case 'list_documents': {
        const docs = db.listDocuments({
          caseId: input.caseId as string | undefined,
          status: input.status as string | undefined,
          type: input.type as string | undefined,
        });
        return JSON.stringify({ documents: docs.map(d => ({ id: d.id, title: d.title, type: d.type, status: d.status, caseId: d.caseId })), count: docs.length });
      }
      case 'get_document': {
        const doc = db.getDocument(input.id as string);
        if (!doc) return JSON.stringify({ error: 'Dokument nie znaleziony' });
        return JSON.stringify(doc);
      }
      case 'search_law': {
        const articles = db.searchArticles(
          input.query as string,
          input.codeName as string | undefined,
          10
        );
        if (articles.length === 0) {
          return JSON.stringify({ message: 'Nie znaleziono przepisów. Baza wiedzy może wymagać załadowania (npm run ingest).', results: [] });
        }
        return JSON.stringify({ results: articles, count: articles.length });
      }
      case 'lookup_article': {
        const article = db.getArticle(
          input.codeName as string,
          input.articleNumber as string
        );
        if (!article) {
          return JSON.stringify({ error: `Nie znaleziono art. ${input.articleNumber} ${input.codeName}. Baza wiedzy może wymagać załadowania.` });
        }
        return JSON.stringify(article);
      }
      case 'add_case_note': {
        const existing = db.getCase(input.caseId as string);
        if (!existing) return JSON.stringify({ error: 'Sprawa nie znaleziona' });
        const currentNotes = existing.notes ?? '';
        const timestamp = new Date().toLocaleString('pl-PL');
        const newNotes = currentNotes
          ? `${currentNotes}\n\n[${timestamp}] ${input.note}`
          : `[${timestamp}] ${input.note}`;
        db.updateCase(input.caseId as string, { notes: newNotes });
        return JSON.stringify({ success: true, message: 'Notatka dodana do sprawy' });
      }
      default:
        return JSON.stringify({ error: `Nieznane narzędzie: ${name}` });
    }
  } catch (err) {
    logger.error({ err, tool: name }, 'Tool execution error');
    return JSON.stringify({ error: `Błąd wykonania narzędzia: ${(err as Error).message}` });
  }
}

// =============================================================================
// AGENT
// =============================================================================

export interface Agent {
  handleMessage(text: string, session: Session): Promise<string | null>;
}

export function createAgent(config: Config, db: Database): Agent {
  return {
    async handleMessage(text: string, session: Session): Promise<string | null> {
      if (config.agent.provider === 'anthropic' && config.agent.anthropicKey) {
        return handleWithAnthropic(text, session, config, db);
      }
      return handleWithOllama(text, session, config, db);
    },
  };
}

// =============================================================================
// ANTHROPIC PROVIDER
// =============================================================================

async function handleWithAnthropic(
  _text: string,
  session: Session,
  config: Config,
  db: Database
): Promise<string | null> {
  const client = new Anthropic({ apiKey: config.agent.anthropicKey });

  const messages: Array<{ role: 'user' | 'assistant'; content: any }> = [];
  for (const msg of session.messages.slice(-20)) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  const anthropicTools = TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as any,
  }));

  let response = await client.messages.create({
    model: config.agent.model.startsWith('claude') ? config.agent.model : 'claude-sonnet-4-5-20250929',
    max_tokens: config.agent.maxTokens,
    temperature: config.agent.temperature,
    system: SYSTEM_PROMPT,
    tools: anthropicTools,
    messages,
  });

  let turns = 0;
  while (response.stop_reason === 'tool_use' && turns < 10) {
    turns++;
    const assistantContent = response.content;
    messages.push({ role: 'assistant', content: assistantContent });

    const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
    for (const block of assistantContent) {
      if (block.type === 'tool_use') {
        logger.info({ tool: block.name }, 'Executing tool');
        const result = executeTool(block.name, block.input as Record<string, unknown>, db);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
    }

    messages.push({ role: 'user', content: toolResults as any });

    response = await client.messages.create({
      model: config.agent.model.startsWith('claude') ? config.agent.model : 'claude-sonnet-4-5-20250929',
      max_tokens: config.agent.maxTokens,
      temperature: config.agent.temperature,
      system: SYSTEM_PROMPT,
      tools: anthropicTools,
      messages,
    });
  }

  const textBlocks = response.content.filter((b: any) => b.type === 'text');
  return textBlocks.map((b: any) => b.text).join('\n') || null;
}

// =============================================================================
// OLLAMA PROVIDER (Bielik)
// =============================================================================

async function handleWithOllama(
  _text: string,
  session: Session,
  config: Config,
  db: Database
): Promise<string | null> {
  const ollamaUrl = config.agent.ollamaUrl;

  const conversationHistory = session.messages.slice(-20).map(msg => ({
    role: msg.role,
    content: msg.content,
  }));

  const toolDescriptions = TOOLS.map(t =>
    `- ${t.name}: ${t.description}`
  ).join('\n');

  const systemWithTools = `${SYSTEM_PROMPT}

Aby użyć narzędzia, odpowiedz TYLKO formatem JSON (bez żadnego innego tekstu):
{"tool": "nazwa_narzedzia", "input": {"param1": "wartosc1"}}

Dostępne narzędzia:
${toolDescriptions}

Jeśli nie musisz używać narzędzia, odpowiedz normalnym tekstem.`;

  let response = await callOllama(ollamaUrl, config.agent.model, systemWithTools, conversationHistory);

  let turns = 0;
  while (turns < 5) {
    const toolCall = parseToolCall(response);
    if (!toolCall) break;

    turns++;
    logger.info({ tool: toolCall.tool }, 'Ollama tool call');
    const result = executeTool(toolCall.tool, toolCall.input, db);

    conversationHistory.push({ role: 'assistant', content: response });
    conversationHistory.push({ role: 'user', content: `Wynik narzędzia ${toolCall.tool}:\n${result}\n\nTeraz odpowiedz użytkownikowi na podstawie wyniku narzędzia.` });

    response = await callOllama(ollamaUrl, config.agent.model, systemWithTools, conversationHistory);
  }

  return response || null;
}

function parseToolCall(text: string): { tool: string; input: Record<string, unknown> } | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.tool && typeof parsed.tool === 'string') {
        return { tool: parsed.tool, input: parsed.input ?? {} };
      }
    } catch {}
  }
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]);
      if (parsed.tool && typeof parsed.tool === 'string') {
        return { tool: parsed.tool, input: parsed.input ?? {} };
      }
    } catch {}
  }
  return null;
}

async function callOllama(
  baseUrl: string,
  model: string,
  system: string,
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      ...messages,
    ],
    stream: false,
    options: { temperature: 0.3, num_predict: 4096 },
  };

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { message?: { content?: string } };
  return data.message?.content ?? '';
}
