import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';

interface ListRow {
	id: number;
	name: string;
	root_folder_path: string;
	quality_profile_id: number | null;
	metadata_profile_id: number | null;
}

interface ListItemRow {
	id: number;
	mbid: string;
	type: 'track' | 'album' | 'artist';
	title: string;
	artist_name: string;
	album_name: string | null;
	lidarr_artist_id: number | null;
	lidarr_album_id: number | null;
	lidarr_track_id: number | null;
	sync_status: string;
	sync_error: string | null;
	created_at: string;
}

interface PlexPlaylistRow {
	id: number;
	list_id: number;
	plex_user_token: string;
	plex_user_name: string;
	plex_playlist_id: string | null;
	playlist_title: string;
	last_synced_at: string | null;
	created_at: string;
}

interface PlexUserMappingRow {
	id: number;
	root_folder_path: string;
	plex_user_name: string;
	plex_user_token: string;
}

export const load: PageServerLoad = async ({ params }) => {
	const id = Number(params.id);
	if (isNaN(id)) error(400, 'Invalid list ID');

	const db = getDb();

	const list = db
		.prepare('SELECT id, name, root_folder_path, quality_profile_id, metadata_profile_id FROM lists WHERE id = ?')
		.get(id) as ListRow | undefined;

	if (!list) error(404, 'List not found');

	const items = db
		.prepare(
			`SELECT id, mbid, type, title, artist_name, album_name,
              lidarr_artist_id, lidarr_album_id, lidarr_track_id,
              sync_status, sync_error, created_at
         FROM list_items
         WHERE list_id = ?
         ORDER BY created_at DESC`
		)
		.all(id) as ListItemRow[];

	// Plex playlists linked to this list
	const plexPlaylists = db
		.prepare(
			`SELECT id, list_id, plex_user_token, plex_user_name, plex_playlist_id,
              playlist_title, last_synced_at, created_at
         FROM plex_playlists
         WHERE list_id = ?
         ORDER BY created_at ASC`
		)
		.all(id) as PlexPlaylistRow[];

	// Suggested user mapping based on this list's root_folder_path
	const suggestedMapping = db
		.prepare('SELECT * FROM plex_user_mappings WHERE root_folder_path = ?')
		.get(list.root_folder_path) as PlexUserMappingRow | undefined;

	// All user mappings (for the dropdown)
	const allMappings = db
		.prepare('SELECT * FROM plex_user_mappings ORDER BY root_folder_path')
		.all() as PlexUserMappingRow[];

	// Count synced plex items per playlist
	const plexItemCounts: Record<number, number> = {};
	for (const pp of plexPlaylists) {
		const row = db
			.prepare('SELECT COUNT(*) as cnt FROM plex_playlist_items WHERE plex_playlist_id_fk = ?')
			.get(pp.id) as { cnt: number };
		plexItemCounts[pp.id] = row.cnt;
	}

	return { list, items, plexPlaylists, suggestedMapping, allMappings, plexItemCounts };
};

