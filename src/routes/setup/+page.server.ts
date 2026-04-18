import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSession,
  createUser,
  userCount
} from '$lib/server/auth';
import { resolveCookieSecure } from '$lib/server/env';

export const load: PageServerLoad = async () => {
  // If the admin has already been created, the setup page is not needed.
  if (userCount() > 0) {
    redirect(303, '/login');
  }
  return {};
};

export const actions: Actions = {
  default: async ({ request, cookies, url }) => {
    if (userCount() > 0) {
      redirect(303, '/login');
    }

    const form = await request.formData();
    const username = (form.get('username') ?? '').toString().trim();
    const password = (form.get('password') ?? '').toString();
    const confirm = (form.get('confirm') ?? '').toString();

    if (!username || !password) {
      return fail(400, { username, error: 'Username and password are required.' });
    }
    if (password.length < 8) {
      return fail(400, { username, error: 'Password must be at least 8 characters.' });
    }
    if (password !== confirm) {
      return fail(400, { username, error: 'Passwords do not match.' });
    }

    const userId = await createUser(username, password);
    const { id: sessionId, expiresAt } = createSession(userId);
    cookies.set(SESSION_COOKIE, sessionId, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      // Driven by TUNEFETCH_COOKIE_SECURE (see env.ts).
      secure: resolveCookieSecure(url),
      expires: expiresAt,
      maxAge: SESSION_TTL_MS / 1000
    });

    redirect(303, '/');
  }
};
