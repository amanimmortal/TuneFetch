<script lang="ts">
  import { enhance } from '$app/forms';
  import type { ActionData, PageData } from './$types';

  export let data: PageData;
  export let form: ActionData;

  // Track which action is in-flight for per-button loading state
  let savePending = false;
  let testPending = false;

  // Derive typed values from the opaque ActionData union.
  // Using 'as' casts here is safe: the server always returns these keys
  // (or undefined), and we default-coerce below.
  $: f = form as Record<string, unknown> | null;
  $: formError       = (f?.error       as string  | undefined) ?? null;
  $: connectionStatus = (f?.connectionStatus as string  | undefined) ?? null;
  $: connectionMessage = (f?.connectionMessage as string  | undefined) ?? null;
  $: saved           = (f?.saved        as boolean | undefined) ?? false;
  $: isOk  = connectionStatus === 'ok';
  $: isErr = connectionStatus === 'error';
</script>

<svelte:head>
  <title>Settings · TuneFetch</title>
</svelte:head>

<section class="space-y-6">
  <header>
    <h1 class="text-2xl font-semibold tracking-tight">Settings</h1>
    <p class="mt-1 text-sm text-slate-400">
      Lidarr connection, admin contact email, and scheduled jobs.
    </p>
  </header>

  <form
    class="card space-y-4"
    method="POST"
    action="?/save"
    use:enhance={({ submitter }) => {
      // Detect which button triggered the submit so the correct button
      // shows its pending label. formaction overrides the form's action
      // on per-button basis, so we key off the submitter element.
      const btn = submitter as HTMLButtonElement | null;
      const isTest =
        (btn?.getAttribute('formaction') ?? '').includes('testConnection');
      if (isTest) {
        testPending = true;
      } else {
        savePending = true;
      }
      return async ({ update }) => {
        try {
          await update();
        } finally {
          // Always clear both — a thrown action or slow connection
          // must not leave the button stuck on "Testing…".
          savePending = false;
          testPending = false;
        }
      };
    }}
  >
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
    <div class="flex flex-wrap items-center gap-3">
      <button type="submit" class="btn-primary" disabled={savePending || testPending}>
        {savePending ? 'Saving…' : 'Save'}
      </button>

      <button
        type="submit"
        formaction="?/testConnection"
        class="btn-secondary"
        disabled={savePending || testPending}
      >
        {testPending ? 'Testing…' : 'Test Lidarr connection'}
      </button>
    </div>

    <!-- Validation error -->
    {#if formError}
      <p class="text-sm text-red-400">{formError}</p>
    {/if}

    <!-- Connection status banner -->
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

      {#if saved}
        <p class="text-xs text-slate-500">
          {isOk
            ? 'Settings saved.'
            : 'Settings saved (Lidarr connection failed — check URL and API key).'}
        </p>
      {/if}
    {/if}
  </form>
</section>
