import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { getSetting, SETTING_KEYS } from '$lib/server/settings';

interface UserMapping {
	id: number;
	root_folder_path: string;
	plex_user_name: string;
	plex_user_token: string;
	library_section_id: string | null;
	created_at: string;
}

export const load: PageServerLoad = async () => {
	const db = getDb();

	const mappings = db
		.prepare('SELECT * FROM plex_user_mappings ORDER BY root_folder_path')
		.all() as UserMapping[];

	const plexConfigured = !!(getSetting(SETTING_KEYS.PLEX_URL) && getSetting(SETTING_KEYS.PLEX_ADMIN_TOKEN));

	return { mappings, plexConfigured };
};
