# TuneFetch — Plex Connectivity Review

**Date:** 2026-04-25
**Scope:** All Plex-related code paths from settings/mapping → list-page "Sync now" → playlist creation in Plex.
**Symptom under investigation:** Items in a list reach `synced` status (Lidarr download succeeded), but pressing **Sync now** in the Plex Playlists section silently produces no playlist (or no track additions) in Plex.

---

## 1. File map

| File | Role |
|---|---|
| `src/lib/server/plex.ts` | Plex API client. Manages tokens, calls PMS and `plex.tv`. |
| `src/lib/server/plex-sync.ts` | Sync engine. Reads `plex_playlists` row, finds tracks, creates/updates playlist. |
| `src/routes/api/plex/+server.ts` | HTTP API. `save_mapping`, `create_playlist_link`, `sync`, etc. |
| `src/routes/lists/[id]/+page.svelte` | List page UI. "Add playlist" form and "Sync now" button. |
| `src/routes/lists/[id]/+page.server.ts` | Loads `plex_playlists` rows and **all** `plex_user_mappings` rows for the page. |
| `src/routes/settings/plex-mappings/+page.svelte` | Page where the user creates a mapping (root folder → Plex user → token → section). |
| `src/routes/settings/plex-mappings/+page.server.ts` | Loader for the mappings page. |
| `src/lib/server/crypto.ts` | `encrypt()` / `decrypt()` / `isEncrypted()` for tokens. |
| `src/lib/server/db.ts` | Startup migration that encrypts any plaintext tokens it finds. |
| `src/lib/server/schema.sql` | `plex_user_mappings`, `plex_playlists`, `plex_playlist_items`. |
| `src/routes/api/webhook/lidarr/+server.ts` | Webhook calls `triggerSyncForArtist()` after a Lidarr download. |

---

## 2. Token storage and encryption — design intent

`crypto.ts`:

```ts
const ENC_PREFIX = 'enc1:';
export function encrypt(plaintext: string): string { /* AES-256-GCM, returns "enc1:<base64>" */ }
export function decrypt(ciphertext: string): string { /* expects ENC_PREFIX */ }
export function isEncrypted(value: string): boolean { return value.startsWith(ENC_PREFIX); }
```

The intent across the codebase is clear: tokens are stored encrypted at rest in both `plex_user_mappings.plex_user_token` and `plex_playlists.plex_user_token`. The startup migration in `db.ts` enforces this for legacy rows:

`src/lib/server/db.ts` (lines 84–102):

```ts
const mappingRows = db.prepare('SELECT id, plex_user_token FROM plex_user_mappings').all() as ...;
for (const row of mappingRows) {
  if (!isEncrypted(row.plex_user_token)) {
    db.prepare('UPDATE plex_user_mappings SET plex_user_token = ? WHERE id = ?')
      .run(encrypt(row.plex_user_token), row.id);
  }
}
const playlistRows = db.prepare('SELECT id, plex_user_token FROM plex_playlists').all() as ...;
for (const row of playlistRows) {
  if (!isEncrypted(row.plex_user_token)) {
    db.prepare('UPDATE plex_playlists SET plex_user_token = ? WHERE id = ?')
      .run(encrypt(row.plex_user_token), row.id);
  }
}
```

The decrypt path in `plex-sync.ts` (lines 27–30):

```ts
function resolveToken(stored: string): string {
  return isEncrypted(stored) ? decrypt(stored) : stored;
}
```

So the design is: **store encrypted; decrypt once at use site**.

---

## 3. PRIMARY ISSUE — `plex_playlists.plex_user_token` is double-encrypted

This is the single most likely root cause of the symptom you described.

### 3.1 The token-flow that creates a `plex_playlists` row

#### Step A — Mapping is saved (correct)

`src/routes/settings/plex-mappings/+page.svelte` (≈ lines 86–135) sends the token in plaintext:

```js
$: if (selectedPlexUserId && plexUsers.length > 0) {
  const user = plexUsers.find(u => u.id === Number(selectedPlexUserId));
  if (user) {
    userName = user.title;
    userToken = user.accessToken;       // plaintext from /api/plex?action=users
  }
}
...
body: JSON.stringify({
  action: 'save_mapping',
  ...
  plex_user_token: userToken,          // plaintext over the wire (HTTPS in deployment)
  library_section_id: librarySectionId
})
```

`src/routes/api/plex/+server.ts` (lines 95–108) encrypts once on insert:

```ts
case 'save_mapping': {
  const { root_folder_path, plex_user_name, plex_user_token, library_section_id } = body;
  ...
  db.prepare(
    `INSERT INTO plex_user_mappings (root_folder_path, plex_user_name, plex_user_token, library_section_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(root_folder_path) DO UPDATE SET ...`
  ).run(root_folder_path, plex_user_name, encrypt(plex_user_token), library_section_id ?? '');
  return json({ ok: true });
}
```

So far: `plex_user_mappings.plex_user_token` = `enc1:<base64-A>`. Correct.

#### Step B — List page loads mappings (no decryption)

`src/routes/lists/[id]/+page.server.ts` (lines 86–88):

```ts
const allMappings = db
  .prepare('SELECT * FROM plex_user_mappings ORDER BY root_folder_path')
  .all() as PlexUserMappingRow[];
```

`allMappings[i].plex_user_token` is the value stored in the DB — i.e. **already encrypted** (`enc1:…`).

#### Step C — User clicks "Create playlist link" — token goes through the client

`src/routes/lists/[id]/+page.svelte` (lines 91–122):

```js
async function addPlexPlaylist() {
  ...
  const mapping = data.allMappings.find(m => m.id === Number(selectedMappingId));
  if (!mapping) return;

  const res = await fetch('/api/plex', {
    method: 'POST',
    body: JSON.stringify({
      action: 'create_playlist_link',
      list_id: data.list.id,
      plex_user_token: mapping.plex_user_token,    // <-- ALREADY ENCRYPTED
      plex_user_name: mapping.plex_user_name,
      playlist_title: newPlaylistTitle.trim()
    })
  });
```

This sends the encrypted ciphertext (`enc1:<base64-A>`) back to the server.

#### Step D — API handler **encrypts again** before insert

`src/routes/api/plex/+server.ts` (lines 119–132):

```ts
case 'create_playlist_link': {
  const { list_id, plex_user_token, plex_user_name, playlist_title } = body;
  if (!list_id || !plex_user_token || !plex_user_name || !playlist_title) {
    throw error(400, '...');
  }
  const result = db
    .prepare(
      `INSERT INTO plex_playlists (list_id, plex_user_token, plex_user_name, playlist_title)
       VALUES (?, ?, ?, ?)`
    )
    .run(list_id, encrypt(plex_user_token), plex_user_name, playlist_title);
  //                ^^^^^^^^ encrypts an already-encrypted string
  return json({ ok: true, id: result.lastInsertRowid });
}
```

Result: `plex_playlists.plex_user_token` = `encrypt("enc1:<base64-A>")` = `enc1:<base64-X>`, where the inner plaintext is itself a valid `enc1:` ciphertext.

### 3.2 Why this breaks "Sync now"

`src/lib/server/plex-sync.ts` (lines 27–93):

```ts
function resolveToken(stored: string): string {
  return isEncrypted(stored) ? decrypt(stored) : stored;
}
...
const plexToken = resolveToken(row.plex_user_token);
```

`resolveToken` peels off **one** layer (`enc1:<base64-X>` → `"enc1:<base64-A>"`). The result still starts with `enc1:` and is still ciphertext, **not** a Plex token.

Subsequent calls then send that ciphertext as a Plex auth header:

`searchTrack` (`plex.ts` lines 400–423):

```ts
const raw = await request<...>(
  'GET',
  `/library/sections/${sectionId}/search?type=10&query=${searchQuery}`,
  { userToken, fetchFn }   // userToken = plexToken from sync; sent as X-Plex-User-Token
);
```

`createPlaylist` (`plex.ts` lines 459–486):

```ts
const raw = await request<...>('POST', '/playlists', {
  token: userToken,        // sent as X-Plex-Token
  fetchFn,
  params: { type: 'audio', title, smart: '0', uri }
});
```

Both calls go to Plex with a 100+-character base64 string in `X-Plex-Token` / `X-Plex-User-Token`. Plex returns 401 (or rejects the URI). `request()` throws a `PlexError`, which the sync engine catches:

`plex-sync.ts` lines 178–185:

```ts
} catch (err) {
  console.error(`[plex-sync] Error searching Plex for "${item.artist_name} - ${item.title}":`, err);
  result.errors++;
}
```

After every track errors out, `foundItems` is empty. Combined with `!row.plex_playlist_id`, the engine returns at line 187–192:

```ts
if (foundItems.length === 0 && !row.plex_playlist_id) {
  // No items found and no playlist exists yet -- nothing to create
  db.prepare('UPDATE plex_playlists SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(row.id);
  return result;     // { added:0, alreadySynced:0, notFound:0, errors:N, unmatched:[] }
}
```

The UI then prints the message in `lists/[id]/+page.svelte` line 139:

```js
plexSyncMessage = `Sync complete: ${r.added} added, ${r.alreadySynced} already synced, ${r.notFound} not found`;
```

`errors` is **not** rendered. The user sees "Sync complete: 0 added, 0 already synced, 0 not found" and the playlist never appears in Plex — exactly your symptom.

### 3.3 Confirming the diagnosis on a live system

You can verify before changing any code by running this against your `data.db`:

```sql
-- A correctly-encrypted token: starts with "enc1:" once, base64 follows.
-- A double-encrypted token: also starts with "enc1:", but decrypting once
-- yields a string that ALSO starts with "enc1:".
SELECT id, list_id, substr(plex_user_token, 1, 16) AS prefix, length(plex_user_token) AS len
FROM plex_playlists;
```

A double-encrypted entry will be noticeably **longer** than a single-encrypted entry (typically ~150 chars vs ~80–100 chars for a Plex token), and decrypting once with the same key will produce a string that still starts with `enc1:`.

A quick Node-side check (saved as `scripts/inspect-plex-tokens.ts` or run via `node --experimental-strip-types`):

```ts
import { getDb } from './src/lib/server/db';
import { decrypt, isEncrypted } from './src/lib/server/crypto';

const rows = getDb().prepare('SELECT id, plex_user_token FROM plex_playlists').all() as Array<{id:number, plex_user_token:string}>;
for (const r of rows) {
  const once = isEncrypted(r.plex_user_token) ? decrypt(r.plex_user_token) : r.plex_user_token;
  console.log(r.id, 'doubleEncrypted=', isEncrypted(once));
}
```

If `doubleEncrypted=true` for any row, this is your bug.

### 3.4 Recommended fix

Two changes — pick whichever you prefer:

**Fix A (minimal, server-side only).** In `create_playlist_link`, only encrypt when the input is *not* already encrypted. This is consistent with the migration loop in `db.ts` and tolerates both call paths.

`src/routes/api/plex/+server.ts` line 130, replace:

```ts
.run(list_id, encrypt(plex_user_token), plex_user_name, playlist_title);
```

with:

```ts
import { encrypt, isEncrypted } from '$lib/server/crypto';
...
const tokenForStorage = isEncrypted(plex_user_token) ? plex_user_token : encrypt(plex_user_token);
.run(list_id, tokenForStorage, plex_user_name, playlist_title);
```

**Fix B (preferred, structural).** Stop sending the token through the client at all. The page already has the mapping ID; pass that and resolve the token on the server.

`src/routes/lists/[id]/+page.svelte` ≈ line 102:

```js
body: JSON.stringify({
  action: 'create_playlist_link',
  list_id: data.list.id,
  mapping_id: Number(selectedMappingId),     // <-- send the mapping id, NOT the token
  playlist_title: newPlaylistTitle.trim()
})
```

`src/routes/api/plex/+server.ts` `create_playlist_link` case:

```ts
case 'create_playlist_link': {
  const { list_id, mapping_id, playlist_title } = body;
  if (!list_id || !mapping_id || !playlist_title) {
    throw error(400, 'list_id, mapping_id, and playlist_title are required');
  }
  const mapping = db
    .prepare('SELECT plex_user_token, plex_user_name FROM plex_user_mappings WHERE id = ?')
    .get(mapping_id) as { plex_user_token: string; plex_user_name: string } | undefined;
  if (!mapping) throw error(404, 'mapping not found');
  // mapping.plex_user_token is already encrypted at rest — store it verbatim.
  const result = db
    .prepare(
      `INSERT INTO plex_playlists (list_id, plex_user_token, plex_user_name, playlist_title)
       VALUES (?, ?, ?, ?)`
    )
    .run(list_id, mapping.plex_user_token, mapping.plex_user_name, playlist_title);
  return json({ ok: true, id: result.lastInsertRowid });
}
```

Fix B is preferred because:

- Tokens never leave the server.
- The DB-storage invariant ("`plex_user_token` is always `enc1:…`") is owned by exactly one place.
- It removes a class of "encrypted/plaintext drift" bugs.

### 3.5 Repairing existing rows

Any pre-existing `plex_playlists` rows created through the bugged path are double-encrypted and must be re-keyed (you cannot recover the original token from them without the encryption key — but you do have the key, so this is safe). Add a one-shot migration to `db.ts` after the existing token-migration block:

```ts
// One-shot: re-key any double-encrypted plex_playlists tokens.
// A double-encrypted value decrypts to another enc1: string.
const rows = db.prepare('SELECT id, plex_user_token FROM plex_playlists').all() as Array<{id:number, plex_user_token:string}>;
for (const r of rows) {
  if (!isEncrypted(r.plex_user_token)) continue;
  let inner: string;
  try { inner = decrypt(r.plex_user_token); } catch { continue; }
  if (isEncrypted(inner)) {
    // peel once
    db.prepare('UPDATE plex_playlists SET plex_user_token = ? WHERE id = ?')
      .run(inner, r.id);
    console.log(`[migration] Un-double-encrypted plex_playlists row ${r.id}`);
  }
}
```

Run once, then remove. (Or simply: `DELETE FROM plex_playlists` and re-add the link from the UI after Fix A or B is in place — there are no `plex_playlist_items` to lose if no playlist was ever successfully created.)

---

## 4. SECONDARY ISSUE — UI hides `errors` count

`src/routes/lists/[id]/+page.svelte` line 137–143:

```js
const r = result.result;
plexSyncMessage = `Sync complete: ${r.added} added, ${r.alreadySynced} already synced, ${r.notFound} not found`;
```

`SyncResult` (`plex-sync.ts` line 63–70) also has an `errors` field. When the primary issue above (or any future Plex 4xx/5xx) silently fails, the count is invisible.

**Fix:** include `errors` in the message and surface `unmatched` for diagnostics:

```js
const r = result.result;
const parts = [
  `${r.added} added`,
  `${r.alreadySynced} already synced`,
  `${r.notFound} not found`,
];
if (r.errors > 0) parts.push(`${r.errors} errors`);
plexSyncMessage = `Sync complete: ${parts.join(', ')}`;
```

This won't fix the bug, but it will make the next bug self-evident.

---

## 5. SECONDARY ISSUE — `library_section_id` lookup keyed on `plex_user_name`

`src/lib/server/plex-sync.ts` lines 96–107:

```ts
const userMapping = db
  .prepare('SELECT library_section_id FROM plex_user_mappings WHERE plex_user_name = ?')
  .get(row.plex_user_name) as { library_section_id: string } | undefined;

const librarySectionId = userMapping?.library_section_id ?? '';
if (!librarySectionId) {
  console.warn(...);
}
```

The `plex_user_mappings` table's UNIQUE key is `root_folder_path`, **not** `plex_user_name`. If the same Plex user is mapped to more than one root folder (a reasonable setup if a user has access to multiple libraries / shared folders), `.get()` returns whichever row SQLite happens to return first.

`searchTrack` (`plex.ts` lines 407–409) then throws if `sectionId` is empty:

```ts
if (!sectionId) {
  throw new PlexError('No Plex library section ID provided for this user mapping.');
}
```

So the failure mode here is: search throws → caught by sync → `errors++` → silently invisible (see §4).

**Fix:** use the list's root folder, which uniquely identifies the mapping.

`plex-sync.ts` ≈ line 84, expand the playlist-row query to join `lists`, then look up by `root_folder_path`:

```ts
const row = db.prepare(`
  SELECT pp.*, l.root_folder_path AS list_root_folder_path
  FROM plex_playlists pp
  JOIN lists l ON l.id = pp.list_id
  WHERE pp.id = ?
`).get(plexPlaylistDbId) as (PlexPlaylistRow & { list_root_folder_path: string }) | undefined;
...
const userMapping = db
  .prepare('SELECT library_section_id FROM plex_user_mappings WHERE root_folder_path = ?')
  .get(row.list_root_folder_path) as { library_section_id: string } | undefined;
```

This also makes the path visible in logs when `library_section_id` is missing.

---

## 6. SECONDARY ISSUE — Plex API assumptions

Three places in the code make assumptions about Plex API behaviour. §6.1 is now confirmed against Plex's documentation; §6.2 and §6.3 still warrant verification.

### 6.1 `X-Plex-User-Token` is not a real Plex header — CONFIRMED

`plex.ts` lines 195–197 and 414–423:

```ts
if (options.userToken) {
  headers['X-Plex-User-Token'] = options.userToken;
}
...
// search uses ADMIN token in X-Plex-Token + user token in X-Plex-User-Token
const raw = await request<...>('GET', `/library/sections/${sectionId}/search?...`, { userToken, fetchFn });
```

The inline comment in `plex.ts` claiming this is "the documented Plex Home API pattern" is incorrect. Plex's published documentation lists `X-Plex-Token` as the only authentication header. There is no `X-Plex-User-Token`.

> "Most endpoints require token based authentication, and the token is expected to be sent in the X-Plex-Token header."
> — Plex Media Server developer headers reference

The correct pattern for acting as a managed user:

1. Obtain the user's transient access token from `POST https://plex.tv/api/home/users/{id}/switch` (already done in `getManagedUsers()` at `plex.ts` lines 340–390).
2. Send that token as `X-Plex-Token` on subsequent PMS requests. **Do not** send any other auth-related header.

`searchTrack` is therefore incorrect: it authenticates with the **admin** token and sends the user token as a header Plex ignores, so the search runs as the admin. The `ratingKey`s returned are admin-library keys, which the user's `POST /playlists` call (in `createPlaylist`, which *does* use the user token correctly) may not be authorised to add.

**Fix.** Refactor `searchTrack` to send only the user's token in `X-Plex-Token`, and remove the `userToken` / `X-Plex-User-Token` mechanism from `request()` entirely.

`src/lib/server/plex.ts` lines 400–447 — `searchTrack`:

```ts
export async function searchTrack(
  artistName: string,
  trackTitle: string,
  sectionId: string,
  userToken: string,                 // <-- now required, not optional
  fetchFn?: FetchFn
): Promise<PlexTrack | null> {
  if (!sectionId) {
    throw new PlexError('No Plex library section ID provided for this user mapping.');
  }
  if (!userToken) {
    throw new PlexError('No Plex user token provided for searchTrack.');
  }

  const searchQuery = encodeURIComponent(trackTitle);
  const raw = await request<{ MediaContainer: { Metadata?: PlexTrack[] } }>(
    'GET',
    `/library/sections/${sectionId}/search?type=10&query=${searchQuery}`,
    { token: userToken, fetchFn }    // <-- user token in X-Plex-Token, nothing else
  );
  // ... matching logic unchanged
}
```

`src/lib/server/plex.ts` lines 158–197 — `request()`: drop the `userToken` option and the `X-Plex-User-Token` header.

```ts
async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  options: {
    token?: string;
    body?: unknown;
    fetchFn?: FetchFn;
    baseUrl?: string;
    params?: Record<string, string>;
  } = {}
): Promise<T> {
  // ... unchanged ...
  const headers: Record<string, string> = {
    'X-Plex-Token': token,
    'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
    'X-Plex-Product': PLEX_PRODUCT,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
  // (remove the X-Plex-User-Token block entirely)
  // ... rest unchanged
}
```

This change alone — even without the §3 double-encryption fix — would not have made the symptom go away (the search is still authenticating with a *valid* admin token, so it returns results, just from the wrong perspective). But after §3 is fixed, this change is needed to ensure the `ratingKey`s `searchTrack` returns are usable by the user's own `POST /playlists` call.

Note: every other Plex call in `plex.ts` (`createPlaylist`, `addToPlaylist`, `removeFromPlaylist`, `getPlaylistItems`, `listPlaylists`) already passes the user token as `token` (i.e. in `X-Plex-Token`). Only `searchTrack` is inconsistent.

### 6.2 `POST /playlists` response shape

`plex.ts` lines 459–486:

```ts
const raw = await request<{
  MediaContainer: { Metadata?: PlexPlaylist[] };
}>('POST', '/playlists', {
  token: userToken,
  fetchFn,
  params: { type: 'audio', title, smart: '0', uri }
});

const playlist = raw.MediaContainer?.Metadata?.[0];
if (!playlist?.ratingKey) {
  throw new PlexError('Playlist creation succeeded but no ratingKey returned');
}
return playlist.ratingKey;
```

**Question to verify:** Is the response shape `{ MediaContainer: { Metadata: [{ ratingKey }] } }` for `POST /playlists` when `Accept: application/json`? Some Plex POST endpoints return XML even when JSON is requested, or return `{ MediaContainer: { Playlist: [...] } }` instead of `Metadata`. If the shape is wrong, the function throws *after* the playlist was actually created in Plex — which would manifest as "playlist appears once in Plex but TuneFetch shows the link as never created" — note that this is *not* exactly the symptom you described (you said no playlist appears).

### 6.3 `uri` format for the initial-items parameter

`plex.ts` line 466:

```ts
const uri = `server://${await getMachineId(fetchFn)}/com.plexapp.plugins.library/library/metadata/${ratingKeys.join(',')}`;
```

**Question to verify:** When creating a playlist via `POST /playlists?uri=...`, is comma-joining the rating keys in the path the correct format? The alternative formats sometimes seen are:

- `library/metadata/12345` for a single key, with multiple keys passed as a `uri=` query repeated (or sent in the request body).
- `library/metadata/12345?...` with a separate query.

If the URI format is wrong, Plex creates the playlist but with no items, or returns 400/500. Worth a `curl` smoke test against your actual server before changing code.

### 6.4 Suggested diagnostic — capture one full request/response cycle

Before applying any of the fixes above, prove which call is failing by enabling verbose logging in `request()` (`plex.ts` line 199–229). Add this temporarily:

```ts
console.log(JSON.stringify({
  ts: new Date().toISOString(),
  tag: 'plex.request',
  method, url,
  status: response.status,
  bodyHead: text.slice(0, 500)
}));
```

Then click "Sync now" once and read the container logs. The first non-2xx response identifies the layer at fault.

---

## 7. MINOR — webhook auto-sync vs manual sync share the same broken token

The webhook path also calls `syncListToPlexPlaylist` via `triggerSyncForArtist` → `enqueuePlexSync` (`plex-sync.ts` lines 276–356). Once §3 is fixed, **both** paths will start working; right now they fail identically and silently because they both use `row.plex_user_token` from `plex_playlists`.

No code change required beyond §3 — this is just a note that the fix has wider effect than the "Sync now" button.

---

## 8. Suggested fix order

1. Verify the diagnosis from §3.3 (a single SQL query, no code change).
2. Apply Fix B from §3.4 (`mapping_id` only goes over the wire; tokens never leave the server).
3. Apply the migration in §3.5 to repair pre-existing rows (or `DELETE FROM plex_playlists` and re-add, since the row count is presumably small).
4. Apply §6.1 (refactor `searchTrack` to use the user token in `X-Plex-Token`; drop `X-Plex-User-Token` and the `userToken` option from `request()`).
5. Apply §4 (show `errors` in the UI message). This makes any future Plex failure self-evident instead of silent.
6. Apply §5 (key the section lookup on `root_folder_path` instead of `plex_user_name`).
7. After steps 1–6, click "Sync now" once and check container logs. If the call still fails, the diagnostic in §6.4 will identify the layer (search response shape vs. POST /playlists response shape vs. URI format).

---

## 9. Open questions for you

1. **Plex API verification (§6.1) — RESOLVED.** Confirmed: send the user's token in `X-Plex-Token` and remove `X-Plex-User-Token` entirely.
2. **Plex API verification (§6.2):** confirmed JSON response shape for `POST /playlists`? (Likely fine — comments in code reference the standard `MediaContainer.Metadata` shape — but worth one `curl` smoke test to be sure.)
3. **Plex API verification (§6.3):** confirmed `uri=server://{machineId}/com.plexapp.plugins.library/library/metadata/{rk1,rk2,...}` format for multi-track creation?
4. **Diagnostic data:** can you run the SQL in §3.3 (or paste the lengths and prefixes of `plex_user_token` in `plex_playlists` vs `plex_user_mappings` for the same user)? That alone will confirm or refute the primary hypothesis without changing any code.
5. **Permission to delete rows:** if §3.3 confirms double-encryption, are you OK with `DELETE FROM plex_playlists` to clear bad rows (you would re-add the playlist links after Fix B), or do you want me to write the targeted "peel one layer" migration from §3.5?

---

## 10. Implementation log — what has been tried (2026-04-26)

This section records every change made and every runtime result observed, so future sessions don't repeat work.

### 10.1 Changes implemented and deployed

All five issues from §3–§6 were implemented and the Docker image was built and deployed successfully.

| # | Section | File(s) changed | Status |
|---|---|---|---|
| 1 | §3 Fix B | `+page.svelte`, `+server.ts` | ✅ Implemented |
| 2 | §4 | `+page.svelte` | ✅ Implemented |
| 3 | §5 | `plex-sync.ts` | ✅ Implemented |
| 4 | §6.1 (initial) | `plex.ts` | ✅ Implemented (then revised — see below) |
| 5 | §3.5 migration | `db.ts` | ✅ Implemented |

### 10.2 Runtime result after first deploy

After deploy, container logs showed:

```
[plex-sync] Error searching Plex for "Artist - Title": PlexError: Plex returned HTTP 401
```

`searchTrack` was sending the managed user token (from `plex_user_mappings`) as `X-Plex-Token`. The local PMS returned 401 for every search.

**Key fact established:** the account being synced is a **Plex Managed Family Account** — a PIN-based sub-account with no independent plex.tv credentials. The token stored in `plex_user_mappings` (obtained via `POST plex.tv/api/home/users/{id}/switch`) is a **plex.tv cloud session token**. The local PMS rejects it for library section search requests.

### 10.3 Fix: revert `searchTrack` to admin token

**Hypothesis:** ratingKeys are library-wide and identical regardless of which user performs the search. Use admin token for search; keep user token only for playlist creation.

**Change made (`plex.ts`):** Removed `userToken` parameter from `searchTrack` entirely. The function now uses the admin token via `request()`'s fallback to `readConfig().adminToken`.

**Change made (`plex-sync.ts`):** Removed the `plexToken` argument from the `searchTrack(...)` call.

**Result after deploy:** `searchTrack` no longer 401s. But `createPlaylist` now 401s:

```
[plex-sync] Failed to create playlist: PlexError: Plex returned HTTP 401
    at createPlaylist (plex-B_wpJuKl.js:223:15)
```

**Conclusion:** The plex.tv cloud switch token is rejected by the local PMS for **all** operations — not just search. It cannot be used as `X-Plex-Token` for any local PMS call.

### 10.4 Root cause of the token problem

`getManagedUsers()` calls `POST https://plex.tv/api/home/users/{id}/switch`. The `authenticationToken` this returns is a **plex.tv cloud credential**. The local PMS does not accept it because the local PMS authenticates tokens against its own session store, not plex.tv's.

This is a structural problem: the token source is wrong. We need a token the **local PMS issued**, not one plex.tv issued.

### 10.5 FAILED: local PMS switch endpoint → 404

**Hypothesis:** `POST {localPms}/home/users/{id}/switch` with admin token returns a locally-valid token.

**Result:** HTTP 404 for all four users (Ben, Guest, Kids, Sharna). The endpoint does not exist on this PMS version.

### 10.6 Current diagnostic: GET /home/users on local PMS

**Hypothesis:** `GET {localPms}/home/users` with admin token might return home user records that include locally-valid tokens or identifiers we can use.

**Change made (`plex.ts` — `getManagedUsers()`):** Added a diagnostic call to `GET {config.baseUrl}/home/users` that logs the first 1000 chars of the response. The plex.tv switch fallback is still in place so the Settings UI still populates. Nothing changes in visible behaviour — this is purely to see what the local PMS exposes.

**After deploy:** go to Settings → Plex → fetch users, then paste the `[plex] GET /home/users →` container log line. The response will determine next steps.

### 10.6 Current state of each file

| File | What changed from original |
|---|---|
| `src/lib/server/plex.ts` | `getManagedUsers()` uses local PMS switch (not plex.tv). `searchTrack` uses admin token (no `userToken` param). `X-Plex-User-Token` removed from `request()`. |
| `src/lib/server/plex-sync.ts` | `searchTrack` call has no user token arg. `library_section_id` looked up via `root_folder_path`. |
| `src/routes/api/plex/+server.ts` | `create_playlist_link` takes `mapping_id`, resolves token server-side. |
| `src/routes/lists/[id]/+page.svelte` | Sends `mapping_id` not token. Sync message includes errors count. |
| `src/lib/server/db.ts` | Migration peels double-encrypted `plex_playlists` tokens on startup. |

### 10.7 Things NOT yet confirmed

- Whether `POST {localPms}/home/users/{id}/switch` exists on all PMS versions and returns the expected token format.
- Whether §6.2 (POST /playlists JSON response shape) and §6.3 (uri format for multi-track) are correct. These haven't been hit yet because all deploys so far have 401'd before reaching playlist creation successfully.
