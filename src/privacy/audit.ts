/**
 * Privacy Audit Log — RODO/GDPR compliance trail
 * Logs every privacy routing decision WITHOUT storing actual PII.
 * Lawyers can prove AI interactions respected tajemnica adwokacka.
 */

import { logger } from '../utils/logger.js';

// =============================================================================
// TYPES
// =============================================================================

export type PrivacyAction =
  | 'route_local'       // PII detected → routed to Ollama
  | 'route_cloud'       // No PII → routed to Anthropic
  | 'route_cloud_anon'  // Cloud with anonymization
  | 'route_refuse'      // PII + no Ollama → refused
  | 'anonymize'         // PII anonymized before cloud
  | 'session_lock'      // Session auto-locked for inactivity
  | 'session_purge'     // Session auto-purged (expired)
  | 'gdpr_delete'       // RODO right-to-deletion executed
  | 'consent_record'    // AI consent recorded for case
  | 'consent_check'     // AI consent checked for case
  | 'consent_revoke'    // AI consent revoked for case
  | 'mode_change';      // Privacy mode changed

export interface AuditEntry {
  action: PrivacyAction;
  sessionKey?: string;
  userId?: string;
  caseId?: string;
  reason: string;
  /** Number of PII matches found (not the values themselves) */
  piiMatchCount?: number;
  /** Types of PII found (e.g. ['pesel', 'nip']) — NOT the values */
  piiTypes?: string[];
  /** Number of anonymization replacements made */
  anonymizationCount?: number;
  /** Which privacy mode was active */
  privacyMode?: string;
  /** Which model/provider was used */
  provider?: string;
  timestamp: number;
}

// =============================================================================
// AUDIT LOGGER
// =============================================================================

/** Raw SQL reference — set by initAuditLog() */
let _sqlDb: import('sql.js').Database | null = null;
let _scheduleSave: (() => void) | null = null;

/**
 * Initialize the audit log with a database reference.
 * Call after DB init, before any privacy operations.
 */
export function initAuditLog(sqlDb: import('sql.js').Database, scheduleSave: () => void): void {
  _sqlDb = sqlDb;
  _scheduleSave = scheduleSave;
}

/**
 * Log a privacy decision to the audit trail.
 * NEVER include actual PII values — only metadata about the decision.
 */
export function logPrivacyEvent(entry: Omit<AuditEntry, 'timestamp'>): void {
  const full: AuditEntry = { ...entry, timestamp: Date.now() };

  // Always log to structured logger (available even if DB isn't ready)
  logger.info({
    audit: true,
    action: full.action,
    reason: full.reason,
    piiMatchCount: full.piiMatchCount,
    piiTypes: full.piiTypes,
    anonymizationCount: full.anonymizationCount,
    privacyMode: full.privacyMode,
    provider: full.provider,
  }, `Audit: ${full.action}`);

  // Persist to DB if available
  if (_sqlDb) {
    try {
      _sqlDb.run(
        `INSERT INTO privacy_audit_log (action, session_key, user_id, case_id, reason, pii_match_count, pii_types, anonymization_count, privacy_mode, provider, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          full.action,
          full.sessionKey ?? null,
          full.userId ?? null,
          full.caseId ?? null,
          full.reason,
          full.piiMatchCount ?? 0,
          full.piiTypes ? JSON.stringify(full.piiTypes) : null,
          full.anonymizationCount ?? 0,
          full.privacyMode ?? null,
          full.provider ?? null,
          full.timestamp,
        ]
      );
      _scheduleSave?.();
    } catch (err) {
      logger.warn({ err }, 'Failed to persist audit log entry');
    }
  }
}

/**
 * Query audit log entries (for compliance reporting).
 * Returns entries in reverse chronological order.
 */
export function queryAuditLog(filters?: {
  action?: PrivacyAction;
  sessionKey?: string;
  userId?: string;
  since?: number;
  limit?: number;
}): AuditEntry[] {
  if (!_sqlDb) return [];

  let sql = 'SELECT * FROM privacy_audit_log WHERE 1=1';
  const params: (string | number | null)[] = [];

  if (filters?.action) { sql += ' AND action = ?'; params.push(filters.action); }
  if (filters?.sessionKey) { sql += ' AND session_key = ?'; params.push(filters.sessionKey); }
  if (filters?.userId) { sql += ' AND user_id = ?'; params.push(filters.userId); }
  if (filters?.since) { sql += ' AND timestamp >= ?'; params.push(filters.since); }

  sql += ' ORDER BY timestamp DESC';
  const limit = Math.max(1, Math.min(filters?.limit ?? 100, 1000));
  sql += ' LIMIT ?';
  params.push(limit);

  try {
    const rows = _sqlDb.exec(sql, params);
    if (!rows.length) return [];
    return rows[0].values.map(v => {
      let piiTypes: string[] | undefined;
      if (v[7]) {
        try { piiTypes = JSON.parse(v[7] as string); } catch { piiTypes = undefined; }
      }
      return {
        action: v[1] as PrivacyAction,
        sessionKey: v[2] as string | undefined,
        userId: v[3] as string | undefined,
        caseId: v[4] as string | undefined,
        reason: v[5] as string,
        piiMatchCount: v[6] as number | undefined,
        piiTypes,
        anonymizationCount: v[8] as number | undefined,
        privacyMode: v[9] as string | undefined,
        provider: v[10] as string | undefined,
        timestamp: v[11] as number,
      };
    });
  } catch (err) {
    logger.warn({ err }, 'Błąd zapytania do logu prywatności');
    return [];
  }
}
