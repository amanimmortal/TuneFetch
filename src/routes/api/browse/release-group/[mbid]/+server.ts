import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { getFirstReleaseForGroup, getReleaseRecordings } from '$lib/server/musicbrainz';
import { getDb } from '$lib/server/db';

export const GET = async ({ params, url }: RequestEvent) => {
	const { mbid } = params as { mbid: string };
	const artistName = url.searchParams.get('artistName') ?? 'Unknown Artist';
	const artistMbid = url.searchParams.get('artistMbid') ?? '';
	const albumTitle = url.searchParams.get('albumTitle') ?? '';

	if (!mbid) {
		return json({ error: 'Missing release-group MBID.' }, { status: 400 });
	}

	try {
		const releaseMbid = await getFirstReleaseForGroup(mbid);
		if (!releaseMbid) {
			return json({ results: [] });
		}

		const recordings = await getReleaseRecordings(releaseMbid);

		const results = recordings.map((rec) => {
			const durationMs = rec.length ?? null;
			const recArtistName = rec['artist-credit']?.[0]?.artist?.name ?? artistName;
			const recArtistMbid = rec['artist-credit']?.[0]?.artist?.id ?? artistMbid;
			return {
				mbid: rec.id,
				type: 'track' as const,
				title: rec.title,
				artist: recArtistName,
				artistMbid: recArtistMbid,
				album: albumTitle,
				durationMs,
				listMemberships: [] as Array<{ listId: number; listName: string }>
			};
		});

		const mbids = results.map((r) => r.mbid);
		if (mbids.length > 0) {
			const placeholders = mbids.map(() => '?').join(',');
			const rows = getDb()
				.prepare(
					`SELECT li.mbid, li.list_id, l.name as listName
					 FROM list_items li
					 JOIN lists l ON l.id = li.list_id
					 WHERE li.mbid IN (${placeholders})`
				)
				.all(...mbids) as Array<{ mbid: string; list_id: number; listName: string }>;

			for (const row of rows) {
				const target = results.find((r) => r.mbid === row.mbid);
				if (target && !target.listMemberships.some((m) => m.listId === row.list_id)) {
					target.listMemberships.push({ listId: row.list_id, listName: row.listName });
				}
			}
		}

		return json({ results });
	} catch (e: unknown) {
		console.error('Browse release-group tracks error:', e);
		return json(
			{ error: e instanceof Error ? e.message : 'Unknown error.' },
			{ status: 500 }
		);
	}
};
