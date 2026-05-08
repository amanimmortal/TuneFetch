<script lang="ts">
  import { onMount } from "svelte";

  export let name: string;
  export let value: string = "";
  export let id: string = name;
  export let required: boolean = false;

  let currentPath: string = "";
  let parentPath: string | null = null;
  let folders: Array<{ name: string; path: string }> = [];
  let error: string | null = null;
  let loading = false;
  let isOpen = false;

  async function loadDirectory(path: string | null = null) {
    loading = true;
    error = null;
    try {
      const query = path ? `?path=${encodeURIComponent(path)}` : "";
      const res = await fetch(`/api/browse${query}`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to load directory");
      }

      currentPath = data.currentPath;
      parentPath = data.parentPath;
      folders = data.folders;
      
      if (!value && !path) {
          value = currentPath; // Default value to starting directory
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  function handleOpen() {
    if (!isOpen) {
      loadDirectory(value || null);
    }
    isOpen = !isOpen;
  }

  function selectFolder(path: string) {
    value = path;
    isOpen = false;
  }
</script>

<div class="relative">
  <div class="flex gap-2">
    <input
      type="text"
      {id}
      {name}
      bind:value
      {required}
      class="input flex-1"
      placeholder="/music/theo"
      autocomplete="off"
    />
    <button
      type="button"
      class="btn-secondary whitespace-nowrap"
      on:click={handleOpen}
    >
      Browse
    </button>
  </div>

  {#if isOpen}
    <div class="absolute z-10 mt-1 w-full rounded-md border border-slate-700 bg-slate-800 p-2 shadow-lg">
      {#if error}
        <div class="mb-2 rounded bg-red-900/30 p-2 text-sm text-red-400">{error}</div>
      {/if}

      <div class="mb-2 flex items-center justify-between text-sm text-slate-300">
        <div class="truncate font-mono" title={currentPath}>{currentPath}</div>
        {#if loading}
          <span class="animate-pulse">Loading...</span>
        {/if}
      </div>

      <div class="max-h-60 overflow-y-auto rounded border border-slate-700 bg-slate-900/50">
        {#if parentPath}
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-700 focus:bg-slate-700"
            on:click={() => loadDirectory(parentPath)}
          >
            <span class="text-slate-400">📁</span>
            <span>..</span>
          </button>
        {/if}

        {#each folders as folder}
          <div class="flex w-full items-center group">
            <button
              type="button"
              class="flex flex-1 items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-700 focus:bg-slate-700"
              on:click={() => selectFolder(folder.path)}
            >
              <span class="text-slate-400">📁</span>
              <span class="truncate">{folder.name}</span>
            </button>
            <button
              type="button"
              class="px-3 py-2 text-slate-500 hover:text-slate-300 focus:text-slate-300 hover:bg-slate-700"
              title="Open folder"
              on:click={() => loadDirectory(folder.path)}
            >
              →
            </button>
          </div>
        {:else}
          {#if !parentPath && !loading}
            <div class="p-3 text-center text-sm text-slate-500">No folders found</div>
          {/if}
        {/each}
      </div>
      
      <div class="mt-2 flex justify-end">
        <button type="button" class="btn-secondary text-sm" on:click={() => (isOpen = false)}>Close</button>
      </div>
    </div>
  {/if}
</div>
