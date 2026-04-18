/**
 * Validated environment configuration.
 *
 * Per OQ-2 (resolved): TUNEFETCH_SECRET is REQUIRED. The container
 * must fail fast on startup if it is missing or too short, so that we
 * never silently regenerate a secret and invalidate every existing
 * session.
 */

import { building } from '$app/environment';
import { setDefaultResultOrder } from 'node:dns';
import { Agent, setGlobalDispatcher } from 'undici';

/**
 * Node's native fetch uses happy-eyeballs: it tries AAAA (IPv6) and A (IPv4)
 * addresses in parallel. In Docker user-defined bridge networks the
 * container often has an IPv6 address but no working IPv6 route, which
 * makes the v6 attempt fail instantly with ETIMEDOUT before the v4
 * attempt can finish. The symptom is: LAN IPv4 hosts work, public
 * hostnames (musicbrainz.org, etc.) fail with sub-second ETIMEDOUT.
 *
 * Two belt-and-braces mitigations, applied in order:
 *
 * 1. `setDefaultResultOrder('ipv4first')` — changes the order in which
 *    `dns.lookup` returns addresses. Only affects code paths that use
 *    `dns.lookup` directly.
 *
 * 2. Replace undici's global dispatcher with one that pins the TCP
 *    `connect` family to 4. This guarantees every outbound fetch uses
 *    IPv4 regardless of DNS result order or undici's happy-eyeballs
 *    scheduler. This is the authoritative fix — `setDefaultResultOrder`
 *    alone did not stop the ETIMEDOUT on the Unraid deploy target.
 *
 * Both run at module top-level in env.ts (imported eagerly from
 * hooks.server.ts) so they apply before any fetch is made.
 * Skipped during build to avoid touching global state in the bundler.
 */
if (!building) {
	try {
		setDefaultResultOrder('ipv4first');
	} catch (err) {
		console.warn('[env] setDefaultResultOrder(ipv4first) failed:', err);
	}
	try {
		setGlobalDispatcher(
			new Agent({
				connect: { family: 4 }
			})
		);
		console.log('[env] undici dispatcher pinned to IPv4 (family=4).');
	} catch (err) {
		console.warn('[env] setGlobalDispatcher(family=4) failed:', err);
	}
}

type CookieSecureMode = 'auto' | 'true' | 'false';

interface Env {
  /** Secret used for signing session cookies. Must be >= 32 chars. */
  SECRET: string;
  /** Directory where the SQLite DB and any persistent app files live. */
  DATA_DIR: string;
  /** Optional pre-seeded admin username. */
  ADMIN_USER: string | null;
  /** Optional pre-seeded admin password (plaintext, hashed on first run). */
  ADMIN_PASSWORD: string | null;
  /**
   * Controls the `Secure` attribute on the session cookie:
   *  - 'auto'  (default) — set Secure when the request URL is https.
   *  - 'true'  — always set Secure (behind an HTTPS proxy).
   *  - 'false' — never set Secure (plain-HTTP LAN deployment).
   *
   * Needed because adapter-node can report `url.protocol` as `https:`
   * when ORIGIN is set to an https URL, even when the browser actually
   * connected over plain HTTP — which causes the browser to silently
   * drop the session cookie and makes login appear to loop.
   */
  COOKIE_SECURE: CookieSecureMode;
}

function parseCookieSecure(raw: string | undefined): CookieSecureMode {
  const v = (raw ?? 'auto').toLowerCase();
  if (v === 'auto' || v === 'true' || v === 'false') return v;
  throw new Error(
    `TUNEFETCH_COOKIE_SECURE must be one of: auto, true, false (got "${raw}").`
  );
}

function load(): Env {
  if (building) {
    return {
      SECRET: 'dummy_secret_for_build_only_that_is_32_chars_long',
      DATA_DIR: '/app/data',
      ADMIN_USER: null,
      ADMIN_PASSWORD: null,
      COOKIE_SECURE: 'auto'
    };
  }

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
    ADMIN_PASSWORD: process.env.TUNEFETCH_ADMIN_PASSWORD ?? null,
    COOKIE_SECURE: parseCookieSecure(process.env.TUNEFETCH_COOKIE_SECURE)
  };
}

/**
 * Resolve the effective `secure` flag for a session cookie given the
 * request URL. Exported for use by login/setup form actions.
 */
export function resolveCookieSecure(url: URL): boolean {
  switch (env.COOKIE_SECURE) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'auto':
    default:
      return url.protocol === 'https:';
  }
}

export const env: Env = load();
