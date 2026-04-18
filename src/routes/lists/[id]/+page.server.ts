import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';

interface ListRow {
	id: number;
	name: string;
	root_folder_path: string;
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

export const load: PageServerLoad = async ({ params }) => {
	const id = Number(params.id);
	if (isNaN(id)) error(400, 'Invalid list ID');

	const db = getDb();

	const list = db
		.prepare('SELECT id, name, root_folder_path FROM lists WHERE id = ?')
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

	return { list, items };
};
