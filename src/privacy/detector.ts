/**
 * Privacy PII Detector for Polish Legal Data
 * Detects PESEL, NIP, REGON, phone numbers, emails, postal codes,
 * case signatures, Polish names (dictionary + keyword), IBAN, ID cards,
 * passports, addresses, company names, and sensitive terms.
 */

import { findPolishNames, containsPolishName } from './names.js';

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
  | 'address'
  | 'iban'
  | 'id_card'
  | 'passport'
  | 'company_name';

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
  // Checksum validation
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(digits[i], 10) * PESEL_WEIGHTS[i];
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  if (checkDigit !== parseInt(digits[10], 10)) return false;
  // Date-of-birth validation: YYMMDD where month encodes century
  const yy = parseInt(digits.slice(0, 2), 10);
  const mm = parseInt(digits.slice(2, 4), 10);
  const dd = parseInt(digits.slice(4, 6), 10);
  // Month ranges: 01-12 (1900s), 21-32 (2000s), 41-52 (2100s), 61-72 (2200s), 81-92 (1800s)
  const monthOffset = mm > 80 ? 80 : mm > 60 ? 60 : mm > 40 ? 40 : mm > 20 ? 20 : 0;
  const realMonth = mm - monthOffset;
  if (realMonth < 1 || realMonth > 12) return false;
  if (dd < 1 || dd > 31) return false;
  // Simple day-in-month check (conservative — allow 29 for Feb)
  const maxDays = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (dd > maxDays[realMonth]) return false;
  return true;
}

// NIP checksum weights
const NIP_WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7];

function isValidNip(digits: string): boolean {
  const clean = digits.replace(/[-\s]/g, '');
  if (clean.length !== 10 || !/^\d{10}$/.test(clean)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(clean[i], 10) * NIP_WEIGHTS[i];
  }
  const checkDigit = sum % 11;
  // If checkDigit is 10, NIP is invalid
  if (checkDigit === 10) return false;
  return checkDigit === parseInt(clean[9], 10);
}

// REGON checksum weights (9-digit)
const REGON9_WEIGHTS = [8, 9, 2, 3, 4, 5, 6, 7];
// REGON checksum weights (14-digit, for the extra 5 digits)
const REGON14_WEIGHTS = [2, 4, 8, 5, 0, 9, 7, 3, 6, 1, 2, 4, 8];

function isValidRegon(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  if (digits.length === 9) {
    let sum = 0;
    for (let i = 0; i < 8; i++) {
      sum += parseInt(digits[i], 10) * REGON9_WEIGHTS[i];
    }
    const checkDigit = sum % 11 === 10 ? 0 : sum % 11;
    return checkDigit === parseInt(digits[8], 10);
  }
  if (digits.length === 14) {
    // First validate the 9-digit base
    if (!isValidRegon(digits.slice(0, 9))) return false;
    let sum = 0;
    for (let i = 0; i < 13; i++) {
      sum += parseInt(digits[i], 10) * REGON14_WEIGHTS[i];
    }
    const checkDigit = sum % 11 === 10 ? 0 : sum % 11;
    return checkDigit === parseInt(digits[13], 10);
  }
  return false;
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
// Case-insensitive to catch "klient:", "KLIENT:", etc.
const NAME_AFTER_KEYWORD_RE = /(?:Klient|Powód|Pozwany|Pełnomocnik|Wnioskodawca|Uczestnik|Dłużnik|Wierzyciel|Spadkodawca|Spadkobierca|Obwiniony|Oskarżony|Pokrzywdzony)\s*:\s*([A-ZŁŚŹŻĆŃ][a-złóśćźżęąń]+(?:\s+[A-ZŁŚŹŻĆŃ][a-złóśćźżęąń]+){1,3})/gi;

// Polish IBAN: PL followed by 26 digits (with optional spaces/dashes)
const IBAN_RE = /\bPL\s?(\d{2}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/g;

// Polish ID card (dowód osobisty): 3 letters + 6 digits
const ID_CARD_RE = /\b([A-Z]{3}\d{6})\b/g;

// Polish passport: 2 letters + 7 digits
const PASSPORT_RE = /\b([A-Z]{2}\d{7})\b/g;

// Street addresses: ul./al./pl. followed by text
const ADDRESS_RE = /(?:ul\.|al\.|pl\.|os\.|ulica|aleja)\s+[A-ZŁŚŹŻĆŃ][a-złóśćźżęąń]+(?:\s+[A-ZŁŚŹŻĆŃ]?[a-złóśćźżęąń]+)*\s+\d+[a-zA-Z]?(?:\/\d+[a-zA-Z]?)?/gi;

// Company names with Polish legal suffixes
const COMPANY_NAME_RE = /(?<=\s|^)[A-ZŁŚŹŻĆŃĘĄÓ][a-złóśćźżęąń]+(?:\s+[A-ZŁŚŹŻĆŃĘĄÓa-złóśćźżęąń]+)*\s+(?:sp\.\s*z\s*o\.?\s*o\.?|S\.?A\.?|sp\.\s*j\.?|sp\.\s*k\.?|sp\.\s*p\.?|s\.?\s*c\.?)(?=\s|$|[.,;:!?)\]])/g;

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

  // --- NIP (with checksum validation) ---
  for (const m of text.matchAll(NIP_RE)) {
    if (isValidNip(m[1])) {
      matches.push({ type: 'nip', value: m[0], index: m.index! });
    }
  }

  // --- REGON (with checksum validation, skip positions already matched as PESEL) ---
  const peselPositions = new Set(matches.filter(p => p.type === 'pesel').map(p => p.index));
  for (const m of text.matchAll(REGON_RE)) {
    if (!peselPositions.has(m.index!) && isValidRegon(m[1])) {
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

  // --- IBAN ---
  for (const m of text.matchAll(IBAN_RE)) {
    matches.push({ type: 'iban', value: m[0], index: m.index! });
  }

  // --- Polish ID card (dowód osobisty) ---
  for (const m of text.matchAll(ID_CARD_RE)) {
    matches.push({ type: 'id_card', value: m[1], index: m.index! });
  }

  // --- Passport ---
  for (const m of text.matchAll(PASSPORT_RE)) {
    matches.push({ type: 'passport', value: m[1], index: m.index! });
  }

  // --- Street addresses ---
  for (const m of text.matchAll(ADDRESS_RE)) {
    matches.push({ type: 'address', value: m[0], index: m.index! });
  }

  // --- Company names with legal suffixes ---
  for (const m of text.matchAll(COMPANY_NAME_RE)) {
    matches.push({ type: 'company_name', value: m[0], index: m.index! });
  }

  // --- Freestanding Polish names (dictionary-based) ---
  const existingNamePositions = new Set(matches.filter(m => m.type === 'person_name').map(m => m.index));
  for (const nm of findPolishNames(text)) {
    // Skip if already caught by keyword-based detection
    if (!existingNamePositions.has(nm.index)) {
      matches.push({ type: 'person_name', value: nm.name, index: nm.index });
    }
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
 * Uses early-exit checks before full regex scan for performance.
 */
export function containsSensitiveData(text: string): boolean {
  if (!text) return false;

  // Fast path: check sensitive keywords first (cheap string search)
  const lower = text.toLowerCase();
  for (const kw of SENSITIVE_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }

  // Quick regex checks (most common patterns, test-only for early exit)
  if (PESEL_RE.test(text)) { PESEL_RE.lastIndex = 0; return true; }
  PESEL_RE.lastIndex = 0;
  if (NIP_RE.test(text)) { NIP_RE.lastIndex = 0; return true; }
  NIP_RE.lastIndex = 0;
  if (PHONE_RE.test(text)) { PHONE_RE.lastIndex = 0; return true; }
  PHONE_RE.lastIndex = 0;
  if (EMAIL_RE.test(text)) { EMAIL_RE.lastIndex = 0; return true; }
  EMAIL_RE.lastIndex = 0;
  if (IBAN_RE.test(text)) { IBAN_RE.lastIndex = 0; return true; }
  IBAN_RE.lastIndex = 0;
  if (NAME_AFTER_KEYWORD_RE.test(text)) { NAME_AFTER_KEYWORD_RE.lastIndex = 0; return true; }
  NAME_AFTER_KEYWORD_RE.lastIndex = 0;
  if (ID_CARD_RE.test(text)) { ID_CARD_RE.lastIndex = 0; return true; }
  ID_CARD_RE.lastIndex = 0;
  if (PASSPORT_RE.test(text)) { PASSPORT_RE.lastIndex = 0; return true; }
  PASSPORT_RE.lastIndex = 0;
  if (REGON_RE.test(text)) { REGON_RE.lastIndex = 0; return true; }
  REGON_RE.lastIndex = 0;
  if (POSTAL_CODE_RE.test(text)) { POSTAL_CODE_RE.lastIndex = 0; return true; }
  POSTAL_CODE_RE.lastIndex = 0;
  if (CASE_SIGNATURE_RE.test(text)) { CASE_SIGNATURE_RE.lastIndex = 0; return true; }
  CASE_SIGNATURE_RE.lastIndex = 0;
  if (ADDRESS_RE.test(text)) { ADDRESS_RE.lastIndex = 0; return true; }
  ADDRESS_RE.lastIndex = 0;
  if (COMPANY_NAME_RE.test(text)) { COMPANY_NAME_RE.lastIndex = 0; return true; }
  COMPANY_NAME_RE.lastIndex = 0;

  // Dictionary-based Polish name check
  if (containsPolishName(text)) return true;

  return false;
}
