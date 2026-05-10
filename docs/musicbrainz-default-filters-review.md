# MusicBrainz Default Filters — Implementation Review

**Audience:** Junior developer picking this up cold.
**Goal:** Tame the volume of MusicBrainz results by applying Lidarr's default release-group filters, with an "Advanced" UI override so power users can bypass them.

---

## 1. Background

### 1.1 What Lidarr's defaults mean

Lidarr's metadata profile defaults are:

| Setting           | Value             |
| ----------------- | ----------------- |
| Primary Types     | `Album`, `EP`     |
| Secondary Types   | `Studio` only     |
| Release Statuses  | `Official` only   |

A subtle but critical point: **MusicBrainz has no `Studio` secondary type.** Lidarr's "Studio" really means *"a release-group with **no** secondary type at all."* Any release-group tagged `Live`, `Compilation`, `Soundtrack`, `Remix`, `Demo`, `DJ-mix`, `Mixtape/Street`, `Audiobook`, `Audio drama`, `Broadcast`, `Field recording`, `Interview`, or `Spokenword` is excluded.

Internally we already enumerate those in [src/lib/server/musicbrainz.ts:113](src/lib/server/musicbrainz.ts:113) (`SECONDARY_TYPE_CATALOGUE`) and the canonical-album resolver already uses them ([src/lib/server/canonicalAlbum.ts:5](src/lib/server/canonicalAlbum.ts:5), `BAD_SECONDARY`). Reuse, don't redefine.

### 1.2 What "Official" means

`status` is a property of a *release*, not a *release-group*. MusicBrainz's search index handles this for us — `status:official` on a release-group query matches groups that have **at least one** Official release. The browse API does not expose this filter directly, so for browse we'll have to either include releases (`inc=releases`) and filter client-side, or accept that browse skips status filtering. See §3.2.

### 1.3 What the user is reporting

Three pain points:

1. **Album search** (`type=album` in the main form) returns hundreds of release-groups, mostly noise (live, comps, bootlegs, singles).
2. **Artist drill-down → "Browse albums"** explodes for any popular artist — every reissue, live record, comp, and single shows up.
3. **Track search ranks live/comp tracks above the studio version.** Concrete repro: searching `Riptide` / `Vance Joy` returns a Triple J "Like A Version" recording as the first hit. That recording is live and its release is a radio-station compilation — not Official, not studio.

A previous draft of this doc claimed track search was already correct because it appends `status:official` and ranks by canonical-album tier. That claim is **wrong** — see §6 for why the existing logic doesn't actually exclude this case, and the layered fix.

---

## 2. Files You Will Touch

| File                                                | Why                                                                                |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/lib/server/musicbrainz.ts`                     | Add filter helpers; teach `searchAlbum` and `getArtistReleaseGroups` about filters. |
| `src/routes/api/search/+server.ts`                  | Read filter params from the request, pass them through to `searchAlbum`.            |
| `src/routes/api/browse/artist/[mbid]/+server.ts`    | Read filter params, pass them through to `getArtistReleaseGroups`.                  |
| `src/routes/+page.svelte`                           | Add the "Advanced filters" disclosure UI; wire state into search + browse calls.    |

You should **not** need to touch:
- `canonicalAlbum.ts` (track search ranking already does the right thing).
- `lidarr.ts`, `orchestrator.ts`, `schema.sql`, settings, etc.

---

## 3. Backend Changes

### 3.1 Shared filter type + helpers — `src/lib/server/musicbrainz.ts`

Add a single source of truth for the filter shape and the defaults.

```ts
// Near the top, after SECONDARY_TYPE_CATALOGUE.
export const PRIMARY_TYPES = ['Album', 'EP', 'Single', 'Other', 'Broadcast'] as const;
export type PrimaryType = (typeof PRIMARY_TYPES)[number];

export interface ReleaseGroupFilters {
  primaryTypes: PrimaryType[];   // empty = no primary-type restriction
  excludeSecondaryTypes: boolean; // true = require no secondary-type ("Studio" in Lidarr terms)
  officialOnly: boolean;          // true = require status:official
}

export const DEFAULT_RG_FILTERS: ReleaseGroupFilters = {
  primaryTypes: ['Album', 'EP'],
  excludeSecondaryTypes: true,
  officialOnly: true
};
```

Add a Lucene-fragment builder for the **search** path:

```ts
// MB Lucene field reference:
//   primarytype:Album            – exact match, case-insensitive
//   primarytype:(Album OR EP)    – multi-value
//   -secondarytype:*             – release-group has NO secondary types (Lidarr's "Studio")
//   status:Official              – matches groups with ≥1 Official release
function buildRgFilterFragment(f: ReleaseGroupFilters): string {
  const parts: string[] = [];
  if (f.primaryTypes.length > 0) {
    parts.push(`primarytype:(${f.primaryTypes.join(' OR ')})`);
  }
  if (f.excludeSecondaryTypes) {
    parts.push('-secondarytype:*');
  }
  if (f.officialOnly) {
    parts.push('status:official');
  }
  return parts.join(' AND ');
}
```

Update `searchAlbum` to accept filters:

```ts
export async function searchAlbum(
  query: string,
  filters: ReleaseGroupFilters = DEFAULT_RG_FILTERS
): Promise<MBReleaseGroup[]> {
  const fragment = buildRgFilterFragment(filters);
  const finalQuery = fragment ? `(${query}) AND ${fragment}` : query;
  const data = await request<{ 'release-groups': MBReleaseGroup[] }>(
    '/release-group',
    { query: finalQuery, limit: '100' }
  );
  return data['release-groups'] || [];
}
```

> ⚠️ Note that `MBReleaseGroup` (line 145) does **not** currently expose `secondary-types`. It does on the wire — extend the interface so the API response carries it, even though we filter via Lucene for search:
> ```ts
> export interface MBReleaseGroup {
>   id: string;
>   title: string;
>   'primary-type'?: string;
>   'secondary-types'?: string[];        // ← add this
>   'first-release-date'?: string;
>   'artist-credit'?: Array<{ artist: { id: string; name: string } }>;
>   score?: number;
> }
> ```
> You'll need it for §3.2.

### 3.2 Artist browse — `getArtistReleaseGroups`

Browse is more limited than search. The `/ws/2/release-group?artist=…` endpoint supports a `type` filter (pipe-OR'd primary types) but **does not** support secondary-type or status filters. So we filter post-fetch.

Status filtering matters for browse, but it requires `inc=releases` and a per-group scan — that doubles response size. The pragmatic compromise: **skip status filtering on browse by default** and only enforce it if it turns out to be a problem in practice. Document the gap; don't pretend it's handled.

```ts
export async function getArtistReleaseGroups(
  artistMbid: string,
  filters: ReleaseGroupFilters = DEFAULT_RG_FILTERS
): Promise<MBReleaseGroup[]> {
  const typeParam = filters.primaryTypes.length > 0
    ? filters.primaryTypes.map((t) => t.toLowerCase()).join('|')
    : 'album|ep|single|other|broadcast';

  const data = await request<{ 'release-groups': MBReleaseGroup[]; 'release-group-count': number }>(
    '/release-group',
    { artist: artistMbid, type: typeParam, limit: '100' }
  );
  let groups = data['release-groups'] || [];

  if (filters.excludeSecondaryTypes) {
    groups = groups.filter((g) => (g['secondary-types'] ?? []).length === 0);
  }

  // NOTE: officialOnly is a no-op on browse — see review doc §3.2 for why.

  return groups;
}
```

The existing call site on [src/routes/api/browse/artist/[mbid]/+server.ts:14](src/routes/api/browse/artist/[mbid]/+server.ts:14) currently hard-codes `type: 'album|ep|single'` inside `musicbrainz.ts`. After your change the same filter is passed through, so the type-ordering sort at lines 16–24 still works — verify it.

### 3.3 Wire filters through the API endpoints

**`src/routes/api/search/+server.ts`** — extract filters from query string, pass to `searchAlbum`:

```ts
import {
  searchAlbum,
  DEFAULT_RG_FILTERS,
  PRIMARY_TYPES,
  type PrimaryType,
  type ReleaseGroupFilters
} from '$lib/server/musicbrainz';

function parseRgFilters(url: URL): ReleaseGroupFilters {
  const raw = url.searchParams.get('primaryTypes');
  const primaryTypes = raw === null
    ? DEFAULT_RG_FILTERS.primaryTypes
    : raw === ''
      ? []
      : raw.split(',').filter((t): t is PrimaryType =>
          (PRIMARY_TYPES as readonly string[]).includes(t)
        );

  const flag = (name: string, fallback: boolean) => {
    const v = url.searchParams.get(name);
    if (v === null) return fallback;
    return v === '1' || v === 'true';
  };

  return {
    primaryTypes,
    excludeSecondaryTypes: flag('studioOnly',   DEFAULT_RG_FILTERS.excludeSecondaryTypes),
    officialOnly:          flag('officialOnly', DEFAULT_RG_FILTERS.officialOnly)
  };
}
```

In the `type === 'album'` branch (around line 51), replace `await searchAlbum(query)` with `await searchAlbum(query, parseRgFilters(url))`.

**`src/routes/api/browse/artist/[mbid]/+server.ts`** — same treatment. Get the `URL` from the event (`{ params, url }: RequestEvent`) and pass parsed filters into `getArtistReleaseGroups`.

### 3.4 What about `type === 'artist'` and `type === 'track'`?

- `type=artist` returns artists — primary/secondary/status doesn't apply. Leave it alone.
- `type=track` **needs work** — it has a real bug surfaced by the Riptide/Vance Joy case. See §6 below for the diagnosis and the layered fix. Do not just append the new RG filters wholesale; the comment at [src/lib/server/musicbrainz.ts:226-231](src/lib/server/musicbrainz.ts:226) explaining why bare `secondarytype:` negation breaks the recording search is still correct.

---

## 4. Frontend Changes — `src/routes/+page.svelte`

### 4.1 State

Add to the script block, alongside the existing form state (line 11):

```ts
import { PRIMARY_TYPES, DEFAULT_RG_FILTERS } from '$lib/server/musicbrainz';
// (If sharing the type from server code is awkward in your setup, just hard-code
//  the same array here. It's small and stable.)

let advancedOpen = false;
let primaryAlbum   = DEFAULT_RG_FILTERS.primaryTypes.includes('Album');
let primaryEP      = DEFAULT_RG_FILTERS.primaryTypes.includes('EP');
let primarySingle  = DEFAULT_RG_FILTERS.primaryTypes.includes('Single');
let primaryOther   = false;
let studioOnly     = DEFAULT_RG_FILTERS.excludeSecondaryTypes;
let officialOnly   = DEFAULT_RG_FILTERS.officialOnly;

$: filtersDiffer =
     !primaryAlbum || !primaryEP || primarySingle || primaryOther ||
     !studioOnly || !officialOnly;
```

### 4.2 Build filter query params

Refactor `performSearch` (line 59) so the query-param building is reusable for both search and browse:

```ts
function appendRgFilterParams(p: URLSearchParams) {
  const primary: string[] = [];
  if (primaryAlbum)  primary.push('Album');
  if (primaryEP)     primary.push('EP');
  if (primarySingle) primary.push('Single');
  if (primaryOther)  primary.push('Other');
  // Always send the param so an empty string means "no primary-type restriction"
  p.set('primaryTypes', primary.join(','));
  p.set('studioOnly',   studioOnly   ? '1' : '0');
  p.set('officialOnly', officialOnly ? '1' : '0');
}
```

In `performSearch` (only when `type === 'album'`) call `appendRgFilterParams(params)` before the `fetch`.

In `toggleArtistAlbums` (line 88) do the same for the browse fetch:

```ts
const p = new URLSearchParams();
appendRgFilterParams(p);
const res = await fetch(`/api/browse/artist/${artistMbid}?${p.toString()}`);
```

> ⚠️ The drill-down caches per-artist results in `artistAlbums[artistMbid]` (line 96, `if (artistAlbums[artistMbid]) return;`). When the user changes filters the cached list is stale. Either bust the cache when a filter toggles, or key the cache by `artistMbid + filterFingerprint`. Easiest: clear `artistAlbums = {}` in a reactive statement that watches the filter variables.

### 4.3 The "Advanced filters" disclosure

Place this between the contextual fields (~line 238) and the "Sort + Submit" row (line 241). Show it only when `type === 'album' || type === 'artist'` — those are the only types it affects.

```svelte
{#if isAdmin && (type === 'album' || type === 'artist')}
  <div class="border-t border-slate-800 pt-3">
    <button
      type="button"
      class="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1"
      on:click={() => (advancedOpen = !advancedOpen)}
    >
      <span>{advancedOpen ? '▾' : '▸'}</span>
      Advanced filters
      {#if filtersDiffer && !advancedOpen}
        <span class="badge bg-amber-900/40 text-amber-300 border border-amber-800">customised</span>
      {/if}
    </button>

    {#if advancedOpen}
      <div class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
        <fieldset class="space-y-1">
          <legend class="text-xs text-slate-400 mb-1">Primary type</legend>
          <label class="flex items-center gap-2"><input type="checkbox" bind:checked={primaryAlbum}  class="accent-sky-500" /> Album</label>
          <label class="flex items-center gap-2"><input type="checkbox" bind:checked={primaryEP}     class="accent-sky-500" /> EP</label>
          <label class="flex items-center gap-2"><input type="checkbox" bind:checked={primarySingle} class="accent-sky-500" /> Single</label>
          <label class="flex items-center gap-2"><input type="checkbox" bind:checked={primaryOther}  class="accent-sky-500" /> Other</label>
        </fieldset>
        <fieldset class="space-y-1">
          <legend class="text-xs text-slate-400 mb-1">Secondary type</legend>
          <label class="flex items-center gap-2">
            <input type="checkbox" bind:checked={studioOnly} class="accent-sky-500" />
            Studio only (exclude live, comps, soundtracks, remixes, …)
          </label>
        </fieldset>
        <fieldset class="space-y-1">
          <legend class="text-xs text-slate-400 mb-1">Release status</legend>
          <label class="flex items-center gap-2">
            <input type="checkbox" bind:checked={officialOnly} class="accent-sky-500" />
            Official only
          </label>
          <p class="text-xs text-slate-600">Note: not enforced on artist drill-down (MB browse limitation).</p>
        </fieldset>
      </div>
    {/if}
  </div>
{/if}
```

### 4.4 Non-admin (Wife Mode)

The simplification doc ([docs/ui-simplification-review.md](docs/ui-simplification-review.md)) calls for hiding this kind of complexity from the non-admin user. Don't render the disclosure when `!isAdmin`. The defaults will silently apply, which is exactly what we want for that audience.

---

## 5. Track Search — What's Actually Broken

> Reported case: search `Riptide` / `Vance Joy`, the first hit's album shows as a Triple J "Like A Version" compilation rather than the studio album *Dream Your Life Away*.

### 5.1 Why the existing logic does not catch this

The track-search pipeline is at [src/routes/api/search/+server.ts:74-119](src/routes/api/search/+server.ts:74). It does three things:

1. Lucene query with `status:official` ([musicbrainz.ts:232](src/lib/server/musicbrainz.ts:232)).
2. For each returned recording, calls `resolveCanonicalAlbumCached` to pick a canonical release-group, and `recordingPenalty` to score the recording.
3. Sorts: tier ASC → penalty ASC → MB score DESC → year ASC.

There are **four** ways a Like-A-Version-style result can sneak to the top despite this:

#### Failure mode A — recording-level `status:official` matches the comp

The Lucene `status:official` filter on a *recording* search matches any recording that appears on at least one Official release. A Triple J Like A Version compilation **is** an Official release on MB (it's a real label-released CD). So the live Riptide recording satisfies the filter cleanly. The filter does not say "the studio recording" — it says "any recording with any Official release," which is too permissive.

#### Failure mode B — canonical resolver lands on the comp at Tier 1

Look at `resolveCanonicalAlbum` ([canonicalAlbum.ts:38](src/lib/server/canonicalAlbum.ts:38)):

```ts
const tier1 = clean.filter(
  (g) => g['primary-type'] === 'Album' &&
         (!g['secondary-types'] || g['secondary-types'].length === 0)
);
```

If MB editors have not tagged the Triple J comp's release-group with a `secondary-type` (or only tagged it `Compilation` plus mis-tagged it as a regular Album), the comp lands in Tier 1. The studio Riptide recording's tier 1 release-group ("Dream Your Life Away", 2014) ties on tier and the year tiebreak `(a.canonical?.year ?? '9999').localeCompare(b.canonical?.year ?? '9999')` is **ascending** — so an earlier-dated comp wins. This is almost certainly the active failure mode.

#### Failure mode C — penalty regex misses the cue

`recordingPenalty` ([canonicalAlbum.ts:74-80](src/lib/server/canonicalAlbum.ts:74)) checks the recording's *title* and *disambiguation* against `\b(live|remaster(ed)?|radio edit|instrumental|acoustic|karaoke|demo|mono|alternate)\b`. The Like A Version recording's title is just "Riptide". Disambiguation is often blank or "Like a Version session" — "Like a Version" doesn't contain any regex word. So the penalty is 0. Studio is also 0. No tiebreak help.

The penalty also never inspects the *canonical album title* — which would be a strong cue ("Like a Version, Vol. 9", "Triple J BBC Sessions", "Live at Glastonbury", etc.).

#### Failure mode D — cache poisoning

`canonical_album_cache` ([schema.sql:160](src/lib/server/schema.sql:160)) has no TTL and no schema version. If at any point the resolver logic was different — or MB returned partial data and a recording resolved to the "wrong" release-group — that wrong canonical is **stuck forever**. Any change to resolver logic must invalidate this cache.

### 5.2 The fix — layered

Pick all four. Each layer addresses a separate failure mode.

#### Layer 1 — apply user filters to track search too

When the user has `studioOnly` and `officialOnly` on (the new defaults), enforce them on track results: **drop** any recording whose canonical album is not Tier 1, **or** whose canonical release-group has any non-empty `secondary-types`.

In [src/routes/api/search/+server.ts:87](src/routes/api/search/+server.ts:87) (where `decorated` is built), filter before sorting:

```ts
const filters = parseRgFilters(url); // re-use the helper from §3.3

const decorated = arr
  .map((rec) => ({
    rec,
    canonical: resolveCanonicalAlbumCached(rec),
    penalty: recordingPenalty(rec)
  }))
  .filter(({ canonical }) => {
    if (!filters.excludeSecondaryTypes && filters.primaryTypes.length === 0) return true;
    if (!canonical) return false; // unresolvable → drop under strict mode
    if (filters.primaryTypes.length > 0) {
      // Tier 1 = Album-no-secondary; Tier 2 = EP/Single. Map filter selection to allowed tiers.
      const allowAlbum  = filters.primaryTypes.includes('Album');
      const allowEpSing = filters.primaryTypes.includes('EP') || filters.primaryTypes.includes('Single');
      if (canonical.tier === 1 && !allowAlbum)  return false;
      if (canonical.tier === 2 && !allowEpSing) return false;
      if (canonical.tier >= 3) return false;
    }
    if (filters.excludeSecondaryTypes && canonical.tier !== 1 && canonical.tier !== 2) {
      return false;
    }
    return true;
  });
```

> Caveat: `CanonicalAlbum` ([canonicalAlbum.ts:10-15](src/lib/server/canonicalAlbum.ts:10)) does not currently expose `primary-type` or `secondary-types` — only `tier`. Tier-based filtering is sufficient because tier 1 already encodes "Album with no secondary types" and tier 2 encodes "EP or Single". You do not need to extend the type unless you also intend to expose individual secondary-type opt-ins (out of scope — see §8).

#### Layer 2 — add a release-group title penalty

In `recordingPenalty`, also scan the **canonical album title** for live/sessions cues. Or better, move that into the sort comparator so it has access to `canonical.title`:

```ts
const RG_TITLE_PENALTY_REGEX =
  /\b(live|sessions?|bbc|triple j|like a version|unplugged|acoustic|in concert|at the)\b/i;

function rgTitlePenalty(title: string | undefined): number {
  if (!title) return 0;
  return RG_TITLE_PENALTY_REGEX.test(title) ? 80 : 0;
}
```

Combine into the sort:

```ts
decorated.sort((a, b) => {
  const tA = a.canonical?.tier ?? 5;
  const tB = b.canonical?.tier ?? 5;
  if (tA !== tB) return tA - tB;
  const pA = a.penalty + rgTitlePenalty(a.canonical?.title);
  const pB = b.penalty + rgTitlePenalty(b.canonical?.title);
  if (pA !== pB) return pA - pB;
  // ... rest unchanged
});
```

This rescues Failure mode B even when the resolver mis-tiers a poorly-tagged comp into Tier 1.

#### Layer 3 — fix the year tiebreak direction

[search/+server.ts:101](src/routes/api/search/+server.ts:101):

```ts
return (a.canonical?.year ?? '9999').localeCompare(b.canonical?.year ?? '9999');
```

This sorts **earliest first**. For "which is the canonical studio release" this is wrong in cases where the studio album came after a session/single appearance. Riptide is exactly this: the song appeared on a 2013 EP, then the 2014 album. If the user wants the album form, the album's year is later. Worse: an earlier-dated comp now beats a later studio album.

The right tiebreak depends on intent. Two reasonable options — pick one and document it:

- **(a) Prefer the latest tier-1 album.** Flip the comparator: `b.year.localeCompare(a.year)`. Latest studio album wins ties.
- **(b) Use MB score before year.** Move the score check above the year check (it's already there, just reorder so year is the last-ditch tiebreak). MB's relevance score will usually favour the canonical studio recording for a clean query.

Recommended: **(b)**, then **(a)** as the final tiebreak. That preserves the canonical-album logic while no longer rewarding "earliest" by default.

#### Layer 4 — invalidate the canonical-album cache

Two options:

- **Easy:** add a `DELETE FROM canonical_album_cache;` migration that runs once at next startup, on a flag like `pragma user_version`. Then bump the version after any future change to the resolver.
- **Proper:** add a `resolver_version INTEGER NOT NULL` column to the cache; on read, only trust rows whose `resolver_version` matches the current code constant; treat mismatches as misses.

Either is acceptable; the proper one is small. Without this step, all four layers above will not change behaviour for any recording whose canonical was already cached wrongly.

### 5.3 Diagnosis-first checklist (do this *before* coding)

Before implementing the four layers, **verify the failure mode for the actual Riptide case**:

1. Hit the MB recording search yourself:
   ```
   curl -H "User-Agent: TuneFetch-debug ( your-email )" \
     "https://musicbrainz.org/ws/2/recording/?query=recording:%22Riptide%22%20AND%20artist:%22Vance%20Joy%22%20AND%20status:official&inc=releases+release-groups+artist-credits&fmt=json&limit=10" \
     | jq '.recordings[] | { id, title, score, releases: [.releases[]?["release-group"] | { id, title, "primary-type", "secondary-types" }] }'
   ```
2. Identify the offending recording's id (the Like-A-Version one). Note its release-groups' `primary-type` and `secondary-types`.
3. Look up the same recording in your local cache:
   ```sql
   SELECT * FROM canonical_album_cache WHERE recording_mbid = '<the offending id>';
   ```
4. If the cache row's `tier` is 1 and points at the comp's release-group, you've confirmed Failure mode B + D. Layer 1 + 4 fix it. Layer 2 + 3 are insurance.
5. If the cache row's tier is 3 or 4 but the recording still ranks first, then the studio recording is missing/buried — Layer 1 still helps, but you also want to confirm the studio recording is in the top 100 MB results (raise `limit` if not).

Write down what you found in the PR description. Future-you will thank you.

---

## 6. Edge Cases & Gotchas

1. **All primary-types unchecked.** The current sketch sends `primaryTypes=` (empty). Server treats this as "no restriction". That's fine for search but on browse it falls back to `album|ep|single|other|broadcast`. Make sure that's the behaviour you want — alternatively treat empty as "validate / show error".

2. **`-secondarytype:*` syntax in Lucene.** Some MB query parsers reject a bare negated wildcard. If you see HTTP 400 from MB with this fragment, replace with the explicit form using values from `SECONDARY_TYPE_CATALOGUE`:
   ```
   -secondarytype:(Live OR Compilation OR Soundtrack OR Remix OR …)
   ```
   Generate that string from `Object.keys(SECONDARY_TYPE_CATALOGUE)` so it stays in sync.

3. **Cache invalidation on the artist drill-down.** Mentioned above — easy to forget.

4. **Score-based sort.** MB's relevance score is part of the search response. Filtering server-side via Lucene preserves it. Filtering client-side (the browse path) doesn't affect ordering because browse responses aren't scored anyway — they're sorted by the existing primary-type/date logic in [src/routes/api/browse/artist/[mbid]/+server.ts:16](src/routes/api/browse/artist/[mbid]/+server.ts:16).

5. **`MBReleaseGroup` interface gap.** The browse endpoint returns `secondary-types` in the JSON, but the current TypeScript type omits it. You must add it (§3.1) or the filter `groups.filter(g => (g['secondary-types'] ?? []).length === 0)` will type-check by accident via the `??` fallback but will silently fail to filter at runtime if the property is dropped during deserialisation elsewhere. Add the field, don't lean on `any`.

6. **Existing track search must not regress.** Re-read the comment at [src/lib/server/musicbrainz.ts:226-231](src/lib/server/musicbrainz.ts:226). Don't be tempted to "consolidate" track filters with the new RG filters — they intentionally differ.

---

## 7. Verification Checklist

Manual tests you should run before opening the PR. Use a popular artist that has a mess of releases — Beatles, Radiohead, Bowie.

- [ ] `type=album` search for `OK Computer` returns the studio album first; no live/comp variants in the list.
- [ ] Same search with the **Advanced** panel opened and `Studio only` unticked: live + comp variants reappear.
- [ ] Same search with all primary types unticked: returns whatever MB has (singles, etc.).
- [ ] Artist search → `Browse albums` for Radiohead: only studio Albums + EPs, no `OK Notok` (live), no `OKNOTOK 1997 2017` (compilation), no Christmas singles.
- [ ] Same drill-down with `Studio only` off: live and comps reappear.
- [ ] **Track search regression — the whole point.** Searching `Riptide` / `Vance Joy` returns the studio recording (album: *Dream Your Life Away*, 2014) as the first hit, not the Triple J Like A Version comp. With `Studio only` off, the live/comp variants reappear lower in the list.
- [ ] Track search baseline still works for a clean case: `Karma Police` / `Radiohead` returns the *OK Computer* studio recording first.
- [ ] After deploying, the canonical-album cache has been invalidated (Layer 4) — confirm by spot-checking a previously-wrong row.
- [ ] Non-admin (Wife Mode) view: the Advanced disclosure does not render at all.
- [ ] Toggling a filter and re-expanding the same artist's albums uses the new filter (cache busted, see §4.2).
- [ ] Network tab: `/api/search?type=album&...` URL contains `primaryTypes`, `studioOnly`, `officialOnly` params.
- [ ] Network tab: `/api/browse/artist/<mbid>?...` URL contains the same params.
- [ ] No TypeScript errors (`npm run check`).

---

## 8. Out of Scope (do not do these in this PR)

- Persisting filter preferences in settings or `localStorage`. Defer until the basic UX is in.
- Adding a status filter to browse (would require `inc=releases`; doubles payload). Document the gap, don't fix it.
- Adding a "secondary types I tolerate" multi-select. The single `Studio only` checkbox covers 99% of cases. If users ask later, the catalogue is already in `SECONDARY_TYPE_CATALOGUE`.
- Restructuring `CanonicalAlbum` to expose primary/secondary types directly. Tier-based filtering is enough for now (see §5.2 caveat).

---

## 9. Reference

- MusicBrainz search field reference: <https://musicbrainz.org/doc/MusicBrainz_API/Search>
- Release-group search fields specifically: <https://musicbrainz.org/doc/Release_Group/Type>
- Lidarr metadata profile docs (the source of the defaults we're copying): <https://wiki.servarr.com/lidarr/settings#metadata-profiles>
- Existing secondary-type catalogue: [src/lib/server/musicbrainz.ts:113](src/lib/server/musicbrainz.ts:113)
- Existing canonical-album tier logic (don't duplicate it, but worth reading): [src/lib/server/canonicalAlbum.ts](src/lib/server/canonicalAlbum.ts)
