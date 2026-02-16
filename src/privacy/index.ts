/**
 * Privacy module — barrel exports
 */

export { detectPii, containsSensitiveData, type PiiType, type PiiMatch, type DetectionResult } from './detector.js';
export { Anonymizer } from './anonymizer.js';
