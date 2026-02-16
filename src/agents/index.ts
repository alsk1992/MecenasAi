/**
 * Mecenas Agent — Polish legal AI assistant
 * Supports Ollama (Bielik) and Anthropic as LLM providers
 * Tools for case management, document drafting, legal search
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger.js';
import type { Config, Session } from '../types.js';
import type { Database } from '../db/index.js';
import { detectPii, containsSensitiveData } from '../privacy/detector.js';
import { Anonymizer } from '../privacy/anonymizer.js';
import { logPrivacyEvent } from '../privacy/audit.js';

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
- Ostrzegasz o terminach procesowych i ich konsekwencjach
- Dodajesz zastrzeżenie "PROJEKT — wymaga weryfikacji prawnika" do każdego dokumentu
- Używasz właściwej terminologii prawniczej

Szablony pism (stosuj przy draft_document):

POZEW:
[Miejscowość], [data]
[Sąd], [Wydział]
Powód: [dane powoda, adres, PESEL/NIP]
Pozwany: [dane pozwanego, adres]
Wartość przedmiotu sporu: [kwota] zł

POZEW [o zapłatę / o odszkodowanie / o ...]

Działając w imieniu powoda, wnoszę o:
1. Zasądzenie od pozwanego na rzecz powoda kwoty [kwota] zł wraz z odsetkami ustawowymi za opóźnienie od dnia [data] do dnia zapłaty.
2. Zasądzenie od pozwanego na rzecz powoda kosztów procesu, w tym kosztów zastępstwa procesowego według norm przepisanych.

UZASADNIENIE
I. Stan faktyczny
[opis stanu faktycznego ze wskazaniem dowodów]

II. Podstawa prawna
[przywołanie artykułów z uzasadnieniem]

III. Właściwość sądu
[uzasadnienie właściwości miejscowej i rzeczowej]

Dowody: [lista załączników]
[podpis pełnomocnika]

ODPOWIEDŹ NA POZEW:
[Miejscowość], [data]
[Sąd], [Wydział], Sygn. akt: [sygnatura]
Pozwany: [dane]
Powód: [dane]

ODPOWIEDŹ NA POZEW

Działając w imieniu pozwanego, wnoszę o:
1. Oddalenie powództwa w całości.
2. Zasądzenie od powoda na rzecz pozwanego kosztów procesu.

UZASADNIENIE
I. Stanowisko pozwanego
[ustosunkowanie do twierdzeń pozwu]
II. Zarzuty
[zarzuty formalne i merytoryczne]
III. Podstawa prawna
[artykuły]

APELACJA:
[Miejscowość], [data]
Do: [Sąd odwoławczy] za pośrednictwem [Sąd I instancji]
Sygn. akt: [sygnatura]
Apelujący: [dane]
Przeciwnik: [dane]

APELACJA
od wyroku [Sąd I instancji] z dnia [data], sygn. akt [sygnatura]

Na podstawie art. 367 § 1 KPC zaskarżam powyższy wyrok w [całości/części] i zarzucam:
1. Naruszenie prawa materialnego — art. [nr] [kodeks] przez [błędną wykładnię/niewłaściwe zastosowanie]
2. Naruszenie prawa procesowego — art. [nr] KPC przez [opis]
3. Błąd w ustaleniach faktycznych przez [opis]

Wnoszę o:
1. Zmianę zaskarżonego wyroku przez [żądanie].
2. Zasądzenie kosztów postępowania apelacyjnego.

UZASADNIENIE
[rozwinięcie zarzutów]

WEZWANIE DO ZAPŁATY:
[Miejscowość], [data]
Nadawca: [dane wierzyciela]
Adresat: [dane dłużnika]

WEZWANIE DO ZAPŁATY

Działając w imieniu [wierzyciela], wzywam do zapłaty kwoty [kwota] zł (słownie: [słownie] złotych) wynikającej z [podstawa: faktura/umowa/tytuł], w terminie 7 dni od dnia doręczenia niniejszego wezwania, na rachunek bankowy: [nr konta].

W przypadku bezskutecznego upływu terminu sprawa zostanie skierowana na drogę postępowania sądowego, co narazi Państwa na dodatkowe koszty.

WNIOSEK:
[Miejscowość], [data]
[Sąd], [Wydział]
Sygn. akt: [sygnatura]
Wnioskodawca: [dane]

WNIOSEK [o zabezpieczenie / o zwolnienie od kosztów / o ...]

Na podstawie art. [nr] KPC wnoszę o:
1. [treść wniosku]

UZASADNIENIE
[uzasadnienie wniosku]

Dostępne narzędzia:
- create_client, list_clients, get_client, update_client, delete_client — zarządzanie klientami
- create_case, list_cases, get_case, update_case, search_cases, delete_case — zarządzanie sprawami
- add_deadline, list_deadlines, update_deadline, delete_deadline — terminy
- draft_document, list_documents, get_document, delete_document, list_document_versions — pisma procesowe
- get_case_timeline — chronologiczna oś czasu sprawy
- search_law, lookup_article — wyszukiwanie przepisów
- add_case_note — notatki do spraw
- set_active_case — ustaw aktywną sprawę (kontekst dla sesji)
- clear_active_case — wyczyść aktywną sprawę
- log_time, list_time_entries — śledzenie czasu pracy
- generate_billing_summary — podsumowanie rozliczeniowe
- create_invoice, list_invoices, get_invoice, update_invoice — faktury
- save_template, list_templates, use_template — biblioteka szablonów dokumentów
- calculate_court_fee — kalkulator opłat sądowych (ustawa o kosztach sądowych)
- calculate_interest — kalkulator odsetek ustawowych (kapitałowe, za opóźnienie, w transakcjach handlowych)
- calculate_limitation — kalkulator przedawnienia roszczeń (terminy z KC i ustaw szczególnych)
- search_court_decisions — wyszukiwanie orzeczeń sądowych w bazie SAOS (400K+ orzeczeń)
- lookup_company — wyszukiwanie firm w KRS i CEIDG (dane rejestrowe, adres, status)
- get_uploaded_document — pobierz treść przesłanego dokumentu (PDF/DOCX/TXT) do analizy
- record_ai_consent, check_ai_consent, revoke_ai_consent — zarządzanie zgodą na AI (RODO)
- gdpr_delete_client — RODO Art. 17 — trwałe usunięcie danych klienta
- set_case_privacy — ustaw tryb prywatności dla konkretnej sprawy (np. strict dla karnych)

Bądź konkretny, profesjonalny i pomocny. Jeśli czegoś nie wiesz, powiedz to wprost.`;

// =============================================================================
// ACTIVE CASE CONTEXT
// =============================================================================

function buildSystemPrompt(session: Session, db: Database): string {
  let prompt = SYSTEM_PROMPT;

  const activeCaseId = typeof session.metadata?.activeCaseId === 'string' ? session.metadata.activeCaseId : undefined;
  if (activeCaseId) {
    const activeCase = db.getCase(activeCaseId);
    if (activeCase) {
      const client = db.getClient(activeCase.clientId);
      const deadlines = db.listDeadlines({ caseId: activeCaseId, upcoming: true });
      const parts = [
        `\n\n--- AKTYWNA SPRAWA ---`,
        `Tytuł: ${activeCase.title}`,
      ];
      if (activeCase.sygnatura) parts.push(`Sygnatura: ${activeCase.sygnatura}`);
      if (activeCase.court) parts.push(`Sąd: ${activeCase.court}`);
      parts.push(`Klient: ${client?.name ?? 'nieznany'}`);
      parts.push(`Status: ${activeCase.status}`);
      parts.push(`Dziedzina: ${activeCase.lawArea}`);
      if (activeCase.description) parts.push(`Opis: ${activeCase.description.slice(0, 2000)}`);
      if (deadlines.length > 0) {
        parts.push(`Nadchodzące terminy:`);
        for (const d of deadlines.slice(0, 5)) {
          parts.push(`- ${d.title} (${d.date.toLocaleDateString('pl-PL')})`);
        }
      }
      parts.push(`\nGdy użytkownik mówi o "tej sprawie" lub nie podaje ID sprawy, używaj aktywnej sprawy (ID: ${activeCaseId}).`);
      prompt += parts.join('\n');
    }
  }

  return prompt;
}

/** Resolve caseId from tool input, falling back to session's active case */
function resolveCaseId(input: Record<string, unknown>, session: Session): string | undefined {
  return (typeof input.caseId === 'string' ? input.caseId : undefined) ?? (typeof session.metadata?.activeCaseId === 'string' ? session.metadata.activeCaseId : undefined);
}

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
    description: 'Dodaj termin procesowy/ustawowy (jeśli nie podano caseId, użyje aktywnej sprawy)',
    input_schema: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: 'ID sprawy (opcjonalne jeśli jest aktywna sprawa)' },
        title: { type: 'string', description: 'Opis terminu' },
        date: { type: 'string', description: 'Data (YYYY-MM-DD)' },
        type: { type: 'string', enum: ['procesowy', 'ustawowy', 'umowny', 'wewnetrzny'] },
        reminderDaysBefore: { type: 'number', description: 'Dni przed terminem na przypomnienie' },
      },
      required: ['title', 'date', 'type'],
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
        codeName: { type: 'string', description: 'Skrót kodeksu (KC, KPC, KK, KPK, KP, KRO, KSH, KPA, KW)', enum: ['KC', 'KPC', 'KK', 'KPK', 'KP', 'KRO', 'KSH', 'KPA', 'KW'] },
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
    description: 'Dodaj notatkę do sprawy (jeśli nie podano caseId, użyje aktywnej sprawy)',
    input_schema: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: 'ID sprawy (opcjonalne jeśli jest aktywna sprawa)' },
        note: { type: 'string', description: 'Treść notatki' },
      },
      required: ['note'],
    },
  },
  {
    name: 'set_active_case',
    description: 'Ustaw aktywną sprawę — wszystkie kolejne komendy bez podanego caseId będą dotyczyć tej sprawy',
    input_schema: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: 'ID sprawy do ustawienia jako aktywna' },
      },
      required: ['caseId'],
    },
  },
  {
    name: 'clear_active_case',
    description: 'Wyczyść aktywną sprawę (wyłącz kontekst sprawy)',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  // ===== BILLING / TIME TRACKING =====
  {
    name: 'log_time',
    description: 'Zarejestruj czas pracy nad sprawą (jeśli nie podano caseId, użyje aktywnej sprawy)',
    input_schema: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: 'ID sprawy (opcjonalne jeśli jest aktywna sprawa)' },
        description: { type: 'string', description: 'Opis wykonanej pracy (np. "Analiza dokumentacji", "Przygotowanie pisma")' },
        durationMinutes: { type: 'number', description: 'Czas w minutach' },
        hourlyRate: { type: 'number', description: 'Stawka godzinowa PLN (opcjonalne)' },
        date: { type: 'string', description: 'Data (YYYY-MM-DD, domyślnie dzisiaj)' },
      },
      required: ['description', 'durationMinutes'],
    },
  },
  {
    name: 'list_time_entries',
    description: 'Listuj wpisy czasu pracy dla sprawy (jeśli nie podano caseId, użyje aktywnej sprawy)',
    input_schema: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: 'ID sprawy (opcjonalne jeśli jest aktywna sprawa)' },
      },
    },
  },
  {
    name: 'generate_billing_summary',
    description: 'Wygeneruj podsumowanie rozliczeniowe dla sprawy',
    input_schema: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: 'ID sprawy (opcjonalne jeśli jest aktywna sprawa)' },
        hourlyRate: { type: 'number', description: 'Domyślna stawka godzinowa PLN (jeśli nie podano przy wpisach)' },
      },
    },
  },
  // ===== DOCUMENT TEMPLATES =====
  {
    name: 'save_template',
    description: 'Zapisz dokument jako szablon wielokrotnego użytku',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nazwa szablonu (np. "Pozew o zapłatę")' },
        type: { type: 'string', enum: ['pozew', 'odpowiedz_na_pozew', 'apelacja', 'zarzuty', 'sprzeciw', 'wezwanie_do_zaplaty', 'wniosek', 'pismo_procesowe', 'umowa', 'opinia_prawna', 'inne'] },
        content: { type: 'string', description: 'Treść szablonu z placeholderami (np. [IMIE_POWODA], [KWOTA])' },
        description: { type: 'string', description: 'Opis kiedy używać tego szablonu' },
        lawArea: { type: 'string', description: 'Dziedzina prawa' },
        tags: { type: 'string', description: 'Tagi oddzielone przecinkami (np. "zapłata,faktura,wierzytelność")' },
      },
      required: ['name', 'type', 'content'],
    },
  },
  {
    name: 'list_templates',
    description: 'Listuj dostępne szablony dokumentów (opcjonalnie filtruj)',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Typ dokumentu' },
        lawArea: { type: 'string', description: 'Dziedzina prawa' },
        query: { type: 'string', description: 'Szukaj w nazwie, opisie i tagach' },
      },
    },
  },
  {
    name: 'use_template',
    description: 'Pobierz treść szablonu do wypełnienia (zwiększa licznik użyć)',
    input_schema: {
      type: 'object',
      properties: {
        templateId: { type: 'string', description: 'ID szablonu' },
      },
      required: ['templateId'],
    },
  },
  {
    name: 'update_document',
    description: 'Edytuj istniejący dokument (tytuł, treść, notatki). Działa głównie na szkicach.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID dokumentu' },
        title: { type: 'string', description: 'Nowy tytuł' },
        content: { type: 'string', description: 'Nowa treść dokumentu' },
        notes: { type: 'string', description: 'Notatki/uwagi' },
      },
      required: ['id'],
    },
  },
  {
    name: 'complete_deadline',
    description: 'Oznacz termin jako zrealizowany/wykonany',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID terminu' },
      },
      required: ['id'],
    },
  },
  {
    name: 'update_deadline',
    description: 'Zaktualizuj termin (tytuł, datę, typ, notatki, dni przypomnienia)',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID terminu' },
        title: { type: 'string', description: 'Nowy tytuł' },
        date: { type: 'string', description: 'Nowa data (YYYY-MM-DD)' },
        type: { type: 'string', enum: ['procesowy', 'ustawowy', 'umowny', 'wewnetrzny'], description: 'Typ terminu' },
        notes: { type: 'string', description: 'Notatki' },
        reminderDaysBefore: { type: 'number', description: 'Dni przed terminem na przypomnienie' },
      },
      required: ['id'],
    },
  },
  {
    name: 'search_cases',
    description: 'Wyszukaj sprawy po frazie (szuka w tytule, opisie, stronie przeciwnej, sygnaturze)',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Fraza wyszukiwania' },
      },
      required: ['query'],
    },
  },
  {
    name: 'delete_document',
    description: 'Usuń dokument (tylko szkice i dokumenty do sprawdzenia)',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID dokumentu' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_document_versions',
    description: 'Pokaż historię wersji dokumentu (poprzednie wersje i aktualną)',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID dokumentu' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_case_timeline',
    description: 'Chronologiczna oś czasu sprawy: dokumenty, terminy, notatki, wpisy czasu',
    input_schema: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: 'ID sprawy (opcjonalnie — używa aktywnej sprawy)' },
      },
    },
  },
  {
    name: 'delete_deadline',
    description: 'Usuń termin',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID terminu' },
      },
      required: ['id'],
    },
  },
  {
    name: 'update_client',
    description: 'Zaktualizuj dane klienta (imię, email, telefon, adres, notatki)',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID klienta' },
        name: { type: 'string', description: 'Imię i nazwisko / nazwa' },
        email: { type: 'string', description: 'Adres email' },
        phone: { type: 'string', description: 'Numer telefonu' },
        address: { type: 'string', description: 'Adres' },
        notes: { type: 'string', description: 'Notatki' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_client',
    description: 'Usuń klienta i wszystkie powiązane sprawy, dokumenty, terminy',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID klienta' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_case',
    description: 'Usuń sprawę i wszystkie powiązane dokumenty, terminy, wpisy czasu',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID sprawy' },
      },
      required: ['id'],
    },
  },
  // ── Legal Calculators ──
  {
    name: 'calculate_court_fee',
    description: 'Oblicz opłatę sądową na podstawie wartości przedmiotu sporu (WPS) lub typu sprawy. Zgodnie z ustawą o kosztach sądowych w sprawach cywilnych.',
    input_schema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Wartość przedmiotu sporu (WPS) w PLN' },
        case_type: {
          type: 'string',
          enum: ['cywilna', 'nakazowa', 'upominawcza', 'uproszczona', 'rozwodowa', 'apelacja', 'zażalenie', 'skarga_kasacyjna', 'rejestrowa_krs', 'wieczystoksiegowa', 'spadkowa'],
          description: 'Typ sprawy (domyślnie: cywilna)',
        },
      },
      required: ['amount'],
    },
  },
  {
    name: 'calculate_interest',
    description: 'Oblicz odsetki ustawowe za podany okres. Obsługuje: odsetki kapitałowe (art. 359 KC), za opóźnienie (art. 481 KC), w transakcjach handlowych.',
    input_schema: {
      type: 'object',
      properties: {
        principal: { type: 'number', description: 'Kwota główna (kapitał) w PLN' },
        start_date: { type: 'string', description: 'Data początkowa (YYYY-MM-DD)' },
        end_date: { type: 'string', description: 'Data końcowa (YYYY-MM-DD, domyślnie dzisiaj)' },
        interest_type: {
          type: 'string',
          enum: ['ustawowe', 'za_opoznienie', 'handlowe'],
          description: 'Typ odsetek: ustawowe (kapitałowe 5%), za_opoznienie (7%), handlowe (10.25%)',
        },
      },
      required: ['principal', 'start_date'],
    },
  },
  {
    name: 'calculate_limitation',
    description: 'Oblicz termin przedawnienia roszczenia. Uwzględnia art. 118 KC (koniec roku kalendarzowego), terminy szczególne z ustaw.',
    input_schema: {
      type: 'object',
      properties: {
        claim_type: {
          type: 'string',
          enum: ['ogolne', 'gospodarcze', 'okresowe', 'sprzedaz', 'przewoz', 'delikt', 'praca_wynagrodzenie', 'praca_inne', 'najem', 'zlecenie', 'dzielo_wada', 'ubezpieczenie', 'bezpodstawne_wzbogacenie'],
          description: 'Typ roszczenia',
        },
        start_date: { type: 'string', description: 'Data wymagalności roszczenia (YYYY-MM-DD)' },
      },
      required: ['claim_type', 'start_date'],
    },
  },
  {
    name: 'search_court_decisions',
    description: 'Wyszukaj orzeczenia sądowe w bazie SAOS (Sądy, Trybunały, SN — 400K+ orzeczeń). Podaje sygnaturę, datę, sąd, fragmenty uzasadnienia.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Fraza wyszukiwania (np. "odszkodowanie za błąd medyczny", "art. 415 KC")' },
        court_type: { type: 'string', enum: ['COMMON', 'SUPREME', 'ADMINISTRATIVE', 'CONSTITUTIONAL_TRIBUNAL', 'NATIONAL_APPEAL_CHAMBER'], description: 'Typ sądu (opcjonalnie)' },
        date_from: { type: 'string', description: 'Data od (YYYY-MM-DD)' },
        date_to: { type: 'string', description: 'Data do (YYYY-MM-DD)' },
        limit: { type: 'number', description: 'Liczba wyników (1-10, domyślnie 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'lookup_company',
    description: 'Wyszukaj firmę w KRS (Krajowy Rejestr Sądowy) lub CEIDG (działalność gospodarcza). Podaj NIP, KRS lub nazwę.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'NIP, numer KRS lub nazwa firmy' },
        registry: { type: 'string', enum: ['krs', 'ceidg', 'auto'], description: 'Rejestr (domyślnie auto — wyszukuje w obu)' },
      },
      required: ['query'],
    },
  },
  // ── Document Upload Analysis ──
  {
    name: 'get_uploaded_document',
    description: 'Pobierz treść przesłanego dokumentu (PDF/DOCX/TXT) do analizy. Użytkownik przesyła plik przez interfejs, a ty analizujesz jego treść.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID dokumentu do analizy' },
        max_chars: { type: 'number', description: 'Maksymalna liczba znaków do zwrócenia (domyślnie 10000)' },
      },
      required: ['id'],
    },
  },
  // ── Invoices ──
  {
    name: 'create_invoice',
    description: 'Utwórz fakturę dla klienta. Oblicz kwotę z wpisów czasu lub podaj ręcznie.',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'string', description: 'ID klienta' },
        case_id: { type: 'string', description: 'ID sprawy (opcjonalnie)' },
        number: { type: 'string', description: 'Numer faktury, np. FV/2026/001' },
        amount: { type: 'number', description: 'Kwota netto w PLN' },
        currency: { type: 'string', description: 'Waluta (domyślnie PLN)', default: 'PLN' },
        due_days: { type: 'number', description: 'Termin płatności w dniach (domyślnie 14)', default: 14 },
        notes: { type: 'string', description: 'Uwagi do faktury' },
      },
      required: ['client_id', 'number', 'amount'],
    },
  },
  {
    name: 'list_invoices',
    description: 'Lista faktur, opcjonalnie filtrowana po kliencie, sprawie lub statusie',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'string', description: 'Filtr: ID klienta' },
        case_id: { type: 'string', description: 'Filtr: ID sprawy' },
        status: { type: 'string', enum: ['szkic', 'wystawiona', 'oplacona', 'zalegla'], description: 'Filtr: status' },
      },
    },
  },
  {
    name: 'get_invoice',
    description: 'Pobierz szczegóły faktury po ID',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID faktury' },
      },
      required: ['id'],
    },
  },
  {
    name: 'update_invoice',
    description: 'Aktualizuj status faktury (np. wystawiona → opłacona)',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID faktury' },
        status: { type: 'string', enum: ['szkic', 'wystawiona', 'oplacona', 'zalegla'], description: 'Nowy status' },
        amount: { type: 'number', description: 'Nowa kwota' },
        notes: { type: 'string', description: 'Uwagi' },
      },
      required: ['id'],
    },
  },
  // ── Privacy & Compliance ──
  {
    name: 'record_ai_consent',
    description: 'Zarejestruj zgodę na przetwarzanie AI dla sprawy. Wymagane przed użyciem AI do analizy danych klienta (RODO, tajemnica adwokacka).',
    input_schema: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: 'ID sprawy' },
        scope: { type: 'string', enum: ['local_only', 'cloud_anonymized', 'full'], description: 'Zakres zgody (domyślnie: local_only)' },
        notes: { type: 'string', description: 'Dodatkowe uwagi' },
      },
      required: ['caseId'],
    },
  },
  {
    name: 'check_ai_consent',
    description: 'Sprawdź czy sprawa ma zarejestrowaną zgodę na AI',
    input_schema: {
      type: 'object',
      properties: { caseId: { type: 'string', description: 'ID sprawy' } },
      required: ['caseId'],
    },
  },
  {
    name: 'revoke_ai_consent',
    description: 'Cofnij zgodę na AI dla sprawy',
    input_schema: {
      type: 'object',
      properties: { caseId: { type: 'string', description: 'ID sprawy' } },
      required: ['caseId'],
    },
  },
  {
    name: 'gdpr_delete_client',
    description: 'RODO Art. 17 — Prawo do usunięcia danych klienta. Trwale kasuje WSZYSTKIE dane: klienta, sprawy, dokumenty, terminy, faktury, wpisy czasu, oraz oczyszcza historię rozmów z danych osobowych. NIEODWRACALNE.',
    input_schema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'ID klienta do usunięcia' },
        confirm: { type: 'boolean', description: 'Potwierdzenie usunięcia (musi być true)' },
      },
      required: ['clientId', 'confirm'],
    },
  },
  {
    name: 'set_case_privacy',
    description: 'Ustaw tryb prywatności dla konkretnej sprawy (np. strict dla spraw karnych/rodzinnych). Nadpisuje globalne ustawienie dla tej sprawy.',
    input_schema: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: 'ID sprawy' },
        privacyMode: { type: 'string', enum: ['auto', 'strict', 'off'], description: 'Tryb prywatności (strict = tylko lokalny model)' },
      },
      required: ['caseId', 'privacyMode'],
    },
  },
];

// =============================================================================
// INPUT VALIDATION HELPERS
// =============================================================================

function requireString(input: Record<string, unknown>, key: string): string | null {
  const v = input[key];
  if (typeof v !== 'string' || v.trim().length === 0) return null;
  return v.trim();
}

function optString(input: Record<string, unknown>, key: string, maxLen = 10000): string | undefined {
  const v = input[key];
  if (v == null) return undefined;
  if (typeof v !== 'string') return undefined;
  return v.slice(0, maxLen);
}

function optNumber(input: Record<string, unknown>, key: string, min = -Infinity, max = Infinity): number | undefined {
  const v = input[key];
  if (v == null) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return n;
}

function parseDate(input: Record<string, unknown>, key: string): Date | null {
  const v = input[key];
  if (v == null) return null;
  const ms = Date.parse(String(v));
  if (isNaN(ms)) return null;
  return new Date(ms);
}

const VALID_CLIENT_TYPES = ['osoba_fizyczna', 'osoba_prawna'] as const;
const VALID_LAW_AREAS = ['cywilne', 'karne', 'administracyjne', 'pracy', 'rodzinne', 'gospodarcze', 'podatkowe', 'egzekucyjne', 'inne'] as const;
const VALID_DEADLINE_TYPES = ['procesowy', 'ustawowy', 'umowny', 'wewnetrzny'] as const;
const VALID_DOC_TYPES = ['pozew', 'odpowiedz_na_pozew', 'apelacja', 'zarzuty', 'sprzeciw', 'wezwanie_do_zaplaty', 'wniosek', 'pismo_procesowe', 'umowa', 'opinia_prawna', 'notatka', 'inne'] as const;

// =============================================================================
// TOOL EXECUTION
// =============================================================================

async function executeTool(name: string, input: Record<string, unknown>, db: Database, session: Session): Promise<string> {
  try {
    switch (name) {
      case 'create_client': {
        const clientName = requireString(input, 'name');
        if (!clientName) return JSON.stringify({ error: 'Imię/nazwa klienta jest wymagane.' });
        const rawType = optString(input, 'type') ?? 'osoba_fizyczna';
        if (!VALID_CLIENT_TYPES.includes(rawType as any)) return JSON.stringify({ error: `Typ klienta musi być: ${VALID_CLIENT_TYPES.join(', ')}` });
        const pesel = optString(input, 'pesel');
        if (pesel && !/^\d{11}$/.test(pesel)) {
          return JSON.stringify({ error: 'PESEL musi składać się z 11 cyfr.' });
        }
        const nip = optString(input, 'nip');
        if (nip && !/^\d{10}$/.test(nip.replace(/[-\s]/g, ''))) {
          return JSON.stringify({ error: 'NIP musi składać się z 10 cyfr.' });
        }
        const client = db.createClient({
          name: clientName,
          type: rawType as any,
          pesel,
          nip: nip ? nip.replace(/[-\s]/g, '') : undefined,
          email: optString(input, 'email'),
          phone: optString(input, 'phone'),
          address: optString(input, 'address'),
        });
        return JSON.stringify({ success: true, client });
      }
      case 'list_clients': {
        const q = optString(input, 'query');
        const clients = q
          ? db.searchClients(q)
          : db.listClients();
        return JSON.stringify({ clients, count: clients.length });
      }
      case 'get_client': {
        const clientGetId = requireString(input, 'id');
        if (!clientGetId) return JSON.stringify({ error: 'ID klienta jest wymagane.' });
        const client = db.getClient(clientGetId);
        if (!client) return JSON.stringify({ error: 'Klient nie znaleziony' });
        return JSON.stringify(client);
      }
      case 'create_case': {
        const caseClientId = requireString(input, 'clientId');
        if (!caseClientId) return JSON.stringify({ error: 'ID klienta (clientId) jest wymagane.' });
        if (!db.getClient(caseClientId)) return JSON.stringify({ error: 'Klient nie znaleziony — najpierw utwórz klienta (create_client).' });
        const caseTitle = requireString(input, 'title');
        if (!caseTitle) return JSON.stringify({ error: 'Tytuł sprawy jest wymagany.' });
        const rawLawArea = optString(input, 'lawArea') ?? 'cywilne';
        if (!VALID_LAW_AREAS.includes(rawLawArea as any)) return JSON.stringify({ error: `Dziedzina prawa musi być: ${VALID_LAW_AREAS.join(', ')}` });
        const legalCase = db.createCase({
          clientId: caseClientId,
          title: caseTitle,
          lawArea: rawLawArea as any,
          status: 'nowa',
          sygnatura: optString(input, 'sygnatura'),
          court: optString(input, 'court'),
          description: optString(input, 'description'),
          opposingParty: optString(input, 'opposingParty'),
          valueOfDispute: optNumber(input, 'valueOfDispute', 0),
        });
        return JSON.stringify({ success: true, case: legalCase });
      }
      case 'list_cases': {
        const lcClientId = optString(input, 'clientId');
        const lcStatus = optString(input, 'status');
        const lcLawArea = optString(input, 'lawArea');
        const cases = db.listCases({
          clientId: lcClientId,
          status: lcStatus,
          lawArea: lcLawArea,
        });
        return JSON.stringify({ cases, count: cases.length });
      }
      case 'get_case': {
        const getCaseId = requireString(input, 'id');
        if (!getCaseId) return JSON.stringify({ error: 'ID sprawy jest wymagane.' });
        const c = db.getCase(getCaseId);
        if (!c) return JSON.stringify({ error: 'Sprawa nie znaleziona' });
        const deadlines = db.listDeadlines({ caseId: c.id });
        const documents = db.listDocuments({ caseId: c.id });
        const client = db.getClient(c.clientId);
        return JSON.stringify({ case: c, client, deadlines, documents: documents.map(d => ({ id: d.id, title: d.title, type: d.type, status: d.status })) });
      }
      case 'update_case': {
        const updateCaseId = requireString(input, 'id');
        if (!updateCaseId) return JSON.stringify({ error: 'ID sprawy jest wymagane.' });
        const updates: Record<string, unknown> = {};
        if (input.status !== undefined) updates.status = optString(input, 'status');
        if (input.sygnatura !== undefined) updates.sygnatura = optString(input, 'sygnatura');
        if (input.court !== undefined) updates.court = optString(input, 'court');
        if (input.notes !== undefined) updates.notes = optString(input, 'notes');
        if (input.description !== undefined) updates.description = optString(input, 'description');
        if (input.opposingParty !== undefined) updates.opposingParty = optString(input, 'opposingParty');
        const updated = db.updateCase(updateCaseId, updates as any);
        if (!updated) return JSON.stringify({ error: 'Sprawa nie znaleziona' });
        return JSON.stringify({ success: true, case: updated });
      }
      case 'add_deadline': {
        const deadlineCaseId = resolveCaseId(input, session);
        if (!deadlineCaseId) return JSON.stringify({ error: 'Brak ID sprawy. Podaj caseId lub ustaw aktywną sprawę (set_active_case).' });
        if (!db.getCase(deadlineCaseId)) return JSON.stringify({ error: 'Sprawa nie znaleziona.' });
        const dlTitle = requireString(input, 'title');
        if (!dlTitle) return JSON.stringify({ error: 'Tytuł terminu jest wymagany.' });
        const dlDate = parseDate(input, 'date');
        if (!dlDate) return JSON.stringify({ error: 'Data terminu jest wymagana (format ISO, np. 2025-03-15).' });
        const rawDlType = optString(input, 'type') ?? 'procesowy';
        if (!VALID_DEADLINE_TYPES.includes(rawDlType as any)) return JSON.stringify({ error: `Typ terminu musi być: ${VALID_DEADLINE_TYPES.join(', ')}` });
        const reminderDays = optNumber(input, 'reminderDaysBefore', 0, 365) ?? 3;
        const deadline = db.createDeadline({
          caseId: deadlineCaseId,
          title: dlTitle,
          date: dlDate,
          type: rawDlType as any,
          completed: false,
          reminderDaysBefore: reminderDays,
        });
        return JSON.stringify({ success: true, deadline });
      }
      case 'list_deadlines': {
        const deadlines = db.listDeadlines({
          caseId: resolveCaseId(input, session),
          upcoming: input.upcoming === true ? true : input.upcoming === false ? false : undefined,
        });
        return JSON.stringify({ deadlines, count: deadlines.length });
      }
      case 'draft_document': {
        const docCaseId = resolveCaseId(input, session);
        const rawDocType = optString(input, 'type') ?? 'pismo_procesowe';
        if (!VALID_DOC_TYPES.includes(rawDocType as any)) return JSON.stringify({ error: `Typ dokumentu musi być: ${VALID_DOC_TYPES.join(', ')}` });
        const docType = rawDocType;
        const docTitle = requireString(input, 'title');
        if (!docTitle) return JSON.stringify({ error: 'Tytuł dokumentu jest wymagany.' });
        const content = requireString(input, 'content');
        if (!content) return JSON.stringify({ error: 'Treść dokumentu jest wymagana.' });
        if (content.length > 100000) return JSON.stringify({ error: 'Treść dokumentu jest zbyt długa (max 100 000 znaków).' });
        const contentLower = content.toLowerCase();

        // Pre-draft validation: check if case has required data
        const warnings: string[] = [];
        if (docCaseId) {
          const docCase = db.getCase(docCaseId);
          if (docCase) {
            if (['pozew', 'apelacja', 'odpowiedz_na_pozew'].includes(docType) && !docCase.valueOfDispute) {
              warnings.push('Brak wartosci przedmiotu sporu (WPS) w sprawie — wymagane w pozwie/apelacji.');
            }
            if (['apelacja', 'odpowiedz_na_pozew'].includes(docType) && !docCase.sygnatura) {
              warnings.push('Brak sygnatury akt — wymagane w odpowiedzi i apelacji.');
            }
            if (!docCase.court && ['pozew', 'apelacja', 'odpowiedz_na_pozew', 'wniosek'].includes(docType)) {
              warnings.push('Brak nazwy sadu w sprawie — uzupelnij dane sprawy.');
            }
          }
        }

        // Content validation: check for required sections by document type
        const sectionChecks: Record<string, string[]> = {
          pozew: ['uzasadnienie', 'podstawa prawna', 'wnosz'],
          odpowiedz_na_pozew: ['uzasadnienie', 'zarzut'],
          apelacja: ['zarzuc', 'uzasadnienie', 'zaskar'],
          wezwanie_do_zaplaty: ['termin', 'zaplat'],
          wniosek: ['wnosz', 'uzasadnienie'],
        };
        const requiredSections = sectionChecks[docType];
        if (requiredSections) {
          for (const section of requiredSections) {
            if (!contentLower.includes(section)) {
              warnings.push(`Brak sekcji zawierajacej "${section}" — sprawdz kompletnosc dokumentu.`);
            }
          }
        }

        // Filing checklist
        const checklist = [
          'Sprawdz dane stron (imiona, adresy, PESEL/NIP)',
          'Zweryfikuj przywolane artykuly i ich aktualnosc',
          'Sprawdz wlasciwosc sadu (miejscowa i rzeczowa)',
          'Zweryfikuj terminy procesowe',
          'Dolacz wymagane zalaczniki i dowody',
          'Podpisz dokument',
        ];

        // Add machine-readable provenance watermark
        const provenance = `[MECENAS-AI | ${new Date().toISOString()} | sesja: ${session.key.slice(0, 12)}]`;
        const watermarkedContent = `${provenance}\nPROJEKT — WYMAGA WERYFIKACJI PRAWNIKA\n\n${content}`;

        const doc = db.createDocument({
          caseId: docCaseId,
          type: docType as any,
          title: docTitle,
          content: watermarkedContent,
          status: 'szkic',
          version: 1,
        });

        return JSON.stringify({
          success: true,
          document: { id: doc.id, title: doc.title, type: doc.type, status: doc.status },
          message: 'Dokument zapisany jako SZKIC. Wymaga weryfikacji prawnika.',
          warnings: warnings.length > 0 ? warnings : undefined,
          checklist,
        });
      }
      case 'list_documents': {
        const docs = db.listDocuments({
          caseId: resolveCaseId(input, session),
          status: optString(input, 'status'),
          type: optString(input, 'type'),
        });
        return JSON.stringify({ documents: docs.map(d => ({ id: d.id, title: d.title, type: d.type, status: d.status, caseId: d.caseId })), count: docs.length });
      }
      case 'get_document': {
        const gdId = requireString(input, 'id');
        if (!gdId) return JSON.stringify({ error: 'ID dokumentu jest wymagane.' });
        const doc = db.getDocument(gdId);
        if (!doc) return JSON.stringify({ error: 'Dokument nie znaleziony' });
        return JSON.stringify(doc);
      }
      case 'search_law': {
        const query = requireString(input, 'query');
        if (!query) return JSON.stringify({ error: 'Zapytanie (query) jest wymagane.' });
        const articles = db.searchArticles(
          query.slice(0, 500),
          optString(input, 'codeName')?.toUpperCase(),
          10
        );
        if (articles.length === 0) {
          return JSON.stringify({ message: 'Nie znaleziono przepisów pasujących do zapytania. Baza wiedzy może wymagać załadowania (npm run ingest).', results: [] });
        }
        // Return formatted, readable article text for the LLM
        const formatted = articles.map(a => {
          const header = `Art. ${a.articleNumber} ${a.codeName}`;
          const location = [a.chapter, a.section].filter(Boolean).join(' > ');
          return `${header}${location ? ` (${location})` : ''}\n${a.content}`;
        });
        return JSON.stringify({
          count: articles.length,
          query,
          articles: formatted.join('\n\n---\n\n'),
        });
      }
      case 'lookup_article': {
        const rawCodeName = requireString(input, 'codeName');
        if (!rawCodeName) return JSON.stringify({ error: 'Nazwa kodeksu (codeName) jest wymagana, np. KC, KPC, KK.' });
        const codeName = rawCodeName.toUpperCase();
        const rawArticleNum = requireString(input, 'articleNumber');
        if (!rawArticleNum) return JSON.stringify({ error: 'Numer artykułu jest wymagany.' });
        const articleNumber = rawArticleNum.replace(/^art\.?\s*/i, '').trim();
        const article = db.getArticle(codeName, articleNumber);
        if (!article) {
          return JSON.stringify({ error: `Nie znaleziono art. ${articleNumber} ${codeName}. Baza wiedzy może wymagać załadowania.` });
        }
        const location = [article.chapter, article.section].filter(Boolean).join(' > ');
        return JSON.stringify({
          header: `Art. ${article.articleNumber} ${article.codeName}`,
          location: location || undefined,
          content: article.content,
        });
      }
      case 'add_case_note': {
        const noteCaseId = resolveCaseId(input, session);
        if (!noteCaseId) return JSON.stringify({ error: 'Brak ID sprawy. Podaj caseId lub ustaw aktywną sprawę (set_active_case).' });
        const noteText = requireString(input, 'note');
        if (!noteText) return JSON.stringify({ error: 'Treść notatki (note) jest wymagana.' });
        const existing = db.getCase(noteCaseId);
        if (!existing) return JSON.stringify({ error: 'Sprawa nie znaleziona' });
        const currentNotes = existing.notes ?? '';
        const timestamp = new Date().toLocaleString('pl-PL');
        const newNotes = currentNotes
          ? `${currentNotes}\n\n[${timestamp}] ${noteText}`
          : `[${timestamp}] ${noteText}`;
        db.updateCase(noteCaseId, { notes: newNotes });
        return JSON.stringify({ success: true, message: 'Notatka dodana do sprawy' });
      }
      case 'set_active_case': {
        const caseId = requireString(input, 'caseId');
        if (!caseId) return JSON.stringify({ error: 'ID sprawy jest wymagane.' });
        const c = db.getCase(caseId);
        if (!c) return JSON.stringify({ error: 'Sprawa nie znaleziona' });
        if (!session.metadata) session.metadata = {};
        session.metadata.activeCaseId = caseId;
        const client = db.getClient(c.clientId);
        return JSON.stringify({
          success: true,
          message: `Aktywna sprawa: "${c.title}"${c.sygnatura ? ` (${c.sygnatura})` : ''} — klient: ${client?.name ?? 'nieznany'}`,
          case: { id: c.id, title: c.title, sygnatura: c.sygnatura, status: c.status },
        });
      }
      case 'clear_active_case': {
        if (session.metadata) delete session.metadata.activeCaseId;
        return JSON.stringify({ success: true, message: 'Aktywna sprawa wyczyszczona.' });
      }
      // ===== BILLING / TIME TRACKING =====
      case 'log_time': {
        const timeCaseId = resolveCaseId(input, session);
        if (!timeCaseId) return JSON.stringify({ error: 'Brak ID sprawy. Podaj caseId lub ustaw aktywną sprawę (set_active_case).' });
        const caseCheck = db.getCase(timeCaseId);
        if (!caseCheck) return JSON.stringify({ error: 'Sprawa nie znaleziona' });
        const durationMinutes = optNumber(input, 'durationMinutes', 1, 14400);
        if (!durationMinutes) {
          return JSON.stringify({ error: 'Czas (durationMinutes) musi być liczbą od 1 do 14400.' });
        }
        const timeDesc = requireString(input, 'description');
        if (!timeDesc) return JSON.stringify({ error: 'Opis czynności jest wymagany.' });
        const timeDate = input.date ? parseDate(input, 'date') : new Date();
        if (!timeDate) return JSON.stringify({ error: 'Nieprawidłowy format daty.' });
        const entry = db.createTimeEntry({
          caseId: timeCaseId,
          description: timeDesc,
          durationMinutes,
          hourlyRate: optNumber(input, 'hourlyRate', 1, 10000),
          date: timeDate,
        });
        const hours = Math.floor(durationMinutes / 60);
        const mins = durationMinutes % 60;
        const timeStr = hours > 0 ? `${hours}h ${mins}min` : `${mins}min`;
        return JSON.stringify({
          success: true,
          entry: { id: entry.id, description: entry.description, duration: timeStr },
          message: `Zarejestrowano ${timeStr} pracy: "${entry.description}"`,
        });
      }
      case 'list_time_entries': {
        const entryCaseId = resolveCaseId(input, session);
        if (!entryCaseId) return JSON.stringify({ error: 'Brak ID sprawy. Podaj caseId lub ustaw aktywną sprawę (set_active_case).' });
        const entries = db.listTimeEntries(entryCaseId);
        const totalMinutes = entries.reduce((sum, e) => sum + e.durationMinutes, 0);
        const totalHours = (totalMinutes / 60).toFixed(1);
        return JSON.stringify({
          entries: entries.map(e => ({
            id: e.id,
            description: e.description,
            durationMinutes: e.durationMinutes,
            hourlyRate: e.hourlyRate,
            date: e.date.toLocaleDateString('pl-PL'),
          })),
          count: entries.length,
          totalMinutes,
          totalHours: `${totalHours}h`,
        });
      }
      case 'generate_billing_summary': {
        const billCaseId = resolveCaseId(input, session);
        if (!billCaseId) return JSON.stringify({ error: 'Brak ID sprawy. Podaj caseId lub ustaw aktywną sprawę (set_active_case).' });
        const billCase = db.getCase(billCaseId);
        if (!billCase) return JSON.stringify({ error: 'Sprawa nie znaleziona' });
        const billClient = db.getClient(billCase.clientId);
        const entries = db.listTimeEntries(billCaseId);
        if (entries.length === 0) return JSON.stringify({ message: 'Brak wpisów czasu pracy dla tej sprawy.' });
        const defaultRate = optNumber(input, 'hourlyRate', 1, 10000) ?? 300; // default 300 PLN/h
        let totalMinutes = 0;
        let totalAmount = 0;
        const lineItems = entries.map(e => {
          const rate = e.hourlyRate ?? defaultRate;
          const amount = (e.durationMinutes / 60) * rate;
          totalMinutes += e.durationMinutes;
          totalAmount += amount;
          return {
            date: e.date.toLocaleDateString('pl-PL'),
            description: e.description,
            duration: `${e.durationMinutes} min`,
            rate: `${rate} PLN/h`,
            amount: `${amount.toFixed(2)} PLN`,
          };
        });
        return JSON.stringify({
          summary: {
            case: billCase.title,
            sygnatura: billCase.sygnatura,
            client: billClient?.name ?? 'nieznany',
            totalHours: `${(totalMinutes / 60).toFixed(1)}h`,
            totalMinutes,
            totalAmount: `${totalAmount.toFixed(2)} PLN`,
            defaultHourlyRate: `${defaultRate} PLN/h`,
          },
          lineItems,
        });
      }
      // ===== LEGAL CALCULATORS =====
      case 'calculate_court_fee': {
        const wps = input.amount as number;
        if (typeof wps !== 'number' || !Number.isFinite(wps) || wps < 0) {
          return JSON.stringify({ error: 'Kwota WPS musi być liczbą >= 0.' });
        }
        const caseType = (optString(input, 'case_type') ?? 'cywilna') as string;

        // Ustawa z dnia 28 lipca 2005 r. o kosztach sądowych w sprawach cywilnych
        // Art. 13 — opłata stosunkowa 5% WPS, min 30 PLN, max 200 000 PLN
        let fee = 0;
        let basis = '';
        let notes: string[] = [];

        if (caseType === 'rozwodowa') {
          fee = 600;
          basis = 'Art. 26 ust. 1 pkt 1 UKSC — opłata stała 600 zł';
        } else if (caseType === 'spadkowa') {
          fee = 100;
          basis = 'Art. 49 ust. 1 pkt 1 UKSC — wniosek o stwierdzenie nabycia spadku 100 zł';
        } else if (caseType === 'rejestrowa_krs') {
          fee = 500;
          basis = 'Art. 52 UKSC — wpis do KRS 500 zł';
        } else if (caseType === 'wieczystoksiegowa') {
          fee = 200;
          basis = 'Art. 42 ust. 1 UKSC — wpis do księgi wieczystej 200 zł';
        } else if (caseType === 'uproszczona') {
          // Art. 28 UKSC — opłaty stałe w postępowaniu uproszczonym
          if (wps <= 500) fee = 30;
          else if (wps <= 1500) fee = 100;
          else if (wps <= 4000) fee = 200;
          else if (wps <= 7500) fee = 400;
          else if (wps <= 10000) fee = 500;
          else if (wps <= 15000) fee = 750;
          else if (wps <= 20000) fee = 1000;
          else fee = Math.min(200000, Math.max(30, Math.round(wps * 0.05)));
          basis = wps <= 20000 ? 'Art. 28 UKSC — opłata stała w postępowaniu uproszczonym' : 'Art. 13 ust. 2 UKSC — opłata stosunkowa 5%';
        } else {
          // Standard proportional fee
          fee = Math.min(200000, Math.max(30, Math.round(wps * 0.05)));
          basis = 'Art. 13 ust. 2 UKSC — opłata stosunkowa 5% WPS';
          if (fee === 30) notes.push('Minimalna opłata sądowa: 30 zł');
          if (fee === 200000) notes.push('Maksymalna opłata sądowa: 200 000 zł');
        }

        // Modifiers
        if (caseType === 'nakazowa') {
          fee = Math.max(30, Math.round(fee * 0.25));
          basis += ' + Art. 19 ust. 2 UKSC — 1/4 opłaty w postępowaniu nakazowym';
          notes.push('Jeśli nakaz zapłaty zostanie zaskarżony, pozwany wnosi 3/4 opłaty.');
        } else if (caseType === 'upominawcza') {
          // No fee reduction for electronic payment order anymore since 2020
          basis += ' (pełna opłata w postępowaniu upominawczym)';
        } else if (caseType === 'apelacja') {
          basis += ' (opłata od apelacji = opłata od pozwu)';
        } else if (caseType === 'zażalenie') {
          fee = Math.max(30, Math.round(fee * 0.2));
          basis += ' + Art. 19 ust. 3 UKSC — 1/5 opłaty od zażalenia';
        } else if (caseType === 'skarga_kasacyjna') {
          basis += ' (opłata od skargi kasacyjnej = opłata od pozwu)';
        }

        return JSON.stringify({
          wps: `${wps.toFixed(2)} PLN`,
          case_type: caseType,
          court_fee: `${fee.toFixed(2)} PLN`,
          court_fee_value: fee,
          basis,
          notes: notes.length > 0 ? notes : undefined,
        });
      }

      case 'calculate_interest': {
        const principal = input.principal as number;
        if (typeof principal !== 'number' || !Number.isFinite(principal) || principal <= 0) {
          return JSON.stringify({ error: 'Kwota główna musi być liczbą > 0.' });
        }
        const startDate = parseDate(input, 'start_date');
        if (!startDate) return JSON.stringify({ error: 'Data początkowa jest wymagana (YYYY-MM-DD).' });
        const endDate = parseDate(input, 'end_date') ?? new Date();
        if (endDate <= startDate) return JSON.stringify({ error: 'Data końcowa musi być po dacie początkowej.' });

        const interestType = (optString(input, 'interest_type') ?? 'za_opoznienie') as string;

        // Current rates (NBP reference rate 5.75% as of Feb 2026)
        // Art. 359 §2 KC: ustawowe = stopa referencyjna + 3.5pp = 9.25% (max 2x = 18.5%)
        // Art. 481 §2 KC: za opóźnienie = stopa referencyjna + 5.5pp = 11.25% (max 2x = 22.5%)
        // Art. 4 ustawy o terminach zapłaty: handlowe = stopa referencyjna + 10pp = 15.75%
        // Note: these are simplified current rates. In production, should track historical rate changes.

        let annualRate: number;
        let legalBasis: string;

        switch (interestType) {
          case 'ustawowe':
            annualRate = 9.25;
            legalBasis = 'Art. 359 §2 KC — odsetki ustawowe (stopa referencyjna NBP 5.75% + 3.5pp)';
            break;
          case 'handlowe':
            annualRate = 15.75;
            legalBasis = 'Art. 4 ust. 3 ustawy o przeciwdziałaniu nadmiernym opóźnieniom (stopa referencyjna NBP 5.75% + 10pp)';
            break;
          case 'za_opoznienie':
          default:
            annualRate = 11.25;
            legalBasis = 'Art. 481 §2 KC — odsetki ustawowe za opóźnienie (stopa referencyjna NBP 5.75% + 5.5pp)';
            break;
        }

        const days = Math.floor((endDate.getTime() - startDate.getTime()) / 86_400_000);
        const interest = principal * (annualRate / 100) * (days / 365);
        const total = principal + interest;

        return JSON.stringify({
          principal: `${principal.toFixed(2)} PLN`,
          interest_type: interestType,
          annual_rate: `${annualRate}%`,
          period: {
            from: startDate.toISOString().slice(0, 10),
            to: endDate.toISOString().slice(0, 10),
            days,
          },
          interest: `${interest.toFixed(2)} PLN`,
          total: `${total.toFixed(2)} PLN`,
          legal_basis: legalBasis,
          note: 'Obliczenie uproszczone (stała stopa). Przy zmianach stóp NBP w okresie naliczania należy obliczyć odsetki oddzielnie dla każdego podokresu.',
        });
      }

      case 'calculate_limitation': {
        const claimType = requireString(input, 'claim_type');
        if (!claimType) return JSON.stringify({ error: 'Typ roszczenia jest wymagany.' });
        const limitStartDate = parseDate(input, 'start_date');
        if (!limitStartDate) return JSON.stringify({ error: 'Data wymagalności roszczenia jest wymagana (YYYY-MM-DD).' });

        // Polish limitation periods (Art. 118+ KC and special statutes)
        const limitationRules: Record<string, { years: number; endOfYear: boolean; basis: string }> = {
          ogolne:                   { years: 6, endOfYear: true, basis: 'Art. 118 KC — ogólny termin przedawnienia 6 lat' },
          gospodarcze:              { years: 3, endOfYear: true, basis: 'Art. 118 KC — roszczenia związane z działalnością gospodarczą 3 lata' },
          okresowe:                 { years: 3, endOfYear: true, basis: 'Art. 118 KC — świadczenia okresowe 3 lata' },
          sprzedaz:                 { years: 2, endOfYear: true, basis: 'Art. 554 KC — roszczenia z tytułu sprzedaży 2 lata' },
          przewoz:                  { years: 1, endOfYear: false, basis: 'Art. 778 KC — roszczenia z umowy przewozu 1 rok' },
          delikt:                   { years: 3, endOfYear: true, basis: 'Art. 442¹ §1 KC — roszczenie z czynu niedozwolonego 3 lata (od dnia dowiedzenia się o szkodzie), max 10 lat od zdarzenia' },
          praca_wynagrodzenie:      { years: 3, endOfYear: false, basis: 'Art. 291 §1 KP — roszczenia ze stosunku pracy 3 lata' },
          praca_inne:               { years: 3, endOfYear: false, basis: 'Art. 291 §1 KP — roszczenia ze stosunku pracy 3 lata' },
          najem:                    { years: 1, endOfYear: false, basis: 'Art. 677 KC — roszczenia z najmu 1 rok od zwrotu rzeczy' },
          zlecenie:                 { years: 2, endOfYear: true, basis: 'Art. 751 KC — roszczenia z umowy zlecenia 2 lata' },
          dzielo_wada:              { years: 2, endOfYear: false, basis: 'Art. 646 KC — roszczenia z umowy o dzieło 2 lata od oddania dzieła' },
          ubezpieczenie:            { years: 3, endOfYear: true, basis: 'Art. 819 §1 KC — roszczenia z umowy ubezpieczenia 3 lata' },
          bezpodstawne_wzbogacenie: { years: 6, endOfYear: true, basis: 'Art. 118 KC — bezpodstawne wzbogacenie 6 lat (termin ogólny)' },
        };

        const rule = limitationRules[claimType];
        if (!rule) return JSON.stringify({ error: `Nieznany typ roszczenia: ${claimType}. Dostępne: ${Object.keys(limitationRules).join(', ')}` });

        const limitDate = new Date(limitStartDate);
        limitDate.setFullYear(limitDate.getFullYear() + rule.years);

        // Art. 118 KC: for periods >= 2 years, limitation ends on Dec 31
        if (rule.endOfYear) {
          limitDate.setMonth(11);
          limitDate.setDate(31);
        }

        const now = new Date();
        const isExpired = limitDate < now;
        const daysLeft = isExpired ? 0 : Math.ceil((limitDate.getTime() - now.getTime()) / 86_400_000);

        return JSON.stringify({
          claim_type: claimType,
          start_date: limitStartDate.toISOString().slice(0, 10),
          limitation_years: rule.years,
          ends_on_dec_31: rule.endOfYear,
          limitation_date: limitDate.toISOString().slice(0, 10),
          is_expired: isExpired,
          days_remaining: daysLeft,
          legal_basis: rule.basis,
          warnings: isExpired
            ? ['ROSZCZENIE PRZEDAWNIONE — dłużnik może podnieść zarzut przedawnienia (art. 117 §2 KC).']
            : daysLeft < 90
              ? [`Roszczenie przedawnia się za ${daysLeft} dni — rozważ przerwanie biegu przedawnienia (art. 123 KC).`]
              : undefined,
        });
      }

      // ===== EXTERNAL LOOKUPS =====
      case 'search_court_decisions': {
        const saosQuery = requireString(input, 'query');
        if (!saosQuery) return JSON.stringify({ error: 'Zapytanie jest wymagane.' });
        const saosLimit = Math.min(10, Math.max(1, optNumber(input, 'limit', 1, 10) ?? 5));

        try {
          const params = new URLSearchParams();
          params.set('all', saosQuery.slice(0, 500));
          params.set('pageSize', String(saosLimit));
          params.set('sortingField', 'JUDGMENT_DATE');
          params.set('sortingDirection', 'DESC');
          const courtType = optString(input, 'court_type');
          if (courtType) params.set('courtType', courtType);
          const dateFrom = optString(input, 'date_from');
          if (dateFrom) params.set('judgmentDateFrom', dateFrom);
          const dateTo = optString(input, 'date_to');
          if (dateTo) params.set('judgmentDateTo', dateTo);

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15_000);
          const resp = await fetch(`https://www.saos.org.pl/api/search/judgments?${params}`, {
            headers: { 'Accept': 'application/json' },
            signal: controller.signal,
          });
          clearTimeout(timeout);

          if (!resp.ok) {
            return JSON.stringify({ error: `SAOS API zwróciło błąd ${resp.status}. Spróbuj ponownie.` });
          }

          const data = await resp.json() as {
            items?: Array<{
              id: number;
              courtType?: string;
              courtCases?: Array<{ caseNumber: string }>;
              judgmentType?: string;
              judgmentDate?: string;
              judges?: Array<{ name: string; function?: string }>;
              textContent?: string;
              keywords?: string[];
              division?: { name?: string; court?: { name?: string } };
            }>;
            info?: { totalResults?: number };
          };

          const items = data.items ?? [];
          if (items.length === 0) {
            return JSON.stringify({ message: 'Nie znaleziono orzeczeń dla podanego zapytania.', results: [] });
          }

          const results = items.map(item => {
            const caseNumbers = (item.courtCases ?? []).map(c => c.caseNumber).join(', ');
            const courtName = item.division?.court?.name ?? item.courtType ?? '';
            const divisionName = item.division?.name ?? '';
            const judges = (item.judges ?? []).map(j => j.function ? `${j.name} (${j.function})` : j.name);
            // Extract first ~500 chars of textContent as excerpt
            let excerpt = '';
            if (item.textContent) {
              // Strip HTML tags
              const text = item.textContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
              excerpt = text.slice(0, 500) + (text.length > 500 ? '...' : '');
            }
            return {
              id: item.id,
              case_numbers: caseNumbers,
              court: courtName,
              division: divisionName,
              judgment_type: item.judgmentType,
              judgment_date: item.judgmentDate,
              judges: judges.slice(0, 5),
              keywords: (item.keywords ?? []).slice(0, 10),
              excerpt,
              url: `https://www.saos.org.pl/judgments/${item.id}`,
            };
          });

          return JSON.stringify({
            query: saosQuery,
            total_results: data.info?.totalResults ?? results.length,
            count: results.length,
            results,
          });
        } catch (err: any) {
          if (err?.name === 'AbortError') {
            return JSON.stringify({ error: 'SAOS API nie odpowiedziało w ciągu 15 sekund. Spróbuj ponownie.' });
          }
          logger.warn({ err }, 'SAOS API error');
          return JSON.stringify({ error: 'Nie udało się połączyć z SAOS API. Sprawdź połączenie internetowe.' });
        }
      }

      case 'lookup_company': {
        const companyQuery = requireString(input, 'query');
        if (!companyQuery) return JSON.stringify({ error: 'Podaj NIP, numer KRS lub nazwę firmy.' });
        const registry = (optString(input, 'registry') ?? 'auto') as string;

        const results: { source: string; data: any }[] = [];

        // Detect query type
        const cleanQuery = companyQuery.replace(/[-\s]/g, '');
        const isNip = /^\d{10}$/.test(cleanQuery);
        const isKrs = /^\d{10}$/.test(cleanQuery) || /^\d{1,10}$/.test(cleanQuery);

        // KRS lookup via api.dane.gov.pl/1.4/resources/50410,50411/data
        const shouldSearchKrs = registry === 'krs' || registry === 'auto';
        const shouldSearchCeidg = registry === 'ceidg' || registry === 'auto';

        if (shouldSearchKrs) {
          try {
            const krsParams = new URLSearchParams();
            if (isNip) {
              krsParams.set('q', cleanQuery);
            } else {
              krsParams.set('q', companyQuery.slice(0, 200));
            }
            krsParams.set('page', '1');
            krsParams.set('per_page', '3');

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10_000);
            const resp = await fetch(`https://api-krs.ms.gov.pl/api/krs/OdpisPelny/${isKrs && /^\d{10}$/.test(cleanQuery) ? cleanQuery : ''}?rejestr=P&format=json`, {
              headers: { 'Accept': 'application/json' },
              signal: controller.signal,
            }).catch(() => null);
            clearTimeout(timeout);

            // Fallback: use dane.gov.pl KRS proxy
            if (!resp || !resp.ok) {
              const daneController = new AbortController();
              const daneTimeout = setTimeout(() => daneController.abort(), 10_000);
              const daneResp = await fetch(`https://api.dane.gov.pl/1.4/resources/50410/data?q=${encodeURIComponent(companyQuery.slice(0, 200))}&page=1&per_page=3&format=json`, {
                headers: { 'Accept': 'application/json' },
                signal: daneController.signal,
              }).catch(() => null);
              clearTimeout(daneTimeout);

              if (daneResp?.ok) {
                const daneData = await daneResp.json() as any;
                const items = daneData?.data ?? [];
                for (const item of items.slice(0, 3)) {
                  const attrs = item?.attributes ?? {};
                  results.push({
                    source: 'KRS (dane.gov.pl)',
                    data: {
                      krs: attrs.krs_podmioty_krs,
                      nip: attrs.krs_podmioty_nip,
                      regon: attrs.krs_podmioty_regon,
                      name: attrs.krs_podmioty_nazwa,
                      form: attrs.krs_podmioty_forma_prawna,
                      address: [attrs.krs_podmioty_adres_ulica, attrs.krs_podmioty_adres_numer, attrs.krs_podmioty_adres_kod_pocztowy, attrs.krs_podmioty_adres_miejscowosc].filter(Boolean).join(' '),
                      registration_date: attrs.krs_podmioty_data_rejestracji,
                    },
                  });
                }
              }
            }
          } catch (err) {
            logger.warn({ err }, 'KRS lookup error');
          }
        }

        if (shouldSearchCeidg && isNip) {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10_000);
            const resp = await fetch(`https://dane.biznes.gov.pl/api/ceidg/v2/firmy?nip=${cleanQuery}`, {
              headers: { 'Accept': 'application/json' },
              signal: controller.signal,
            }).catch(() => null);
            clearTimeout(timeout);

            if (resp?.ok) {
              const ceidgData = await resp.json() as any;
              const firms = ceidgData?.firmy ?? [];
              for (const firm of firms.slice(0, 3)) {
                results.push({
                  source: 'CEIDG',
                  data: {
                    name: firm.nazwa,
                    nip: firm.wlasciciel?.nip,
                    regon: firm.wlasciciel?.regon,
                    owner: firm.wlasciciel ? `${firm.wlasciciel.imie} ${firm.wlasciciel.nazwisko}` : undefined,
                    status: firm.status,
                    start_date: firm.dataRozpoczecia,
                    address: firm.adresDzialalnosci ? `${firm.adresDzialalnosci.ulica ?? ''} ${firm.adresDzialalnosci.budynek ?? ''}, ${firm.adresDzialalnosci.kodPocztowy ?? ''} ${firm.adresDzialalnosci.miasto ?? ''}` : undefined,
                    pkd: firm.pkd,
                  },
                });
              }
            }
          } catch (err) {
            logger.warn({ err }, 'CEIDG lookup error');
          }
        }

        if (results.length === 0) {
          return JSON.stringify({
            message: `Nie znaleziono danych dla "${companyQuery}" w ${registry === 'auto' ? 'KRS ani CEIDG' : registry.toUpperCase()}.`,
            hint: isNip ? 'Upewnij się, że NIP jest poprawny.' : 'Spróbuj wyszukać po NIP dla dokładniejszych wyników.',
          });
        }

        return JSON.stringify({ query: companyQuery, count: results.length, results });
      }

      // ===== UPLOADED DOCUMENT ANALYSIS =====
      case 'get_uploaded_document': {
        const udDocId = requireString(input, 'id');
        if (!udDocId) return JSON.stringify({ error: 'ID dokumentu jest wymagane.' });
        const udDoc = db.getDocument(udDocId);
        if (!udDoc) return JSON.stringify({ error: 'Dokument nie znaleziony.' });
        const maxChars = optNumber(input, 'max_chars', 100, 200_000) ?? 10_000;
        const content = udDoc.content.slice(0, maxChars);
        const truncated = udDoc.content.length > maxChars;
        return JSON.stringify({
          id: udDoc.id,
          title: udDoc.title,
          type: udDoc.type,
          total_chars: udDoc.content.length,
          truncated,
          content,
          hint: truncated ? `Dokument ma ${udDoc.content.length} znaków. Wyświetlono ${maxChars}. Użyj max_chars aby pobrać więcej.` : undefined,
        });
      }

      // ===== INVOICES =====
      case 'create_invoice': {
        const invClientId = requireString(input, 'client_id');
        if (!invClientId) return JSON.stringify({ error: 'ID klienta jest wymagane.' });
        if (!db.getClient(invClientId)) return JSON.stringify({ error: 'Klient nie znaleziony.' });
        const invNumber = requireString(input, 'number');
        if (!invNumber) return JSON.stringify({ error: 'Numer faktury jest wymagany.' });
        const invAmount = input.amount as number;
        if (typeof invAmount !== 'number' || !Number.isFinite(invAmount) || invAmount < 0) {
          return JSON.stringify({ error: 'Kwota musi być liczbą >= 0.' });
        }
        const invCaseId = optString(input, 'case_id');
        if (invCaseId && !db.getCase(invCaseId)) return JSON.stringify({ error: 'Sprawa nie znaleziona.' });
        const dueDays = optNumber(input, 'due_days', 1, 365) ?? 14;
        const issuedAt = new Date();
        const dueAt = new Date(issuedAt.getTime() + dueDays * 24 * 60 * 60 * 1000);
        const invoice = db.createInvoice({
          clientId: invClientId,
          caseId: invCaseId,
          number: invNumber,
          amount: invAmount,
          currency: (optString(input, 'currency') ?? 'PLN').toUpperCase(),
          status: 'szkic',
          issuedAt,
          dueAt,
          notes: optString(input, 'notes'),
        });
        return JSON.stringify({ success: true, invoice });
      }
      case 'list_invoices': {
        const invoices = db.listInvoices({
          clientId: optString(input, 'client_id'),
          caseId: optString(input, 'case_id'),
          status: optString(input, 'status'),
        });
        return JSON.stringify({ count: invoices.length, invoices });
      }
      case 'get_invoice': {
        const gInvId = requireString(input, 'id');
        if (!gInvId) return JSON.stringify({ error: 'ID faktury jest wymagane.' });
        const inv = db.getInvoice(gInvId);
        if (!inv) return JSON.stringify({ error: 'Faktura nie znaleziona.' });
        return JSON.stringify(inv);
      }
      case 'update_invoice': {
        const uInvId = requireString(input, 'id');
        if (!uInvId) return JSON.stringify({ error: 'ID faktury jest wymagane.' });
        const existingInv = db.getInvoice(uInvId);
        if (!existingInv) return JSON.stringify({ error: 'Faktura nie znaleziona.' });
        const invUpdates: Record<string, unknown> = {};
        const newStatus = optString(input, 'status');
        if (newStatus) {
          const VALID_INV_STATUSES = ['szkic', 'wystawiona', 'oplacona', 'zalegla'];
          if (!VALID_INV_STATUSES.includes(newStatus)) return JSON.stringify({ error: `Status musi być: ${VALID_INV_STATUSES.join(', ')}` });
          invUpdates.status = newStatus;
          if (newStatus === 'oplacona') invUpdates.paidAt = new Date();
        }
        const newAmount = optNumber(input, 'amount', 0);
        if (newAmount !== undefined) invUpdates.amount = newAmount;
        const invNotes = optString(input, 'notes');
        if (invNotes !== undefined) invUpdates.notes = invNotes;
        const updated = db.updateInvoice(uInvId, invUpdates as any);
        return JSON.stringify({ success: true, invoice: updated });
      }
      // ===== DOCUMENT TEMPLATES =====
      case 'save_template': {
        const tplName = requireString(input, 'name');
        if (!tplName) return JSON.stringify({ error: 'Nazwa szablonu jest wymagana.' });
        const tplContent = requireString(input, 'content');
        if (!tplContent) return JSON.stringify({ error: 'Treść szablonu jest wymagana.' });
        const rawTplType = optString(input, 'type') ?? 'pismo_procesowe';
        if (!VALID_DOC_TYPES.includes(rawTplType as any)) return JSON.stringify({ error: `Typ szablonu musi być: ${VALID_DOC_TYPES.join(', ')}` });
        const template = db.createTemplate({
          name: tplName,
          type: rawTplType as any,
          content: tplContent,
          description: optString(input, 'description'),
          lawArea: optString(input, 'lawArea') as any,
          tags: optString(input, 'tags'),
        });
        return JSON.stringify({
          success: true,
          template: { id: template.id, name: template.name, type: template.type },
          message: `Szablon "${template.name}" zapisany. Użyj: use_template z ID: ${template.id}`,
        });
      }
      case 'list_templates': {
        const templates = db.listTemplates({
          type: optString(input, 'type'),
          lawArea: optString(input, 'lawArea'),
          query: optString(input, 'query', 500),
        });
        return JSON.stringify({
          templates: templates.map(t => ({
            id: t.id, name: t.name, type: t.type,
            description: t.description, lawArea: t.lawArea,
            tags: t.tags, useCount: t.useCount,
          })),
          count: templates.length,
        });
      }
      case 'use_template': {
        const utId = requireString(input, 'templateId');
        if (!utId) return JSON.stringify({ error: 'ID szablonu jest wymagane.' });
        const template = db.getTemplate(utId);
        if (!template) return JSON.stringify({ error: 'Szablon nie znaleziony' });
        db.incrementTemplateUseCount(template.id);
        return JSON.stringify({
          template: {
            id: template.id, name: template.name, type: template.type,
            description: template.description,
          },
          content: template.content,
          message: `Szablon "${template.name}" — wypełnij placeholdery i dostosuj do sprawy.`,
        });
      }
      case 'update_document': {
        const udId = requireString(input, 'id');
        if (!udId) return JSON.stringify({ error: 'ID dokumentu jest wymagane.' });
        const existing = db.getDocument(udId);
        if (!existing) return JSON.stringify({ error: 'Dokument nie znaleziony.' });
        if (existing.status === 'zatwierdzony' || existing.status === 'zlozony') {
          return JSON.stringify({ error: `Nie można edytować dokumentu o statusie "${existing.status}". Utwórz nową wersję.` });
        }
        const udUpdates: Record<string, unknown> = {};
        if (input.title !== undefined) udUpdates.title = optString(input, 'title');
        if (input.content !== undefined) {
          const udContent = optString(input, 'content', 100000);
          if (udContent && udContent.length > 100000) return JSON.stringify({ error: 'Treść za długa (maks. 100 000 znaków).' });
          udUpdates.content = udContent;
        }
        if (input.notes !== undefined) udUpdates.notes = optString(input, 'notes');
        const updatedDoc = db.updateDocument(udId, udUpdates as any);
        if (!updatedDoc) return JSON.stringify({ error: 'Nie udało się zaktualizować dokumentu.' });
        return JSON.stringify({ success: true, document: { id: updatedDoc.id, title: updatedDoc.title, status: updatedDoc.status } });
      }
      case 'complete_deadline': {
        const cdId = requireString(input, 'id');
        if (!cdId) return JSON.stringify({ error: 'ID terminu jest wymagane.' });
        db.completeDeadline(cdId);
        return JSON.stringify({ success: true, message: 'Termin oznaczony jako wykonany.' });
      }
      case 'update_deadline': {
        const udlId = requireString(input, 'id');
        if (!udlId) return JSON.stringify({ error: 'ID terminu jest wymagane.' });
        const udlUpdates: Partial<{ title: string; date: Date; type: string; notes: string; reminderDaysBefore: number }> = {};
        if (input.title !== undefined) udlUpdates.title = optString(input, 'title');
        if (input.date !== undefined) {
          const d = parseDate(input, 'date');
          if (!d) return JSON.stringify({ error: 'Nieprawidłowy format daty.' });
          udlUpdates.date = d;
        }
        if (input.type !== undefined) {
          const t = optString(input, 'type');
          if (t && !VALID_DEADLINE_TYPES.includes(t as any)) return JSON.stringify({ error: `Typ terminu musi być: ${VALID_DEADLINE_TYPES.join(', ')}` });
          udlUpdates.type = t;
        }
        if (input.notes !== undefined) udlUpdates.notes = optString(input, 'notes');
        if (input.reminderDaysBefore !== undefined) {
          udlUpdates.reminderDaysBefore = optNumber(input, 'reminderDaysBefore', 0, 365);
        }
        const updatedDl = db.updateDeadline(udlId, udlUpdates as any);
        if (!updatedDl) return JSON.stringify({ error: 'Termin nie znaleziony.' });
        return JSON.stringify({ success: true, deadline: updatedDl });
      }
      case 'search_cases': {
        const scQuery = requireString(input, 'query');
        if (!scQuery) return JSON.stringify({ error: 'Fraza wyszukiwania jest wymagana.' });
        const results = db.searchCases(scQuery.slice(0, 500));
        return JSON.stringify({ cases: results, count: results.length });
      }
      case 'delete_document': {
        const ddId = requireString(input, 'id');
        if (!ddId) return JSON.stringify({ error: 'ID dokumentu jest wymagane.' });
        const ddDoc = db.getDocument(ddId);
        if (!ddDoc) return JSON.stringify({ error: 'Dokument nie znaleziony.' });
        if (ddDoc.status === 'zatwierdzony' || ddDoc.status === 'zlozony') {
          return JSON.stringify({ error: `Nie można usunąć dokumentu o statusie "${ddDoc.status}".` });
        }
        db.deleteDocument(ddId);
        return JSON.stringify({ success: true, message: `Dokument "${ddDoc.title}" usunięty.` });
      }
      case 'list_document_versions': {
        const dvId = requireString(input, 'id');
        if (!dvId) return JSON.stringify({ error: 'ID dokumentu jest wymagane.' });
        const versions = db.getDocumentVersions(dvId);
        if (versions.length === 0) return JSON.stringify({ error: 'Dokument nie znaleziony.' });
        return JSON.stringify({
          count: versions.length,
          versions: versions.map(v => ({
            id: v.id, version: v.version, status: v.status,
            title: v.title, updatedAt: v.updatedAt,
          })),
        });
      }
      case 'get_case_timeline': {
        const tlCaseId = resolveCaseId(input, session);
        if (!tlCaseId) return JSON.stringify({ error: 'Brak ID sprawy. Podaj case_id lub ustaw aktywną sprawę.' });
        const tlCase = db.getCase(tlCaseId);
        if (!tlCase) return JSON.stringify({ error: 'Sprawa nie znaleziona.' });
        const docs = db.listDocuments({ caseId: tlCaseId });
        const deadlines = db.listDeadlines({ caseId: tlCaseId });
        const timeEntries = db.listTimeEntries(tlCaseId);
        const invoices = db.listInvoices({ caseId: tlCaseId });

        type TimelineEvent = { date: Date; type: string; description: string };
        const events: TimelineEvent[] = [];

        events.push({ date: tlCase.createdAt, type: 'utworzenie', description: `Sprawa utworzona: ${tlCase.title}` });
        for (const d of docs) {
          events.push({ date: d.createdAt, type: 'dokument', description: `${d.type}: "${d.title}" (${d.status})` });
        }
        for (const dl of deadlines) {
          events.push({ date: dl.date, type: dl.completed ? 'termin_zrealizowany' : 'termin', description: `${dl.type}: ${dl.title}` });
        }
        for (const te of timeEntries) {
          events.push({ date: te.date, type: 'czas_pracy', description: `${te.durationMinutes} min — ${te.description}` });
        }
        for (const inv of invoices) {
          events.push({ date: inv.issuedAt, type: 'faktura', description: `${inv.number}: ${inv.amount} ${inv.currency} (${inv.status})` });
        }

        events.sort((a, b) => a.date.getTime() - b.date.getTime());

        return JSON.stringify({
          case: tlCase.title,
          sygnatura: tlCase.sygnatura,
          totalEvents: events.length,
          timeline: events.map(e => ({
            date: e.date.toLocaleDateString('pl-PL'),
            type: e.type,
            description: e.description,
          })),
        });
      }
      case 'delete_deadline': {
        const delDlId = requireString(input, 'id');
        if (!delDlId) return JSON.stringify({ error: 'ID terminu jest wymagane.' });
        db.deleteDeadline(delDlId);
        return JSON.stringify({ success: true, message: 'Termin usunięty.' });
      }
      case 'update_client': {
        const ucId = requireString(input, 'id');
        if (!ucId) return JSON.stringify({ error: 'ID klienta jest wymagane.' });
        if (!db.getClient(ucId)) return JSON.stringify({ error: 'Klient nie znaleziony.' });
        const ucUpdates: Record<string, unknown> = {};
        if (input.name !== undefined) ucUpdates.name = optString(input, 'name');
        if (input.email !== undefined) ucUpdates.email = optString(input, 'email');
        if (input.phone !== undefined) ucUpdates.phone = optString(input, 'phone');
        if (input.address !== undefined) ucUpdates.address = optString(input, 'address');
        if (input.notes !== undefined) ucUpdates.notes = optString(input, 'notes');
        const updatedClient = db.updateClient(ucId, ucUpdates as any);
        if (!updatedClient) return JSON.stringify({ error: 'Nie udało się zaktualizować klienta.' });
        return JSON.stringify({ success: true, client: updatedClient });
      }
      case 'delete_client': {
        const dcId = requireString(input, 'id');
        if (!dcId) return JSON.stringify({ error: 'ID klienta jest wymagane.' });
        if (!db.getClient(dcId)) return JSON.stringify({ error: 'Klient nie znaleziony.' });
        db.deleteClient(dcId);
        return JSON.stringify({ success: true, message: 'Klient i powiązane dane usunięte.' });
      }
      case 'delete_case': {
        const delCaseId = requireString(input, 'id');
        if (!delCaseId) return JSON.stringify({ error: 'ID sprawy jest wymagane.' });
        if (!db.getCase(delCaseId)) return JSON.stringify({ error: 'Sprawa nie znaleziona.' });
        db.deleteCase(delCaseId);
        return JSON.stringify({ success: true, message: 'Sprawa i powiązane dane usunięte.' });
      }
      // ── Privacy & Compliance Tools ──
      case 'record_ai_consent': {
        const conCaseId = resolveCaseId(input, session);
        if (!conCaseId) return JSON.stringify({ error: 'ID sprawy jest wymagane.' });
        if (!db.getCase(conCaseId)) return JSON.stringify({ error: 'Sprawa nie znaleziona.' });
        const scope = optString(input, 'scope') ?? 'local_only';
        const notes = optString(input, 'notes');
        const consent = db.recordAiConsent(conCaseId, session.userId, scope, notes ?? undefined);
        logPrivacyEvent({ action: 'consent_record', sessionKey: session.key, userId: session.userId, caseId: conCaseId, reason: `scope=${scope}` });
        return JSON.stringify({ success: true, consent, message: `Zgoda na AI zarejestrowana (zakres: ${scope}).` });
      }
      case 'check_ai_consent': {
        const chkCaseId = resolveCaseId(input, session);
        if (!chkCaseId) return JSON.stringify({ error: 'ID sprawy jest wymagane.' });
        const consent = db.getAiConsent(chkCaseId);
        logPrivacyEvent({ action: 'consent_check', sessionKey: session.key, userId: session.userId, caseId: chkCaseId, reason: 'consent_checked' });
        if (!consent) return JSON.stringify({ hasConsent: false, message: 'Brak zgody na AI dla tej sprawy.' });
        return JSON.stringify({ hasConsent: true, consent });
      }
      case 'revoke_ai_consent': {
        const revCaseId = resolveCaseId(input, session);
        if (!revCaseId) return JSON.stringify({ error: 'ID sprawy jest wymagane.' });
        const revoked = db.revokeAiConsent(revCaseId);
        if (!revoked) return JSON.stringify({ error: 'Brak aktywnej zgody do cofnięcia.' });
        logPrivacyEvent({ action: 'consent_revoke', sessionKey: session.key, userId: session.userId, caseId: revCaseId, reason: 'consent_revoked' });
        return JSON.stringify({ success: true, message: 'Zgoda na AI cofnięta.' });
      }
      case 'gdpr_delete_client': {
        const gdprClientId = requireString(input, 'clientId');
        if (!gdprClientId) return JSON.stringify({ error: 'ID klienta jest wymagane.' });
        if (input.confirm !== true) return JSON.stringify({ error: 'Wymagane potwierdzenie: confirm=true. Operacja jest NIEODWRACALNA — trwale usuwa wszystkie dane klienta.' });
        const client = db.getClient(gdprClientId);
        if (!client) return JSON.stringify({ error: 'Klient nie znaleziony.' });
        const result = db.gdprDeleteClient(gdprClientId);
        logPrivacyEvent({ action: 'gdpr_delete', sessionKey: session.key, userId: session.userId, reason: `client_deleted`, privacyMode: (session.metadata?.privacyMode as string) ?? 'auto' });
        return JSON.stringify({ success: true, ...result, message: `Dane klienta trwale usunięte (Art. 17 RODO). Usunięto ${result.deletedCases} spraw, ${result.deletedDocuments} dokumentów, oczyszczono ${result.scrubbedSessions} sesji.` });
      }
      case 'set_case_privacy': {
        const scpCaseId = requireString(input, 'caseId');
        if (!scpCaseId) return JSON.stringify({ error: 'ID sprawy jest wymagane.' });
        const mode = requireString(input, 'privacyMode');
        if (!mode || !['auto', 'strict', 'off'].includes(mode)) return JSON.stringify({ error: 'Tryb musi być: auto, strict lub off.' });
        const updated = db.updateCase(scpCaseId, { privacyMode: mode as 'auto' | 'strict' | 'off' });
        if (!updated) return JSON.stringify({ error: 'Sprawa nie znaleziona.' });
        logPrivacyEvent({ action: 'mode_change', sessionKey: session.key, userId: session.userId, caseId: scpCaseId, reason: `case_privacy_set_${mode}`, privacyMode: mode });
        return JSON.stringify({ success: true, message: `Tryb prywatności sprawy ustawiony na: ${mode}.` });
      }
      default:
        return JSON.stringify({ error: `Nieznane narzędzie: ${name}` });
    }
  } catch (err) {
    logger.error({ err, tool: name }, 'Tool execution error');
    const msg = err instanceof Error ? err.message.slice(0, 100) : 'unknown';
    return JSON.stringify({ error: `Błąd wykonania narzędzia ${name}: ${msg}` });
  }
}

// =============================================================================
// SMART MODEL ROUTING
// =============================================================================

/** Classify whether a message needs the full (heavy) model or can use the speed model */
function isSimpleQuery(text: string): boolean {
  const lower = text.toLowerCase().trim();
  const len = lower.length;

  // Check complex patterns FIRST (even short messages like "napisz pozew" need full model)
  const complexPatterns = [
    /napisz (pozew|apelacj|odpowiedź|pismo|umow|wezwanie|wniosek|opini)/,
    /przygotuj (projekt|dokument|pismo)/,
    /przeanalizuj|analiz[auy]/,
    /sporządź|zredaguj/,
    /wyjaśnij.{20,}/,   // long explanation requests
    /porównaj|zestawienie/,
  ];
  for (const pat of complexPatterns) {
    if (pat.test(lower)) return false;
  }

  // Very short messages — greetings, confirmations, simple questions
  if (len < 60) return true;

  // Explicit tool triggers that the speed model handles fine
  const speedPatterns = [
    /^(cześć|hej|dzień dobry|witam|siema|hi|hello)/,
    /^(tak|nie|ok|dobrze|dzięki|dziękuję)/,
    /ile wynos|oblicz|policz|kalkul/,
    /opłat[aey]\s+sądow/,
    /odsetek|odsetki/,
    /przedawnien/,
    /wyszukaj.*(firm|krs|ceidg|nip)/,
    /szukaj.*(orzecz|wyrok)/,
    /art(ykuł)?\s*\.?\s*\d/,
    /jaki (jest|są) (termin|status)/,
    /pokaż (sprawy|klient|termin|faktur|dokument)/,
    /lista (spraw|klient|termin|faktur|dokument)/,
  ];
  for (const pat of speedPatterns) {
    if (pat.test(lower)) return true;
  }

  // Medium-length messages default to speed model (complex already caught above)
  if (len < 200) return true;

  // Long messages go to the full model
  return false;
}

/** Check if a model is available in Ollama */
async function checkOllamaModel(ollamaUrl: string, model: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const resp = await fetch(`${ollamaUrl}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return false;
    const data = await resp.json() as { models?: Array<{ name: string }> };
    const models = data.models ?? [];
    const baseName = model.split(':')[0];
    return models.some(m => m.name === model || m.name === baseName || m.name.startsWith(baseName + ':'));
  } catch {
    return false;
  }
}

// =============================================================================
// PRIVACY-AWARE ROUTING
// =============================================================================

type PrivacyDecision = 'local' | 'cloud_anonymized' | 'refuse';

/**
 * Classify privacy sensitivity of the current request.
 * Scans: current message, active case context, recent conversation history.
 */
function classifyPrivacy(
  text: string,
  session: Session,
  config: Config,
  db: Database
): { decision: PrivacyDecision; reason: string } {
  const mode = (session.metadata?.privacyMode as string) ?? config.privacy.mode;

  // Off = no protection
  if (mode === 'off') {
    return { decision: 'cloud_anonymized', reason: 'privacy_off' };
  }

  // Check current message for PII
  const msgResult = detectPii(text);
  let hasPii = msgResult.hasPii || msgResult.hasSensitiveKeywords;

  // Active case context = always sensitive (contains client name, case details)
  const activeCaseId = typeof session.metadata?.activeCaseId === 'string' ? session.metadata.activeCaseId : undefined;
  if (activeCaseId) {
    const activeCase = db.getCase(activeCaseId);
    if (activeCase) {
      hasPii = true; // Active case always has client PII in system prompt
      // Per-case privacy override (e.g. strict for criminal/family cases)
      if (activeCase.privacyMode === 'strict') {
        return { decision: 'local', reason: 'case_strict_mode' };
      }
    }
  }

  // Scan last 20 conversation messages for PII (must match Anthropic context window)
  if (!hasPii) {
    const recentMessages = (session.messages ?? []).slice(-20);
    for (const msg of recentMessages) {
      if (containsSensitiveData(msg.content)) {
        hasPii = true;
        break;
      }
    }
  }

  // Strict mode = always local
  if (mode === 'strict') {
    return { decision: 'local', reason: 'strict_mode' };
  }

  // Auto mode with PII detected = force local
  if (hasPii) {
    return { decision: 'local', reason: 'pii_detected' };
  }

  // Auto mode, no PII = cloud is OK (with anonymization as safety net)
  return { decision: 'cloud_anonymized', reason: 'no_pii' };
}

/** Quick probe: is Ollama reachable? */
async function isOllamaUp(ollamaUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    const resp = await fetch(`${ollamaUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    return resp.ok;
  } catch {
    return false;
  }
}

// =============================================================================
// AGENT
// =============================================================================

export interface Agent {
  handleMessage(text: string, session: Session): Promise<string | null>;
}

export function createAgent(config: Config, db: Database): Agent {
  let speedModelAvailable: boolean | null = null; // null = not yet checked
  let speedModelLastCheck = 0; // timestamp of last check
  const SPEED_MODEL_RECHECK_MS = 300_000; // Re-check every 5 minutes
  const speedModel = config.agent.speedModel;

  return {
    async handleMessage(text: string, session: Session): Promise<string | null> {
      // --- Privacy-aware routing ---
      const privacy = classifyPrivacy(text, session, config, db);
      const activeCaseId = typeof session.metadata?.activeCaseId === 'string' ? session.metadata.activeCaseId : undefined;
      const piiResult = detectPii(text);

      if (privacy.decision === 'local' || privacy.decision === 'refuse') {
        // Must use local model — check if Ollama is available
        const ollamaUp = await isOllamaUp(config.agent.ollamaUrl);

        if (!ollamaUp) {
          if (privacy.decision === 'refuse') {
            logPrivacyEvent({ action: 'route_refuse', sessionKey: session.key, userId: session.userId, caseId: activeCaseId, reason: privacy.reason, piiMatchCount: piiResult.matches.length, piiTypes: [...new Set(piiResult.matches.map(m => m.type))], privacyMode: (session.metadata?.privacyMode as string) ?? config.privacy.mode });
            return '⚠️ **Ochrona prywatności**: Wykryto dane wrażliwe, a lokalny model AI (Ollama) jest niedostępny. Nie mogę przetworzyć tej wiadomości przez zewnętrzny serwer ze względu na tajemnicę adwokacką. Uruchom Ollama (`ollama serve`) i spróbuj ponownie.';
          }
          // decision === 'local' (PII detected, Ollama down)
          // case_strict_mode = ALWAYS block cloud, regardless of blockCloudOnPii setting
          if (privacy.reason === 'case_strict_mode') {
            logPrivacyEvent({ action: 'route_refuse', sessionKey: session.key, userId: session.userId, caseId: activeCaseId, reason: 'case_strict_ollama_down', piiMatchCount: piiResult.matches.length, piiTypes: [...new Set(piiResult.matches.map(m => m.type))], privacyMode: (session.metadata?.privacyMode as string) ?? config.privacy.mode });
            logger.warn({ reason: privacy.reason }, 'Sprawa w trybie ścisłym — Ollama niedostępna, blokuję przekazanie do chmury');
            return '⚠️ **Ochrona prywatności**: Sprawa ma włączony tryb ścisły (strict). Lokalny model AI (Ollama) jest niedostępny. Ze względu na tajemnicę adwokacką nie mogę przekazać danych tej sprawy do zewnętrznego serwera. Uruchom Ollama (`ollama serve`) i spróbuj ponownie.';
          }
          if (config.privacy.blockCloudOnPii) {
            logPrivacyEvent({ action: 'route_refuse', sessionKey: session.key, userId: session.userId, caseId: activeCaseId, reason: 'pii_ollama_down_blocked', piiMatchCount: piiResult.matches.length, piiTypes: [...new Set(piiResult.matches.map(m => m.type))], privacyMode: (session.metadata?.privacyMode as string) ?? config.privacy.mode });
            logger.warn({ reason: privacy.reason }, 'Wykryto dane wrażliwe — Ollama niedostępna, blokuję przekazanie do chmury');
            return '⚠️ **Ochrona prywatności**: Wykryto dane osobowe (PESEL, NIP, dane klienta) w wiadomości lub kontekście aktywnej sprawy. Lokalny model AI (Ollama) jest niedostępny. Ze względu na ochronę tajemnicy adwokackiej nie mogę przekazać tych danych do zewnętrznego serwera. Uruchom Ollama (`ollama serve`) lub wyłącz kontekst aktywnej sprawy (`/clear`).';
          }
          // blockCloudOnPii=false → fall through to cloud, but FORCE anonymization
          logger.warn({ reason: privacy.reason }, 'blockCloudOnPii=false — wymuszam anonimizację przed wysłaniem do chmury');
        } else {
          // Ollama is up — route locally
          if (privacy.reason === 'pii_detected' || privacy.reason === 'strict_mode' || privacy.reason === 'case_strict_mode') {
            logPrivacyEvent({ action: 'route_local', sessionKey: session.key, userId: session.userId, caseId: activeCaseId, reason: privacy.reason, piiMatchCount: piiResult.matches.length, piiTypes: [...new Set(piiResult.matches.map(m => m.type))], privacyMode: (session.metadata?.privacyMode as string) ?? config.privacy.mode, provider: 'ollama' });
            logger.info({ reason: privacy.reason }, 'Wykryto dane wrażliwe — wymuszam routing lokalny');
          }

          // Check speed model availability (re-check periodically)
          if (speedModel && (speedModelAvailable === null || Date.now() - speedModelLastCheck > SPEED_MODEL_RECHECK_MS)) {
            speedModelAvailable = await checkOllamaModel(config.agent.ollamaUrl, speedModel);
            speedModelLastCheck = Date.now();
            if (speedModelAvailable) {
              logger.info({ speedModel }, 'Speed model dostępny — routing aktywny');
            } else {
              logger.info({ speedModel }, 'Speed model niedostępny — użyj: ollama pull ' + speedModel);
            }
          }

          const useSpeed = speedModelAvailable && speedModel && isSimpleQuery(text);
          const modelToUse = useSpeed ? speedModel : config.agent.model;

          try {
            return await handleWithOllama(text, session, config, db, modelToUse);
          } catch (err) {
            // If Ollama fails and PII is present, refuse — do NOT fall back to cloud
            if (privacy.reason === 'pii_detected' || privacy.reason === 'strict_mode' || privacy.reason === 'case_strict_mode') {
              logger.error({ err }, 'Ollama error z danymi wrażliwymi — odmowa');
              return '⚠️ **Ochrona prywatności**: Lokalny model AI zwrócił błąd. Ze względu na dane wrażliwe w wiadomości nie mogę przełączyć na model zewnętrzny. Spróbuj ponownie.';
            }
            throw err;
          }
        }
      }

      // --- Cloud path (no PII, or privacy=off, or blockCloudOnPii=false) ---
      // forceAnonymize when PII was detected but cloud is allowed (blockCloudOnPii=false fallthrough)
      const piiDetectedForCloud = privacy.reason === 'pii_detected' || privacy.reason === 'strict_mode' || privacy.reason === 'case_strict_mode';

      // If using Anthropic as primary, skip Ollama
      if (config.agent.provider === 'anthropic' && config.agent.anthropicKey) {
        logPrivacyEvent({ action: 'route_cloud', sessionKey: session.key, userId: session.userId, caseId: activeCaseId, reason: privacy.reason, piiMatchCount: piiResult.matches.length, piiTypes: [...new Set(piiResult.matches.map(m => m.type))], privacyMode: (session.metadata?.privacyMode as string) ?? config.privacy.mode, provider: 'anthropic' });
        return await handleWithAnthropic(text, session, config, db, piiDetectedForCloud);
      }

      // Check speed model availability (re-check periodically)
      if (speedModel && (speedModelAvailable === null || Date.now() - speedModelLastCheck > SPEED_MODEL_RECHECK_MS)) {
        speedModelAvailable = await checkOllamaModel(config.agent.ollamaUrl, speedModel);
        speedModelLastCheck = Date.now();
        if (speedModelAvailable) {
          logger.info({ speedModel }, 'Speed model dostępny — routing aktywny');
        } else {
          logger.info({ speedModel }, 'Speed model niedostępny — użyj: ollama pull ' + speedModel);
        }
      }

      // Route to speed model for simple queries
      const useSpeed = speedModelAvailable && speedModel && isSimpleQuery(text);
      const modelToUse = useSpeed ? speedModel : config.agent.model;

      if (useSpeed) {
        logger.debug({ model: modelToUse }, 'Routing → speed model');
      }

      try {
        return await handleWithOllama(text, session, config, db, modelToUse);
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        const isOllamaDown = msg.includes('nie jest uruchomiony') || msg.includes('nie odpowiedział') || msg.includes('Nie można połączyć');

        // If speed model failed, retry with main model
        if (useSpeed && !isOllamaDown) {
          logger.warn({ err: msg }, 'Speed model błąd — przełączam na główny model');
          try {
            return await handleWithOllama(text, session, config, db, config.agent.model);
          } catch (retryErr) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : '';
            if (config.agent.anthropicKey) {
              logger.warn({ err: retryMsg }, 'Ollama niedostępna — przełączam na Anthropic');
              logPrivacyEvent({ action: 'route_cloud', sessionKey: session.key, userId: session.userId, caseId: activeCaseId, reason: 'ollama_fallback', piiMatchCount: piiResult.matches.length, piiTypes: [...new Set(piiResult.matches.map(m => m.type))], privacyMode: (session.metadata?.privacyMode as string) ?? config.privacy.mode, provider: 'anthropic' });
              return await handleWithAnthropic(text, session, config, db, piiDetectedForCloud);
            }
            throw retryErr;
          }
        }

        if (isOllamaDown && config.agent.anthropicKey) {
          logger.warn({ err: msg }, 'Ollama niedostępna — przełączam na Anthropic');
          logPrivacyEvent({ action: 'route_cloud', sessionKey: session.key, userId: session.userId, caseId: activeCaseId, reason: 'ollama_down_fallback', piiMatchCount: piiResult.matches.length, piiTypes: [...new Set(piiResult.matches.map(m => m.type))], privacyMode: (session.metadata?.privacyMode as string) ?? config.privacy.mode, provider: 'anthropic' });
          return await handleWithAnthropic(text, session, config, db, piiDetectedForCloud);
        }
        throw err;
      }
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
  db: Database,
  forceAnonymize = false
): Promise<string | null> {
  // --- Network isolation: strict mode blocks ALL cloud calls ---
  const effectivePrivacyMode = (session.metadata?.privacyMode as string) ?? config.privacy.mode;
  // Also check active case's privacy mode as defense-in-depth
  const activeCaseId = typeof session.metadata?.activeCaseId === 'string' ? session.metadata.activeCaseId : undefined;
  if (activeCaseId) {
    const activeCase = db.getCase(activeCaseId);
    if (activeCase?.privacyMode === 'strict') {
      logPrivacyEvent({ action: 'route_refuse', sessionKey: session.key, userId: session.userId, caseId: activeCaseId, reason: 'case_strict_mode_cloud_blocked', privacyMode: 'strict', provider: 'anthropic' });
      return '⚠️ **Ochrona prywatności**: Sprawa ma tryb ścisły — wszystkie zapytania muszą być przetwarzane lokalnie. Uruchom Ollama (`ollama serve`).';
    }
  }
  if (effectivePrivacyMode === 'strict') {
    logPrivacyEvent({ action: 'route_refuse', sessionKey: session.key, userId: session.userId, reason: 'strict_mode_cloud_blocked', privacyMode: 'strict', provider: 'anthropic' });
    return '⚠️ **Ochrona prywatności**: Tryb ścisły aktywny — wszystkie zapytania muszą być przetwarzane lokalnie. Zewnętrzne serwery AI są zablokowane. Uruchom Ollama (`ollama serve`).';
  }

  const client = new Anthropic({ apiKey: config.agent.anthropicKey });

  // --- Privacy: create per-request anonymizer ---
  // forceAnonymize=true when PII was detected but blockCloudOnPii=false (must protect regardless)
  const shouldAnonymize = forceAnonymize || (effectivePrivacyMode !== 'off' && config.privacy.anonymizeForCloud);
  const anonymizer = shouldAnonymize ? new Anonymizer() : null;

  // --- Build system prompt (strip active case context for cloud if configured) ---
  let systemPrompt: string;
  if (effectivePrivacyMode !== 'off' && config.privacy.stripActiveCaseForCloud) {
    // Use base prompt only — no active case context to prevent client PII leaking
    systemPrompt = SYSTEM_PROMPT;
  } else {
    systemPrompt = buildSystemPrompt(session, db);
  }
  if (anonymizer) systemPrompt = anonymizer.anonymize(systemPrompt);

  // --- Build message history (anonymized) ---
  const messages: Array<{ role: 'user' | 'assistant'; content: any }> = [];
  for (const msg of (session.messages ?? []).slice(-20)) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      const content = anonymizer ? anonymizer.anonymize(msg.content) : msg.content;
      messages.push({ role: msg.role, content });
    }
  }

  if (anonymizer && anonymizer.hasReplacements) {
    logPrivacyEvent({ action: 'route_cloud_anon', sessionKey: session.key, userId: session.userId, reason: 'anonymized_for_cloud', anonymizationCount: anonymizer.mappingCount, privacyMode: effectivePrivacyMode, provider: 'anthropic' });
    logger.info({ mappings: anonymizer.mappingCount }, 'Anonimizacja PII przed wysłaniem do Anthropic');
  }

  const anthropicTools = TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as any,
  }));

  const anthropicModel = config.agent.model.startsWith('claude') ? config.agent.model : 'claude-sonnet-4-5-20250929';
  if (!config.agent.model.startsWith('claude')) {
    logger.warn({ configured: config.agent.model, using: anthropicModel }, 'Model name nie zaczyna się od "claude" — użyto domyślnego');
  }

  let response;
  try {
    response = await client.messages.create({
      model: anthropicModel,
      max_tokens: config.agent.maxTokens,
      temperature: config.agent.temperature,
      system: systemPrompt,
      tools: anthropicTools,
      messages,
    });
  } catch (apiErr) {
    logger.error({ err: apiErr }, 'Anthropic API error');
    const statusCode = (apiErr as any)?.status;
    if (statusCode === 401) return '⚠️ Błąd autoryzacji Anthropic API — sprawdź klucz API w konfiguracji.';
    if (statusCode === 429) return '⚠️ Limit zapytań Anthropic API przekroczony — spróbuj ponownie za chwilę.';
    return 'Przepraszam, wystąpił błąd komunikacji z serwerem AI. Spróbuj ponownie.';
  }

  let turns = 0;
  while (response.stop_reason === 'tool_use' && turns < 10) {
    turns++;
    const assistantContent = response.content;
    messages.push({ role: 'assistant', content: assistantContent });

    const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
    for (const block of assistantContent) {
      if (block.type === 'tool_use' && block.id && block.name) {
        logger.info({ tool: block.name }, 'Executing tool');
        // De-anonymize tool input so DB operations use real values
        let toolInput = block.input as Record<string, unknown>;
        if (anonymizer) {
          const rawJson = JSON.stringify(toolInput);
          const deAnon = anonymizer.deanonymize(rawJson);
          try {
            toolInput = JSON.parse(deAnon);
          } catch (parseErr) {
            logger.warn({ rawJson: rawJson.slice(0, 200), err: parseErr }, 'Deanonymization corrupted JSON — skipping tool execution');
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ error: 'Błąd deanonimizacji danych wejściowych narzędzia.' }) });
            continue;
          }
        }
        let result: string;
        try {
          result = await executeTool(block.name, toolInput, db, session);
        } catch (toolErr) {
          // Log full error server-side, return sanitized message to LLM (no schema/path leak)
          logger.error({ err: toolErr, tool: block.name }, 'Tool execution error');
          result = JSON.stringify({ error: `Wewnętrzny błąd narzędzia ${block.name}. Spróbuj ponownie lub użyj innego podejścia.` });
        }
        // Truncate + re-anonymize tool result before sending back to cloud
        const truncResult = result.length > 16000 ? result.slice(0, 16000) + '\n...[wynik skrócony]' : result;
        const anonResult = anonymizer ? anonymizer.anonymize(truncResult) : truncResult;
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: anonResult });
      }
    }

    // No tool_use blocks found despite stop_reason — break to avoid infinite loop
    if (toolResults.length === 0) break;

    messages.push({ role: 'user', content: toolResults as any });

    // Re-build system prompt (still stripped for cloud)
    const loopSystemPrompt = (effectivePrivacyMode !== 'off' && config.privacy.stripActiveCaseForCloud)
      ? SYSTEM_PROMPT
      : buildSystemPrompt(session, db);
    const anonLoopSystem = anonymizer ? anonymizer.anonymize(loopSystemPrompt) : loopSystemPrompt;

    try {
      response = await client.messages.create({
        model: anthropicModel,
        max_tokens: config.agent.maxTokens,
        temperature: config.agent.temperature,
        system: anonLoopSystem,
        tools: anthropicTools,
        messages,
      });
    } catch (apiErr) {
      logger.error({ err: apiErr, turn: turns }, 'Anthropic API error during tool loop');
      break; // Return whatever we have so far
    }
  }

  const textBlocks = response.content.filter((b: any) => b.type === 'text');
  let rawResponse = textBlocks.map((b: any) => b.text ?? '').filter(Boolean).join('\n') || null;

  // If we hit the tool turn limit without a text response, return a user-friendly message
  if (!rawResponse && turns >= 10) {
    logger.warn({ turns }, 'Anthropic tool turn limit reached without text response');
    rawResponse = 'Przepraszam, osiągnąłem limit operacji przetwarzania. Spróbuj sformułować pytanie prościej lub podziel je na mniejsze kroki.';
  }

  // De-anonymize the response before returning to user
  if (rawResponse && anonymizer) {
    let deAnon = anonymizer.deanonymize(rawResponse);
    // Check for residual placeholders the LLM may have modified
    if (deAnon.includes('<<MECENAS_')) {
      logger.warn('Residual <<MECENAS_>> placeholders detected after deanonymization — stripping');
      deAnon = deAnon.replace(/<<MECENAS_[A-Z]+_\d+>>/g, '[dane osobowe]');
    }
    return deAnon;
  }
  return rawResponse;
}

// =============================================================================
// OLLAMA PROVIDER (Bielik)
// =============================================================================

async function handleWithOllama(
  _text: string,
  session: Session,
  config: Config,
  db: Database,
  modelOverride?: string
): Promise<string | null> {
  const ollamaUrl = config.agent.ollamaUrl;
  const model = modelOverride ?? config.agent.model;

  const conversationHistory = (session.messages ?? []).slice(-20).map(msg => ({
    role: msg.role,
    content: msg.content,
  }));

  const toolDescriptions = TOOLS.map(t =>
    `- ${t.name}: ${t.description}`
  ).join('\n');

  const systemWithTools = `${buildSystemPrompt(session, db)}

Aby użyć narzędzia, odpowiedz TYLKO formatem JSON (bez żadnego innego tekstu):
{"tool": "nazwa_narzedzia", "input": {"param1": "wartosc1"}}

Dostępne narzędzia:
${toolDescriptions}

Jeśli nie musisz używać narzędzia, odpowiedz normalnym tekstem.`;

  let response = await callOllama(ollamaUrl, model, systemWithTools, conversationHistory, config.agent.temperature, config.agent.maxTokens);

  let turns = 0;
  while (turns < 10) {
    const toolCall = parseToolCall(response);
    if (!toolCall) break;

    turns++;
    logger.info({ tool: toolCall.tool, model }, 'Ollama tool call');
    let result: string;
    try {
      result = await executeTool(toolCall.tool, toolCall.input, db, session);
    } catch (err) {
      logger.error({ err, tool: toolCall.tool }, 'Ollama tool execution error');
      result = JSON.stringify({ error: `Wewnętrzny błąd narzędzia ${toolCall.tool}. Spróbuj ponownie lub użyj innego podejścia.` });
    }
    // Truncate large results to prevent Ollama context overflow
    if (result.length > 16000) {
      result = result.slice(0, 16000) + '\n...[wynik skrócony]';
    }

    conversationHistory.push({ role: 'assistant', content: response });
    conversationHistory.push({ role: 'user', content: `Wynik narzędzia ${toolCall.tool}:\n${result}\n\nTeraz odpowiedz użytkownikowi na podstawie wyniku narzędzia.` });

    response = await callOllama(ollamaUrl, model, systemWithTools, conversationHistory, config.agent.temperature, config.agent.maxTokens);
  }

  // If response is still a tool call JSON after hitting the limit, return a user-friendly message
  if (turns >= 10 && parseToolCall(response)) {
    logger.warn({ turns }, 'Ollama tool turn limit reached — response is still a tool call');
    return 'Przepraszam, osiągnąłem limit operacji przetwarzania. Spróbuj sformułować pytanie prościej lub podziel je na mniejsze kroki.';
  }

  return response || null;
}

const KNOWN_TOOL_NAMES = new Set(TOOLS.map(t => t.name));

function parseToolCall(text: string): { tool: string; input: Record<string, unknown> } | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.tool && typeof parsed.tool === 'string' && KNOWN_TOOL_NAMES.has(parsed.tool)) {
        return { tool: parsed.tool, input: parsed.input ?? {} };
      }
    } catch {}
  }
  // Match each code block individually (non-greedy between ``` pairs)
  const codeBlocks = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)];
  for (const block of codeBlocks) {
    try {
      const parsed = JSON.parse(block[1]);
      if (parsed.tool && typeof parsed.tool === 'string' && KNOWN_TOOL_NAMES.has(parsed.tool)) {
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
  messages: Array<{ role: string; content: string }>,
  temperature = 0.3,
  maxTokens = 4096
): Promise<string> {
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      ...messages,
    ],
    stream: false,
    options: { temperature, num_predict: maxTokens },
  };

  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000); // 2 min timeout
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timeout);
    if (err?.name === 'AbortError') {
      throw new Error('Ollama nie odpowiedział w ciągu 2 minut. Model może być zbyt duży lub serwer jest przeciążony.');
    }
    if (err?.code === 'ECONNREFUSED' || err?.cause?.code === 'ECONNREFUSED') {
      throw new Error(`Ollama nie jest uruchomiony na ${baseUrl}. Uruchom: ollama serve`);
    }
    throw new Error(`Nie można połączyć się z Ollama (${baseUrl}): ${err?.message ?? 'nieznany błąd'}`);
  }
  clearTimeout(timeout);

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    if (response.status === 404 && errorText.includes('not found')) {
      throw new Error(`Model "${model}" nie znaleziony. Pobierz go: ollama pull ${model}`);
    }
    throw new Error(`Ollama zwróciło błąd (${response.status}): ${errorText.slice(0, 200)}`);
  }

  const data = await response.json() as { message?: { content?: string } };
  return data.message?.content ?? '';
}

// =============================================================================
// DEADLINE REMINDERS
// =============================================================================

const DAY_MS = 86_400_000;
const REMINDER_CHECK_MS = 300_000; // 5 minutes

export interface DeadlineReminder {
  deadlineId: string;
  caseTitle: string;
  deadlineTitle: string;
  date: Date;
  daysLeft: number;
  overdue: boolean;
  type: string;
}

/**
 * Start periodic deadline reminder checks.
 * Returns a cleanup function to stop the interval.
 */
export function startDeadlineReminders(
  db: Database,
  onReminder: (reminders: DeadlineReminder[]) => void
): () => void {
  const sentReminders = new Set<string>();

  function check(): void {
    // Cap sentinel growth — evict oldest half (Sets maintain insertion order)
    if (sentReminders.size > 5000) {
      const toKeep = Math.floor(sentReminders.size / 2);
      let skip = sentReminders.size - toKeep;
      for (const key of sentReminders) {
        if (skip-- <= 0) break;
        sentReminders.delete(key);
      }
    }

    try {
      const allDeadlines = db.listDeadlines({ completed: false });
      const nowMs = Date.now();
      const pending: DeadlineReminder[] = [];

      for (const deadline of allDeadlines) {
        const dateMs = deadline.date.getTime();
        const reminderMs = dateMs - (deadline.reminderDaysBefore * DAY_MS);
        const daysLeft = Math.ceil((dateMs - nowMs) / DAY_MS);

        // Overdue
        if (dateMs < nowMs) {
          const key = `${deadline.id}:overdue`;
          if (sentReminders.has(key)) continue;
          sentReminders.add(key);
          const legalCase = db.getCase(deadline.caseId);
          pending.push({
            deadlineId: deadline.id,
            caseTitle: legalCase?.title ?? deadline.caseId,
            deadlineTitle: deadline.title,
            date: deadline.date,
            daysLeft,
            overdue: true,
            type: deadline.type,
          });
          continue;
        }

        // In reminder window
        if (reminderMs <= nowMs && dateMs > nowMs) {
          const key = `${deadline.id}:reminder`;
          if (sentReminders.has(key)) continue;
          sentReminders.add(key);
          const legalCase = db.getCase(deadline.caseId);
          pending.push({
            deadlineId: deadline.id,
            caseTitle: legalCase?.title ?? deadline.caseId,
            deadlineTitle: deadline.title,
            date: deadline.date,
            daysLeft,
            overdue: false,
            type: deadline.type,
          });
        }
      }

      if (pending.length > 0) {
        onReminder(pending);
      }
    } catch (err) {
      logger.warn({ err }, 'Deadline reminder check failed');
    }
  }

  // Run immediately on start, then every 5 minutes
  check();
  const interval = setInterval(check, REMINDER_CHECK_MS);

  return () => clearInterval(interval);
}
