<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';

	export let data: PageData;
	export let form: ActionData;

	// Search form state
	let type = 'artist';
	let artistField = '';
	let albumField = '';
	let trackField = '';
	let sortBy = 'relevance';

	let searching = false;
	let results: any[] = [];
	let searchError: string | null = null;
	let didInitialSearch = false;

	// Drill-down state
	let expandedArtistMbid: string | null = null;
	let artistAlbums: Record<string, any[]> = {};
	let artistAlbumsLoading: Record<string, boolean> = {};
	let artistAlbumsError: Record<string, string | null> = {};

	let expandedAlbumMbid: string | null = null;
	let albumTracks: Record<string, any[]> = {};
	let albumTracksLoading: Record<string, boolean> = {};
	let albumTracksError: Record<string, string | null> = {};

	$: sortedResults = sortResults(results, sortBy);

	function sortResults(items: any[], sort: string): any[] {
		const copy = [...items];
		switch (sort) {
			case 'title-asc': return copy.sort((a, b) => a.title.localeCompare(b.title));
			case 'title-desc': return copy.sort((a, b) => b.title.localeCompare(a.title));
			case 'artist-asc': return copy.sort((a, b) => (a.artist ?? '').localeCompare(b.artist ?? ''));
			case 'year-desc': return copy.sort((a, b) => (b.year ?? '').localeCompare(a.year ?? ''));
			default: return copy;
		}
	}

	function formatDuration(ms: number | null): string {
		if (!ms) return '';
		const totalSec = Math.round(ms / 1000);
		const m = Math.floor(totalSec / 60);
		const s = totalSec % 60;
		return `${m}:${s.toString().padStart(2, '0')}`;
	}

	function hasAnyField(): boolean {
		return !!(artistField.trim() || albumField.trim() || trackField.trim());
	}

	async function performSearch() {
		if (!hasAnyField()) return;
		searching = true;
		searchError = null;
		results = [];
		didInitialSearch = true;
		expandedArtistMbid = null;
		expandedAlbumMbid = null;

		try {
			const params = new URLSearchParams({ type });
			if (artistField.trim()) params.set('artist', artistField.trim());
			if (albumField.trim()) params.set('album', albumField.trim());
			if (trackField.trim()) params.set('track', trackField.trim());

			const res = await fetch(`/api/search?${params.toString()}`);
			const json = await res.json();
			if (json.error) {
				searchError = json.error;
			} else {
				results = json.results || [];
			}
		} catch {
			searchError = 'Failed to load search results.';
		} finally {
			searching = false;
		}
	}

	async function toggleArtistAlbums(artistMbid: string) {
		if (expandedArtistMbid === artistMbid) {
			expandedArtistMbid = null;
			return;
		}
		expandedArtistMbid = artistMbid;
		expandedAlbumMbid = null;

		if (artistAlbums[artistMbid]) return;

		artistAlbumsLoading[artistMbid] = true;
		artistAlbumsError[artistMbid] = null;
		try {
			const res = await fetch(`/api/browse/artist/${artistMbid}`);
			const json = await res.json();
			if (json.error) {
				artistAlbumsError[artistMbid] = json.error;
			} else {
				artistAlbums[artistMbid] = json.results ?? [];
			}
		} catch {
			artistAlbumsError[artistMbid] = 'Failed to load albums.';
		} finally {
			artistAlbumsLoading[artistMbid] = false;
			artistAlbums = artistAlbums;
		}
	}

	async function toggleAlbumTracks(rgMbid: string, artistName: string, artistMbid: string, albumTitle: string) {
		if (expandedAlbumMbid === rgMbid) {
			expandedAlbumMbid = null;
			return;
		}
		expandedAlbumMbid = rgMbid;

		if (albumTracks[rgMbid]) return;

		albumTracksLoading[rgMbid] = true;
		albumTracksError[rgMbid] = null;
		try {
			const p = new URLSearchParams({ artistName, artistMbid, albumTitle });
			const res = await fetch(`/api/browse/release-group/${rgMbid}?${p.toString()}`);
			const json = await res.json();
			if (json.error) {
				albumTracksError[rgMbid] = json.error;
			} else {
				albumTracks[rgMbid] = json.results ?? [];
			}
		} catch {
			albumTracksError[rgMbid] = 'Failed to load tracks.';
		} finally {
			albumTracksLoading[rgMbid] = false;
			albumTracks = albumTracks;
		}
	}

	function onTypeChange() {
		results = [];
		didInitialSearch = false;
		searchError = null;
		expandedArtistMbid = null;
		expandedAlbumMbid = null;
		albumField = '';
		trackField = '';
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

  <!-- Search Form -->
  <form class="card space-y-4" on:submit|preventDefault={performSearch}>
    <!-- Type selector -->
    <div class="flex gap-4 flex-wrap">
      {#each ['artist', 'album', 'track'] as t}
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="radio" name="type" value={t} bind:group={type} on:change={onTypeChange} class="accent-sky-500" />
          <span class="text-sm font-medium capitalize text-slate-200">{t}</span>
        </label>
      {/each}
    </div>

    <!-- Contextual fields -->
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {#if type === 'artist'}
        <div class="sm:col-span-2 lg:col-span-3">
          <label for="field-artist" class="block text-xs text-slate-400 mb-1">Artist name</label>
          <input id="field-artist" type="text" class="input w-full" placeholder="e.g. Radiohead" bind:value={artistField} />
        </div>
      {/if}
      {#if type === 'album'}
        <div>
          <label for="field-album" class="block text-xs text-slate-400 mb-1">Album title</label>
          <input id="field-album" type="text" class="input w-full" placeholder="e.g. OK Computer" bind:value={albumField} />
        </div>
        <div>
          <label for="field-artist-album" class="block text-xs text-slate-400 mb-1">Artist <span class="text-slate-500">(optional)</span></label>
          <input id="field-artist-album" type="text" class="input w-full" placeholder="e.g. Radiohead" bind:value={artistField} />
        </div>
      {/if}
      {#if type === 'track'}
        <div>
          <label for="field-track" class="block text-xs text-slate-400 mb-1">Track title</label>
          <input id="field-track" type="text" class="input w-full" placeholder="e.g. Karma Police" bind:value={trackField} />
        </div>
        <div>
          <label for="field-artist-track" class="block text-xs text-slate-400 mb-1">Artist <span class="text-slate-500">(optional)</span></label>
          <input id="field-artist-track" type="text" class="input w-full" placeholder="e.g. Radiohead" bind:value={artistField} />
        </div>
        <div>
          <label for="field-album-track" class="block text-xs text-slate-400 mb-1">Album <span class="text-slate-500">(optional)</span></label>
          <input id="field-album-track" type="text" class="input w-full" placeholder="e.g. OK Computer" bind:value={albumField} />
        </div>
      {/if}
    </div>

    <!-- Sort + Submit -->
    <div class="flex flex-wrap gap-3 items-end pt-1">
      <div>
        <label for="sort-by" class="block text-xs text-slate-400 mb-1">Sort by</label>
        <select id="sort-by" class="input sm:w-44" bind:value={sortBy}>
          <option value="relevance">Relevance</option>
          <option value="title-asc">Title A→Z</option>
          <option value="title-desc">Title Z→A</option>
          <option value="artist-asc">Artist A→Z</option>
          {#if type === 'album'}
            <option value="year-desc">Year (newest first)</option>
          {/if}
        </select>
      </div>
      <button type="submit" class="btn-primary h-9 py-1" disabled={searching || !hasAnyField()}>
        {searching ? 'Searching…' : 'Search'}
      </button>
    </div>
  </form>

  {#if searchError}
    <div class="text-red-400 text-sm">{searchError}</div>
  {/if}

  {#if didInitialSearch && !searching}
    <p class="text-xs text-slate-500">
      {sortedResults.length > 0
        ? `${sortedResults.length} result${sortedResults.length !== 1 ? 's' : ''}`
        : 'No results found.'}
    </p>
  {/if}

  <!-- Results -->
  {#if sortedResults.length > 0}
    <div class="grid gap-4 md:grid-cols-2">
      {#each sortedResults as r}
        <div class="card flex flex-col gap-3 justify-between">
          <div>
            <div class="flex items-start justify-between gap-2">
              <h3 class="font-semibold text-slate-100">{r.title}</h3>
              <span class="badge bg-slate-800 text-slate-300 ml-2 mt-0.5 whitespace-nowrap capitalize">{r.type}</span>
            </div>
            {#if r.type !== 'artist'}
              <p class="text-sm text-slate-400 mt-1">{r.artist}</p>
            {/if}
            <div class="flex items-center gap-3 mt-0.5">
              {#if r.type === 'track' && r.album}
                <p class="text-xs text-slate-500">{r.album}</p>
              {/if}
              {#if r.type === 'track' && r.durationMs}
                <p class="text-xs text-slate-600">{formatDuration(r.durationMs)}</p>
              {/if}
              {#if r.type === 'album' && r.year}
                <p class="text-xs text-slate-500">{r.year}</p>
              {/if}
            </div>
            <div class="flex flex-wrap gap-2 mt-3">
              {#if r.inLidarr}
                <span class="badge bg-purple-900/50 text-purple-300 border border-purple-800">In Lidarr</span>
              {/if}
              {#each r.listMemberships as lm}
                <span class="badge bg-sky-900/50 text-sky-300 border border-sky-800">In: {lm.listName}</span>
              {/each}
            </div>
          </div>

          <!-- Actions -->
          <div class="flex flex-wrap items-center gap-2 mt-2 pt-3 border-t border-slate-800">
            <form method="POST" action="?/addToList" use:enhance class="flex items-center gap-2 flex-1 min-w-0">
              <input type="hidden" name="mbid" value={r.mbid} />
              <input type="hidden" name="type" value={r.type} />
              <input type="hidden" name="title" value={r.title} />
              <input type="hidden" name="artistName" value={r.artist} />
              <input type="hidden" name="albumName" value={r.album || ''} />
              <input type="hidden" name="artistMbid" value={r.artistMbid || ''} />
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
            {#if r.type === 'artist'}
              <button type="button" class="btn-secondary h-9 py-1 text-sm whitespace-nowrap shrink-0"
                on:click={() => toggleArtistAlbums(r.mbid)}>
                {expandedArtistMbid === r.mbid ? 'Hide albums' : 'Browse albums'}
              </button>
            {/if}
          </div>

          <!-- Artist → Albums drill-down -->
          {#if r.type === 'artist' && expandedArtistMbid === r.mbid}
            <div class="mt-1 pt-3 border-t border-slate-700 space-y-2">
              {#if artistAlbumsLoading[r.mbid]}
                <p class="text-xs text-slate-400 animate-pulse">Loading albums…</p>
              {:else if artistAlbumsError[r.mbid]}
                <p class="text-xs text-red-400">{artistAlbumsError[r.mbid]}</p>
              {:else if (artistAlbums[r.mbid] ?? []).length === 0}
                <p class="text-xs text-slate-500">No releases found.</p>
              {:else}
                <p class="text-xs text-slate-500 font-medium uppercase tracking-wide">Releases</p>
                <div class="space-y-2">
                  {#each (artistAlbums[r.mbid] ?? []) as album}
                    <div class="rounded bg-slate-800/60 px-3 py-2 space-y-2">
                      <div class="flex items-start justify-between gap-2">
                        <div class="min-w-0">
                          <p class="text-sm font-medium text-slate-100 truncate">{album.title}</p>
                          <p class="text-xs text-slate-500">{album.type}{album.year ? ' · ' + album.year : ''}</p>
                          {#each (album.listMemberships ?? []) as lm}
                            <span class="badge bg-sky-900/50 text-sky-300 border border-sky-800 text-xs mr-1">In: {lm.listName}</span>
                          {/each}
                        </div>
                        <div class="flex gap-2 shrink-0">
                          <form method="POST" action="?/addToList" use:enhance class="flex items-center gap-1">
                            <input type="hidden" name="mbid" value={album.mbid} />
                            <input type="hidden" name="type" value="album" />
                            <input type="hidden" name="title" value={album.title} />
                            <input type="hidden" name="artistName" value={r.title} />
                            <input type="hidden" name="albumName" value={album.title} />
                            <input type="hidden" name="artistMbid" value={r.mbid} />
                            {#if data.lists.length > 0}
                              <select name="listId" class="input px-1.5 py-1 text-xs h-7" required>
                                <option value="" disabled selected>List…</option>
                                {#each data.lists as list}
                                  <option value={list.id}>{list.name}</option>
                                {/each}
                              </select>
                              <button type="submit" class="btn-secondary h-7 px-2 text-xs">Add</button>
                            {/if}
                          </form>
                          <button type="button" class="btn-secondary h-7 px-2 text-xs whitespace-nowrap"
                            on:click={() => toggleAlbumTracks(album.mbid, r.title, r.mbid, album.title)}>
                            {expandedAlbumMbid === album.mbid ? 'Hide' : 'Tracks'}
                          </button>
                        </div>
                      </div>

                      <!-- Album → Tracks drill-down -->
                      {#if expandedAlbumMbid === album.mbid}
                        <div class="pt-2 border-t border-slate-700 space-y-1">
                          {#if albumTracksLoading[album.mbid]}
                            <p class="text-xs text-slate-400 animate-pulse">Loading tracks…</p>
                          {:else if albumTracksError[album.mbid]}
                            <p class="text-xs text-red-400">{albumTracksError[album.mbid]}</p>
                          {:else if (albumTracks[album.mbid] ?? []).length === 0}
                            <p class="text-xs text-slate-500">No tracks found.</p>
                          {:else}
                            {#each (albumTracks[album.mbid] ?? []) as track, idx}
                              <div class="flex items-center justify-between gap-2 py-1">
                                <div class="min-w-0 flex items-center gap-2">
                                  <span class="text-xs text-slate-600 w-5 text-right shrink-0">{idx + 1}</span>
                                  <div class="min-w-0">
                                    <p class="text-xs text-slate-200 truncate">{track.title}</p>
                                    {#if track.durationMs}
                                      <p class="text-xs text-slate-600">{formatDuration(track.durationMs)}</p>
                                    {/if}
                                    {#each (track.listMemberships ?? []) as lm}
                                      <span class="badge bg-sky-900/50 text-sky-300 border border-sky-800 text-xs mr-1">In: {lm.listName}</span>
                                    {/each}
                                  </div>
                                </div>
                                <form method="POST" action="?/addToList" use:enhance class="flex items-center gap-1 shrink-0">
                                  <input type="hidden" name="mbid" value={track.mbid} />
                                  <input type="hidden" name="type" value="track" />
                                  <input type="hidden" name="title" value={track.title} />
                                  <input type="hidden" name="artistName" value={track.artist} />
                                  <input type="hidden" name="albumName" value={album.title} />
                                  <input type="hidden" name="artistMbid" value={track.artistMbid || r.mbid} />
                                  {#if data.lists.length > 0}
                                    <select name="listId" class="input px-1.5 py-0.5 text-xs h-6" required>
                                      <option value="" disabled selected>List…</option>
                                      {#each data.lists as list}
                                        <option value={list.id}>{list.name}</option>
                                      {/each}
                                    </select>
                                    <button type="submit" class="btn-secondary h-6 px-2 text-xs">Add</button>
                                  {/if}
                                </form>
                              </div>
                            {/each}
                          {/if}
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}

        </div>
      {/each}
    </div>
  {/if}
</section>
