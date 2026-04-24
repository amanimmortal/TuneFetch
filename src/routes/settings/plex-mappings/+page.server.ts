/**
 * Plex User Mappings page.
 *
 * Maps Lidarr root folder paths to Plex managed users so the system
 * knows which user should receive playlists for which list.
 */
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { getSetting, SETTING_KEYS } from '$lib/server/settings';
import { rootFolders } from '$lib/server/lidarr';

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

	// Get Lidarr root folders for the dropdown
	let lidarrRootFolders: Array<{ path: string }> = [];
	try {
		const folders = await rootFolders();
		lidarrRootFolders = folders.map((f) => ({ path: f.path }));
	} catch {
		// Lidarr not configured — that's OK
	}

	// Check if Plex is configured
	const plexConfigured = !!(getSetting(SETTING_KEYS.PLEX_URL) && getSetting(SETTING_KEYS.PLEX_ADMIN_TOKEN));

	return { mappings, rootFolders: lidarrRootFolders, plexConfigured };
};
