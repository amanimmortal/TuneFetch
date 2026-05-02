# Track Search — Filtering to the Canonical Album

> **Status:** Brainstorm / design doc — pre-implementation
> **Audience:** Implementer (reduced-context model). This doc is meant to be self-contained.
> **Goal:** When a user runs a track search, surface results where each track is mapped to its *original studio album* (or, failing that, an EP/single, or a remastered "best of" compilation) — instead of the current behaviour where the album column is just `releases[0]` and live/karaoke/compilation versions flood the list.

---

## 1. Current behaviour (what we're changing)

`src/lib/server/musicbrainz.ts` — `searchTrack()` calls `/recording` with a Lucene query built from the artist + recording + release fields. In `src/routes/api/search/+server.ts`, each recording's album is taken from `a.releases?.[0]?.title` — i.e. whatever release MusicBrainz happened to list first. There is no filtering and no preference for original albums.

Symptoms the user has reported:
- The same song appears many times: live versions, remasters, karaoke, compilation appearances, regional reissues, etc.
- The "album" column is unpredictable — often a compilation rather than the original LP.

---

## 2. Strategies on the table

Strategies 1–4 are from Gemini Pro's prior pass; 5–11 are additions from this pass. Each has a short verdict at the end.

### Strategy 1 — Lucene exclusion query (pre-filter at the API)

Use the `/recording` endpoint's Lucene support to negate unwanted release types in the query itself:

```
recording:"<track>" AND artist:"<artist>"
  AND primarytype:album
  NOT secondarytype:live
  NOT secondarytype:compilation
  NOT secondarytype:remix
  NOT secondarytype:soundtrack
  NOT secondarytype:demo
  AND status:official
```

- **Pros:** Cheapest. The MB server filters before sending. Tiny bandwidth.
- **Cons:** Strict filters destroy recall — a track that *only* appeared on an EP or single returns 0. Also, a `recording` search filters by *any* release the recording is on; a recording that appears on both a studio album and a compilation will still match, so this doesn't actually deduplicate.
- **Verdict:** **Use as a soft pre-filter** (status + minus live/karaoke/audio-drama/spoken-word) but do not rely on it alone. Always run a fallback if zero results.

### Strategy 2 — Release-group attribute matrix (post-process)

Request `inc=releases+release-groups` on the recording search, then sort/group locally:

1. Drop release-groups whose `secondary-types` include `Live`, `Remix`, `Interview`, `DJ-mix`, `Spokenword`, `Audio drama`.
2. Tier 1: `primary-type: Album` AND no `secondary-types`. Sort by `first-release-date` ascending. Earliest = original.
3. Tier 2: `primary-type: EP` or `Single`. Sort by date asc.
4. Tier 3: `primary-type: Album` with `secondary-type: Compilation`. Sort by date asc — picks the canonical "best of."

- **Pros:** Reliable, single API call, total local control.
- **Cons:** Payload is large for popular tracks (a Beatles search can be megabytes). Slower response.
- **Verdict:** **This is the core of the recommended approach.** The "tiered" logic matches exactly what the user asked for ("original album, or fall back to a remastered best-of").

### Strategy 3 — Entity traversal via Works

A `Work` is the abstract composition; many `Recording`s reference one `Work`. Searching `/work` then walking `recording-rels` finds every recording of the same song, including re-recordings.

- **Pros:** Cleanest model — separates "the song" from "this audio capture." Great for re-recorded catalogues (e.g. Taylor's Versions).
- **Cons:** Work→Recording links are inconsistently maintained in MB. Lots of works have zero or partial links. Adds an extra API hop.
- **Verdict:** **Skip for v1.** Too unreliable. Revisit if we add a "show all versions" feature later.

### Strategy 4 — Title / disambiguation regex scrub

Drop recordings whose `title` or `disambiguation` matches `(?i)\b(live|remaster(ed)?|radio edit|instrumental|acoustic|karaoke|demo|mono|stereo mix|alternate)\b`.

- **Pros:** Catches cases where MB contributors put "Live" in the title but didn't tag the secondary type.
- **Cons:** False positives — the band Live, an album literally called "Acoustic," etc.
- **Verdict:** **Use as a tiebreaker / penalty signal**, not a hard filter. Penalise the score, don't drop the row.

### Strategy 5 — Composite score ranking (NEW)

Instead of binary include/exclude, assign each recording a numeric score and sort. Signals:

| Signal | Weight | Rationale |
|---|---|---|
| Earliest release-group is `primary=Album`, no secondary | +100 | Original studio album |
| Earliest release-group is `primary=EP` or `Single` | +60 | Pre-album single release |
| Has `secondary=Compilation` only | +30 | Best-of fallback |
| Has `secondary=Live` | −80 | Live |
| Has `secondary=Soundtrack` | −20 | Often legitimate but noisy |
| Title regex hit (Strategy 4) | −40 | Scrub signal |
| Recording is referenced by N≥3 release-groups | +20 | Indicates a "real" track, not a one-off |
| `status=Official` | +10 | Exclude promos/bootlegs |
| Has Cover Art Archive entry on earliest release | +5 | Canonical releases tend to have art |
| Recording length < 30s or > 15min | −30 | Likely interlude / mash-up |

- **Pros:** Robust, gracefully degrades when one signal is missing.
- **Cons:** Tuning the weights requires real-world testing.
- **Verdict:** **Layer this on top of Strategy 2.** Use the matrix for the album choice, the score for ordering tied results.

### Strategy 6 — Recording-frequency heuristic (NEW)

The original studio recording is usually the one referenced by the *most* release-groups (it gets reused across compilations, anniversary editions, etc.), while a live recording typically appears only on its own live album. So: cluster the search results by `recording.id`, count how many distinct release-groups each is on, prefer the highest-count recording for "the song."

- **Pros:** Excellent at distinguishing the canonical master recording from one-off live/demo recordings.
- **Cons:** Fails for songs that were *re-recorded* (Taylor's Version: both versions get reused widely).
- **Verdict:** **Strong tiebreaker.** Use to pick *which recording MBID* to surface when several recordings of the same song exist.

### Strategy 7 — Two-pass with cache (NEW)

Many users will search the same artist/track combos repeatedly. Cache the resolution:

```
recording_mbid → { canonical_release_group_mbid, canonical_release_group_title, year }
```

Store in SQLite (we already use it). On a search:
1. Run the `/recording` search.
2. For each unique recording in the result, look in cache.
3. Cache miss → fetch `release-group` data with `inc=releases` (Strategy 2), apply the matrix, write to cache.
4. Cache hit → use cached value.

- **Pros:** Pays the API cost once per song. Subsequent searches are instant.
- **Cons:** Adds a table + cache-invalidation thinking (probably never invalidate; MB metadata rarely changes for original albums).
- **Verdict:** **Recommended.** Big UX win for repeat use.

### Strategy 8 — Format / status pre-filter (NEW)

Add to the Lucene query: `status:official` and exclude `format:DVD`, `format:Blu-ray`, `format:VHS`. Removes concert footage release-groups that pollute results for popular artists.

- **Pros:** Cheap, no recall cost for music-only intent.
- **Cons:** Trivial — just one more filter line.
- **Verdict:** **Include in the pre-filter (Strategy 1).**

### Strategy 9 — UI-level deduplication (NEW)

Whatever ranking we apply server-side, group results in the UI by the **canonical recording** so the user sees one row per song with the original album shown, plus a "more versions" disclosure. Even with imperfect ranking, this stops the visual flood.

- **Pros:** Big perceived-quality win regardless of how good the ranking is.
- **Cons:** Requires a small frontend change in `+page.svelte`.
- **Verdict:** **Recommended for v2** of this feature, after the server logic lands.

### Strategy 10 — ISRC / artist-origin country tiebreaker (NEW)

ISRCs encode country + year. If multiple releases tie on date, prefer the release whose `country` matches the artist's origin (Beatles → UK > US). This is a tiebreaker only.

- **Pros:** Surfaces the *actual* original (UK Parlophone Beatles albums, not US Capitol re-shuffles).
- **Cons:** Needs an artist→country lookup. Marginal benefit for most users.
- **Verdict:** **Defer.** Nice to have, not essential.

### Strategy 11 — Lazy "find original" button (NEW)

Don't resolve eagerly at all — show recordings as-is, and add a per-result "Find original album" button that runs the matrix + cache logic on demand for that one recording.

- **Pros:** Zero API cost on the search itself. Fastest possible search response.
- **Cons:** Does not solve the user's stated problem (they want the list to be clean by default).
- **Verdict:** **Reject as primary**, but consider as a "Show all versions" affordance.

---

## 3. Recommended approach

Combine the cheap stuff at the query level, then do the smart sort locally, then cache the result. Concretely:

1. **Pre-filter** (Strategy 1 + 8): Always append to track-search Lucene queries:
   ```
   AND status:official NOT secondarytype:live NOT secondarytype:compilation NOT secondarytype:remix NOT secondarytype:soundtrack NOT secondarytype:demo NOT secondarytype:interview NOT secondarytype:audio_drama NOT secondarytype:spokenword
   ```
   If the result count is 0, retry without the secondary-type negations (recall fallback).

2. **Enrich** (Strategy 2): Switch `searchTrack()` to include `inc=releases+release-groups+artist-credits` on the `/recording` query. This gives us release-group primary/secondary types and dates inline — no extra round trips.

3. **Resolve the canonical album per recording** (Strategy 2 matrix + Strategy 5 scoring + Strategy 6 tiebreaker):
   - For each recording, walk its release-groups and pick the best one using the tiered matrix:
     - **Tier 1:** `primary-type=Album`, no secondary-types → pick earliest by `first-release-date`.
     - **Tier 2:** `primary-type=EP` or `Single` → earliest.
     - **Tier 3:** `primary-type=Album`, secondary-types includes `Compilation` (and *only* Compilation) → earliest.
     - **Tier 4 (last resort):** Any release-group → earliest.
   - Drop release-groups containing `Live`, `Remix`, `Interview`, `DJ-mix`, `Audio drama`, `Spokenword` in `secondary-types` *before* the tiers run.
   - Apply the composite score (Strategy 5) to break ties between recordings that resolved to similarly-tiered albums; prefer the recording with the highest release-group count (Strategy 6) within the same tier.

4. **Cache** (Strategy 7): Persist `recording_mbid → { release_group_mbid, release_group_title, year, tier }` in SQLite. Look up before resolving, write after.

5. **Title-regex penalty** (Strategy 4): Apply only as a score adjustment, never as a filter.

6. **Defer**: Strategies 3, 9, 10, 11.

---

## 4. Implementation plan (for the implementer)

Files to touch:

- `src/lib/server/musicbrainz.ts` — extend `searchTrack` and types.
- `src/routes/api/search/+server.ts` — wire in canonical-album resolution and cache.
- `src/lib/server/db.ts` (or wherever the DB schema lives) — add a cache table.
- `src/lib/server/orchestrator.test.ts` (and possibly a new `musicbrainz.test.ts`) — unit tests for the resolver.

### 4.1 Type additions in `musicbrainz.ts`

Extend `MBRecording`:

```ts
export interface MBReleaseGroupNested {
  id: string;
  title: string;
  'primary-type'?: string | null;
  'secondary-types'?: string[];
  'first-release-date'?: string;
}

export interface MBReleaseNested {
  id: string;
  title: string;
  status?: string;
  date?: string;
  country?: string;
  'release-group'?: MBReleaseGroupNested;
}

export interface MBRecording {
  id: string;
  title: string;
  length?: number;
  disambiguation?: string;            // NEW — used by title scrubber
  'artist-credit'?: Array<{ artist: { id: string; name: string } }>;
  releases?: MBReleaseNested[];        // EXTENDED — releases now carry release-group inline
  score?: number;
}
```

### 4.2 Update `searchTrack`

```ts
export async function searchTrack(query: string): Promise<MBRecording[]> {
  const data = await request<{ recordings: MBRecording[] }>('/recording', {
    query,
    inc: 'releases+release-groups+artist-credits',
    limit: '100'
  });
  return data.recordings || [];
}
```

Verify whether `/recording` search supports `inc` — if it does **not** (some MB search endpoints only honour `inc` on lookups, not searches), fall back to: search → take top N recording MBIDs → batch-lookup each via `/recording/{mbid}?inc=releases+release-groups`. The implementer should test the search-with-inc path first; if MB ignores the `inc`, switch to lookups. Cap to top 25 recordings to bound API cost (the rate limiter will queue them; expect ~25s for a cold cache).

### 4.3 Update the Lucene query builder

In `src/routes/api/search/+server.ts` track branch, after `buildQuery(fields)` produces the base query, append the pre-filter clauses. Build a helper in `musicbrainz.ts`:

```ts
const TRACK_NEGATIVE_SECONDARY_TYPES = [
  'live', 'compilation', 'remix', 'soundtrack',
  'demo', 'interview', 'audio_drama', 'spokenword'
];

export function appendTrackFilters(baseQuery: string): string {
  const negations = TRACK_NEGATIVE_SECONDARY_TYPES
    .map((t) => `NOT secondarytype:${t}`).join(' ');
  return `${baseQuery} AND status:official ${negations}`;
}
```

In the search handler:

```ts
const strict = appendTrackFilters(query);
let arr = await searchTrack(strict);
if (arr.length === 0) {
  // Recall fallback — try without the negations
  arr = await searchTrack(`${query} AND status:official`);
}
if (arr.length === 0) {
  arr = await searchTrack(query); // last resort
}
```

### 4.4 Canonical-album resolver

New file `src/lib/server/canonicalAlbum.ts`:

```ts
import type { MBRecording, MBReleaseGroupNested } from './musicbrainz';

const BAD_SECONDARY = new Set([
  'Live', 'Remix', 'Interview', 'DJ-mix', 'Audio drama', 'Spokenword'
]);

const TITLE_PENALTY_REGEX =
  /\b(live|remaster(ed)?|radio edit|instrumental|acoustic|karaoke|demo|mono|alternate)\b/i;

export interface CanonicalAlbum {
  releaseGroupMbid: string;
  title: string;
  year: string | null;
  tier: 1 | 2 | 3 | 4;
}

export function resolveCanonicalAlbum(rec: MBRecording): CanonicalAlbum | null {
  const groups = (rec.releases ?? [])
    .map((r) => r['release-group'])
    .filter((g): g is MBReleaseGroupNested => !!g);

  // Dedupe by RG id
  const byId = new Map<string, MBReleaseGroupNested>();
  for (const g of groups) byId.set(g.id, g);
  const unique = [...byId.values()];

  // Drop bad-secondary groups upfront
  const clean = unique.filter((g) => {
    const sec = g['secondary-types'] ?? [];
    return !sec.some((s) => BAD_SECONDARY.has(s));
  });

  const earliest = (gs: MBReleaseGroupNested[]) =>
    gs.slice().sort((a, b) =>
      (a['first-release-date'] ?? '9999').localeCompare(b['first-release-date'] ?? '9999')
    )[0];

  const tier1 = clean.filter(
    (g) => g['primary-type'] === 'Album' && (!g['secondary-types'] || g['secondary-types'].length === 0)
  );
  if (tier1.length) return toCanonical(earliest(tier1), 1);

  const tier2 = clean.filter(
    (g) => g['primary-type'] === 'EP' || g['primary-type'] === 'Single'
  );
  if (tier2.length) return toCanonical(earliest(tier2), 2);

  const tier3 = clean.filter(
    (g) =>
      g['primary-type'] === 'Album' &&
      (g['secondary-types'] ?? []).every((s) => s === 'Compilation') &&
      (g['secondary-types'] ?? []).includes('Compilation')
  );
  if (tier3.length) return toCanonical(earliest(tier3), 3);

  if (clean.length) return toCanonical(earliest(clean), 4);
  if (unique.length) return toCanonical(earliest(unique), 4);
  return null;
}

function toCanonical(g: MBReleaseGroupNested, tier: 1 | 2 | 3 | 4): CanonicalAlbum {
  return {
    releaseGroupMbid: g.id,
    title: g.title,
    year: g['first-release-date']?.slice(0, 4) ?? null,
    tier
  };
}

export function recordingPenalty(rec: MBRecording): number {
  let penalty = 0;
  if (TITLE_PENALTY_REGEX.test(rec.title)) penalty += 40;
  if (rec.disambiguation && TITLE_PENALTY_REGEX.test(rec.disambiguation)) penalty += 40;
  if (rec.length && (rec.length < 30_000 || rec.length > 15 * 60_000)) penalty += 30;
  return penalty;
}
```

### 4.5 Sort order in the search handler

After mapping each recording, decorate with `tier` and `penalty`, then sort:

```ts
const decorated = arr.map((rec) => {
  const canonical = resolveCanonicalAlbum(rec);
  const penalty = recordingPenalty(rec);
  return { rec, canonical, penalty };
});

decorated.sort((a, b) => {
  const tA = a.canonical?.tier ?? 5;
  const tB = b.canonical?.tier ?? 5;
  if (tA !== tB) return tA - tB;
  // Within tier: prefer fewer penalty points, then higher MB score, then earlier year
  if (a.penalty !== b.penalty) return a.penalty - b.penalty;
  const sA = a.rec.score ?? 0;
  const sB = b.rec.score ?? 0;
  if (sA !== sB) return sB - sA;
  return (a.canonical?.year ?? '9999').localeCompare(b.canonical?.year ?? '9999');
});

results = decorated.map(({ rec, canonical }) => ({
  mbid: rec.id,
  type: 'track',
  title: rec.title,
  artist: rec['artist-credit']?.[0]?.artist?.name ?? 'Unknown Artist',
  artistMbid: rec['artist-credit']?.[0]?.artist?.id ?? null,
  album: canonical?.title ?? rec.releases?.[0]?.title ?? null,
  albumMbid: canonical?.releaseGroupMbid ?? null,   // NEW — useful for drill-down
  year: canonical?.year ?? null,                    // NEW
  tier: canonical?.tier ?? null,                    // NEW — UI can show a badge
  durationMs: rec.length ?? null,
  score: rec.score ?? 0,
  inLidarr: false,
  listMemberships: []
}));
```

### 4.6 SQLite cache

Add a migration creating:

```sql
CREATE TABLE IF NOT EXISTS canonical_album_cache (
  recording_mbid     TEXT PRIMARY KEY,
  release_group_mbid TEXT NOT NULL,
  release_group_title TEXT NOT NULL,
  year               TEXT,
  tier               INTEGER NOT NULL,
  cached_at          INTEGER NOT NULL  -- unix seconds
);
```

In `canonicalAlbum.ts`, wrap `resolveCanonicalAlbum` so it checks the cache first by `recording_mbid` and writes through after computing. No TTL — invalidate manually if MB metadata changes (rare for original albums).

### 4.7 Tests

Add `src/lib/server/canonicalAlbum.test.ts` with fixtures covering:

- Recording with one Album release-group → tier 1, picks it.
- Recording with Album + Live + Compilation release-groups → tier 1, picks the Album.
- Recording with only Live and Compilation → tier 3, picks the Compilation.
- Recording with EP only → tier 2.
- Recording with Album + Soundtrack secondary → Album excluded? **No** — Soundtrack is borderline; current code does NOT drop it (only the BAD_SECONDARY set). Confirm this matches user intent in review.
- Two same-titled Albums, earliest-date selection.

---

## 5. Risks & open questions

- **Does `/recording` search honour `inc=releases+release-groups`?** MB documents `inc` for *lookups*; behaviour on *searches* varies. **Verify before implementing 4.2** — if it doesn't work, fall back to per-recording lookups (slower; consider capping to top 25 recordings).
- **Rate limit blast.** With per-recording lookups, a cold cache for "Yesterday by The Beatles" could mean 25 sequential requests at 1 req/s = 25s. Acceptable for a request initiated by a human, but mention it in the loading state.
- **Soundtrack tracks** — should "Eye of the Tiger" surface its soundtrack album or its parent studio album? Decide policy. Current draft *keeps* soundtrack release-groups (only the obvious noise types are in `BAD_SECONDARY`).
- **Live / Remix bands & albums** — Strategy 4 regex penalty avoids the false-positive trap of Strategy 4 used as a hard filter, but verify with the band "Live" and an album literally titled "Acoustic" before shipping.
- **Re-recordings** — Taylor's Version etc. The matrix will pick the *original* (1st release date), which is usually correct. Add a `tier` badge in the UI so the user sees that they got, e.g., the 2008 original rather than the 2023 re-recording.

---

## 6. Out of scope for this change

- Frontend dedup / "show all versions" disclosure (Strategy 9). Land server-side first, iterate.
- Work-based traversal (Strategy 3).
- Country/origin tiebreaker (Strategy 10).
- Lazy on-demand resolution button (Strategy 11).
