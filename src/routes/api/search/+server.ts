import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { searchArtist, searchAlbum, searchTrack, buildQuery } from '$lib/server/musicbrainz';
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
			const arr = await searchAlbum(query);
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
			const arr = await searchTrack(query);
			results = arr.map((a) => {
				const artistName = a['artist-credit']?.[0]?.artist?.name ?? 'Unknown Artist';
				const artistMbid = a['artist-credit']?.[0]?.artist?.id ?? null;
				const albumName = a.releases?.[0]?.title ?? null;
				const durationMs = a.length ?? null;
				return {
					mbid: a.id,
					type: 'track',
					title: a.title,
					artist: artistName,
					artistMbid,
					album: albumName,
					durationMs,
					score: a.score ?? 0,
					inLidarr: false,
					listMemberships: []
				};
			});
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
