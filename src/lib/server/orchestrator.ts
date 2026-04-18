/**
 * Push orchestrator.
 *
 * Implements Scenarios A, B, and C from REQUIREMENTS §4D.
 * All DB writes for a single run are wrapped in one transaction.
 *
 * Callers must pass the list_items.id of the item to push.
 * The orchestrator reads the item + list from the DB, determines the
 * correct scenario, and either pushes to Lidarr or flags the item for
 * the mirror workflow.
 */

import { getDb } from './db';
import {
	LidarrError,
	getArtistByMbid,
	addArtist,
	getAlbums,
	updateAlbum,
	getTracks,
	updateTrack,
	runCommand
} from './lidarr';
import { startBackfill } from './mirror';

// ── DB row types ──────────────────────────────────────────────────────────────

interface ListItemRow {
	id: number;
	list_id: number;
	mbid: string;
	type: 'track' | 'album' | 'artist';
	title: string;
	artist_name: string;
	album_name: string | null;
	/** MB artist MBID stored at add-time for track/album items. Used to auto-add artist to Lidarr. */
	artist_mbid: string | null;
	lidarr_artist_id: number | null;
	lidarr_album_id: number | null;
	lidarr_track_id: number | null;
	sync_status: string;
}

interface ListRow {
	id: number;
	name: string;
	root_folder_path: string;
}

interface OwnershipRow {
	id: number;
	artist_mbid: string;
	lidarr_artist_id: number;
	owner_list_id: number;
	root_folder_path: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Mark a list_item as failed with an error message.
 * Always runs outside any outer transaction so partial failures are recorded.
 */
function markFailed(itemId: number, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	getDb()
		.prepare(
			`UPDATE list_items SET sync_status = 'failed', sync_error = ? WHERE id = ?`
		)
		.run(message, itemId);
}

/**
 * Mark a list_item as mirror_pending (artist already owned by another list —
 * files will be copied when Lidarr downloads them via webhook).
 */
function markMirrorPending(itemId: number): void {
	getDb()
		.prepare(
			`UPDATE list_items SET sync_status = 'mirror_pending', sync_error = NULL WHERE id = ?`
		)
		.run(itemId);
}

/**
 * Mark a list_item as synced and record the Lidarr IDs.
 */
function markSynced(
	itemId: number,
	ids: { lidarrArtistId?: number; lidarrAlbumId?: number; lidarrTrackId?: number }
): void {
	getDb()
		.prepare(
			`UPDATE list_items
         SET sync_status = 'synced',
             sync_error = NULL,
             lidarr_artist_id = COALESCE(?, lidarr_artist_id),
             lidarr_album_id  = COALESCE(?, lidarr_album_id),
             lidarr_track_id  = COALESCE(?, lidarr_track_id)
       WHERE id = ?`
		)
		.run(
			ids.lidarrArtistId ?? null,
			ids.lidarrAlbumId ?? null,
			ids.lidarrTrackId ?? null,
			itemId
		);
}

/**
 * Write or update the artist_ownership record.
 */
function upsertOwnership(
	artistMbid: string,
	lidarrArtistId: number,
	ownerListId: number,
	rootFolderPath: string
): void {
	getDb()
		.prepare(
			`INSERT INTO artist_ownership (artist_mbid, lidarr_artist_id, owner_list_id, root_folder_path)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(artist_mbid) DO NOTHING`
		)
		.run(artistMbid, lidarrArtistId, ownerListId, rootFolderPath);
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the orchestration sequence for a single list_item.
 *
 * This function is async and may make multiple Lidarr API calls.
 * It catches all errors and writes them to the list_item record,
 * so it never throws to the caller.
 */
export async function orchestrate(listItemId: number): Promise<void> {
	const db = getDb();

	// Load the item and its parent list
	const item = db
		.prepare(
			`SELECT id, list_id, mbid, type, title, artist_name, album_name, artist_mbid,
              lidarr_artist_id, lidarr_album_id, lidarr_track_id, sync_status
         FROM list_items WHERE id = ?`
		)
		.get(listItemId) as ListItemRow | undefined;

	if (!item) {
		console.error(`[orchestrator] list_item ${listItemId} not found`);
		return;
	}

	const list = db
		.prepare('SELECT id, name, root_folder_path FROM lists WHERE id = ?')
		.get(item.list_id) as ListRow | undefined;

	if (!list) {
		markFailed(listItemId, 'Parent list not found — was it deleted?');
		return;
	}

	// Mark as pending while we work
	db.prepare(`UPDATE list_items SET sync_status = 'pending', sync_error = NULL WHERE id = ?`).run(
		listItemId
	);

	try {
		switch (item.type) {
			case 'artist':
				await scenarioA(item, list);
				break;
			case 'album':
				await scenarioC(item, list);
				break;
			case 'track':
				await scenarioB(item, list);
				break;
			default:
				markFailed(listItemId, `Unknown item type: ${item.type}`);
		}
	} catch (err) {
		markFailed(listItemId, err);
	}
}

// ── Scenario A: full artist add ───────────────────────────────────────────────

async function scenarioA(item: ListItemRow, list: ListRow): Promise<void> {
	const db = getDb();

	// Pre-flight: does Lidarr already know about this artist?
	const existing = await getArtistByMbid(item.mbid);

	if (!existing) {
		// Artist is new to Lidarr — add with monitor=all
		const lidarrArtist = await addArtist({
			foreignArtistId: item.mbid,
			artistName: item.artist_name,
			rootFolderPath: list.root_folder_path,
			monitored: true,
			addOptions: { monitor: 'all', searchForMissingAlbums: true }
		});

		upsertOwnership(item.mbid, lidarrArtist.id, list.id, list.root_folder_path);
		markSynced(item.id, { lidarrArtistId: lidarrArtist.id });

		// Trigger artist search
		await runCommand('ArtistSearch', { artistId: lidarrArtist.id });
	} else {
		// Artist already in Lidarr
		upsertOwnership(item.mbid, existing.id, list.id, existing.rootFolderPath);

		// Check if owned by a different list's root folder
		const ownership = db
			.prepare('SELECT * FROM artist_ownership WHERE artist_mbid = ?')
			.get(item.mbid) as OwnershipRow | undefined;

		if (ownership && ownership.root_folder_path !== list.root_folder_path) {
			// Cross-library add — record the Lidarr ID and start background backfill.
			// startBackfill sets status to mirror_active, copies existing files,
			// then transitions to synced (or mirror_pending if no files yet).
			db.prepare(`UPDATE list_items SET lidarr_artist_id = ? WHERE id = ?`).run(
				existing.id,
				item.id
			);
			markMirrorPending(item.id);
			startBackfill(existing.id, item.id, ownership.root_folder_path, list.root_folder_path).catch(
				(err) => console.error(`[orchestrator] backfill failed for item ${item.id}:`, err)
			);
		} else {
			// Same root folder — just mark synced
			markSynced(item.id, { lidarrArtistId: existing.id });
		}
	}
}

// ── Scenario B: single track add ─────────────────────────────────────────────

async function scenarioB(item: ListItemRow, list: ListRow): Promise<void> {
	const db = getDb();

	// Resolve the Lidarr artist for this track.
	// Resolution order:
	//   1. lidarr_artist_id already stored on this item (e.g. from a prior retry)
	//   2. artist_ownership table keyed by item.artist_mbid
	//   3. Sibling list_items with same artist_name that have been synced
	//   4. Auto-add via item.artist_mbid (monitor=none) — REQUIREMENTS §4D Scenario B

	let lidarrArtistId = item.lidarr_artist_id;
	let resolvedArtistMbid: string | null = item.artist_mbid;

	if (!lidarrArtistId) {
		// Check ownership table directly by artist MBID
		if (item.artist_mbid) {
			const ownership = db
				.prepare('SELECT * FROM artist_ownership WHERE artist_mbid = ?')
				.get(item.artist_mbid) as OwnershipRow | undefined;
			if (ownership) {
				lidarrArtistId = ownership.lidarr_artist_id;
			}
		}
	}

	if (!lidarrArtistId) {
		// Fallback: sibling list_items with the same artist_name that are synced
		const related = db
			.prepare(
				`SELECT li.lidarr_artist_id, ao.artist_mbid
           FROM list_items li
           JOIN artist_ownership ao ON ao.lidarr_artist_id = li.lidarr_artist_id
           WHERE li.artist_name = ? AND li.lidarr_artist_id IS NOT NULL
           LIMIT 1`
			)
			.get(item.artist_name) as
			| { lidarr_artist_id: number; artist_mbid: string }
			| undefined;
		if (related) {
			lidarrArtistId = related.lidarr_artist_id;
			resolvedArtistMbid = resolvedArtistMbid ?? related.artist_mbid;
		}
	}

	if (!lidarrArtistId) {
		// Auto-add artist with monitor=none so only this track gets monitored.
		// Requires artist_mbid stored at search time.
		if (!item.artist_mbid) {
			markFailed(
				item.id,
				`Cannot push track to Lidarr: artist MusicBrainz ID was not captured at search time. ` +
					`Remove and re-add this item from the search page to fix this.`
			);
			return;
		}

		// Check whether the artist already exists in Lidarr (e.g. added via another path)
		const existing = await getArtistByMbid(item.artist_mbid);
		if (existing) {
			lidarrArtistId = existing.id;
			upsertOwnership(item.artist_mbid, existing.id, list.id, existing.rootFolderPath);
		} else {
			// Add artist to Lidarr with all albums unmonitored — we'll monitor only this track below
			const lidarrArtist = await addArtist({
				foreignArtistId: item.artist_mbid,
				artistName: item.artist_name,
				rootFolderPath: list.root_folder_path,
				monitored: true,
				addOptions: { monitor: 'none', searchForMissingAlbums: false }
			});
			lidarrArtistId = lidarrArtist.id;
			upsertOwnership(item.artist_mbid, lidarrArtist.id, list.id, list.root_folder_path);
		}
	}

	// At this point lidarrArtistId is guaranteed non-null. Check cross-library.
	if (resolvedArtistMbid) {
		const ownership = db
			.prepare('SELECT * FROM artist_ownership WHERE artist_mbid = ?')
			.get(resolvedArtistMbid) as OwnershipRow | undefined;
		if (ownership && ownership.root_folder_path !== list.root_folder_path) {
			db.prepare(`UPDATE list_items SET lidarr_artist_id = ? WHERE id = ?`).run(
				lidarrArtistId,
				item.id
			);
			markMirrorPending(item.id);
			startBackfill(lidarrArtistId, item.id, ownership.root_folder_path, list.root_folder_path).catch(
				(err) => console.error(`[orchestrator] backfill failed for item ${item.id}:`, err)
			);
			return;
		}
	}

	// Find the track in Lidarr by its recording MBID
	const tracks = await getTracks(lidarrArtistId);
	const target = tracks.find((t) => t.foreignTrackId === item.mbid);

	if (!target) {
		markFailed(
			item.id,
			`Track MBID ${item.mbid} not found in Lidarr for artist ID ${lidarrArtistId}. ` +
				`Lidarr may not have synced metadata yet — retry in a few minutes.`
		);
		return;
	}

	// Monitor only this track
	await updateTrack({ ...target, monitored: true });

	// Trigger track search
	await runCommand('TrackSearch', { trackIds: [target.id] });

	markSynced(item.id, { lidarrArtistId, lidarrTrackId: target.id });
}

// ── Scenario C: full album add ────────────────────────────────────────────────

async function scenarioC(item: ListItemRow, list: ListRow): Promise<void> {
	const db = getDb();

	// Same artist-resolution logic as Scenario B.
	// item.mbid is the release-group MBID; item.artist_mbid is the artist MBID.

	let lidarrArtistId = item.lidarr_artist_id;
	let resolvedArtistMbid: string | null = item.artist_mbid;

	if (!lidarrArtistId) {
		// Check ownership table by artist MBID
		if (item.artist_mbid) {
			const ownership = db
				.prepare('SELECT * FROM artist_ownership WHERE artist_mbid = ?')
				.get(item.artist_mbid) as OwnershipRow | undefined;
			if (ownership) {
				lidarrArtistId = ownership.lidarr_artist_id;
			}
		}
	}

	if (!lidarrArtistId) {
		// Fallback: sibling list_items with same artist_name
		const related = db
			.prepare(
				`SELECT li.lidarr_artist_id, ao.artist_mbid
           FROM list_items li
           JOIN artist_ownership ao ON ao.lidarr_artist_id = li.lidarr_artist_id
           WHERE li.artist_name = ? AND li.lidarr_artist_id IS NOT NULL
           LIMIT 1`
			)
			.get(item.artist_name) as
			| { lidarr_artist_id: number; artist_mbid: string }
			| undefined;
		if (related) {
			lidarrArtistId = related.lidarr_artist_id;
			resolvedArtistMbid = resolvedArtistMbid ?? related.artist_mbid;
		}
	}

	if (!lidarrArtistId) {
		// Auto-add artist with monitor=none so only this album gets monitored.
		if (!item.artist_mbid) {
			markFailed(
				item.id,
				`Cannot push album to Lidarr: artist MusicBrainz ID was not captured at search time. ` +
					`Remove and re-add this item from the search page to fix this.`
			);
			return;
		}

		const existing = await getArtistByMbid(item.artist_mbid);
		if (existing) {
			lidarrArtistId = existing.id;
			upsertOwnership(item.artist_mbid, existing.id, list.id, existing.rootFolderPath);
		} else {
			const lidarrArtist = await addArtist({
				foreignArtistId: item.artist_mbid,
				artistName: item.artist_name,
				rootFolderPath: list.root_folder_path,
				monitored: true,
				addOptions: { monitor: 'none', searchForMissingAlbums: false }
			});
			lidarrArtistId = lidarrArtist.id;
			upsertOwnership(item.artist_mbid, lidarrArtist.id, list.id, list.root_folder_path);
		}
	}

	// Cross-library check
	if (resolvedArtistMbid) {
		const ownership = db
			.prepare('SELECT * FROM artist_ownership WHERE artist_mbid = ?')
			.get(resolvedArtistMbid) as OwnershipRow | undefined;
		if (ownership && ownership.root_folder_path !== list.root_folder_path) {
			db.prepare(`UPDATE list_items SET lidarr_artist_id = ? WHERE id = ?`).run(
				lidarrArtistId,
				item.id
			);
			markMirrorPending(item.id);
			startBackfill(lidarrArtistId, item.id, ownership.root_folder_path, list.root_folder_path).catch(
				(err) => console.error(`[orchestrator] backfill failed for item ${item.id}:`, err)
			);
			return;
		}
	}

	// Find the album in Lidarr by release-group MBID
	const albums = await getAlbums(lidarrArtistId);
	const target = albums.find((a) => a.foreignAlbumId === item.mbid);

	if (!target) {
		markFailed(
			item.id,
			`Album MBID ${item.mbid} not found in Lidarr for artist ID ${lidarrArtistId}. ` +
				`Lidarr may not have synced metadata yet — retry in a few minutes.`
		);
		return;
	}

	// Monitor this album
	await updateAlbum({ ...target, monitored: true });

	// Trigger album search
	await runCommand('AlbumSearch', { albumIds: [target.id] });

	markSynced(item.id, { lidarrArtistId, lidarrAlbumId: target.id });
}
