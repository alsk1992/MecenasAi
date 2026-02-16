/**
 * Privacy PII Detector for Polish Legal Data
 * Detects PESEL, NIP, REGON, phone numbers, emails, postal codes,
 * case signatures, Polish names after legal keywords, and sensitive terms.
 */

// =============================================================================
// TYPES
// =============================================================================

export type PiiType =
  | 'pesel'
  | 'nip'
  | 'regon'
  | 'phone'
  | 'email'
  | 'postal_code'
  | 'case_signature'
  | 'person_name'
  | 'address';

export interface PiiMatch {
  type: PiiType;
  value: string;
  index: number;
}

export interface DetectionResult {
  hasPii: boolean;
  hasSensitiveKeywords: boolean;
  matches: PiiMatch[];
  keywords: string[];
}

// =============================================================================
// PESEL CHECKSUM VALIDATION
// =============================================================================

const PESEL_WEIGHTS = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];

function isValidPesel(digits: string): boolean {
  if (digits.length !== 11 || !/^\d{11}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(digits[i], 10) * PESEL_WEIGHTS[i];
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === parseInt(digits[10], 10);
}

// =============================================================================
// REGEX PATTERNS
// =============================================================================

// PESEL: 11 digits, word-boundary delimited
const PESEL_RE = /\b(\d{11})\b/g;

// NIP: 10 digits, optional dashes/spaces (e.g. 526-104-08-28 or 5261040828)
const NIP_RE = /\b(\d{3}[-\s]?\d{3}[-\s]?\d{2}[-\s]?\d{2})\b/g;

// REGON: 9 or 14 digits
const REGON_RE = /\b(\d{9}|\d{14})\b/g;

// Phone: +48, 48 prefix, or bare 9-digit starting with typical Polish prefixes
const PHONE_RE = /(?:\+48[\s-]?|48[\s-]?)(\d{3}[\s-]?\d{3}[\s-]?\d{3})\b|\b((?:5[0-9]|6[0-9]|7[0-9]|8[0-9])\d[\s-]?\d{3}[\s-]?\d{3})\b/g;

// Email
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Polish postal code: XX-XXX
const POSTAL_CODE_RE = /\b(\d{2}-\d{3})\b/g;

// Court case signature: e.g. "I C 123/26", "II K 45/25", "III Ca 789/24"
const CASE_SIGNATURE_RE = /\b(X{0,3}(?:IX|IV|V?I{0,3})\s+[A-Z][a-z]{0,4}\s+\d{1,6}\/\d{2,4})\b/g;

// Polish names after legal keywords (Klient:, Powód:, Pozwany:, Pełnomocnik:, etc.)
const NAME_AFTER_KEYWORD_RE = /(?:Klient|Powód|Pozwany|Pełnomocnik|Wnioskodawca|Uczestnik|Dłużnik|Wierzyciel|Spadkodawca|Spadkobierca|Obwiniony|Oskarżony|Pokrzywdzony)\s*:\s*([A-ZŁŚŹŻĆŃ][a-złóśćźżęąń]+(?:\s+[A-ZŁŚŹŻĆŃ][a-złóśćźżęąń]+){1,3})/g;

// =============================================================================
// SENSITIVE KEYWORDS (Polish legal terms indicating PII context)
// =============================================================================

const SENSITIVE_KEYWORDS = [
  'klient',
  'pesel',
  'nip',
  'regon',
  'dane osobowe',
  'pozwany',
  'powód',
  'adres zamieszkania',
  'adres korespondencyjny',
  'numer dowodu',
  'dowód osobisty',
  'numer paszportu',
  'data urodzenia',
  'miejsce urodzenia',
  'imię i nazwisko',
  'stan cywilny',
  'numer konta',
  'rachunek bankowy',
  'akt notarialny',
  'tajemnica adwokacka',
  'tajemnica radcowska',
  'poufne',
  'dane wrażliwe',
  'krs',
] as const;

// =============================================================================
// MAIN DETECTION FUNCTION
// =============================================================================

/**
 * Scan text for Polish legal PII and sensitive keywords.
 * Returns all matches and whether the text is considered sensitive.
 */
export function detectPii(text: string): DetectionResult {
  const matches: PiiMatch[] = [];
  const keywords: string[] = [];

  // --- PESEL (with checksum validation) ---
  for (const m of text.matchAll(PESEL_RE)) {
    if (isValidPesel(m[1])) {
      matches.push({ type: 'pesel', value: m[1], index: m.index! });
    }
  }

  // --- NIP ---
  for (const m of text.matchAll(NIP_RE)) {
    const clean = m[1].replace(/[-\s]/g, '');
    if (clean.length === 10) {
      matches.push({ type: 'nip', value: m[0], index: m.index! });
    }
  }

  // --- REGON (only if not already matched as PESEL) ---
  const peselPositions = new Set(matches.filter(p => p.type === 'pesel').map(p => p.index));
  for (const m of text.matchAll(REGON_RE)) {
    if (!peselPositions.has(m.index!)) {
      matches.push({ type: 'regon', value: m[1], index: m.index! });
    }
  }

  // --- Phone ---
  for (const m of text.matchAll(PHONE_RE)) {
    matches.push({ type: 'phone', value: m[0], index: m.index! });
  }

  // --- Email ---
  for (const m of text.matchAll(EMAIL_RE)) {
    matches.push({ type: 'email', value: m[0], index: m.index! });
  }

  // --- Postal code ---
  for (const m of text.matchAll(POSTAL_CODE_RE)) {
    matches.push({ type: 'postal_code', value: m[1], index: m.index! });
  }

  // --- Case signature ---
  for (const m of text.matchAll(CASE_SIGNATURE_RE)) {
    matches.push({ type: 'case_signature', value: m[1], index: m.index! });
  }

  // --- Person names after legal keywords ---
  for (const m of text.matchAll(NAME_AFTER_KEYWORD_RE)) {
    matches.push({ type: 'person_name', value: m[1].trim(), index: m.index! + m[0].indexOf(m[1]) });
  }

  // --- Sensitive keywords ---
  const lower = text.toLowerCase();
  for (const kw of SENSITIVE_KEYWORDS) {
    if (lower.includes(kw)) {
      keywords.push(kw);
    }
  }

  return {
    hasPii: matches.length > 0,
    hasSensitiveKeywords: keywords.length > 0,
    matches,
    keywords,
  };
}

/**
 * Quick check: does text contain any PII or sensitive keywords?
 * Faster than full detectPii() when you only need a boolean.
 */
export function containsSensitiveData(text: string): boolean {
  const result = detectPii(text);
  return result.hasPii || result.hasSensitiveKeywords;
}
