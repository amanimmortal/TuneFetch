<script lang="ts">
  import type { PageData } from './$types';
  import { invalidateAll } from '$app/navigation';

  export let data: PageData;

  // Sync status display config
  const STATUS_CONFIG: Record<string, { label: string; classes: string }> = {
    pending:        { label: 'Pending',         classes: 'bg-slate-700 text-slate-300' },
    synced:         { label: 'Synced',          classes: 'bg-green-900/60 text-green-300 border border-green-700' },
    failed:         { label: 'Failed',          classes: 'bg-red-900/60 text-red-300 border border-red-700' },
    mirror_pending: { label: 'Mirror pending',  classes: 'bg-sky-900/60 text-sky-300 border border-sky-700' },
    mirror_active:  { label: 'Mirror active',   classes: 'bg-blue-900/60 text-blue-300 border border-blue-700' },
    mirror_broken:  { label: 'Mirror broken',   classes: 'bg-orange-900/60 text-orange-300 border border-orange-700' }
  };

  function statusCfg(status: string) {
    return STATUS_CONFIG[status] ?? { label: status, classes: 'bg-slate-700 text-slate-300' };
  }

  const TYPE_LABELS: Record<string, string> = {
    artist: 'Artist',
    album:  'Album',
    track:  'Track'
  };

  // Track which items are currently being retried or removed
  let retrying = new Set<number>();
  let removing = new Set<number>();

  async function removeItem(itemId: number) {
    if (!confirm('Remove this item from the list? Mirror files on disk will also be deleted.')) return;
    removing.add(itemId);
    removing = removing;
    try {
      await fetch(`/api/lists/${data.list.id}/items/${itemId}`, { method: 'DELETE' });
      await invalidateAll();
    } finally {
      removing.delete(itemId);
      removing = removing;
    }
  }

  const RETRYABLE = new Set(['pending', 'mirror_pending', 'failed', 'mirror_broken']);

  async function retryItem(itemId: number) {
    retrying.add(itemId);
    retrying = retrying; // trigger reactivity
    try {
      await fetch(`/api/lists/${data.list.id}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: itemId })
      });
      await invalidateAll();
    } finally {
      retrying.delete(itemId);
      retrying = retrying;
    }
  }

  async function retryAll() {
    const ids = data.items
      .filter((i) => RETRYABLE.has(i.sync_status))
      .map((i) => i.id);
    await Promise.all(ids.map(retryItem));
  }

  $: retryableItems = data.items.filter((i) => RETRYABLE.has(i.sync_status));
  $: retryingAll = retryableItems.length > 0 && retryableItems.every((i) => retrying.has(i.id));

  // ── Plex sync UI state ────────────────────────────────────────────────
  let showAddPlex = false;
  let newPlaylistTitle = '';
  let selectedMappingId = '';
  let addingPlex = false;
  let syncingPlaylist: number | null = null;
  let plexSyncMessage = '';
  let deletingPlaylist: number | null = null;

  // Pre-select suggested mapping when it exists
  $: if (data.suggestedMapping && !selectedMappingId) {
    selectedMappingId = String(data.suggestedMapping.id);
  }

  // Default playlist title to list name
  $: if (!newPlaylistTitle && data.list.name) {
    newPlaylistTitle = data.list.name;
  }

  async function addPlexPlaylist() {
    if (!selectedMappingId || !newPlaylistTitle.trim()) return;
    addingPlex = true;
    plexSyncMessage = '';
    try {
      const mapping = data.allMappings.find(m => m.id === Number(selectedMappingId));
      if (!mapping) return;

      const res = await fetch('/api/plex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create_playlist_link',
          list_id: data.list.id,
          plex_user_token: mapping.plex_user_token,
          plex_user_name: mapping.plex_user_name,
          playlist_title: newPlaylistTitle.trim()
        })
      });
      const result = await res.json();
      if (result.ok) {
        showAddPlex = false;
        newPlaylistTitle = data.list.name;
        selectedMappingId = '';
        await invalidateAll();
      } else {
        plexSyncMessage = result.error ?? 'Failed to create playlist link';
      }
    } finally {
      addingPlex = false;
    }
  }

  async function syncPlaylist(playlistDbId: number) {
    syncingPlaylist = playlistDbId;
    plexSyncMessage = '';
    try {
      const res = await fetch('/api/plex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'sync',
          playlist_id: playlistDbId
        })
      });
      const result = await res.json();
      if (result.ok) {
        const r = result.result;
        plexSyncMessage = `Sync complete: ${r.added} added, ${r.alreadySynced} already synced, ${r.notFound} not found`;
        await invalidateAll();
      } else {
        plexSyncMessage = result.error ?? 'Sync failed';
      }
    } catch (err) {
      plexSyncMessage = 'Network error during sync';
    } finally {
      syncingPlaylist = null;
    }
  }

  async function deletePlaylistLink(playlistDbId: number) {
    if (!confirm('Remove this Plex playlist link? The playlist in Plex itself will not be deleted.')) return;
    deletingPlaylist = playlistDbId;
    try {
      await fetch('/api/plex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delete_playlist_link',
          id: playlistDbId
        })
      });
      await invalidateAll();
    } finally {
      deletingPlaylist = null;
    }
  }
</script>

<svelte:head>
  <title>{data.list.name} · TuneFetch</title>
</svelte:head>

<section class="space-y-6">
  <!-- Header -->
  <header class="flex items-start justify-between gap-4">
    <div>
      <div class="flex items-center gap-2">
        <a href="/lists" class="text-sm text-slate-400 hover:text-slate-200">← Lists</a>
      </div>
      <h1 class="mt-1 text-2xl font-semibold tracking-tight">{data.list.name}</h1>
      <p class="mt-0.5 font-mono text-xs text-slate-500">{data.list.root_folder_path}</p>
    </div>
    <span class="badge bg-slate-700 text-slate-300 mt-1">
      {data.items.length} item{data.items.length !== 1 ? 's' : ''}
    </span>
  </header>

  <!-- ── Plex Sync Panel ──────────────────────────────────────────────── -->
  <div class="card space-y-4">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-medium text-slate-200">Plex Playlists</h2>
      <button
        class="btn-secondary text-xs"
        on:click={() => { showAddPlex = !showAddPlex; }}
      >
        {showAddPlex ? 'Cancel' : '+ Add playlist'}
      </button>
    </div>

    <!-- Warning if no mapping for this path -->
    {#if !data.suggestedMapping && data.allMappings.length > 0}
      <div class="flex items-start gap-2 rounded-lg border border-amber-700 bg-amber-950/40 px-3 py-2 text-sm text-amber-300">
        <span class="mt-px select-none text-base leading-none">⚠</span>
        <span>
          No Plex user is mapped to <code class="font-mono text-xs">{data.list.root_folder_path}</code>.
          <a href="/settings" class="underline hover:text-amber-200">Configure user mappings</a> in Settings to auto-suggest the correct user.
        </span>
      </div>
    {/if}

    {#if data.allMappings.length === 0}
      <div class="flex items-start gap-2 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-400">
        <span class="mt-px select-none text-base leading-none">—</span>
        <span>
          No Plex user mappings configured yet.
          <a href="/settings" class="underline hover:text-slate-200">Set up Plex</a> in Settings first.
        </span>
      </div>
    {/if}

    <!-- Add playlist form -->
    {#if showAddPlex && data.allMappings.length > 0}
      <div class="rounded-lg border border-slate-600 bg-slate-800/50 p-4 space-y-3">
        <div>
          <label for="plex_user_select" class="mb-1 block text-sm font-medium text-slate-300">
            Plex User
          </label>
          <select
            id="plex_user_select"
            class="input"
            bind:value={selectedMappingId}
          >
            <option value="">Select a user…</option>
            {#each data.allMappings as mapping}
              <option value={String(mapping.id)}>
                {mapping.plex_user_name}
                ({mapping.root_folder_path})
                {mapping.root_folder_path === data.list.root_folder_path ? '✓ matches' : ''}
              </option>
            {/each}
          </select>

          {#if selectedMappingId}
            {@const sel = data.allMappings.find(m => m.id === Number(selectedMappingId))}
            {#if sel && sel.root_folder_path !== data.list.root_folder_path}
              <p class="mt-1 text-xs text-amber-400">
                ⚠ This user's mapped path (<code class="font-mono">{sel.root_folder_path}</code>)
                doesn't match this list's path (<code class="font-mono">{data.list.root_folder_path}</code>).
                The user may not have access to see these tracks in Plex.
              </p>
            {:else if sel}
              <p class="mt-1 text-xs text-green-400">
                ✓ User path matches this list — tracks should be visible to {sel.plex_user_name}.
              </p>
            {/if}
          {/if}
        </div>

        <div>
          <label for="plex_playlist_title" class="mb-1 block text-sm font-medium text-slate-300">
            Playlist Title
          </label>
          <input
            id="plex_playlist_title"
            type="text"
            class="input"
            bind:value={newPlaylistTitle}
            placeholder="My playlist name"
          />
        </div>

        <button
          class="btn-primary text-sm"
          disabled={addingPlex || !selectedMappingId || !newPlaylistTitle.trim()}
          on:click={addPlexPlaylist}
        >
          {addingPlex ? 'Creating…' : 'Create playlist link'}
        </button>
      </div>
    {/if}

    <!-- Existing playlists -->
    {#if data.plexPlaylists.length > 0}
      <div class="space-y-2">
        {#each data.plexPlaylists as pp (pp.id)}
          <div class="rounded-lg border border-slate-600 bg-slate-800/30 px-4 py-3 flex items-center justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-medium text-slate-100">{pp.playlist_title}</span>
                <span class="badge bg-purple-900/50 text-purple-300 border border-purple-700 text-xs">
                  {pp.plex_user_name}
                </span>
                {#if pp.plex_playlist_id}
                  <span class="badge bg-green-900/40 text-green-400 text-xs">
                    {data.plexItemCounts[pp.id] ?? 0} tracks synced
                  </span>
                {:else}
                  <span class="badge bg-slate-700 text-slate-400 text-xs">Not yet created in Plex</span>
                {/if}
              </div>
              {#if pp.last_synced_at}
                <p class="mt-0.5 text-xs text-slate-500">Last synced: {new Date(pp.last_synced_at).toLocaleString()}</p>
              {/if}
            </div>

            <div class="flex shrink-0 items-center gap-2">
              <button
                class="btn-primary text-xs py-1 px-3"
                disabled={syncingPlaylist === pp.id}
                on:click={() => syncPlaylist(pp.id)}
              >
                {syncingPlaylist === pp.id ? 'Syncing…' : 'Sync now'}
              </button>
              <button
                class="btn-secondary text-xs py-1 px-2 text-red-400 hover:text-red-300"
                disabled={deletingPlaylist === pp.id}
                on:click={() => deletePlaylistLink(pp.id)}
              >
                ✕
              </button>
            </div>
          </div>
        {/each}
      </div>
    {:else if !showAddPlex}
      <p class="text-sm text-slate-500">No Plex playlists linked to this list.</p>
    {/if}

    <!-- Sync message -->
    {#if plexSyncMessage}
      <div class="rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-300">
        {plexSyncMessage}
      </div>
    {/if}
  </div>

  <!-- Items -->
  {#if data.items.length === 0}
    <div class="card text-sm text-slate-400">
      No items in this list yet. Search for music and add it here.
    </div>
  {:else}
    {#if retryableItems.length > 0}
      <div class="flex justify-end">
        <button
          class="btn-secondary text-xs py-1 px-3 disabled:opacity-50"
          disabled={retryingAll}
          on:click={retryAll}
        >
          {retryingAll ? 'Retrying…' : `Retry all (${retryableItems.length})`}
        </button>
      </div>
    {/if}
    <div class="space-y-3">
      {#each data.items as item (item.id)}
        {@const cfg = statusCfg(item.sync_status)}
        <div class="card space-y-2">
          <!-- Item row -->
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-medium text-slate-100 truncate">{item.title}</span>
                <span class="badge bg-slate-800 text-slate-400 capitalize shrink-0">
                  {TYPE_LABELS[item.type] ?? item.type}
                </span>
              </div>
              <p class="mt-0.5 text-sm text-slate-400">{item.artist_name}
                {#if item.album_name}
                  <span class="text-slate-500">· {item.album_name}</span>
                {/if}
              </p>
            </div>

            <!-- Status badge + actions -->
            <div class="flex shrink-0 items-center gap-2">
              <span class="badge {cfg.classes}">{cfg.label}</span>

              {#if item.sync_status === 'failed' || item.sync_status === 'mirror_broken' || item.sync_status === 'pending' || item.sync_status === 'mirror_pending'}
                <button
                  class="btn-secondary text-xs py-1 px-2 disabled:opacity-50"
                  disabled={retrying.has(item.id)}
                  on:click={() => retryItem(item.id)}
                >
                  {retrying.has(item.id) ? 'Retrying…' : 'Retry'}
                </button>
              {/if}
              <button
                class="text-xs py-1 px-2 rounded text-slate-500 hover:text-red-400 hover:bg-red-950/40 transition-colors disabled:opacity-30"
                disabled={removing.has(item.id)}
                on:click={() => removeItem(item.id)}
                title="Remove from list"
              >
                {removing.has(item.id) ? '…' : '✕'}
              </button>
            </div>
          </div>

          <!-- Error detail -->
          {#if item.sync_status === 'failed' && item.sync_error}
            <div class="rounded border border-red-800 bg-red-950/40 px-3 py-2 font-mono text-xs text-red-300">
              {item.sync_error}
            </div>
          {/if}

          <!-- Mirror pending indicator -->
          {#if item.sync_status === 'mirror_pending'}
            <p class="text-xs text-sky-400/80">
              Waiting for Lidarr to download — will mirror files automatically on download.
            </p>
          {/if}

          <!-- Mirror broken note -->
          {#if item.sync_status === 'mirror_broken'}
            <p class="text-xs text-orange-400/80">
              Mirror copy is broken or missing. Use Retry to attempt repair.
            </p>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</section>
