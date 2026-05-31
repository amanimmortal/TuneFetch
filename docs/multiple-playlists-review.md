# Design Review: Multiple Playlists per Person ("Maybe / Test" Playlists + Move Between Them)

> **Status:** Review / design only — no code changes made.
> **Date:** 2026-05-31.
> **Trigger:** Theo and Finn each want a second "Test" / "Maybe" playlist to audition new
> music before committing it to their main playlist. They (and later Mum, and eventually the
> kids themselves) need a way to **move a song from the Maybe playlist to the main playlist**
> from inside the app, and that move action must live in the **simplified (non-admin)** part
> of the UI.

---

## 1. What's actually being asked for

Three distinct things:

1. **A second playlist per kid** — e.g. `Theo` (keepers) plus `Theo – Maybe` (audition inbox),
   and the same for Finn. New songs land in *Maybe*; the kid listens; keepers get promoted.
2. **A "move" action in the app** — promote a song from Maybe → Main (and ideally demote /
   send back, and reject entirely).
3. **It has to work in simplified mode** — the audience is Mum now and the kids later, on a
   phone, so the move has to be a single obvious tap, not an admin operation.

The good news (section 2): TuneFetch's existing data model already does most of this. The new
work concentrates in one new "move" operation plus some simplified-mode UI.

---

## 2. How playlists work today (the relevant mental model)

Facts confirmed from the current code (`schema.sql`, `plex-sync.ts`, the item-delete endpoint,
the list-detail loader) that drive every decision below.

- **A "List" is a person + a Lidarr root folder.** (`lists` table: `name`, `root_folder_path`,
  `quality_profile_id`, `metadata_profile_id`.) Each List is what gets projected out to a playlist.
- **Two Lists can share one root folder — this is already the design.** `REQUIREMENTS.md` §3
  uses `Theo` and `Finn` both pointing at `/mnt/.../music/kids`, and `plex-sync.ts` explicitly
  disambiguates "multiple `plex_user_mappings` rows [that] share a root_folder_path (e.g. several
  kids on the same kids tree)".
- **A List is projected to a Plex playlist (and a Music Assistant playlist) per user.**
  `plex_playlists` links one `list_id` to one playlist for one Plex user; its own schema comment
  says *"a single user can have multiple playlists from different lists."* So one Plex user owning
  both a `Theo` playlist and a `Theo – Maybe` playlist is a **supported shape today** — but see
  the binding mechanics below, because that link is **not automatic and not set at list creation.**
- **`list_items` belong to exactly one List** (`list_id` FK, `ON DELETE CASCADE`). A song is "in
  the Maybe playlist" purely by virtue of its `list_id`.
- **The sync layer is per-list, with surgical per-track tracking.** `syncListToPlexPlaylist(plexPlaylistDbId)`
  pushes a list's items into its Plex playlist (creating it on first run) and then mirrors the
  same playlist into Music Assistant via `ma-sync.ts`. `plex_playlist_items` stores the Plex
  `ratingKey` **and** `plex_playlist_item_id`, so individual tracks can be added/removed from a
  specific playlist.
- **Files on disk are per-root-folder, not per-list.** Lidarr owns one copy of an artist under one
  root folder; secondary lists get **file copies** (`mirror_files`). Two Lists that share a root
  folder therefore **share the same files on disk** — there is no second copy.

### How a list is tied to a person (important — there is no user field on a list)

This caught a real gap. **There is no Plex user on the `lists` table, and list creation does not
ask for one** (`lists/+page.server.ts` `create` only stores `name`, `root_folder_path`, and the two
profile ids). The person↔list binding lives in a *second*, separately-created table:

- **`plex_user_mappings`** (Settings → Plex mappings): `root_folder_path → Plex user` (name, token,
  numeric user id, library section id). Multiple users may map to the same root folder
  (Theo + Finn → kids).
- **`plex_playlists`** (created on the **list detail page**, not at list creation): binds a specific
  `list_id → a specific Plex user` + a playlist title. **This is the actual list↔person link.**

The binding is created by a **manual step**: on a list's page, the "Link a Plex playlist" panel shows
a dropdown of every `(user, root folder)` mapping; you pick the person, type a title, click **Link**,
which `INSERT`s the `plex_playlists` row. That `INSERT` happens in exactly one place — the `link`
action of `POST /api/plex` — so nothing auto-creates it. At sync time, `runPlexSync` reads
`plex_playlists.plex_user_name` and resolves that user's token + library section via
`plex_user_mappings` on `(root_folder_path, plex_user_name)`. **That per-user resolution — not the
root folder alone — is what keeps Theo's list out of Finn's Plex.**

Two consequences that matter for this feature:

1. **The disambiguation for shared-root lists is manual.** Because Theo and Finn share the kids root,
   the app cannot infer which person a new kids-root list belongs to; you choose it from the dropdown
   when linking. (There's a `suggestedMapping` query, but it uses `.get()` and returns only one of the
   shared users, and isn't used to pre-fill — the dropdown is the real choice.)
2. **The linking panel is admin-only** (`{#if isAdmin}` on the list detail page). So a non-admin
   (Mum, or a kid later) who creates a list in simplified mode currently has **no way to link it to a
   Plex user at all** — the list would exist but never sync to anyone's Plex. This is a direct blocker
   for "my wife and later the kids would want to do the same thing," and it's why your instinct to
   capture the user at list creation is the right call (see §5 and §8).

### The realization that makes this cheap

Because a `Theo – Maybe` playlist would point at the **same root folder** as `Theo`:

- Adding the Maybe playlist needs **no new download, Lidarr, or mirror infrastructure.** The audio
  already lives in the kids library regardless of which playlist it's "in."
- **Moving a song from Maybe → Main is a pure playlist-membership change.** The file never moves,
  nothing re-downloads, no copy is made. We only: (a) change the song's `list_id`, and (b) remove
  it from the Maybe playlist and add it to the Main playlist in Plex/MA.

That is the whole reason this feature is small. Keep Maybe and Main on the same root folder and the
move stays a metadata operation.

---

## 3. Two ways to model it

### Option A — Each playlist is its own List  *(recommended)*

Create `Theo – Maybe` and `Finn – Maybe` as ordinary Lists pointing at the **same root folder** as
the existing `Theo` / `Finn` Lists.

- **Move = reassign `list_item.list_id`** from the Maybe list to the Main list, then swap Plex/MA
  playlist membership using the per-item sync the engine already has.
- **Pros:** Reuses all of the add / sync / playlist-creation code. No change to the core tables.
  Lowest effort, lowest risk. The "one user can own multiple playlists" path already works in
  `plex_playlists`.
- **Cons:**
  - The nav grows (each kid now shows two lists). Needs grouping in simplified mode so it reads as
    "Theo: Main / Maybe" rather than four flat entries.
  - The *pairing* of "this Maybe list promotes into that Main list" isn't modeled — it's a naming
    convention. The move UI needs to know the target. Cheapest fix: a nullable `promote_to_list_id`
    column on `lists` (or a small `settings` entry) so a Maybe list knows its Main counterpart.

### Option B — One List, multiple playlists / a "stage" bucket  *(bigger change)*

Keep `Theo` as a single List but give `list_items` a `stage` / `bucket` column (`'maybe' | 'main'`),
and let one List own two playlists.

- **Move = update the `stage` column** + reshuffle playlist membership.
- **Pros:** "One person = one List" stays true; nav stays small; the Main/Maybe pairing is
  intrinsic, no convention needed.
- **Cons:** Touches the core List→playlist projection, which is 1:1 today (`runPlexSync` resolves
  exactly one `plex_playlists` row → one list → one playlist title). Requires a schema migration and
  changes throughout the sync layer (it would now map a List to two playlists). More surface area,
  more to test.

### Recommendation

**Start with Option A.** It gets the feature working with the least new code and leans on paths
already proven in production. Revisit Option B only if the nav becomes cluttered or the "two lists
per person" model confuses users. The migration A → B later is contained (fold the paired lists into
one with a stage column).

---

## 4. The "move" operation — the core new work

This is the one genuinely new piece of behaviour, and it **must be a distinct operation from
"remove."** The current item-delete endpoint
(`src/routes/api/lists/[id]/items/[itemId]/+server.ts`) deletes the item's `mirror_files` from disk
(`fs.unlink`) before removing the row. A naive "remove from source, add to destination" move would
delete the shared file — fatal when Maybe and Main share a root folder.

A same-root move (Maybe → Main) should do:

1. **Guard:** confirm source and destination Lists share a root folder. (If they don't, it's a
   cross-library copy, not a move — out of scope for v1; see §6.)
2. **Reassign** the `list_item.list_id` from source → destination (Option A), *or* flip the `stage`
   column (Option B).
3. **Plex:** remove the track from the source playlist and add it to the destination playlist,
   re-pointing the `plex_playlist_items` row. The engine already creates the destination playlist on
   first sync and tracks per-track `ratingKey` / `plex_playlist_item_id`, so the move re-uses
   `syncListToPlexPlaylist` for the add side and a targeted removal for the source side — **never**
   the file-deleting delete endpoint.
4. **Music Assistant:** do the same through `ma-sync.ts`. **Both backends must be handled** — the MA
   push is wired into the same sync path, and the repo already has MA-specific bug-handover docs, so
   MA parity is a known footgun.
5. **Leave the file on disk untouched.**

Where it lands (no code here — just the surfaces):

- A new endpoint, e.g. `POST /api/lists/[id]/items/[itemId]/move` taking a target list id, sitting
  beside the existing `DELETE` handler.
- A server-side `moveListItem(...)` in the sync layer that wraps the steps above in one DB
  transaction so a half-applied move can't strand a song between playlists.

---

## 5. Simplified-mode UI (a hard requirement, not a nicety)

The audience is Mum now, the kids later, on a phone. Reuse the patterns already documented in
[ui-simplification-review.md](./ui-simplification-review.md) (cookie-based admin toggle; nav filtered
to `/` and `/lists`; large `h-11` touch targets; jargon hidden).

- **New songs should default into *Maybe*.** Maybe is the audition inbox. On the search page, the
  planned quick-add buttons (`[ + Add to Theo ]`) should add to *Theo – Maybe* by default, so nothing
  reaches the "real" playlist without a deliberate promote.
- **Add a per-song "Move to <Main>" action on the list detail page**
  (`src/routes/lists/[id]/+page.svelte`). Note this runs *against* the grain of the simplification
  doc, which hides most per-item buttons (Retry, raw errors) in simplified mode — the Move button is
  the one per-item action that must be **visible** in simplified mode. Make it a big, clearly-labelled,
  mobile-sized button (e.g. "⭐ Keep this" / "Move to Theo").
- **Optional reverse / reject actions:** "Send back to Maybe" (Main → Maybe) and "Remove" (drop from
  Maybe). Define what "remove from Maybe" means for the file — see §6.
- **Nav grouping:** with Option A the simplified Playlists view should group a person's two lists
  ("Theo — Main / Maybe") instead of showing a flat list of four, or the non-technical user won't know
  which is which.
- **Bind the Plex user at list creation (new requirement surfaced by review).** Today the list↔user
  link is a separate, admin-only step (see §2 "How a list is tied to a person"). For simplified-mode
  self-service to work — and to avoid 6 manual link steps for Main+Maybe across three people — list
  creation should capture the Plex user (defaulted/filtered from `plex_user_mappings` for the chosen
  root folder) and **auto-create the `plex_playlists` row**. If that's out of scope for v1, the
  fallback is: **admin pre-creates every list and its playlist link**, and simplified mode only ever
  adds/moves songs (never creates lists).

---

## 6. Risks, edge cases, and things to verify

- **Shared-file reference counting — the #1 gotcha (and possibly a *pre-existing* bug).** The delete
  endpoint unconditionally `fs.unlink`s an item's `mirror_files` and relies on `ON DELETE CASCADE`;
  it does **not** appear to check whether another list on the same root folder still references that
  file. Today Theo and Finn already share the kids root, so **removing a song from Theo could delete
  a file Finn still has in his playlist.** This must be confirmed and, if real, fixed independently of
  this feature. For the move feature specifically: the move must be metadata + playlist-membership
  only and must never touch the file.
- **Cross-root moves are a different feature.** If a Maybe list ever points at a *different* root
  folder than its Main, a move becomes a copy-into-secondary-library (the full `mirror.ts` workflow),
  not a metadata move. Keep v1 moves constrained to same-root and the feature stays simple.
- **Duplicates / already-promoted.** Decide whether the "already in Theo" membership badge and the
  add flow should block or dedupe when a song exists in both a person's lists. The search page already
  computes list-membership badges; make sure they account for both of a person's lists.
- **Every new Maybe list needs its own playlist link, and that step is manual + admin-only today.**
  The Plex *playlist itself* is auto-created in Plex on the first `syncListToPlexPlaylist` run — but
  only once a `plex_playlists` row exists pointing the list at a user, and that row is created **only**
  by the manual "Link a Plex playlist" panel (admin-gated). So a brand-new `Theo – Maybe` list will
  silently sync to nobody until someone links it. For Main+Maybe across Mum + 2 kids that's six lists,
  six manual links. This is the strongest argument for binding the user at list creation (§5, §8).
- **Lidarr monitoring on reject.** If a kid auditions a track in Maybe and rejects it, the file is
  already downloaded. Simplest policy: "removing from Maybe just drops it from the playlist and leaves
  the file" (no Lidarr change). Deleting from disk / unmonitoring is heavier and probably shouldn't be
  exposed in simplified mode.
- **Transaction safety.** Wrap the move (reassign + remove-from + add-to) so a failure can't leave a
  song in neither playlist or both.

---

## 7. Rough effort / phasing

1. **Phase 0 — prove the shape (no code).** As admin, manually create `Theo – Maybe` / `Finn – Maybe`
   Lists on the kids root folder via the existing Lists UI, then **use the admin-only "Link a Plex
   playlist" panel to bind each to the right Plex user** (this manual link is required — see §2/§6),
   add a song, sync, and confirm each playlist lands in the correct person's Plex and MA. Validates
   Option A end-to-end before any code.
2. **Phase 1 — move backend.** `moveListItem(...)` + `POST .../move` endpoint, same-root guard, both
   Plex and MA, one transaction. Add `promote_to_list_id` (or equivalent) so a Maybe list knows its
   Main.
3. **Phase 2 — simplified UI + user-at-creation.** Default quick-add to Maybe; add the visible
   "Move to <Main>" button on the list detail page; group a person's lists in the simplified nav; and
   bind the Plex user at list creation (auto-creating the `plex_playlists` row) so non-admins can
   create their own lists — or, if deferring, document that list creation stays admin-only.
4. **Phase 3 — polish.** Reverse move / reject semantics, duplicate handling, MA parity tests, and the
   shared-file reference-counting fix from §6.

Phases 1–2 are the feature; they're modest because the data model and per-item sync already exist.
Most of the real care is in §6 (not deleting shared files) and MA/Plex parity.

---

## 8. Open questions for the maintainer

1. **Option A (two Lists per person) or Option B (one List + a `stage` bucket)?** Recommendation is A
   first.
2. **Same root folder for Maybe and Main?** Strongly recommended yes — it's what makes the move a
   metadata-only operation. Confirm there's no reason to split them.
3. **What does "reject from Maybe" do to the file?** Keep on disk (recommended for simplified mode) vs.
   delete / unmonitor (admin-only).
4. **Per-person grouping in the simplified nav** — acceptable, or do you want Option B specifically to
   keep the nav to one entry per person?
5. **Scope of users** — just the two kids' Maybe lists for now, or set the pattern up so Mum's and
   (later) each kid's own logins get the same Maybe→Main flow? The model supports all of them; it's a
   question of how many lists/playlists to create up front.
6. **Bind the Plex user at list creation, or keep list creation admin-only?** Today there's no user
   field on a list and the playlist link is a separate admin-only step (§2). Adding a Plex-user picker
   to list creation (auto-creating the `plex_playlists` row) is what makes simplified-mode
   self-service possible and removes six manual link steps. If we'd rather not touch list creation now,
   the explicit fallback is: admin pre-creates all lists + links, and simplified mode never creates
   lists. Which way?

---

*No code was changed in producing this review. It is the planning basis for the feature; update it as
decisions are made, mirroring the style of the other docs in this folder.*
