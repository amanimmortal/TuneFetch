/**
 * Symmetric encryption helpers for TuneFetch.
 *
 * Uses AES-256-GCM with a random 12-byte IV per encryption operation.
 * The key is derived from TUNEFETCH_SECRET (first 32 bytes, zero-padded if shorter).
 *
 * Output format (base64-encoded): `<12-byte IV><16-byte auth tag><ciphertext>`
 * Prefix "enc1:" marks encrypted values so migrations can detect them.
 *
 * HMAC-SHA256 helper is used by auth.ts to sign session cookie values so
 * that rotating TUNEFETCH_SECRET invalidates all outstanding sessions.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';
import { env } from './env';

const ENC_PREFIX = 'enc1:';
const IV_LEN = 12;
const TAG_LEN = 16;
const ALG = 'aes-256-gcm';

/** Derive a 32-byte key buffer from the secret string. */
function deriveKey(): Buffer {
  const raw = Buffer.from(env.SECRET, 'utf8');
  if (raw.length >= 32) return raw.subarray(0, 32);
  // Zero-pad if shorter than 32 bytes (TUNEFETCH_SECRET validation already
  // requires >= 32 chars so this is a safety fallback only).
  const padded = Buffer.alloc(32, 0);
  raw.copy(padded);
  return padded;
}

/**
 * Encrypt `plaintext` and return a prefixed base64 string.
 * The result is safe to store in any TEXT column.
 */
export function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: IV | auth-tag | ciphertext
  const combined = Buffer.concat([iv, tag, ct]);
  return ENC_PREFIX + combined.toString('base64');
}

/**
 * Decrypt a value produced by `encrypt()`.
 * Returns the original plaintext.
 * Throws if the ciphertext is tampered with or the key is wrong.
 */
export function decrypt(ciphertext: string): string {
  if (!ciphertext.startsWith(ENC_PREFIX)) {
    throw new Error('decrypt: value does not have expected enc1: prefix');
  }
  const combined = Buffer.from(ciphertext.slice(ENC_PREFIX.length), 'base64');
  if (combined.length < IV_LEN + TAG_LEN) {
    throw new Error('decrypt: ciphertext too short');
  }
  const iv = combined.subarray(0, IV_LEN);
  const tag = combined.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = combined.subarray(IV_LEN + TAG_LEN);

  const key = deriveKey();
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct) + decipher.final('utf8');
}

/** Returns true when the value was produced by `encrypt()`. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

// ── Session HMAC ──────────────────────────────────────────────────────────────

const HMAC_SEP = ':';

/**
 * Sign a raw session ID with HMAC-SHA256(SECRET).
 * Returns `${rawId}:${hmac}` — this is the value stored in the cookie.
 */
export function signSessionId(rawId: string): string {
  const sig = createHmac('sha256', env.SECRET).update(rawId).digest('hex');
  return rawId + HMAC_SEP + sig;
}

/**
 * Verify and extract the raw session ID from a signed cookie value.
 * Returns the rawId if the HMAC is valid, null otherwise.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function verifySessionCookie(cookie: string): string | null {
  const sep = cookie.lastIndexOf(HMAC_SEP);
  if (sep === -1) return null;
  const rawId = cookie.slice(0, sep);
  const provided = cookie.slice(sep + 1);
  const expected = createHmac('sha256', env.SECRET).update(rawId).digest('hex');
  // Both buffers must be same length for timingSafeEqual
  if (provided.length !== expected.length) return null;
  const valid = timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  return valid ? rawId : null;
}
