import type { LayoutServerLoad } from './$types';

export const ADMIN_COOKIE = 'adminMode';

export const load: LayoutServerLoad = async ({ locals, cookies }) => {
  const isAdmin = cookies.get(ADMIN_COOKIE) === 'true';
  return {
    user: locals.user,
    isAdmin
  };
};
