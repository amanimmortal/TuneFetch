/**
 * Validated environment configuration.
 *
 * Per OQ-2 (resolved): TUNEFETCH_SECRET is REQUIRED. The container
 * must fail fast on startup if it is missing or too short, so that we
 * never silently regenerate a secret and invalidate every existing
 * session.
 */

interface Env {
  /** Secret used for signing session cookies. Must be >= 32 chars. */
  SECRET: string;
  /** Directory where the SQLite DB and any persistent app files live. */
  DATA_DIR: string;
  /** Optional pre-seeded admin username. */
  ADMIN_USER: string | null;
  /** Optional pre-seeded admin password (plaintext, hashed on first run). */
  ADMIN_PASSWORD: string | null;
}

function load(): Env {
  const secret = process.env.TUNEFETCH_SECRET;
  if (!secret) {
    throw new Error(
      'TUNEFETCH_SECRET environment variable is required. ' +
        'Set it to a random string of at least 32 characters.'
    );
  }
  if (secret.length < 32) {
    throw new Error(
      `TUNEFETCH_SECRET must be at least 32 characters (got ${secret.length}).`
    );
  }

  return {
    SECRET: secret,
    DATA_DIR: process.env.TUNEFETCH_DATA_DIR ?? '/app/data',
    ADMIN_USER: process.env.TUNEFETCH_ADMIN_USER ?? null,
    ADMIN_PASSWORD: process.env.TUNEFETCH_ADMIN_PASSWORD ?? null
  };
}

export const env: Env = load();
