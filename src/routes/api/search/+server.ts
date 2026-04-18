import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { searchArtist, searchAlbum, searchTrack } from '$lib/server/musicbrainz';
import { listArtists, getAlbums } from '$lib/server/lidarr';
import { getDb } from '$lib/server/db';

export const GET: RequestHandler = async ({ url }) => {
	const query = url.searchParams.get('q');
	const type = url.searchParams.get('type');

	if (!query || !type) {
		return json({ error: 'Missing query (q) or type.' }, { status: 400 });
	}

	if (!['artist', 'album', 'track'].includes(type)) {
		return json({ error: 'Invalid type parameter.' }, { status: 400 });
	}

	try {
		let results: any[] = [];
		let mbids: string[] = [];

		// 1. MusicBrainz Search
		if (type === 'artist') {
			const arr = await searchArtist(query);
			results = arr.map((a) => ({
				mbid: a.id,
				type: 'artist',
				title: a.name,
				artist: a.name,
				album: null,
				inLidarr: false,
				listMemberships: []
			}));
			mbids = results.map((r) => r.mbid);
		} else if (type === 'album') {
			const arr = await searchAlbum(query);
			results = arr.map((a) => {
				const artistName = a['artist-credit']?.[0]?.artist?.name ?? 'Unknown Artist';
				return {
					mbid: a.id,
					type: 'album',
					title: a.title,
					artist: artistName,
					album: a.title,
					inLidarr: false,
					listMemberships: []
				};
			});
			mbids = results.map((r) => r.mbid);
		} else if (type === 'track') {
			const arr = await searchTrack(query);
			results = arr.map((a) => {
				const artistName = a['artist-credit']?.[0]?.artist?.name ?? 'Unknown Artist';
				const albumName = a.releases?.[0]?.title ?? 'Unknown Album';
				return {
					mbid: a.id,
					type: 'track',
					title: a.title,
					artist: artistName,
					album: albumName,
					inLidarr: false,
					listMemberships: []
				};
			});
			mbids = results.map((r) => r.mbid);
		}

		// 2. Lidarr Match (OQ-5)
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
			// For tracks, we skip fetching all tracks from Lidarr as it's too heavy.
		} catch (e) {
			console.error('Lidarr match failed, proceeding without Lidarr badges:', e);
		}

		// 3. List Memberships Match
		if (mbids.length > 0) {
			// Limit to SQLite variable maximum just to be safe, though 25-50 results usually fits.
			const batchMbids = mbids.slice(0, 900);
			const placeholders = batchMbids.map(() => '?').join(',');
			const rows = getDb()
				.prepare(
					`
				SELECT li.mbid, li.list_id, l.name as listName
				FROM list_items li
				JOIN lists l ON l.id = li.list_id
				WHERE li.mbid IN (${placeholders})
			`
				)
				.all(...batchMbids) as Array<{ mbid: string; list_id: number; listName: string }>;

			for (const row of rows) {
				const target = results.find((r) => r.mbid === row.mbid);
				if (target) {
					// Avoid duplicates just in case
					if (!target.listMemberships.some((m: any) => m.listId === row.list_id)) {
						target.listMemberships.push({ listId: row.list_id, listName: row.listName });
					}
				}
			}
		}

		return json({ results });
	} catch (e: unknown) {
		console.error('Search API error:', e);
		return json(
			{ error: e instanceof Error ? e.message : 'Unknown search error occurred.' },
			{ status: 500 }
		);
	}
};
