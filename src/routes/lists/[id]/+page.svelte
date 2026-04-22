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

  // Track which items are currently being retried
  let retrying = new Set<number>();

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

  <!-- Items -->
  {#if data.items.length === 0}
    <div class="card text-sm text-slate-400">
      No items in this list yet. Search for music and add it here.
    </div>
  {:else}
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

              {#if item.sync_status === 'failed' || item.sync_status === 'mirror_broken'}
                <button
                  class="btn-secondary text-xs py-1 px-2 disabled:opacity-50"
                  disabled={retrying.has(item.id)}
                  on:click={() => retryItem(item.id)}
                >
                  {retrying.has(item.id) ? 'Retrying…' : 'Retry'}
                </button>
              {/if}
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
