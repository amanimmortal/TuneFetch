import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSession,
  getUserByUsername,
  verifyPassword
} from '$lib/server/auth';
import { resolveCookieSecure } from '$lib/server/env';

/**
 * Only allow same-site relative paths to prevent open-redirect attacks.
 * Rejects protocol-relative URLs (//evil.com) and absolute URLs.
 */
function safeRedirect(target: string | null): string {
  if (!target) return '/';
  if (target.startsWith('/') && !target.startsWith('//')) return target;
  return '/';
}

export const load: PageServerLoad = async ({ locals, url }) => {
  if (locals.user) {
    const redirectTo = safeRedirect(url.searchParams.get('redirect'));
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

    if (!username || !password) {
      return fail(400, { username, error: 'Username and password are required.' });
    }

    const user = getUserByUsername(username);
    const credOk = user ? await verifyPassword(password, user.password_hash) : false;
    if (!user || !credOk) {
      console.warn('[login] Failed login attempt for username:', username ? '<present>' : '<empty>');
      return fail(401, { username, error: 'Invalid credentials.' });
    }

    const { id: sessionId, expiresAt } = createSession(user.id);

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

    const redirectTo = safeRedirect(redirectParam);
    redirect(303, redirectTo);
  }
};
