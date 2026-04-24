# Technical Handover: Search Result List Selection Reset Bug

## Issue Description
In the **Search** interface (`/`), when a user adds a track, artist, or album to a list, the list selection dropdown resets unexpectedly after the "Add" button is clicked.

Specifically:
1. The user selects a target list from the dropdown (which initially shows "Select list…").
2. The user clicks "Add".
3. The item is successfully added, but the dropdown resets to either "Select list…" or the first available list in alphabetical order.

This creates a poor user experience as it can make the user believe they added the item to the wrong list if they weren't paying close attention at the moment of the click.

## Root Cause Analysis
The issue is caused by the interaction between SvelteKit's `use:enhance` and the lack of state persistence for the `select` element during page invalidation.

### Implementation Details
In `src/routes/+page.svelte`, each search result provides a form to add the item to a list:

```svelte
<!-- src/routes/+page.svelte -->
<form method="POST" action="?/addToList" use:enhance class="flex items-center gap-2 flex-1 min-w-0">
  <input type="hidden" name="mbid" value={r.mbid} />
  <!-- ... other hidden fields ... -->
  {#if data.lists.length === 0}
    <span class="text-sm text-slate-500 italic flex-1">No lists exist.</span>
  {:else}
    <select name="listId" class="input flex-1 px-2 py-1 text-sm h-9 min-w-0" required>
      <option value="" disabled selected>Select list…</option>
      {#each data.lists as list}
        <option value={list.id}>{list.name}</option>
      {/each}
    </select>
    <button type="submit" class="btn-secondary h-9 py-1 text-sm whitespace-nowrap shrink-0">Add</button>
  {/if}
</form>
```

### Why the Reset Occurs
1. **Form Reset**: By default, `use:enhance` resets the form fields upon a successful response. This reverts the `<select>` to its initial state, which is the `<option>` marked as `selected`.
2. **Page Invalidation**: `use:enhance` also triggers a call to `invalidateAll()`, which re-runs the `load` function in `src/routes/+page.server.ts`.
3. **Data Refresh**: When `load` re-runs, it fetches a fresh copy of `data.lists`:
   ```typescript
   // src/routes/+page.server.ts
   export const load: PageServerLoad = async () => {
       const lists = getDb()
           .prepare('SELECT id, name FROM lists ORDER BY name ASC')
           .all() as { id: number; name: string }[];
       return { lists };
   };
   ```
4. **Re-rendering**: Svelte detects that `data.lists` has changed (or at least was re-assigned) and re-renders the `{#each}` block inside the search results.
5. **State Loss**: Because the `select` element's value is **not bound** (no `bind:value`), Svelte does not attempt to preserve the user's previous selection through the re-render. The browser defaults back to the first available option. 
6. **Confusing Default**: Since the "Select list…" option is `disabled`, some browsers or reconciliation steps may default to the first *enabled* option (the first list alphabetically), making it look like the "wrong" list is selected.

## Files Involved
- `src/routes/+page.svelte` (Lines 300–305: The select element implementation)
- `src/routes/+page.server.ts` (Lines 6–12: The load function providing the lists)

## Recommended Fixes

### Option 1: Prevent Form Reset (Easiest)
Customize the `use:enhance` behavior to prevent the automatic form reset. This allows the user's selection to persist in the DOM.

```javascript
<form 
  method="POST" 
  action="?/addToList" 
  use:enhance={() => {
    return async ({ update }) => {
      await update({ reset: false });
    };
  }}
>
```

### Option 2: Bind Selection to State
Create a reactive variable to track the selected list ID. However, since search results are dynamic and there are multiple forms, this would require a mapping (e.g., `selectedListIds: Record<string, string>`) to track selection per result MBID.

### Option 3: "Smart" Placeholder
If the reset is desired but the "wrong list" look is the problem, ensure the "Select list…" option is always the one shown after reset by explicitly binding the value to an empty string on success, or ensuring the browser respects the `selected` attribute correctly during reconciliation.
