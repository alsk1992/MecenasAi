/**
 * Privacy module — barrel exports
 */

export { detectPii, containsSensitiveData, type PiiType, type PiiMatch, type DetectionResult } from './detector.js';
export { Anonymizer } from './anonymizer.js';
export { logPrivacyEvent, queryAuditLog, initAuditLog, type PrivacyAction, type AuditEntry } from './audit.js';
export { getEncryptionKey, encryptBuffer, decryptBuffer, isEncryptedFile } from './encryption.js';
export { findPolishNames, containsPolishName, matchPolishName } from './names.js';
