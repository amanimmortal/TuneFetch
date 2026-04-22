# Plex Connector — Scope & Design Notes

**Project:** TuneFetch  
**Date:** 2026-04-22  
**Status:** Scoping only — no code yet

---

## Overview

Add a Plex integration that automatically creates and maintains playlists in Plex for a specified user, driven by the contents of a TuneFetch list. The intended flow is:

1. User adds tracks/albums/artists to a TuneFetch list
2. Lidarr downloads the music
3. Plex scans the new files into its library
4. TuneFetch creates or updates the corresponding Plex playlist for the configured user

---

## Plex API Capabilities

The Plex REST API (documented at [plexapi.dev](https://plexapi.dev)) supports everything needed:

| Endpoint | Purpose |
|---|---|
| `POST /playlists` | Create a playlist with a title and initial item set |
| `PUT /playlists/{id}/items` | Add items by `ratingKey` |
| `DELETE /playlists/{id}/items?playlistItemID=` | Remove specific items |
| `DELETE /playlists/{id}` | Delete a playlist entirely |
| `GET /library/sections/{id}/refresh` | Trigger a Plex library scan |

Authentication is via `X-Plex-Token` header. Each managed/home user has their own token, retrievable from:

```
GET https://plex.tv/api/servers/{serverID}/shared_servers?X-Plex-Token={admin_token}
```

This returns all authorised users and their per-server access tokens. Creating a playlist "for a user" means making the API call using *their* token, not the admin token.

---

## What Needs to Be Built

### 1. Plex API Client — `src/lib/server/plex.ts`

Follows the same pattern as the existing `lidarr.ts`. Required methods:

- `testConnection()` — GET `/` to verify server is reachable
- `getLibrarySections()` — list music libraries, let user select which one to target
- `triggerLibraryScan(sectionId)` — POST to refresh a section after Lidarr download
- `searchTrack(artist, title)` → `ratingKey | null` — find a track in the Plex library
- `createPlaylist(userToken, title, ratingKeys[])` → `playlistId`
- `addToPlaylist(userToken, playlistId, ratingKey)`
- `removeFromPlaylist(userToken, playlistId, playlistItemId)`
- `getManagedUsers(adminToken)` — hits plex.tv to enumerate users + tokens

### 2. Schema Additions — `src/lib/server/schema.sql`

All additions must be idempotent (existing pattern uses `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`).

**New settings keys** (in existing `settings` table):
- `plex_url` — base URL of the Plex server (e.g. `http://192.168.1.x:32400`)
- `plex_admin_token` — admin X-Plex-Token
- `plex_library_section_id` — which music library section to search

**New table: `plex_playlists`**

```sql
CREATE TABLE IF NOT EXISTS plex_playlists (
  id               INTEGER PRIMARY KEY,
  list_id          INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  plex_user_token  TEXT NOT NULL,
  plex_user_name   TEXT NOT NULL,
  plex_playlist_id TEXT,          -- null until first sync creates it
  playlist_title   TEXT NOT NULL,
  last_synced_at   DATETIME,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_plex_playlists_list ON plex_playlists(list_id);
```

**New table: `plex_playlist_items`**

Tracks the ratingKey for each successfully synced list item, so subsequent syncs don't need to re-search Plex for every track.

```sql
CREATE TABLE IF NOT EXISTS plex_playlist_items (
  id                  INTEGER PRIMARY KEY,
  plex_playlist_id_fk INTEGER NOT NULL REFERENCES plex_playlists(id) ON DELETE CASCADE,
  list_item_id        INTEGER NOT NULL REFERENCES list_items(id) ON DELETE CASCADE,
  plex_rating_key     TEXT NOT NULL,
  plex_playlist_item_id TEXT,     -- needed for targeted removal
  synced_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(plex_playlist_id_fk, list_item_id)
);
```

### 3. Settings Page — `src/routes/settings/`

Add a "Plex" section to the existing settings page:

- Plex server URL field + connection test button
- Plex admin token field (masked)
- Library section dropdown (populated on connection test)
- "Fetch Users" button that calls plex.tv and lists available managed users (stored for per-list config)

### 4. Per-List Plex Config — `src/routes/lists/[id]/`

On the list detail page, add a Plex sync panel:

- Toggle to enable/disable Plex sync for this list
- Dropdown to select which Plex user the playlist belongs to
- Text field for playlist name (defaults to list name)
- "Sync Now" button (manual trigger)
- Last synced timestamp + item count

### 5. Sync Logic — `src/lib/server/plex-sync.ts`

Core function: `syncListToPlexPlaylist(listId, plexPlaylistRow)`

Steps:
1. Load all `synced` list items for the list
2. For each item not yet in `plex_playlist_items`: search Plex by artist + title → get `ratingKey`
3. Add found items to the Plex playlist; record in `plex_playlist_items`
4. Log unmatched items as `plex_pending` for retry
5. If the playlist doesn't exist yet (`plex_playlist_id` is null): create it first, then add items

### 6. Webhook Integration — `src/routes/api/webhook/lidarr/+server.ts`

Extend the existing Download handler. After mirroring completes:

1. Trigger a Plex library section refresh (`GET /library/sections/{id}/refresh`)
2. Enqueue a delayed sync attempt for any lists that have Plex sync enabled and contain items for the downloaded artist

The delay is necessary — see the Timing Problem section below.

---

## The Hard Part: Timing

This is the most non-trivial piece of the feature. There is an inherent delay between Lidarr firing the webhook and the file being visible in Plex:

```
Lidarr downloads file
  → TuneFetch webhook fires, mirrors the file
    → Plex scans the new file   ← indeterminate delay (seconds to minutes)
      → TuneFetch searches Plex by artist+title → gets ratingKey
        → Track added to playlist
```

TuneFetch cannot add a track to a Plex playlist until Plex has scanned it into the library. The sync logic therefore needs a **retry queue with backoff**:

- On webhook: trigger library scan, then attempt sync after a short initial delay (e.g. 30s)
- If tracks still not found: retry with exponential backoff (e.g. 30s → 2min → 5min → 15min)
- After N failures: mark item `plex_pending`, surface in UI for manual retry
- A "Sync Now" button on the list page covers the manual retry path

This pattern is analogous to the existing mirror backfill retry logic in `mirror.ts` and fits naturally into the existing scheduler/background task model.

---

## Track Matching Caveat

Plex does not natively index by MusicBrainz ID in its standard music agent (unless the user is running a custom agent like `musicbrainz` or `beets`). Track matching will be done by searching `artist name + track title` against the Plex library.

This works reliably for clean metadata but has edge cases:

- Featuring artists (e.g. "Artist A feat. Artist B" vs "Artist A")
- Remixes and alternate versions
- Inconsistent tagging from Lidarr/MusicBrainz

Unmatched tracks should be logged and surfaced in the UI rather than silently dropped. No need to block on solving edge cases for the initial implementation.

---

## Open Design Question

**Should the Plex playlist be authoritative or additive?**

This needs a decision before implementation as it significantly affects sync logic:

- **Authoritative**: TuneFetch owns the playlist entirely. Any manual edits the user makes in Plex will be overwritten on next sync. Simpler to implement.
- **Additive**: TuneFetch only ever adds items, never removes. Manual additions by the user in Plex are preserved. Requires diffing playlist state on each sync.

A reasonable default is **authoritative** for initial implementation, with additive as a per-list option later.

---

## Complexity Summary

| Piece | Effort | Notes |
|---|---|---|
| Plex API client | Low | Follows existing `lidarr.ts` pattern exactly |
| Schema additions | Low | Two new tables, three new settings keys |
| User token enumeration | Low–Medium | One plex.tv API call + UI to display results |
| Playlist CRUD | Low | Straightforward REST calls |
| Track search + matching | Medium | Artist+title fuzzy matching, handle no-results |
| Retry queue for scan timing | **Medium–High** | Most novel piece; no direct analogue in codebase |
| UI (per-list config + status) | Medium | New panel on existing list detail page |
| Settings page additions | Low | Follows existing settings page pattern |

**Overall estimate: ~10–15 hours.** The existing architecture (webhook handler, settings store, background task pattern from `mirror.ts`) maps well onto this feature. The retry/timing problem is the one genuinely new piece of complexity.

---

## References

- [Plex API — Create a Playlist](https://plexapi.dev/api-reference/library-playlists/create-a-playlist)
- [Plex API — Adding to a Playlist](https://plexapi.dev/api-reference/playlists/adding-to-a-playlist)
- [Plex API — Official Docs](https://developer.plex.tv/pms/)
- [Finding an X-Plex-Token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/)
