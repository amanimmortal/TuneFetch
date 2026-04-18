<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';

	export let data: PageData;
	export let form: ActionData;

	let q = '';
	let type = 'artist';

	let searching = false;
	let results: any[] = [];
	let searchError: string | null = null;
    let didInitialSearch = false;

	async function performSearch() {
		if (!q.trim()) return;
		searching = true;
		searchError = null;
		results = [];
        didInitialSearch = true;

		try {
			const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&type=${encodeURIComponent(type)}`);
			const json = await res.json();
			if (json.error) {
				searchError = json.error;
			} else {
				results = json.results || [];
			}
		} catch (err) {
			searchError = 'Failed to load search results.';
		} finally {
			searching = false;
		}
	}
</script>

<svelte:head>
  <title>Search · TuneFetch</title>
</svelte:head>

<section class="space-y-6">
  <header>
    <h1 class="text-2xl font-semibold tracking-tight">Search</h1>
    <p class="mt-1 text-sm text-slate-400">
      Find artists, albums, and tracks on MusicBrainz and add them to a list.
    </p>
  </header>

  {#if form?.success}
    <div class="rounded-md bg-green-900/50 p-4 text-green-300 border border-green-800">
        Item added to list successfully!
    </div>
  {/if}
  {#if form?.error}
    <div class="rounded-md bg-red-900/50 p-4 text-red-300 border border-red-800">
        {form.error}
    </div>
  {/if}

  <form class="card flex flex-col sm:flex-row gap-4" on:submit|preventDefault={performSearch}>
    <input type="text" class="input flex-1" placeholder="Search MusicBrainz..." bind:value={q} required />
    <select class="input sm:w-48" bind:value={type}>
        <option value="artist">Artist</option>
        <option value="album">Album</option>
        <option value="track">Track</option>
    </select>
    <button type="submit" class="btn-primary" disabled={searching}>
        {searching ? 'Wait...' : 'Search'}
    </button>
  </form>

  {#if searchError}
    <div class="text-red-400">{searchError}</div>
  {/if}

  {#if results.length > 0}
    <div class="grid gap-4 md:grid-cols-2">
      {#each results as r}
        <div class="card flex flex-col gap-3 justify-between">
           <div>
             <div class="flex items-start justify-between gap-2">
               <h3 class="font-semibold text-slate-100">{r.title}</h3>
               <span class="badge bg-slate-800 text-slate-300 ml-2 mt-0.5 whitespace-nowrap capitalize">{r.type}</span>
             </div>
             {#if r.type !== 'artist'}
                <p class="text-sm text-slate-400 mt-1">{r.artist}</p>
             {/if}
             {#if r.type === 'track' && r.album}
                <p class="text-xs text-slate-500">{r.album}</p>
             {/if}

             <div class="flex flex-wrap gap-2 mt-3">
                 {#if r.inLidarr}
                    <span class="badge bg-purple-900/50 text-purple-300 border border-purple-800">In Lidarr</span>
                 {/if}
                 {#each r.listMemberships as lm}
                    <span class="badge bg-sky-900/50 text-sky-300 border border-sky-800">In: {lm.listName}</span>
                 {/each}
             </div>
           </div>

           <form method="POST" action="?/addToList" use:enhance class="flex items-center gap-2 mt-2 pt-3 border-t border-slate-800">
               <input type="hidden" name="mbid" value={r.mbid} />
               <input type="hidden" name="type" value={r.type} />
               <input type="hidden" name="title" value={r.title} />
               <input type="hidden" name="artistName" value={r.artist} />
               <input type="hidden" name="albumName" value={r.album || ''} />

               {#if data.lists.length === 0}
                  <span class="text-sm text-slate-500 italic flex-1">No lists exist to add to.</span>
               {:else}
                  <select name="listId" class="input flex-1 px-2 py-1 text-sm h-9" required>
                      <option value="" disabled selected>Select list...</option>
                      {#each data.lists as list}
                          <option value={list.id}>{list.name}</option>
                      {/each}
                  </select>
                  <button type="submit" class="btn-secondary h-9 py-1 text-sm whitespace-nowrap">Add to list</button>
               {/if}
           </form>
        </div>
      {/each}
    </div>
  {:else if didInitialSearch && !searching}
    <p class="text-slate-400">No results found.</p>
  {/if}
</section>
