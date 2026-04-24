# Handover — Plex "Fetch Users" returns empty list despite server finding 4

**Project:** TuneFetch
**Component:** Plex connector — Managed User enumeration
**Date written:** 2026-04-24
**Reported by:** Ben
**Status:** Bug confirmed, root-cause area isolated, diagnostic data still needed before landing the fix

---

## 1. TuneFetch primer (for a dev new to the repo)

| Aspect | Detail |
|---|---|
| Frontend & backend | SvelteKit (single app — pages in `src/routes/*/+page.svelte`, server API routes in `src/routes/*/+server.ts`) |
| Language | TypeScript + Svelte 4 |
| Database | SQLite via `better-sqlite3`, file-based, persisted to `/app/data` in the container (volume `TUNEFETCH_DATA_DIR`) |
| Styling | Tailwind CSS |
| Server entry | `build/index.js` (built by Vite, run under `node:20-alpine` with `tini` + `su-exec` for PUID/PGID) |
| Deployment target | Docker on Unraid (Nvidia Titan X 12GB GPU is not used by this app) |
| Node flag | `NODE_OPTIONS=--dns-result-order=ipv4first` — set in the Dockerfile because Docker bridge networks hand out unusable IPv6 which breaks outbound fetches to plex.tv/musicbrainz. **Relevant to this bug** — see Section 7. |

### Running locally
```bash
npm install
npm run dev          # Vite dev server
npm test             # vitest
npm run check        # svelte-check type-check
```

### Building / running the Docker image
```bash
docker build -t tunefetch:dev .
docker run --rm -p 8282:3000 -v tunefetch-data:/app/data tunefetch:dev
```

### Key files for this bug
| File | Role |
|---|---|
| `src/lib/server/plex.ts` | Plex API client. `getManagedUsers()` is the function under investigation (lines 262–363). |
| `src/routes/api/plex/+server.ts` | HTTP endpoint. `GET /api/plex?action=users` → `getManagedUsers()` → `{ ok, users }` (lines 40–43). |
| `src/routes/settings/plex-mappings/+page.svelte` | The "Plex User Mappings" UI. `fetchPlexUsers()` (lines 27–50) makes the request and renders the error string (line 40). |
| `src/lib/server/settings.ts` | Where `plex_url` and `plex_admin_token` are read from (`SETTING_KEYS.PLEX_URL`, `SETTING_KEYS.PLEX_ADMIN_TOKEN`). |
| `docs/plex_openapi.json` | Plex OpenAPI — reference for local PMS endpoints. |
| `docs/lidarr_openapi.json` | Lidarr OpenAPI — reference, unrelated to this bug. |
| `docs/plex-connector-scope.md` | Original scope doc. **Note the drift flagged in Section 7.** |

---

## 2. Symptom

On `/settings/plex-mappings`, clicking **Fetch Plex Users** shows the red error message:

> No managed users found on this Plex server.

The server logs, however, clearly show 4 users were retrieved from plex.tv:

```
{"ts":"2026-04-24T12:19:12.840Z","tag":"hooks.in","method":"GET","path":"/api/plex","search":"?action=users",…}
[plex] Found 4 home user(s) from plex.tv
{"ts":"2026-04-24T12:19:14.852Z","tag":"hooks.out","method":"GET","path":"/api/plex","status":200,"ms":2012,"setCookie":null}
```

HTTP 200, ~2 s latency, no request-level error.

---

## 3. Reproduction

1. In the running container, ensure Plex URL and admin token are set on `/settings` (the test connection button must be green).
2. Navigate to `/settings/plex-mappings`.
3. Click **Fetch Plex Users**.
4. Observe the error banner "No managed users found on this Plex server." appears while the container logs show `[plex] Found 4 home user(s) from plex.tv`.

The 4 users *do* exist on the Plex Home — they show up in the Plex web UI when switching accounts.

---

## 4. Request/response trace

Frontend (`plex-mappings/+page.svelte` line 35):
```ts
const res = await fetch('/api/plex?action=users');
const result = await res.json();
if (result.ok) {
  plexUsers = result.users;
  if (plexUsers.length === 0) {
    errorMessage = 'No managed users found on this Plex server.';
  }
}
```

Server (`api/plex/+server.ts` lines 40–43):
```ts
case 'users': {
  const users = await getManagedUsers(svelteKitFetch);
  return json({ ok: true, users });
}
```

Given the frontend code, the UI message can only be produced when `result.ok === true` **and** `result.users.length === 0`. So the response is literally `{ "ok": true, "users": [] }` — not an error path.

The question becomes: why does `getManagedUsers()` return `[]` when it logged that it found 4 users?

---

## 5. Root-cause analysis

`getManagedUsers()` in `src/lib/server/plex.ts` runs in **two sequential steps**. The second step is where the data is dropped.

### Step 1 — list Home users (lines 272–314)

```ts
usersResponse = await fn('https://plex.tv/api/home/users', {
  method: 'GET',
  headers: {
    'X-Plex-Token': config.adminToken,
    'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
    'X-Plex-Product': PLEX_PRODUCT
  },
  signal: AbortSignal.timeout(15_000)
});
…
const userElementMatches = [...xmlText.matchAll(/<User\s([^>]*)\/?>|<User\s([^>]*)>[\s\S]*?<\/User>/g)];
const userList: Array<{ id: number; title: string }> = [];
for (const m of userElementMatches) {
  const attrs = m[1] ?? m[2] ?? '';
  const idMatch = attrs.match(/\bid="(\d+)"/);
  const titleMatch = attrs.match(/\btitle="([^"]*)"/);
  if (idMatch && titleMatch) {
    userList.push({ id: parseInt(idMatch[1], 10), title: titleMatch[1] });
  }
}

console.log(`[plex] Found ${userList.length} home user(s) from plex.tv`);   // ← line 310
```

This is the line the log shows. Step 1 is working: 4 users were parsed from the XML.

### Step 2 — per-user token via the Home switch endpoint (lines 316–362)

```ts
const users: PlexManagedUser[] = [];

for (const user of userList) {
  try {
    const switchUrl = `https://plex.tv/api/home/users/${user.id}/switch`;
    const switchResponse = await fn(switchUrl, {
      method: 'POST',
      headers: {
        'X-Plex-Token': config.adminToken,
        'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
        'X-Plex-Product': PLEX_PRODUCT
      },
      signal: AbortSignal.timeout(15_000)
    });

    if (switchResponse.ok) {
      const switchXml = await switchResponse.text();
      const tokenMatch = switchXml.match(/authenticationToken="([^"]+)"/);
      const token = tokenMatch?.[1];

      if (token) {
        users.push({ id: user.id, title: user.title, accessToken: token });
      } else {
        console.warn(
          `[plex] Switch succeeded for "${user.title}" but authenticationToken not found in XML`
        );
      }
    } else {
      const errText = await switchResponse.text();
      console.warn(
        `[plex] Switch failed for "${user.title}" — HTTP ${switchResponse.status}: ${errText.substring(0, 200)}`
      );
    }
  } catch (err) {
    console.warn(`[plex] Exception switching to user "${user.title}":`, err);
  }
}

return users;   // ← line 362: may be empty despite Step 1 succeeding
```

**The flaw:** every failure mode in Step 2 (non-OK HTTP, missing `authenticationToken` attribute, thrown exception) is logged at `warn` level and silently skipped. If it fails for all 4 users, the function returns `[]`, the route returns `{ ok: true, users: [] }`, and the user sees "No managed users found on this Plex server." — which is misleading: users *were* found, we just couldn't get tokens for them.

### Why Step 2 is likely the failure point
The `[plex] Found 4 …` line is logged *before* Step 2. The fact that you see that log line **and** an empty response is the signature of Step 2 failing silently.

The `console.warn` output from lines 348 / 353 / 358 would tell us exactly which failure mode is hitting. **Ben reports those warn lines are not visible in the log tail he collected.** Possible reasons:
1. The warn lines never fired (unlikely — one of the three branches must run on each iteration if Step 2 is executing).
2. The logs were truncated / filtered to only show request hooks + `console.log` (possible — the `hooks.in`/`hooks.out` entries suggest a structured wrapper; `console.warn` from inside business logic may be going to a different stream or being dropped by log configuration).
3. Step 2 is not being reached at all (e.g., an early return or thrown error before the `for` loop). Reading the current code, this is not possible — there's no branch between line 310 and line 320.

**This must be confirmed first** — see Section 6.

---

## 6. What to do first (investigation steps)

**Do not ship a fix before you know which Step-2 branch is firing.** The right fix depends on the answer.

### Step 6.1 — Expose the warnings

Temporarily promote the `console.warn` calls in `src/lib/server/plex.ts` at lines 348, 353, and 358 to `console.error`, and collect the reason for each user into a diagnostic array. Return it to the caller so we can see it from the browser DevTools Network tab without needing container log access:

```ts
// sketch — see Section 7 for the proposed landing patch
const failures: Array<{ id: number; title: string; reason: string }> = [];
// … on each failure branch, push a structured entry
// at return time, attach failures to the return value or a thrown PlexError
```

Run **Fetch Plex Users**, open DevTools → Network → the `/api/plex?action=users` response. You should now see exactly one of:

- `HTTP 401 Unauthorized` / `HTTP 403 Forbidden` — admin token lacks permission to switch Home. See 6.2.
- `HTTP 400` with body mentioning `pin` — the Home admin has a Managed User PIN configured. See 6.3.
- `Switch succeeded but authenticationToken not found in XML` — XML shape has changed or user is not a Home member. See 6.4.
- Exception with cause `ETIMEDOUT` / `ENOTFOUND` / `EAI_AGAIN` — outbound DNS/network. See 6.5.

### Step 6.2 — Token / permission issue
Confirm the admin token is from the Plex Home owner account (not a Plex Pass-less secondary account, and not a per-server share token). Have Ben reissue via `https://app.plex.tv/auth/token` using the Home owner login. The `X-Plex-Token` on `/api/home/users/{id}/switch` must belong to the Home admin.

### Step 6.3 — Managed User PIN
If any Home user has a PIN, the switch endpoint requires `?pin=XXXX` as a query parameter. The current code does not send one. Two options:
- **(a) Supported path:** use the `/api/v2/home/users` endpoint which returns user tokens directly, without needing `/switch`. Requires verifying the v2 response shape against `docs/plex_openapi.json`.
- **(b) Workaround:** prompt the user for each PIN in the UI and pass it through. More UX, same endpoint.

Option (a) is strongly preferred and aligns closer to the original scope doc (see Section 7).

### Step 6.4 — `authenticationToken` not in XML
Plex changed the response shape. Log the full `switchXml` body and inspect. The attribute may now be `authToken` or nested inside a child element. Update the regex or parse the XML properly (`fast-xml-parser` would be a cleaner option than regex — not currently a dependency).

### Step 6.5 — Network / DNS
Confirm by running inside the container:
```bash
docker exec -it <container> /bin/sh
wget -qO- https://plex.tv/api/home/users --header "X-Plex-Token: <admin_token>"
```
If this works, the DNS/network is fine and something inside Node's fetch is failing. Check `NODE_OPTIONS=--dns-result-order=ipv4first` is actually set (it is, in `Dockerfile` line 61) and that the undici dispatcher override in `src/lib/server/env.ts` is loaded.

---

## 7. Recommended fix (to land after investigation narrows the cause)

The fix has two parts: **surface the failure reason** regardless of which underlying cause wins, and **reconsider the endpoint choice** now that we know `/home/users/{id}/switch` has failure modes that are easy to hit.

### 7.1 Surface failure reasons — patch for `src/lib/server/plex.ts`

Make `getManagedUsers()` return the partial success plus a structured list of failures. Update the API response and the frontend to present the reason.

```ts
// src/lib/server/plex.ts — replace the Step 2 loop

export interface PlexManagedUserFailure {
  id: number;
  title: string;
  reason: string;
}

export interface GetManagedUsersResult {
  users: PlexManagedUser[];
  failures: PlexManagedUserFailure[];
}

// … inside getManagedUsers, change return type to Promise<GetManagedUsersResult>
const users: PlexManagedUser[] = [];
const failures: PlexManagedUserFailure[] = [];

for (const user of userList) {
  try {
    const switchUrl = `https://plex.tv/api/home/users/${user.id}/switch`;
    const switchResponse = await fn(switchUrl, {
      method: 'POST',
      headers: {
        'X-Plex-Token': config.adminToken,
        'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
        'X-Plex-Product': PLEX_PRODUCT
      },
      signal: AbortSignal.timeout(15_000)
    });

    if (switchResponse.ok) {
      const switchXml = await switchResponse.text();
      const tokenMatch = switchXml.match(/authenticationToken="([^"]+)"/);
      const token = tokenMatch?.[1];
      if (token) {
        users.push({ id: user.id, title: user.title, accessToken: token });
      } else {
        const reason = `Switch succeeded but authenticationToken not found. XML (first 500 chars): ${switchXml.substring(0, 500)}`;
        console.error(`[plex] ${reason}`);
        failures.push({ id: user.id, title: user.title, reason });
      }
    } else {
      const errText = await switchResponse.text();
      const reason = `HTTP ${switchResponse.status}: ${errText.substring(0, 200)}`;
      console.error(`[plex] Switch failed for "${user.title}" — ${reason}`);
      failures.push({ id: user.id, title: user.title, reason });
    }
  } catch (err) {
    const reason = describeFetchError(err);
    console.error(`[plex] Exception switching to user "${user.title}": ${reason}`);
    failures.push({ id: user.id, title: user.title, reason });
  }
}

return { users, failures };
```

### 7.2 API route — expose failures

`src/routes/api/plex/+server.ts` line 40–43:
```ts
case 'users': {
  const { users, failures } = await getManagedUsers(svelteKitFetch);
  return json({ ok: true, users, failures });
}
```

### 7.3 Frontend — show the reason

`src/routes/settings/plex-mappings/+page.svelte` lines 27–50:
```ts
async function fetchPlexUsers() {
  if (!data.plexConfigured) {
    errorMessage = 'Plex is not configured. Set URL and token in Settings first.';
    return;
  }
  fetchingUsers = true;
  errorMessage = '';
  try {
    const res = await fetch('/api/plex?action=users');
    const result = await res.json();
    if (result.ok) {
      plexUsers = result.users;
      const failures: Array<{ title: string; reason: string }> = result.failures ?? [];
      if (plexUsers.length === 0 && failures.length > 0) {
        errorMessage =
          `Found ${failures.length} Plex user(s) but could not retrieve tokens. ` +
          failures.map(f => `${f.title}: ${f.reason}`).join(' | ');
      } else if (plexUsers.length === 0) {
        errorMessage = 'No managed users found on this Plex server.';
      } else if (failures.length > 0) {
        errorMessage =
          `Loaded ${plexUsers.length} user(s). Could not retrieve tokens for: ` +
          failures.map(f => f.title).join(', ');
      }
    } else {
      errorMessage = result.error ?? 'Failed to fetch Plex users';
    }
  } catch {
    errorMessage = 'Network error fetching Plex users';
  } finally {
    fetchingUsers = false;
  }
}
```

### 7.4 Design drift — consider the v2 endpoint

`docs/plex-connector-scope.md` line 32–38 specified this approach:
```
GET https://plex.tv/api/servers/{serverID}/shared_servers?X-Plex-Token={admin_token}
```
The current implementation uses `/api/home/users` + `/api/home/users/{id}/switch` instead. These target *different* user populations:

| Endpoint | Returns |
|---|---|
| `/api/home/users` | Plex Home members — family-style shared accounts under one Plex Pass. Requires `/switch` for each token, PIN may be required. |
| `/api/servers/{machineId}/shared_servers` | Users the server has been *shared* with — distinct plex.tv accounts. Returns per-server tokens directly, no second call. |
| `/api/v2/home/users` (JSON) | Home members with tokens in the response. Newer endpoint. |

If Ben's 4 users are Home members (likely — the log says "home users"), the cleanest fix once we've confirmed the failure mode is to move to `/api/v2/home/users` which returns tokens in a single call and avoids the `/switch` PIN trap. Verify the response shape against `docs/plex_openapi.json` before committing.

If the 4 users are instead server shares, `shared_servers` is the correct endpoint and the whole Home path should be replaced.

**Recommendation for the next dev:** land 7.1–7.3 first (makes the real failure visible in the UI for every future incident of this kind), then pick between v2/home/users and shared_servers based on what the surfaced error reveals.

---

## 8. Test plan

### 8.1 Unit — `src/lib/server/plex.test.ts` (new file)
Create `vitest` tests for `getManagedUsers()` with a mocked `fetchFn`:

1. **Happy path** — Step 1 returns 2 users, Step 2 returns valid XML with `authenticationToken` for each → returns 2 users, 0 failures.
2. **Step 1 HTTP error** — Step 1 returns 401 → throws `PlexError` with status 401.
3. **Step 2 HTTP error for one user** — one user 200, one user 403 → returns 1 user, 1 failure with reason `"HTTP 403: …"`.
4. **Step 2 missing token** — response OK but no `authenticationToken` attribute → failure with reason mentioning the XML snippet.
5. **Step 2 exception** — mocked `fetchFn` throws `AbortError` → failure with reason containing `"AbortError"`.
6. **All users fail** — all 4 in Step 2 fail → returns `{ users: [], failures: [4 entries] }` (this is the current production bug's shape).

Run: `npm test`.

### 8.2 Integration — manual, in Docker, against the real Plex Home
1. Rebuild the image: `docker build -t tunefetch:plex-fix .`.
2. Run with the same volume and env: `docker run --rm -p 8282:3000 -v <same-data-volume>:/app/data tunefetch:plex-fix`.
3. Hit `/settings/plex-mappings` → **Fetch Plex Users**.
4. If users load — pick one, save a mapping, confirm the token is stored in SQLite (`plex_user_mappings.plex_user_token`).
5. If failures appear — the UI should now show a specific reason per user. This is the diagnostic output Section 6 needs.
6. Container log tail should show `[plex] …` lines at `error` level matching the UI reasons.

### 8.3 Regression checks
- `npm run check` — no new type errors (the new `failures` array adds an interface; make sure `+page.svelte` consumes it correctly).
- Test connection button on `/settings` still works (uses `testConnection`, not affected, but share the same error envelope).
- Existing saved mappings still render correctly (they do — the saved-mapping table read path in the `mappings` case is untouched).

### 8.4 Once the real error is known
Whichever branch of Section 6 wins, add a dedicated case to 8.1 covering the specific XML / HTTP body shape observed in production so we don't regress on it.

---

## 9. Open questions for Ben

1. Are the 4 users **Plex Home** members (family-style under one Plex Pass) or **shared users** (separate plex.tv accounts given access to his server)? The log says "home users" because the code logs that literally, but the endpoint only fetches Home users — so if the 4 users are actually server shares, Step 1 would have returned 0 and we'd never see this symptom. Worth confirming to rule out a misleading log label.
2. Does the Plex Home have a PIN on any managed user? (Plex → Settings → Users & Sharing → Manage Library Access.) If yes, 6.3 is the most likely cause and the v2 endpoint switch is required.
3. The admin token in Settings — was it generated while logged in as the Plex Home owner, or a different account?

---

## 10. Files touched by the recommended fix

| File | Change |
|---|---|
| `src/lib/server/plex.ts` | Change `getManagedUsers()` return type to `{ users, failures }`; promote warns to errors; include structured failure reasons. |
| `src/routes/api/plex/+server.ts` | Include `failures` in the JSON response for `action=users`. |
| `src/routes/settings/plex-mappings/+page.svelte` | Render failure reasons in the error message when `users.length === 0` or when partial. |
| `src/lib/server/plex.test.ts` | New — unit coverage per 8.1. |

No schema changes. No migrations. Purely code-level.
