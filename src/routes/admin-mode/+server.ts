import { redirect, type RequestHandler } from '@sveltejs/kit';
import { ADMIN_COOKIE } from '$lib/server/adminMode';

export const POST: RequestHandler = async ({ request, cookies, url }) => {
  const form = await request.formData();
  const next = String(form.get('value') ?? '') === 'true';
  const redirectTo = String(form.get('redirectTo') ?? '/');

  cookies.set(ADMIN_COOKIE, next ? 'true' : 'false', {
    path: '/',
    httpOnly: false,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365
  });

  const safeTarget = redirectTo.startsWith('/') && !redirectTo.startsWith('//')
    ? redirectTo
    : '/';

  redirect(303, safeTarget);
};
