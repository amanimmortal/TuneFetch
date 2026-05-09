# UI Code Review: Simplification for Non-Tech Users (Wife Mode)

**Target User**: Wife (Vet Nurse, not technologically adept).
**Primary Device**: Mobile Phone.
**Key Focus**: Adding music to children's playlists as simply as possible.

---

## 1. High-Level Strategy

The current UI exposes many technical concepts related to the underlying stack (Lidarr, Plex, Sync Statuses, MBIDs). To make the app usable for the target user, we need to:
1. **Hide administrative and technical pages.**
2. **Flatten the search and add flow** to minimize clicks.
3. **Translate technical jargon** into friendly, descriptive terms.
4. **Optimize for mobile touch** interaction.

---

## 2. Navigation Changes (`src/routes/+layout.svelte`)

The current navigation lists: `Search`, `Lists`, `Mirror Health`, `Settings`.

### Recommended Changes:
- **Hide "Mirror Health" and "Settings"**: These are for the administrator. They should be removed from the main navigation for the wife. They can be placed in a sub-menu, accessible only via direct URL, or hidden behind an "Admin Mode" toggle.
- **Rename "Lists" to "Playlists"**: The term "Lists" is a bit abstract. "Playlists" or "Children's Playlists" is more intuitive.

---

## 3. Search & Add Flow (`src/routes/+page.svelte`)

This is the most critical page. Currently, it requires selecting a type, filling a field, clicking search, scrolling to a result, selecting a list from a dropdown, and clicking add.

### Recommended Changes:
- **Simplify Search Input**:
    - The current UI requires picking "Artist", "Album", or "Track". This is confusing.
    - **Proposal**: Default to a single search input labeled "Search for a song or artist". If the backend requires a specific type, default to "Track" (as adding specific songs to playlists is the main use case) or perform a combined search if the API supports it.
    - If explicit types are needed, use visual pills or tabs instead of radio buttons, and keep it to "Songs" and "Artists".
- **Hide "Sort by"**:
    - Hide the sort dropdown. Default to "Relevance". The target user rarely needs to sort search results A-Z.
- **Flatten the "Add to List" Action**:
    - *Current*: A dropdown to select the list + an "Add" button. (2-3 clicks).
    - *Proposal*: If there are only a few children's playlists (e.g., "Theo", "Mia"), replace the dropdown and button with **direct quick-add buttons** for each list.
    - **Example**: Instead of a dropdown, show: `[ + Add to Theo ]` `[ + Add to Mia ]`. This reduces the action to a single tap.
- **Hide Technical Badges**:
    - Hide the "In Lidarr" badge. The user doesn't need to know about Lidarr.
    - Simplify the "In: ListName" badges. Maybe just show a checkmark or a simple text like "Already in Theo's list".
- **Drill-Down Complexity**:
    - The feature to click "Browse albums" on an artist and then "Tracks" on an album is powerful but creates a very deep, scrolling UI on a phone.
    - Ensure these buttons are large and clearly labeled, or consider a simpler "Top Tracks" view if the API supports it to avoid the multi-step drill-down.

---

## 4. Playlist View (`src/routes/lists/[id]/+page.svelte`)

This page shows what is in a specific list. It is currently very technical.

### Recommended Changes:
- **Hide the Plex Sync Panel**:
    - The "Plex Playlists" section (lines 205-351) is full of technical details like mappings, root folders, and sync messages.
    - **Proposal**: Hide this entire panel for the wife. The syncing to Plex should be automatic or handled by the administrator. She only needs to see the list of songs.
- **Simplify Status Labels**:
    - Current statuses: "Pending", "Synced", "Failed", "Mirror pending", "Mirror active", "Mirror broken".
    - **Proposal**: Map these to human-friendly terms:
        - `synced` -> No badge needed (cleaner) or a simple green dot.
        - `pending` / `mirror_pending` -> "Downloading..." or "Processing...".
        - `failed` / `mirror_broken` -> "Error" (maybe with a note to ask the tech user).
- **Hide "Retry" and "Remove" Complexity**:
    - Hide the "Retry" buttons. Let the system handle retries or leave that for the administrator.
    - Keep the "Remove" (✕) button but make it larger for mobile.

---

## 5. Mobile Optimization (All Pages)

Since the target user will be using a phone, the UI needs to be "fat-finger" friendly and have lower density.

### Recommended Changes:
- **Button Sizes**:
    - Ensure all buttons (like the proposed "Add to Theo" buttons) are at least `44px` high (Tailwind `h-11` or similar).
    - The current `btn-secondary` uses `h-9` which is a bit small for mobile touch.
- **Touch Targets**:
    - The "✕" button to remove items on the list page is very small (`text-xs`). Increase the hit area even if the text remains small, or use a larger icon.
- **Inputs**:
    - Use larger text in inputs on mobile to prevent iOS from auto-zooming (at least `16px` or `text-base`).
- **Layout**:
    - The grid layout on the search page defaults to `md:grid-cols-2`. On mobile, it is 1 column, which is correct. Ensure the cards have sufficient spacing so the user doesn't accidentally tap the wrong card.

---

## 6. Required Changes for Developer (Task List)

Here are the specific tasks to pass to a developer to implement "Wife Mode":

### Navigation
- [ ] In `src/routes/+layout.svelte`, add a check or a separate layout for "Simple Mode".
- [ ] Remove "Mirror Health" and "Settings" from the navigation array for non-admin users.
- [ ] Rename "Lists" label to "Playlists".

### Search Page (`src/routes/+page.svelte`)
- [ ] Simplify the search form: hide the type selector and sort dropdown by default.
- [ ] Implement a combined search or default to "Track".
- [ ] Replace the list selection dropdown in search results with direct buttons for the top 2-3 lists.
- [ ] Hide the "In Lidarr" badge.
- [ ] Increase button heights to `h-11` for mobile views.

### List Detail Page (`src/routes/lists/[id]/+page.svelte`)
- [ ] Hide the "Plex Playlists" card (lines 205-351).
- [ ] Simplify the status mapping in `STATUS_CONFIG` to use simpler words (Ready, Working, Error).
- [ ] Hide "Retry" buttons.
- [ ] Increase the size of the delete (✕) button for items.

---

## 7. Admin Toggle Architecture (Decision: 2026-05-09)

**Chosen approach:** A device-remembered admin toggle stored as a cookie. No separate accounts or user roles required.

### How it works

1. A small **"Admin mode"** toggle sits in the header (e.g., next to the username — low-profile but findable).
2. Clicking it writes a cookie: `adminMode=true` or `adminMode=false`, with a long `max-age` (e.g., 1 year), so it survives browser restarts indefinitely on that device.
3. SvelteKit reads the cookie **server-side** in `src/routes/+layout.server.ts` and passes `isAdmin: boolean` down through the layout's `data` prop.
4. Every page and the layout template gates admin-only UI behind `{#if data.isAdmin}`.

### Why server-side cookie (not `localStorage`)

Reading the cookie in `+layout.server.ts` means the server renders the correct layout on the **first HTTP request** — there is no flash of admin UI before the client hides it. `localStorage` is client-only and would cause the full admin UI to render briefly before toggling off.

### Default value trade-off

| Default | Effect on admin | Effect on wife |
|---|---|---|
| `true` (admin on) | Every new device is admin — no setup needed | Wife's phone must be set to `false` once during setup |
| `false` (simple on) | Admin must toggle on once on each of their own devices | Works out of the box on any new device |

**Recommendation:** default to `false`. This will ease use later when kids grow and can add their own songs. Only Dad needs admin access and can toggle it on.

### Security note

This is a **UI-only** control. It hides admin elements; it does not restrict API access. Someone on the wife's phone could navigate to `/settings` or `/mirrors` directly and still reach those pages. For a private family app on a home network this is acceptable. If that ever changes, the API routes would also need server-side role checks.

### Files to touch

| File | Change |
|---|---|
| `src/routes/+layout.server.ts` | Read `adminMode` cookie; pass `isAdmin: boolean` to layout data |
| `src/routes/+layout.svelte` | Conditionally render nav items; render the toggle button |
| `src/routes/+page.svelte` | Gate type selector, sort, Lidarr badge, dropdown on `data.isAdmin` |
| `src/routes/lists/[id]/+page.svelte` | Gate Plex panel, retry buttons, raw errors, folder path on `data.isAdmin` |

### Task checklist for this section

- [ ] Create or update `src/routes/+layout.server.ts` to read the `adminMode` cookie and expose `isAdmin` in layout data.
- [ ] In `+layout.svelte`, filter `navItems` to `['/', '/lists']` when `!data.isAdmin`.
- [ ] Add an "Admin mode" toggle button in the header that sets the cookie and reloads (or uses a form action) to re-render with the new value.
- [ ] Confirm that `isAdmin` is threaded into page `data` for the search and list-detail pages (may need `+layout.ts` to forward it if the pages need it).

---

## 8. Code Review Findings (Added 2026-05-09)

The following are findings from a direct inspection of the three source files against the requirements above. Items are grouped by whether they confirm, correct, or extend the original recommendations.

---

### 8.1 Layout (`src/routes/+layout.svelte`)

**Confirmed:** All four nav items (Search, Lists, Mirror Health, Settings) are present with no filtering — matches the doc's observation.

**Finding — No role/mode data in the user object (resolved by Section 7):**
The layout template uses `data.user` (line 47) to show the username and Sign-out button, but there is no `role`, `isAdmin`, or `simpleMode` field — and no separate accounts are wanted. This is resolved by the cookie-based Admin Toggle described in Section 7: `isAdmin` comes from a cookie, not from the user record, so no database or account changes are needed.

---

### 8.2 Search Page (`src/routes/+page.svelte`)

**Confirmed:** Radio button type selector, visible sort dropdown, dropdown+Add button pattern, and "In Lidarr" / "In: {lm.listName}" badges are all present as described.

**Correction — Default search type is `'artist'`, not `'track'`:**
Line 9: `let type = 'artist';`. The doc recommends defaulting to `'track'` as the primary use case (adding specific songs). The current default is the opposite. The task list should explicitly call this out as a change.

**New finding — Page subtitle exposes "MusicBrainz" (line 162):**
The subtitle reads: *"Find artists, albums, and tracks on MusicBrainz and add them to a list."*
Both "MusicBrainz" (a backend database name) and "a list" (vs. "a playlist") are jargon. Should be replaced with something like: *"Search for songs and artists to add to your playlists."*

**New finding — Track drill-down add buttons are critically small (`h-6` = 24px):**
The doc flags album-level buttons in the drill-down as `h-7` (28px), but track-level buttons (line 402) are `h-6` (24px) — even smaller. The list-select in that row (line 396) is also `h-6`. These are far below the 44px touch target threshold and would be essentially untappable on a phone.

**New finding — Drill-down select inputs are also undersized:**
- Album-level `<select>` (line 348): `h-7` (28px)
- Track-level `<select>` (line 396): `h-6` (24px)

Both selects are in the drill-down path the wife would use most (picking which playlist to add a song to). The doc's task only calls out button heights — the select inputs need the same treatment.

**New finding — Search submit button is also `h-9` (line 236):**
The main "Search" submit button uses `h-9 py-1`. The doc only calls out the "Add" button height; the Search button itself is equally undersized for mobile.

---

### 8.3 List Detail Page (`src/routes/lists/[id]/+page.svelte`)

**Confirmed:** Plex Sync Panel (lines 204–351), all six STATUS_CONFIG statuses with technical labels (lines 8–15), per-item Retry buttons (lines 394–401), and the small delete button (lines 403–410) are all present as described.

**New finding — "Retry all" button not covered by the task list (lines 359–368):**
Above the item list, there is a "Retry all (N)" button that appears whenever any items are in a retryable state. The doc's task list says to hide "Retry" buttons but only addresses the per-item ones. The "Retry all" button must also be hidden for the simplified view.

**New finding — Root folder path exposed in the page header (line 197):**
```svelte
<p class="mt-0.5 font-mono text-xs text-slate-500">{data.list.root_folder_path}</p>
```
This displays the raw filesystem path (e.g. `/music/kids/theo`) directly under the playlist name. This is meaningless and confusing to a non-technical user and should be hidden.

**New finding — "← Lists" back link uses the old label (line 194):**
The back link reads `← Lists`. If the nav item is renamed to "Playlists", this text must also be updated for consistency.

**New finding — Inline status notes reference "Lidarr" and "mirror" directly (lines 422–432):**
Two visible text strings use technical jargon:
- Line 424: *"Waiting for Lidarr to download — will mirror files automatically on download."*
- Line 431: *"Mirror copy is broken or missing. Use Retry to attempt repair."*

For simplified mode these should either be hidden entirely or replaced. Suggestions:
- mirror_pending → *"This song is being downloaded."*
- mirror_broken → *"Something went wrong. Ask an admin to fix this."*

**New finding — Raw error text exposed in the UI (lines 415–418):**
When `sync_status === 'failed'` and `sync_error` is set, the raw error string is shown in a monospace code block. This will show stack traces or filesystem errors to the user. It should be hidden for simplified mode (the simplified status label "Error" with a note to contact admin is sufficient).

**New finding — Confirmation dialog exposes "Mirror files on disk" (line 32–33):**
The `removeItem` function triggers:
```js
confirm('Remove this item from the list? Mirror files on disk will also be deleted.')
```
For the wife, this should read something like: *"Remove this song from the playlist?"*

**New finding — Item type badge adds noise (lines 379–381):**
Each item card shows a type badge ("Artist", "Album", "Track"). For a children's music playlist the items will almost always be tracks, so this badge adds density without value. Consider hiding in simplified mode.

---

### 8.4 Updated Task List Additions

The following tasks should be added to Section 6:

**Layout**
- [ ] Implement the cookie-based admin toggle — see full task checklist in Section 7.

**Search Page (`src/routes/+page.svelte`)**
- [ ] Change default `type` from `'artist'` to `'track'` (line 9).
- [ ] Update the page subtitle to remove "MusicBrainz" and "a list" (line 162).
- [ ] Increase the main "Search" submit button to at least `h-11` (line 236).
- [ ] In the drill-down: increase album-level add button from `h-7` to `h-11` and select from `h-7` to a standard height.
- [ ] In the drill-down: increase track-level add button from `h-6` to `h-11` and select from `h-6` to a standard height.

**List Detail Page (`src/routes/lists/[id]/+page.svelte`)**
- [ ] Hide the "Retry all" button (lines 359–368) in simplified mode.
- [ ] Hide the root folder path from the page header (line 197).
- [ ] Update the "← Lists" back link text to "← Playlists" (line 194).
- [ ] Replace or hide the "mirror_pending" and "mirror_broken" inline text notes that reference Lidarr and mirror (lines 422–432).
- [ ] Hide the raw `sync_error` code block (lines 415–418) in simplified mode.
- [ ] Simplify the `removeItem` confirmation dialog to remove "Mirror files on disk" (line 32–33).
- [ ] Consider hiding the type badge on item cards (lines 379–381) in simplified mode.
