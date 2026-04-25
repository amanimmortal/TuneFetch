import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { orchestrate } from '$lib/server/orchestrator';

/**
 * POST /api/lists/[id]/retry
 * Body (JSON): { "item_id": <list_items.id> }
 *
 * Re-runs the orchestrator for a specific failed/broken list_item.
 * Returns immediately -- orchestration runs in the background.
 */
export const POST: RequestHandler = async ({ request, params }) => {
	const listId = Number(params.id);
	const body = await request.json();
	const itemId = Number(body?.item_id);

	if (isNaN(itemId) || itemId <= 0) {
		error(400, 'Missing or invalid item_id');
	}

	const item = getDb()
		.prepare('SELECT id FROM list_items WHERE id = ? AND list_id = ?')
		.get(itemId, listId) as { id: number } | undefined;

	if (!item) error(404, 'Item not found in this list');

	queueMicrotask(() => {
		orchestrate(itemId).catch((err) => {
			console.error(`[retry] unhandled error for item ${itemId}:`, err);
			// Update sync_status so the UI reflects the failure rather than
			// staying stuck in whatever state it was in before the retry.
			try {
				getDb()
					.prepare(
						`UPDATE list_items SET sync_status = 'failed', sync_error = ?
						   WHERE id = ?`
					)
					.run(String(err?.message ?? err), itemId);
			} catch (dbErr) {
				console.error(`[retry] Could not mark item ${itemId} as failed:`, dbErr);
			}
		});
	});

	return json({ queued: true, itemId });
};
