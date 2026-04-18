import { hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { getDb } from './db';
import { env } from './env';

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

/** Create a new session for the given user and return its id. */
export function createSession(userId: number): { id: string; expiresAt: Date } {
  const id = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  getDb()
    .prepare(
      'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
    )
    .run(id, userId, expiresAt.toISOString());
  return { id, expiresAt };
}

/**
 * Resolve a session cookie to a user record. Returns null if the
 * session is unknown or expired. Expired sessions are deleted on
 * read.
 */
export function getSessionUser(
  sessionId: string | null | undefined
): { id: number; username: string } | null {
  if (!sessionId) return null;
  const row = getDb()
    .prepare('SELECT id, user_id, expires_at FROM sessions WHERE id = ?')
    .get(sessionId) as SessionRow | undefined;
  if (!row) return null;

  if (new Date(row.expires_at).getTime() < Date.now()) {
    deleteSession(sessionId);
    return null;
  }
  return getUserById(row.user_id);
}

export function deleteSession(sessionId: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

/** Remove any sessions past their expiry. Safe to call periodically. */
export function cleanupExpiredSessions(): void {
  getDb()
    .prepare('DELETE FROM sessions WHERE expires_at < ?')
    .run(new Date().toISOString());
}
