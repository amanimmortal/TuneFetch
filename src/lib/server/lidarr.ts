/**
 * Lidarr API v1 client.
 *
 * All methods read the base URL and API key from the settings table at
 * call time, so configuration changes take effect immediately without
 * a server restart.
 *
 * Pass a custom `fetchFn` argument to override global fetch in unit tests.
 */

import { getSetting, SETTING_KEYS } from './settings';

// ── Error type ────────────────────────────────────────────────────────────────

/**
 * Thrown whenever Lidarr returns a non-2xx response, is unreachable,
 * or is not yet configured in settings.
 *
 * `status` is the HTTP status code (undefined for network errors).
 * `body` is the raw response body text (useful for sync_error storage).
 */
export class LidarrError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
		public readonly body?: string
	) {
		super(message);
		this.name = 'LidarrError';
	}
}

/**
 * Undici's native fetch surfaces network failures as a plain Error with
 * message "fetch failed". The actual cause (DNS, refused, TLS, timeout)
 * lives in `err.cause`. Walk that chain into a single readable string.
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

// ── Lidarr response types ─────────────────────────────────────────────────────

export interface LidarrConfig {
	baseUrl: string;
	apiKey: string;
}

export interface SystemStatus {
	appName: string;
	version: string;
	[key: string]: unknown;
}

export interface RootFolder {
	id: number;
	path: string;
	freeSpace: number;
	[key: string]: unknown;
}

export interface LidarrArtist {
	id: number;
	/** MusicBrainz artist MBID. */
	foreignArtistId: string;
	artistName: string;
	rootFolderPath: string;
	monitored: boolean;
	qualityProfileId: number;
	metadataProfileId: number;
	[key: string]: unknown;
}

export interface LidarrAlbum {
	id: number;
	/** MusicBrainz release-group MBID. */
	foreignAlbumId: string;
	artistId: number;
	title: string;
	monitored: boolean;
	[key: string]: unknown;
}

export interface LidarrTrack {
	id: number;
	/** MusicBrainz recording MBID. */
	foreignTrackId: string;
	artistId: number;
	albumId: number;
	title: string;
	monitored: boolean;
	[key: string]: unknown;
}

export interface LidarrTrackFile {
	id: number;
	artistId: number;
	albumId: number;
	/** Absolute path to the file on the Lidarr host (same as container path via volume mounts). */
	path: string;
	[key: string]: unknown;
}

export interface AddArtistPayload {
	/** MusicBrainz artist MBID. */
	foreignArtistId: string;
	artistName: string;
	rootFolderPath: string;
	qualityProfileId?: number;
	metadataProfileId?: number;
	monitored: boolean;
	addOptions: {
		/**
		 * `all`  — monitor all albums/tracks (full artist add, Scenario A).
		 * `none` — add artist unmonitored, then selectively monitor tracks/albums
		 *          (Scenario B / C).
		 */
		monitor: 'all' | 'none' | 'missing' | 'existing' | 'first' | 'latest' | 'future';
		searchForMissingAlbums?: boolean;
	};
}

export interface LidarrCommand {
	id: number;
	name: string;
	status: string;
	[key: string]: unknown;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

type FetchFn = typeof fetch;

/** Read and validate Lidarr config from settings. Throws LidarrError if unset. */
function readConfig(): LidarrConfig {
	const baseUrl = getSetting(SETTING_KEYS.LIDARR_URL);
	const apiKey = getSetting(SETTING_KEYS.LIDARR_API_KEY);
	if (!baseUrl || !apiKey) {
		throw new LidarrError(
			'Lidarr is not configured. Set Lidarr URL and API key in Settings.'
		);
	}
	return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey };
}

/**
 * Internal fetch wrapper.
 * - Injects X-Api-Key header.
 * - Applies a 15-second timeout.
 * - Throws LidarrError on non-2xx responses or network failures.
 */
async function request<T>(
	method: 'GET' | 'POST' | 'PUT' | 'DELETE',
	path: string,
	body?: unknown,
	fetchFn: FetchFn = fetch
): Promise<T> {
	const { baseUrl, apiKey } = readConfig();
	const url = `${baseUrl}${path}`;

	let response: Response;
	try {
		response = await fetchFn(url, {
			method,
			headers: {
				'X-Api-Key': apiKey,
				'Content-Type': 'application/json',
				Accept: 'application/json'
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(15_000)
		});
	} catch (err: unknown) {
		const detail = describeFetchError(err);
		console.error(
			JSON.stringify({
				ts: new Date().toISOString(),
				tag: 'lidarr.fetchError',
				method,
				url,
				detail
			})
		);
		throw new LidarrError(`Network error contacting Lidarr: ${detail}`);
	}

	const text = await response.text();

	if (!response.ok) {
		throw new LidarrError(
			`Lidarr returned HTTP ${response.status}`,
			response.status,
			text
		);
	}

	try {
		return JSON.parse(text) as T;
	} catch {
		throw new LidarrError(
			'Lidarr returned a non-JSON response',
			response.status,
			text
		);
	}
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Test connectivity. Calls GET /api/v1/system/status. */
export function systemStatus(fetchFn?: FetchFn): Promise<SystemStatus> {
	return request<SystemStatus>('GET', '/api/v1/system/status', undefined, fetchFn);
}

/** Return all configured root folders. Used to populate the list-create dropdown. */
export function rootFolders(fetchFn?: FetchFn): Promise<RootFolder[]> {
	return request<RootFolder[]>('GET', '/api/v1/rootfolder', undefined, fetchFn);
}

/** Return every artist currently in Lidarr. */
export function listArtists(fetchFn?: FetchFn): Promise<LidarrArtist[]> {
	return request<LidarrArtist[]>('GET', '/api/v1/artist', undefined, fetchFn);
}

/**
 * Look up an artist by MusicBrainz MBID.
 * Returns null if Lidarr does not know about this artist.
 */
export async function getArtistByMbid(
	mbid: string,
	fetchFn?: FetchFn
): Promise<LidarrArtist | null> {
	const artists = await listArtists(fetchFn);
	return artists.find((a) => a.foreignArtistId === mbid) ?? null;
}

/** Add a new artist to Lidarr. */
export function addArtist(
	payload: AddArtistPayload,
	fetchFn?: FetchFn
): Promise<LidarrArtist> {
	return request<LidarrArtist>('POST', '/api/v1/artist', payload, fetchFn);
}

/**
 * Update an existing artist record.
 * Used for ownership transfer (changing rootFolderPath).
 * Pass the full artist object back — Lidarr requires it.
 */
export function updateArtist(
	artist: LidarrArtist,
	fetchFn?: FetchFn
): Promise<LidarrArtist> {
	return request<LidarrArtist>('PUT', `/api/v1/artist/${artist.id}`, artist, fetchFn);
}

/** Return all albums for an artist, or all albums if no artistId is provided. */
export function getAlbums(artistId?: number, fetchFn?: FetchFn): Promise<LidarrAlbum[]> {
	const path = artistId !== undefined ? `/api/v1/album?artistId=${artistId}` : '/api/v1/album';
	return request<LidarrAlbum[]>(
		'GET',
		path,
		undefined,
		fetchFn
	);
}

/**
 * Update an album record (e.g. set monitored = true for Scenario C).
 * Pass the full album object back.
 */
export function updateAlbum(album: LidarrAlbum, fetchFn?: FetchFn): Promise<LidarrAlbum> {
	return request<LidarrAlbum>('PUT', `/api/v1/album/${album.id}`, album, fetchFn);
}

/** Return all tracks for an artist. */
export function getTracks(artistId: number, fetchFn?: FetchFn): Promise<LidarrTrack[]> {
	return request<LidarrTrack[]>(
		'GET',
		`/api/v1/track?artistId=${artistId}`,
		undefined,
		fetchFn
	);
}

/**
 * Update a track record (e.g. set monitored = true for Scenario B).
 * Pass the full track object back.
 */
export function updateTrack(track: LidarrTrack, fetchFn?: FetchFn): Promise<LidarrTrack> {
	return request<LidarrTrack>('PUT', `/api/v1/track/${track.id}`, track, fetchFn);
}

/**
 * Return all downloaded track files for an artist.
 * Used by the mirror backfill job to enumerate files that need copying.
 */
export function getTrackFiles(
	artistId: number,
	fetchFn?: FetchFn
): Promise<LidarrTrackFile[]> {
	return request<LidarrTrackFile[]>(
		'GET',
		`/api/v1/trackfile?artistId=${artistId}`,
		undefined,
		fetchFn
	);
}

/**
 * Trigger a named Lidarr search command.
 *
 * @param name  `ArtistSearch` | `AlbumSearch` | `TrackSearch`
 * @param body  Command-specific payload, e.g. `{ artistId: 42 }` or `{ trackIds: [1, 2] }`
 */
export function runCommand(
	name: 'ArtistSearch' | 'AlbumSearch' | 'TrackSearch',
	body: Record<string, unknown>,
	fetchFn?: FetchFn
): Promise<LidarrCommand> {
	return request<LidarrCommand>('POST', '/api/v1/command', { name, ...body }, fetchFn);
}
