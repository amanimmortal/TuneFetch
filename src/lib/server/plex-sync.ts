/**
 * Plex playlist sync engine.
 *
 * Core function: syncListToPlexPlaylist(plexPlaylistId)
 *
 * Steps:
 * 1. Load all synced list items for the linked list
 * 2. For each item not yet in plex_playlist_items: search Plex by artist + title
 * 3. Add found items to the Plex playlist; record in plex_playlist_items
 * 4. Log unmatched items for manual retry
 * 5. If playlist doesn't exist yet: create it first, then add items
 *
 * Retry/backoff for the scan timing problem is handled by enqueuePlexSync()
 * which can be called from the webhook handler.
 */

import { getDb } from './db';
import {
	searchTrack,
	createPlaylist,
	addToPlaylist,
	getPlaylistItems,
	PlexError
} from './plex';
import { decrypt, isEncrypted } from './crypto';

/** Decrypt a Plex token that may be stored encrypted or as legacy plaintext. */
function resolveToken(stored: string): string {
	return isEncrypted(stored) ? decrypt(stored) : stored;
}

// ── DB row types ──────────────────────────────────────────────────────────────

interface PlexPlaylistRow {
	id: number;
	list_id: number;
	plex_user_token: string;
	plex_user_name: string;
	plex_playlist_id: string | null;
	playlist_title: string;
	last_synced_at: string | null;
}

interface ListItemRow {
	id: number;
	mbid: string;
	type: string;
	title: string;
	artist_name: string;
	album_name: string | null;
	sync_status: string;
}

interface PlexPlaylistItemRow {
	id: number;
	plex_playlist_id_fk: number;
	list_item_id: number;
	plex_rating_key: string;
}

// ── Sync result ───────────────────────────────────────────────────────────────

export interface SyncResult {
	added: number;
	alreadySynced: number;
	notFound: number;
	errors: number;
	/** Items that couldn't be found in Plex (artist + title). */
	unmatched: Array<{ listItemId: number; artistName: string; title: string }>;
}

// ── Core sync function ────────────────────────────────────────────────────────

/**
 * Sync a TuneFetch list to its linked Plex playlist.
 *
 * @param plexPlaylistDbId - The id from the plex_playlists table (not the Plex ratingKey).
 */
export async function syncListToPlexPlaylist(
	plexPlaylistDbId: number
): Promise<SyncResult> {
	const db = getDb();

	const row = db
		.prepare(`
			SELECT pp.*, l.root_folder_path AS list_root_folder_path
			FROM plex_playlists pp
			JOIN lists l ON l.id = pp.list_id
			WHERE pp.id = ?
		`)
		.get(plexPlaylistDbId) as (PlexPlaylistRow & { list_root_folder_path: string }) | undefined;

	if (!row) {
		throw new Error(`plex_playlists row ${plexPlaylistDbId} not found`);
	}

	// Decrypt the stored token -- it may be plaintext (legacy) or encrypted.
	const plexToken = resolveToken(row.plex_user_token);

	// Look up the library_section_id via root_folder_path (unique key on plex_user_mappings),
	// not plex_user_name which is not unique and could return the wrong mapping row.
	const userMapping = db
		.prepare('SELECT library_section_id FROM plex_user_mappings WHERE root_folder_path = ?')
		.get(row.list_root_folder_path) as { library_section_id: string } | undefined;

	const librarySectionId = userMapping?.library_section_id ?? '';
	if (!librarySectionId) {
		console.warn(
			`[plex-sync] No library_section_id configured for user "${row.plex_user_name}" — ` +
			`update the Plex user mapping in Settings.`
		);
	}

	// Load all synced list items for this list
	const items = db
		.prepare(
			`SELECT id, mbid, type, title, artist_name, album_name, sync_status
       FROM list_items
       WHERE list_id = ?
         AND sync_status IN ('synced', 'mirror_pending', 'mirror_active')
       ORDER BY created_at ASC`
		)
		.all(row.list_id) as ListItemRow[];

	// Load already-synced plex_playlist_items for this playlist
	const alreadySynced = new Set(
		(
			db
				.prepare(
					'SELECT list_item_id FROM plex_playlist_items WHERE plex_playlist_id_fk = ?'
				)
				.all(row.id) as Array<{ list_item_id: number }>
		).map((r) => r.list_item_id)
	);

	const result: SyncResult = {
		added: 0,
		alreadySynced: alreadySynced.size,
		notFound: 0,
		errors: 0,
		unmatched: []
	};

	// Find new items to sync
	const newItems = items.filter((item) => !alreadySynced.has(item.id));

	if (newItems.length === 0 && row.plex_playlist_id) {
		// Nothing to do -- update last_synced_at
		db.prepare('UPDATE plex_playlists SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?')
			.run(row.id);
		return result;
	}

	// Search Plex for each new item
	const foundItems: Array<{
		listItemId: number;
		ratingKey: string;
	}> = [];

	for (const item of newItems) {
		// Only sync track-type items or items where we have artist+title
		// Album and artist types don't have individual tracks to add
		if (item.type === 'artist') {
			// Skip artist-type items -- playlists contain tracks, not artists
			continue;
		}

		try {
			const track = await searchTrack(item.artist_name, item.title, librarySectionId, plexToken);
			if (track) {
				foundItems.push({
					listItemId: item.id,
					ratingKey: track.ratingKey
				});
			} else {
				result.notFound++;
				result.unmatched.push({
					listItemId: item.id,
					artistName: item.artist_name,
					title: item.title
				});
			}
		} catch (err) {
			console.error(
				`[plex-sync] Error searching Plex for "${item.artist_name} - ${item.title}":`,
				err
			);
			result.errors++;
		}
	}

	if (foundItems.length === 0 && !row.plex_playlist_id) {
		// No items found and no playlist exists yet -- nothing to create
		db.prepare('UPDATE plex_playlists SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?')
			.run(row.id);
		return result;
	}

	// Create playlist if it doesn't exist yet
	let playlistId = row.plex_playlist_id;

	if (!playlistId && foundItems.length > 0) {
		try {
			playlistId = await createPlaylist(
				plexToken,
				row.playlist_title,
				foundItems.map((f) => f.ratingKey)
			);
			db.prepare('UPDATE plex_playlists SET plex_playlist_id = ? WHERE id = ?')
				.run(playlistId, row.id);

			// Record all items as synced
			const insertStmt = db.prepare(
				`INSERT OR IGNORE INTO plex_playlist_items
				   (plex_playlist_id_fk, list_item_id, plex_rating_key)
				 VALUES (?, ?, ?)`
			);
			for (const item of foundItems) {
				insertStmt.run(row.id, item.listItemId, item.ratingKey);
				result.added++;
			}

			db.prepare('UPDATE plex_playlists SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?')
				.run(row.id);
			return result;
		} catch (err) {
			console.error('[plex-sync] Failed to create playlist:', err);
			result.errors++;
			return result;
		}
	}

	// Add new items to existing playlist
	if (playlistId && foundItems.length > 0) {
		try {
			await addToPlaylist(
				plexToken,
				playlistId,
				foundItems.map((f) => f.ratingKey)
			);

			const insertStmt = db.prepare(
				`INSERT OR IGNORE INTO plex_playlist_items
				   (plex_playlist_id_fk, list_item_id, plex_rating_key)
				 VALUES (?, ?, ?)`
			);
			for (const item of foundItems) {
				insertStmt.run(row.id, item.listItemId, item.ratingKey);
				result.added++;
			}
		} catch (err) {
			console.error('[plex-sync] Failed to add items to playlist:', err);
			result.errors++;
		}
	}

	db.prepare('UPDATE plex_playlists SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?')
		.run(row.id);

	return result;
}

// ── Retry queue for scan timing ───────────────────────────────────────────────

/** Active retry timers, keyed by plex_playlists.id. */
const _retryTimers = new Map<number, ReturnType<typeof setTimeout>>();

/** Maximum number of retry attempts before giving up. */
const MAX_RETRIES = 5;

/** Backoff schedule in milliseconds: 30s -> 2min -> 5min -> 15min -> 30min. */
const BACKOFF_MS = [30_000, 120_000, 300_000, 900_000, 1_800_000];

/**
 * Enqueue a delayed Plex sync attempt for a playlist.
 *
 * Called from the webhook handler after a Lidarr download event.
 * If there's already a pending retry for this playlist, it is NOT replaced
 * (to avoid resetting the backoff).
 */
export function enqueuePlexSync(plexPlaylistDbId: number): void {
	if (_retryTimers.has(plexPlaylistDbId)) {
		console.log(
			`[plex-sync] Retry already queued for plex_playlist ${plexPlaylistDbId}, skipping`
		);
		return;
	}

	_retryWithBackoff(plexPlaylistDbId, 0);
}

function _retryWithBackoff(plexPlaylistDbId: number, attempt: number): void {
	const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
	console.log(
		`[plex-sync] Scheduling sync for plex_playlist ${plexPlaylistDbId} ` +
			`in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`
	);

	const timer = setTimeout(async () => {
		_retryTimers.delete(plexPlaylistDbId);
		try {
			const result = await syncListToPlexPlaylist(plexPlaylistDbId);

			if (result.notFound > 0 && attempt + 1 < MAX_RETRIES) {
				// Some tracks still not found -- retry with backoff
				console.log(
					`[plex-sync] ${result.notFound} track(s) not found in Plex for playlist ${plexPlaylistDbId}, retrying...`
				);
				_retryWithBackoff(plexPlaylistDbId, attempt + 1);
			} else {
				console.log(
					`[plex-sync] Sync complete for playlist ${plexPlaylistDbId}: ` +
						`added=${result.added}, notFound=${result.notFound}, errors=${result.errors}`
				);
			}
		} catch (err) {
			console.error(`[plex-sync] Sync failed for playlist ${plexPlaylistDbId}:`, err);
			if (attempt + 1 < MAX_RETRIES) {
				_retryWithBackoff(plexPlaylistDbId, attempt + 1);
			}
		}
	}, delay);

	_retryTimers.set(plexPlaylistDbId, timer);
}

/**
 * Cancel all pending retry timers (for graceful shutdown).
 */
export function cancelAllRetries(): void {
	for (const timer of _retryTimers.values()) {
		clearTimeout(timer);
	}
	_retryTimers.clear();
}

// ── Trigger sync for affected playlists ───────────────────────────────────────

/**
 * Find all plex_playlists rows that contain items for the given Lidarr artist,
 * and enqueue delayed syncs for them.
 *
 * Called from the webhook handler after a download event + library refresh.
 */
export function triggerSyncForArtist(lidarrArtistId: number): void {
	const db = getDb();

	const playlists = db
		.prepare(
			`SELECT DISTINCT pp.id
       FROM plex_playlists pp
       JOIN list_items li ON li.list_id = pp.list_id
       WHERE li.lidarr_artist_id = ?
         AND li.sync_status IN ('synced', 'mirror_pending', 'mirror_active')`
		)
		.all(lidarrArtistId) as Array<{ id: number }>;

	for (const { id } of playlists) {
		enqueuePlexSync(id);
	}
}

/**
 * Return the distinct library_section_ids for all Plex users who have playlists
 * that include tracks for the given Lidarr artist.
 *
 * Used by the webhook handler to refresh each relevant library section.
 */
export function getSectionIdsForArtist(lidarrArtistId: number): string[] {
	const db = getDb();

	const rows = db
		.prepare(
			`SELECT DISTINCT m.library_section_id
       FROM plex_playlists pp
       JOIN list_items li ON li.list_id = pp.list_id
       JOIN lists l ON l.id = pp.list_id
       JOIN plex_user_mappings m ON m.root_folder_path = l.root_folder_path
       WHERE li.lidarr_artist_id = ?
         AND li.sync_status IN ('synced', 'mirror_pending', 'mirror_active')
         AND m.library_section_id != ''`
		)
		.all(lidarrArtistId) as Array<{ library_section_id: string }>;

	return rows.map((r) => r.library_section_id);
}
