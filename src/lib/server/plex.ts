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

/**
 * Pull every attribute from each occurrence of `<tagName ...>` into a flat
 * object. Tag matching is case-insensitive so callers don't have to probe
 * every casing Plex might serve (`<user>` vs `<User>`); the trailing `\s`
 * still prevents prefix collisions like `<UserList ...>` matching `User`.
 *
 * Attribute names allow any characters that XML 1.0 permits in a Name
 * except whitespace, `=`, `/`, `>`, and quote chars — so namespaced
 * (`xml:lang`) and hyphenated (`data-foo`) attributes are captured too.
 * Values are read from double-quoted strings only (Plex always uses those).
 */
function parseXmlAttributes(xml: string, tagName: string): Array<Record<string, string>> {
	const result: Array<Record<string, string>> = [];
	const tagRegex = new RegExp(
		`<${tagName}\\s([^>]*?)/?>|<${tagName}\\s([^>]*?)>`,
		'gi'
	);
	for (const m of xml.matchAll(tagRegex)) {
		const attrText = m[1] ?? m[2] ?? '';
		const attrs: Record<string, string> = {};
		for (const am of attrText.matchAll(/([^\s=/>"']+)="([^"]*)"/g)) {
			attrs[am[1]] = am[2];
		}
		result.push(attrs);
	}
	return result;
}

async function plexTvGet(
	url: string,
	adminToken: string,
	fn: FetchFn,
	accept: 'json' | 'xml' = 'xml'
): Promise<{ status: number; text: string; contentType: string }> {
	const resp = await fn(url, {
		method: 'GET',
		headers: plexHeaders(adminToken, {
			Accept: accept === 'json' ? 'application/json' : 'application/xml'
		}),
		signal: AbortSignal.timeout(15_000)
	});
	return {
		status: resp.status,
		text: await resp.text(),
		contentType: resp.headers.get('content-type') ?? ''
	};
}

/**
 * Result of querying the shared_servers endpoint. Carries enough context
 * for the caller to distinguish "this user isn't shared" from "the response
 * shape changed and we parsed nothing usable".
 */
interface SharedServerLookup {
	/** userID → accessToken. Only contains entries where both fields parsed. */
	tokens: Map<number, string>;
	/** Number of <SharedServer> elements we saw in the response, valid or not. */
	rawElementCount: number;
	/** Entries that had a SharedServer element but missing/unparseable userID or accessToken. */
	malformedCount: number;
}

/**
 * Fetch the per-server access tokens for every user with whom this server
 * is shared.
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
): Promise<SharedServerLookup> {
	const url = `https://plex.tv/api/servers/${machineId}/shared_servers`;
	const { status, text } = await plexTvGet(url, adminToken, fn);
	if (status !== 200) {
		throw new PlexError(
			`plex.tv returned HTTP ${status} for shared_servers`,
			status,
			text
		);
	}

	const tokens = new Map<number, string>();
	let malformedCount = 0;
	const elements = parseXmlAttributes(text, 'SharedServer');
	for (const attrs of elements) {
		const userId = attrs.userID ? parseInt(attrs.userID, 10) : NaN;
		const token = attrs.accessToken;
		if (!Number.isNaN(userId) && token) {
			tokens.set(userId, token);
		} else {
			malformedCount++;
		}
	}
	return { tokens, rawElementCount: elements.length, malformedCount };
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
	// Ask for JSON explicitly. plex.tv has been observed to ignore Accept and
	// serve XML for this endpoint anyway, so we route on the response's
	// Content-Type header rather than guessing from the body. Both shapes
	// carry the same id/title/username at the top of the document.
	const { status, text, contentType } = await plexTvGet(
		'https://plex.tv/api/v2/user',
		adminToken,
		fn,
		'json'
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

	const isJson = contentType.toLowerCase().includes('json');
	if (isJson) {
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
			// Server claimed JSON but body wasn't parseable — fall through to XML.
		}
	}

	if (id === undefined) {
		// XML path. parseXmlAttributes is case-insensitive so this single call
		// covers <user>, <User>, etc.
		const userAttrs = parseXmlAttributes(text, 'user')[0];
		if (userAttrs) {
			const parsedId = userAttrs.id ? parseInt(userAttrs.id, 10) : NaN;
			if (!Number.isNaN(parsedId)) id = parsedId;
			title = userAttrs.title ?? userAttrs.friendlyName ?? userAttrs.username;
			username = userAttrs.username;
		}
	}

	if (id === undefined) {
		throw new PlexError(
			`plex.tv /api/v2/user response could not be parsed (content-type: ${contentType || 'unset'})`,
			status,
			text.slice(0, 500)
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
	console.log(
		`[plex] shared_servers: ${shared.tokens.size} valid token(s), ` +
			`${shared.rawElementCount} <SharedServer> element(s), ${shared.malformedCount} malformed`
	);

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

	const knownUserIds = [...shared.tokens.keys()];

	for (const u of homeUsers) {
		if (u.id === admin.id) continue; // already added as admin
		const token = shared.tokens.get(u.id);
		if (token) {
			users.push({ id: u.id, title: u.title, accessToken: token });
			continue;
		}
		failures.push({
			id: u.id,
			title: u.title,
			reason: explainMissingShare(u.id, shared, knownUserIds)
		});
	}

	return { users, failures };
}

/**
 * Build a context-rich reason for why a home user has no shared_servers
 * entry. Distinguishes "nobody is shared", "shape changed / parse failed",
 * and "this user specifically isn't in the share list".
 */
function explainMissingShare(
	userId: number,
	shared: SharedServerLookup,
	knownUserIds: number[]
): string {
	if (shared.rawElementCount === 0) {
		return (
			`No <SharedServer> entries returned by plex.tv shared_servers — ` +
			`either no users are shared with this server, or the response shape changed. ` +
			`Verify in Plex → Settings → Users & Sharing that this user has at least one library section shared.`
		);
	}
	if (shared.tokens.size === 0 && shared.malformedCount > 0) {
		return (
			`shared_servers returned ${shared.malformedCount} entry/entries but none had ` +
			`both userID and accessToken — likely a Plex response-shape change. ` +
			`Check the server logs for the raw XML.`
		);
	}
	const sample = knownUserIds.slice(0, 5).join(', ');
	const suffix =
		knownUserIds.length > 5 ? `, … (+${knownUserIds.length - 5} more)` : '';
	const malformedNote =
		shared.malformedCount > 0
			? ` (${shared.malformedCount} malformed entry/entries also seen)`
			: '';
	return (
		`No shared_servers entry for userID ${userId}. ` +
		`Library is shared with ${shared.tokens.size} other user(s) [${sample}${suffix}]${malformedNote}. ` +
		`Share a library section with this user in Plex, then refresh.`
	);
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
		const token = shared.tokens.get(plexUserId);
		if (!token) {
			const knownUserIds = [...shared.tokens.keys()];
			console.error(
				`[plex] getUserAccessToken: no shared_servers entry for user ${plexUserId}. ` +
					`Saw ${shared.rawElementCount} <SharedServer> element(s), ` +
					`${shared.tokens.size} valid token(s) [${knownUserIds.slice(0, 10).join(', ')}], ` +
					`${shared.malformedCount} malformed.`
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
 * Diagnostic detail for a track-search miss.
 *
 * `rawCount` is how many tracks Plex returned for the title query before we
 * filtered by artist. `topCandidate` is the closest non-match (highest result)
 * — useful for spotting metadata drift like "Track (Remastered 2011)" vs the
 * canonical "Track" title in Lidarr.
 */
export interface SearchTrackResult {
	track: PlexTrack | null;
	rawCount: number;
	topCandidate?: { title: string; artist: string };
	matchedBy?: 'exact' | 'fuzzy-artist-substring' | 'title-only';
}

/**
 * Search for a track in the Plex library by artist name and track title,
 * returning both the match and diagnostic context for misses.
 *
 * Uses the admin token: ratingKeys are library-wide and identical across
 * users, so the lookup itself can run as the owner.
 */
export async function searchTrackDiagnostic(
	artistName: string,
	trackTitle: string,
	sectionId: string,
	fetchFn?: FetchFn
): Promise<SearchTrackResult> {
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
	if (exact) {
		return { track: exact, rawCount: results.length, matchedBy: 'exact' };
	}

	const fuzzy = results.find(
		(t) =>
			t.title.toLowerCase() === titleLower &&
			t.grandparentTitle?.toLowerCase().includes(artistLower)
	);
	if (fuzzy) {
		return { track: fuzzy, rawCount: results.length, matchedBy: 'fuzzy-artist-substring' };
	}

	const titleOnly = results.find((t) => t.title.toLowerCase() === titleLower);
	if (titleOnly) {
		return { track: titleOnly, rawCount: results.length, matchedBy: 'title-only' };
	}

	const top = results[0];
	return {
		track: null,
		rawCount: results.length,
		topCandidate: top
			? { title: top.title, artist: top.grandparentTitle ?? '(unknown artist)' }
			: undefined
	};
}

/**
 * Backwards-compatible search wrapper that returns just the track or null.
 * Prefer `searchTrackDiagnostic` for new callers that want to log misses.
 */
export async function searchTrack(
	artistName: string,
	trackTitle: string,
	sectionId: string,
	fetchFn?: FetchFn
): Promise<PlexTrack | null> {
	const r = await searchTrackDiagnostic(artistName, trackTitle, sectionId, fetchFn);
	return r.track;
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
