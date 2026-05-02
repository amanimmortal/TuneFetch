/**
 * Plex Media Server API client.
 *
 * Token model (mirrors python-plexapi):
 *   - Admin token: stored in settings as PLEX_ADMIN_TOKEN. Used for all
 *     server-level operations (identity, sections, sync triggers) and for
 *     playlist operations performed AS the server owner.
 *   - Per-user token: obtained from
 *       GET https://plex.tv/api/servers/{machineId}/shared_servers
 *     which is the canonical, server-scoped accessToken for each user
 *     who has been granted library access. These tokens are accepted by
 *     the local PMS for that user's playlists, library views, etc.
 *
 * What we deliberately do NOT do anymore:
 *   - POST /api/home/users/{id}/switch — returns a plex.tv cloud session
 *     token that the local PMS rejects.
 *   - POST /users/sign_in.json — exchanges one cloud token for another
 *     cloud token; still not accepted by the local PMS.
 *   These were attempted in earlier iterations (see PLEX_REVIEW.md §10).
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

export interface PlexIdentity {
	machineIdentifier: string;
	version: string;
	friendlyName?: string;
	[key: string]: unknown;
}

export interface PlexLibrarySection {
	key: string;
	title: string;
	type: string;
	agent?: string;
	[key: string]: unknown;
}

export interface PlexManagedUser {
	id: number;
	title: string;
	username?: string;
	accessToken: string;
	/** True for the server owner (admin token). */
	isAdmin?: boolean;
	[key: string]: unknown;
}

export interface PlexManagedUserFailure {
	id: number;
	title: string;
	reason: string;
}

export interface GetManagedUsersResult {
	users: PlexManagedUser[];
	failures: PlexManagedUserFailure[];
}

export interface PlexTrack {
	ratingKey: string;
	title: string;
	grandparentTitle?: string;
	parentTitle?: string;
	type: string;
	[key: string]: unknown;
}

export interface PlexPlaylist {
	ratingKey: string;
	title: string;
	type: string;
	playlistType?: string;
	leafCount?: number;
	[key: string]: unknown;
}

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

const PLEX_CLIENT_ID = 'tunefetch';
const PLEX_PRODUCT = 'TuneFetch';

/** Standard X-Plex-* headers sent on every request. */
function plexHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
	return {
		'X-Plex-Token': token,
		'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
		'X-Plex-Product': PLEX_PRODUCT,
		...extra
	};
}

/**
 * Internal fetch wrapper for local PMS requests.
 * - Injects X-Plex-Token + identifier headers.
 * - Applies a 15-second timeout.
 * - Throws PlexError on non-2xx or network failures.
 */
async function request<T>(
	method: 'GET' | 'POST' | 'PUT' | 'DELETE',
	path: string,
	options: {
		token?: string;
		body?: unknown;
		fetchFn?: FetchFn;
		baseUrl?: string;
		params?: Record<string, string>;
		/** 'json' (default) or 'xml'. */
		accept?: 'json' | 'xml';
	} = {}
): Promise<T> {
	const config = options.baseUrl ? null : readConfig();
	const base = options.baseUrl ?? config!.baseUrl;
	const token = options.token ?? config!.adminToken;
	const fetchFn = options.fetchFn ?? fetch;
	const accept = options.accept ?? 'json';

	let url = `${base}${path}`;
	if (options.params) {
		const qs = new URLSearchParams(options.params).toString();
		url += (url.includes('?') ? '&' : '?') + qs;
	}

	const headers = plexHeaders(token, {
		Accept: accept === 'json' ? 'application/json' : 'application/xml'
	});
	if (options.body !== undefined) {
		headers['Content-Type'] = 'application/json';
	}

	let response: Response;
	try {
		response = await fetchFn(url, {
			method,
			headers,
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
		return {} as T;
	}

	if (accept === 'xml') {
		return text as unknown as T;
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

export async function testConnection(fetchFn?: FetchFn): Promise<PlexIdentity> {
	const raw = await request<{ MediaContainer: PlexIdentity }>(
		'GET',
		'/',
		{ fetchFn }
	);
	return raw.MediaContainer;
}

export async function getLibrarySections(
	fetchFn?: FetchFn
): Promise<PlexLibrarySection[]> {
	const raw = await request<{
		MediaContainer: { Directory?: PlexLibrarySection[] };
	}>('GET', '/library/sections', { fetchFn });
	return raw.MediaContainer.Directory ?? [];
}

export async function refreshLibrarySection(
	sectionId: string,
	fetchFn?: FetchFn
): Promise<void> {
	await request('GET', `/library/sections/${sectionId}/refresh`, { fetchFn });
}

// ── plex.tv helpers ───────────────────────────────────────────────────────────

/** Pull every attribute from a tag's first occurrence into a flat object. */
function parseXmlAttributes(xml: string, tagName: string): Array<Record<string, string>> {
	const result: Array<Record<string, string>> = [];
	const tagRegex = new RegExp(
		`<${tagName}\\s([^>]*?)/?>|<${tagName}\\s([^>]*?)>`,
		'g'
	);
	for (const m of xml.matchAll(tagRegex)) {
		const attrText = m[1] ?? m[2] ?? '';
		const attrs: Record<string, string> = {};
		for (const am of attrText.matchAll(/(\w+)="([^"]*)"/g)) {
			attrs[am[1]] = am[2];
		}
		result.push(attrs);
	}
	return result;
}

async function plexTvGet(
	url: string,
	adminToken: string,
	fn: FetchFn
): Promise<{ status: number; text: string }> {
	const resp = await fn(url, {
		method: 'GET',
		headers: plexHeaders(adminToken),
		signal: AbortSignal.timeout(15_000)
	});
	return { status: resp.status, text: await resp.text() };
}

/**
 * Fetch the per-server access tokens for every user with whom this server
 * is shared. Returns Map<plexUserId, accessToken>.
 *
 * Endpoint: GET https://plex.tv/api/servers/{machineId}/shared_servers
 * (this is what python-plexapi's MyPlexUser.get_token reads).
 *
 * The admin/owner does NOT appear here — they don't share with themselves.
 */
async function getSharedServerTokens(
	machineId: string,
	adminToken: string,
	fn: FetchFn
): Promise<Map<number, string>> {
	const url = `https://plex.tv/api/servers/${machineId}/shared_servers`;
	const { status, text } = await plexTvGet(url, adminToken, fn);
	if (status !== 200) {
		throw new PlexError(
			`plex.tv returned HTTP ${status} for shared_servers`,
			status,
			text
		);
	}

	const map = new Map<number, string>();
	for (const attrs of parseXmlAttributes(text, 'SharedServer')) {
		const userId = attrs.userID ? parseInt(attrs.userID, 10) : NaN;
		const token = attrs.accessToken;
		if (!Number.isNaN(userId) && token) {
			map.set(userId, token);
		}
	}
	return map;
}

interface AdminAccount {
	id: number;
	title: string;
	username?: string;
}

/** Identify the server owner via plex.tv. Cached. */
let _adminAccount: AdminAccount | null = null;
async function getAdminAccount(
	adminToken: string,
	fn: FetchFn
): Promise<AdminAccount> {
	if (_adminAccount) return _adminAccount;
	const { status, text } = await plexTvGet(
		'https://plex.tv/api/v2/user',
		adminToken,
		fn
	);
	if (status !== 200) {
		throw new PlexError(
			`plex.tv returned HTTP ${status} for /api/v2/user`,
			status,
			text
		);
	}
	let id: number | undefined;
	let title: string | undefined;
	let username: string | undefined;
	try {
		const json = JSON.parse(text) as {
			id?: number;
			title?: string;
			username?: string;
			friendlyName?: string;
		};
		id = json.id;
		title = json.title ?? json.friendlyName ?? json.username;
		username = json.username;
	} catch {
		// /api/v2/user returns JSON; if not, surface as a config issue.
		throw new PlexError(
			'plex.tv /api/v2/user returned non-JSON response',
			status,
			text.slice(0, 300)
		);
	}
	if (!id) {
		throw new PlexError(
			'plex.tv /api/v2/user response missing id field',
			status,
			text.slice(0, 300)
		);
	}
	_adminAccount = { id, title: title ?? `Admin (${id})`, username };
	return _adminAccount;
}

// ── Public API — Managed Users ────────────────────────────────────────────────

/**
 * Enumerate the users who can be mapped to root folders in TuneFetch:
 *   - The server owner (admin), with their admin token.
 *   - Every Plex Home user who has library access on this server, with the
 *     per-server accessToken from /api/servers/{machineId}/shared_servers.
 *
 * Home users without any library shared with them are returned in `failures`.
 */
export async function getManagedUsers(
	fetchFn?: FetchFn
): Promise<GetManagedUsersResult> {
	const config = readConfig();
	const fn = fetchFn ?? fetch;

	// Identity gives us the machine identifier needed for shared_servers.
	const identity = await testConnection(fn);
	const machineId = identity.machineIdentifier;

	// Step 1: Home users (for friendly names + ids).
	const { status: huStatus, text: huText } = await plexTvGet(
		'https://plex.tv/api/home/users',
		config.adminToken,
		fn
	);
	if (huStatus !== 200) {
		throw new PlexError(
			`plex.tv returned HTTP ${huStatus} for /api/home/users`,
			huStatus,
			huText
		);
	}

	const homeUsers: Array<{ id: number; title: string }> = [];
	for (const attrs of parseXmlAttributes(huText, 'User')) {
		const id = attrs.id ? parseInt(attrs.id, 10) : NaN;
		const title = attrs.title ?? '';
		if (!Number.isNaN(id) && title) {
			homeUsers.push({ id, title });
		}
	}
	console.log(`[plex] Found ${homeUsers.length} home user(s) from plex.tv`);

	// Step 2: shared_servers token map.
	const shared = await getSharedServerTokens(machineId, config.adminToken, fn);

	// Step 3: admin account (so the owner can be mapped too).
	const admin = await getAdminAccount(config.adminToken, fn);

	const users: PlexManagedUser[] = [];
	const failures: PlexManagedUserFailure[] = [];

	// Always include the admin first.
	users.push({
		id: admin.id,
		title: admin.title,
		username: admin.username,
		accessToken: config.adminToken,
		isAdmin: true
	});

	for (const u of homeUsers) {
		if (u.id === admin.id) continue; // already added as admin
		const token = shared.get(u.id);
		if (token) {
			users.push({ id: u.id, title: u.title, accessToken: token });
		} else {
			failures.push({
				id: u.id,
				title: u.title,
				reason:
					'No library shared with this user on this server. Share at least one library section in Plex, then refresh.'
			});
		}
	}

	return { users, failures };
}

/**
 * Return a token usable against the local PMS for the given Plex user id.
 *
 * - If the id matches the server owner, returns the admin token.
 * - Otherwise looks up the per-server accessToken in shared_servers.
 *
 * Returns null if the user has no library access on this server (or any
 * other plex.tv error). Caller decides whether to fall back to a stored
 * token or surface the error.
 */
export async function getUserAccessToken(
	plexUserId: number,
	fetchFn?: FetchFn
): Promise<string | null> {
	const config = readConfig();
	const fn = fetchFn ?? fetch;

	try {
		const admin = await getAdminAccount(config.adminToken, fn);
		if (plexUserId === admin.id) {
			return config.adminToken;
		}
		const identity = await testConnection(fn);
		const shared = await getSharedServerTokens(
			identity.machineIdentifier,
			config.adminToken,
			fn
		);
		const token = shared.get(plexUserId);
		if (!token) {
			console.error(
				`[plex] getUserAccessToken: no shared_servers entry for user ${plexUserId}`
			);
			return null;
		}
		return token;
	} catch (err) {
		console.error(
			`[plex] getUserAccessToken error for user ${plexUserId}: ${describeFetchError(err)}`
		);
		return null;
	}
}

// ── Public API — Track Search ─────────────────────────────────────────────────

/**
 * Search for a track in the Plex library by artist name and track title.
 *
 * Uses the admin token: ratingKeys are library-wide and identical across
 * users, so the lookup itself can run as the owner.
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

	const exact = results.find(
		(t) =>
			t.title.toLowerCase() === titleLower &&
			t.grandparentTitle?.toLowerCase() === artistLower
	);
	if (exact) return exact;

	const fuzzy = results.find(
		(t) =>
			t.title.toLowerCase() === titleLower &&
			t.grandparentTitle?.toLowerCase().includes(artistLower)
	);
	if (fuzzy) return fuzzy;

	return results.find((t) => t.title.toLowerCase() === titleLower) ?? null;
}

// ── Public API — Playlist CRUD ────────────────────────────────────────────────

/**
 * Create a new audio playlist for a specific user.
 *
 * Sends the request the same way python-plexapi does:
 *   POST /playlists?uri=server://{machineId}/com.plexapp.plugins.library/library/metadata/{rk1,rk2,...}
 *        &type=audio&title={title}&smart=0
 * with X-Plex-Token: <userToken>, no body. Response is XML; we read the
 * ratingKey attribute from the first <Playlist> child of <MediaContainer>.
 */
export async function createPlaylist(
	userToken: string,
	title: string,
	ratingKeys: string[],
	fetchFn?: FetchFn
): Promise<string> {
	if (ratingKeys.length === 0) {
		throw new PlexError('createPlaylist requires at least one ratingKey');
	}
	const machineId = await getMachineId(fetchFn);
	const uri = `server://${machineId}/com.plexapp.plugins.library/library/metadata/${ratingKeys.join(',')}`;

	const xml = await request<string>('POST', '/playlists', {
		token: userToken,
		fetchFn,
		accept: 'xml',
		params: {
			type: 'audio',
			title,
			smart: '0',
			uri
		}
	});

	const playlists = parseXmlAttributes(xml, 'Playlist');
	const ratingKey = playlists[0]?.ratingKey;
	if (!ratingKey) {
		throw new PlexError(
			'Playlist creation succeeded but no ratingKey returned',
			undefined,
			typeof xml === 'string' ? xml.slice(0, 500) : ''
		);
	}
	return ratingKey;
}

export async function addToPlaylist(
	userToken: string,
	playlistId: string,
	ratingKeys: string[],
	fetchFn?: FetchFn
): Promise<void> {
	if (ratingKeys.length === 0) return;
	const machineId = await getMachineId(fetchFn);
	const uri = `server://${machineId}/com.plexapp.plugins.library/library/metadata/${ratingKeys.join(',')}`;

	await request('PUT', `/playlists/${playlistId}/items`, {
		token: userToken,
		fetchFn,
		accept: 'xml',
		params: { uri }
	});
}

export async function removeFromPlaylist(
	userToken: string,
	playlistId: string,
	playlistItemId: string,
	fetchFn?: FetchFn
): Promise<void> {
	await request(
		'DELETE',
		`/playlists/${playlistId}/items/${playlistItemId}`,
		{ token: userToken, fetchFn, accept: 'xml' }
	);
}

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

let _machineId: string | null = null;

async function getMachineId(fetchFn?: FetchFn): Promise<string> {
	if (_machineId) return _machineId;
	const identity = await testConnection(fetchFn);
	_machineId = identity.machineIdentifier;
	return _machineId;
}

/**
 * Reset all module-level caches (machine id, admin account).
 * Call when settings change.
 */
export function resetPlexCache(): void {
	_machineId = null;
	_adminAccount = null;
}
