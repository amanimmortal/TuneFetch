# TuneFetch — Code Review

**Reviewed:** 2026-04-25
**Scope:** Correctness/bugs + Requirements compliance (per `REQUIREMENTS.md`), full depth (incl. nits/style), with suggested fixes.
**Verification performed:**
- `npm install` (Linux), `npx tsc --noEmit -p .` (real compile errors captured)
- `npx vitest run` (test suites attempted)
- `npx svelte-kit sync` (config deprecation warnings captured)
- Manual file-by-file review against `REQUIREMENTS.md`

> **Severity legend** — **P0** blocks build/runtime, **P1** security or data-corruption risk, **P2** correctness/requirements deviation, **P3** quality/nits.

---

## P0 — Build / tooling

### P0-1 — Reviewer-side false alarm: three files appeared truncated; **resolved**

> **Status: not a bug.** Recording for context.
>
> While running `tsc --noEmit` during this review, three files (`orchestrator.ts`, `plex.ts`, `plex-sync.ts`) appeared truncated mid-statement and `tsc` reported three `TS1005` syntax errors. A re-check minutes later showed the files intact — they were being edited by a parallel agent at the time the snapshot was taken. Final verification with `wc -l` and `tail` shows all three files end cleanly at their expected closing braces, and `tsc` no longer reports any `TS1005` errors. No action required.

### P0-2 — Vitest configuration is brittle against current Vite

`npx vitest run` emits the warning:

```
warning: optimizeDeps.esbuildOptions option was specified by "vite-plugin-svelte"
plugin. This option is deprecated, please use optimizeDeps.rolldownOptions instead.
```

`npx vitest run --reporter=basic` fails with `Failed to load custom Reporter from basic` — the `basic` reporter alias was removed somewhere between Vitest 2.x and 4.x. The default reporter still starts.

**Fix:** pin a compatible matrix in `package.json` — e.g. `"vitest": "^2.1.0"` against Vite 5/6, or upgrade `vite-plugin-svelte` to a version that supports the rolldown options. Verify with `npm test`.

### P0-3 — `svelte-kit sync` deprecation

`npx svelte-kit sync` emits:

```
config.kit.csrf.checkOrigin has been deprecated in favour of csrf.trustedOrigins.
It will be removed in a future version
```

This will become a hard error on the next major SvelteKit. See P1-2 for the fix; it pairs with the CSRF security finding.

---

## P1 — Security

### P1-1 — CSRF protection disabled (and the option used is deprecated)

`svelte.config.js`:

```js
kit: {
  adapter: adapter({ out: 'build' }),
  csrf: {
    checkOrigin: false   // ← disables Origin/Referer enforcement
  }
}
```

`npx svelte-kit sync` confirms:

```
config.kit.csrf.checkOrigin has been deprecated in favour of csrf.trustedOrigins.
```

The TuneFetch UI uses cookie-based session auth and form-action POSTs. With CSRF disabled, any third-party page the admin visits can submit cross-origin forms that perform list edits, settings changes, or item deletions while the admin's session cookie is valid.

**Fix:** re-enable CSRF and migrate to the new option:

```js
// svelte.config.js
import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ out: 'build' }),
    csrf: {
      // Allow only the host(s) the admin actually uses. For LAN+reverse-proxy
      // setups list both. Empty array = strict same-origin.
      trustedOrigins: [
        // e.g. 'https://tunefetch.example.com',
      ]
    }
  }
};

export default config;
```

If form actions stop working in dev, list `http://localhost:5173` in `trustedOrigins`.

### P1-3 — Webhook endpoint has no authentication, and the public-prefix matcher is too permissive

`src/hooks.server.ts` line 14:

```ts
const PUBLIC_PREFIXES = ['/login', '/setup', '/api/webhook/'];
```

`src/routes/api/webhook/lidarr/+server.ts` lines 5–12 say "No authentication is required" because Lidarr and TuneFetch share an internal Docker network. Two problems:

1. The prefix `'/api/webhook/'` matches *any* future webhook route — there's no allow-list of which webhook is auth-free.
2. If the user later exposes TuneFetch behind a reverse proxy (as `Dockerfile` env `HOST=0.0.0.0` suggests is normal), the webhook becomes reachable from the internet and can be hammered. Each call kicks off file copies and DB writes — trivial DoS.

**Fix:** require a shared secret on the webhook and only mark this exact path as public.

```ts
// hooks.server.ts
const PUBLIC_PREFIXES = ['/login', '/setup'];
const PUBLIC_EXACT = new Set(['/api/webhook/lidarr']);

function isPublic(pathname: string): boolean {
  return PUBLIC_EXACT.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}
```

```ts
// src/routes/api/webhook/lidarr/+server.ts (top of POST)
import { env } from '$env/dynamic/private';

const expected = env.LIDARR_WEBHOOK_SECRET;
const provided = request.headers.get('x-tunefetch-secret');
if (expected && provided !== expected) {
  return json({ error: 'unauthorized' }, { status: 401 });
}
```

In Lidarr's webhook config, add the same value as a custom header. Document this in `REQUIREMENTS.md`.

### P1-4 — Plex user tokens stored in plaintext

`src/lib/server/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS plex_user_mappings (
  id                INTEGER PRIMARY KEY,
  root_folder_path  TEXT NOT NULL UNIQUE,
  plex_user_name    TEXT NOT NULL,
  plex_user_token   TEXT NOT NULL,        -- ← plaintext
  ...
);
CREATE TABLE IF NOT EXISTS plex_playlists (
  ...
  plex_user_token   TEXT NOT NULL,        -- ← duplicated plaintext
  ...
);
```

Plex tokens grant full library access for a managed user. SQLite file lives at `/app/data/tunefetch.db`; on Unraid this share is often readable by other containers.

**Fix:** encrypt at rest using `TUNEFETCH_SECRET` (which is currently loaded but unused — see P1-5). Use `node:crypto` `createCipheriv` with AES-256-GCM. Keep the token's first 4 chars + last 4 chars in a separate column for UI display. Don't store the same token twice — drop `plex_playlists.plex_user_token` and `plex_playlists.plex_user_name` and JOIN through `plex_user_mappings.id`.

### P1-5 — `TUNEFETCH_SECRET` is required but never used

`src/lib/server/env.ts` validates `TUNEFETCH_SECRET` length ≥ 32. `src/lib/server/auth.ts` imports `env` but never uses it; sessions are random 32-byte hex tokens stored in the DB unsigned.

That makes the secret a load-bearing piece of operational ceremony with no actual purpose. If the value rotates the user expects sessions to invalidate; today they don't.

**Fix:** either (a) sign the session-cookie value with HMAC(SECRET) and verify in `getSessionUser`, so secret rotation invalidates outstanding sessions, or (b) remove the secret requirement from `env.ts` and document that it is reserved for future encryption use. **(a)** is the cleaner path; pair with P1-4 and use the same secret as the AES key.

### P1-6 — Verbose debug logging exposes session/cookie metadata

`src/hooks.server.ts` lines 42–62, 80–92, 105–114 log on every non-asset request:

```ts
console.log(JSON.stringify({
  ts: new Date().toISOString(), tag: 'hooks.in',
  method: event.request.method, path: pathname, search: event.url.search,
  proto: event.url.protocol, host: ..., xfProto: ...,
  hasSessionCookieHdr, sessionIdPresent: Boolean(sessionId),
  userResolved: event.locals.user?.username ?? null
}));
```

…and on the way out:

```ts
const setCookieHdr = response.headers.get('set-cookie');
console.log(JSON.stringify({ ..., setCookie: setCookieHdr ? setCookieHdr.slice(0, 240) : null }));
```

`src/routes/login/+page.server.ts` lines 27–111 do the same on every login attempt: usernamePresent, credentialsOk, sessionIdLen, expiresAt, cookieSecure, cookieSecureMode. The first 240 chars of `set-cookie` include the cookie value — enough to copy into another browser.

The comments say "Remove once the login-loop issue is fully diagnosed." That's the fix.

**Fix:** delete these blocks (or gate them behind `if (env.DEBUG_HOOKS === '1')` if they have ongoing diagnostic value):

```ts
// hooks.server.ts — delete lines 42-62 and 80-92 and 105-114
// login/+page.server.ts — delete the four console.log JSON blocks
```

Keep one terse log line per failed login (no usernames, no cookie data) for ops visibility.

### P1-7 — Item-delete endpoint trusts whatever path is in the DB and has no auth/ownership check

`src/routes/api/lists/[id]/items/[itemId]/+server.ts`:

```ts
export const DELETE: RequestHandler = async ({ params }) => {
  const listId = Number(params.id);
  const itemId = Number(params.itemId);
  // No locals.user check, no ownership check beyond list_id matching item.list_id
  ...
  const mirrorFiles = db
    .prepare('SELECT mirror_path FROM mirror_files WHERE list_item_id = ?')
    .all(itemId) as Array<{ mirror_path: string }>;
  const fileResults = await Promise.allSettled(
    mirrorFiles.map((f) => fs.unlink(f.mirror_path))   // ← trusts DB
  );
  ...
};
```

Two issues:
1. No `locals.user` check; `hooks.server.ts` does require auth for `/api/...` paths so this is OK *today*, but the file is the wrong place to omit it — defensive.
2. `mirror_path` is dereferenced as a filesystem path with no validation that it lives under one of the configured Lidarr root folders. If a row's `mirror_path` is corrupted to `/etc/passwd`, this endpoint deletes it.

**Fix:**

```ts
import path from 'node:path';
import { listRootFolders } from '$lib/server/lidarr';

const allowedRoots = (await listRootFolders()).map((r) => path.resolve(r.path));
const fileResults = await Promise.allSettled(
  mirrorFiles
    .filter((f) => {
      const abs = path.resolve(f.mirror_path);
      const ok = allowedRoots.some((root) => abs.startsWith(root + path.sep));
      if (!ok) console.warn(`[delete-item] refusing to unlink path outside roots: ${abs}`);
      return ok;
    })
    .map((f) => fs.unlink(f.mirror_path))
);
```

Also: it's worth deleting `mirror_files` rows for refused paths in a separate pass (mark them `stale` + log) so the orphan scanner can flag them.

### P1-8 — Login `redirect=` parameter is an open-redirect vector

`src/routes/login/+page.server.ts` line 104:

```ts
const redirectTo = redirectParam ?? '/';
...
redirect(303, redirectTo);
```

The user-controlled `redirect=` query param is followed unconditionally. `https://tunefetch/login?redirect=https://evil.example.com/phish` will 303 the user to evil.example.com after a successful login, useful for phishing.

**Fix:** require the redirect to be an internal path:

```ts
function safeRedirect(target: string | null): string {
  if (!target) return '/';
  // Only allow same-site, no protocol-relative
  if (target.startsWith('/') && !target.startsWith('//')) return target;
  return '/';
}
const redirectTo = safeRedirect(redirectParam);
```

Apply the same fix in the `load` function (line 14).

---

## P2 — Correctness / Requirements deviation

### P2-1 — `artist_ownership.owner_list_id` lacks a delete rule, so list-deletion can fail

`src/lib/server/schema.sql` line 63:

```sql
CREATE TABLE IF NOT EXISTS artist_ownership (
  ...
  owner_list_id    INTEGER NOT NULL REFERENCES lists(id),  -- ← no ON DELETE clause
  ...
);
```

`lists.id` is not cascade-deleted, so deleting a list whose id appears in `artist_ownership.owner_list_id` raises `SQLITE_CONSTRAINT_FOREIGNKEY`. `REQUIREMENTS.md` OQ-4 says the delete flow must "transfer ownership" — but the schema has no mechanism for the transfer to succeed atomically.

**Fix (schema):**

```sql
-- artist_ownership table
owner_list_id INTEGER REFERENCES lists(id) ON DELETE SET NULL,
```

Combined with a transactional list-delete that nulls or reassigns `owner_list_id` first, then deletes the list. Add a migration:

```ts
// db.ts — migration block (idempotent)
const cols = db.prepare("PRAGMA foreign_key_list(artist_ownership)").all();
const ownerFK = cols.find((c: any) => c.from === 'owner_list_id');
if (ownerFK?.on_delete === 'NO ACTION') {
  db.exec(`
    BEGIN;
    CREATE TABLE artist_ownership_new (...);   -- with the ON DELETE clause
    INSERT INTO artist_ownership_new SELECT * FROM artist_ownership;
    DROP TABLE artist_ownership;
    ALTER TABLE artist_ownership_new RENAME TO artist_ownership;
    COMMIT;
  `);
}
```

### P2-2 — Single-track monitoring deviates from `REQUIREMENTS.md` §4D Scenario B

`src/lib/server/lidarr.ts` lines 332–334 (paraphrased from comment):

> Lidarr's API has no PUT endpoint for tracks — `/api/v1/track` and `/api/v1/track/{id}` are GET-only. Individual track monitoring cannot be set via the API. Monitor the parent album instead.

`REQUIREMENTS.md` §4D Scenario B step 6 states: "PUT /api/v1/track — set `monitored: true` for the target track only". The implementation diverges and monitors the entire album, which causes Lidarr to download every track on the album rather than just the requested one.

This is a real product behaviour bug for users adding individual tracks: they'll get the full album in their library.

**Fix (pick one):**
- **Option A:** Update `REQUIREMENTS.md` to acknowledge Lidarr's API limitation and document that single-track adds materialise the whole album. Add a UI note when a user adds a track item.
- **Option B:** Use Lidarr's `MonitorTracks` *command* endpoint (POST `/api/v1/command` with `name: 'MonitorTracks'`, `trackIds: [...]`) which does exist. Verify against your Lidarr version.
- **Option C:** Materialise per-track monitoring at the file level — let the album download, then prune unwanted tracks via `DELETE /api/v1/trackfile/{id}`.

Suggest B; quick test:

```ts
// lidarr.ts
export async function monitorTracks(trackIds: number[]) {
  return runCommand('MonitorTracks', { trackIds });
}
```

…then call it from `scenarioB` after the track is found.

### P2-3 — MusicBrainz query builder does not escape Lucene specials

`src/lib/server/musicbrainz.ts` (around line 144):

```ts
function buildQuery(parts: Record<string, string>): string {
  return Object.entries(parts)
    .map(([k, v]) => `${k}:"${v.trim().replace(/"/g, '\\"')}"`)
    .join(' AND ');
}
```

This escapes only quotes. MusicBrainz uses Lucene query syntax; track titles like `(Reprise)`, `What If?`, `AC/DC`, `+/-`, `**`, or `Slash & Burn` will produce malformed queries — usually 400 from MB or wildcard-matched garbage.

**Fix:**

```ts
const LUCENE_SPECIALS = /([+\-!(){}\[\]^"~*?:\\/]|&&|\|\|)/g;
function escapeLucene(v: string): string {
  return v.trim().replace(LUCENE_SPECIALS, '\\$1');
}
function buildQuery(parts: Record<string, string>): string {
  return Object.entries(parts)
    .filter(([, v]) => v.trim() !== '')
    .map(([k, v]) => `${k}:"${escapeLucene(v).replace(/"/g, '\\"')}"`)
    .join(' AND ');
}
```

Add a test for `AC/DC`, `What If?`, and `Foo (Live)`.

### P2-4 — Webhook concurrency: `sync_status` updated outside a transaction

`src/routes/api/webhook/lidarr/+server.ts` lines 161–191: each successful `mirrorTrackFile` triggers an unscoped `UPDATE list_items SET sync_status='synced' ...`. Two concurrent webhooks for the same artist (Lidarr can fire multiple Download events for an album in quick succession) race on this update.

Worse, if both webhooks see a single `mirror_pending` row but only one of them actually copies a file, the other's UPDATE may flip status to `synced` while the file copy is still in flight in the first call. Result: the dashboard says "synced", file isn't on disk yet, orphan scan runs and the user sees "stale".

**Fix:** wrap each candidate's status flip in a transaction with the file copy, or mark `mirror_active` only after the *individual* file copy resolves *and* the `mirror_files` row's status is `active`:

```ts
// after mirrorTrackFile resolves successfully
db.transaction(() => {
  const haveActive = db.prepare(
    `SELECT 1 FROM mirror_files
      WHERE list_item_id = ? AND status = 'active' LIMIT 1`
  ).get(candidate.list_item_id);
  if (haveActive) {
    db.prepare(
      `UPDATE list_items SET sync_status='synced', sync_error=NULL
        WHERE id = ? AND sync_status='mirror_pending'`
    ).run(candidate.list_item_id);
  }
})();
```

### P2-5 — Sibling-fallback can match the wrong artist

`src/lib/server/orchestrator.ts` (around line 477) — sibling-album lookup joins on `lidarr_artist_id`:

```ts
JOIN artist_ownership ao ON ao.lidarr_artist_id = li.lidarr_artist_id
```

Lidarr can re-use the same internal artist ID after a manual artist-record deletion + re-add. If a user deletes an artist in Lidarr and adds a different MusicBrainz artist, the same `lidarr_artist_id` may now point to the new MBID. Joining on it will treat the old and new artist as the same.

**Fix:** join on `artist_mbid` instead, which is immutable.

```ts
JOIN artist_ownership ao ON ao.artist_mbid = li.artist_mbid
```

(Requires `list_items.artist_mbid` to be populated, which is already the case in `scenarioB`/`scenarioC`. Add an index: `CREATE INDEX idx_list_items_artist_mbid ON list_items(artist_mbid);`)

### P2-6 — Plex retry timers leak on shutdown

`src/lib/server/plex-sync.ts` exports `cancelAllRetries()` but `src/lib/server/shutdown.ts` does not call it. SIGTERM in Docker leaves up to N pending `setTimeout` callbacks; on Node 20 these keep the event loop alive past the intended shutdown timeout.

**Fix:**

```ts
// src/lib/server/shutdown.ts
import { cancelAllRetries } from './plex-sync';
import { flushPendingCopies } from './mirror';
import { closeDb } from './db';

export function registerShutdownHandlers() {
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, async () => {
      cancelAllRetries();              // ← add
      await flushPendingCopies(5000);
      closeDb();
      process.exit(0);
    });
  }
}
```

### P2-7 — Orphan-scan scheduler is DST-affected

`src/lib/server/scheduler.ts` `msUntilNextRun` uses `next.setHours(hours, minutes, 0, 0)` on the local Date. In Australian DST regions (NSW/VIC/TAS, AEDT↔AEST in Apr/Oct), the scan can run twice on the autumn switch and skip on the spring switch, depending on the configured time.

**Fix:** anchor in UTC and let the user pick a UTC time, or use a small cron library (`node-cron`). At minimum:

```ts
function msUntilNextRun(timeOfDay: string /* "HH:MM", local */) {
  const [h, m] = timeOfDay.split(':').map(Number);
  const now = new Date();
  let next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);

  // DST guard: if next falls inside a DST gap, skip forward by 1 hr.
  // If it falls inside a fall-back ambiguity, the second occurrence is
  // implicitly preferred by setHours, which is fine.
  const ms = next.getTime() - now.getTime();
  return ms > 0 ? ms : 24 * 60 * 60 * 1000;
}
```

`REQUIREMENTS.md` §4F mentions "Cron-style or time-of-day setting" — go cron (e.g. `node-cron`) and the DST issue disappears.

### P2-8 — `addToList` action does not verify list ownership

`src/routes/+page.server.ts` `addToList`: doesn't check that the target list exists or that `locals.user` has access. Single-user app today, but as soon as the schema gets a `lists.user_id` column, this becomes a privilege-escalation bug.

**Fix:** add `lists.user_id` to schema + check it on every list-touching route:

```ts
const list = db.prepare('SELECT id FROM lists WHERE id = ? AND user_id = ?')
  .get(listId, locals.user.id);
if (!list) error(404, 'List not found');
```

(Apply across all `routes/lists/...` and `routes/api/lists/...` handlers.)

### P2-9 — List-delete swallows Lidarr errors and continues

`src/routes/lists/+page.server.ts` delete action (lines 209–220): the Lidarr ownership-transfer call is wrapped in `try/catch`, errors are logged, and the DB transaction proceeds. End state: TuneFetch DB shows the list deleted; Lidarr still owns the artist under the old root. Mirror copies become orphans on next scan.

**Fix:** abort on Lidarr failure:

```ts
try {
  await transferOwnershipInLidarr(...);
} catch (err) {
  console.error('[lists/delete] Lidarr transfer failed', err);
  return fail(502, { error: 'Lidarr ownership transfer failed; aborted delete.' });
}
// only now run the DB transaction
```

### P2-10 — Search route silently drops items past 900

`src/routes/api/search/+server.ts` line ~31: `.slice(0, 900)`. No log, no UI hint that the result was capped.

**Fix:**

```ts
const results = (await getSearchResults()) ?? [];
const capped = results.length > 900 ? results.slice(0, 900) : results;
return json({ results: capped, capped: results.length > 900, total: results.length });
```

Then surface `data.capped` in the UI ("Showing 900 of 12 471 — refine your search").

### P2-11 — `retry` endpoint always reports success

`src/routes/api/lists/[id]/retry/+server.ts` line 28:

```ts
orchestrate(itemId).catch((err) => {
  console.error(`[retry] unhandled error for item ${itemId}:`, err);
});
return json({ queued: true, itemId });
```

The promise is fire-and-forget, so the caller can never tell if orchestration started successfully. Synchronous failures inside `orchestrate` (which is `async` — rare but possible) are lost too.

**Fix:**

```ts
queueMicrotask(() => {
  orchestrate(itemId).catch((err) => {
    console.error(`[retry] unhandled error for item ${itemId}:`, err);
    // Mark the item failed so the UI shows a state change
    getDb().prepare(
      `UPDATE list_items SET sync_status='failed', sync_error=?
         WHERE id = ?`
    ).run(String(err?.message ?? err), itemId);
  });
});
return json({ queued: true, itemId });
```

### P2-12 — Settings time-of-day validation accepts `99:99`

`src/routes/settings/+page.server.ts` line 95:

```ts
if (!/^\d{2}:\d{2}$/.test(orphanScanTime)) { ... }
```

`99:99` passes, `25:00` passes. The scheduler then computes `setHours(99, 99, ...)` which silently rolls over by 4 days.

**Fix:**

```ts
const m = /^(\d{2}):(\d{2})$/.exec(orphanScanTime);
const hh = m ? Number(m[1]) : -1;
const mm = m ? Number(m[2]) : -1;
if (!m || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
  return fail(400, { error: 'Orphan scan time must be HH:MM (00:00–23:59).', ... });
}
```

### P2-13 — `refreshStale` is a serial, non-restartable loop

`src/routes/mirrors/+page.server.ts` `refreshStale` action (lines 126–159): iterates stale rows one at a time, awaiting each `copyFile` before continuing. No batching, no progress feedback, no cancellation. A user clicking the button on a 5000-stale-row backlog will hold one HTTP connection open for hours.

**Fix:** dispatch the loop into the existing mirror queue (similar to `enqueuePlexSync`) and return immediately with a count; surface progress on the dashboard via the polling endpoint:

```ts
refreshStale: async () => {
  const db = getDb();
  const count = db.prepare(`SELECT COUNT(*) AS n FROM mirror_files WHERE status='stale'`)
    .get().n;
  enqueueRefreshStaleAll();   // fire-and-forget background worker
  return { queued: count };
},
```

---

## P3 — Quality / nits

### P3-1 — `_machineId` cache never invalidates

`src/lib/server/plex.ts` line 559:

```ts
let _machineId: string | null = null;
```

If the user changes `PLEX_URL` in Settings, the cached id still points at the old server. Reset on settings save:

```ts
// plex.ts
export function resetPlexCache() { _machineId = null; }
```

Call from `setSetting(SETTING_KEYS.PLEX_URL, ...)` in `settings.ts`.

### P3-2 — Plex XML parsed via regex

`src/lib/server/plex.ts` line ~322 parses Plex API XML responses with a regex. Plex APIs all support `Accept: application/json` — switch:

```ts
headers.set('Accept', 'application/json');
```

…and parse with `JSON.parse(await res.text())`. Drop the regex.

### P3-3 — Unused `env` import

`src/lib/server/auth.ts` imports `env` but never references it. Either use it (P1-5) or remove the import.

### P3-4 — Title fallback ignores accents and punctuation

`src/lib/server/orchestrator.ts` lines 376–381: title-only fallback compares with `toLowerCase()` only.

```ts
function normalize(s: string) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip accents
    .replace(/[^a-z0-9]/g, '');                         // strip punctuation/whitespace
}
const found = tracks.find((t) => normalize(t.title) === normalize(item.title));
```

### P3-5 — `db.ts` accumulates ad-hoc ALTER TABLE migrations

Each schema change requires editing `db.ts`. Fine for now; recommend a tiny migrations directory keyed by `PRAGMA user_version` once you have more than ~5 migrations.

```ts
const userVersion = db.prepare('PRAGMA user_version').get().user_version as number;
if (userVersion < 1) {
  db.exec('...migration 1...');
  db.exec('PRAGMA user_version = 1');
}
if (userVersion < 2) { ... }
```

### P3-6 — `npm install` not `npm ci` in Dockerfile

`Dockerfile` line 20 explains the workaround for cross-platform optional deps. Better fix: commit a Linux-resolved `package-lock.json` (run `npm install` once on Linux/WSL and commit), or switch to `pnpm` whose lockfile is platform-agnostic.

### P3-7 — `/api/search` hammers Lidarr per request

`src/routes/api/search/+server.ts` calls `listArtists()` and `getAlbums()` on every search keystroke. Cache for ~30s in-process:

```ts
let _artistCache: { at: number; rows: any[] } | null = null;
async function listArtistsCached() {
  if (_artistCache && Date.now() - _artistCache.at < 30_000) return _artistCache.rows;
  const rows = await listArtists();
  _artistCache = { at: Date.now(), rows };
  return rows;
}
```

### P3-8 — Vitest deprecation: `optimizeDeps.esbuildOptions`

Vitest 4 + Vite 7 emits the warning shown in P0-3. Pin Vitest 2.x or upgrade `vite-plugin-svelte`.

### P3-9 — Use `Accept: application/json` on Plex calls

Same as P3-2 (separate fix file).

### P3-10 — `plex_playlists` duplicates user identity

`plex_playlists.plex_user_token` and `plex_playlists.plex_user_name` duplicate `plex_user_mappings`. Replace with a FK:

```sql
CREATE TABLE plex_playlists (
  id                 INTEGER PRIMARY KEY,
  list_id            INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  user_mapping_id    INTEGER NOT NULL REFERENCES plex_user_mappings(id) ON DELETE CASCADE,
  plex_playlist_id   TEXT,
  playlist_title     TEXT NOT NULL,
  last_synced_at     DATETIME,
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### P3-11 — `vite.config.ts.timestamp-*.mjs`

`.gitignore` already excludes the pattern. `git ls-files | grep timestamp` to confirm none are tracked; if any are, delete + commit.

### P3-12 — `addToList` rate limit

The home page action calls `orchestrate` fire-and-forget with no rate limiter. A sticky button-mash adds N+1 jobs into the orchestrator. Add a debounce client-side **or** an in-memory limiter keyed by item MBID server-side.

### P3-13 — Replace deprecated CSRF flag

Already covered in P1-2. Listed here so the dev fixes both the security defaults *and* the deprecation in the same change.

---

## Files reviewed without findings

The following were read and have no observed issues at this depth:

- `.gitignore`
- `postcss.config.js`
- `tailwind.config.ts`
- `src/app.html`
- `src/routes/+layout.svelte`
- `src/routes/api/lists/[id]/status/+server.ts` (clean)
- `src/lib/server/auth.ts` (modulo P3-3)
- `src/lib/server/env.ts` (modulo P1-5)

---

## Suggested fix order

1. **P1-2** turn CSRF back on and migrate to `csrf.trustedOrigins` (one-line fix; also clears P0-3).
2. **P1-3** add webhook secret + tighten the public-prefix matcher.
3. **P1-6** strip debug logging from `hooks.server.ts` and `login/+page.server.ts`.
4. **P1-7** + **P1-8** add path validation to the delete endpoint and validate the login redirect.
5. **P2-1** add `ON DELETE` rule to `artist_ownership`.
6. **P2-3** Lucene-escape MusicBrainz queries.
7. **P2-2** decide between updating `REQUIREMENTS.md` or using `MonitorTracks` for single-track items.
8. **P2-4** through **P2-13** in any order — each is independent.
9. **P1-4** + **P1-5** plaintext-token encryption — pair these.
10. **P0-2** Vitest/Vite version pin so `npm test` runs cleanly.
11. **P3** group as bug-bash issues.

## Verification checklist for the implementing dev

- [ ] `npx tsc --noEmit -p .` — zero errors (currently passes after `svelte-kit sync` regenerates `./$types`)
- [ ] `npm test` — all tests pass (P0-2)
- [ ] `npx svelte-kit sync` — no deprecation warnings (P0-3 / P1-2)
- [ ] `docker build .` succeeds end-to-end
- [ ] Unit test added covering `escapeLucene` for `AC/DC`, `What If?`, `(Reprise)`
- [ ] Manual: delete a list with owned artists — succeeds, `artist_ownership` rows updated (P2-1)
- [ ] Manual: send two Lidarr Download webhooks for the same artist within 100ms — final `sync_status` row count matches expected (P2-4)
- [ ] Manual: change `PLEX_URL` in Settings, run Plex sync — uses the new server (P3-1)
