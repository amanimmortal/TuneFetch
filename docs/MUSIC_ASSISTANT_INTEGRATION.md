# Music Assistant Integration Spec

## Context

TuneFetch is a SvelteKit app (with a SQLite backend via `better-sqlite3`) that manages music lists,
syncs them to Lidarr for downloading, mirrors files across Plex library roots, and creates/updates
Plex playlists for each user. The codebase lives in `src/`.

This spec adds a second sync target: **Music Assistant (MA)**. After a Plex playlist sync, TuneFetch
will also create/update a matching playlist in MA. This is necessary because MA has a known
limitation where it only surfaces playlists from the single Plex account it was authenticated with
(the admin account), regardless of which credentials are used to add the Plex provider. Child user
playlists are invisible to MA. The fix is to have TuneFetch push those playlists into MA directly
using MA's own API.

MA already has all the music indexed (it reads from the same Plex server using the admin token), so
track searches against MA's library will resolve correctly. We just need to create MA-native
playlists containing the right tracks.

---

## Relevant existing files

Read these before implementing — they define patterns you must follow:

| File | Why it matters |
|------|----------------|
| `src/lib/server/settings.ts` | `SETTING_KEYS` enum, `getSetting`, `setSetting`, `getAllSettings` |
| `src/lib/server/plex.ts` | Pattern for an API client (typed fetch wrapper, error class, config via settings) |
| `src/lib/server/plex-sync.ts` | Pattern for a sync engine (reads DB, calls API, writes results back to DB). Also home of the `_retryWithBackoff` path that re-triggers syncs |
| `src/lib/server/crypto.ts` | `encrypt()` / `decrypt()` for secrets stored in settings — Plex tokens use this; MA bearer token must too |
| `src/lib/server/db.ts` | Migration pattern: `pragma('table_info(...)')` then conditional `ALTER TABLE` |
| `src/routes/api/plex/+server.ts` | The `sync` action you will extend |
| `src/routes/settings/+page.server.ts` | How settings are loaded and saved |
| `src/routes/settings/+page.svelte` | Settings UI pattern |
| `src/lib/server/schema.sql` | Full DB schema — `plex_playlists` and `plex_playlist_items` are the key tables |

---

## Confirmed Music Assistant API model

These shapes are confirmed from the live MA instance at `http://192.168.200.14:8095/api-docs/commands`
and the OpenAPI at `/openapi.json`. **No further probing is needed before implementation.**

### Transport

Single endpoint for everything:

```
POST {baseUrl}/api
Authorization: Bearer {token}
Content-Type: application/json

{ "command": "music/search", "args": { ... } }
```

Auth is **mandatory** as of MA schema version 28. The token is a long-lived bearer token the user
generates in the MA UI; we store it (encrypted) in settings.

### Commands we use

| Command | Args | Returns |
|---------|------|---------|
| `music/search` | `{ search_query, media_types: ["track"], limit: 10, library_only: true }` | `SearchResults` — `tracks[]` of `Track \| ItemMapping` |
| `music/playlists/library_items` | `{ search?: string, limit?: number, kwargs: {} }` | `Playlist[]` |
| `music/playlists/create_playlist` | `{ name }` | `Playlist` (use `.item_id` for subsequent calls) |
| `music/playlists/add_playlist_tracks` | `{ db_playlist_id, uris: string[] }` | `BackgroundTask` (async — fire-and-forget) |
| `music/playlists/playlist_tracks` | `{ item_id, provider_instance_id_or_domain }` | `Track[]` (collected from server-side AsyncGenerator) |
| `music/playlists/get` | `{ item_id, provider_instance_id_or_domain }` | `Playlist` (used for verifying a stored ID is still valid) |

### Track identity

`Track.uri` is the stable identifier (e.g. `library://track/456`). Use it everywhere — the bare
`item_id` is only meaningful when paired with a `provider`.

### Playlist provider

Created playlists default to MA's built-in library provider when `provider_instance_or_domain` is
omitted. `provider_instance_id_or_domain` for `playlist_tracks` / `get` of a created playlist is
typically `"library"` — confirm by inspecting the `Playlist.provider` field returned from create.

### Two behaviours still worth verifying live (one-shot tests, not blockers)

1. **Is `add_playlist_tracks` idempotent?** Add the same URI twice, then call `playlist_tracks` and
   check for duplicates. Determines whether we need to diff before adding.
2. **What does `playlist_tracks` look like over HTTP?** It's typed as `AsyncGenerator` server-side.
   Most likely the HTTP transport collects it into a JSON array; if it streams, we may need to use
   the WebSocket transport (`wss://host/ws`, or `ws://` for plaintext-only LAN deployments) for
   that one call.

---

## Step 1 — `src/lib/server/settings.ts`

Add two keys to the `SETTING_KEYS` object:

```ts
MUSIC_ASSISTANT_URL: 'music_assistant_url',
MUSIC_ASSISTANT_TOKEN: 'music_assistant_token',  // bearer token, encrypted at rest
```

Add a `getMusicAssistantConfig()` helper following the same pattern as `getPlexConfig()`. Both URL
and token are required — auth is mandatory in MA, so we fail fast if either is missing:

```ts
import { decrypt, isEncrypted } from './crypto';

export function getMusicAssistantConfig(): { baseUrl: string; token: string } {
  const baseUrl = getSetting(SETTING_KEYS.MUSIC_ASSISTANT_URL);
  const stored = getSetting(SETTING_KEYS.MUSIC_ASSISTANT_TOKEN);
  if (!baseUrl || !stored) {
    throw new Error(
      'Music Assistant URL and bearer token must be configured in Settings before using this feature.'
    );
  }
  const token = isEncrypted(stored) ? decrypt(stored) : stored;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

/** True when MA is configured. Used by sync engine to skip silently when not set up. */
export function isMusicAssistantConfigured(): boolean {
  return Boolean(
    getSetting(SETTING_KEYS.MUSIC_ASSISTANT_URL) &&
    getSetting(SETTING_KEYS.MUSIC_ASSISTANT_TOKEN)
  );
}
```

---

## Step 2 — Schema migration

Add a column to `plex_playlists` for the persisted MA playlist ID. This avoids name-based lookup on
every sync (which would be fragile against renames, case differences, and accidental duplicates).

### `src/lib/server/schema.sql`

In the `CREATE TABLE plex_playlists (...)` block, add:

```sql
ma_playlist_item_id TEXT,  -- MA's playlist item_id once created; null until first MA sync
```

### `src/lib/server/db.ts`

After the existing `plex_user_mappings` migrations and before the index-recreation block, add:

```ts
const plexPlaylistCols = (db.pragma('table_info(plex_playlists)') as Array<{ name: string }>)
  .map((c) => c.name);
if (!plexPlaylistCols.includes('ma_playlist_item_id')) {
  db.exec('ALTER TABLE plex_playlists ADD COLUMN ma_playlist_item_id TEXT');
}
```

---

## Step 3 — `src/lib/server/music-assistant.ts` (new file)

RPC-shaped client. Single private `command<T>(name, args)` helper; named public functions wrap it.

```ts
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
interface MaPlaylist {
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

/** Test connectivity — issues a cheap command and returns true on success. */
export async function testConnection(): Promise<boolean> {
  // library_items with limit=1 is the cheapest way to confirm both reachability
  // and a valid bearer token. The /info endpoint exists but doesn't require
  // auth, so it wouldn't validate the token.
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

/** Find a playlist by exact name in MA's library. Returns null if not found. */
export async function findPlaylistByName(name: string): Promise<MaPlaylist | null> {
  // `kwargs: {}` is required by the schema; it's a Python **kwargs artifact.
  const playlists = await command<MaPlaylist[]>('music/playlists/library_items', {
    search: name,
    limit: 50,
    kwargs: {}
  });
  return (
    playlists.find((p) => p.name === name && p.is_editable !== false) ?? null
  );
}

/** Create a new MA-native playlist. Returns the new Playlist (with item_id and provider). */
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

/** Return the URIs of tracks currently in an MA playlist. Used to diff before adding. */
export async function getPlaylistTrackUris(
  itemId: string,
  providerInstanceIdOrDomain: string
): Promise<Set<string>> {
  // The server signature is AsyncGenerator[Track, None]; over HTTP this is
  // expected to be collected into a JSON array. If the live response is a
  // streaming format instead, switch this single call to the WebSocket
  // transport — that's the narrowest place to change.
  const tracks = await command<MaTrack[]>('music/playlists/playlist_tracks', {
    item_id: itemId,
    provider_instance_id_or_domain: providerInstanceIdOrDomain
  });
  return new Set(tracks.map((t) => t.uri).filter(Boolean));
}

/**
 * Add tracks to an MA playlist. Returns immediately — MA performs the work
 * asynchronously and returns a BackgroundTask handle which we currently
 * discard (fire-and-forget). Caller is expected to have already diffed against
 * existing tracks if MA's add is not idempotent.
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
```

---

## Step 4 — `src/lib/server/ma-sync.ts` (new file)

The sync engine for MA. Reuses the same `plex_playlists` and `plex_playlist_items` rows as the
source of truth — only tracks already confirmed present in Plex are synced, since MA's library
mirrors Plex.

Key design decisions:

- **Persisted MA playlist ID**: the `ma_playlist_item_id` column added in Step 2 holds MA's
  `item_id` after first creation. Subsequent syncs read it directly — no name-lookup round-trip,
  survives MA-side renames, no risk of accidentally creating a duplicate.
- **Diff before add**: regardless of MA's idempotency behaviour, we always read the current
  playlist tracks and only push the diff. This keeps the implementation correct under either
  outcome of the open behavioural question.
- **Concurrent search with a small concurrency limit** to avoid the N+1 sequential round-trips
  pattern. A 200-track playlist would otherwise be 200 sequential network calls.
- **Failures are non-fatal**: a track miss is logged and counted; a hard error on one operation
  doesn't abort the whole sync.

```ts
/**
 * Music Assistant playlist sync engine.
 *
 * Called from syncListToPlexPlaylist() after the Plex sync completes. For each
 * plex_playlists row, creates or updates a matching playlist in MA using the
 * tracks confirmed present in Plex (and therefore in MA's index).
 */

import { getDb } from './db';
import {
  searchTrack,
  findPlaylistByName,
  createPlaylist,
  getPlaylist,
  getPlaylistTrackUris,
  addTracksToPlaylist,
  MusicAssistantError
} from './music-assistant';
import { isMusicAssistantConfigured } from './settings';

const SEARCH_CONCURRENCY = 8;

export interface MaSyncResult {
  playlistName: string;
  /** New tracks pushed to MA on this run. */
  added: number;
  /** Tracks already in the MA playlist (skipped via diff). */
  alreadyInMa: number;
  /** Tracks not found in MA's library. */
  notFound: number;
  /** Per-track or per-call errors (non-fatal). */
  errors: number;
  /** True if MA isn't configured — caller should treat as "feature disabled". */
  skipped: boolean;
}

export async function syncPlaylistToMusicAssistant(
  plexPlaylistDbId: number
): Promise<MaSyncResult> {
  const db = getDb();
  const empty: MaSyncResult = {
    playlistName: '',
    added: 0,
    alreadyInMa: 0,
    notFound: 0,
    errors: 0,
    skipped: false
  };

  if (!isMusicAssistantConfigured()) {
    return { ...empty, skipped: true };
  }

  const ppRow = db
    .prepare(
      `SELECT id, list_id, playlist_title, ma_playlist_item_id
         FROM plex_playlists WHERE id = ?`
    )
    .get(plexPlaylistDbId) as
    | {
        id: number;
        list_id: number;
        playlist_title: string;
        ma_playlist_item_id: string | null;
      }
    | undefined;
  if (!ppRow) throw new Error(`plex_playlists row ${plexPlaylistDbId} not found`);

  const result: MaSyncResult = { ...empty, playlistName: ppRow.playlist_title };

  // Tracks confirmed present in Plex — same set we'd want in MA.
  const tracks = db
    .prepare(
      `SELECT DISTINCT li.id, li.title, li.artist_name
         FROM list_items li
         JOIN plex_playlist_items ppi ON ppi.list_item_id = li.id
        WHERE ppi.plex_playlist_id_fk = ?
          AND li.type = 'track'`
    )
    .all(plexPlaylistDbId) as Array<{ id: number; title: string; artist_name: string }>;

  if (tracks.length === 0) return result;

  // Resolve the MA playlist (cached id → name lookup → create).
  const ensured = await ensureMaPlaylist(plexPlaylistDbId, ppRow);
  if (!ensured) {
    result.errors++;
    return result;
  }
  const { itemId: maPlaylistId, provider: maPlaylistProvider } = ensured;

  // Existing tracks in the MA playlist — used to diff and to count alreadyInMa.
  let existingUris: Set<string>;
  try {
    existingUris = await getPlaylistTrackUris(maPlaylistId, maPlaylistProvider);
  } catch (err) {
    console.error(`[ma-sync] Failed to fetch existing tracks for "${ppRow.playlist_title}":`, err);
    result.errors++;
    existingUris = new Set();
  }

  // Search MA for each track in parallel (bounded concurrency).
  const foundUris: string[] = [];
  await runWithConcurrency(tracks, SEARCH_CONCURRENCY, async (track) => {
    try {
      const uri = await searchTrack(track.artist_name, track.title);
      if (!uri) {
        console.log(
          `[ma-sync] No MA match for list_item ${track.id} ` +
            `"${track.artist_name} - ${track.title}"`
        );
        result.notFound++;
        return;
      }
      if (existingUris.has(uri)) {
        result.alreadyInMa++;
      } else {
        foundUris.push(uri);
      }
    } catch (err) {
      console.error(
        `[ma-sync] Error searching MA for list_item ${track.id} ` +
          `"${track.artist_name} - ${track.title}":`,
        err
      );
      result.errors++;
    }
  });

  if (foundUris.length > 0) {
    try {
      await addTracksToPlaylist(maPlaylistId, foundUris);
      result.added = foundUris.length;
    } catch (err) {
      console.error(
        `[ma-sync] Failed to add tracks to MA playlist "${ppRow.playlist_title}":`,
        err
      );
      result.errors++;
    }
  }

  return result;
}

/**
 * Resolve the MA playlist for this plex_playlists row.
 * Order: stored id → search by name → create. Persists the id on first creation
 * or first match so subsequent syncs skip the lookup.
 */
async function ensureMaPlaylist(
  plexPlaylistDbId: number,
  ppRow: { playlist_title: string; ma_playlist_item_id: string | null }
): Promise<{ itemId: string; provider: string } | null> {
  const db = getDb();

  // 1. Cached id — verify it still exists.
  if (ppRow.ma_playlist_item_id) {
    try {
      const existing = await getPlaylist(ppRow.ma_playlist_item_id, 'library');
      if (existing) return { itemId: existing.item_id, provider: existing.provider };
      // Stored id is stale (deleted in MA) — fall through to recreate.
      console.warn(
        `[ma-sync] Stored MA playlist id ${ppRow.ma_playlist_item_id} no longer exists; recreating.`
      );
    } catch (err) {
      if (!(err instanceof MusicAssistantError) || err.status !== 404) {
        console.error(`[ma-sync] Error fetching MA playlist ${ppRow.ma_playlist_item_id}:`, err);
        return null;
      }
    }
  }

  // 2. Name lookup — handles fresh installs and out-of-band creation.
  try {
    const found = await findPlaylistByName(ppRow.playlist_title);
    if (found) {
      db.prepare('UPDATE plex_playlists SET ma_playlist_item_id = ? WHERE id = ?')
        .run(found.item_id, plexPlaylistDbId);
      return { itemId: found.item_id, provider: found.provider };
    }
  } catch (err) {
    console.error(`[ma-sync] Error searching for existing MA playlist:`, err);
    // Don't bail — try to create.
  }

  // 3. Create.
  try {
    const created = await createPlaylist(ppRow.playlist_title);
    db.prepare('UPDATE plex_playlists SET ma_playlist_item_id = ? WHERE id = ?')
      .run(created.item_id, plexPlaylistDbId);
    return { itemId: created.item_id, provider: created.provider };
  } catch (err) {
    console.error(`[ma-sync] Failed to create MA playlist "${ppRow.playlist_title}":`, err);
    return null;
  }
}

/** Run an async fn over items with bounded concurrency. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) return;
      await fn(next);
    }
  });
  await Promise.all(workers);
}
```

---

## Step 5 — Wire MA into `syncListToPlexPlaylist`

The MA call belongs **inside** `syncListToPlexPlaylist`, not in the API route handler. There's a
retry-with-backoff path in `plex-sync.ts` (`_retryWithBackoff` → `syncListToPlexPlaylist`) that
fires on partial Plex matches. Wiring MA at the route level only would silently skip MA on every
retry. Putting it inside `syncListToPlexPlaylist` covers manual sync, route-triggered sync, and
retry-triggered sync with one wiring point.

### `src/lib/server/plex-sync.ts`

Extend `SyncResult`:

```ts
import type { MaSyncResult } from './ma-sync';

export interface SyncResult {
  added: number;
  alreadySynced: number;
  notFound: number;
  errors: number;
  unmatched: Array<{ listItemId: number; artistName: string; title: string }>;
  /** MA sync result. `null` if MA is not configured. */
  maResult: MaSyncResult | null;
}
```

At the end of `syncListToPlexPlaylist`, just before returning the result, add the MA call wrapped
so its failures do not bubble up:

```ts
let maResult: MaSyncResult | null = null;
try {
  const { syncPlaylistToMusicAssistant } = await import('./ma-sync');
  maResult = await syncPlaylistToMusicAssistant(plexPlaylistDbId);
  if (maResult.skipped) maResult = null;
} catch (err) {
  console.error('[plex-sync] MA sync error (non-fatal):', err);
}

return { ...result, maResult };
```

The dynamic import is intentional here: it keeps `plex-sync.ts` runnable in test environments that
don't initialise MA, and avoids adding a top-level dep on a brand-new module.

### `src/routes/api/plex/+server.ts`

The `sync` case stays simple — `maResult` rides along inside `result`:

```ts
case 'sync': {
  const { playlist_id } = body;
  if (!playlist_id) throw error(400, 'playlist_id is required');
  const syncResult = await syncListToPlexPlaylist(Number(playlist_id));
  return json({ ok: true, result: syncResult });
}
```

Add `MusicAssistantError` to the catch block so a hard MA error (which would only escape if it
fired *outside* `syncListToPlexPlaylist`, e.g. from `testMusicAssistantConnection`) returns clean
JSON instead of a 500:

```ts
} catch (err: unknown) {
  if (err instanceof PlexError) {
    return json({ ok: false, error: err.message }, { status: err.status ?? 500 });
  }
  if (err instanceof MusicAssistantError) {
    return json({ ok: false, error: err.message }, { status: err.status ?? 500 });
  }
  throw err;
}
```

Import `MusicAssistantError` at the top of the file.

---

## Step 6 — Settings page

### `src/routes/settings/+page.server.ts`

**In `load`:** add to the returned `settings` object:

```ts
musicAssistantUrl: settings[SETTING_KEYS.MUSIC_ASSISTANT_URL] ?? '',
// Token returned as a placeholder string when set, never the real value.
musicAssistantTokenSet: Boolean(settings[SETTING_KEYS.MUSIC_ASSISTANT_TOKEN])
```

**In the `save` action:** read the URL and (only when changed) re-encrypt the token. Mirror how
`PLEX_ADMIN_TOKEN` is handled — the form submits an empty token field to mean "leave unchanged":

```ts
import { encrypt } from '$lib/server/crypto';

const musicAssistantUrl = ((data.get('music_assistant_url') as string | null) ?? '').trim();
const musicAssistantToken = ((data.get('music_assistant_token') as string | null) ?? '').trim();

setSetting(SETTING_KEYS.MUSIC_ASSISTANT_URL, musicAssistantUrl);
if (musicAssistantToken) {
  setSetting(SETTING_KEYS.MUSIC_ASSISTANT_TOKEN, encrypt(musicAssistantToken));
}
```

Add a `testMusicAssistantConnection` action modelled on `testPlexConnection`. It calls
`testConnection()` from `music-assistant.ts` and returns either `{ ok: true }` or
`{ ok: false, error }`.

### `src/routes/settings/+page.svelte`

Add a **Music Assistant** section below the existing Plex section. It needs:

- Text input `music_assistant_url` (label: "Music Assistant URL", placeholder:
  `http://192.168.x.x:8095`).
- Password-style input `music_assistant_token` (label: "Bearer Token"). When `musicAssistantTokenSet`
  is true, render an empty field with placeholder "(unchanged — leave blank to keep)".
- "Test connection" button submitting `?/testMusicAssistantConnection`.
- Connection status indicator matching the Plex status style.

Hint text under the URL field: *"If configured, playlists will also be synced to Music Assistant
after each Plex sync. Generate a long-lived bearer token in MA's UI."*

---

## Step 7 — `src/routes/lists/[id]/+page.svelte` (UI feedback)

The existing `syncPlaylist()` reads `data.result` from the API response. Extend the message
construction to include MA results when present:

```ts
const maParts: string[] = [];
const maResult = data.result?.maResult;
if (maResult) {
  maParts.push(`MA: ${maResult.added} added`);
  if (maResult.alreadyInMa > 0) maParts.push(`${maResult.alreadyInMa} already in MA`);
  if (maResult.notFound > 0) maParts.push(`${maResult.notFound} not found in MA`);
  if (maResult.errors > 0) maParts.push(`${maResult.errors} MA errors`);
}
const allParts = [...parts, ...maParts];
plexSyncMessage = `Sync complete: ${allParts.join(', ')}`;
```

`maResult` will be `null` when MA isn't configured (set by `syncListToPlexPlaylist` after detecting
`skipped: true`), so the existing UI behaves unchanged for users who don't enable MA.

---

## Step 8 — Verification

After implementing, verify in this order:

1. **Settings save/load round-trip** — set a MA URL and token, reload, confirm URL persists and
   token field shows "unchanged" placeholder. Confirm the stored token in SQLite has the `enc1:`
   prefix (i.e. is encrypted).

2. **Test connection** — succeeds against a valid token, fails cleanly with a 401 message against a
   bogus one.

3. **Manual sync with MA configured (first run)** — trigger a sync on an existing plex_playlist
   that has synced tracks. Check the response includes `maResult` with non-zero `added`. Verify
   `plex_playlists.ma_playlist_item_id` is now populated.

4. **Manual sync with MA configured (second run, no changes)** — trigger sync again. `added`
   should be 0, `alreadyInMa` should equal the track count. Check the MA UI has no duplicates.
   *This is the live idempotency test — if MA's add IS idempotent we'd see the same outcome
   without our diff, but the diff still saves the redundant network call.*

5. **Manual sync without MA configured** — clear MA URL, sync. `maResult` should be `null` in the
   response. No errors logged.

6. **Stored ID staleness** — manually delete the playlist in MA's UI, leave
   `ma_playlist_item_id` populated, trigger sync. Should log a warning, recreate the playlist, and
   update the stored id.

7. **Retry path** — induce a partial Plex match so `_retryWithBackoff` fires. Confirm MA sync also
   ran on the retry (check logs for `[ma-sync]` lines after the retry attempt).

---

## Open behavioural questions (live test, not blockers)

These are nice-to-know but the current design is correct under either outcome. Confirm during
verification step 4:

| # | Question | What changes if the answer flips |
|---|----------|----------------------------------|
| 1 | Is `add_playlist_tracks` idempotent? | If yes, the diff in `ma-sync.ts` is belt-and-braces but harmless. If no, the diff is essential. Either way the code is correct as written. |
| 2 | Does `playlist_tracks` return a JSON array or stream over HTTP? | If it streams, switch *only* `getPlaylistTrackUris` to the WebSocket transport. Localised change. |

---

## What this does NOT cover

- **Home Assistant automation / voice trigger setup** — separate HA-side task. Once MA playlists
  exist with predictable names (e.g. `Theo's Favourites`), an HA script can call
  `music_assistant.play_media` targeting a `media_player` entity. HA YAML and Aqara button
  triggers should be scoped separately once the TuneFetch side is confirmed working.

- **Scheduled / automatic MA re-sync** — `scheduler.ts` could be extended to re-run MA sync on a
  schedule, but the current design already covers this implicitly: anything that triggers
  `syncListToPlexPlaylist` also pushes to MA, so adding MA to scheduled syncs requires no MA-side
  code change.

- **Per-user MA accounts** — MA's user system is separate from Plex's. We push playlists into
  MA's library where they're visible to all MA users; there is currently no plan to scope MA
  playlists per user.
