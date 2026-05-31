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
	searchTrackDiagnostic,
	searchAlbumDiagnostic,
	getAlbumTracks,
	createPlaylist,
	addToPlaylist,
	getPlaylistItems,
	getUserAccessToken,
	refreshLibrarySection
} from './plex';
import { decrypt, isEncrypted } from './crypto';
import type { MaSyncResult } from './ma-sync';

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

interface PlexUserMappingRow {
	plex_user_id: number | null;
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
	/**
	 * Music Assistant sync result. `null` when MA isn't configured (the
	 * integration stays opt-in) or when MA sync threw a hard error that we
	 * swallowed to keep MA failures non-fatal to Plex.
	 */
	maResult: MaSyncResult | null;
}

// ── Core sync function ────────────────────────────────────────────────────────

/**
 * Sync a TuneFetch list to its linked Plex playlist, then push the same
 * playlist into Music Assistant if configured.
 *
 * The MA push is wrapped here (not at the API route) so the retry path in
 * _retryWithBackoff also picks it up — every code path that mutates a Plex
 * playlist also keeps MA in sync via one wiring point.
 *
 * @param plexPlaylistDbId - The id from the plex_playlists table (not the Plex ratingKey).
 */
export async function syncListToPlexPlaylist(
	plexPlaylistDbId: number
): Promise<SyncResult> {
	const plexResult = await runPlexSync(plexPlaylistDbId);

	let maResult: MaSyncResult | null = null;
	try {
		const { syncPlaylistToMusicAssistant } = await import('./ma-sync');
		const ma = await syncPlaylistToMusicAssistant(plexPlaylistDbId);
		// Caller treats `null` as "feature off" — surface skipped state that way.
		maResult = ma.skipped ? null : ma;
	} catch (err) {
		console.error('[plex-sync] MA sync error (non-fatal):', err);
	}

	return { ...plexResult, maResult };
}

async function runPlexSync(
	plexPlaylistDbId: number
): Promise<Omit<SyncResult, 'maResult'>> {
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

	// Stored token is a fallback for legacy mappings that have no plex_user_id.
	const storedToken = resolveToken(row.plex_user_token);

	// Look up the library_section_id and plex_user_id for *this specific
	// playlist's user* — multiple plex_user_mappings rows can now share a
	// root_folder_path (e.g. several kids on the same kids tree), so we must
	// disambiguate by plex_user_name.
	const userMapping = db
		.prepare(
			`SELECT library_section_id, plex_user_id
			   FROM plex_user_mappings
			  WHERE root_folder_path = ? AND plex_user_name = ?`
		)
		.get(row.list_root_folder_path, row.plex_user_name) as
		(PlexUserMappingRow & { library_section_id: string }) | undefined;

	// Resolve the per-server access token via plex.tv shared_servers (or admin
	// token if the mapped user is the server owner). This is the canonical
	// per-user, per-server token path — see PLEX_REVIEW.md §10 and the
	// python-plexapi MyPlexUser.get_token reference.
	let plexToken = storedToken;
	if (userMapping?.plex_user_id) {
		const fresh = await getUserAccessToken(userMapping.plex_user_id);
		if (fresh) {
			plexToken = fresh;
		} else {
			console.warn(
				`[plex-sync] Could not resolve access token for user ID ${userMapping.plex_user_id} ` +
				`(no library shared, or plex.tv error). Falling back to stored token.`
			);
		}
	} else {
		console.warn(
			`[plex-sync] No plex_user_id stored for this mapping — falling back to stored token. ` +
			`Re-save the mapping in Settings to enable shared_servers token lookup.`
		);
	}

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

	// Load locally-tracked synced items for this playlist.
	const trackedRows = db
		.prepare(
			`SELECT ppi.id, ppi.list_item_id, ppi.plex_rating_key, li.type AS list_item_type
			   FROM plex_playlist_items ppi
			   JOIN list_items li ON li.id = ppi.list_item_id
			  WHERE ppi.plex_playlist_id_fk = ?`
		)
		.all(row.id) as Array<{
			id: number;
			list_item_id: number;
			plex_rating_key: string;
			list_item_type: 'track' | 'album' | 'artist';
		}>;

	// Reconcile against the Plex playlist's actual contents. If a user has
	// removed a track in Plex (or Plex re-scanned the library and changed the
	// ratingKey), the local row claims "synced" but Plex doesn't have it.
	// Drop those stale rows so the item below gets re-added.
	let prunedStale = 0;
	if (row.plex_playlist_id) {
		// Keep the try/catch tight around the Plex API call so a DB delete
		// error below isn't misreported as a Plex reconciliation failure.
		// Reconciliation failures are non-fatal: we fall back to the local
		// view and keep the sync moving. DB errors below are exceptional
		// (schema is stable, no constraints on this DELETE) and are allowed
		// to bubble up to the caller.
		let livePlexItems: Awaited<ReturnType<typeof getPlaylistItems>> | null = null;
		try {
			livePlexItems = await getPlaylistItems(plexToken, row.plex_playlist_id);
		} catch (err) {
			console.warn(
				`[plex-sync] Could not fetch playlist ${row.plex_playlist_id} from Plex ` +
				`(continuing with local state):`,
				err
			);
		}

		if (livePlexItems !== null) {
			const liveRatingKeys = new Set(livePlexItems.map((i) => String(i.ratingKey)));
			const deleteStmt = db.prepare('DELETE FROM plex_playlist_items WHERE id = ?');
			for (const tracked of trackedRows) {
				if (tracked.list_item_type === 'track') {
					if (!liveRatingKeys.has(String(tracked.plex_rating_key))) {
						deleteStmt.run(tracked.id);
						prunedStale++;
						console.log(
							`[plex-sync] Pruned stale plex_playlist_items row ${tracked.id} ` +
							`(list_item ${tracked.list_item_id}, ratingKey ${tracked.plex_rating_key} ` +
							`no longer in Plex playlist ${row.plex_playlist_id})`
						);
					}
				} else if (tracked.list_item_type === 'album') {
					try {
						const albumTracks = await getAlbumTracks(plexToken, tracked.plex_rating_key);
						const albumTrackKeys = albumTracks.map((t) => String(t.ratingKey));
						// If NONE of the album's tracks are in the Plex playlist, consider the album removed.
						const hasAnyTrack = albumTrackKeys.some((key) => liveRatingKeys.has(key));
						if (!hasAnyTrack) {
							deleteStmt.run(tracked.id);
							prunedStale++;
							console.log(
								`[plex-sync] Pruned stale plex_playlist_items row ${tracked.id} ` +
								`(album list_item ${tracked.list_item_id}, ratingKey ${tracked.plex_rating_key} ` +
								`has no remaining tracks in Plex playlist ${row.plex_playlist_id})`
							);
						}
					} catch (err) {
						console.warn(
							`[plex-sync] Could not check album tracks for ratingKey ${tracked.plex_rating_key} (non-fatal):`,
							err
						);
					}
				}
			}
		}
	}

	// Re-read after potential pruning so alreadySynced reflects ground truth.
	const alreadySynced = new Set(
		(
			db
				.prepare(
					'SELECT list_item_id FROM plex_playlist_items WHERE plex_playlist_id_fk = ?'
				)
				.all(row.id) as Array<{ list_item_id: number }>
		).map((r) => r.list_item_id)
	);

	const result: Omit<SyncResult, 'maResult'> = {
		added: 0,
		alreadySynced: alreadySynced.size,
		notFound: 0,
		errors: 0,
		unmatched: []
	};

	if (prunedStale > 0) {
		console.log(
			`[plex-sync] Reconcile dropped ${prunedStale} stale row(s); ` +
			`${alreadySynced.size} item(s) still confirmed in Plex playlist ${row.plex_playlist_id}`
		);
	}

	// Find new items to sync (anything not currently confirmed in Plex)
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
		if (item.type === 'artist') {
			// Skip artist-type items -- playlists contain tracks, not artists
			continue;
		}

		try {
			let ratingKey: string | null = null;
			let matchNote = '';

			if (item.type === 'album') {
				const search = await searchAlbumDiagnostic(
					item.artist_name,
					item.title,
					librarySectionId
				);
				if (search.album) {
					ratingKey = search.album.ratingKey;
					if (search.matchedBy && search.matchedBy !== 'exact') {
						matchNote = `Matched album "${item.artist_name} - ${item.title}" via ${search.matchedBy} (Plex: "${search.album.parentTitle ?? '?'} - ${search.album.title}")`;
					}
				} else {
					const detail =
						search.rawCount === 0
							? `no Plex search results for album`
							: search.topCandidate
							? `album search had hits; top candidate "${search.topCandidate.artist} - ${search.topCandidate.title}" did not match expected artist/title`
							: `album search had hits but no usable candidate metadata`;
					console.log(
						`[plex-sync] No Plex match for album list_item ${item.id} ` +
						`"${item.artist_name} - ${item.title}" (sectionId=${librarySectionId}): ${detail}`
					);
					result.notFound++;
					result.unmatched.push({
						listItemId: item.id,
						artistName: item.artist_name,
						title: item.title
					});
				}
			} else {
				// Track type
				const search = await searchTrackDiagnostic(
					item.artist_name,
					item.title,
					librarySectionId,
					undefined,
					item.album_name
				);
				if (search.track) {
					ratingKey = search.track.ratingKey;
					if (search.matchedBy && search.matchedBy !== 'exact') {
						matchNote = `Matched track "${item.artist_name} - ${item.title}" via ${search.matchedBy} (Plex: "${search.track.grandparentTitle ?? '?'} - ${search.track.title}" on album "${search.track.parentTitle ?? '?'}")`;
					}
				} else {
					const queryNote = search.queryUsed && search.queryUsed !== item.title ? ` (last query="${search.queryUsed}")` : '';
					const detail =
						search.rawCount === 0
							? `no Plex search results across normalization variants${queryNote} — title may be indexed differently or library not yet scanned`
							: search.topCandidate
							? `${search.rawCount} title-search hit(s)${queryNote}; top candidate "${search.topCandidate.artist} - ${search.topCandidate.title}" did not match expected artist/title/album`
							: `${search.rawCount} title-search hit(s)${queryNote} but no usable candidate metadata`;
					console.log(
						`[plex-sync] No Plex match for track list_item ${item.id} ` +
						`"${item.artist_name} - ${item.title}" (album="${item.album_name ?? ''}", sectionId=${librarySectionId}): ${detail}`
					);
					result.notFound++;
					result.unmatched.push({
						listItemId: item.id,
						artistName: item.artist_name,
						title: item.title
					});
				}
			}

			if (ratingKey) {
				if (matchNote) {
					console.log(
						`[plex-sync] ${matchNote}, ratingKey ${ratingKey}${
							item.type === 'album' ? ' (all tracks will be added by Plex)' : ''
						}`
					);
				}
				foundItems.push({
					listItemId: item.id,
					ratingKey
				});
			}
		} catch (err) {
			console.error(
				`[plex-sync] Error searching Plex for list_item ${item.id} ` +
				`"${item.artist_name} - ${item.title}":`,
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
 * After any TuneFetch action that adds, replaces, or moves files in a
 * mirror destination, tell Plex to rescan the relevant library and queue a
 * delayed sync of any playlists that reference this artist.
 *
 * This is the single canonical entry point — call it from every code path
 * that touches files (webhook, backfill, refresh-stale, verify discover-new,
 * etc.) so Plex always sees fresh content and our playlist syncs find it.
 *
 * Properties:
 *   - Fire-and-forget. Never blocks the caller.
 *   - Silent no-op when no Plex playlists reference this artist (the
 *     section query returns []).
 *   - Internal dedup via _retryTimers: repeated calls for the same
 *     artist within one backoff window do not stack timers.
 */
export function triggerPlexRefreshAndSync(lidarrArtistId: number, source = 'mirror'): void {
	const sectionIds = getSectionIdsForArtist(lidarrArtistId);
	if (sectionIds.length === 0) return; // No Plex playlists configured for this artist

	// Fire-and-forget: refresh each relevant library section so Plex
	// re-indexes the files we just placed there.
	for (const sectionId of sectionIds) {
		refreshLibrarySection(sectionId)
			.then(() => {
				console.log(`[${source}] Plex library refresh triggered for section ${sectionId} (artist ${lidarrArtistId})`);
			})
			.catch((err) => {
				console.warn(`[${source}] Plex library refresh failed for section ${sectionId} (artist ${lidarrArtistId}):`, err);
			});
	}

	// Queue delayed sync attempts for any playlists that reference this artist.
	// The retry backoff handles the gap between Plex refresh and file indexing.
	triggerSyncForArtist(lidarrArtistId);
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
