import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { promises as fs } from 'node:fs';
import { getDb } from '$lib/server/db';

/**
 * DELETE /api/lists/[id]/items/[itemId]
 *
 * Removes a list_item and cleans up its mirror files.
 * Steps:
 *   1. Verify the item belongs to this list.
 *   2. Collect all mirror_files rows for the item.
 *   3. Delete the physical mirror files from disk (best-effort).
 *   4. Delete the list_items row — ON DELETE CASCADE removes mirror_files rows.
 */
export const DELETE: RequestHandler = async ({ params }) => {
	const listId = Number(params.id);
	const itemId = Number(params.itemId);

	if (isNaN(listId) || isNaN(itemId)) error(400, 'Invalid list or item ID');

	const db = getDb();

	const item = db
		.prepare('SELECT id FROM list_items WHERE id = ? AND list_id = ?')
		.get(itemId, listId) as { id: number } | undefined;

	if (!item) error(404, 'Item not found in this list');

	// Collect mirror file paths before deleting the DB row
	const mirrorFiles = db
		.prepare('SELECT mirror_path FROM mirror_files WHERE list_item_id = ?')
		.all(itemId) as Array<{ mirror_path: string }>;

	// Delete physical files best-effort — don't abort if a file is already gone
	const fileResults = await Promise.allSettled(
		mirrorFiles.map((f) => fs.unlink(f.mirror_path))
	);
	const fileErrors = fileResults.filter((r) => {
		if (r.status === 'rejected') {
			const code = (r.reason as NodeJS.ErrnoException)?.code;
			return code !== 'ENOENT'; // ignore already-missing files
		}
		return false;
	});
	if (fileErrors.length > 0) {
		console.warn(
			`[delete-item] ${fileErrors.length} mirror file(s) could not be deleted for item ${itemId}:`,
			fileErrors.map((r) => (r as PromiseRejectedResult).reason?.message)
		);
	}

	// Delete the DB row — CASCADE removes mirror_files rows
	db.prepare('DELETE FROM list_items WHERE id = ?').run(itemId);

	console.log(
		`[delete-item] removed list_item ${itemId} from list ${listId}, ` +
		`deleted ${mirrorFiles.length - fileErrors.length}/${mirrorFiles.length} mirror file(s)`
	);

	return json({ deleted: true, itemId });
};
