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

/** A user whose token could not be retrieved in Step 2 of getManagedUsers(). */
export interface PlexManagedUserFailure {
	id: number;
	title: string;
	reason: string;
}

/** Return value of getManagedUsers(). */
export interface GetManagedUsersResult {
	users: PlexManagedUser[];
	failures: PlexManagedUserFailure[];
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
): Promise<GetManagedUsersResult> {
	const config = readConfig();
	const fn = fetchFn ?? fetch;

	// ── Step 1: List home users from plex.tv ─────────────────────────────────
	// NOTE: Must use /api/home/users (NOT /api/v2/home/users).
	// The v2 endpoint returns a different structure and the switch endpoint lives under v1.
	// Response is XML — parse the User elements.
	let usersResponse: Response;
	try {
		usersResponse = await fn('https://plex.tv/api/home/users', {
			method: 'GET',
			headers: {
				'X-Plex-Token': config.adminToken,
				'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
				'X-Plex-Product': PLEX_PRODUCT
				// No Accept: application/json — this endpoint returns XML
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

	// Parse the XML response to extract User elements (attribute order-independent)
	const xmlText = await usersResponse.text();
	const userElementMatches = [...xmlText.matchAll(/<User\s([^>]*)\/?>|<User\s([^>]*)>[\s\S]*?<\/User>/g)];

	const userList: Array<{ id: number; title: string }> = [];
	for (const m of userElementMatches) {
		const attrs = m[1] ?? m[2] ?? '';
		const idMatch = attrs.match(/\bid="(\d+)"/);
		const titleMatch = attrs.match(/\btitle="([^"]*)"/);  
		if (idMatch && titleMatch) {
			userList.push({ id: parseInt(idMatch[1], 10), title: titleMatch[1] });
		}
	}

	console.log(`[plex] Found ${userList.length} home user(s) from plex.tv`);

	if (userList.length === 0) {
		console.warn('[plex] No users parsed from /api/home/users XML. Raw (first 500 chars):', xmlText.substring(0, 500));
	}

	// ── Step 2: Get per-user token via switch ─────────────────────────────────
	// POST /api/home/users/{id}/switch → XML response with authenticationToken attribute
	const users: PlexManagedUser[] = [];
	const failures: PlexManagedUserFailure[] = [];

	for (const user of userList) {
		try {
			const switchUrl = `https://plex.tv/api/home/users/${user.id}/switch`;
			const switchResponse = await fn(switchUrl, {
				method: 'POST',
				headers: {
					'X-Plex-Token': config.adminToken,
					'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
					'X-Plex-Product': PLEX_PRODUCT
					// No Accept: application/json — returns XML
				},
				signal: AbortSignal.timeout(15_000)
			});

			if (switchResponse.ok) {
				const switchXml = await switchResponse.text();
				// Extract authenticationToken from XML attribute
				const tokenMatch = switchXml.match(/authenticationToken="([^"]+)"/);
				const token = tokenMatch?.[1];

				if (token) {
					users.push({
						id: user.id,
						title: user.title,
						accessToken: token
					});
				} else {
					const reason = `Switch succeeded but authenticationToken not found in XML. Response (first 500 chars): ${switchXml.substring(0, 500)}`;
					console.error(`[plex] ${reason}`);
					failures.push({ id: user.id, title: user.title, reason });
				}
			} else {
				const errText = await switchResponse.text();
				const reason = `HTTP ${switchResponse.status}: ${errText.substring(0, 200)}`;
				console.error(`[plex] Switch failed for "${user.title}" — ${reason}`);
				failures.push({ id: user.id, title: user.title, reason });
			}
		} catch (err) {
			const reason = describeFetchError(err);
			console.error(`[plex] Exception switching to user "${user.title}": ${reason}`);
			failures.push({ id: user.id, title: user.title, reason });
		}
	}

	return { users, failures };
}

// ── Public API — Track Search ─────────────────────────────────────────────────

/**
 * Search for a track in the Plex library by artist name and track title.
 *
 * @param sectionId - The Plex library section ID to search within (per-user).
 * Returns the first matching track, or null if not found.
 */
export async function searchTrack(
	artistName: string,
	trackTitle: string,
	sectionId: string,
	fetchFn?: FetchFn
): Promise<PlexTrack | null> {
	if (!sectionId) {
		throw new PlexError('No Plex library section ID provided for this user mapping.');
	}

	// Search by track title within the music library section (type=10 = track)
	const searchQuery = encodeURIComponent(trackTitle);
	const raw = await request<{
		MediaContainer: { Metadata?: PlexTrack[] };
	}>(
		'GET',
		`/library/sections/${sectionId}/search?type=10&query=${searchQuery}`,
		{ fetchFn }
	);

	const results = raw.MediaContainer.Metadata ?? [];

	const artistLower = artistName.toLowerCase();
	const titleLower = trackTitle.toLowerCase();

	// Exact match first
	const exact = results.find(
		(t) =>
			t.title.toLowerCase() === titleLower &&
			t.grandparentTitle?.toLowerCase() === artistLower
	);
	if (exact) return exact;

	// Fuzzy: artist name contains match
	const fuzzy = results.find(
		(t) =>
			t.title.toLowerCase() === titleLower &&
			t.grandparentTitle?.toLowerCase().includes(artistLower)
	);
	if (fuzzy) return fuzzy;

	// Last resort: title-only match
	return results.find((t) => t.title.toLowerCase() === titleLower) ?? null;
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
	// Build the URI for the initial items (no section ID needed for playlist creation)
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
