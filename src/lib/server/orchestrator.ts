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
	getArtist,
	getArtistByMbid,
	addArtist,
	updateArtist,
	getAlbum,
	getAlbums,
	updateAlbum,
	getTracks,
	runCommand,
	getQualityProfiles,
	getMetadataProfiles,
	rootFolders,
	getLidarrPrimaryRoot
} from './lidarr';
import { startBackfill, type MirrorScope } from './mirror';

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
	quality_profile_id: number | null;
	metadata_profile_id: number | null;
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
 * Normalize a track title for fuzzy comparison.
 * - Lowercases
 * - Strips Unicode accent marks (NFD decomposition)
 * - Strips all non-alphanumeric characters
 *
 * This lets titles like "Résumé (Live)", "AC/DC", and "What If?" match their
 * Lidarr counterparts despite punctuation and encoding differences.
 */
function normalizeTitle(s: string): string {
	return s
		.toLowerCase()
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '') // strip combining diacritics
		.replace(/[^a-z0-9]/g, '');       // strip punctuation, spaces, special chars
}

/**
 * Resolve a list_item to a Lidarr track, logging which strategy succeeded.
 *
 * Resolution is intentionally lossy: TuneFetch stores the MusicBrainz
 * **recording** MBID, while Lidarr's `foreignTrackId` is the MusicBrainz
 * **track-on-release** MBID — different identifiers for the same song —
 * so the foreignTrackId lookup almost always fails. The title fallback is
 * non-deterministic for songs that appear on multiple releases (e.g. a
 * track on both the original album and a compilation), and returns the
 * first match Lidarr's API listed.
 *
 * The returned track is only used to monitor + AlbumSearch the right unit
 * so Lidarr actually downloads something — mirror scope is now always the
 * whole artist (see _runBackfill). Logging here gives us visibility into
 * which strategy matched and how ambiguous the title fallback was.
 */
function resolveTrackForListItem(
	tracks: import('./lidarr').LidarrTrack[],
	item: { id: number; mbid: string; title: string }
): import('./lidarr').LidarrTrack | undefined {
	const byMbid = tracks.find((t) => t.foreignTrackId === item.mbid);
	if (byMbid) {
		console.log(
			`[orchestrator] item ${item.id}: matched track via foreignTrackId — ` +
			`Lidarr track ${byMbid.id} "${byMbid.title}" (album ${byMbid.albumId})`
		);
		return byMbid;
	}

	const titleMatches = tracks.filter(
		(t) => normalizeTitle(t.title) === normalizeTitle(item.title)
	);
	if (titleMatches.length === 0) return undefined;

	const chosen = titleMatches[0]!;
	if (titleMatches.length === 1) {
		console.log(
			`[orchestrator] item ${item.id} ("${item.title}"): matched track via title fallback — ` +
			`Lidarr track ${chosen.id} (album ${chosen.albumId})`
		);
	} else {
		const others = titleMatches
			.slice(1, 4)
			.map((t) => `${t.id} (album ${t.albumId})`)
			.join(', ');
		console.log(
			`[orchestrator] item ${item.id} ("${item.title}"): title fallback was AMBIGUOUS — ` +
			`${titleMatches.length} candidates, picked Lidarr track ${chosen.id} (album ${chosen.albumId}). ` +
			`Other candidates: ${others}${titleMatches.length > 4 ? ', ...' : ''}. ` +
			`Mirror still copies the full artist, but the chosen track is the one whose album gets AlbumSearched.`
		);
	}
	return chosen;
}

/**
 * Mark a list_item as failed with an error message.
 * Always runs outside any outer transaction so partial failures are recorded.
 */
function markFailed(itemId: number, error: unknown): void {
	let message = error instanceof Error ? error.message : String(error);
	// Append Lidarr's response body so the UI shows the actual API error, not just the status code.
	if (error instanceof LidarrError && error.body) {
		message += `\n${error.body}`;
	}
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



// ── Profile resolution ────────────────────────────────────────────────────────

/**
 * Resolve quality and metadata profile IDs for a list.
 * Uses the list's stored values if configured; falls back to the first
 * available Lidarr profile for pre-existing lists that predate this setting.
 */
async function resolveProfileIds(
	list: ListRow
): Promise<{ qualityProfileId: number; metadataProfileId: number }> {
	if (list.quality_profile_id && list.metadata_profile_id) {
		return {
			qualityProfileId: list.quality_profile_id,
			metadataProfileId: list.metadata_profile_id
		};
	}
	// Fallback: fetch first available profiles from Lidarr
	const [qualityProfiles, metadataProfiles] = await Promise.all([
		getQualityProfiles(),
		getMetadataProfiles()
	]);
	const qualityProfileId = list.quality_profile_id ?? qualityProfiles[0]?.id;
	const metadataProfileId = list.metadata_profile_id ?? metadataProfiles[0]?.id;
	if (!qualityProfileId) throw new Error('No quality profiles configured in Lidarr');
	if (!metadataProfileId) throw new Error('No metadata profiles configured in Lidarr');
	return { qualityProfileId, metadataProfileId };
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
		.prepare('SELECT id, name, root_folder_path, quality_profile_id, metadata_profile_id FROM lists WHERE id = ?')
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
	const primaryRoot = await getLidarrPrimaryRoot();

	// Pre-flight: does Lidarr already know about this artist?
	const existing = await getArtistByMbid(item.mbid);

	let lidarrArtistId: number;

	if (!existing) {
		// Artist is new to Lidarr — add with monitor=all
		const { qualityProfileId, metadataProfileId } = await resolveProfileIds(list);
		const lidarrArtist = await addArtist({
			foreignArtistId: item.mbid,
			artistName: item.artist_name,
			rootFolderPath: primaryRoot,
			qualityProfileId,
			metadataProfileId,
			monitored: true,
			addOptions: { monitor: 'all', searchForMissingAlbums: true }
		});
		lidarrArtistId = lidarrArtist.id;

		upsertOwnership(item.mbid, lidarrArtist.id, list.id, primaryRoot);

		// Trigger artist search
		await runCommand('ArtistSearch', { artistId: lidarrArtist.id });
	} else {
		// Artist already in Lidarr
		lidarrArtistId = existing.id;
		upsertOwnership(item.mbid, existing.id, list.id, existing.rootFolderPath);
	}

	if (list.root_folder_path !== primaryRoot) {
		// Cross-library add — record the Lidarr ID and start background backfill.
		db.prepare(`UPDATE list_items SET lidarr_artist_id = ? WHERE id = ?`).run(
			lidarrArtistId,
			item.id
		);
		markMirrorPending(item.id);
		const scope: MirrorScope = { type: 'artist' };
		startBackfill(lidarrArtistId, item.id, primaryRoot, list.root_folder_path, scope).catch(
			(err) => console.error(`[orchestrator] backfill failed for item ${item.id}:`, err)
		);
	} else {
		// Same root folder — just mark synced
		markSynced(item.id, { lidarrArtistId });
	}
}

// ── Scenario B: single track add ─────────────────────────────────────────────

async function scenarioB(item: ListItemRow, list: ListRow): Promise<void> {
	const db = getDb();
	const primaryRoot = await getLidarrPrimaryRoot();

	// Resolve the Lidarr artist for this track.
	let lidarrArtistId = item.lidarr_artist_id;

	if (!lidarrArtistId && item.artist_mbid) {
		const existing = await getArtistByMbid(item.artist_mbid);
		if (existing) {
			lidarrArtistId = existing.id;
		}
	}

	if (!lidarrArtistId) {
		// Auto-add artist with monitor=none so only this track gets monitored.
		if (!item.artist_mbid) {
			markFailed(
				item.id,
				`Cannot push track to Lidarr: artist MusicBrainz ID was not captured at search time. ` +
					`Remove and re-add this item from the search page to fix this.`
			);
			return;
		}

		const existing = await getArtistByMbid(item.artist_mbid);
		if (existing) {
			lidarrArtistId = existing.id;
			upsertOwnership(item.artist_mbid, existing.id, list.id, existing.rootFolderPath);
			if (!existing.monitored) {
				await updateArtist({ ...existing, monitored: true });
			}
		} else {
			const { qualityProfileId, metadataProfileId } = await resolveProfileIds(list);
			const lidarrArtist = await addArtist({
				foreignArtistId: item.artist_mbid,
				artistName: item.artist_name,
				rootFolderPath: primaryRoot,
				qualityProfileId,
				metadataProfileId,
				monitored: true,
				addOptions: { monitor: 'none', searchForMissingAlbums: false }
			});
			lidarrArtistId = lidarrArtist.id;
			upsertOwnership(item.artist_mbid, lidarrArtist.id, list.id, primaryRoot);
		}
	}

	// Find the track in Lidarr
	const tracks = await getTracks(lidarrArtistId);
	const target = resolveTrackForListItem(tracks, item);

	if (!target) {
		const sample = tracks.slice(0, 5).map((t) => `"${t.title}" [${t.foreignTrackId}]`).join(', ');
		const hint = tracks.length === 0
			? 'Lidarr returned 0 tracks — metadata may not have synced yet, retry in a few minutes.'
			: `Lidarr returned ${tracks.length} track(s) but none matched. Sample: [${sample}]`;
		markFailed(item.id, `Track "${item.title}" not found in Lidarr. ${hint}`);
		return;
	}

	// Monitor parent album
	const album = await getAlbum(target.albumId);
	if (!album.monitored) {
		await updateAlbum({ ...album, monitored: true });
	}

	// Trigger album search
	await runCommand('AlbumSearch', { albumIds: [target.albumId] });

	// Cross-library check
	if (list.root_folder_path !== primaryRoot) {
		db.prepare(
			`UPDATE list_items SET lidarr_artist_id = ?, lidarr_album_id = ?, lidarr_track_id = ? WHERE id = ?`
		).run(lidarrArtistId, target.albumId, target.id, item.id);

		markMirrorPending(item.id);
		const scope: MirrorScope = { type: 'track', lidarrAlbumId: target.albumId, lidarrTrackId: target.id };
		startBackfill(lidarrArtistId, item.id, primaryRoot, list.root_folder_path, scope).catch(
			(err) => console.error(`[orchestrator] backfill failed for item ${item.id}:`, err)
		);
		return;
	}

	markSynced(item.id, { lidarrArtistId, lidarrAlbumId: target.albumId, lidarrTrackId: target.id });
}

// ── Scenario C: full album add ────────────────────────────────────────────────

async function scenarioC(item: ListItemRow, list: ListRow): Promise<void> {
	const db = getDb();
	const primaryRoot = await getLidarrPrimaryRoot();

	let lidarrArtistId = item.lidarr_artist_id;

	if (!lidarrArtistId && item.artist_mbid) {
		const existing = await getArtistByMbid(item.artist_mbid);
		if (existing) {
			lidarrArtistId = existing.id;
		}
	}

	if (!lidarrArtistId) {
		// Auto-add artist
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
			if (!existing.monitored) {
				await updateArtist({ ...existing, monitored: true });
			}
		} else {
			const { qualityProfileId, metadataProfileId } = await resolveProfileIds(list);
			const lidarrArtist = await addArtist({
				foreignArtistId: item.artist_mbid,
				artistName: item.artist_name,
				rootFolderPath: primaryRoot,
				qualityProfileId,
				metadataProfileId,
				monitored: true,
				addOptions: { monitor: 'none', searchForMissingAlbums: false }
			});
			lidarrArtistId = lidarrArtist.id;
			upsertOwnership(item.artist_mbid, lidarrArtist.id, list.id, primaryRoot);
		}
	}

	// Find the album
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

	// Cross-library check
	if (list.root_folder_path !== primaryRoot) {
		db.prepare(
			`UPDATE list_items SET lidarr_artist_id = ?, lidarr_album_id = ? WHERE id = ?`
		).run(lidarrArtistId, target.id, item.id);

		markMirrorPending(item.id);
		const scope: MirrorScope = { type: 'album', lidarrAlbumId: target.id };
		startBackfill(lidarrArtistId, item.id, primaryRoot, list.root_folder_path, scope).catch(
			(err) => console.error(`[orchestrator] backfill failed for item ${item.id}:`, err)
		);
		return;
	}

	markSynced(item.id, { lidarrArtistId, lidarrAlbumId: target.id });
}
