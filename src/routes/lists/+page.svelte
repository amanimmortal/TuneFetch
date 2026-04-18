<script lang="ts">
  import { enhance } from "$app/forms";
  import type { ActionData, PageData } from "./$types";

  export let data: PageData;
  export let form: ActionData;

  // ── Local UI state ─────────────────────────────────────────────────────────
  let renamingId: number | null = null;
  let showCreateForm = false;

  // ── Derive action results from opaque ActionData union ─────────────────────
  $: f = form as Record<string, unknown> | null;
  $: createError     = (f?.createError as string | undefined) ?? null;
  $: renameError     = (f?.renameError as string | undefined) ?? null;
  $: renameErrorId   = (f?.renameId   as number | undefined) ?? null;
  $: deleteWarning   = (f?.deleteWarning as boolean | undefined) ?? false;
  $: deleteId        = (f?.deleteId   as number | undefined) ?? null;
  $: transferable    = (f?.transferable as any[] | undefined) ?? [];
  $: blocked         = (f?.blocked    as any[] | undefined) ?? [];

  // Reset rename form after success
  $: if (f?.renamed)  renamingId = null;
  $: if (f?.created)  showCreateForm = false;
</script>

<svelte:head>
  <title>Lists · TuneFetch</title>
</svelte:head>

<section class="space-y-6">
  <header class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Lists</h1>
      <p class="mt-1 text-sm text-slate-400">
        Each list maps to a person and a Lidarr root folder.
      </p>
    </div>
    <button class="btn-primary" on:click={() => (showCreateForm = !showCreateForm)}>
      {showCreateForm ? "Cancel" : "New list"}
    </button>
  </header>

  <!-- ── Create form ──────────────────────────────────────────────────────── -->
  {#if showCreateForm}
    <form
      class="card space-y-4"
      method="POST"
      action="?/create"
      use:enhance
    >
      <h2 class="font-medium text-slate-200">New list</h2>

      <div>
        <label for="new_name" class="mb-1 block text-sm font-medium text-slate-300">Name</label>
        <input id="new_name" name="name" type="text" class="input" placeholder="e.g. Theo" required />
      </div>

      {#if data.lidarrError}
        <p class="text-sm text-amber-400">
          Cannot load root folders — Lidarr not configured or unreachable: {data.lidarrError}
        </p>
        <input name="root_folder_path" type="text" class="input" placeholder="/mnt/user/media/music/..." required />
      {:else}
        <div>
          <label for="new_root_folder" class="mb-1 block text-sm font-medium text-slate-300">
            Root folder
          </label>
          <select id="new_root_folder" name="root_folder_path" class="input" required>
            <option value="" disabled selected>Select a root folder…</option>
            {#each data.folders as folder}
              <option value={folder.path}>{folder.path}</option>
            {/each}
          </select>
        </div>
      {/if}

      {#if createError}
        <p class="text-sm text-red-400">{createError}</p>
      {/if}

      <button type="submit" class="btn-primary">Create</button>
    </form>
  {/if}

  <!-- ── List cards ────────────────────────────────────────────────────────── -->
  {#if data.lists.length === 0}
    <div class="card text-sm text-slate-400">
      No lists yet. Create one above to get started.
    </div>
  {:else}
    <div class="space-y-3">
      {#each data.lists as list (list.id)}
        <div class="card space-y-3">
          <!-- List header -->
          <div class="flex items-start justify-between gap-4">
            <div>
              <h2 class="font-semibold text-slate-100">{list.name}</h2>
              <p class="mt-0.5 font-mono text-xs text-slate-500">{list.root_folder_path}</p>
              <p class="mt-1 text-xs text-slate-400">
                {list.item_count} item{list.item_count !== 1 ? "s" : ""}
              </p>
            </div>

            <div class="flex shrink-0 gap-2">
              <a href="/lists/{list.id}" class="btn-secondary text-sm">View</a>
              <button
                class="btn-secondary text-sm"
                on:click={() => (renamingId = renamingId === list.id ? null : list.id)}
              >
                {renamingId === list.id ? "Cancel" : "Rename"}
              </button>
              <form method="POST" action="?/delete" use:enhance>
                <input type="hidden" name="id" value={list.id} />
                <button type="submit" class="btn-danger text-sm">Delete</button>
              </form>
            </div>
          </div>

          <!-- Inline rename form -->
          {#if renamingId === list.id}
            <form
              class="flex items-center gap-2 border-t border-slate-700 pt-3"
              method="POST"
              action="?/rename"
              use:enhance
            >
              <input type="hidden" name="id" value={list.id} />
              <input
                name="name"
                type="text"
                class="input flex-1"
                value={list.name}
                placeholder="New name"
                required
              />
              <button type="submit" class="btn-primary text-sm">Save</button>
            </form>
            {#if renameError && renameErrorId === list.id}
              <p class="text-sm text-red-400">{renameError}</p>
            {/if}
          {/if}

          <!-- Delete warning panel -->
          {#if deleteWarning && deleteId === list.id}
            <div class="space-y-3 rounded-lg border border-amber-700 bg-amber-950/40 p-4 text-sm">
              {#if blocked.length > 0}
                <p class="font-medium text-amber-300">Cannot delete — ownership conflict</p>
                <p class="text-amber-200/80">
                  The following artists are owned by this list in Lidarr and are not in any
                  other list. Add them to another list first, or remove them from Lidarr manually.
                </p>
                <ul class="list-inside list-disc space-y-0.5 text-amber-200/70">
                  {#each blocked as a}
                    <li>{a.display_name}</li>
                  {/each}
                </ul>
              {/if}

              {#if transferable.length > 0}
                <p class="font-medium text-amber-300">
                  {blocked.length > 0 ? "Transferable artists" : "Ownership transfer required"}
                </p>
                <p class="text-amber-200/80">
                  Lidarr ownership of the following artists will be transferred to another list.
                  Lidarr will physically move their files to the new root folder.
                </p>
                <ul class="list-inside list-disc space-y-0.5 text-amber-200/70">
                  {#each transferable as a}
                    <li>{a.display_name} → {a.newOwnerName}</li>
                  {/each}
                </ul>
              {/if}

              <div class="flex gap-2 pt-1">
                {#if blocked.length === 0}
                  <form method="POST" action="?/delete" use:enhance>
                    <input type="hidden" name="id" value={list.id} />
                    <input type="hidden" name="confirmed" value="true" />
                    <button type="submit" class="btn-danger text-sm">
                      Transfer ownership and delete
                    </button>
                  </form>
                {/if}
                <button
                  class="btn-secondary text-sm"
                  on:click={() => { /* SvelteKit will clear form on next action */ window.location.reload(); }}
                >
                  Cancel
                </button>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</section>
