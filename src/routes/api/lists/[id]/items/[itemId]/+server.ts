import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getDb } from '$lib/server/db';
import { rootFolders } from '$lib/server/lidarr';

/**
 * DELETE /api/lists/[id]/items/[itemId]
 *
 * Removes a list_item and cleans up its mirror files.
 * Steps:
 *   1. Verify the item belongs to this list.
 *   2. Collect all mirror_files rows for the item.
 *   3. Delete the physical mirror files from disk (best-effort).
 *   4. Delete the list_items row -- ON DELETE CASCADE removes mirror_files rows.
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
		.prepare('SELECT id, mirror_path FROM mirror_files WHERE list_item_id = ?')
		.all(itemId) as Array<{ id: number; mirror_path: string }>;

	// Validate every mirror_path is under a configured Lidarr root folder before
	// touching the filesystem. This prevents a corrupted DB row from unlinking
	// arbitrary paths outside the expected tree.
	let allowedRoots: string[] = [];
	try {
		allowedRoots = (await rootFolders()).map((r) => path.resolve(r.path));
	} catch (err) {
		console.warn('[delete-item] Could not fetch Lidarr root folders for path validation:', err);
	}

	function isUnderAllowedRoot(filePath: string): boolean {
		if (allowedRoots.length === 0) return true; // Lidarr unreachable -- allow (best-effort)
		const abs = path.resolve(filePath);
		return allowedRoots.some((root) => abs.startsWith(root + path.sep) || abs === root);
	}

	const safeFiles = mirrorFiles.filter((f) => {
		if (isUnderAllowedRoot(f.mirror_path)) return true;
		console.warn(
			`[delete-item] Refusing to unlink path outside allowed roots: ${f.mirror_path}`
		);
		return false;
	});

	// Delete physical files best-effort -- don't abort if a file is already gone
	const fileResults = await Promise.allSettled(
		safeFiles.map((f) => fs.unlink(f.mirror_path))
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

	const skipped = mirrorFiles.length - safeFiles.length;

	// Delete the DB row -- CASCADE removes mirror_files rows
	db.prepare('DELETE FROM list_items WHERE id = ?').run(itemId);

	console.log(
		`[delete-item] removed list_item ${itemId} from list ${listId}, ` +
		`deleted ${safeFiles.length - fileErrors.length}/${mirrorFiles.length} mirror file(s)` +
		(skipped > 0 ? `, skipped ${skipped} path(s) outside allowed roots` : '')
	);

	return json({ deleted: true, itemId });
};
