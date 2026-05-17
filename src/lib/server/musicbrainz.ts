import { getSetting, SETTING_KEYS } from './settings';

const BASE_URL = 'https://musicbrainz.org/ws/2';

export class MusicBrainzError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
		public readonly body?: string
	) {
		super(message);
		this.name = 'MusicBrainzError';
	}
}

/**
 * Node's native fetch (undici) surfaces network failures as a plain Error
 * whose message is just "fetch failed". The useful detail — DNS failure,
 * connection refused, TLS error, etc. — hides in `err.cause`. This helper
 * walks the cause chain and returns a single descriptive string.
 */
function describeFetchError(err: unknown): string {
	const parts: string[] = [];
	let node: unknown = err;
	const seen = new Set<unknown>();
	while (node && !seen.has(node)) {
		seen.add(node);
		if (node instanceof Error) {
			const code = (node as { code?: string }).code;
			parts.push(code ? `${node.message} [${code}]` : node.message);
			node = (node as { cause?: unknown }).cause;
		} else {
			parts.push(String(node));
			break;
		}
	}
	return parts.join(' — caused by: ');
}

let lastRequestTime = 0;
let queue: Promise<unknown> = Promise.resolve();

/**
 * Enqueue a function to run with a 1-second cadence to respect MusicBrainz rate limits.
 */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
	const execute = async () => {
		const now = Date.now();
		const timeSinceLast = now - lastRequestTime;
		if (timeSinceLast < 1000) {
			await new Promise((resolve) => setTimeout(resolve, 1000 - timeSinceLast));
		}
		try {
			return await fn();
		} finally {
			lastRequestTime = Date.now();
		}
	};

	const next = queue.then(execute);
	queue = next.catch(() => {});
	return next;
}

async function request<T>(path: string, query: Record<string, string>): Promise<T> {
	const email = getSetting(SETTING_KEYS.ADMIN_CONTACT_EMAIL);
	if (!email) {
		throw new Error(
			'Admin Contact Email is not configured. Set it in Settings before searching.'
		);
	}

	const params = new URLSearchParams(query);
	params.set('fmt', 'json');

	return enqueue(async () => {
		const fullUrl = `${BASE_URL}${path}?${params.toString()}`;
		let response: Response;
		try {
			response = await fetch(fullUrl, {
				headers: {
					'User-Agent': `TuneFetch/1.0 ( ${email} )`,
					Accept: 'application/json'
				},
				signal: AbortSignal.timeout(15_000)
			});
		} catch (err: unknown) {
			const detail = describeFetchError(err);
			console.error(
				JSON.stringify({
					ts: new Date().toISOString(),
					tag: 'musicbrainz.fetchError',
					url: fullUrl,
					detail
				})
			);
			throw new MusicBrainzError(`Network error contacting MusicBrainz: ${detail}`);
		}

		if (!response.ok) {
			const text = await response.text();
			throw new MusicBrainzError(`MusicBrainz returned HTTP ${response.status}`, response.status, text);
		}

		return response.json() as Promise<T>;
	});
}

// ── Secondary-type catalogue — single source of truth (doc §4.1a) ────────────
// Keys are exact MB JSON values (case-sensitive). noise=true types are dropped
// by the resolver (canonicalAlbum.ts). Compilation is intentionally noise=false
// so it remains discoverable as a Tier 3 fallback.
export const SECONDARY_TYPE_CATALOGUE = {
	Audiobook:          { noise: true  },
	'Audio drama':      { noise: true  },
	Broadcast:          { noise: false },
	Compilation:        { noise: false },
	Demo:               { noise: true  },
	'DJ-mix':           { noise: true  },
	'Field recording':  { noise: false },
	Interview:          { noise: true  },
	Live:               { noise: true  },
	'Mixtape/Street':   { noise: true  },
	Remix:              { noise: true  },
	Soundtrack:         { noise: false },
	Spokenword:         { noise: true  }
} as const;

// Exact JSON values used by the resolver's BAD_SECONDARY check.
export const NOISE_SECONDARY_TYPES_JSON: ReadonlySet<string> = new Set(
	Object.entries(SECONDARY_TYPE_CATALOGUE)
		.filter(([, meta]) => meta.noise)
		.map(([name]) => name)
);

// ── Release-group filter types and Lidarr-matching defaults ──────────────────
export const PRIMARY_TYPES = ['Album', 'EP', 'Single', 'Other', 'Broadcast'] as const;
export type PrimaryType = (typeof PRIMARY_TYPES)[number];

export interface ReleaseGroupFilters {
	primaryTypes: PrimaryType[];     // empty = no primary-type restriction
	excludeSecondaryTypes: boolean;  // true = require no secondary-type ("Studio" in Lidarr terms)
	officialOnly: boolean;           // true = require status:official (search only; browse limitation)
}

export const DEFAULT_RG_FILTERS: ReleaseGroupFilters = {
	primaryTypes: ['Album', 'EP', 'Single'],
	excludeSecondaryTypes: true,
	officialOnly: true
};

// Lucene fragment builder for the search path.
// MB Lucene field reference:
//   primarytype:(Album OR EP)   – multi-value primary type
//   -secondarytype:*            – release-group has NO secondary types (Lidarr's "Studio")
//   status:Official             – matches groups with ≥1 Official release
function buildRgFilterFragment(f: ReleaseGroupFilters): string {
	const parts: string[] = [];
	if (f.primaryTypes.length > 0) {
		parts.push(`primarytype:(${f.primaryTypes.join(' OR ')})`);
	}
	if (f.excludeSecondaryTypes) {
		// Use explicit exclusion list to avoid parser issues with bare -secondarytype:*
		const excluded = Object.keys(SECONDARY_TYPE_CATALOGUE)
			.map((t) => escapeLucene(t))
			.join(' OR ');
		parts.push(`-secondarytype:(${excluded})`);
	}
	if (f.officialOnly) {
		parts.push('status:official');
	}
	return parts.join(' AND ');
}

// Parse ReleaseGroupFilters from URL search params, falling back to defaults.
export function parseRgFilters(url: URL): ReleaseGroupFilters {
	const raw = url.searchParams.get('primaryTypes');
	const primaryTypes =
		raw === null
			? DEFAULT_RG_FILTERS.primaryTypes
			: raw === ''
				? []
				: (raw
						.split(',')
						.filter((t): t is PrimaryType =>
							(PRIMARY_TYPES as readonly string[]).includes(t)
						));

	const flag = (name: string, fallback: boolean): boolean => {
		const v = url.searchParams.get(name);
		if (v === null) return fallback;
		return v === '1' || v === 'true';
	};

	return {
		primaryTypes,
		excludeSecondaryTypes: flag('studioOnly', DEFAULT_RG_FILTERS.excludeSecondaryTypes),
		officialOnly: flag('officialOnly', DEFAULT_RG_FILTERS.officialOnly)
	};
}

// Result Interfaces
export interface MBArtist {
	id: string; // MBID
	name: string;
	type?: string;
	disambiguation?: string;
	score?: number;
}

export interface MBReleaseGroup {
	id: string; // MBID
	title: string;
	'primary-type'?: string;
	'secondary-types'?: string[];
	'first-release-date'?: string;
	'artist-credit'?: Array<{ artist: { id: string; name: string } }>;
	score?: number;
}

// Nested release-group shape returned inside a recording's releases array
// when inc=release-groups is used. Distinct from the top-level MBReleaseGroup.
export interface MBReleaseGroupNested {
	id: string;
	title: string;
	'primary-type'?: string | null;
	'secondary-types'?: string[];
	'first-release-date'?: string;
}

export interface MBReleaseNested {
	id: string;
	title: string;
	status?: string;
	date?: string;
	country?: string;
	'release-group'?: MBReleaseGroupNested;
}

export interface MBRecording {
	id: string; // MBID
	title: string;
	length?: number; // duration in milliseconds
	disambiguation?: string;
	'artist-credit'?: Array<{ artist: { id: string; name: string } }>;
	releases?: MBReleaseNested[];
	score?: number;
}

/**
 * Escape MusicBrainz Lucene special characters in a field value.
 * MusicBrainz uses Lucene query syntax; unescaped chars like /, (, ), +, etc.
 * produce malformed queries or wildcard-matched garbage.
 *
 * Characters escaped: + - ! ( ) { } [ ] ^ ~ * ? : / \ and operators && ||
 */
const LUCENE_SPECIALS = /([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g;
export function escapeLucene(v: string): string {
	return v.trim().replace(LUCENE_SPECIALS, '\\$1');
}

/**
 * Build a MusicBrainz Lucene query string from named fields.
 * e.g. buildQuery({ recording: 'Yesterday', artist: 'Beatles' })
 *   => 'recording:"Yesterday" AND artist:"Beatles"'
 */
export function buildQuery(fields: Record<string, string>): string {
	return Object.entries(fields)
		.filter(([, v]) => v.trim().length > 0)
		.map(([k, v]) => `${k}:"${escapeLucene(v).replace(/"/g, '\\"')}"`)
		.join(' AND ');
}

export async function searchArtist(query: string): Promise<MBArtist[]> {
	const data = await request<{ artists: MBArtist[] }>('/artist', { query });
	return data.artists || [];
}

export async function searchAlbum(
	query: string,
	filters: ReleaseGroupFilters = DEFAULT_RG_FILTERS
): Promise<MBReleaseGroup[]> {
	const fragment = buildRgFilterFragment(filters);
	const finalQuery = fragment ? `(${query}) AND ${fragment}` : query;
	const data = await request<{ 'release-groups': MBReleaseGroup[] }>('/release-group', {
		query: finalQuery,
		limit: '100'
	});
	return data['release-groups'] || [];
}

export async function searchTrack(query: string): Promise<MBRecording[]> {
	const data = await request<{ recordings: MBRecording[] }>('/recording', {
		query,
		inc: 'releases+release-groups+artist-credits',
		limit: '100'
	});
	return data.recordings || [];
}

// Appends status:official to a base Lucene query.
// Secondary-type negations (live, remix, etc.) are intentionally omitted here:
// MB indexes secondarytype across ALL release groups a recording appears in, so
// negating live/remix would also exclude studio recordings that happen to appear
// on any live or remix album. The canonical album resolver handles secondary-type
// ranking via its tier/penalty system.
export function appendTrackFilters(baseQuery: string): string {
	return `(${baseQuery}) AND status:official`;
}

/**
 * Browse all release groups (albums) for a given artist MBID.
 * Uses the MusicBrainz browse endpoint — does not consume a search slot but still rate-limited.
 * NOTE: officialOnly is not enforced here — the browse API does not support status filtering
 * without fetching releases (inc=releases), which doubles payload. See review doc §3.2.
 */
export async function getArtistReleaseGroups(
	artistMbid: string,
	filters: ReleaseGroupFilters = DEFAULT_RG_FILTERS
): Promise<MBReleaseGroup[]> {
	const typeParam =
		filters.primaryTypes.length > 0
			? filters.primaryTypes.map((t) => t.toLowerCase()).join('|')
			: 'album|ep|single|other|broadcast';

	const data = await request<{ 'release-groups': MBReleaseGroup[]; 'release-group-count': number }>(
		'/release-group',
		{ artist: artistMbid, type: typeParam, limit: '100' }
	);
	let groups = data['release-groups'] || [];

	if (filters.excludeSecondaryTypes) {
		groups = groups.filter((g) => (g['secondary-types'] ?? []).length === 0);
	}

	return groups;
}

/**
 * Browse all recordings in a specific release (not release-group) by release MBID.
 * Returns recordings with artist-credits included.
 */
export async function getReleaseRecordings(releaseMbid: string): Promise<MBRecording[]> {
	const data = await request<{ recordings: MBRecording[]; 'recording-count': number }>(
		'/recording',
		{ release: releaseMbid, inc: 'artist-credits', limit: '100' }
	);
	return data.recordings || [];
}

/**
 * Look up a release-group to get its list of releases, then return the first
 * official release's MBID (used to subsequently fetch its recordings).
 */
export async function getFirstReleaseForGroup(rgMbid: string): Promise<string | null> {
	const data = await request<{
		id: string;
		releases?: Array<{ id: string; title: string; status?: string; date?: string }>;
	}>(`/release-group/${rgMbid}`, { inc: 'releases' });

	const releases = data.releases ?? [];
	if (releases.length === 0) return null;

	// Prefer an "Official" release; fall back to first available
	const official = releases.find((r) => r.status === 'Official') ?? releases[0];
	return official.id;
}
