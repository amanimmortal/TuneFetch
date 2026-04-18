import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';

interface StatusRow {
	id: number;
	sync_status: string;
	sync_error: string | null;
	lidarr_artist_id: number | null;
	lidarr_album_id: number | null;
	lidarr_track_id: number | null;
}

/**
 * GET /api/lists/[id]/status
 *
 * Lightweight polling endpoint — returns sync_status for every item
 * in the list. Called every few seconds from the list detail page
 * while any items are in a pending/in-progress state.
 */
export const GET: RequestHandler = async ({ params }) => {
	const listId = Number(params.id);
	if (isNaN(listId)) error(400, 'Invalid list ID');

	const items = getDb()
		.prepare(
			`SELECT id, sync_status, sync_error,
              lidarr_artist_id, lidarr_album_id, lidarr_track_id
         FROM list_items
         WHERE list_id = ?
         ORDER BY created_at DESC`
		)
		.all(listId) as StatusRow[];

	return json({ items });
};
