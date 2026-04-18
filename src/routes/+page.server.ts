import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { getDb } from '$lib/server/db';
import { orchestrate } from '$lib/server/orchestrator';

export const load: PageServerLoad = async () => {
	const lists = getDb()
		.prepare('SELECT id, name FROM lists ORDER BY name ASC')
		.all() as { id: number; name: string }[];

	return { lists };
};

export const actions: Actions = {
	/**
	 * Add an item to a list and immediately kick off the Lidarr push.
	 * The orchestrator runs in the background — the action returns
	 * immediately with the newly-created item id so the UI can poll
	 * for status updates.
	 */
	addToList: async ({ request }) => {
		const data = await request.formData();
		const listId   = Number(data.get('listId'));
		const mbid     = ((data.get('mbid')       as string | null) ?? '').trim();
		const type     = ((data.get('type')       as string | null) ?? '').trim();
		const title    = ((data.get('title')      as string | null) ?? '').trim();
		const artistName = ((data.get('artistName') as string | null) ?? '').trim();
		const albumName  = ((data.get('albumName')  as string | null) ?? '').trim() || null;
		// Artist MBID for track/album items — used by orchestrator to auto-add
		// the artist to Lidarr (monitor=none) when not already present.
		const artistMbid = ((data.get('artistMbid') as string | null) ?? '').trim() || null;

		if (!listId || !mbid || !type || !title || !artistName) {
			return fail(400, { error: 'Missing required fields for adding to list.' });
		}

		if (!['track', 'album', 'artist'].includes(type)) {
			return fail(400, { error: 'Invalid item type.' });
		}

		let newItemId: number;
		try {
			const result = getDb()
				.prepare(
					`INSERT INTO list_items (list_id, mbid, type, title, artist_name, album_name, artist_mbid)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
				)
				.run(listId, mbid, type, title, artistName, albumName, artistMbid);
			newItemId = result.lastInsertRowid as number;
		} catch {
			return fail(500, { error: 'Database error — could not add item.' });
		}

		// Fire-and-forget orchestration. We do not await so the HTTP response
		// returns quickly. The UI polls /api/lists/[id]/status for live updates.
		orchestrate(newItemId).catch((err) => {
			console.error(`[orchestrate] unhandled error for item ${newItemId}:`, err);
		});

		return { success: true, newItemId, listId };
	}
};
