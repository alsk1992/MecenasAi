/**
 * Privacy Anonymizer — bidirectional PII ↔ placeholder replacement
 * Stateful per request: consistent mapping across system prompt + messages + tool results.
 * Response is de-anonymized back (best-effort).
 */

import { detectPii, type PiiType, type PiiMatch } from './detector.js';

// =============================================================================
// PLACEHOLDER FORMAT
// =============================================================================

const PLACEHOLDER_LABELS: Record<PiiType, string> = {
  pesel: 'PESEL',
  nip: 'NIP',
  regon: 'REGON',
  phone: 'TEL',
  email: 'EMAIL',
  postal_code: 'KOD',
  case_signature: 'SYGN',
  person_name: 'OSOBA',
  address: 'ADRES',
  iban: 'IBAN',
  id_card: 'DOWOD',
  passport: 'PASZPORT',
  company_name: 'FIRMA',
};

// =============================================================================
// ANONYMIZER CLASS
// =============================================================================

/**
 * Per-request bidirectional PII anonymizer.
 *
 * IMPORTANT — SESSION ISOLATION:
 * Create a NEW Anonymizer instance for each request/message.
 * Never share an instance across sessions or users — doing so would
 * leak PII mappings between different lawyer sessions.
 *
 * The stateful design (forward/reverse maps) is intentional within a single
 * request to maintain consistent placeholder mapping across system prompt,
 * user messages, tool inputs, tool results, and final response.
 */
export class Anonymizer {
  /** original → placeholder */
  private readonly forward = new Map<string, string>();
  /** placeholder → original */
  private readonly reverse = new Map<string, string>();
  /** counters per PII type */
  private readonly counters = new Map<PiiType, number>();

  /**
   * Replace all detected PII in text with consistent placeholders.
   * Same original value always maps to the same placeholder within this instance.
   */
  anonymize(text: string): string {
    const result = detectPii(text);
    if (!result.hasPii) return text;

    // Sort matches by index descending so replacements don't shift positions
    const sorted = [...result.matches].sort((a, b) => b.index - a.index);

    let out = text;
    for (const match of sorted) {
      const placeholder = this.getOrCreatePlaceholder(match.type, match.value);
      out = out.slice(0, match.index) + placeholder + out.slice(match.index + match.value.length);
    }
    return out;
  }

  /**
   * Replace all placeholders in text back to original values (best-effort).
   * Critical guarantee is that PII never reaches cloud, not that de-anonymization is perfect.
   */
  deanonymize(text: string): string {
    let out = text;
    // Replace longer placeholders first to avoid partial matches
    const entries = [...this.reverse.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [placeholder, original] of entries) {
      // Use split+join for global replacement (no regex escaping needed)
      out = out.split(placeholder).join(original);
    }
    return out;
  }

  /**
   * Check if this anonymizer has any mappings (i.e., PII was found and replaced).
   */
  get hasReplacements(): boolean {
    return this.forward.size > 0;
  }

  /**
   * Get the current mapping table (for debugging/logging — never send to cloud).
   */
  get mappingCount(): number {
    return this.forward.size;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** Normalize PII values for consistent mapping (e.g. NIP with/without dashes → same placeholder) */
  private normalizeValue(type: PiiType, value: string): string {
    if (type === 'nip' || type === 'regon' || type === 'pesel' || type === 'phone' || type === 'iban') {
      return value.replace(/[-\s]/g, '');
    }
    if (type === 'person_name' || type === 'company_name') {
      return value.trim();
    }
    return value;
  }

  private getOrCreatePlaceholder(type: PiiType, value: string): string {
    // Check both raw and normalized forms
    const normalized = this.normalizeValue(type, value);
    const existing = this.forward.get(value) ?? this.forward.get(normalized);
    if (existing) {
      // Also register the original form for forward lookup (but keep first seen form in reverse)
      if (!this.forward.has(value)) {
        this.forward.set(value, existing);
      }
      return existing;
    }

    const count = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, count);

    const label = PLACEHOLDER_LABELS[type];
    const placeholder = `<<MECENAS_${label}_${count}>>`;

    this.forward.set(value, placeholder);
    // Also store the normalized form for cross-lookup
    if (normalized !== value) {
      this.forward.set(normalized, placeholder);
    }
    this.reverse.set(placeholder, value);

    return placeholder;
  }
}
