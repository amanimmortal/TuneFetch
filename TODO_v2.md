# TuneFetch — v2 Backlog

> **Purpose:** Tracks quality-of-life improvements identified during v1 development, plus the deferred future-scope items from REQUIREMENTS.md §10. None of these are required for the core use case — v1 is fully functional without them.
>
> **Last updated:** 2026-04-18

---

## Quality-of-life improvements (v1 gaps)

These are small-to-medium gaps noticed during v1 development. They don't block use but will become friction points once the app is in daily use.

### Mirror engine

**Automatic stale-mirror retry schedule**
Currently, mirror rows that failed to copy (status `stale`) are only retried when a user clicks "Refresh Stale" on the mirror health dashboard. A nightly retry job (similar to the orphan scan scheduler) would resolve transient copy failures (e.g. NAS spinup delays) without manual intervention.
- Suggested approach: add a `retryStale()` function in `mirror.ts`, call it from `scheduler.ts` alongside the orphan scan. Expose the last retry count + timestamp on the dashboard.

**Orphan file deletion from the dashboard**
Orphan files are detected and listed but can only be investigated — there is no in-app way to delete them. A "Delete selected orphans" action with a confirmation dialog would close the loop.
- Risk: file deletion is irreversible. Show full paths, require explicit checkbox selection, and log each deletion.

**Mirror progress live feedback**
Background backfill jobs run fire-and-forget. The only way to know one has finished is to refresh the list detail page and see `mirror_pending → synced`. A lightweight SSE or polling endpoint (e.g. `GET /api/lists/[id]/mirror-progress`) returning backfill job counts would let the UI update the status badge without a full page reload.

**Retry-all-failed button**
The list detail page supports retrying one failed item at a time. A "Retry all failed" button that iterates over every `sync_status = 'failed'` row in the list would save clicks after a Lidarr outage.

### Search & discovery

**Search result pagination**
MusicBrainz returns a limited result window. A "Load more" button passing an `offset` parameter to the `/api/search` endpoint would surface deeper results for common artist/album names.

**"Already in list" indicator on search cards**
Search result cards show "In Lidarr" and list membership badges, but the "Add to list" dropdown still offers all lists including ones the item is already in. Disabling or hiding already-added lists in the dropdown would prevent accidental duplicate adds (which currently produce a DB UNIQUE constraint error surfaced as a generic failure).

**Bulk add from search**
Currently one item can be added per search result card. A "Select multiple → Add all to list" flow would be useful when adding a whole discography one album at a time.

### UI / UX

**In-app log viewer**
Structured JSON logs go to stdout (visible via `docker logs tunefetch`) but are not surfaced in the UI. A `/admin/logs` page tailing the last N log lines would help non-technical users diagnose issues without SSH access.

**List item ordering**
Items are displayed in insertion order only. Allowing manual drag-to-reorder or sorting by `sync_status` / `artist_name` / `date added` would improve usability on long lists.

**Export list as CSV / JSON**
No way to export a list's contents. A simple download action on the list detail page (artist, title, type, status, dates) would be useful for auditing and backups.

**Dashboard landing page**
The home page (`/`) is the search page. A small dashboard showing pending/failed counts, recent mirror activity, and a quick-add search box would make more sense as the default landing page once lists are established.

### Security & operations

**Webhook shared secret**
The Lidarr webhook endpoint (`/api/webhook/lidarr`) is unauthenticated — justified in v1 because TuneFetch and Lidarr share the same Docker host. If TuneFetch is ever exposed beyond the LAN, the endpoint should validate a shared secret header (configurable in Settings, passed in the Lidarr webhook URL as a query param or header).

**GHCR package auto-publish**
The GitHub Actions workflow builds and pushes the image on every push to `main`, but the GHCR package starts private and requires a manual visibility change. An additional workflow step (or a one-time repo setting) to set the package to public would eliminate this friction for new deployments.

**Settings page validation**
The settings form accepts any string for Lidarr URL and orphan scan time. Adding client-side and server-side validation (valid URL format, valid HH:MM time) would prevent hard-to-diagnose failures.

---

## Future scope (deferred from v1 — REQUIREMENTS.md §10)

These items were explicitly out of scope during v1 planning. The v1 architecture accommodates them but they are not started.

**Multi-user accounts with per-user list ownership**
The single admin user model is deliberate for v1. The `users` table is already designed to support expansion — adding a `owner_user_id` FK to `lists` and a list-permissions model would be the main changes. Separate login credentials per family member, each seeing only their own lists.

**Plex library rescan trigger**
After a successful file copy into a secondary root folder, TuneFetch could call the Plex API to trigger an immediate library scan for that folder, making the track available in Plex without waiting for the scheduled scan interval.

**Last.fm / Spotify playlist import**
Importing a listening history or playlist from a third-party service to bulk-populate a list. The MusicBrainz MBID needed for orchestration can be resolved from track/artist names via the existing search client.

**Mobile-responsive UI**
v1 targets desktop/tablet. The Tailwind CSS foundation is in place; mobile layout work is a v2 concern.

**Album art display**
MusicBrainz provides cover art via the Cover Art Archive API. The release-group MBID is already stored on `list_items.mbid` for album-type rows, so fetching art requires only an additional API call on the list detail page.

**Download queue visibility**
A read-only view of Lidarr's current download queue (via `GET /api/v1/queue`), surfaced within TuneFetch for convenience so users don't need to open Lidarr separately to check download progress.

**Notification on download complete**
Push a browser notification (Web Push API) or email when a requested track has been downloaded and is available in the library. The Lidarr webhook is already the trigger point — it would only need an additional notification dispatch after a successful mirror copy.
