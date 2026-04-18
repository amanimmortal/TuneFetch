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
import { registerShutdownHandlers } from '$lib/server/shutdown';

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
  // Register SIGTERM/SIGINT handlers for clean shutdown.
  registerShutdownHandlers();
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
  const isQuiet = pathname.startsWith('/@') || pathname.startsWith('/node_modules');

  // ── DEBUG: inbound request state (cookie + resolved user) ─────────────────
  // Remove once the login-loop issue is fully diagnosed.
  const rawCookieHdr = event.request.headers.get('cookie') ?? '';
  const hasSessionCookieHdr = rawCookieHdr.includes(`${SESSION_COOKIE}=`);
  if (!isQuiet) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        tag: 'hooks.in',
        method: event.request.method,
        path: pathname,
        search: event.url.search,
        proto: event.url.protocol,
        host: event.request.headers.get('host'),
        xfProto: event.request.headers.get('x-forwarded-proto'),
        hasSessionCookieHdr,
        sessionIdPresent: Boolean(sessionId),
        userResolved: event.locals.user?.username ?? null
      })
    );
  }

  const t0 = Date.now();
  try {
    // If no admin user has been configured yet, force the user through
    // a first-run setup flow.
    if (userCount() === 0 && !pathname.startsWith('/setup') && !isPublic(pathname)) {
      redirect(303, '/setup');
    }

    if (!event.locals.user && !isPublic(pathname)) {
      const target = encodeURIComponent(pathname + event.url.search);
      redirect(303, `/login?redirect=${target}`);
    }

    const response = await resolve(event);
    const ms = Date.now() - t0;
    if (!isQuiet) {
      const setCookieHdr = response.headers.get('set-cookie');
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          tag: 'hooks.out',
          method: event.request.method,
          path: pathname,
          status: response.status,
          ms,
          setCookie: setCookieHdr ? setCookieHdr.slice(0, 240) : null
        })
      );
    }
    return response;
  } catch (e) {
    // Log redirects thrown from this handle (they bypass resolve() above
    // so would otherwise be invisible in the docker log stream).
    const ms = Date.now() - t0;
    if (
      e &&
      typeof e === 'object' &&
      'status' in e &&
      'location' in e &&
      !isQuiet
    ) {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          tag: 'hooks.redirectThrow',
          method: event.request.method,
          path: pathname,
          status: (e as { status: number }).status,
          location: (e as { location: string }).location,
          ms
        })
      );
    }
    throw e;
  }
};
