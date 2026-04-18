import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { SESSION_COOKIE, deleteSession } from '$lib/server/auth';

export const POST: RequestHandler = async ({ cookies, locals }) => {
  if (locals.sessionId) {
    deleteSession(locals.sessionId);
  }
  cookies.delete(SESSION_COOKIE, { path: '/' });
  redirect(303, '/login');
};
