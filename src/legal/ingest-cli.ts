#!/usr/bin/env tsx
/**
 * Mecenas Legal Knowledge Ingestion CLI
 *
 * Fetches Polish legal codes from the Sejm ELI API (api.sejm.gov.pl/eli)
 * and indexes them into the local SQLite database for RAG retrieval.
 *
 * Usage: npm run ingest
 *
 * API docs: https://api.sejm.gov.pl/eli/openapi/ui/
 */

import { initDatabase } from '../db/index.js';

// =============================================================================
// Sejm ELI API
// =============================================================================

const API_BASE = 'https://api.sejm.gov.pl/eli';

interface CodeDef {
  codeName: string;
  fullName: string;
  /** ELI path: publisher/year/position */
  eli: string;
}

/**
 * Use the latest consolidated text (tekst jednolity) that has HTML available.
 * These are the most current versions of each code as of 2024.
 */
const CODES: CodeDef[] = [
  { codeName: 'KC',  fullName: 'Kodeks cywilny',                          eli: 'DU/2024/1061' },
  { codeName: 'KPC', fullName: 'Kodeks postępowania cywilnego',           eli: 'DU/2024/1568' },
  { codeName: 'KK',  fullName: 'Kodeks karny',                            eli: 'DU/2024/706' },
  { codeName: 'KP',  fullName: 'Kodeks pracy',                            eli: 'DU/2023/1465' },
  { codeName: 'KRO', fullName: 'Kodeks rodzinny i opiekuńczy',            eli: 'DU/2023/2809' },
  { codeName: 'KSH', fullName: 'Kodeks spółek handlowych',                eli: 'DU/2024/18' },
  { codeName: 'KPA', fullName: 'Kodeks postępowania administracyjnego',    eli: 'DU/2024/572' },
];

interface ParsedArticle {
  articleNumber: string;
  title: string;
  content: string;
  chapter?: string;
  section?: string;
}

// =============================================================================
// Fetch HTML and parse articles
// =============================================================================

async function fetchHtml(eli: string): Promise<string> {
  const url = `${API_BASE}/acts/${eli}/text.html`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * Strip HTML tags, collapse whitespace, decode basic entities.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|tr|td|th|dt|dd|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parse the Sejm HTML into individual articles.
 *
 * The HTML from api.sejm.gov.pl uses structured divs with IDs like:
 *   id="book_pierwsza-part_ogolna-titl_I-arti_1"
 * and article headings like "Art. 1." followed by content.
 */
function parseArticlesFromHtml(html: string, codeName: string): ParsedArticle[] {
  const articles: ParsedArticle[] = [];

  // Strategy: split on "Art. N." pattern in the stripped text.
  // The HTML is well-structured so this works reliably.
  const text = stripHtml(html);
  const lines = text.split('\n');

  let currentSection = '';
  let currentChapter = '';
  let currentArtNum = '';
  let currentLines: string[] = [];

  function flush() {
    if (currentArtNum && currentLines.length > 0) {
      const content = currentLines.join('\n').trim();
      if (content) {
        articles.push({
          articleNumber: currentArtNum,
          title: `Art. ${currentArtNum} ${codeName}`,
          content,
          section: currentSection || undefined,
          chapter: currentChapter || undefined,
        });
      }
    }
    currentLines = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Structural headings
    if (/^(KSIĘGA|Księga|CZĘŚĆ|Część|TYTUŁ|Tytuł|DZIAŁ|Dział)\s/i.test(line)) {
      currentSection = line;
      continue;
    }
    if (/^(Rozdział|ROZDZIAŁ)\s/i.test(line)) {
      currentChapter = line;
      continue;
    }

    // Article start: "Art. 1.", "Art. 415.", "Art. 505(1).", "Art. 24a."
    const artMatch = line.match(/^Art\.\s*(\d+[a-z]?(?:\(\d+\))?)\.\s*(.*)/);
    if (artMatch) {
      flush();
      currentArtNum = artMatch[1];
      if (artMatch[2].trim()) {
        currentLines.push(artMatch[2].trim());
      }
      continue;
    }

    // Content lines
    if (currentArtNum) {
      currentLines.push(line);
    }
  }
  flush();

  return articles;
}

// =============================================================================
// Fallback: embedded sample articles (used when API is unreachable)
// =============================================================================

function sampleArticles(codeName: string): ParsedArticle[] {
  const samples: Record<string, ParsedArticle[]> = {
    KC: [
      { articleNumber: '1', title: 'Art. 1 KC', content: 'Kodeks niniejszy reguluje stosunki cywilnoprawne między osobami fizycznymi i osobami prawnymi.' },
      { articleNumber: '5', title: 'Art. 5 KC', content: 'Nie można czynić ze swego prawa użytku, który by był sprzeczny ze społeczno-gospodarczym przeznaczeniem tego prawa lub z zasadami współżycia społecznego. Takie działanie lub zaniechanie uprawnionego nie jest uważane za wykonywanie prawa i nie korzysta z ochrony.' },
      { articleNumber: '6', title: 'Art. 6 KC', content: 'Ciężar udowodnienia faktu spoczywa na osobie, która z faktu tego wywodzi skutki prawne.' },
      { articleNumber: '415', title: 'Art. 415 KC', content: 'Kto z winy swej wyrządził drugiemu szkodę, obowiązany jest do jej naprawienia.' },
      { articleNumber: '471', title: 'Art. 471 KC', content: 'Dłużnik obowiązany jest do naprawienia szkody wynikłej z niewykonania lub nienależytego wykonania zobowiązania, chyba że niewykonanie lub nienależyte wykonanie jest następstwem okoliczności, za które dłużnik odpowiedzialności nie ponosi.' },
      { articleNumber: '535', title: 'Art. 535 KC', content: '§ 1. Przez umowę sprzedaży sprzedawca zobowiązuje się przenieść na kupującego własność rzeczy i wydać mu rzecz, a kupujący zobowiązuje się rzecz odebrać i zapłacić sprzedawcy cenę.' },
    ],
    KPC: [
      { articleNumber: '187', title: 'Art. 187 KPC', content: '§ 1. Pozew powinien czynić zadość warunkom pisma procesowego, a nadto zawierać:\n1) dokładnie określone żądanie, a w sprawach o prawa majątkowe także oznaczenie wartości przedmiotu sporu, chyba że przedmiotem sprawy jest oznaczona kwota pieniężna;\n2) wskazanie faktów, na których powód opiera swoje żądanie, a w miarę potrzeby uzasadniających również właściwość sądu;\n3) informację, czy strony podjęły próbę mediacji lub innego pozasądowego sposobu rozwiązania sporu.' },
      { articleNumber: '367', title: 'Art. 367 KPC', content: '§ 1. Od wyroku sądu pierwszej instancji przysługuje apelacja do sądu drugiej instancji.\n§ 2. Apelację od wyroku sądu rejonowego rozpoznaje sąd okręgowy, a od wyroku sądu okręgowego jako pierwszej instancji – sąd apelacyjny.' },
    ],
    KK: [
      { articleNumber: '1', title: 'Art. 1 KK', content: '§ 1. Odpowiedzialności karnej podlega ten tylko, kto popełnia czyn zabroniony pod groźbą kary przez ustawę obowiązującą w czasie jego popełnienia.\n§ 2. Nie stanowi przestępstwa czyn zabroniony, którego społeczna szkodliwość jest znikoma.\n§ 3. Nie popełnia przestępstwa sprawca czynu zabronionego, jeżeli nie można mu przypisać winy w czasie czynu.' },
      { articleNumber: '148', title: 'Art. 148 KK', content: '§ 1. Kto zabija człowieka, podlega karze pozbawienia wolności na czas nie krótszy od lat 8, karze 25 lat pozbawienia wolności albo karze dożywotniego pozbawienia wolności.' },
      { articleNumber: '286', title: 'Art. 286 KK', content: '§ 1. Kto, w celu osiągnięcia korzyści majątkowej, doprowadza inną osobę do niekorzystnego rozporządzenia własnym lub cudzym mieniem za pomocą wprowadzenia jej w błąd albo wyzyskania błędu lub niezdolności do należytego pojmowania przedsiębranego działania, podlega karze pozbawienia wolności od 6 miesięcy do lat 8.' },
    ],
    KP: [
      { articleNumber: '22', title: 'Art. 22 KP', content: '§ 1. Przez nawiązanie stosunku pracy pracownik zobowiązuje się do wykonywania pracy określonego rodzaju na rzecz pracodawcy i pod jego kierownictwem oraz w miejscu i czasie wyznaczonym przez pracodawcę, a pracodawca – do zatrudniania pracownika za wynagrodzeniem.' },
      { articleNumber: '52', title: 'Art. 52 KP', content: '§ 1. Pracodawca może rozwiązać umowę o pracę bez wypowiedzenia z winy pracownika w razie:\n1) ciężkiego naruszenia przez pracownika podstawowych obowiązków pracowniczych;\n2) popełnienia przez pracownika w czasie trwania umowy o pracę przestępstwa, które uniemożliwia dalsze zatrudnianie go na zajmowanym stanowisku, jeżeli przestępstwo jest oczywiste lub zostało stwierdzone prawomocnym wyrokiem;\n3) zawinionej przez pracownika utraty uprawnień koniecznych do wykonywania pracy na zajmowanym stanowisku.' },
    ],
    KRO: [
      { articleNumber: '56', title: 'Art. 56 KRO', content: '§ 1. Jeżeli między małżonkami nastąpił zupełny i trwały rozkład pożycia, każdy z małżonków może żądać, ażeby sąd rozwiązał małżeństwo przez rozwód.' },
      { articleNumber: '133', title: 'Art. 133 KRO', content: '§ 1. Rodzice obowiązani są do świadczeń alimentacyjnych względem dziecka, które nie jest jeszcze w stanie utrzymać się samodzielnie, chyba że dochody z majątku dziecka wystarczają na pokrycie kosztów jego utrzymania i wychowania.' },
    ],
    KSH: [
      { articleNumber: '151', title: 'Art. 151 KSH', content: '§ 1. Spółka z ograniczoną odpowiedzialnością może być utworzona przez jedną albo więcej osób w każdym celu prawnie dopuszczalnym, chyba że ustawa stanowi inaczej.' },
      { articleNumber: '299', title: 'Art. 299 KSH', content: '§ 1. Jeżeli egzekucja przeciwko spółce okaże się bezskuteczna, członkowie zarządu odpowiadają solidarnie za jej zobowiązania.' },
    ],
    KPA: [
      { articleNumber: '6', title: 'Art. 6 KPA', content: 'Organy administracji publicznej działają na podstawie przepisów prawa.' },
      { articleNumber: '104', title: 'Art. 104 KPA', content: '§ 1. Organ administracji publicznej załatwia sprawę przez wydanie decyzji, chyba że przepisy kodeksu stanowią inaczej.\n§ 2. Decyzje rozstrzygają sprawę co do jej istoty w całości lub w części albo w inny sposób kończą sprawę w danej instancji.' },
    ],
  };
  return samples[codeName] ?? [];
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  console.log('\n⚖️  Mecenas — Ładowanie bazy wiedzy prawnej');
  console.log('  Źródło: api.sejm.gov.pl/eli (Sejm ELI API)\n');

  const db = await initDatabase();
  let totalArticles = 0;

  for (const code of CODES) {
    console.log(`📚 ${code.codeName} — ${code.fullName}`);

    let articles: ParsedArticle[];

    try {
      console.log(`  Pobieranie ${API_BASE}/acts/${code.eli}/text.html ...`);
      const html = await fetchHtml(code.eli);
      articles = parseArticlesFromHtml(html, code.codeName);
      console.log(`  Sparsowano ${articles.length} artykułów z HTML`);

      if (articles.length === 0) {
        throw new Error('Parser zwrócił 0 artykułów');
      }
    } catch (err) {
      console.log(`  ⚠️  Błąd: ${(err as Error).message}`);
      console.log(`  Ładowanie artykułów wbudowanych (fallback)...`);
      articles = sampleArticles(code.codeName);
      console.log(`  ${articles.length} artykułów wbudowanych`);
    }

    if (articles.length === 0) {
      console.log(`  ⚠️  Brak artykułów\n`);
      continue;
    }

    let inserted = 0;
    for (const article of articles) {
      try {
        db.upsertArticle({
          codeName: code.codeName,
          articleNumber: article.articleNumber,
          title: article.title,
          content: article.content,
          chapter: article.chapter,
          section: article.section,
        });
        inserted++;
      } catch (err) {
        console.log(`  ✗ art. ${article.articleNumber}: ${(err as Error).message}`);
      }
    }

    console.log(`  ✓ Załadowano ${inserted} artykułów\n`);
    totalArticles += inserted;
  }

  console.log(`✅ Łącznie: ${totalArticles} artykułów\n`);

  const allCodes = ['KC', 'KPC', 'KK', 'KP', 'KRO', 'KSH', 'KPA'];
  console.log('📊 Baza wiedzy:');
  for (const c of allCodes) {
    console.log(`  ${c}: ${db.countArticles(c)}`);
  }
  console.log(`  Łącznie: ${db.countArticles()}`);

  db.close();
  console.log('\n✓ Gotowe!\n');
}

main().catch((err) => {
  console.error('Błąd krytyczny:', err);
  process.exit(1);
});
