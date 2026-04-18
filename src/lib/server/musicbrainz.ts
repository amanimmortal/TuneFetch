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
		let response: Response;
		try {
			response = await fetch(`${BASE_URL}${path}?${params.toString()}`, {
				headers: {
					'User-Agent': `TuneFetch/1.0 ( ${email} )`,
					Accept: 'application/json'
				},
				signal: AbortSignal.timeout(15_000)
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new MusicBrainzError(`Network error contacting MusicBrainz: ${msg}`);
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
}

export interface MBReleaseGroup {
	id: string; // MBID
	title: string;
	'primary-type'?: string;
	'artist-credit'?: Array<{ artist: { id: string; name: string } }>;
}

export interface MBRecording {
	id: string; // MBID
	title: string;
	'artist-credit'?: Array<{ artist: { id: string; name: string } }>;
	releases?: Array<{ id: string; title: string; 'release-group'?: { id: string; title: string } }>;
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
