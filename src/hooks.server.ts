import { redirect, type Handle } from '@sveltejs/kit';
import {
  SESSION_COOKIE,
  getSessionUser,
  maybeSeedAdmin,
  userCount
} from '$lib/server/auth';
// Importing env eagerly so the process fails fast if TUNEFETCH_SECRET is missing.
import '$lib/server/env';
import { startScheduler } from '$lib/server/scheduler';

// Paths that are accessible without authentication.
const PUBLIC_PREFIXES = ['/login', '/setup', '/api/webhook/'];

let _seeded = false;
async function ensureSeed() {
  if (_seeded) return;
  _seeded = true;
  await maybeSeedAdmin();
  // Start the nightly orphan scan scheduler on first request.
  // startScheduler() is idempotent — safe to call here.
  startScheduler();
}

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

export const handle: Handle = async ({ event, resolve }) => {
  await ensureSeed();

  const sessionId = event.cookies.get(SESSION_COOKIE) ?? null;
  event.locals.sessionId = sessionId;
  event.locals.user = getSessionUser(sessionId);

  const { pathname } = event.url;

  // If no admin user has been configured yet, force the user through
  // a first-run setup flow.
  if (userCount() === 0 && !pathname.startsWith('/setup') && !isPublic(pathname)) {
    redirect(303, '/setup');
  }

  if (!event.locals.user && !isPublic(pathname)) {
    const target = encodeURIComponent(pathname + event.url.search);
    redirect(303, `/login?redirect=${target}`);
  }

  return resolve(event);
};
