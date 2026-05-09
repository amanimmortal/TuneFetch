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
