/**
 * Logger utility using Pino — with PII scrubbing
 *
 * All log output is passed through a redactor that strips
 * Polish PII patterns (PESEL, NIP, IBAN, phone, email)
 * to prevent accidental PII leakage to log files/stdout.
 */

// @ts-ignore - pino CJS/ESM interop
import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';

// PII patterns to redact from log output (conservative — avoids false positives)
const PII_REDACT_PATTERNS: Array<[RegExp, string]> = [
  // PESEL: 11 consecutive digits at word boundary
  [/\b\d{11}\b/g, '[PESEL_REDACTED]'],
  // NIP: 10 digits with optional dashes (XXX-XXX-XX-XX or XXXXXXXXXX)
  [/\b\d{3}[-\s]?\d{3}[-\s]?\d{2}[-\s]?\d{2}\b/g, '[NIP_REDACTED]'],
  // IBAN: PL followed by 26 digits
  [/\bPL\s?\d{2}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[IBAN_REDACTED]'],
  // Polish phone: +48 or 48 prefix + 9 digits
  [/(?:\+48[\s-]?|48[\s-]?)\d{3}[\s-]?\d{3}[\s-]?\d{3}\b/g, '[TEL_REDACTED]'],
  // Email (basic)
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL_REDACTED]'],
  // Polish ID card: 3 letters + 6 digits
  [/\b[A-Z]{3}\d{6}\b/g, '[DOWOD_REDACTED]'],
  // Polish passport: 2 letters + 7 digits
  [/\b[A-Z]{2}\d{7}\b/g, '[PASZPORT_REDACTED]'],
];

/** Scrub PII patterns from a string */
function scrubPii(str: string): string {
  let result = str;
  for (const [pattern, replacement] of PII_REDACT_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** Recursively scrub PII from an object's string values (shallow — max 3 levels) */
function scrubObject(obj: unknown, depth = 0): unknown {
  if (depth > 3) return obj;
  if (typeof obj === 'string') return scrubPii(obj);
  if (Array.isArray(obj)) return obj.map(v => scrubObject(v, depth + 1));
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = scrubObject(value, depth + 1);
    }
    return result;
  }
  return obj;
}

const rootLogger = (pino as any)({
  level,
  hooks: {
    logMethod(inputArgs: unknown[], method: (...args: unknown[]) => void) {
      // Scrub PII from all log arguments
      const scrubbed = inputArgs.map(arg => scrubObject(arg));
      return method.apply(this, scrubbed);
    },
  },
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  },
});

export function createLogger(name: string) {
  return rootLogger.child({ name });
}

export { rootLogger as logger };
