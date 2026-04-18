import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { orchestrate } from '$lib/server/orchestrator';

/**
 * POST /api/lists/[id]/retry
 * Body (form-encoded): item_id=<list_items.id>
 *
 * Re-runs the orchestrator for a specific failed/broken list_item.
 * Returns immediately — UI polls /api/lists/[id]/status for result.
 */
export const POST: RequestHandler = async ({ request, params }) => {
	const listId = Number(params.id);
	const formData = await request.formData();
	const itemId = Number(formData.get('item_id'));

	if (isNaN(itemId) || itemId <= 0) {
		error(400, 'Missing or invalid item_id');
	}

	const item = getDb()
		.prepare('SELECT id FROM list_items WHERE id = ? AND list_id = ?')
		.get(itemId, listId) as { id: number } | undefined;

	if (!item) error(404, 'Item not found in this list');

	orchestrate(itemId).catch((err) => {
		console.error(`[retry] unhandled error for item ${itemId}:`, err);
	});

	return json({ queued: true, itemId });
};
