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
	'first-release-date'?: string;
	'artist-credit'?: Array<{ artist: { id: string; name: string } }>;
	score?: number;
}

export interface MBRecording {
	id: string; // MBID
	title: string;
	length?: number; // duration in milliseconds
	'artist-credit'?: Array<{ artist: { id: string; name: string } }>;
	releases?: Array<{ id: string; title: string; 'release-group'?: { id: string; title: string } }>;
	score?: number;
}

/**
 * Build a MusicBrainz Lucene query string from named fields.
 * e.g. buildQuery({ recording: 'Yesterday', artist: 'Beatles' })
 *   => 'recording:"Yesterday" AND artist:"Beatles"'
 */
export function buildQuery(fields: Record<string, string>): string {
	return Object.entries(fields)
		.filter(([, v]) => v.trim().length > 0)
		.map(([k, v]) => `${k}:"${v.trim().replace(/"/g, '\\"')}"`)
		.join(' AND ');
}

export async function searchArtist(query: string): Promise<MBArtist[]> {
	const data = await request<{ artists: MBArtist[] }>('/artist', { query });
	return data.artists || [];
}

export async function searchAlbum(query: string): Promise<MBReleaseGroup[]> {
	const data = await request<{ 'release-groups': MBReleaseGroup[] }>('/release-group', { query });
	return data['release-groups'] || [];
}

export async function searchTrack(query: string): Promise<MBRecording[]> {
	const data = await request<{ recordings: MBRecording[] }>('/recording', { query });
	return data.recordings || [];
}

/**
 * Browse all release groups (albums) for a given artist MBID.
 * Uses the MusicBrainz browse endpoint — does not consume a search slot but still rate-limited.
 */
export async function getArtistReleaseGroups(artistMbid: string): Promise<MBReleaseGroup[]> {
	// MusicBrainz browse paginates at 100 max. For most artists that covers it.
	const data = await request<{ 'release-groups': MBReleaseGroup[]; 'release-group-count': number }>(
		'/release-group',
		{ artist: artistMbid, type: 'album|ep|single', limit: '100' }
	);
	return data['release-groups'] || [];
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
