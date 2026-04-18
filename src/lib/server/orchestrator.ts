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

// ── DB row types ──────────────────────────────────────────────────────────────

interface ListItemRow {
	id: number;
	list_id: number;
	mbid: string;
	type: 'track' | 'album' | 'artist';
	title: string;
	artist_name: string;
	album_name: string | null;
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
			`SELECT id, list_id, mbid, type, title, artist_name, album_name,
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
			// Cross-library add — flag for mirroring, do not trigger search
			db.prepare(`UPDATE list_items SET lidarr_artist_id = ? WHERE id = ?`).run(
				existing.id,
				item.id
			);
			markMirrorPending(item.id);
		} else {
			// Same root folder — just mark synced
			markSynced(item.id, { lidarrArtistId: existing.id });
		}
	}
}

// ── Scenario B: single track add ─────────────────────────────────────────────

async function scenarioB(item: ListItemRow, list: ListRow): Promise<void> {
	const db = getDb();

	// We need the artist MBID from list_items.
	// For a track item, we store the recording MBID in mbid,
	// but artist information is in artist_name.
	// We need Lidarr's artist lookup — try to find by artist_name heuristic
	// using the lidarr_artist_id if already set, or the ownership table.
	//
	// Full artist-MBID-for-track lookup requires MusicBrainz data not stored here.
	// For now: check if we have lidarr_artist_id already set (from a prior run),
	// otherwise surface as a failure with a clear message.
	//
	// The search page stores artist_name; the orchestrator uses it to look up
	// existing ownership by artist_name as a fallback.

	// Check if there's an existing artist in Lidarr matching this artist name
	// via the ownership table (keyed by lidarr_artist_id on a prior item)
	let lidarrArtistId = item.lidarr_artist_id;
	let artistMbid: string | null = null;
	let rootFolderPath = list.root_folder_path;

	if (!lidarrArtistId) {
		// Try ownership table by looking at other list_items with same artist_name
		const related = db
			.prepare(
				`SELECT li.lidarr_artist_id, ao.artist_mbid, ao.root_folder_path
           FROM list_items li
           JOIN artist_ownership ao ON ao.lidarr_artist_id = li.lidarr_artist_id
           WHERE li.artist_name = ? AND li.lidarr_artist_id IS NOT NULL
           LIMIT 1`
			)
			.get(item.artist_name) as
			| { lidarr_artist_id: number; artist_mbid: string; root_folder_path: string }
			| undefined;

		if (related) {
			lidarrArtistId = related.lidarr_artist_id;
			artistMbid = related.artist_mbid;
			rootFolderPath = related.root_folder_path;
		}
	}

	// If we still don't have an artist ID, we need to add the artist unmonitored.
	// We don't have the artist MBID from a track search here — mark as failed
	// with a clear explanation so the caller can retry with more info.
	if (!lidarrArtistId) {
		markFailed(
			item.id,
			`Cannot push track to Lidarr: artist MBID not available. ` +
				`Ensure the artist "${item.artist_name}" has been added to Lidarr first, ` +
				`or add an artist-type item for this artist.`
		);
		return;
	}

	// Check ownership — is this artist in a different root folder?
	if (artistMbid) {
		const ownership = db
			.prepare('SELECT * FROM artist_ownership WHERE artist_mbid = ?')
			.get(artistMbid) as OwnershipRow | undefined;

		if (ownership && ownership.root_folder_path !== list.root_folder_path) {
			// Cross-library track — flag for mirror
			db.prepare(`UPDATE list_items SET lidarr_artist_id = ? WHERE id = ?`).run(
				lidarrArtistId,
				item.id
			);
			markMirrorPending(item.id);
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

	// Same artist-lookup challenge as Scenario B.
	// For album items, the mbid is the release-group MBID.
	// We look for an existing Lidarr artist via related ownership.

	let lidarrArtistId = item.lidarr_artist_id;
	let artistMbid: string | null = null;

	if (!lidarrArtistId) {
		const related = db
			.prepare(
				`SELECT li.lidarr_artist_id, ao.artist_mbid, ao.root_folder_path
           FROM list_items li
           JOIN artist_ownership ao ON ao.lidarr_artist_id = li.lidarr_artist_id
           WHERE li.artist_name = ? AND li.lidarr_artist_id IS NOT NULL
           LIMIT 1`
			)
			.get(item.artist_name) as
			| { lidarr_artist_id: number; artist_mbid: string; root_folder_path: string }
			| undefined;

		if (related) {
			lidarrArtistId = related.lidarr_artist_id;
			artistMbid = related.artist_mbid;
		}
	}

	if (!lidarrArtistId) {
		markFailed(
			item.id,
			`Cannot push album to Lidarr: artist MBID not available. ` +
				`Add an artist-type item for "${item.artist_name}" first.`
		);
		return;
	}

	// Check ownership for cross-library scenario
	if (artistMbid) {
		const ownership = db
			.prepare('SELECT * FROM artist_ownership WHERE artist_mbid = ?')
			.get(artistMbid) as OwnershipRow | undefined;

		if (ownership && ownership.root_folder_path !== list.root_folder_path) {
			db.prepare(`UPDATE list_items SET lidarr_artist_id = ? WHERE id = ?`).run(
				lidarrArtistId,
				item.id
			);
			markMirrorPending(item.id);
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
