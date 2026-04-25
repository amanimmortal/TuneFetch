import { hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { getDb } from './db';
import { env } from './env';
import { signSessionId, verifySessionCookie } from './crypto';

export const SESSION_COOKIE = 'tf_session';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
}

interface SessionRow {
  id: string;
  user_id: number;
  expires_at: string;
}

/** Argon2id hash with the library's defaults (suitable for passwords). */
export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(
  password: string,
  passwordHash: string
): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/**
 * Look up a user by username. Returns null if not found.
 */
export function getUserByUsername(username: string): UserRow | null {
  return (
    (getDb()
      .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
      .get(username) as UserRow | undefined) ?? null
  );
}

export function getUserById(id: number): Pick<UserRow, 'id' | 'username'> | null {
  return (
    (getDb()
      .prepare('SELECT id, username FROM users WHERE id = ?')
      .get(id) as { id: number; username: string } | undefined) ?? null
  );
}

export function userCount(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM users')
    .get() as { c: number };
  return row.c;
}

/** Create a user. Throws on duplicate username. */
export async function createUser(
  username: string,
  password: string
): Promise<number> {
  const passwordHash = await hashPassword(password);
  const result = getDb()
    .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(username, passwordHash);
  return Number(result.lastInsertRowid);
}

/**
 * Seed the admin user from env vars if no user exists yet and both
 * TUNEFETCH_ADMIN_USER and TUNEFETCH_ADMIN_PASSWORD are set. Called
 * once at server startup.
 */
export async function maybeSeedAdmin(): Promise<void> {
  if (userCount() > 0) return;
  if (!env.ADMIN_USER || !env.ADMIN_PASSWORD) return;
  await createUser(env.ADMIN_USER, env.ADMIN_PASSWORD);
}

/**
 * Create a new session for the given user.
 *
 * Returns `id` — the signed cookie value (`rawId:hmac`) to store in the browser.
 * Only the rawId is persisted in the DB; the HMAC lives only in the cookie.
 * Rotating TUNEFETCH_SECRET invalidates all outstanding sessions because
 * verifySessionCookie() will reject the old HMACs.
 */
export function createSession(userId: number): { id: string; expiresAt: Date } {
  const rawId = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  getDb()
    .prepare(
      'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
    )
    .run(rawId, userId, expiresAt.toISOString());
  return { id: signSessionId(rawId), expiresAt };
}

/**
 * Resolve a signed session cookie value to a user record.
 * Returns null if the HMAC is invalid, the session is unknown, or it is expired.
 * Expired sessions are deleted on read.
 */
export function getSessionUser(
  cookieValue: string | null | undefined
): { id: number; username: string } | null {
  if (!cookieValue) return null;
  // Verify HMAC before hitting the DB to prevent timing attacks on invalid cookies.
  const rawId = verifySessionCookie(cookieValue);
  if (!rawId) return null;

  const row = getDb()
    .prepare('SELECT id, user_id, expires_at FROM sessions WHERE id = ?')
    .get(rawId) as SessionRow | undefined;
  if (!row) return null;

  if (new Date(row.expires_at).getTime() < Date.now()) {
    deleteSession(rawId);
    return null;
  }
  return getUserById(row.user_id);
}

/**
 * Delete a session by its signed cookie value or raw ID.
 * Accepts either format so logout works regardless of whether the cookie
 * has been updated to the HMAC-signed form.
 */
export function deleteSession(cookieValueOrRawId: string): void {
  // If it looks like a signed value, extract the rawId; otherwise use as-is.
  const rawId = verifySessionCookie(cookieValueOrRawId) ?? cookieValueOrRawId;
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(rawId);
}

/** Remove any sessions past their expiry. Safe to call periodically. */
export function cleanupExpiredSessions(): void {
  getDb()
    .prepare('DELETE FROM sessions WHERE expires_at < ?')
    .run(new Date().toISOString());
}
