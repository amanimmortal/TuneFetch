import type { MBRecording, MBReleaseGroupNested } from './musicbrainz';
import { NOISE_SECONDARY_TYPES_JSON } from './musicbrainz';
import { getDb } from './db';

const BAD_SECONDARY = NOISE_SECONDARY_TYPES_JSON;

const TITLE_PENALTY_REGEX =
	/\b(live|remaster(ed)?|radio edit|instrumental|acoustic|karaoke|demo|mono|alternate)\b/i;

export type CanonicalTier = 1 | 2 | 3 | 4 | 5;

export interface CanonicalAlbum {
	releaseGroupMbid: string;
	title: string;
	year: string | null;
	tier: CanonicalTier;
}

export function resolveCanonicalAlbum(rec: MBRecording): CanonicalAlbum | null {
	const groups = (rec.releases ?? [])
		.map((r) => r['release-group'])
		.filter((g): g is MBReleaseGroupNested => !!g);

	// Dedupe by release-group id
	const byId = new Map<string, MBReleaseGroupNested>();
	for (const g of groups) byId.set(g.id, g);
	const unique = [...byId.values()];

	// Drop release-groups whose secondary-types include a noise type
	const clean = unique.filter((g) => {
		const sec = g['secondary-types'] ?? [];
		return !sec.some((s) => BAD_SECONDARY.has(s));
	});

	const earliest = (gs: MBReleaseGroupNested[]) =>
		gs.slice().sort((a, b) =>
			(a['first-release-date'] ?? '9999').localeCompare(b['first-release-date'] ?? '9999')
		)[0];

	// Tier 1: studio album (no secondary types)
	const tier1 = clean.filter(
		(g) => g['primary-type'] === 'Album' && (!g['secondary-types'] || g['secondary-types'].length === 0)
	);
	if (tier1.length) return toCanonical(earliest(tier1), 1);

	// Tier 2: EP
	const tier2 = clean.filter((g) => g['primary-type'] === 'EP');
	if (tier2.length) return toCanonical(earliest(tier2), 2);

	// Tier 3: Single
	const tier3 = clean.filter((g) => g['primary-type'] === 'Single');
	if (tier3.length) return toCanonical(earliest(tier3), 3);

	// Tier 4: compilation-only album (best-of fallback)
	const tier4 = clean.filter(
		(g) =>
			g['primary-type'] === 'Album' &&
			(g['secondary-types'] ?? []).length > 0 &&
			(g['secondary-types'] ?? []).every((s) => s === 'Compilation')
	);
	if (tier4.length) return toCanonical(earliest(tier4), 4);

	// Tier 5: anything remaining
	if (clean.length) return toCanonical(earliest(clean), 5);
	if (unique.length) return toCanonical(earliest(unique), 5);
	return null;
}

function toCanonical(g: MBReleaseGroupNested, tier: CanonicalTier): CanonicalAlbum {
	return {
		releaseGroupMbid: g.id,
		title: g.title,
		year: g['first-release-date']?.slice(0, 4) ?? null,
		tier
	};
}

export function recordingPenalty(rec: MBRecording): number {
	let penalty = 0;
	if (TITLE_PENALTY_REGEX.test(rec.title)) penalty += 40;
	if (rec.disambiguation && TITLE_PENALTY_REGEX.test(rec.disambiguation)) penalty += 40;
	if (rec.length && (rec.length < 30_000 || rec.length > 15 * 60_000)) penalty += 30;
	return penalty;
}

interface CacheRow {
	release_group_mbid: string;
	release_group_title: string;
	year: string | null;
	tier: number;
}

// Prepared statements initialised once on first call to avoid per-invocation prepare overhead.
let _stmtGet: any = null;
let _stmtUpsert: any = null;

// Cache-aware wrapper: looks up recording_mbid in SQLite, resolves on miss, writes through.
export function resolveCanonicalAlbumCached(rec: MBRecording): CanonicalAlbum | null {
	const db = getDb();
	_stmtGet ??= db.prepare(
		'SELECT release_group_mbid, release_group_title, year, tier FROM canonical_album_cache WHERE recording_mbid = ?'
	);
	_stmtUpsert ??= db.prepare(
		`INSERT OR REPLACE INTO canonical_album_cache
		  (recording_mbid, release_group_mbid, release_group_title, year, tier, cached_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	);

	const cached = _stmtGet.get(rec.id) as CacheRow | undefined;

	if (cached) {
		return {
			releaseGroupMbid: cached.release_group_mbid,
			title: cached.release_group_title,
			year: cached.year,
			tier: cached.tier as CanonicalTier
		};
	}

	const result = resolveCanonicalAlbum(rec);

	if (result) {
		_stmtUpsert.run(
			rec.id,
			result.releaseGroupMbid,
			result.title,
			result.year,
			result.tier,
			Math.floor(Date.now() / 1000)
		);
	}

	return result;
}
