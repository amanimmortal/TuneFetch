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
 * Match strategy mirrors plex.ts: exact title match (case-insensitive), and the
 * artist name must appear as a substring of one of the track's artists.
 */
export async function searchTrack(
	artistName: string,
	trackTitle: string
): Promise<string | null> {
	const results = await command<MaSearchResults>('music/search', {
		search_query: `${artistName} ${trackTitle}`,
		media_types: ['track'],
		limit: 10,
		library_only: true
	});

	const tracks = results.tracks ?? [];
	const titleLower = trackTitle.toLowerCase();
	const artistLower = artistName.toLowerCase();

	for (const t of tracks) {
		if (t.name.toLowerCase() !== titleLower) continue;
		const artists = t.artists ?? [];
		const artistMatch = artists.some((a) => a.name.toLowerCase().includes(artistLower));
		if (artistMatch && t.uri) return t.uri;
	}
	return null;
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
