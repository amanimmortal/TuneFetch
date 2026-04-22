/**
 * Plex Media Server API client.
 *
 * Follows the same pattern as the existing `lidarr.ts`:
 * - Reads config from the settings table at call time.
 * - Applies a 15-second timeout per request.
 * - Throws PlexError on non-2xx responses or network failures.
 *
 * Authentication: Plex uses `X-Plex-Token` header. The admin token is used
 * for server-level operations; per-user tokens are required for creating
 * playlists "as" a specific managed user.
 */

import { getSetting, SETTING_KEYS } from './settings';

// ── Error type ────────────────────────────────────────────────────────────────

export class PlexError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
		public readonly body?: string
	) {
		super(message);
		this.name = 'PlexError';
	}
}

/**
 * Walk the cause chain of a fetch failure into a readable string.
 * (Same utility as lidarr.ts.)
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

// ── Config ────────────────────────────────────────────────────────────────────

export interface PlexConfig {
	baseUrl: string;
	adminToken: string;
}

/** Read and validate Plex config from settings. Throws PlexError if unset. */
function readConfig(): PlexConfig {
	const baseUrl = getSetting(SETTING_KEYS.PLEX_URL);
	const adminToken = getSetting(SETTING_KEYS.PLEX_ADMIN_TOKEN);
	if (!baseUrl || !adminToken) {
		throw new PlexError(
			'Plex is not configured. Set Plex URL and admin token in Settings.'
		);
	}
	return { baseUrl: baseUrl.replace(/\/+$/, ''), adminToken };
}

// ── Response types ────────────────────────────────────────────────────────────

/** Top-level identity response from GET / */
export interface PlexIdentity {
	machineIdentifier: string;
	version: string;
	friendlyName?: string;
	[key: string]: unknown;
}

/** A library section (e.g. Music, Movies). */
export interface PlexLibrarySection {
	key: string;
	title: string;
	type: string;
	/** The agent used for this library (e.g. 'tv.plex.agents.music'). */
	agent?: string;
	[key: string]: unknown;
}

/** A managed/home user from plex.tv. */
export interface PlexManagedUser {
	id: number;
	title: string; // display name
	username?: string;
	/** Per-server access token for this user. */
	accessToken: string;
	[key: string]: unknown;
}

/** A track result from a Plex library search. */
export interface PlexTrack {
	ratingKey: string;
	title: string;
	grandparentTitle?: string; // artist name
	parentTitle?: string; // album name
	type: string;
	[key: string]: unknown;
}

/** A Plex playlist. */
export interface PlexPlaylist {
	ratingKey: string;
	title: string;
	type: string;
	playlistType?: string;
	leafCount?: number;
	[key: string]: unknown;
}

/** A playlist item with its playlistItemID (needed for removal). */
export interface PlexPlaylistItem {
	ratingKey: string;
	title: string;
	playlistItemID: number;
	grandparentTitle?: string;
	parentTitle?: string;
	[key: string]: unknown;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

type FetchFn = typeof fetch;

/** Plex client identifier — identifies TuneFetch as the connecting app. */
const PLEX_CLIENT_ID = 'tunefetch';
const PLEX_PRODUCT = 'TuneFetch';

/**
 * Internal fetch wrapper for local PMS requests.
 * - Injects X-Plex-Token header.
 * - Applies a 15-second timeout.
 * - Requests JSON responses.
 * - Throws PlexError on non-2xx or network failures.
 */
async function request<T>(
	method: 'GET' | 'POST' | 'PUT' | 'DELETE',
	path: string,
	options: {
		token?: string;
		body?: unknown;
		fetchFn?: FetchFn;
		/** If true, read config; if false, use provided base URL. */
		baseUrl?: string;
		/** Query params to append. */
		params?: Record<string, string>;
	} = {}
): Promise<T> {
	const config = options.baseUrl ? null : readConfig();
	const base = options.baseUrl ?? config!.baseUrl;
	const token = options.token ?? config!.adminToken;
	const fetchFn = options.fetchFn ?? fetch;

	let url = `${base}${path}`;
	if (options.params) {
		const qs = new URLSearchParams(options.params).toString();
		url += (url.includes('?') ? '&' : '?') + qs;
	}

	let response: Response;
	try {
		response = await fetchFn(url, {
			method,
			headers: {
				'X-Plex-Token': token,
				'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
				'X-Plex-Product': PLEX_PRODUCT,
				Accept: 'application/json',
				'Content-Type': 'application/json'
			},
			body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
			signal: AbortSignal.timeout(15_000)
		});
	} catch (err: unknown) {
		const detail = describeFetchError(err);
		console.error(
			JSON.stringify({
				ts: new Date().toISOString(),
				tag: 'plex.fetchError',
				method,
				url,
				detail
			})
		);
		throw new PlexError(`Network error contacting Plex: ${detail}`);
	}

	const text = await response.text();

	if (!response.ok) {
		throw new PlexError(
			`Plex returned HTTP ${response.status}`,
			response.status,
			text
		);
	}

	if (!text.trim()) {
		return {} as T; // Some Plex endpoints return empty body on success
	}

	try {
		return JSON.parse(text) as T;
	} catch {
		throw new PlexError(
			'Plex returned a non-JSON response',
			response.status,
			text
		);
	}
}

// ── Public API — Server ───────────────────────────────────────────────────────

/** Test connectivity by fetching the server identity. */
export async function testConnection(fetchFn?: FetchFn): Promise<PlexIdentity> {
	const raw = await request<{ MediaContainer: PlexIdentity }>(
		'GET',
		'/',
		{ fetchFn }
	);
	return raw.MediaContainer;
}

/** List all library sections. Used to let users pick a music library. */
export async function getLibrarySections(
	fetchFn?: FetchFn
): Promise<PlexLibrarySection[]> {
	const raw = await request<{
		MediaContainer: { Directory?: PlexLibrarySection[] };
	}>('GET', '/library/sections', { fetchFn });
	return raw.MediaContainer.Directory ?? [];
}

/** Trigger a library section scan so newly downloaded files are indexed. */
export async function refreshLibrarySection(
	sectionId: string,
	fetchFn?: FetchFn
): Promise<void> {
	await request('GET', `/library/sections/${sectionId}/refresh`, { fetchFn });
}

// ── Public API — Managed Users ────────────────────────────────────────────────

/**
 * Enumerate managed/home users and their per-server access tokens.
 *
 * Calls the plex.tv API (not the local PMS) to get shared servers,
 * then extracts the user list with their tokens.
 *
 * Note: This is a plex.tv cloud call, not a local PMS call.
 */
export async function getManagedUsers(
	fetchFn?: FetchFn
): Promise<PlexManagedUser[]> {
	const config = readConfig();
	const fn = fetchFn ?? fetch;

	// First get the server's machine identifier
	const identity = await testConnection(fn);
	const machineId = identity.machineIdentifier;

	// Get resources from plex.tv to find our server and its shared users
	const resourcesUrl =
		`https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1`;

	let response: Response;
	try {
		response = await fn(resourcesUrl, {
			method: 'GET',
			headers: {
				'X-Plex-Token': config.adminToken,
				'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
				Accept: 'application/json'
			},
			signal: AbortSignal.timeout(15_000)
		});
	} catch (err: unknown) {
		throw new PlexError(`Network error contacting plex.tv: ${describeFetchError(err)}`);
	}

	if (!response.ok) {
		throw new PlexError(
			`plex.tv returned HTTP ${response.status}`,
			response.status,
			await response.text()
		);
	}

	const resources = (await response.json()) as Array<{
		name: string;
		clientIdentifier: string;
		provides: string;
		accessToken?: string;
		[key: string]: unknown;
	}>;

	// The admin user's token is the one we already have.
	// To get managed user tokens, we need to hit the shared_servers endpoint.
	const sharedUrl =
		`https://plex.tv/api/v2/home/users`;

	let usersResponse: Response;
	try {
		usersResponse = await fn(sharedUrl, {
			method: 'GET',
			headers: {
				'X-Plex-Token': config.adminToken,
				'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
				Accept: 'application/json'
			},
			signal: AbortSignal.timeout(15_000)
		});
	} catch (err: unknown) {
		throw new PlexError(`Network error fetching managed users: ${describeFetchError(err)}`);
	}

	if (!usersResponse.ok) {
		throw new PlexError(
			`plex.tv returned HTTP ${usersResponse.status} for managed users`,
			usersResponse.status,
			await usersResponse.text()
		);
	}

	const usersData = (await usersResponse.json()) as {
		users?: Array<{
			id: number;
			title: string;
			username?: string;
			[key: string]: unknown;
		}>;
		[key: string]: unknown;
	};

	const users: PlexManagedUser[] = [];

	// For each user, we need their per-server access token.
	// The admin user can switch to a managed user via plex.tv API.
	for (const user of usersData.users ?? []) {
		// Try to get a per-server token for this user by "switching" to them
		try {
			const switchUrl = `https://plex.tv/api/v2/home/users/${user.id}/switch`;
			const switchResponse = await fn(switchUrl, {
				method: 'POST',
				headers: {
					'X-Plex-Token': config.adminToken,
					'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
					Accept: 'application/json'
				},
				signal: AbortSignal.timeout(15_000)
			});

			if (switchResponse.ok) {
				const switchData = (await switchResponse.json()) as {
					authToken?: string;
					[key: string]: unknown;
				};
				if (switchData.authToken) {
					users.push({
						id: user.id,
						title: user.title,
						username: user.username,
						accessToken: switchData.authToken
					});
				}
			}
		} catch (err) {
			console.warn(`[plex] Failed to get token for user "${user.title}":`, err);
		}
	}

	// Re-switch back to admin to restore the admin context
	// (The admin token itself is still valid, this is just best practice)

	return users;
}

// ── Public API — Track Search ─────────────────────────────────────────────────

/**
 * Search for a track in the Plex library by artist name and track title.
 *
 * Returns the first matching track's ratingKey, or null if not found.
 * Uses the configured library section for scoped search.
 */
export async function searchTrack(
	artistName: string,
	trackTitle: string,
	fetchFn?: FetchFn
): Promise<PlexTrack | null> {
	const sectionId = getSetting(SETTING_KEYS.PLEX_LIBRARY_SECTION_ID);
	if (!sectionId) {
		throw new PlexError('Plex music library section is not configured.');
	}

	// Search by track title within the music library section.
	// Plex search uses the hub endpoint or the direct search endpoint.
	const searchQuery = encodeURIComponent(trackTitle);
	const raw = await request<{
		MediaContainer: { Metadata?: PlexTrack[] };
	}>(
		'GET',
		`/library/sections/${sectionId}/search?type=10&query=${searchQuery}`,
		{ fetchFn }
	);

	const results = raw.MediaContainer.Metadata ?? [];

	// Filter to tracks matching the artist name (case-insensitive)
	const artistLower = artistName.toLowerCase();
	const titleLower = trackTitle.toLowerCase();

	// Exact match first
	const exact = results.find(
		(t) =>
			t.title.toLowerCase() === titleLower &&
			(t.grandparentTitle?.toLowerCase() === artistLower)
	);
	if (exact) return exact;

	// Fuzzy: artist contains match
	const fuzzy = results.find(
		(t) =>
			t.title.toLowerCase() === titleLower &&
			t.grandparentTitle?.toLowerCase().includes(artistLower)
	);
	if (fuzzy) return fuzzy;

	// Last resort: title-only match
	const titleOnly = results.find(
		(t) => t.title.toLowerCase() === titleLower
	);
	return titleOnly ?? null;
}

// ── Public API — Playlist CRUD ────────────────────────────────────────────────

/**
 * Create a new playlist for a specific user.
 *
 * @param userToken - The Plex user's access token (playlists are per-user).
 * @param title - Playlist title.
 * @param ratingKeys - Initial set of track ratingKeys to include.
 * @returns The created playlist's ratingKey (playlist ID).
 */
export async function createPlaylist(
	userToken: string,
	title: string,
	ratingKeys: string[],
	fetchFn?: FetchFn
): Promise<string> {
	const config = readConfig();
	const sectionId = getSetting(SETTING_KEYS.PLEX_LIBRARY_SECTION_ID);

	// Build the URI for the initial items
	const uri = `server://${await getMachineId(fetchFn)}/com.plexapp.plugins.library/library/metadata/${ratingKeys.join(',')}`;

	const raw = await request<{
		MediaContainer: { Metadata?: PlexPlaylist[] };
	}>('POST', '/playlists', {
		token: userToken,
		fetchFn,
		params: {
			type: 'audio',
			title,
			smart: '0',
			uri
		}
	});

	const playlist = raw.MediaContainer?.Metadata?.[0];
	if (!playlist?.ratingKey) {
		throw new PlexError('Playlist creation succeeded but no ratingKey returned');
	}
	return playlist.ratingKey;
}

/**
 * Add tracks to an existing playlist.
 */
export async function addToPlaylist(
	userToken: string,
	playlistId: string,
	ratingKeys: string[],
	fetchFn?: FetchFn
): Promise<void> {
	const machineId = await getMachineId(fetchFn);
	const uri = `server://${machineId}/com.plexapp.plugins.library/library/metadata/${ratingKeys.join(',')}`;

	await request('PUT', `/playlists/${playlistId}/items`, {
		token: userToken,
		fetchFn,
		params: { uri }
	});
}

/**
 * Remove a specific item from a playlist by its playlistItemID.
 */
export async function removeFromPlaylist(
	userToken: string,
	playlistId: string,
	playlistItemId: string,
	fetchFn?: FetchFn
): Promise<void> {
	await request(
		'DELETE',
		`/playlists/${playlistId}/items/${playlistItemId}`,
		{ token: userToken, fetchFn }
	);
}

/**
 * Get all items in a playlist (with their playlistItemIDs).
 */
export async function getPlaylistItems(
	userToken: string,
	playlistId: string,
	fetchFn?: FetchFn
): Promise<PlexPlaylistItem[]> {
	const raw = await request<{
		MediaContainer: { Metadata?: PlexPlaylistItem[] };
	}>('GET', `/playlists/${playlistId}/items`, {
		token: userToken,
		fetchFn
	});
	return raw.MediaContainer.Metadata ?? [];
}

/**
 * List all playlists for a specific user.
 */
export async function listPlaylists(
	userToken: string,
	fetchFn?: FetchFn
): Promise<PlexPlaylist[]> {
	const raw = await request<{
		MediaContainer: { Metadata?: PlexPlaylist[] };
	}>('GET', '/playlists', {
		token: userToken,
		fetchFn
	});
	return raw.MediaContainer.Metadata ?? [];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Cache the machine identifier to avoid repeated calls. */
let _machineId: string | null = null;

async function getMachineId(fetchFn?: FetchFn): Promise<string> {
	if (_machineId) return _machineId;
	const identity = await testConnection(fetchFn);
	_machineId = identity.machineIdentifier;
	return _machineId;
}
