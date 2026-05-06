/**
 * Music Assistant playlist sync engine.
 *
 * Called from syncListToPlexPlaylist() after the Plex sync completes. For each
 * plex_playlists row, creates or updates a matching playlist in MA using the
 * tracks confirmed present in Plex (and therefore in MA's index).
 *
 * Design notes:
 * - Uses the persisted ma_playlist_item_id column so subsequent syncs skip
 *   name-based lookup (survives renames in MA's UI, no duplicate-name risk).
 * - Always diffs against existing playlist tracks before adding, so the result
 *   is correct whether or not MA's add_playlist_tracks is idempotent.
 * - Searches MA with bounded concurrency to avoid N sequential round-trips
 *   for large playlists.
 * - Failures on individual operations are logged and counted but don't abort
 *   the rest of the sync.
 */

import { getDb } from './db';
import {
	searchTrack,
	findPlaylistByName,
	createPlaylist,
	getPlaylist,
	getPlaylistTrackUris,
	addTracksToPlaylist,
	MusicAssistantError
} from './music-assistant';
import { isMusicAssistantConfigured } from './settings';

const SEARCH_CONCURRENCY = 8;

export interface MaSyncResult {
	playlistName: string;
	/** New tracks pushed to MA on this run. */
	added: number;
	/** Tracks already in the MA playlist (skipped via diff). */
	alreadyInMa: number;
	/** Tracks not found in MA's library. */
	notFound: number;
	/** Per-track or per-call errors (non-fatal). */
	errors: number;
	/** True if MA isn't configured — caller should treat as "feature disabled". */
	skipped: boolean;
}

export async function syncPlaylistToMusicAssistant(
	plexPlaylistDbId: number
): Promise<MaSyncResult> {
	const db = getDb();
	const empty: MaSyncResult = {
		playlistName: '',
		added: 0,
		alreadyInMa: 0,
		notFound: 0,
		errors: 0,
		skipped: false
	};

	if (!isMusicAssistantConfigured()) {
		return { ...empty, skipped: true };
	}

	const ppRow = db
		.prepare(
			`SELECT id, list_id, playlist_title, ma_playlist_item_id, ma_playlist_provider
			   FROM plex_playlists WHERE id = ?`
		)
		.get(plexPlaylistDbId) as
		| {
				id: number;
				list_id: number;
				playlist_title: string;
				ma_playlist_item_id: string | null;
				ma_playlist_provider: string | null;
		  }
		| undefined;
	if (!ppRow) throw new Error(`plex_playlists row ${plexPlaylistDbId} not found`);

	const result: MaSyncResult = { ...empty, playlistName: ppRow.playlist_title };

	// Tracks confirmed present in Plex — same set we'd want in MA.
	const tracks = db
		.prepare(
			`SELECT DISTINCT li.id, li.title, li.artist_name
			   FROM list_items li
			   JOIN plex_playlist_items ppi ON ppi.list_item_id = li.id
			  WHERE ppi.plex_playlist_id_fk = ?
			    AND li.type = 'track'`
		)
		.all(plexPlaylistDbId) as Array<{ id: number; title: string; artist_name: string }>;

	if (tracks.length === 0) return result;

	const ensured = await ensureMaPlaylist(plexPlaylistDbId, ppRow);
	if (!ensured) {
		result.errors++;
		return result;
	}
	const { itemId: maPlaylistId, provider: maPlaylistProvider } = ensured;

	let existingUris: Set<string>;
	try {
		existingUris = await getPlaylistTrackUris(maPlaylistId, maPlaylistProvider);
	} catch (err) {
		console.error(
			`[ma-sync] Failed to fetch existing tracks for "${ppRow.playlist_title}":`,
			err
		);
		result.errors++;
		existingUris = new Set();
	}

	// Dedupe via Set: two distinct list_items can resolve to the same MA track
	// (duplicates in the source list, or different MBIDs sharing artist+title),
	// and we don't want to send the same URI twice.
	const foundUris = new Set<string>();
	await runWithConcurrency(tracks, SEARCH_CONCURRENCY, async (track) => {
		try {
			const uri = await searchTrack(track.artist_name, track.title);
			if (!uri) {
				console.log(
					`[ma-sync] No MA match for list_item ${track.id} ` +
						`"${track.artist_name} - ${track.title}"`
				);
				result.notFound++;
				return;
			}
			if (existingUris.has(uri)) {
				result.alreadyInMa++;
			} else {
				foundUris.add(uri);
			}
		} catch (err) {
			console.error(
				`[ma-sync] Error searching MA for list_item ${track.id} ` +
					`"${track.artist_name} - ${track.title}":`,
				err
			);
			result.errors++;
		}
	});

	if (foundUris.size > 0) {
		const urisToAdd = Array.from(foundUris);
		try {
			await addTracksToPlaylist(maPlaylistId, urisToAdd);
			result.added = urisToAdd.length;
		} catch (err) {
			console.error(
				`[ma-sync] Failed to add tracks to MA playlist "${ppRow.playlist_title}":`,
				err
			);
			result.errors++;
		}
	}

	return result;
}

/**
 * Resolve the MA playlist for this row. Order: stored id → name lookup → create.
 * Persists both the id and provider on first creation/match so subsequent syncs
 * skip the lookup AND don't have to assume a provider.
 */
async function ensureMaPlaylist(
	plexPlaylistDbId: number,
	ppRow: {
		playlist_title: string;
		ma_playlist_item_id: string | null;
		ma_playlist_provider: string | null;
	}
): Promise<{ itemId: string; provider: string } | null> {
	const db = getDb();

	if (ppRow.ma_playlist_item_id) {
		// Use the stored provider when available; fall back to 'library' for
		// rows migrated from before the provider column existed.
		const lookupProvider = ppRow.ma_playlist_provider ?? 'library';
		try {
			const existing = await getPlaylist(ppRow.ma_playlist_item_id, lookupProvider);
			if (existing) {
				// Backfill the provider column for legacy rows so the next sync
				// uses the canonical value.
				if (!ppRow.ma_playlist_provider) {
					db.prepare(
						'UPDATE plex_playlists SET ma_playlist_provider = ? WHERE id = ?'
					).run(existing.provider, plexPlaylistDbId);
				}
				return { itemId: existing.item_id, provider: existing.provider };
			}
			console.warn(
				`[ma-sync] Stored MA playlist id ${ppRow.ma_playlist_item_id} no longer exists; recreating.`
			);
		} catch (err) {
			if (!(err instanceof MusicAssistantError) || err.status !== 404) {
				console.error(
					`[ma-sync] Error fetching MA playlist ${ppRow.ma_playlist_item_id}:`,
					err
				);
				return null;
			}
		}
	}

	try {
		const found = await findPlaylistByName(ppRow.playlist_title);
		if (found) {
			db.prepare(
				'UPDATE plex_playlists SET ma_playlist_item_id = ?, ma_playlist_provider = ? WHERE id = ?'
			).run(found.item_id, found.provider, plexPlaylistDbId);
			return { itemId: found.item_id, provider: found.provider };
		}
	} catch (err) {
		console.error(`[ma-sync] Error searching for existing MA playlist:`, err);
		// Don't bail — try to create.
	}

	try {
		const created = await createPlaylist(ppRow.playlist_title);
		db.prepare(
			'UPDATE plex_playlists SET ma_playlist_item_id = ?, ma_playlist_provider = ? WHERE id = ?'
		).run(created.item_id, created.provider, plexPlaylistDbId);
		return { itemId: created.item_id, provider: created.provider };
	} catch (err) {
		console.error(`[ma-sync] Failed to create MA playlist "${ppRow.playlist_title}":`, err);
		return null;
	}
}

/** Run an async fn over items with bounded concurrency. */
async function runWithConcurrency<T>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<void>
): Promise<void> {
	const queue = items.slice();
	const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
		while (queue.length > 0) {
			const next = queue.shift();
			if (next === undefined) return;
			await fn(next);
		}
	});
	await Promise.all(workers);
}
