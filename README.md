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

## Project layout

```
src/
  app.html              HTML shell
  app.css               Tailwind entry + component classes
  hooks.server.ts       Auth gate, first-run redirect, env validation
  lib/server/           DB, auth, env, settings — server-only code
  routes/               UI routes (+page.svelte) and API routes (+server.ts)
Dockerfile              Multi-stage build, Alpine, PUID/PGID aware
docker-compose.example.yml
REQUIREMENTS.md         Full product + architecture spec
```

## Status

**Phase 1B Complete.** The application includes:
- Foundation scaffold (SQLite, SvelteKit, Auth, Tailwind).
- Configurable Lidarr API client.
- MusicBrainz API integration with rate-limit queueing.
- A functional Search UI that tags matching Lidarr tracks automatically.

**Up Next:**
- Phase 2: Lists & Lidarr push orchestration (sending tracks to Lidarr).
- Phase 3: Mirror engine (File copying background processor).
- Phase 4: Hardening and Webhooks.

See `TODO.md` and `REQUIREMENTS.md` for full breakdown.
