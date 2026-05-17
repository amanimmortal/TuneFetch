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
	getLidarrPrimaryRoot,
	lookupAlbumByReleaseGroupMbid,
	type LidarrTrack
} from './lidarr';
import { startBackfill, type MirrorScope } from './mirror';

/**
 * Poll Lidarr for an artist's tracks until the list is non-empty or `timeoutMs` elapses.
 *
 * Why: when an artist is freshly POSTed to Lidarr, the metadata fetch from
 * MusicBrainz happens asynchronously. An immediate `getTracks(artistId)` call
 * almost always returns `[]`. Without this poll, scenarioB/C would
 * `markFailed("Lidarr returned 0 tracks...")` on every fresh-artist add even
 * though Lidarr would have populated the tracks seconds later.
 *
 * Returns whatever tracks are present at the moment the poll exits — empty if
 * the timeout fires, populated if Lidarr finished syncing in time.
 */
async function pollForTracks(
	artistId: number,
	timeoutMs = 30_000,
	intervalMs = 3_000
): Promise<LidarrTrack[]> {
	const deadline = Date.now() + timeoutMs;
	let attempt = 0;
	while (true) {
		attempt++;
		const tracks = await getTracks(artistId);
		if (tracks.length > 0) {
			console.log(
				`[orchestrator] pollForTracks: artist ${artistId} returned ${tracks.length} track(s) on attempt ${attempt}`
			);
			return tracks;
		}
		if (Date.now() + intervalMs >= deadline) {
			console.warn(
				`[orchestrator] pollForTracks: artist ${artistId} still empty after ${attempt} attempt(s) (~${timeoutMs}ms) — giving up`
			);
			return tracks;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

/**
 * Resolve a release-group MBID to the artist that *owns* it in MusicBrainz,
 * via Lidarr's metadata server.
 *
 * Why this exists: a recording's credited artist (e.g. Jack Black on
 * "Steve's Lava Chicken") often differs from the release group's owning artist
 * (e.g. "Various Artists" on the "A Minecraft Movie" soundtrack). Adding the
 * recording's artist to Lidarr and waiting for the album to appear in *their*
 * discography is a dead end — Lidarr only knows about that release group as
 * part of the Various Artists discography.
 *
 * Returns `null` when the lookup returns nothing or fails — caller should fall
 * back to `artist_mbid` from the list_item.
 */
async function resolveReleaseGroupArtist(
	releaseGroupMbid: string,
	itemId: number
): Promise<{ artistMbid: string; artistName: string; albumTitle: string } | null> {
	try {
		const results = await lookupAlbumByReleaseGroupMbid(releaseGroupMbid);
		if (!results || results.length === 0) {
			console.warn(
				`[orchestrator] item ${itemId}: Lidarr album/lookup for lidarr:${releaseGroupMbid} returned no results`
			);
			return null;
		}
		// Prefer the exact MBID match — Lidarr usually returns one result for an
		// MBID-form term, but be defensive.
		const match = results.find((r) => r.foreignAlbumId === releaseGroupMbid) ?? results[0];
		if (!match?.artist?.foreignArtistId) {
			console.warn(
				`[orchestrator] item ${itemId}: Lidarr album/lookup result missing artist.foreignArtistId for lidarr:${releaseGroupMbid}`
			);
			return null;
		}
		return {
			artistMbid: match.artist.foreignArtistId,
			artistName: match.artist.artistName,
			albumTitle: match.title
		};
	} catch (err) {
		console.warn(
			`[orchestrator] item ${itemId}: Lidarr album/lookup failed for lidarr:${releaseGroupMbid} —`,
			err
		);
		return null;
	}
}

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
	/**
	 * MB release-group MBID. For track items, the canonical release group from
	 * the canonical-album resolver — used to resolve the *owning* artist via
	 * Lidarr's `lidarr:<mbid>` lookup (which can differ from artist_mbid for
	 * Various Artists releases / soundtracks). For album items, equals mbid.
	 * NULL for artist items and for legacy rows added before this column existed.
	 */
	album_mbid: string | null;
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
	console.error(`[orchestrator] item ${itemId}: markFailed — ${message}`);
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
	console.log(`[orchestrator] item ${itemId}: mirror_pending (cross-library add, backfill queued)`);
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
	console.log(
		`[orchestrator] item ${itemId}: synced — ` +
		`artist=${ids.lidarrArtistId ?? '-'} album=${ids.lidarrAlbumId ?? '-'} track=${ids.lidarrTrackId ?? '-'}`
	);
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
			`SELECT id, list_id, mbid, type, title, artist_name, album_name, artist_mbid, album_mbid,
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

	console.log(
		`[orchestrator] item ${listItemId}: starting — type=${item.type} title="${item.title}" ` +
		`artist="${item.artist_name}" mbid=${item.mbid} list="${list.name}" root="${list.root_folder_path}"`
	);

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
		console.log(
			`[orchestrator] item ${item.id}: scenarioA — adding artist "${item.artist_name}" ` +
			`(MBID ${item.mbid}) to Lidarr at "${primaryRoot}" with monitor=all`
		);
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
		console.log(`[orchestrator] item ${item.id}: scenarioA — Lidarr assigned artist id ${lidarrArtistId}`);

		// Trigger artist search
		await runCommand('ArtistSearch', { artistId: lidarrArtist.id });
		console.log(`[orchestrator] item ${item.id}: scenarioA — triggered ArtistSearch on ${lidarrArtistId}`);
	} else {
		// Artist already in Lidarr
		lidarrArtistId = existing.id;
		console.log(
			`[orchestrator] item ${item.id}: scenarioA — artist "${existing.artistName}" already in Lidarr (id ${lidarrArtistId})`
		);
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

	// Decide which artist MBID actually owns the release group this track lives
	// on. For most tracks this matches item.artist_mbid (the recording's credited
	// artist). For soundtracks / Various Artists compilations the *recording*
	// is credited to e.g. "Jack Black" but the *release group* is owned by
	// "Various Artists" — adding Jack Black will never surface the album.
	let effectiveArtistMbid = item.artist_mbid;
	let effectiveArtistName = item.artist_name;
	if (item.album_mbid) {
		const resolved = await resolveReleaseGroupArtist(item.album_mbid, item.id);
		if (resolved && resolved.artistMbid !== item.artist_mbid) {
			console.log(
				`[orchestrator] item ${item.id}: scenarioB — release-group lookup overrides artist: ` +
				`"${item.artist_name}" (MBID ${item.artist_mbid ?? '-'}) → ` +
				`"${resolved.artistName}" (MBID ${resolved.artistMbid}) for album "${resolved.albumTitle}"`
			);
			effectiveArtistMbid = resolved.artistMbid;
			effectiveArtistName = resolved.artistName;
		} else if (resolved) {
			console.log(
				`[orchestrator] item ${item.id}: scenarioB — release-group lookup confirmed artist "${resolved.artistName}"`
			);
		}
	}

	// Resolve the Lidarr artist. Always prefer MBID-based resolution — the
	// cached lidarr_artist_id can be stale (e.g. if a previous sync erroneously
	// wrote the wrong artist's ID, including the case this very fix addresses).
	let lidarrArtistId = item.lidarr_artist_id;
	let freshlyAdded = false;

	if (effectiveArtistMbid) {
		const existing = await getArtistByMbid(effectiveArtistMbid);
		if (existing) {
			if (lidarrArtistId && lidarrArtistId !== existing.id) {
				console.warn(
					`[orchestrator] item ${item.id} ("${item.title}"): cached lidarr_artist_id ` +
					`${lidarrArtistId} overridden by MBID lookup → ${existing.id} ("${existing.artistName}")`
				);
			}
			lidarrArtistId = existing.id;
		} else {
			lidarrArtistId = null;
		}
	}

	if (!lidarrArtistId) {
		// Artist not yet in Lidarr — add with monitor=all + searchForMissingAlbums so
		// Lidarr begins metadata sync and album search immediately. We will narrow
		// the monitor set down to just the wanted album once metadata lands.
		if (!effectiveArtistMbid) {
			markFailed(
				item.id,
				`Cannot push track to Lidarr: no artist MusicBrainz ID available. ` +
					`Both the captured artist MBID and the release-group lookup came up empty. ` +
					`Remove and re-add this item from the search page to fix this.`
			);
			return;
		}

		const { qualityProfileId, metadataProfileId } = await resolveProfileIds(list);
		console.log(
			`[orchestrator] item ${item.id}: scenarioB — adding artist "${effectiveArtistName}" ` +
			`(MBID ${effectiveArtistMbid}) to Lidarr at "${primaryRoot}" with monitor=all (will narrow after metadata sync)`
		);
		const lidarrArtist = await addArtist({
			foreignArtistId: effectiveArtistMbid,
			artistName: effectiveArtistName,
			rootFolderPath: primaryRoot,
			qualityProfileId,
			metadataProfileId,
			monitored: true,
			addOptions: { monitor: 'all', searchForMissingAlbums: true }
		});
		lidarrArtistId = lidarrArtist.id;
		freshlyAdded = true;
		console.log(`[orchestrator] item ${item.id}: scenarioB — Lidarr assigned artist id ${lidarrArtistId}`);
	} else {
		// Existing artist — ensure it's monitored.
		const existing = await getArtistByMbid(effectiveArtistMbid!);
		if (existing && !existing.monitored) {
			console.log(`[orchestrator] item ${item.id}: scenarioB — enabling monitor on existing artist ${lidarrArtistId}`);
			await updateArtist({ ...existing, monitored: true });
		}
		if (existing) {
			console.log(
				`[orchestrator] item ${item.id}: scenarioB — artist "${existing.artistName}" already in Lidarr (id ${lidarrArtistId})`
			);
		}
	}

	// Find the track in Lidarr. For a freshly-added artist Lidarr fetches MB
	// metadata asynchronously — poll until tracks appear (or we time out).
	//
	// When album_mbid is known, prefer the *specific* release group's tracks:
	// poll until that album appears for this artist (avoids matching on a
	// same-titled cover from a different album), then narrow tracks to it.
	let tracks: LidarrTrack[] = [];
	let targetAlbumId: number | undefined;
	if (item.album_mbid) {
		const deadline = Date.now() + 30_000;
		let attempts = 0;
		while (Date.now() < deadline) {
			attempts++;
			const albums = await getAlbums(lidarrArtistId);
			const match = albums.find((a) => a.foreignAlbumId === item.album_mbid);
			if (match) {
				targetAlbumId = match.id;
				console.log(
					`[orchestrator] item ${item.id}: scenarioB — release group ${item.album_mbid} ` +
					`resolved to Lidarr album ${match.id} ("${match.title}") on attempt ${attempts}`
				);
				break;
			}
			if (!freshlyAdded) break; // existing artist — if the album isn't there it isn't coming
			await new Promise((resolve) => setTimeout(resolve, 3_000));
		}
		if (targetAlbumId !== undefined) {
			tracks = (await getTracks(lidarrArtistId)).filter((t) => t.albumId === targetAlbumId);
		} else {
			console.warn(
				`[orchestrator] item ${item.id}: scenarioB — release group ${item.album_mbid} did not ` +
				`appear on artist ${lidarrArtistId} within timeout; falling back to whole-artist track search`
			);
			tracks = freshlyAdded ? await pollForTracks(lidarrArtistId) : await getTracks(lidarrArtistId);
		}
	} else {
		tracks = freshlyAdded ? await pollForTracks(lidarrArtistId) : await getTracks(lidarrArtistId);
	}
	const target = resolveTrackForListItem(tracks, item);

	if (!target) {
		const sample = tracks.slice(0, 5).map((t) => `"${t.title}" [${t.foreignTrackId}]`).join(', ');
		const hint = tracks.length === 0
			? 'Lidarr returned 0 tracks — metadata may not have synced yet, retry in a few minutes.'
			: `Lidarr returned ${tracks.length} track(s) but none matched. Sample: [${sample}]`;
		markFailed(item.id, `Track "${item.title}" not found in Lidarr (artist ID ${lidarrArtistId}, artist MBID ${item.artist_mbid ?? 'unknown'}). ${hint}`);
		return;
	}

	// Monitor parent album
	const album = await getAlbum(target.albumId);
	if (!album.monitored) {
		console.log(`[orchestrator] item ${item.id}: scenarioB — monitoring album ${target.albumId} ("${album.title}")`);
		await updateAlbum({ ...album, monitored: true });
	}

	// Narrow: for freshly-added artists we set monitor=all so Lidarr would
	// search every album. Now that we've identified the one we actually want,
	// unmonitor every other album on this artist so the user doesn't get the
	// whole discography. Best-effort — failures here don't block the sync.
	if (freshlyAdded) {
		try {
			const allAlbums = await getAlbums(lidarrArtistId);
			const toUnmonitor = allAlbums.filter((a) => a.id !== target.albumId && a.monitored);
			if (toUnmonitor.length > 0) {
				console.log(
					`[orchestrator] item ${item.id}: scenarioB — narrowing artist ${lidarrArtistId}: ` +
					`unmonitoring ${toUnmonitor.length} sibling album(s), keeping ${target.albumId} monitored`
				);
				for (const a of toUnmonitor) {
					await updateAlbum({ ...a, monitored: false });
				}
			}
		} catch (err) {
			console.warn(
				`[orchestrator] item ${item.id}: scenarioB — narrow step failed (non-fatal):`,
				err
			);
		}
	}

	// Trigger album search
	console.log(`[orchestrator] item ${item.id}: scenarioB — triggering AlbumSearch on album ${target.albumId}`);
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

	// Resolve the release group's *owning* artist via Lidarr lookup. For album
	// items item.mbid is itself the release-group MBID. The lookup is the only
	// reliable source of truth for which artist Lidarr will file this release
	// group under (matters for Various Artists comps).
	let effectiveArtistMbid = item.artist_mbid;
	let effectiveArtistName = item.artist_name;
	{
		const resolved = await resolveReleaseGroupArtist(item.mbid, item.id);
		if (resolved && resolved.artistMbid !== item.artist_mbid) {
			console.log(
				`[orchestrator] item ${item.id}: scenarioC — release-group lookup overrides artist: ` +
				`"${item.artist_name}" (MBID ${item.artist_mbid ?? '-'}) → ` +
				`"${resolved.artistName}" (MBID ${resolved.artistMbid}) for album "${resolved.albumTitle}"`
			);
			effectiveArtistMbid = resolved.artistMbid;
			effectiveArtistName = resolved.artistName;
		} else if (resolved) {
			console.log(
				`[orchestrator] item ${item.id}: scenarioC — release-group lookup confirmed artist "${resolved.artistName}"`
			);
		}
	}

	// Always prefer MBID-based resolution — the cached lidarr_artist_id can be stale.
	let lidarrArtistId = item.lidarr_artist_id;
	let freshlyAdded = false;

	if (effectiveArtistMbid) {
		const existing = await getArtistByMbid(effectiveArtistMbid);
		if (existing) {
			if (lidarrArtistId && lidarrArtistId !== existing.id) {
				console.warn(
					`[orchestrator] item ${item.id} ("${item.title}"): cached lidarr_artist_id ` +
					`${lidarrArtistId} overridden by MBID lookup → ${existing.id} ("${existing.artistName}")`
				);
			}
			lidarrArtistId = existing.id;
		} else {
			lidarrArtistId = null;
		}
	}

	if (!lidarrArtistId) {
		// Auto-add artist
		if (!effectiveArtistMbid) {
			markFailed(
				item.id,
				`Cannot push album to Lidarr: no artist MusicBrainz ID available (recording-credit lookup ` +
					`and release-group lookup both empty). Remove and re-add this item to fix this.`
			);
			return;
		}

		const { qualityProfileId, metadataProfileId } = await resolveProfileIds(list);
		console.log(
			`[orchestrator] item ${item.id}: scenarioC — adding artist "${effectiveArtistName}" ` +
			`(MBID ${effectiveArtistMbid}) to Lidarr at "${primaryRoot}" with monitor=all (will narrow to album ${item.mbid})`
		);
		const lidarrArtist = await addArtist({
			foreignArtistId: effectiveArtistMbid,
			artistName: effectiveArtistName,
			rootFolderPath: primaryRoot,
			qualityProfileId,
			metadataProfileId,
			monitored: true,
			addOptions: { monitor: 'all', searchForMissingAlbums: true }
		});
		lidarrArtistId = lidarrArtist.id;
		freshlyAdded = true;
		console.log(`[orchestrator] item ${item.id}: scenarioC — Lidarr assigned artist id ${lidarrArtistId}`);
	} else {
		const existing = await getArtistByMbid(effectiveArtistMbid!);
		if (existing && !existing.monitored) {
			console.log(`[orchestrator] item ${item.id}: scenarioC — enabling monitor on existing artist ${lidarrArtistId}`);
			await updateArtist({ ...existing, monitored: true });
		}
		if (existing) {
			console.log(
				`[orchestrator] item ${item.id}: scenarioC — artist "${existing.artistName}" already in Lidarr (id ${lidarrArtistId})`
			);
		}
	}

	// Find the album. For a freshly-added artist, Lidarr fetches MB metadata
	// asynchronously — poll until albums appear (we reuse pollForTracks's logic
	// via a small inline poll on getAlbums, since the same timing applies).
	let albums = await getAlbums(lidarrArtistId);
	if (freshlyAdded && albums.length === 0) {
		const deadline = Date.now() + 30_000;
		let attempt = 0;
		while (albums.length === 0 && Date.now() < deadline) {
			attempt++;
			await new Promise((resolve) => setTimeout(resolve, 3_000));
			albums = await getAlbums(lidarrArtistId);
		}
		console.log(
			`[orchestrator] item ${item.id}: scenarioC — getAlbums poll completed after ${attempt} attempt(s) ` +
			`(${albums.length} album(s))`
		);
	}
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
	console.log(`[orchestrator] item ${item.id}: scenarioC — monitoring album ${target.id} ("${target.title}")`);
	await updateAlbum({ ...target, monitored: true });

	// Narrow: for a freshly-added artist, unmonitor every other album so we
	// don't pull the whole discography. Best-effort.
	if (freshlyAdded) {
		try {
			const toUnmonitor = albums.filter((a) => a.id !== target.id && a.monitored);
			if (toUnmonitor.length > 0) {
				console.log(
					`[orchestrator] item ${item.id}: scenarioC — narrowing artist ${lidarrArtistId}: ` +
					`unmonitoring ${toUnmonitor.length} sibling album(s), keeping ${target.id} monitored`
				);
				for (const a of toUnmonitor) {
					await updateAlbum({ ...a, monitored: false });
				}
			}
		} catch (err) {
			console.warn(
				`[orchestrator] item ${item.id}: scenarioC — narrow step failed (non-fatal):`,
				err
			);
		}
	}

	// Trigger album search
	console.log(`[orchestrator] item ${item.id}: scenarioC — triggering AlbumSearch on album ${target.id}`);
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
