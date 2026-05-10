import type { LayoutServerLoad } from './$types';
import { ADMIN_COOKIE } from '$lib/server/adminMode';

export const load: LayoutServerLoad = async ({ locals, cookies }) => {
  const isAdmin = cookies.get(ADMIN_COOKIE) === 'true';
  return {
    user: locals.user,
    isAdmin
  };
};
