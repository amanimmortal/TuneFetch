import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { getArtistReleaseGroups } from '$lib/server/musicbrainz';
import { getDb } from '$lib/server/db';

export const GET = async ({ params }: RequestEvent) => {
	const { mbid } = params as { mbid: string };

	if (!mbid) {
		return json({ error: 'Missing artist MBID.' }, { status: 400 });
	}

	try {
		const releaseGroups = await getArtistReleaseGroups(mbid);

		const typeOrder: Record<string, number> = { Album: 0, EP: 1, Single: 2 };
		releaseGroups.sort((a, b) => {
			const ta = typeOrder[a['primary-type'] ?? ''] ?? 99;
			const tb = typeOrder[b['primary-type'] ?? ''] ?? 99;
			if (ta !== tb) return ta - tb;
			const da = a['first-release-date'] ?? '';
			const db2 = b['first-release-date'] ?? '';
			return db2.localeCompare(da);
		});

		const results = releaseGroups.map((rg) => ({
			mbid: rg.id,
			title: rg.title,
			type: rg['primary-type'] ?? 'Unknown',
			year: rg['first-release-date']?.slice(0, 4) ?? null,
			artistName: rg['artist-credit']?.[0]?.artist?.name ?? null,
			artistMbid: rg['artist-credit']?.[0]?.artist?.id ?? null
		}));

		const mbids = results.map((r) => r.mbid);
		const listMembershipMap: Record<string, Array<{ listId: number; listName: string }>> = {};

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
				if (!listMembershipMap[row.mbid]) listMembershipMap[row.mbid] = [];
				listMembershipMap[row.mbid].push({ listId: row.list_id, listName: row.listName });
			}
		}

		return json({
			results: results.map((r) => ({
				...r,
				listMemberships: listMembershipMap[r.mbid] ?? []
			}))
		});
	} catch (e: unknown) {
		console.error('Browse artist albums error:', e);
		return json(
			{ error: e instanceof Error ? e.message : 'Unknown error.' },
			{ status: 500 }
		);
	}
};
