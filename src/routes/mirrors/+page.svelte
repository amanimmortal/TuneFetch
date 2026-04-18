<script lang="ts">
  import { enhance } from '$app/forms';
  import type { ActionData, PageData } from './$types';

  export let data: PageData;
  export let form: ActionData;

  $: f = form as Record<string, unknown> | null;
  $: refreshError = (f?.refreshError as string | undefined) ?? null;
  $: scanError    = (f?.scanError    as string | undefined) ?? null;
  $: refreshed    = (f?.refreshed    as number | undefined) ?? null;
  $: scanned      = (f?.scanned      as boolean | undefined) ?? false;

  // Truncate long paths for display — show tail end, most readable part
  function shortPath(p: string, maxLen = 60): string {
    if (p.length <= maxLen) return p;
    return '…' + p.slice(p.length - (maxLen - 1));
  }
</script>

<svelte:head>
  <title>Mirror Health · TuneFetch</title>
</svelte:head>

<section class="space-y-6">
  <header class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Mirror Health</h1>
      <p class="mt-1 text-sm text-slate-400">
        File copies, stale mirrors, and orphan detection.
      </p>
    </div>
    <div class="flex gap-2">
      <form method="POST" action="?/refreshStale" use:enhance>
        <button
          type="submit"
          class="btn-secondary"
          disabled={data.staleCount === 0}
          title={data.staleCount === 0 ? 'No stale files' : `Refresh ${data.staleCount} stale file(s)`}
        >
          Refresh Stale{data.staleCount > 0 ? ` (${data.staleCount})` : ''}
        </button>
      </form>
      <form method="POST" action="?/scanNow" use:enhance>
        <button type="submit" class="btn-secondary">Scan Now</button>
      </form>
    </div>
  </header>

  <!-- Action feedback -->
  {#if refreshError}
    <div class="rounded-md border border-red-800 bg-red-900/40 p-3 text-sm text-red-300">{refreshError}</div>
  {/if}
  {#if scanError}
    <div class="rounded-md border border-red-800 bg-red-900/40 p-3 text-sm text-red-300">{scanError}</div>
  {/if}
  {#if refreshed !== null}
    <div class="rounded-md border border-green-800 bg-green-900/40 p-3 text-sm text-green-300">
      Refreshed {refreshed} file(s) successfully.
    </div>
  {/if}
  {#if scanned}
    <div class="rounded-md border border-sky-800 bg-sky-900/40 p-3 text-sm text-sky-300">
      Orphan scan complete.{data.orphans.length > 0 ? ` Found ${data.orphans.length} orphan(s).` : ' No orphans found.'}
    </div>
  {/if}

  <!-- ── Summary stats ────────────────────────────────────────────────────── -->
  <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
    <div class="card text-center">
      <p class="text-2xl font-bold text-slate-100">{data.totalFiles}</p>
      <p class="mt-1 text-xs text-slate-400">Total mirrors</p>
    </div>
    <div class="card text-center">
      <p class="text-2xl font-bold text-green-400">{data.activeCount}</p>
      <p class="mt-1 text-xs text-slate-400">Active</p>
    </div>
    <div class="card text-center">
      <p class="text-2xl font-bold {data.staleCount > 0 ? 'text-amber-400' : 'text-slate-500'}">{data.staleCount}</p>
      <p class="mt-1 text-xs text-slate-400">Stale</p>
    </div>
    <div class="card text-center">
      <p class="text-2xl font-bold {data.pendingCount > 0 ? 'text-sky-400' : 'text-slate-500'}">{data.pendingCount}</p>
      <p class="mt-1 text-xs text-slate-400">Pending</p>
    </div>
  </div>

  <!-- ── Stale files ───────────────────────────────────────────────────────── -->
  {#if data.staleFiles.length > 0}
    <div class="space-y-2">
      <h2 class="text-lg font-medium text-amber-400">
        Stale Mirrors <span class="text-sm font-normal text-slate-400">— source was upgraded, copy not yet refreshed</span>
      </h2>
      <div class="overflow-x-auto rounded-lg border border-slate-700">
        <table class="w-full text-sm">
          <thead class="border-b border-slate-700 bg-slate-800/50">
            <tr>
              <th class="px-4 py-2 text-left text-slate-300">Track</th>
              <th class="px-4 py-2 text-left text-slate-300">List</th>
              <th class="px-4 py-2 text-left text-slate-300">Mirror path</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-800">
            {#each data.staleFiles as f}
              <tr class="hover:bg-slate-800/30">
                <td class="px-4 py-2 text-slate-200">
                  {f.item_title}
                  <span class="ml-1 text-xs text-slate-500">{f.artist_name}</span>
                </td>
                <td class="px-4 py-2 text-slate-400">{f.list_name}</td>
                <td class="px-4 py-2 font-mono text-xs text-slate-500" title={f.mirror_path}>
                  {shortPath(f.mirror_path)}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}

  <!-- ── Pending files ─────────────────────────────────────────────────────── -->
  {#if data.pendingFiles.length > 0}
    <div class="space-y-2">
      <h2 class="text-lg font-medium text-sky-400">
        Pending Copies <span class="text-sm font-normal text-slate-400">— copy was attempted but not yet successful</span>
      </h2>
      <div class="overflow-x-auto rounded-lg border border-slate-700">
        <table class="w-full text-sm">
          <thead class="border-b border-slate-700 bg-slate-800/50">
            <tr>
              <th class="px-4 py-2 text-left text-slate-300">Track</th>
              <th class="px-4 py-2 text-left text-slate-300">List</th>
              <th class="px-4 py-2 text-left text-slate-300">Source path</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-800">
            {#each data.pendingFiles as f}
              <tr class="hover:bg-slate-800/30">
                <td class="px-4 py-2 text-slate-200">
                  {f.item_title}
                  <span class="ml-1 text-xs text-slate-500">{f.artist_name}</span>
                </td>
                <td class="px-4 py-2 text-slate-400">{f.list_name}</td>
                <td class="px-4 py-2 font-mono text-xs text-slate-500" title={f.source_path}>
                  {shortPath(f.source_path)}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}

  <!-- ── Orphan files ──────────────────────────────────────────────────────── -->
  <div class="space-y-2">
    <div class="flex items-baseline justify-between">
      <h2 class="text-lg font-medium text-slate-200">
        Orphan Files
        {#if data.orphans.length > 0}
          <span class="ml-2 rounded-full bg-amber-900/50 px-2 py-0.5 text-sm font-normal text-amber-300">
            {data.orphans.length}
          </span>
        {/if}
      </h2>
      {#if data.lastScan}
        <p class="text-xs text-slate-500">Last scan: {new Date(data.lastScan).toLocaleString()}</p>
      {:else}
        <p class="text-xs text-slate-500">No scan run yet — click Scan Now</p>
      {/if}
    </div>

    {#if data.orphans.length === 0}
      <div class="card text-sm text-slate-400">
        {#if data.lastScan}
          No orphan files found in the last scan.
        {:else}
          Run Scan Now to check for files in mirror folders with no corresponding database record.
        {/if}
      </div>
    {:else}
      <p class="text-sm text-slate-400">
        These files exist under a mirror root folder but have no matching record in the database.
        They may be left over from a deleted list item. Review before deleting manually.
      </p>
      <div class="overflow-x-auto rounded-lg border border-slate-700">
        <table class="w-full text-sm">
          <thead class="border-b border-slate-700 bg-slate-800/50">
            <tr>
              <th class="px-4 py-2 text-left text-slate-300">File path</th>
              <th class="px-4 py-2 text-left text-slate-300">Root folder</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-800">
            {#each data.orphans as o}
              <tr class="hover:bg-slate-800/30">
                <td class="px-4 py-2 font-mono text-xs text-slate-400" title={o.file_path}>
                  {shortPath(o.file_path, 80)}
                </td>
                <td class="px-4 py-2 font-mono text-xs text-slate-500" title={o.root_folder}>
                  {shortPath(o.root_folder)}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>

  <!-- ── Active mirrors (collapsed detail) ────────────────────────────────── -->
  {#if data.activeFiles.length > 0}
    <details class="group">
      <summary class="cursor-pointer select-none rounded-lg border border-slate-700 bg-slate-800/30 px-4 py-3 text-sm font-medium text-slate-300 hover:bg-slate-800/60">
        Active mirrors ({data.activeFiles.length}{data.activeFiles.length === 200 ? '+' : ''})
        <span class="ml-2 text-xs font-normal text-slate-500 group-open:hidden">— click to expand</span>
      </summary>
      <div class="mt-2 overflow-x-auto rounded-lg border border-slate-700">
        <table class="w-full text-sm">
          <thead class="border-b border-slate-700 bg-slate-800/50">
            <tr>
              <th class="px-4 py-2 text-left text-slate-300">Track</th>
              <th class="px-4 py-2 text-left text-slate-300">List</th>
              <th class="px-4 py-2 text-left text-slate-300">Mirror path</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-800">
            {#each data.activeFiles as f}
              <tr class="hover:bg-slate-800/30">
                <td class="px-4 py-2 text-slate-200">
                  {f.item_title}
                  <span class="ml-1 text-xs text-slate-500">{f.artist_name}</span>
                </td>
                <td class="px-4 py-2 text-slate-400">{f.list_name}</td>
                <td class="px-4 py-2 font-mono text-xs text-slate-500" title={f.mirror_path}>
                  {shortPath(f.mirror_path)}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </details>
  {/if}
</section>
