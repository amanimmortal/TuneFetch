import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { searchArtist, searchAlbum, searchTrack, buildQuery, appendTrackFilters, parseRgFilters } from '$lib/server/musicbrainz';
import { resolveCanonicalAlbumCached, recordingPenalty } from '$lib/server/canonicalAlbum';
import { listArtists, getAlbums } from '$lib/server/lidarr';
import { getDb } from '$lib/server/db';

export const GET: RequestHandler = async ({ url }) => {
	const type = url.searchParams.get('type');

	// Multi-field params
	const artistFilter = url.searchParams.get('artist')?.trim() ?? '';
	const albumFilter = url.searchParams.get('album')?.trim() ?? '';
	const trackFilter = url.searchParams.get('track')?.trim() ?? '';

	if (!type) {
		return json({ error: 'Missing type parameter.' }, { status: 400 });
	}

	if (!['artist', 'album', 'track'].includes(type)) {
		return json({ error: 'Invalid type parameter.' }, { status: 400 });
	}

	if (!artistFilter && !albumFilter && !trackFilter) {
		return json(
			{ error: 'At least one search field (artist, album, track) is required.' },
			{ status: 400 }
		);
	}

	try {
		let results: any[] = [];
		let mbids: string[] = [];
		let query: string;

		if (type === 'artist') {
			query = buildQuery({ artist: artistFilter });
			const arr = await searchArtist(query);
			results = arr.map((a) => ({
				mbid: a.id,
				type: 'artist',
				title: a.name,
				artist: a.name,
				artistMbid: a.id,
				album: null,
				score: a.score ?? 0,
				inLidarr: false,
				listMemberships: []
			}));
			mbids = results.map((r) => r.mbid);
		} else if (type === 'album') {
			const fields: Record<string, string> = {};
			if (albumFilter) fields['releasegroup'] = albumFilter;
			if (artistFilter) fields['artist'] = artistFilter;
			query = buildQuery(fields);
			const arr = await searchAlbum(query, parseRgFilters(url));
			results = arr.map((a) => {
				const artistName = a['artist-credit']?.[0]?.artist?.name ?? 'Unknown Artist';
				const artistMbid = a['artist-credit']?.[0]?.artist?.id ?? null;
				return {
					mbid: a.id,
					type: 'album',
					title: a.title,
					artist: artistName,
					artistMbid,
					album: a.title,
					year: a['first-release-date']?.slice(0, 4) ?? null,
					score: a.score ?? 0,
					inLidarr: false,
					listMemberships: []
				};
			});
			mbids = results.map((r) => r.mbid);
		} else if (type === 'track') {
			const fields: Record<string, string> = {};
			if (trackFilter) fields['recording'] = trackFilter;
			if (artistFilter) fields['artist'] = artistFilter;
			if (albumFilter) fields['release'] = albumFilter;
			query = buildQuery(fields);

			const strict = appendTrackFilters(query);
			let arr = await searchTrack(strict);
			if (arr.length === 0) {
				arr = await searchTrack(query);
			}

			const trackFilters = parseRgFilters(url);

			// Layer 2: penalty for release-group title cues (live sessions, compilations, etc.)
			const RG_TITLE_PENALTY_REGEX =
				/\b(live|sessions?|bbc|triple j|like a version|unplugged|acoustic|in concert|at the)\b/i;
			function rgTitlePenalty(title: string | undefined): number {
				if (!title) return 0;
				return RG_TITLE_PENALTY_REGEX.test(title) ? 80 : 0;
			}

			// Layer 1: filter by canonical tier when strict filters are on.
			// Tiers: 1=Album, 2=EP, 3=Single, 4=Compilation, 5=anything remaining.
			const decorated = arr
				.map((rec) => ({
					rec,
					canonical: resolveCanonicalAlbumCached(rec),
					penalty: recordingPenalty(rec)
				}))
				.filter(({ canonical }) => {
					if (!trackFilters.excludeSecondaryTypes && trackFilters.primaryTypes.length === 0) return true;
					if (!canonical) return false;
					if (trackFilters.primaryTypes.length > 0) {
						const allowAlbum = trackFilters.primaryTypes.includes('Album');
						const allowEP = trackFilters.primaryTypes.includes('EP');
						const allowSingle = trackFilters.primaryTypes.includes('Single');
						if (canonical.tier === 1 && !allowAlbum) return false;
						if (canonical.tier === 2 && !allowEP) return false;
						if (canonical.tier === 3 && !allowSingle) return false;
						if (canonical.tier >= 4) return false;
					}
					if (
						trackFilters.excludeSecondaryTypes &&
						canonical.tier !== 1 &&
						canonical.tier !== 2 &&
						canonical.tier !== 3
					) {
						return false;
					}
					return true;
				});

			// Layer 2+3: include RG title penalty; prefer latest album as final tiebreak
			decorated.sort((a, b) => {
				const tA = a.canonical?.tier ?? 6;
				const tB = b.canonical?.tier ?? 6;
				if (tA !== tB) return tA - tB;
				const pA = a.penalty + rgTitlePenalty(a.canonical?.title);
				const pB = b.penalty + rgTitlePenalty(b.canonical?.title);
				if (pA !== pB) return pA - pB;
				const sA = a.rec.score ?? 0;
				const sB = b.rec.score ?? 0;
				if (sA !== sB) return sB - sA;
				// prefer latest release as final tiebreak (earlier releases are more likely compilations)
				return (b.canonical?.year ?? '0000').localeCompare(a.canonical?.year ?? '0000');
			});

			// Deduplicate: keep only the best-ranked recording per canonical release group.
			// MB returns multiple recordings of the same track (album version, single mix,
			// remaster, etc.) that all resolve to the same release group — they look identical
			// to the user, so keep only the first (highest-ranked) one.
			const seenAlbumMbids = new Set<string>();
			const deduped = decorated.filter(({ canonical }) => {
				if (!canonical?.releaseGroupMbid) return true;
				if (seenAlbumMbids.has(canonical.releaseGroupMbid)) return false;
				seenAlbumMbids.add(canonical.releaseGroupMbid);
				return true;
			});

			results = deduped.map(({ rec, canonical }) => ({
				mbid: rec.id,
				type: 'track',
				title: rec.title,
				artist: rec['artist-credit']?.[0]?.artist?.name ?? 'Unknown Artist',
				artistMbid: rec['artist-credit']?.[0]?.artist?.id ?? null,
				album: canonical?.title ?? rec.releases?.[0]?.title ?? null,
				albumMbid: canonical?.releaseGroupMbid ?? null,
				year: canonical?.year ?? null,
				tier: canonical?.tier ?? null,
				durationMs: rec.length ?? null,
				score: rec.score ?? 0,
				inLidarr: false,
				listMemberships: []
			}));
			mbids = results.map((r) => r.mbid);
		}

		// Lidarr Match
		try {
			if (type === 'artist') {
				const lidarrArtists = await listArtists();
				const lidarrMbids = new Set(lidarrArtists.map((a) => a.foreignArtistId));
				for (const r of results) {
					if (lidarrMbids.has(r.mbid)) r.inLidarr = true;
				}
			} else if (type === 'album') {
				const lidarrAlbums = await getAlbums();
				const lidarrMbids = new Set(lidarrAlbums.map((a) => a.foreignAlbumId));
				for (const r of results) {
					if (lidarrMbids.has(r.mbid)) r.inLidarr = true;
				}
			}
		} catch (e) {
			console.error('Lidarr match failed, proceeding without Lidarr badges:', e);
		}

		// Cap results at 900 to stay within the SQLite parameter limit and avoid
		// overloading the UI. Surface capped/total so the UI can display a hint.
		const totalResults = results.length;
		if (results.length > 900) {
			results = results.slice(0, 900);
			mbids = mbids.slice(0, 900);
		}
		const wasCapped = totalResults > 900;

		// List Memberships Match
		if (mbids.length > 0) {
			const batchMbids = mbids.slice(0, 900);
			const placeholders = batchMbids.map(() => '?').join(',');
			const rows = getDb()
				.prepare(
					`SELECT li.mbid, li.list_id, l.name as listName
					 FROM list_items li
					 JOIN lists l ON l.id = li.list_id
					 WHERE li.mbid IN (${placeholders})`
				)
				.all(...batchMbids) as Array<{ mbid: string; list_id: number; listName: string }>;

			for (const row of rows) {
				const target = results.find((r) => r.mbid === row.mbid);
				if (target) {
					if (!target.listMemberships.some((m: any) => m.listId === row.list_id)) {
						target.listMemberships.push({ listId: row.list_id, listName: row.listName });
					}
				}
			}
		}

		return json({ results, capped: wasCapped, total: totalResults });
	} catch (e: unknown) {
		console.error('Search API error:', e);
		return json(
			{ error: e instanceof Error ? e.message : 'Unknown search error occurred.' },
			{ status: 500 }
		);
	}
};
