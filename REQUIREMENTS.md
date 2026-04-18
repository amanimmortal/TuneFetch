# TuneFetch — Requirements & Brainstorming Document

> **Status:** Draft v0.2 — Pre-development  
> **Last updated:** 2026-04-18  
> **Purpose:** This document captures all design decisions, open questions, architectural trade-offs, and feature specifications agreed upon before any code is written. It is the source of truth for development planning.

---

## Table of Contents

1. [Project Overview & Goals](#1-project-overview--goals)
2. [Tech Stack & Environment](#2-tech-stack--environment)
3. [Core Concepts & Mental Model](#3-core-concepts--mental-model)
4. [Feature Specifications](#4-feature-specifications)
   - 4A. Authentication
   - 4B. Search & Discovery
   - 4C. List Management
   - 4D. Lidarr API Orchestration
   - 4E. Symlink Management System
   - 4F. Settings & Configuration
5. [Revised Data Model](#5-revised-data-model)
6. [External API Integrations](#6-external-api-integrations)
7. [Deployment & Infrastructure](#7-deployment--infrastructure)
8. [Known Constraints & Risks](#8-known-constraints--risks)
9. [Open Questions](#9-open-questions)
10. [Future Scope (Out of v1)](#10-future-scope-out-of-v1)

---

## 1. Project Overview & Goals

TuneFetch is a lightweight, containerized web application acting as an intermediary between family members, the MusicBrainz metadata API, and a local Lidarr instance.

### Primary Problem Being Solved

Lidarr is a powerful music acquisition tool, but it has two significant UX gaps for a household with separate Plex libraries:

1. Its search and "add music" flow is designed around adding whole artists, not individual tracks.
2. It has no concept of per-user or per-library targeting — an artist belongs to one root folder, and that's final.

TuneFetch solves both problems:
- It provides a track/album/artist search UI backed by MusicBrainz, allowing individual track selection.
- It manages Lidarr's monitoring state via API so only explicitly requested tracks are monitored.
- It mirrors tracks into secondary root folders (e.g., a kids library) by **copying the files**, keeping each Plex library fully independent and always playable.

### Goals for v1

- Any family member can search for music and add it to their personal list.
- Music is automatically pushed to Lidarr on add, with correct monitoring state.
- Tracks added to multiple family lists are copied into the correct folder paths under each list's root folder rather than re-downloaded.
- The app surfaces clearly whether a track/album/artist is already present in any list, avoiding confusion.
- The whole system runs in a single Docker container on Unraid with minimal configuration.

---

## 2. Tech Stack & Environment

| Layer | Technology | Rationale |
|---|---|---|
| Framework | SvelteKit | Handles both frontend UI and backend API routes in one project. Compiles to a small, optimised Node.js server. |
| Runtime | Node.js (via SvelteKit Node adapter) | Lightweight, sufficient for this workload. |
| Database | SQLite | File-based, single-volume persistence. No separate DB container needed. |
| Styling | Tailwind CSS | Utility-first, fast to iterate, minimal bundle size. |
| Deployment | Single Docker container | Simplicity. Unraid compatible. |
| Host | Unraid (Nvidia Titan X 12GB GPU present but not relevant to this app) | |
| Reverse Proxy | External NGINX (not bundled) | Handles TLS/HTTPS. The container exposes plain HTTP on port 3000. |

---

## 3. Core Concepts & Mental Model

Understanding these three concepts is essential before reading the feature specs.

### Lists = People + Root Folders

A **List** in TuneFetch is not a simple playlist. It represents a **person's music library**, mapped to a specific Lidarr root folder path. Examples:

| List Name | Root Folder | Plex Library |
|---|---|---|
| Mum & Dad | /mnt/user/media/music/parents | Parents' Plex library |
| Theo | /mnt/user/media/music/kids | Kids' Plex library |
| Finn | /mnt/user/media/music/kids | Kids' Plex library (same folder) |

Two lists can map to the same root folder (Theo and Finn both feed into the kids library). This is intentional — it lets you track *who requested what* independently of where the files live.

### Lidarr Owns One Copy

Lidarr does not support multiple root folders per artist. When an artist is first added, Lidarr assigns it to exactly one root folder — the one belonging to the first list that triggered the add. That list (and its root folder) is the **Lidarr owner** of that artist.

All subsequent lists that request music from the same artist receive a **file copy** rather than a new Lidarr entry.

### Copies Mirror the Folder Structure

When a track owned by List A (root folder A) is requested by List B (root folder B), TuneFetch copies the file to an identical relative path under the secondary root folder:

```
/mnt/user/media/music/parents/Artist Name/Album Name/Track.mp3
  copied to →
/mnt/user/media/music/kids/Artist Name/Album Name/Track.mp3
```

The folder path under the root folder mirrors Lidarr's naming exactly, so Plex picks it up naturally in both libraries. Each copy is a fully independent file — Plex can read it regardless of what happens to the source.

> **Infrastructure note:** Hardlinks are not viable because root folders are on different physical drives in the Unraid array. File copies work across all drive configurations and are the chosen approach (OQ-7, resolved).

---

## 4. Feature Specifications

### 4A. Authentication

**Decision: Single admin user.**

- One account, credentials set via environment variables (`TUNEFETCH_USER`, `TUNEFETCH_PASSWORD`) or configured on first run.
- Password stored as a hash (Argon2id preferred; bcrypt acceptable).
- Session-based auth with a secure HTTP-only cookie.
- No user management UI required in v1.
- All routes are protected. Unauthenticated requests redirect to `/login`.

> **Resolved (OQ-2):** `TUNEFETCH_SECRET` is a **required environment variable**, explicitly set by the user. It must be present at startup — the container should fail fast with a clear error if it is absent. This avoids the risk of a new secret being generated if the database is wiped, which would invalidate all existing sessions.

---

### 4B. Search & Discovery

**Search targets MusicBrainz exclusively.** This ensures all MBIDs (MusicBrainz IDs) are native to Lidarr's internal database, guaranteeing a clean 1:1 match when pushing to Lidarr.

#### Searchable Entity Types

| Type | MusicBrainz Entity | Notes |
|---|---|---|
| Artist | `artist` | Searches by name |
| Album | `release-group` | Searches by title, optionally filtered by artist |
| Track | `recording` | Searches by title, optionally filtered by artist/album |

#### Search Results Display

Each result card must show:
- Title / artist name / album name (where applicable)
- Entity type badge (Artist / Album / Track)
- **List membership badges** — if the item is already in one or more lists, display those list names prominently (e.g., `Already in: Theo, Mum & Dad`). This is the primary duplicate-detection mechanism.
- An "Add to list" action — opens a dropdown or modal to select which list to add to.

#### Rate Limiting

MusicBrainz enforces a **1 request/second** rate limit with a descriptive User-Agent requirement. The server-side API route must:
- Set `User-Agent: TuneFetch/1.0 (contact: <admin_email>)` on all requests. The admin email should be configurable.
- Implement a simple request queue with a 1-second interval between MusicBrainz calls.
- Return a user-friendly "searching…" state in the UI while rate limiting is active.

---

### 4C. List Management

#### List CRUD

- Create, rename, and delete lists.
- Each list requires: `name`, `root_folder_path` (selected from a dropdown populated by Lidarr's `/api/v1/rootfolder` endpoint).
- Deleting a list requires a multi-step confirmation flow: the app first checks whether the list owns any artists in Lidarr, and if so, requires the user to confirm an ownership transfer before deletion can proceed. See OQ-4 (resolved) for the full ownership transfer design.

#### List View

Each list page shows:
- All items in the list (tracks, albums, artists).
- Per-item `sync_status`: `pending` | `synced` | `failed` | `mirror_pending` | `mirror_active` | `mirror_broken`.
- Failed items show the error message and a **Retry** button.
- Mirror-pending items show a "Waiting for Lidarr download…" indicator.
- Mirror-broken or stale items show a warning and a **Repair** button.

#### Adding Items to a List

1. User finds a result via Search.
2. User selects a target list from a dropdown.
3. Item is added to the list in SQLite.
4. The Lidarr push (or symlink creation) is triggered **automatically and immediately**.
5. The UI updates the item's `sync_status` in real time (consider SvelteKit server-sent events or polling).

---

### 4D. Lidarr API Orchestration

This is the most complex logic in the application. The behaviour differs depending on whether the artist already exists in Lidarr and which type of item is being added.

#### Pre-flight: Artist Ownership Check

Before any push, the app must determine whether Lidarr already knows about the artist:

```
GET /api/v1/artist
→ Filter results by MBID
→ If found: record as existing owner (note the rootFolderPath Lidarr has it under)
→ If not found: proceed to add
```

This check must happen on every push, not just the first time, because Lidarr's state may have changed outside the app.

#### Scenario A: Artist Type — Full Artist Add

*Triggered when a user adds an artist-type item to a list.*

1. **Artist ownership check** (see above).
2. If artist does **not** exist in Lidarr:
   - `POST /api/v1/artist` with `addOptions.monitor: "all"` and `rootFolderPath` set to the list's configured root folder.
   - Store `lidarr_artist_id` and the owning root folder in the DB.
3. If artist **already exists** in Lidarr under a *different* root folder than the current list:
   - This is a cross-library artist add. **TuneFetch cannot add the artist to a second root folder in Lidarr.**
   - Record the item in the list. Set `sync_status` to `mirror_pending` (backfill in progress) immediately.
   - **Immediately begin a background job** to mirror all existing downloaded files for this artist into the secondary list's root folder (symlink or copy — see OQ-7). This may be a large operation for prolific artists; progress should be visible in the list view.
   - Register with the webhook system to mirror all future downloads for this artist to the same secondary root folder automatically.
   - Do **not** trigger a new Lidarr search — Lidarr already owns this artist and manages its downloads.
4. Trigger a Lidarr search: `POST /api/v1/command` with `{ "name": "ArtistSearch", "artistId": <id> }`.
   - Skip this step if the artist already existed in Lidarr (step 3 path) — Lidarr is already managing downloads.

#### Scenario B: Track Type — Single Track Add

*Triggered when a user adds a single track to a list.*

1. **Artist ownership check.**
2. If artist does **not** exist in Lidarr:
   - `POST /api/v1/artist` with `addOptions.monitor: "none"` and the correct `rootFolderPath`. Artist and all albums added **unmonitored**.
3. Ensure the parent album exists in Lidarr (it will be added automatically with the artist in step 2, but unmonitored).
4. `GET /api/v1/track?artistId=<id>` — retrieve all tracks for the artist.
5. Find the target track by MBID.
6. `PUT /api/v1/track` — set `monitored: true` for the target track only.
7. Trigger a track search: `POST /api/v1/command` with `{ "name": "TrackSearch", "trackIds": [<id>] }`.
8. If artist **already exists** in Lidarr under a different root folder → proceed to mirror workflow (Section 4E) instead of pushing to Lidarr again. Mirror only the specific requested track, not the entire artist.

#### Scenario C: Album Type — Full Album Add

*Triggered when a user adds an album-type item to a list.*

1. **Artist ownership check.**
2. If artist does **not** exist in Lidarr:
   - `POST /api/v1/artist` with `addOptions.monitor: "none"`. Artist added unmonitored.
3. `GET /api/v1/album?artistId=<id>` — find the target album by MBID.
4. `PUT /api/v1/album` — set `monitored: true` for the target album only.
5. Trigger album search: `POST /api/v1/command` with `{ "name": "AlbumSearch", "albumIds": [<id>] }`.
6. If artist already exists under a different root folder → mirror workflow (Section 4E). Mirror all tracks in the album, not the entire artist.

#### Error Handling

- Any Lidarr API error (non-2xx response) sets the item's `sync_status` to `failed` and stores the HTTP status + response body as `sync_error` in the DB.
- A **Retry** button re-runs the full orchestration sequence for that item.
- Network timeouts should be caught and treated as failures with a descriptive message.

---

### 4E. File Copy System

This is the second major complexity in TuneFetch, arising because Lidarr cannot hold an artist in multiple root folders simultaneously. **File copies are used exclusively** (OQ-7, resolved). Each secondary list receives its own independent copy of any shared file, meaning every Plex library is fully self-contained and always playable.

#### When Copying Is Needed

A copy is required when:
- A track/album/artist is requested for **List B**, but the artist is already owned in Lidarr under **List A's** root folder (or any other root folder).
- The item may not be downloaded yet (`mirror_pending`) or may already be on disk (copy can happen immediately).

#### Background Backfill (Resolved — OQ-1)

When an artist is added to a secondary list and that artist already has downloaded files under the owning root folder, TuneFetch immediately begins a **background backfill job**:

1. Enumerate all downloaded track files for that artist via `GET /api/v1/trackfile?artistId=<id>`.
2. For each file, copy it to the equivalent path under the secondary root folder.
3. Create intermediate directories as needed.
4. Update the `mirror_files` DB record to `active` as each file is processed.
5. Update `list_item.sync_status` to `synced` once all existing files are copied.

This job runs asynchronously. Progress (e.g., "Copying 3 of 47 files…") is surfaced in the list view. The user does not need to wait.

#### Webhook Integration

TuneFetch exposes a webhook endpoint: `POST /api/webhook/lidarr`

This endpoint must be registered in Lidarr under **Settings → Connect → Webhook** with the following events enabled:
- **On Download** — new file acquired by Lidarr
- **On Upgrade** — existing file replaced with a better quality version

**On Download**, TuneFetch:
1. Receives the payload including the file path and track/album MBIDs.
2. Queries the DB for any lists that have this artist registered for mirroring.
3. Copies the file into each qualifying secondary root folder at the correct relative path.
4. Updates the `mirror_files` record to `active`.

**On Upgrade**, TuneFetch:
1. Identifies all `mirror_files` records whose `source_path` matches the upgraded file.
2. Overwrites the copy at each `mirror_path` with the new higher-quality file.
3. The old copy continues to serve from Plex until the overwrite completes — there is no gap in playability.
4. Updates `mirror_files.status` back to `active` and clears any `stale` state.

#### Copy Path Construction

```
<secondary_root_folder> / <relative_path_from_owning_root_folder>
```

Example:
- Lidarr owner root: `/mnt/user/media/music/parents`
- Lidarr file path: `/mnt/user/media/music/parents/Radiohead/OK Computer/05 - Let Down.mp3`
- Relative path: `Radiohead/OK Computer/05 - Let Down.mp3`
- Secondary root (kids): `/mnt/user/media/music/kids`
- Copy destination: `/mnt/user/media/music/kids/Radiohead/OK Computer/05 - Let Down.mp3`

#### Mirror Health Dashboard

A dedicated page (or panel) must show:
- All active copies with their source and destination paths.
- Stale copies (source was upgraded but copy has not yet been refreshed — `status = 'stale'`).
- A **Refresh Stale** button that re-copies stale files from their current source.
- A **Scan Now** button to trigger orphan detection manually.

#### Scheduled Orphan Detection (Resolved — OQ-6)

Orphan detection (files on disk under a secondary root folder with no corresponding `mirror_files` DB record) runs **automatically on a configurable schedule** (default: daily at 03:00). The schedule is set in the Settings page. The scan:
1. Walks all configured secondary root folders.
2. Checks each file against the `mirror_files` DB table by path.
3. Flags orphans in the health dashboard for user review — does not delete them automatically.

#### Volume Mount Requirement

The Docker container requires **read access to all owning root folders** (to read source files for copying) and **read-write access to all secondary root folders** (to write copies and create directories). In practice, since any root folder can become an owner depending on which list first triggers an artist add, all mounted root folders should be granted read-write access. With 3–4 root folders expected, the Docker Compose file will have 3–4 explicit volume entries.

---

### 4F. Settings & Configuration

A settings page accessible only to the admin user must allow configuration of:

| Setting | Description |
|---|---|
| Lidarr URL | Base URL of the Lidarr instance (e.g., `http://192.168.1.10:8686`) |
| Lidarr API Key | Retrieved from Lidarr → Settings → General |
| Admin contact email | Used in the MusicBrainz User-Agent header |
| Scheduler time for orphan scan | Cron-style or time-of-day setting for the nightly orphan detection job (default: 03:00) |

On save, the app should **test the Lidarr connection** (call `/api/v1/system/status`) and surface a success/failure indicator.

> **Resolved (OQ-3):** Webhook authentication (shared secret) is **not required**. TuneFetch and Lidarr always run on the same Docker host on the internal network. The webhook endpoint does not need to be internet-exposed, so validating a shared secret adds complexity without meaningful security benefit in this deployment model.

---

## 5. Revised Data Model

```sql
-- Single admin user (may expand in future)
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Lists map to people and to Lidarr root folders
CREATE TABLE lists (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  root_folder_path TEXT NOT NULL,  -- Must match a path from Lidarr /api/v1/rootfolder
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Items added to lists by users
CREATE TABLE list_items (
  id               INTEGER PRIMARY KEY,
  list_id          INTEGER NOT NULL REFERENCES lists(id),
  mbid             TEXT NOT NULL,   -- MusicBrainz ID (recording, release-group, or artist MBID)
  type             TEXT NOT NULL CHECK(type IN ('track', 'album', 'artist')),
  title            TEXT NOT NULL,
  artist_name      TEXT NOT NULL,
  album_name       TEXT,            -- NULL for artist-type items
  lidarr_artist_id INTEGER,         -- Lidarr internal artist ID, populated after push
  lidarr_album_id  INTEGER,         -- Lidarr internal album ID (track/album types)
  lidarr_track_id  INTEGER,         -- Lidarr internal track ID (track type only)
  sync_status      TEXT NOT NULL DEFAULT 'pending'
                   CHECK(sync_status IN ('pending','synced','failed','mirror_pending','mirror_active','mirror_broken')),
  sync_error       TEXT,            -- Stores error message/HTTP body if sync_status = 'failed'
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tracks which list "owns" each artist in Lidarr (only one owner per artist MBID)
CREATE TABLE artist_ownership (
  id               INTEGER PRIMARY KEY,
  artist_mbid      TEXT NOT NULL UNIQUE,
  lidarr_artist_id INTEGER NOT NULL,
  owner_list_id    INTEGER NOT NULL REFERENCES lists(id),
  root_folder_path TEXT NOT NULL,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- File copies created by TuneFetch for secondary-list items (OQ-7 resolved: always file copies)
CREATE TABLE mirror_files (
  id              INTEGER PRIMARY KEY,
  list_item_id    INTEGER NOT NULL REFERENCES list_items(id),
  source_path     TEXT NOT NULL,   -- Absolute path of the source file (under the owning list's root folder)
  mirror_path     TEXT NOT NULL,   -- Absolute path of the copy (under the secondary list's root folder)
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending','active','stale')),
                  -- 'stale': source was upgraded by Lidarr but copy has not yet been refreshed
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- App-wide configuration (key-value store for settings page)
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### Key Design Notes

- `artist_ownership` is a separate table (not on `list_items`) because the ownership is **per artist MBID globally**, not per list item. Multiple list_items for different lists can all reference the same artist MBID, but only one list owns it in Lidarr.
- `mirror_files` is separate from `list_items` because one list_item (e.g., an artist add) could eventually produce dozens of copied files as albums are downloaded over time.
- `sync_status` on `list_items` covers both the Lidarr push result and the copy state for items that take the mirror path. The `mirror_*` states only apply to items where another list already owns the artist in Lidarr.
- `mirror_files` has no `method` column — file copies are the only mechanism (OQ-7, resolved). The `stale` status flags copies where the Lidarr source has been upgraded but the copy has not yet been refreshed.

---

## 6. External API Integrations

### MusicBrainz API

- **Base URL:** `https://musicbrainz.org/ws/2/`
- **Format:** JSON (`?fmt=json`)
- **Rate limit:** 1 request/second — enforced server-side with a request queue.
- **Required header:** `User-Agent: TuneFetch/1.0 ( <admin_contact_email> )` — MusicBrainz will ban IPs without a descriptive User-Agent.
- **Key endpoints used:**
  - `GET /artist?query=<name>` — Artist search
  - `GET /release-group?query=<title>` — Album search
  - `GET /recording?query=<title>` — Track search
- All search calls are made **server-side** (in SvelteKit `+server.ts` routes) to protect the rate limiting queue and avoid CORS issues.

### Lidarr API (v1)

- **Base URL:** Configurable (stored in `settings` table)
- **Auth header:** `X-Api-Key: <api_key>`
- **Reference:** https://lidarr.audio/docs/api/
- **Key endpoints:**

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/v1/system/status` | Connection test |
| GET | `/api/v1/rootfolder` | Populate root folder dropdown when creating a list |
| GET | `/api/v1/artist` | List all artists (for ownership check) |
| POST | `/api/v1/artist` | Add a new artist |
| PUT | `/api/v1/artist` | Update an artist (used for ownership transfer — change rootFolderPath) |
| GET | `/api/v1/album?artistId=<id>` | Get albums for an artist |
| PUT | `/api/v1/album` | Update album monitoring state |
| GET | `/api/v1/track?artistId=<id>` | Get all tracks for an artist |
| PUT | `/api/v1/track` | Update track monitoring state |
| POST | `/api/v1/command` | Trigger search (ArtistSearch, AlbumSearch, TrackSearch) |

---

## 7. Deployment & Infrastructure

### Docker Container Design

```dockerfile
# Key requirements
- Base image: node:lts-alpine (small footprint)
- PUID / PGID environment variables for file permission mapping
  (ensures symlinks are created with the correct Unraid user/group)
- Exposed port: 3000 (HTTP only — TLS terminated by NGINX reverse proxy)
```

### Required Volume Mounts

| Container path | Host path (example) | Purpose |
|---|---|---|
| `/app/data` | `/mnt/user/appdata/tunefetch` | SQLite database + config |
| `/mnt/music/parents` | `/mnt/user/media/music/parents` | Root folder 1 (read + write for symlinks) |
| `/mnt/music/kids` | `/mnt/user/media/music/kids` | Root folder 2 (read + write for symlinks) |
| `/mnt/music/other` | `/mnt/user/media/music/other` | Root folder 3 (if applicable) |

> **Note:** All root folder mounts require **read-write** access. TuneFetch needs write access to create symlinks and create intermediate directories. It needs read access to follow/verify existing symlinks.

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PUID` | Yes | User ID for file ownership on Unraid |
| `PGID` | Yes | Group ID for file ownership on Unraid |
| `TUNEFETCH_SECRET` | Yes | Session secret for cookie signing (min 32 chars) |
| `TUNEFETCH_ADMIN_USER` | Optional | Pre-set admin username (can be set via UI on first run) |
| `TUNEFETCH_ADMIN_PASSWORD` | Optional | Pre-set admin password (hashed on startup) |

### Networking

- The container communicates with Lidarr over the internal Docker/Unraid network.
- Lidarr must be able to reach TuneFetch's webhook endpoint (`http://<tunefetch_host>:3000/api/webhook/lidarr`) — ensure no firewall rules block this internal traffic.
- TLS/HTTPS is handled by an external NGINX reverse proxy. The container itself serves plain HTTP.

---

## 8. Known Constraints & Risks

| # | Constraint / Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Stale copies after Lidarr upgrade** — If the webhook fires but TuneFetch fails to re-copy the upgraded file, secondary lists are left with a lower-quality version. | Medium | `status = 'stale'` in `mirror_files` surfaces this. **Refresh Stale** button in the health dashboard allows manual re-copy. Automatic retry on next webhook delivery. |
| 2 | **Lidarr webhook reliability** — If the webhook is not configured in Lidarr or the connection drops, `mirror_pending` items will never resolve and upgrades will leave stale copies. | High | Startup validates webhook reachability and warns loudly if it fails. Scheduled orphan scan and manual Scan Now button provide fallback. The health dashboard makes the pending/stale state visible. |
| 3 | **MusicBrainz MBID ↔ Lidarr MBID mismatch** — While both use MusicBrainz IDs, there can be edge cases (e.g., a recording MBID that Lidarr maps differently). | Medium | Test with a range of artists/tracks early in development. Fall back to title-matching as a search heuristic if needed. |
| 4 | **Ownership transfer moves the entire artist in Lidarr** — When a list is deleted and its artists are transferred, Lidarr physically moves all files to the new root folder. This can trigger a Lidarr rescan and temporarily affect Plex. | Medium | Surface a clear warning in the delete flow listing all affected artists. Ownership transfer should be a deliberate, confirmed action, not automatic. All mirrors pointing to the old paths must be updated in the same transaction. |
| 5 | **Large artist backfill on secondary list add** — An artist with hundreds of downloaded tracks requires creating many mirrors upfront when added to a secondary list. | Medium | Background job with progress indicator. Runs asynchronously; user can navigate away. |
| 6 | **Plex library refresh latency** — Plex may not immediately pick up new mirrors (symlinks or copies). | Low | Out of scope for TuneFetch. User manages Plex library scans manually or via scheduled scan. |
| 7 | **SQLite concurrent write limitations** — Under normal household usage this is not an issue, but rapid concurrent adds could cause lock contention. | Low | WAL mode enabled on SQLite. Single-user app limits concurrency anyway. |

---

## 9. Open Questions

Resolved questions are kept here for reference. Active open questions are marked **🔴 OPEN**.

### OQ-1: Backfill Strategy for Full Artist Add to Secondary List
**✅ RESOLVED**  
Immediately mirror all existing downloaded files in a background job, and register with the webhook system for all future downloads. Progress is surfaced in the list view. See Section 4E for the full backfill workflow.

---

### OQ-2: Session Secret Management
**✅ RESOLVED**  
`TUNEFETCH_SECRET` is a **required environment variable**. The container fails fast on startup if it is absent. See Section 4A.

---

### OQ-3: Lidarr Webhook Authentication
**✅ RESOLVED**  
No shared secret required. TuneFetch and Lidarr always share the same Docker host and communicate over the internal network. The webhook endpoint does not need authentication at the application layer.

---

### OQ-4: What Happens When a List Is Deleted?
**✅ RESOLVED**  
If the deleted list is the Lidarr owner of one or more artists, ownership is **transferred** to another list that also contains those artists. The transfer is implemented by calling `PUT /api/v1/artist` in Lidarr to update the `rootFolderPath` to the new owning list's root folder. Lidarr will physically move the files to the new location.

**Implications:**
- The deletion flow must identify all owned artists and present a list to the user before proceeding.
- The user must confirm the transfer explicitly — this is not automatic.
- All existing `mirror_files` records pointing to the old root folder paths must be updated (or recreated) after the move completes.
- If no other list contains a given artist, deletion is blocked until the user either adds the artist to another list or explicitly chooses to remove it from Lidarr entirely.
- This interaction is significantly simpler in **copy mode** (OQ-7): copies remain valid at their existing paths regardless of where Lidarr moves the source files, so only the DB records need updating.

---

### OQ-5: Search Scope — Existing Lidarr Library
**✅ RESOLVED**  
Yes. Search results should also query Lidarr's existing library (`GET /api/v1/artist`, `GET /api/v1/album`) and surface items already in Lidarr but not yet in any TuneFetch list. This allows retroactive tagging of existing content. Results from Lidarr and MusicBrainz should be visually distinguished (e.g., a "In Lidarr" badge).

---

### OQ-6: Orphan Detection Schedule
**✅ RESOLVED**  
Orphan detection runs **automatically on a configurable schedule** (default: daily at 03:00). The schedule is set in the Settings page. A manual **Scan Now** button is also available. Orphans are flagged in the Mirror Health Dashboard but are never deleted automatically.

---

### OQ-7: Symlinks vs File Copies for Mirroring
**✅ RESOLVED — File copies.**  
The kids and adult libraries are small enough that disk duplication is not a concern. File copies are operationally simpler: no broken-link risk, no symlink chain to update during ownership transfer, and secondary copies remain playable even during a Lidarr upgrade event. See Section 4E for the full copy workflow.

---

## 10. Future Scope (Out of v1)

The following features are explicitly deferred to avoid scope creep. They are documented here so they can inform v1 architectural decisions without blocking them.

- **Multi-user accounts with per-user list ownership** — The single admin user model is deliberate for v1. The `users` table is designed to support expansion.
- **Plex library rescan trigger** — TuneFetch could call Plex's API after a successful symlink creation to trigger an immediate library scan.
- **Last.fm / Spotify import** — Importing a listening history or playlist from a third-party service to bulk-populate a list.
- **Mobile-responsive UI** — v1 targets desktop/tablet. Mobile optimisation is a v2 concern.
- **Album art display** — MusicBrainz provides cover art via the Cover Art Archive API. Not in scope for v1 but the MBID data needed is already being stored.
- **Download queue visibility** — A read-only view of Lidarr's current download queue, surfaced within TuneFetch for convenience.
- **Notification on download complete** — Push a browser or email notification when a requested track has been downloaded and is available.

---

*Document maintained by TuneFetch project. Update this file as design decisions are finalised or revised.*
