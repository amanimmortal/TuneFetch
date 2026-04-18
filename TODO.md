# TuneFetch — Development TODO

> **Purpose:** Snapshot of what's built vs. what's left, so a new conversation can pick up cold.
>
> **Primary source of truth:** [REQUIREMENTS.md](./REQUIREMENTS.md) — all design decisions live there. This file tracks implementation status against those requirements.
>
> **Last updated:** 2026-04-18

---

## How to resume this project in a new conversation

1. Read [REQUIREMENTS.md](./REQUIREMENTS.md) in full — it is the complete spec.
2. Read this file to see what's implemented and what's next.
3. Confirmed decisions the user made during scaffold:
   - SvelteKit project lives at the **repo root** (not in a subfolder).
   - **TypeScript**, **npm**, `adapter-node`.
   - Build approach: **foundation first**, then feature work (not vertical slices).
4. User preferences (carry these into any new session):
   - Factual, objective tone — no emotional language.
   - **Ask clarifying questions, never assume.**
   - Target is Unraid + Docker. Australian context where relevant.
5. Environment notes for anyone running this:
   - `TUNEFETCH_SECRET` must be set (>= 32 chars) or the server refuses to start.
   - Local dev data lives in `./data` (see `.env.example`). Docker uses `/app/data`.
   - DB is `tunefetch.db` inside the data dir, WAL mode, schema auto-applied on boot.

---

## Phase 0 — Foundation (COMPLETE)

Scaffolding and infrastructure. Verified via `npx svelte-check` (0 errors) and a production `vite build` + smoke test.

- [x] SvelteKit + TypeScript scaffold at repo root
  - `package.json`, `tsconfig.json`, `svelte.config.js`, `vite.config.ts`
  - `adapter-node`, port 3000 in prod, 5173 in dev
- [x] Tailwind CSS wired up
  - `tailwind.config.ts`, `postcss.config.js`, `src/app.css`
  - Pre-defined component classes: `btn`, `btn-primary`, `btn-secondary`, `btn-danger`, `input`, `card`, `badge`
- [x] SQLite schema + DB module (REQUIREMENTS §5)
  - `src/lib/server/schema.sql` — all tables from the spec plus a `sessions` table
  - `src/lib/server/db.ts` — singleton `better-sqlite3` with WAL + foreign keys, schema applied idempotently via `?raw` import
  - `src/vite-env.d.ts` — TS declaration for the `?raw` import
- [x] Env validation (REQUIREMENTS §4A, OQ-2)
  - `src/lib/server/env.ts` — fails fast if `TUNEFETCH_SECRET` absent or <32 chars
- [x] Settings key/value store (REQUIREMENTS §4F)
  - `src/lib/server/settings.ts` — typed key constants + `getSetting`/`setSetting`/`getAllSettings`
- [x] Auth skeleton (REQUIREMENTS §4A)
  - `src/lib/server/auth.ts` — Argon2id via `@node-rs/argon2`, server-side session table, 30-day TTL, cleanup helper, `maybeSeedAdmin` for env-var seeding
  - `src/hooks.server.ts` — auth gate, seed-on-first-request, redirects unauthenticated to `/login?redirect=…`, redirects to `/setup` if no admin exists, public prefixes: `/login`, `/setup`, `/api/webhook/`
  - `src/routes/login/` — form, POST action, sets HTTP-only signed cookie
  - `src/routes/setup/` — first-run admin creation form (min 8-char password, confirm)
  - `src/routes/logout/+server.ts` — POST-only, deletes session
- [x] Baseline layout + nav
  - `src/routes/+layout.svelte` — top nav (Search / Lists / Mirror Health / Settings) + user chip + sign-out, hidden on `/login` and `/setup`
  - `src/routes/+layout.server.ts` — exposes `user` to layout data
  - Placeholder pages: `/` (Search), `/lists`, `/mirrors`, `/settings`
- [x] Settings page (UI scaffold only — form actions not wired)
  - `src/routes/settings/+page.server.ts` loads current settings
  - `src/routes/settings/+page.svelte` renders the four fields (Lidarr URL/API key, admin contact email, orphan scan time)
- [x] Docker deployment
  - `Dockerfile` — multi-stage, `node:20-alpine`, builds native deps, runs via `tini` + `su-exec` as PUID/PGID-mapped user, exposes 3000, volume `/app/data`
  - `docker/entrypoint.sh` — remaps runtime uid/gid to `PUID`/`PGID`, chowns data dir
  - `docker-compose.example.yml` — example with the required volume mounts
  - `.dockerignore`
- [x] Dev docs
  - `README.md` — local dev, build, Docker usage
  - `.env.example` — all env vars
- [x] Verified
  - `npx svelte-check` → 0 errors, 0 warnings
  - `vite build` → clean
  - `node build/index.js` boots, `/` 303→`/setup`, `/setup` returns 200
  - Missing `TUNEFETCH_SECRET` causes startup crash with a clear message

---

## Phase 1 — Search & Lidarr connection (NEXT)

Recommended order because search results need to show "in Lidarr" badges (OQ-5) and list creation needs Lidarr's root folder list (§4C), so both features require the Lidarr client first.

### 1A. Lidarr API client (REQUIREMENTS §4D, §6) — COMPLETE

- [x] `src/lib/server/lidarr.ts` — typed client
  - Base URL + API key read from settings via `settings.ts` at call time
  - Exports `LidarrError` (structured, carries HTTP status + body for `sync_error`)
  - Helpers: `systemStatus()`, `rootFolders()`, `listArtists()`, `getArtistByMbid(mbid)`, `addArtist(…)`, `updateArtist(…)`, `getAlbums(artistId)`, `updateAlbum(…)`, `getTracks(artistId)`, `updateTrack(…)`, `getTrackFiles(artistId)`, `runCommand(name, body)`
  - All 4xx/5xx + network errors surface as `LidarrError`
  - Unit-testable: all functions accept optional `fetchFn` override
- [x] Settings page form actions (`?/save`, `?/testConnection`)
  - `?/save` writes settings via `setSetting`, then calls `systemStatus()` and returns connection result
  - `?/testConnection` tests current saved settings without modifying them
  - Both actions return `{ connectionStatus, connectionMessage, saved }` for the UI
- [x] `src/lib/server/settings.ts` — `getLidarrConfig()` added, throws if URL or API key unset

### 1B. MusicBrainz client (REQUIREMENTS §4B, §6) - COMPLETE

- [x] `src/lib/server/musicbrainz.ts` — server-side client
  - 1 req/sec global queue (simple promise chain serialising calls)
  - `User-Agent: TuneFetch/1.0 ( <admin_contact_email> )` — email pulled from settings at request time
  - Methods for `artist`, `release-group`, `recording` search
- [x] `src/routes/api/search/+server.ts` — GET handler
  - Query params: `q`, `type` (`artist|album|track`)
  - Runs MusicBrainz search + Lidarr artist match (OQ-5) + list-membership lookup in one response
  - Returns a shape suitable for the card layout (`{ results: [{ mbid, type, title, artist, album, inLidarr, listMemberships: [{ listId, listName }] }] }`)
- [x] `src/routes/+page.svelte` — Search UI
  - Text input + type filter
  - Result cards per REQUIREMENTS §4B (badges for "In Lidarr", list memberships)
  - Each card has an "Add to list" dropdown populated from `lists` table
  - Submits to an `add-to-list` action (wire minimally — full orchestration in Phase 2)

---

## Phase 2 — Lists & push orchestration (REQUIREMENTS §4C, §4D)

- [ ] List CRUD
  - `GET/POST` for list create/rename/delete in `src/routes/lists/`
  - Root folder dropdown populated from `lidarr.rootFolders()`
  - Delete flow: check `artist_ownership`, show list of affected artists, force confirmation, run ownership transfer (OQ-4)
- [ ] List detail page (`/lists/[id]`)
  - Items with `sync_status` badges, error rows with Retry, mirror progress rows
- [ ] Push orchestrator (`src/lib/server/orchestrator.ts`)
  - Scenario A: full artist (monitor=all; if existing owner → mirror workflow)
  - Scenario B: single track (monitor=none + PUT track to monitored=true + TrackSearch; if existing owner → mirror)
  - Scenario C: full album (monitor=none + PUT album to monitored=true + AlbumSearch; if existing owner → mirror)
  - Writes `artist_ownership` on first add, populates Lidarr IDs on `list_items`
  - All DB writes for an orchestrator run happen in a single transaction
  - On error: `sync_status='failed'`, `sync_error` populated
- [ ] Retry endpoint — re-runs the orchestrator for a specific `list_items.id`
- [ ] UI progress mechanism — SSE or simple polling of `/api/list/:id/status`

---

## Phase 3 — Mirror engine (REQUIREMENTS §4E, OQ-1, OQ-7)

- [ ] Mirror copy service (`src/lib/server/mirror.ts`)
  - `copyFile(sourcePath, mirrorPath)` — creates intermediate dirs, atomic write (temp + rename)
  - `mirrorAllForArtist(artistId, targetListId)` — enumerates Lidarr `trackfile` endpoint, copies each
  - Background job runner — simple async queue in-process (v1 scope, single container)
- [ ] Webhook handler (`src/routes/api/webhook/lidarr/+server.ts`)
  - No auth (OQ-3). Internal network only — document in README.
  - Handles `Download` and `Upgrade` events
  - `Download` → for each list with this artist registered, copy file into secondary root
  - `Upgrade` → find `mirror_files` where `source_path` matches, re-copy, mark `active`
- [ ] Mirror health dashboard (`/mirrors`)
  - List active / stale / orphan rows
  - "Refresh Stale" button → re-copies all `status='stale'` rows
  - "Scan Now" button → runs orphan detector on demand
- [ ] Scheduled orphan scanner (REQUIREMENTS §4E, OQ-6)
  - Read schedule from settings (`orphan_scan_time`, HH:MM)
  - In-process scheduler fires once per day at configured time
  - Walks secondary root folders, flags files with no matching `mirror_files` row
  - Never auto-deletes — surfaces in the dashboard only

---

## Phase 4 — Hardening

- [ ] Request logging (structured, minimal)
- [ ] Graceful shutdown — close DB, flush pending copies
- [ ] Session cleanup job — call `cleanupExpiredSessions()` on a timer
- [ ] Tests for the orchestrator's three scenarios (mock `fetch` for Lidarr)
- [ ] Webhook reachability check on startup → warn in logs if unreachable (Risk §8 item 2)
- [ ] Docs: a short "Lidarr setup" section in README covering the Connect → Webhook config

---

## Conventions in this codebase (for the next AI)

- **Imports**: `$lib/server/*` for server-only modules. SvelteKit enforces this — anything in `src/lib/server/` cannot be imported from client code.
- **Types from generated route files**: `import type { PageServerLoad, Actions, RequestHandler } from './$types'` — NOT from `@sveltejs/kit`.
- **Redirects**: SvelteKit 2 style — `redirect(303, '/foo')` with no `throw`. `redirect()` returns `never` and throws internally.
- **DB access**: always via `getDb()` from `src/lib/server/db.ts`. `better-sqlite3` is synchronous; don't `await` prepared-statement calls.
- **Password hashing**: `@node-rs/argon2` (`hash` / `verify`). Keep defaults.
- **Settings reads**: via `getSetting(SETTING_KEYS.FOO)`. New keys → extend the `SETTING_KEYS` object.
- **Sync status strings**: exactly the set in `list_items.sync_status` CHECK constraint — `pending | synced | failed | mirror_pending | mirror_active | mirror_broken`.
- **Mirror status strings**: exactly `pending | active | stale` per `mirror_files.status`.
- **No Windows paths in code** — all paths are Linux container paths. The container maps Unraid paths via volume mounts.
- **Native modules** (`better-sqlite3`, `@node-rs/argon2`) are marked external in `vite.config.ts`. If you add another native dep, add it there too.
- **Sandbox build quirk** (dev environment only): SvelteKit's `.svelte-kit/types` regeneration can EPERM on the virtiofs mount used in this sandbox. Not a code issue — `docker compose build` and native-filesystem `npm run build` both work. If you hit it during development verification, copy the project to `/tmp` and build there.

---

## Files to read when resuming

In order:

1. [REQUIREMENTS.md](./REQUIREMENTS.md) — the spec.
2. [README.md](./README.md) — dev/run instructions.
3. `src/lib/server/schema.sql` — current data model.
4. `src/lib/server/auth.ts` and `src/hooks.server.ts` — understand the auth gate before touching routes.
5. `src/routes/+layout.svelte` — nav structure, reuse the existing pattern.
6. This file — to see what's next.
