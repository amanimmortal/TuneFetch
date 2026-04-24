# Technical Audit: Search Form Button Reactivity Issue

## Issue Description
The "Search" button on the primary search tab (`/`) is consistently disabled ("greyed out"), preventing users from submitting searches even after valid input has been entered into the artist, album, or track fields.

## Root Cause Analysis
The issue stems from a **reactivity tracking failure** in the Svelte 4 compiler. 

### Implementation Details
In `src/routes/+page.svelte`, the search button's `disabled` state is determined by the following expression:

```svelte
<button type="submit" class="btn-primary h-9 py-1" disabled={searching || !hasAnyField()}>
```

The `hasAnyField` function is defined as a standard JavaScript function:

```javascript
function hasAnyField(): boolean {
    return !!(artistField.trim() || albumField.trim() || trackField.trim());
}
```

### Why it Fails
In Svelte 3 and 4, the compiler tracks dependencies for template expressions to determine when they need to be re-evaluated. However, when a function is called with **no arguments** inside a template expression (like `!hasAnyField()`), the compiler does not automatically trace the function's internal dependencies (like `artistField`) unless they are also explicitly used elsewhere in the same expression or the function is part of a reactive declaration.

Because `searching` remains `false` and `hasAnyField()` is only evaluated once during the initial render (returning `false`), the button remains disabled. When the user types into an input field, Svelte updates the internal state of `artistField`, but it does not realize that the `button`'s `disabled` attribute needs to be re-calculated because it doesn't "see" that `hasAnyField()` depends on those variables.

## Evidence
- **Initial State:** `artistField`, `albumField`, and `trackField` are all `''`. `hasAnyField()` returns `false`. `disabled` is `true`.
- **User Interaction:** User types into a field. The input is bound via `bind:value`, so the variable updates.
- **Re-render:** Svelte re-renders the input elements, but the button's `disabled` expression `searching || !hasAnyField()` is **not** re-evaluated because its explicit dependencies (`searching`) haven't changed.

## Recommended Fixes

### Option 1: Reactive Statement (Recommended)
Convert the search validation into a reactive variable. This is the idiomatic Svelte way to handle such dependencies as it makes the tracking explicit to the compiler.

```javascript
// Add this reactive declaration
$: canSearch = !!(artistField.trim() || albumField.trim() || trackField.trim());

// Update the button
<button type="submit" ... disabled={searching || !canSearch}>
```

### Option 2: Explicit Arguments
Pass the dependencies as arguments to the function call in the template. This forces the compiler to track them.

```svelte
<button type="submit" ... disabled={searching || !hasAnyField(artistField, albumField, trackField)}>
```

## Additional Findings
While reviewing `src/routes/+page.svelte`, a minor state management inconsistency was noted in the `onTypeChange` function:

```javascript
function onTypeChange() {
    results = [];
    didInitialSearch = false;
    searchError = null;
    expandedArtistMbid = null;
    expandedAlbumMbid = null;
    albumField = '';
    trackField = '';
    // artistField is NOT cleared here
}
```
Currently, switching between "Album" and "Artist" search types preserves the `artistField` value. While this can be a useful feature (e.g., searching for an artist's albums after searching for the artist), it should be confirmed if this was intentional or an oversight.
