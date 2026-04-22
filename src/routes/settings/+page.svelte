<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { ActionData, PageData } from './$types';

  export let data: PageData;
  export let form: ActionData;

  // Track which action is in-flight for per-button loading state
  let savePending = false;
  let testPending = false;
  let testPlexPending = false;

  // Derive typed values from the opaque ActionData union.
  $: f = form as Record<string, unknown> | null;
  $: formError       = (f?.error       as string  | undefined) ?? null;
  $: connectionStatus = (f?.connectionStatus as string  | undefined) ?? null;
  $: connectionMessage = (f?.connectionMessage as string  | undefined) ?? null;
  $: plexConnectionStatus = (f?.plexConnectionStatus as string | undefined) ?? null;
  $: plexConnectionMessage = (f?.plexConnectionMessage as string | undefined) ?? null;
  $: saved           = (f?.saved        as boolean | undefined) ?? false;
  $: isOk  = connectionStatus === 'ok';
  $: isErr = connectionStatus === 'error';
  $: plexIsOk  = plexConnectionStatus === 'ok';
  $: plexIsErr = plexConnectionStatus === 'error';

  const handleSubmit: SubmitFunction = ({ submitter }) => {
    const formaction =
      submitter instanceof HTMLButtonElement
        ? submitter.getAttribute('formaction') ?? ''
        : '';
    if (formaction.includes('testPlexConnection')) {
      testPlexPending = true;
    } else if (formaction.includes('testConnection')) {
      testPending = true;
    } else {
      savePending = true;
    }
    return async ({ update }) => {
      try {
        await update({ reset: false });
      } finally {
        savePending = false;
        testPending = false;
        testPlexPending = false;
      }
    };
  };
</script>

<svelte:head>
  <title>Settings · TuneFetch</title>
</svelte:head>

<section class="space-y-6">
  <header>
    <h1 class="text-2xl font-semibold tracking-tight">Settings</h1>
    <p class="mt-1 text-sm text-slate-400">
      Lidarr connection, Plex integration, admin contact email, and scheduled jobs.
    </p>
  </header>

  <form
    class="card space-y-4"
    method="POST"
    action="?/save"
    use:enhance={handleSubmit}
  >
    <!-- ── Lidarr ─────────────────────────────────────────────────────── -->
    <h2 class="text-lg font-medium text-slate-200 border-b border-slate-700 pb-2">Lidarr</h2>

    <div>
      <label for="lidarr_url" class="mb-1 block text-sm font-medium text-slate-300">
        Lidarr URL
      </label>
      <input
        id="lidarr_url"
        name="lidarr_url"
        type="url"
        placeholder="http://192.168.1.10:8686"
        value={data.settings.lidarrUrl}
        class="input"
        autocomplete="off"
      />
    </div>

    <div>
      <label for="lidarr_api_key" class="mb-1 block text-sm font-medium text-slate-300">
        Lidarr API Key
      </label>
      <input
        id="lidarr_api_key"
        name="lidarr_api_key"
        type="password"
        value={data.settings.lidarrApiKey}
        class="input"
        autocomplete="off"
      />
    </div>

    <div>
      <button
        type="submit"
        formaction="?/testConnection"
        class="btn-secondary"
        disabled={savePending || testPending || testPlexPending}
      >
        {testPending ? 'Testing…' : 'Test Lidarr connection'}
      </button>
    </div>

    {#if connectionStatus}
      <div
        class="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm
          {isOk
            ? 'border-green-700 bg-green-950 text-green-300'
            : isErr
            ? 'border-red-700 bg-red-950 text-red-300'
            : 'border-slate-600 bg-slate-800 text-slate-400'}"
      >
        <span class="mt-px select-none text-base leading-none">
          {isOk ? '✓' : isErr ? '✗' : '—'}
        </span>
        <span>{connectionMessage}</span>
      </div>
    {/if}

    <!-- ── Plex ───────────────────────────────────────────────────────── -->
    <h2 class="text-lg font-medium text-slate-200 border-b border-slate-700 pb-2 mt-6">Plex</h2>

    <div>
      <label for="plex_url" class="mb-1 block text-sm font-medium text-slate-300">
        Plex URL
      </label>
      <input
        id="plex_url"
        name="plex_url"
        type="url"
        placeholder="http://192.168.1.10:32400"
        value={data.settings.plexUrl}
        class="input"
        autocomplete="off"
      />
      <p class="mt-1 text-xs text-slate-500">
        Local address of your Plex Media Server.
      </p>
    </div>

    <div>
      <label for="plex_admin_token" class="mb-1 block text-sm font-medium text-slate-300">
        Plex Admin Token
      </label>
      <input
        id="plex_admin_token"
        name="plex_admin_token"
        type="password"
        value={data.settings.plexAdminToken}
        class="input"
        autocomplete="off"
      />
      <p class="mt-1 text-xs text-slate-500">
        The X-Plex-Token for the server admin account. Find it in Plex → Settings → Network → XML link.
      </p>
    </div>

    <div>
      <label for="plex_library_section_id" class="mb-1 block text-sm font-medium text-slate-300">
        Music Library Section ID
      </label>
      <input
        id="plex_library_section_id"
        name="plex_library_section_id"
        type="text"
        placeholder="e.g. 3"
        value={data.settings.plexLibrarySectionId}
        class="input"
        autocomplete="off"
      />
      <p class="mt-1 text-xs text-slate-500">
        The numeric ID of your Plex music library section. Test the connection first, then check your library sections.
      </p>
    </div>

    <div>
      <button
        type="submit"
        formaction="?/testPlexConnection"
        class="btn-secondary"
        disabled={savePending || testPending || testPlexPending}
      >
        {testPlexPending ? 'Testing…' : 'Test Plex connection'}
      </button>
    </div>

    {#if plexConnectionStatus}
      <div
        class="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm
          {plexIsOk
            ? 'border-green-700 bg-green-950 text-green-300'
            : plexIsErr
            ? 'border-red-700 bg-red-950 text-red-300'
            : 'border-slate-600 bg-slate-800 text-slate-400'}"
      >
        <span class="mt-px select-none text-base leading-none">
          {plexIsOk ? '✓' : plexIsErr ? '✗' : '—'}
        </span>
        <span>{plexConnectionMessage}</span>
      </div>
    {/if}

    <div>
      <a
        href="/settings/plex-mappings"
        class="inline-flex items-center gap-1.5 text-sm text-purple-400 hover:text-purple-300 transition-colors"
      >
        <span>👤</span>
        <span>Manage Plex User Mappings</span>
        <span class="text-slate-500">→</span>
      </a>
      <p class="mt-0.5 text-xs text-slate-500">
        Map Lidarr root folders to Plex users so playlists target the correct accounts.
      </p>
    </div>

    <!-- ── General ────────────────────────────────────────────────────── -->
    <h2 class="text-lg font-medium text-slate-200 border-b border-slate-700 pb-2 mt-6">General</h2>

    <div>
      <label for="admin_contact_email" class="mb-1 block text-sm font-medium text-slate-300">
        Admin contact email
      </label>
      <input
        id="admin_contact_email"
        name="admin_contact_email"
        type="email"
        placeholder="you@example.com"
        value={data.settings.adminContactEmail}
        class="input"
      />
      <p class="mt-1 text-xs text-slate-500">
        Used in the User-Agent header sent to MusicBrainz.
      </p>
    </div>

    <div>
      <label for="orphan_scan_time" class="mb-1 block text-sm font-medium text-slate-300">
        Orphan scan time (HH:MM, 24-hour)
      </label>
      <input
        id="orphan_scan_time"
        name="orphan_scan_time"
        type="time"
        value={data.settings.orphanScanTime}
        class="input"
      />
      <p class="mt-1 text-xs text-slate-500">
        Time of day to run the nightly mirror orphan detection scan.
      </p>
    </div>

    <!-- Action buttons -->
    <div class="flex flex-wrap items-center gap-3 pt-2 border-t border-slate-700">
      <button type="submit" class="btn-primary" disabled={savePending || testPending || testPlexPending}>
        {savePending ? 'Saving…' : 'Save all settings'}
      </button>
    </div>

    <!-- Validation error -->
    {#if formError}
      <p class="text-sm text-red-400">{formError}</p>
    {/if}

    {#if saved}
      <p class="text-xs text-slate-500">
        All settings saved.
      </p>
    {/if}
  </form>
</section>
