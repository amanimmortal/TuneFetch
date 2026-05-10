<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { enhance } from '$app/forms';

	export let data: PageData;
	export let form: ActionData;

	$: isAdmin = data.isAdmin;

	// Search form state
	let type = 'track';
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

	// Advanced filter state — defaults match Lidarr's metadata profile defaults
	let advancedOpen = false;
	let primaryAlbum = true;
	let primaryEP = true;
	let primarySingle = false;
	let primaryOther = false;
	let studioOnly = true;
	let officialOnly = true;

	$: filtersDiffer =
		!primaryAlbum || !primaryEP || primarySingle || primaryOther || !studioOnly || !officialOnly;

	// Bust the per-artist album cache whenever filters change
	$: {
		primaryAlbum; primaryEP; primarySingle; primaryOther; studioOnly; officialOnly;
		artistAlbums = {};
	}

	$: canSearch = !!(artistField.trim() || albumField.trim() || trackField.trim());
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

	function appendRgFilterParams(p: URLSearchParams) {
		const primary: string[] = [];
		if (primaryAlbum) primary.push('Album');
		if (primaryEP) primary.push('EP');
		if (primarySingle) primary.push('Single');
		if (primaryOther) primary.push('Other');
		p.set('primaryTypes', primary.join(','));
		p.set('studioOnly', studioOnly ? '1' : '0');
		p.set('officialOnly', officialOnly ? '1' : '0');
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
			if (type === 'album') appendRgFilterParams(params);

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
			const p = new URLSearchParams();
			appendRgFilterParams(p);
			const res = await fetch(`/api/browse/artist/${artistMbid}?${p.toString()}`);
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

	function listMembershipIds(memberships: any[] | undefined): Set<number> {
		const ids = new Set<number>();
		for (const lm of memberships ?? []) ids.add(lm.listId ?? lm.list_id);
		return ids;
	}
</script>

<svelte:head>
  <title>Search · TuneFetch</title>
</svelte:head>

<section class="space-y-6">
  <header>
    <h1 class="text-2xl font-semibold tracking-tight">Search</h1>
    <p class="mt-1 text-sm text-slate-400">
      {#if isAdmin}
        Find artists, albums, and tracks on MusicBrainz and add them to a list.
      {:else}
        Search for songs and artists to add to your playlists.
      {/if}
    </p>
  </header>

  {#if form?.success}
    <div class="rounded-md bg-green-900/50 p-4 text-green-300 border border-green-800">
      Added to playlist!
    </div>
  {/if}
  {#if form?.error}
    <div class="rounded-md bg-red-900/50 p-4 text-red-300 border border-red-800">
      {form.error}
    </div>
  {/if}

  <!-- Search Form -->
  <form class="card space-y-4" on:submit|preventDefault={performSearch}>
    {#if isAdmin}
      <!-- Type selector (admin only) -->
      <div class="flex gap-4 flex-wrap">
        {#each ['artist', 'album', 'track'] as t}
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="type" value={t} bind:group={type} on:change={onTypeChange} class="accent-sky-500" />
            <span class="text-sm font-medium capitalize text-slate-200">{t}</span>
          </label>
        {/each}
      </div>
    {/if}

    <!-- Contextual fields -->
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {#if type === 'artist'}
        <div class="sm:col-span-2 lg:col-span-3">
          <label for="field-artist" class="block text-xs text-slate-400 mb-1">Artist name</label>
          <input id="field-artist" type="text" class="input w-full text-base" placeholder="e.g. Radiohead" bind:value={artistField} />
        </div>
      {/if}
      {#if type === 'album'}
        <div>
          <label for="field-album" class="block text-xs text-slate-400 mb-1">Album title</label>
          <input id="field-album" type="text" class="input w-full text-base" placeholder="e.g. OK Computer" bind:value={albumField} />
        </div>
        <div>
          <label for="field-artist-album" class="block text-xs text-slate-400 mb-1">Artist <span class="text-slate-500">(optional)</span></label>
          <input id="field-artist-album" type="text" class="input w-full text-base" placeholder="e.g. Radiohead" bind:value={artistField} />
        </div>
      {/if}
      {#if type === 'track'}
        <div>
          <label for="field-track" class="block text-xs text-slate-400 mb-1">
            {isAdmin ? 'Track title' : 'Song title'}
          </label>
          <input id="field-track" type="text" class="input w-full text-base" placeholder={isAdmin ? 'e.g. Karma Police' : 'e.g. Let It Go'} bind:value={trackField} />
        </div>
        <div>
          <label for="field-artist-track" class="block text-xs text-slate-400 mb-1">Artist <span class="text-slate-500">(optional)</span></label>
          <input id="field-artist-track" type="text" class="input w-full text-base" placeholder="e.g. Radiohead" bind:value={artistField} />
        </div>
        {#if isAdmin}
          <div>
            <label for="field-album-track" class="block text-xs text-slate-400 mb-1">Album <span class="text-slate-500">(optional)</span></label>
            <input id="field-album-track" type="text" class="input w-full text-base" placeholder="e.g. OK Computer" bind:value={albumField} />
          </div>
        {/if}
      {/if}
    </div>

    <!-- Advanced filters (admin only, album + artist types) -->
    {#if isAdmin && (type === 'album' || type === 'artist')}
      <div class="border-t border-slate-800 pt-3">
        <button
          type="button"
          class="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1"
          on:click={() => (advancedOpen = !advancedOpen)}
        >
          <span>{advancedOpen ? '▾' : '▸'}</span>
          Advanced filters
          {#if filtersDiffer && !advancedOpen}
            <span class="badge bg-amber-900/40 text-amber-300 border border-amber-800 ml-1">customised</span>
          {/if}
        </button>

        {#if advancedOpen}
          <div class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
            <fieldset class="space-y-1">
              <legend class="text-xs text-slate-400 mb-1">Primary type</legend>
              <label class="flex items-center gap-2"><input type="checkbox" bind:checked={primaryAlbum}  class="accent-sky-500" /> Album</label>
              <label class="flex items-center gap-2"><input type="checkbox" bind:checked={primaryEP}     class="accent-sky-500" /> EP</label>
              <label class="flex items-center gap-2"><input type="checkbox" bind:checked={primarySingle} class="accent-sky-500" /> Single</label>
              <label class="flex items-center gap-2"><input type="checkbox" bind:checked={primaryOther}  class="accent-sky-500" /> Other</label>
            </fieldset>
            <fieldset class="space-y-1">
              <legend class="text-xs text-slate-400 mb-1">Secondary type</legend>
              <label class="flex items-center gap-2">
                <input type="checkbox" bind:checked={studioOnly} class="accent-sky-500" />
                Studio only (exclude live, comps, soundtracks, remixes, …)
              </label>
            </fieldset>
            <fieldset class="space-y-1">
              <legend class="text-xs text-slate-400 mb-1">Release status</legend>
              <label class="flex items-center gap-2">
                <input type="checkbox" bind:checked={officialOnly} class="accent-sky-500" />
                Official only
              </label>
              <p class="text-xs text-slate-600">Note: not enforced on artist drill-down (MB browse limitation).</p>
            </fieldset>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Sort + Submit -->
    <div class="flex flex-wrap gap-3 items-end pt-1">
      {#if isAdmin}
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
      {/if}
      <button type="submit" class="btn-primary h-11 px-4 text-base" disabled={searching || !canSearch}>
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
        {@const memberIds = listMembershipIds(r.listMemberships)}
        <div class="card flex flex-col gap-3 justify-between">
          <div>
            <div class="flex items-start justify-between gap-2">
              <h3 class="font-semibold text-slate-100">{r.title}</h3>
              {#if isAdmin}
                <span class="badge bg-slate-800 text-slate-300 ml-2 mt-0.5 whitespace-nowrap capitalize">{r.type}</span>
              {/if}
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
              {#if isAdmin && r.inLidarr}
                <span class="badge bg-purple-900/50 text-purple-300 border border-purple-800">In Lidarr</span>
              {/if}
              {#each r.listMemberships as lm}
                <span class="badge bg-sky-900/50 text-sky-300 border border-sky-800">
                  {isAdmin ? `In: ${lm.listName}` : `✓ In ${lm.listName}`}
                </span>
              {/each}
            </div>
          </div>

          <!-- Actions -->
          <div class="flex flex-wrap items-center gap-2 mt-2 pt-3 border-t border-slate-800">
            {#if data.lists.length === 0}
              <span class="text-sm text-slate-500 italic flex-1">No playlists exist.</span>
            {:else if isAdmin}
              <form method="POST" action="?/addToList" use:enhance={() => async ({ update }) => update({ reset: false })} class="flex items-center gap-2 flex-1 min-w-0">
                <input type="hidden" name="mbid" value={r.mbid} />
                <input type="hidden" name="type" value={r.type} />
                <input type="hidden" name="title" value={r.title} />
                <input type="hidden" name="artistName" value={r.artist} />
                <input type="hidden" name="albumName" value={r.album || ''} />
                <input type="hidden" name="artistMbid" value={r.artistMbid || ''} />
                <select name="listId" class="input flex-1 px-2 py-1 text-sm h-9 min-w-0" required>
                  <option value="" disabled selected>Select list…</option>
                  {#each data.lists as list}
                    <option value={list.id}>{list.name}</option>
                  {/each}
                </select>
                <button type="submit" class="btn-secondary h-9 py-1 text-sm whitespace-nowrap shrink-0">Add</button>
              </form>
            {:else}
              <!-- Simple mode: one button per playlist -->
              <div class="flex flex-wrap items-center gap-2 flex-1 min-w-0">
                {#each data.lists as list}
                  {@const inList = memberIds.has(list.id)}
                  <form method="POST" action="?/addToList" use:enhance={() => async ({ update }) => update({ reset: false })}>
                    <input type="hidden" name="mbid" value={r.mbid} />
                    <input type="hidden" name="type" value={r.type} />
                    <input type="hidden" name="title" value={r.title} />
                    <input type="hidden" name="artistName" value={r.artist} />
                    <input type="hidden" name="albumName" value={r.album || ''} />
                    <input type="hidden" name="artistMbid" value={r.artistMbid || ''} />
                    <input type="hidden" name="listId" value={list.id} />
                    <button
                      type="submit"
                      class="btn-primary h-11 px-4 text-base whitespace-nowrap disabled:opacity-50"
                      disabled={inList}
                    >
                      {inList ? `✓ In ${list.name}` : `+ Add to ${list.name}`}
                    </button>
                  </form>
                {/each}
              </div>
            {/if}
            {#if r.type === 'artist'}
              <button type="button" class="btn-secondary h-11 px-4 text-base whitespace-nowrap shrink-0"
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
                    {@const albumMemberIds = listMembershipIds(album.listMemberships)}
                    <div class="rounded bg-slate-800/60 px-3 py-2 space-y-2">
                      <div class="flex items-start justify-between gap-2 flex-wrap">
                        <div class="min-w-0">
                          <p class="text-sm font-medium text-slate-100 truncate">{album.title}</p>
                          <p class="text-xs text-slate-500">{album.type}{album.year ? ' · ' + album.year : ''}</p>
                          {#each (album.listMemberships ?? []) as lm}
                            <span class="badge bg-sky-900/50 text-sky-300 border border-sky-800 text-xs mr-1">
                              {isAdmin ? `In: ${lm.listName}` : `✓ In ${lm.listName}`}
                            </span>
                          {/each}
                        </div>
                        <div class="flex flex-wrap gap-2 shrink-0">
                          {#if data.lists.length > 0 && isAdmin}
                            <form method="POST" action="?/addToList" use:enhance={() => async ({ update }) => update({ reset: false })} class="flex items-center gap-1">
                              <input type="hidden" name="mbid" value={album.mbid} />
                              <input type="hidden" name="type" value="album" />
                              <input type="hidden" name="title" value={album.title} />
                              <input type="hidden" name="artistName" value={r.title} />
                              <input type="hidden" name="albumName" value={album.title} />
                              <input type="hidden" name="artistMbid" value={r.mbid} />
                              <select name="listId" class="input px-2 py-1 text-sm h-11" required>
                                <option value="" disabled selected>List…</option>
                                {#each data.lists as list}
                                  <option value={list.id}>{list.name}</option>
                                {/each}
                              </select>
                              <button type="submit" class="btn-secondary h-11 px-3 text-sm">Add</button>
                            </form>
                          {:else if data.lists.length > 0}
                            {#each data.lists as list}
                              {@const inList = albumMemberIds.has(list.id)}
                              <form method="POST" action="?/addToList" use:enhance={() => async ({ update }) => update({ reset: false })}>
                                <input type="hidden" name="mbid" value={album.mbid} />
                                <input type="hidden" name="type" value="album" />
                                <input type="hidden" name="title" value={album.title} />
                                <input type="hidden" name="artistName" value={r.title} />
                                <input type="hidden" name="albumName" value={album.title} />
                                <input type="hidden" name="artistMbid" value={r.mbid} />
                                <input type="hidden" name="listId" value={list.id} />
                                <button
                                  type="submit"
                                  class="btn-primary h-11 px-3 text-sm whitespace-nowrap disabled:opacity-50"
                                  disabled={inList}
                                >
                                  {inList ? `✓ ${list.name}` : `+ ${list.name}`}
                                </button>
                              </form>
                            {/each}
                          {/if}
                          <button type="button" class="btn-secondary h-11 px-3 text-sm whitespace-nowrap"
                            on:click={() => toggleAlbumTracks(album.mbid, r.title, r.mbid, album.title)}>
                            {expandedAlbumMbid === album.mbid ? 'Hide' : 'Tracks'}
                          </button>
                        </div>
                      </div>

                      <!-- Album → Tracks drill-down -->
                      {#if expandedAlbumMbid === album.mbid}
                        <div class="pt-2 border-t border-slate-700 space-y-2">
                          {#if albumTracksLoading[album.mbid]}
                            <p class="text-xs text-slate-400 animate-pulse">Loading tracks…</p>
                          {:else if albumTracksError[album.mbid]}
                            <p class="text-xs text-red-400">{albumTracksError[album.mbid]}</p>
                          {:else if (albumTracks[album.mbid] ?? []).length === 0}
                            <p class="text-xs text-slate-500">No tracks found.</p>
                          {:else}
                            {#each (albumTracks[album.mbid] ?? []) as track, idx}
                              {@const trackMemberIds = listMembershipIds(track.listMemberships)}
                              <div class="flex items-start justify-between gap-2 py-2 flex-wrap">
                                <div class="min-w-0 flex items-start gap-2 flex-1">
                                  <span class="text-xs text-slate-600 w-5 text-right shrink-0 mt-1">{idx + 1}</span>
                                  <div class="min-w-0">
                                    <p class="text-sm text-slate-200 truncate">{track.title}</p>
                                    {#if track.durationMs}
                                      <p class="text-xs text-slate-600">{formatDuration(track.durationMs)}</p>
                                    {/if}
                                    {#each (track.listMemberships ?? []) as lm}
                                      <span class="badge bg-sky-900/50 text-sky-300 border border-sky-800 text-xs mr-1">
                                        {isAdmin ? `In: ${lm.listName}` : `✓ In ${lm.listName}`}
                                      </span>
                                    {/each}
                                  </div>
                                </div>
                                {#if data.lists.length > 0 && isAdmin}
                                  <form method="POST" action="?/addToList" use:enhance={() => async ({ update }) => update({ reset: false })} class="flex items-center gap-1 shrink-0">
                                    <input type="hidden" name="mbid" value={track.mbid} />
                                    <input type="hidden" name="type" value="track" />
                                    <input type="hidden" name="title" value={track.title} />
                                    <input type="hidden" name="artistName" value={track.artist} />
                                    <input type="hidden" name="albumName" value={album.title} />
                                    <input type="hidden" name="artistMbid" value={track.artistMbid || r.mbid} />
                                    <select name="listId" class="input px-2 py-1 text-sm h-11" required>
                                      <option value="" disabled selected>List…</option>
                                      {#each data.lists as list}
                                        <option value={list.id}>{list.name}</option>
                                      {/each}
                                    </select>
                                    <button type="submit" class="btn-secondary h-11 px-3 text-sm">Add</button>
                                  </form>
                                {:else if data.lists.length > 0}
                                  <div class="flex flex-wrap gap-2 shrink-0">
                                    {#each data.lists as list}
                                      {@const inList = trackMemberIds.has(list.id)}
                                      <form method="POST" action="?/addToList" use:enhance={() => async ({ update }) => update({ reset: false })}>
                                        <input type="hidden" name="mbid" value={track.mbid} />
                                        <input type="hidden" name="type" value="track" />
                                        <input type="hidden" name="title" value={track.title} />
                                        <input type="hidden" name="artistName" value={track.artist} />
                                        <input type="hidden" name="albumName" value={album.title} />
                                        <input type="hidden" name="artistMbid" value={track.artistMbid || r.mbid} />
                                        <input type="hidden" name="listId" value={list.id} />
                                        <button
                                          type="submit"
                                          class="btn-primary h-11 px-3 text-sm whitespace-nowrap disabled:opacity-50"
                                          disabled={inList}
                                        >
                                          {inList ? `✓ ${list.name}` : `+ ${list.name}`}
                                        </button>
                                      </form>
                                    {/each}
                                  </div>
                                {/if}
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
