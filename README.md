# TuneFetch

Lightweight web app that sits between family members, MusicBrainz, and a local Lidarr instance. See [REQUIREMENTS.md](./REQUIREMENTS.md) for the full design.

## Stack

- SvelteKit (TypeScript) — UI and API routes
- Node.js (adapter-node)
- SQLite via `better-sqlite3`
- Tailwind CSS
- Single Docker container, deployed on Unraid

---

## Deploying on Unraid

### Step 1 — Make the GHCR image public (once, on GitHub)

The CI workflow pushes a Docker image to GitHub Container Registry on every push to `main`. By default the package is private. To pull it on Unraid without a token:

1. Go to `https://github.com/amanimmortal?tab=packages`
2. Click **tunefetch** → **Package settings** → **Change visibility** → **Public**

The image URL is: `ghcr.io/amanimmortal/tunefetch:latest`

### Step 2 — Create the appdata folder

```bash
mkdir -p /mnt/user/appdata/tunefetch
```

### Step 3 — Deploy via Unraid Docker UI (recommended)

In the Unraid web UI go to **Docker → Add Container** and fill in:

| Field | Value |
| --- | --- |
| Name | `tunefetch` |
| Repository | `ghcr.io/amanimmortal/tunefetch:latest` |
| Network Type | Bridge |
| Port | Host `3000` → Container `3000` (TCP) |

Add the following **Path** mappings (Container Type = Path, Access Mode = Read/Write):

| Container path | Host path |
| --- | --- |
| `/app/data` | `/mnt/user/appdata/tunefetch` |
| `/mnt/music/parents` | `/mnt/user/media/music/parents` |
| `/mnt/music/kids` | `/mnt/user/media/music/kids` |

Add one path per Lidarr root folder you have. The container paths are what you will enter in TuneFetch's Settings page as root folder values — they must match exactly what Lidarr uses inside its own container (or the path Lidarr reports via its API).

Add the following **Variable** (Environment) entries:

| Variable | Value | Notes |
| --- | --- | --- |
| `TUNEFETCH_SECRET` | *(random 64-char string)* | Generate with `openssl rand -hex 32`. Required — server won't start without it. |
| `PUID` | `99` | Unraid's `nobody` user. Match your Lidarr PUID. |
| `PGID` | `100` | Unraid's `users` group. Match your Lidarr PGID. |
| `TUNEFETCH_ADMIN_USER` | `admin` | *(optional)* Pre-seeds the admin account on first boot. |
| `TUNEFETCH_ADMIN_PASSWORD` | *(your password)* | *(optional)* Min 8 chars. Only used on first boot if no admin exists yet. |
| `ORIGIN` | `http://<unraid-ip>:3000` | **Required if using a reverse proxy.** SvelteKit uses this for CSRF validation on form submissions. Set to the URL you actually browse to (e.g. `https://tunefetch.yourdomain.com`). |

Click **Apply**. The container will start and pull the image automatically.

### Step 4 — First-run setup

Open `http://<unraid-ip>:3000` in a browser.

- If you did **not** set `TUNEFETCH_ADMIN_USER`/`TUNEFETCH_ADMIN_PASSWORD`, the app will redirect to `/setup` where you can create the admin account.
- If you did pre-seed those env vars, log in directly with those credentials.

### Step 5 — Configure Lidarr connection

Go to **Settings** in the TuneFetch nav and enter:

- **Lidarr URL** — e.g. `http://192.168.1.100:8686` (use the LAN IP, not `localhost`)
- **Lidarr API key** — copy from Lidarr → Settings → General → Security

Click **Save & Test**. A green banner confirms the connection.

### Step 6 — Configure the Lidarr webhook

TuneFetch needs to receive events from Lidarr when files are downloaded or upgraded so it can copy them into secondary library folders automatically.

In Lidarr, go to **Settings → Connect → + (Add) → Webhook** and configure:

| Field | Value |
| --- | --- |
| Name | `TuneFetch` |
| URL | `http://<unraid-ip>:3000/api/webhook/lidarr` |
| Method | POST |
| On Download | ✓ |
| On Upgrade | ✓ |

Use the **Test** button in Lidarr to confirm TuneFetch receives the ping (look for a 200 OK in Lidarr's logs).

> **Note:** No shared secret is needed — TuneFetch and Lidarr communicate over your local network. If you run TuneFetch behind a reverse proxy with HTTPS, use the proxy URL in the webhook field.

### Step 7 — Create lists and add music

1. Go to **Lists → New list**, give it a name, and pick the root folder for that library (e.g. `/mnt/music/kids`).
2. Use the **Search** page to find any artist, album, or track on MusicBrainz.
3. Select the list from the dropdown on a result card and click **Add**.
4. The item's status will move from `pending` → `synced` as TuneFetch pushes it to Lidarr.
5. If the artist already lives in another list's library, status becomes `mirror_pending` and files are copied over in the background.

---

## Deploying via docker-compose (alternative)

```bash
cp docker-compose.example.yml docker-compose.yml
# Edit docker-compose.yml: set TUNEFETCH_SECRET, adjust host paths
docker compose up -d
```

---

## All environment variables

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `TUNEFETCH_SECRET` | **yes** | — | >= 32 chars. Server refuses to start if missing or short. |
| `PUID` | recommended | `1000` | Runtime UID for file ownership. Set to match your Lidarr PUID (`99` on Unraid). |
| `PGID` | recommended | `1000` | Runtime GID. Set to match your Lidarr PGID (`100` on Unraid). |
| `ORIGIN` | if behind proxy | — | Full URL of the app as seen by browsers. Needed for CSRF to work through a reverse proxy (e.g. Nginx Proxy Manager). |
| `TUNEFETCH_DATA_DIR` | no | `/app/data` | Path inside the container where the SQLite DB is stored. Change only if remapping the data volume. |
| `TUNEFETCH_ADMIN_USER` | no | — | Pre-seed admin username on first boot. |
| `TUNEFETCH_ADMIN_PASSWORD` | no | — | Pre-seed admin password on first boot (hashed with Argon2id). |
| `PORT` | no | `3000` | HTTP port the Node server listens on inside the container. |
| `HOST` | no | `0.0.0.0` | Bind address inside the container. |

---

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
npm start   # runs node build/index.js on port 3000
```

## Running tests

```bash
npm test          # run once
npm run test:watch  # watch mode
```

Tests use Vitest with in-memory SQLite and mocked Lidarr/mirror dependencies. No external services needed.

---

## Project layout

```
src/
  app.html                  HTML shell
  app.css                   Tailwind entry + component classes
  hooks.server.ts           Auth gate, first-run redirect, scheduler startup, request logging
  lib/server/
    auth.ts                 Argon2id password hashing, session management
    db.ts                   SQLite singleton (better-sqlite3, WAL, safe migrations)
    env.ts                  Fail-fast env validation (TUNEFETCH_SECRET)
    lidarr.ts               Typed Lidarr API v1 client
    mirror.ts               File copy service — atomic copies, backfill jobs, re-mirror on upgrade
    musicbrainz.ts          MusicBrainz search client with 1 req/sec rate-limit queue
    orchestrator.ts         Lidarr push logic — Scenarios A/B/C, artist ownership, backfill trigger
    orchestrator.test.ts    Vitest unit tests — 13 tests, in-memory SQLite
    scheduler.ts            Nightly orphan scan, hourly session cleanup, startup Lidarr check
    settings.ts             Key/value settings store
    shutdown.ts             SIGTERM/SIGINT graceful shutdown — flushes mirror jobs, closes DB
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
docker/entrypoint.sh        UID/GID remapping at startup
docker-compose.example.yml
REQUIREMENTS.md             Full product + architecture spec
TODO.md                     Implementation status per phase
```

---

## Current status

**Phases 0–4 complete.** The application is feature-complete and hardened for initial production use.

- Foundation scaffold (SvelteKit, SQLite, Auth, Tailwind, Docker).
- Configurable Lidarr API client with full v1 coverage needed for orchestration.
- MusicBrainz search with 1 req/sec rate-limit queue and In Lidarr / list membership badges.
- Full search UI: find any artist/album/track and add it to a list in one action.
- List management: create, rename, delete (with ownership transfer confirmation).
- Push orchestrator: three scenarios covering artist adds, single track adds, and album adds. Artists not yet in Lidarr are added automatically (unmonitored) before the specific track or album is monitored.
- Mirror engine: when an artist is owned by another list's library, files are copied into the secondary root folder atomically. Background backfill handles existing files; the Lidarr webhook handles new downloads and upgrades.
- Mirror health dashboard: active/stale/pending file tables, Refresh Stale action, on-demand and scheduled orphan detection.
- Structured JSON request logging, graceful SIGTERM/SIGINT shutdown, hourly session cleanup, startup Lidarr reachability check.
- Orchestrator unit tests: 13/13 passing (Vitest, in-memory SQLite, mocked Lidarr/mirror).

See `TODO.md` for the full phase-by-phase breakdown.
