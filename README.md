# TuneFetch

Lightweight web app that sits between family members, MusicBrainz, and a local Lidarr instance. See [REQUIREMENTS.md](./REQUIREMENTS.md) for the full design.

## Stack

- SvelteKit (TypeScript) — UI and API routes
- Node.js (adapter-node)
- SQLite via `better-sqlite3`
- Tailwind CSS
- Single Docker container, deployed on Unraid

## Local development

```bash
# 1. Install dependencies
npm install

# 2. Set up environment
cp .env.example .env
# Edit .env and set TUNEFETCH_SECRET to a random 32+ char string.

# 3. Run the dev server
npm run dev
```

The app listens on http://localhost:5173 in dev. On first load it will redirect to `/setup` to create the admin account (unless you pre-seeded via `TUNEFETCH_ADMIN_USER` / `TUNEFETCH_ADMIN_PASSWORD`).

## Production build

```bash
npm run build
npm start   # runs node build/index.js on port 3000 by default
```

## Docker

```bash
# Build and run with compose (copy the example first and adjust paths).
cp docker-compose.example.yml docker-compose.yml
docker compose up -d --build
```

### Required volume mounts

| Container path | Host path (example) | Purpose |
| --- | --- | --- |
| `/app/data` | `/mnt/user/appdata/tunefetch` | SQLite DB + config |
| `/mnt/music/<library>` | `/mnt/user/media/music/<library>` | Each Lidarr root folder (rw) |

### Required env vars

| Variable | Required | Notes |
| --- | --- | --- |
| `TUNEFETCH_SECRET` | yes | >= 32 chars. Server fails to start if missing. |
| `PUID` / `PGID` | recommended | Unraid user/group for file ownership. |
| `TUNEFETCH_ADMIN_USER` | no | Pre-seed admin username. |
| `TUNEFETCH_ADMIN_PASSWORD` | no | Pre-seed admin password (hashed on first run). |

## Lidarr webhook setup

TuneFetch needs to receive events from Lidarr when files are downloaded or upgraded, so it can copy them into secondary library folders automatically.

In Lidarr, go to **Settings → Connect → + (Add) → Webhook** and configure:

| Field | Value |
| --- | --- |
| Name | TuneFetch |
| URL | `http://<tunefetch-host>:3000/api/webhook/lidarr` |
| Method | POST |
| On Download | ✓ |
| On Upgrade | ✓ |

No shared secret is required — TuneFetch and Lidarr share the same Docker host and communicate over the internal network. Use the **Test** button in Lidarr to verify the connection.

## Project layout

```
src/
  app.html                  HTML shell
  app.css                   Tailwind entry + component classes
  hooks.server.ts           Auth gate, first-run setup redirect, scheduler startup
  lib/server/
    auth.ts                 Argon2id password hashing, session management
    db.ts                   SQLite singleton (better-sqlite3, WAL, safe migrations)
    env.ts                  Fail-fast env validation (TUNEFETCH_SECRET)
    lidarr.ts               Typed Lidarr API v1 client
    mirror.ts               File copy service — atomic copies, backfill, re-mirror on upgrade
    musicbrainz.ts          MusicBrainz search client with 1 req/sec queue
    orchestrator.ts         Lidarr push logic — Scenarios A/B/C, artist ownership, backfill trigger
    scheduler.ts            Nightly orphan scan scheduler + runOrphanScan()
    settings.ts             Key/value settings store
    schema.sql              SQLite schema (idempotent, applied on boot)
  routes/
    +page.svelte            Search UI (MusicBrainz search → add to list)
    lists/                  List CRUD + detail pages
    mirrors/                Mirror health dashboard
    settings/               Lidarr URL/API key, admin email, orphan scan time
    api/
      search/               GET — MusicBrainz + Lidarr badge lookup
      lists/[id]/
        retry/              POST — re-run orchestrator for a failed item
        status/             GET — poll sync_status for all items in a list
      webhook/lidarr/       POST — Lidarr Download/Upgrade webhook receiver
Dockerfile                  Multi-stage build, Alpine, PUID/PGID aware
docker-compose.example.yml
REQUIREMENTS.md             Full product + architecture spec
TODO.md                     Implementation status per phase
```

## Current status

**Phases 0–3 complete.** The application is functionally complete for its core use case:

- Foundation scaffold (SvelteKit, SQLite, Auth, Tailwind, Docker).
- Configurable Lidarr API client with full v1 coverage needed for orchestration.
- MusicBrainz search with 1 req/sec rate-limit queue and In Lidarr / list membership badges.
- Full search UI: find any artist/album/track and add it to a list in one action.
- List management: create, rename, delete (with ownership transfer confirmation).
- Push orchestrator: three scenarios covering artist adds, single track adds, and album adds. Artists not yet in Lidarr are added automatically (unmonitored) before the specific track or album is monitored.
- Mirror engine: when an artist is owned by another list's library, files are copied into the secondary root folder. Background backfill handles existing files; the Lidarr webhook handles new downloads and upgrades.
- Mirror health dashboard: active/stale/pending file tables, Refresh Stale action, on-demand and scheduled orphan detection.

**Up next — Phase 4: Hardening**

- Structured request logging.
- Graceful shutdown (DB close, flush pending copies).
- Session cleanup job.
- Orchestrator unit tests (mock Lidarr fetch).
- Webhook reachability check on startup.
- Lidarr setup section in this README.

See `TODO.md` for the full breakdown.
