import { getDb } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';
import { fail } from '@sveltejs/kit';

export const load: PageServerLoad = async () => {
	const lists = getDb()
		.prepare('SELECT id, name FROM lists ORDER BY name ASC')
		.all() as { id: number; name: string }[];

	return { lists };
};

export const actions: Actions = {
	addToList: async ({ request }) => {
		const data = await request.formData();
		const listId = data.get('listId');
		const mbid = data.get('mbid');
		const type = data.get('type');
		const title = data.get('title');
		const artistName = data.get('artistName');
		const albumName = data.get('albumName') || null;

		if (!listId || !mbid || !type || !title || !artistName) {
			return fail(400, { error: 'Missing required fields for adding to list.' });
		}

		try {
			// Minimal wire-up as per Phase 1B requirements. Full orchestration in Phase 2.
			getDb()
				.prepare(
					`INSERT INTO list_items (list_id, mbid, type, title, artist_name, album_name)
					 VALUES (?, ?, ?, ?, ?, ?)`
				)
				.run(listId, mbid, type, title, artistName, albumName);
			
			return { success: true };
		} catch (e: unknown) {
			console.error('Error adding to list:', e);
			return fail(500, { error: 'Database error adding to list.' });
		}
	}
};
