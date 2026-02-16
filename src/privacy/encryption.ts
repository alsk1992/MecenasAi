/**
 * Database Encryption at Rest — AES-256-GCM
 * Encrypts the SQLite database file when saving to disk.
 * Key source: MECENAS_DB_KEY env var or auto-generated keyfile at ~/.mecenas/db.key
 *
 * File format: [12-byte IV][16-byte auth tag][encrypted data]
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { resolveStateDir } from '../config/index.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_FILE = join(resolveStateDir(), 'db.key');

// Magic bytes to identify encrypted files
const MAGIC = Buffer.from('MECENAS1');

const SALT_FILE = join(resolveStateDir(), 'db.salt');

/**
 * Derive a 256-bit key from a passphrase using scrypt.
 * Uses per-installation random salt (generated on first run, persisted to db.salt).
 */
function deriveKey(passphrase: string): Buffer {
  const salt = getOrCreateSalt();
  return scryptSync(passphrase, salt, 32);
}

/** Get or create a per-installation random salt (16 bytes) */
function getOrCreateSalt(): Buffer {
  // Try to read existing salt file
  if (existsSync(SALT_FILE)) {
    try {
      return readFileSync(SALT_FILE);
    } catch {
      // Fall through to create new salt
    }
  }
  // Generate new random salt and persist
  const salt = randomBytes(16);
  try {
    writeFileSync(SALT_FILE, salt, { mode: 0o600 });
    chmodSync(SALT_FILE, 0o600);
  } catch {
    // If we can't persist, use static fallback (better than crashing)
    return Buffer.from('mecenas-db-salt-v1');
  }
  return salt;
}

/**
 * Get or create the encryption key.
 * Priority: MECENAS_DB_KEY env var → db.key file → auto-generate
 * Returns null if encryption is explicitly disabled (MECENAS_DB_ENCRYPT=false)
 */
export function getEncryptionKey(): Buffer | null {
  // Explicitly disabled
  if (process.env.MECENAS_DB_ENCRYPT === 'false') {
    return null;
  }

  // From env var
  const envKey = process.env.MECENAS_DB_KEY?.trim();
  if (envKey) {
    return deriveKey(envKey);
  }

  // From keyfile
  if (existsSync(KEY_FILE)) {
    try {
      const raw = readFileSync(KEY_FILE, 'utf-8').trim();
      return deriveKey(raw);
    } catch (err) {
      logger.warn({ err }, 'Nie udało się odczytać klucza szyfrowania');
    }
  }

  // Auto-generate keyfile (first run)
  try {
    const generated = randomBytes(32).toString('hex');
    writeFileSync(KEY_FILE, generated + '\n', { mode: 0o600 });
    chmodSync(KEY_FILE, 0o600); // owner-only read/write
    logger.info({ path: KEY_FILE }, 'Wygenerowano klucz szyfrowania bazy danych');
    return deriveKey(generated);
  } catch (err) {
    logger.warn({ err }, 'Nie udało się wygenerować klucza — baza bez szyfrowania');
    return null;
  }
}

/**
 * Encrypt a buffer (raw SQLite DB) using AES-256-GCM.
 * Returns: MAGIC + IV + AUTH_TAG + CIPHERTEXT
 */
export function encryptBuffer(data: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([MAGIC, iv, authTag, encrypted]);
}

/**
 * Decrypt an encrypted buffer back to raw SQLite DB.
 * Expects: MAGIC + IV + AUTH_TAG + CIPHERTEXT
 * Returns null if decryption fails (wrong key or corrupted file).
 */
export function decryptBuffer(data: Buffer, key: Buffer): Buffer | null {
  try {
    const offset = MAGIC.length;
    // Check magic bytes
    if (data.length < offset + IV_LENGTH + AUTH_TAG_LENGTH + 1) return null;
    if (!data.subarray(0, offset).equals(MAGIC)) return null;

    const iv = data.subarray(offset, offset + IV_LENGTH);
    const authTag = data.subarray(offset + IV_LENGTH, offset + IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = data.subarray(offset + IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}

/**
 * Check if a buffer is an encrypted Mecenas DB file (starts with MAGIC bytes).
 */
export function isEncryptedFile(data: Buffer): boolean {
  return data.length >= MAGIC.length && data.subarray(0, MAGIC.length).equals(MAGIC);
}
