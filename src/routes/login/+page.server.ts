import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSession,
  getUserByUsername,
  verifyPassword
} from '$lib/server/auth';
import { env, resolveCookieSecure } from '$lib/server/env';

export const load: PageServerLoad = async ({ locals, url }) => {
  if (locals.user) {
    const redirectTo = url.searchParams.get('redirect') ?? '/';
    redirect(303, redirectTo);
  }
  return {};
};

export const actions: Actions = {
  default: async ({ request, cookies, url }) => {
    const form = await request.formData();
    const username = (form.get('username') ?? '').toString().trim();
    const password = (form.get('password') ?? '').toString();
    const redirectParam = url.searchParams.get('redirect');

    // ── DEBUG: login flow instrumentation ────────────────────────────────────
    // Remove once the login-loop issue is fully diagnosed.
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        tag: 'login.attempt',
        usernamePresent: Boolean(username),
        passwordPresent: Boolean(password),
        redirectParam,
        urlProtocol: url.protocol,
        urlHost: url.host
      })
    );

    if (!username || !password) {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          tag: 'login.missingFields'
        })
      );
      return fail(400, { username, error: 'Username and password are required.' });
    }

    const user = getUserByUsername(username);
    const credOk = user ? await verifyPassword(password, user.password_hash) : false;
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        tag: 'login.credentialCheck',
        userFound: Boolean(user),
        credentialsOk: credOk
      })
    );
    if (!user || !credOk) {
      return fail(401, { username, error: 'Invalid credentials.' });
    }

    const { id: sessionId, expiresAt } = createSession(user.id);
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        tag: 'login.sessionCreated',
        sessionIdLen: sessionId.length,
        expiresAt: expiresAt.toISOString()
      })
    );

    const cookieOpts = {
      path: '/',
      httpOnly: true,
      sameSite: 'lax' as const,
      // `secure` is driven by the TUNEFETCH_COOKIE_SECURE env var (default:
      // auto, which follows url.protocol). Keeping cookie security as an
      // explicit deployment decision avoids the LAN-over-HTTP login loop
      // caused by adapter-node reporting url.protocol as https: when it
      // shouldn't.
      secure: resolveCookieSecure(url),
      expires: expiresAt,
      maxAge: Math.floor(SESSION_TTL_MS / 1000)
    };
    cookies.set(SESSION_COOKIE, sessionId, cookieOpts);
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        tag: 'login.cookieSet',
        cookieName: SESSION_COOKIE,
        secure: cookieOpts.secure,
        cookieSecureMode: env.COOKIE_SECURE,
        sameSite: cookieOpts.sameSite,
        httpOnly: cookieOpts.httpOnly,
        path: cookieOpts.path,
        expires: cookieOpts.expires.toISOString(),
        maxAge: cookieOpts.maxAge
      })
    );

    const redirectTo = redirectParam ?? '/';
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        tag: 'login.redirecting',
        to: redirectTo
      })
    );
    redirect(303, redirectTo);
  }
};
