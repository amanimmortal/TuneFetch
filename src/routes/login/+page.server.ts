import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSession,
  getUserByUsername,
  verifyPassword
} from '$lib/server/auth';

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

    if (!username || !password) {
      return fail(400, { username, error: 'Username and password are required.' });
    }

    const user = getUserByUsername(username);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return fail(401, { username, error: 'Invalid credentials.' });
    }

    const { id: sessionId, expiresAt } = createSession(user.id);
    cookies.set(SESSION_COOKIE, sessionId, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: Math.floor(SESSION_TTL_MS / 1000)
    });

    const redirectTo = url.searchParams.get('redirect') ?? '/';
    redirect(303, redirectTo);
  }
};
