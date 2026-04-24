<script lang="ts">
  import type { PageData } from './$types';
  import { invalidateAll } from '$app/navigation';

  export let data: PageData;

  // ── Form state ──────────────────────────────────────────────────────
  let selectedRootPath = '';
  let userName = '';
  let userToken = '';
  let librarySectionId = '';
  let saving = false;
  let fetchingUsers = false;
  let fetchingSections = false;
  let errorMessage = '';
  let successMessage = '';
  let deletingId: number | null = null;

  // Plex managed users fetched from plex.tv
  let plexUsers: Array<{ id: number; title: string; accessToken: string }> = [];
  let selectedPlexUserId = '';

  // Plex library sections fetched from the server
  let plexSections: Array<{ key: string; title: string; type: string }> = [];
  let selectedSectionKey = '';

  async function fetchPlexUsers() {
    if (!data.plexConfigured) {
      errorMessage = 'Plex is not configured. Set URL and token in Settings first.';
      return;
    }
    fetchingUsers = true;
    errorMessage = '';
    try {
      const res = await fetch('/api/plex?action=users');
      const result = await res.json();
      if (result.ok) {
        plexUsers = result.users;
        const failures: Array<{ title: string; reason: string }> = result.failures ?? [];
        if (plexUsers.length === 0 && failures.length > 0) {
          errorMessage =
            `Found ${failures.length} Plex user(s) but could not retrieve tokens. ` +
            failures.map((f) => `${f.title}: ${f.reason}`).join(' | ');
        } else if (plexUsers.length === 0) {
          errorMessage = 'No managed users found on this Plex server.';
        } else if (failures.length > 0) {
          errorMessage =
            `Loaded ${plexUsers.length} user(s). Could not retrieve tokens for: ` +
            failures.map((f) => f.title).join(', ');
        }
      } else {
        errorMessage = result.error ?? 'Failed to fetch Plex users';
      }
    } catch {
      errorMessage = 'Network error fetching Plex users';
    } finally {
      fetchingUsers = false;
    }
  }

  async function fetchSections() {
    fetchingSections = true;
    errorMessage = '';
    try {
      const res = await fetch('/api/plex?action=sections');
      const result = await res.json();
      if (result.ok) {
        // Only show music libraries
        plexSections = result.sections.filter(
          (s: { type: string }) => s.type === 'artist'
        );
        if (plexSections.length === 0) {
          errorMessage = 'No music libraries found. Make sure you have a Music type library in Plex.';
        }
      } else {
        errorMessage = result.error ?? 'Failed to fetch library sections';
      }
    } catch {
      errorMessage = 'Network error fetching Plex sections';
    } finally {
      fetchingSections = false;
    }
  }

  // When a Plex user is selected, populate name + token
  $: if (selectedPlexUserId && plexUsers.length > 0) {
    const user = plexUsers.find(u => u.id === Number(selectedPlexUserId));
    if (user) {
      userName = user.title;
      userToken = user.accessToken;
    }
  }

  // When a section is selected, populate librarySectionId
  $: if (selectedSectionKey) {
    librarySectionId = selectedSectionKey;
  }

  async function saveMapping() {
    if (!selectedRootPath || !userName || !userToken || !librarySectionId) {
      errorMessage = 'All fields are required, including the music library section.';
      return;
    }
    saving = true;
    errorMessage = '';
    successMessage = '';
    try {
      const res = await fetch('/api/plex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save_mapping',
          root_folder_path: selectedRootPath,
          plex_user_name: userName,
          plex_user_token: userToken,
          library_section_id: librarySectionId
        })
      });
      const result = await res.json();
      if (result.ok) {
        successMessage = `Mapped "${selectedRootPath}" → ${userName} (section ${librarySectionId})`;
        selectedRootPath = '';
        userName = '';
        userToken = '';
        librarySectionId = '';
        selectedPlexUserId = '';
        selectedSectionKey = '';
        await invalidateAll();
      } else {
        errorMessage = result.error ?? 'Failed to save mapping';
      }
    } finally {
      saving = false;
    }
  }

  async function deleteMapping(id: number) {
    if (!confirm('Remove this user mapping?')) return;
    deletingId = id;
    try {
      await fetch('/api/plex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete_mapping', id })
      });
      await invalidateAll();
    } finally {
      deletingId = null;
    }
  }
</script>

<svelte:head>
  <title>Plex User Mappings · TuneFetch</title>
</svelte:head>

<section class="space-y-6">
  <header>
    <div class="flex items-center gap-2">
      <a href="/settings" class="text-sm text-slate-400 hover:text-slate-200">← Settings</a>
    </div>
    <h1 class="mt-1 text-2xl font-semibold tracking-tight">Plex User Mappings</h1>
    <p class="mt-1 text-sm text-slate-400">
      Map Lidarr root folder paths to Plex users. This ensures each user's playlists only contain
      tracks they can actually access in Plex.
    </p>
  </header>

  <!-- Existing mappings -->
  <div class="card space-y-4">
    <h2 class="text-lg font-medium text-slate-200">Current Mappings</h2>

    {#if data.mappings.length === 0}
      <p class="text-sm text-slate-500">No mappings configured yet.</p>
    {:else}
      <div class="space-y-2">
        {#each data.mappings as mapping (mapping.id)}
          <div class="rounded-lg border border-slate-600 bg-slate-800/30 px-4 py-3 flex items-center justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-3 flex-wrap">
                <code class="font-mono text-sm text-slate-300">{mapping.root_folder_path}</code>
                <span class="text-slate-500">→</span>
                <span class="font-medium text-purple-300">{mapping.plex_user_name}</span>
                {#if mapping.library_section_id}
                  <span class="badge bg-slate-700 text-slate-400 text-xs">section {mapping.library_section_id}</span>
                {:else}
                  <span class="badge bg-amber-900/40 text-amber-400 border border-amber-700 text-xs">⚠ No section set</span>
                {/if}
              </div>
              <p class="mt-0.5 text-xs text-slate-500">
                Token: {mapping.plex_user_token.substring(0, 8)}…
              </p>
            </div>
            <button
              class="btn-secondary text-xs py-1 px-2 text-red-400 hover:text-red-300"
              disabled={deletingId === mapping.id}
              on:click={() => deleteMapping(mapping.id)}
            >
              {deletingId === mapping.id ? '…' : '✕ Remove'}
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Add new mapping -->
  <div class="card space-y-4">
    <h2 class="text-lg font-medium text-slate-200">Add Mapping</h2>

    {#if !data.plexConfigured}
      <div class="flex items-start gap-2 rounded-lg border border-amber-700 bg-amber-950/40 px-3 py-2 text-sm text-amber-300">
        <span class="mt-px select-none text-base leading-none">⚠</span>
        <span>
          Plex is not configured yet.
          <a href="/settings" class="underline hover:text-amber-200">Configure Plex</a> in Settings first.
        </span>
      </div>
    {:else}
      <!-- Step 1: Fetch Plex users -->
      {#if plexUsers.length === 0}
        <div>
          <p class="mb-2 text-sm text-slate-400">
            First, fetch managed users from your Plex server to auto-fill their tokens.
          </p>
          <button
            class="btn-secondary"
            disabled={fetchingUsers}
            on:click={fetchPlexUsers}
          >
            {fetchingUsers ? 'Fetching…' : 'Fetch Plex Users'}
          </button>
        </div>
      {/if}

      <!-- Step 2: Select user + root folder -->
      {#if plexUsers.length > 0}
        <div>
          <label for="plex_user_select" class="mb-1 block text-sm font-medium text-slate-300">
            Plex User
          </label>
          <select
            id="plex_user_select"
            class="input"
            bind:value={selectedPlexUserId}
          >
            <option value="">Select a user…</option>
            {#each plexUsers as user}
              <option value={String(user.id)}>{user.title}</option>
            {/each}
          </select>
        </div>
      {/if}

      <div>
        <label for="root_folder_select" class="mb-1 block text-sm font-medium text-slate-300">
          Lidarr Root Folder Path
        </label>
        {#if data.rootFolders.length > 0}
          <select
            id="root_folder_select"
            class="input"
            bind:value={selectedRootPath}
          >
            <option value="">Select a root folder…</option>
            {#each data.rootFolders as folder}
              <option value={folder.path}>{folder.path}</option>
            {/each}
          </select>
        {:else}
          <input
            id="root_folder_select"
            type="text"
            class="input"
            bind:value={selectedRootPath}
            placeholder="/mnt/music/ben"
          />
          <p class="mt-1 text-xs text-slate-500">
            Lidarr root folders couldn't be loaded. Enter the path manually.
          </p>
        {/if}
      </div>

      <div>
        <label for="user_name_input" class="mb-1 block text-sm font-medium text-slate-300">
          User Display Name
        </label>
        <input
          id="user_name_input"
          type="text"
          class="input"
          bind:value={userName}
          placeholder="Ben"
        />
      </div>

      <div>
        <label for="user_token_input" class="mb-1 block text-sm font-medium text-slate-300">
          User Access Token
        </label>
        <input
          id="user_token_input"
          type="password"
          class="input"
          bind:value={userToken}
          placeholder="Fetched automatically when selecting a user above"
        />
        <p class="mt-1 text-xs text-slate-500">
          Auto-filled from the Plex user selection. You can also enter it manually.
        </p>
      </div>

      <!-- Section ID: fetch from server or enter manually -->
      <div>
        <label for="section_select" class="mb-1 block text-sm font-medium text-slate-300">
          Music Library Section
        </label>
        <p class="mb-2 text-xs text-slate-400">
          Each user/family group can have their own separate music library.
          Fetch sections from Plex, or enter the numeric ID manually.
        </p>
        <div class="flex gap-2">
          {#if plexSections.length === 0}
            <input
              id="section_select"
              type="text"
              class="input flex-1"
              bind:value={librarySectionId}
              placeholder="e.g. 3"
            />
            <button
              class="btn-secondary shrink-0"
              disabled={fetchingSections}
              on:click={fetchSections}
            >
              {fetchingSections ? 'Fetching…' : 'Fetch Sections'}
            </button>
          {:else}
            <select
              id="section_select"
              class="input flex-1"
              bind:value={selectedSectionKey}
            >
              <option value="">Select a library…</option>
              {#each plexSections as section}
                <option value={section.key}>{section.title} (ID: {section.key})</option>
              {/each}
            </select>
            <button
              class="btn-secondary shrink-0 text-xs"
              on:click={() => { plexSections = []; selectedSectionKey = ''; librarySectionId = ''; }}
            >
              Clear
            </button>
          {/if}
        </div>
      </div>

      <button
        class="btn-primary"
        disabled={saving || !selectedRootPath || !userName || !userToken || !librarySectionId}
        on:click={saveMapping}
      >
        {saving ? 'Saving…' : 'Save Mapping'}
      </button>
    {/if}

    {#if errorMessage}
      <div class="flex items-start gap-2 rounded-lg border border-red-700 bg-red-950/40 px-3 py-2 text-sm text-red-300">
        <span class="mt-px select-none text-base leading-none">✗</span>
        <span>{errorMessage}</span>
      </div>
    {/if}

    {#if successMessage}
      <div class="flex items-start gap-2 rounded-lg border border-green-700 bg-green-950/40 px-3 py-2 text-sm text-green-300">
        <span class="mt-px select-none text-base leading-none">✓</span>
        <span>{successMessage}</span>
      </div>
    {/if}
  </div>
</section>
