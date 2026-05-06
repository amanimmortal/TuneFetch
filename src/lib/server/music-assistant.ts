/**
 * Music Assistant API client.
 *
 * MA is a second playlist sync target alongside Plex. Pushes child-user playlists
 * directly into MA because MA's Plex provider only surfaces the admin account's
 * playlists, leaving child-user playlists invisible.
 *
 * MA already has all tracks indexed from Plex, so library-only track searches
 * resolve correctly. We only need to create MA-native playlists with the right
 * track URIs.
 *
 * Transport: single endpoint POST /api with { command, args } envelope.
 * Bearer-token auth is mandatory (MA schema v28+).
 */

import { getMusicAssistantConfig } from './settings';

export class MusicAssistantError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
		public readonly body?: string
	) {
		super(message);
		this.name = 'MusicAssistantError';
	}
}

// MA schema types — only the fields we actually read.
interface MaTrack {
	item_id: string;
	provider: string;
	name: string;
	uri: string;
	artists?: Array<{ name: string }>;
}
export interface MaPlaylist {
	item_id: string;
	provider: string;
	name: string;
	uri: string;
	is_editable?: boolean;
}
interface MaSearchResults {
	tracks?: MaTrack[];
}

async function command<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
	const { baseUrl, token } = getMusicAssistantConfig();

	let response: Response;
	try {
		response = await fetch(`${baseUrl}/api`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`
			},
			body: JSON.stringify({ command: name, args }),
			signal: AbortSignal.timeout(15_000)
		});
	} catch (err) {
		throw new MusicAssistantError(`Network error contacting Music Assistant: ${String(err)}`);
	}

	const text = await response.text();
	if (!response.ok) {
		throw new MusicAssistantError(
			`MA command "${name}" returned HTTP ${response.status}`,
			response.status,
			text
		);
	}
	if (!text.trim()) return undefined as T;
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new MusicAssistantError(
			`MA command "${name}" returned non-JSON response`,
			response.status,
			text
		);
	}
}

/** Test connectivity. Issues a cheap library_items call to validate URL + token. */
export async function testConnection(): Promise<boolean> {
	// /info would be cheaper but doesn't require auth, so it wouldn't validate
	// the bearer token. library_items with limit=1 exercises the full auth path.
	await command<MaPlaylist[]>('music/playlists/library_items', { limit: 1, kwargs: {} });
	return true;
}

/**
 * Search MA library for a track. Returns the MA `uri` (e.g. "library://track/456"),
 * or null if no acceptable match is found.
 *
 * Search strategy (title-only primary search):
 * MA's search tokenizer chokes on certain characters (notably `/` in artist
 * names like "AC/DC"). Combining `artistName + trackTitle` into a single query
 * is fundamentally fragile. Instead we:
 *   1. Search by track title only — avoids tokenizer issues entirely.
 *   2. If title-only returns 0 results, retry with a sanitized (alphanumeric +
 *      spaces) artist name prepended — catches rare tracks with generic titles.
 *   3. Filter results client-side for artist and title match.
 *
 * Match strategy:
 * - Title: case-insensitive equality after normalization (lowercase, strip
 *   parentheticals, common punctuation, and curly quotes). Also accepts a
 *   word-bounded suffix like "Thunder - Single Version" matching "Thunder",
 *   without letting "Thunder" match "Thunderstruck".
 * - Artist: alphanumeric-only comparison so "AC/DC" matches "AC DC" or "ACDC".
 *   Bidirectional substring so "Imagine Dragons" matches "imagine dragons feat. ...".
 *   When MA returns an `ItemMapping` (no `artists[]` field), we trust the
 *   search result since the query already included the artist name.
 *
 * On a miss, logs the top candidates MA returned so the user can diagnose
 * whether the search is too narrow or the matcher is too strict.
 */
export async function searchTrack(
	artistName: string,
	trackTitle: string
): Promise<string | null> {
	// Primary search: title-only to prevent MA tokenizer issues with artist names
	// containing special characters (e.g. "AC/DC", "GZA/Genius")
	let results = await command<MaSearchResults>('music/search', {
		search_query: trackTitle,
		media_types: ['track'],
		limit: 25
	});

	let tracks = results.tracks ?? [];

	// Fallback: if title-only returned nothing, retry with sanitized artist + title.
	// Sanitization strips all non-alphanumeric chars so "AC/DC" becomes "AC DC".
	if (tracks.length === 0) {
		const sanitizedArtist = artistName.replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
		if (sanitizedArtist) {
			results = await command<MaSearchResults>('music/search', {
				search_query: `${sanitizedArtist} ${trackTitle}`,
				media_types: ['track'],
				limit: 25
			});
			tracks = results.tracks ?? [];
		}
	}

	if (tracks.length === 0) {
		console.log(`[ma-sync] MA search returned 0 tracks for "${artistName} - ${trackTitle}"`);
		return null;
	}

	const wantTitle = normalizeForMatch(trackTitle);

	for (const t of tracks) {
		if (!t.uri || !t.name) continue;
		if (!titleMatches(t.name, wantTitle)) continue;
		if (!artistMatches(t.artists, artistName)) continue;
		return t.uri;
	}

	const candidates = tracks
		.slice(0, 5)
		.map((t) => {
			const a = t.artists?.[0]?.name;
			return a ? `"${t.name}" by ${a}` : `"${t.name}"`;
		})
		.join(', ');
	console.log(
		`[ma-sync] No acceptable MA match for "${artistName} - ${trackTitle}" ` +
			`among ${tracks.length} result(s). Top: ${candidates}`
	);
	return null;
}

/**
 * Normalize a string for title matching: lowercase, strip parenthetical
 * suffixes (versions, "(feat. X)"), common punctuation, and curly quotes.
 * Preserves word boundaries.
 */
function normalizeForMatch(s: string): string {
	return s
		.toLowerCase()
		.replace(/\([^)]*\)/g, '')
		.replace(/[’‘'`"]/g, '')
		.replace(/[.,!?/]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Strip everything except a-z and 0-9 — used for artist names where
 * "AC/DC", "AC DC", and "ACDC" should all be considered equivalent. */
function alphanumOnly(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function titleMatches(actual: string, wantNormalized: string): boolean {
	const a = normalizeForMatch(actual);
	if (a === wantNormalized) return true;
	// Allow a suffix variation like "Thunder - Single Version" to match
	// "Thunder", but require a word boundary so "Thunderstruck" doesn't
	// match "Thunder".
	return a.startsWith(wantNormalized + ' ') || a.startsWith(wantNormalized + '-');
}

function artistMatches(
	artists: Array<{ name: string }> | undefined,
	wantArtist: string
): boolean {
	// MA can return an `ItemMapping` (no artists[]) instead of a full Track.
	// In that case trust the search since the query already included the
	// artist name.
	if (!artists || artists.length === 0) return true;
	const wantA = alphanumOnly(wantArtist);
	return artists.some((a) => {
		const an = alphanumOnly(a.name);
		return an === wantA || an.includes(wantA) || wantA.includes(an);
	});
}

/** Find a playlist by exact name. Returns null if none match. */
export async function findPlaylistByName(name: string): Promise<MaPlaylist | null> {
	// `kwargs: {}` is required by the schema — Python **kwargs artifact.
	const playlists = await command<MaPlaylist[]>('music/playlists/library_items', {
		search: name,
		limit: 50,
		kwargs: {}
	});
	return playlists.find((p) => p.name === name && p.is_editable !== false) ?? null;
}

/** Create a new MA-native playlist. */
export async function createPlaylist(name: string): Promise<MaPlaylist> {
	return command<MaPlaylist>('music/playlists/create_playlist', { name });
}

/** Fetch a playlist by id; returns null if it no longer exists. */
export async function getPlaylist(
	itemId: string,
	providerInstanceIdOrDomain: string
): Promise<MaPlaylist | null> {
	try {
		return await command<MaPlaylist>('music/playlists/get', {
			item_id: itemId,
			provider_instance_id_or_domain: providerInstanceIdOrDomain
		});
	} catch (err) {
		if (err instanceof MusicAssistantError && err.status === 404) return null;
		throw err;
	}
}

/** Return the URIs of tracks currently in an MA playlist, used for diffing. */
export async function getPlaylistTrackUris(
	itemId: string,
	providerInstanceIdOrDomain: string
): Promise<Set<string>> {
	// Server signature is AsyncGenerator[Track, None]; over HTTP this is
	// expected to be collected into a JSON array. If the live response turns
	// out to be a streaming format, switch this single call to the WebSocket
	// transport — that's the narrowest place to change.
	const tracks = await command<MaTrack[]>('music/playlists/playlist_tracks', {
		item_id: itemId,
		provider_instance_id_or_domain: providerInstanceIdOrDomain
	});
	return new Set(tracks.map((t) => t.uri).filter(Boolean));
}

/**
 * Add tracks to an MA playlist. Returns immediately — MA performs the work
 * asynchronously and returns a BackgroundTask handle which we discard.
 * Caller is expected to have already diffed against existing tracks.
 */
export async function addTracksToPlaylist(
	dbPlaylistId: string,
	trackUris: string[]
): Promise<void> {
	if (trackUris.length === 0) return;
	await command<unknown>('music/playlists/add_playlist_tracks', {
		db_playlist_id: dbPlaylistId,
		uris: trackUris
	});
}
