<script lang="ts">
  import type { ActionData } from './$types';

  export let form: ActionData;
</script>

<svelte:head>
  <title>First-run setup · TuneFetch</title>
</svelte:head>

<div class="flex min-h-full items-center justify-center px-4 py-12">
  <div class="w-full max-w-sm">
    <div class="mb-6 text-center">
      <h1 class="text-2xl font-semibold tracking-tight">Welcome to TuneFetch</h1>
      <p class="mt-1 text-sm text-slate-400">Create the admin account to continue.</p>
    </div>

    <form method="POST" class="card space-y-4">
      <div>
        <label for="username" class="mb-1 block text-sm font-medium text-slate-300">
          Username
        </label>
        <input
          id="username"
          name="username"
          type="text"
          autocomplete="username"
          required
          value={form?.username ?? ''}
          class="input"
        />
      </div>

      <div>
        <label for="password" class="mb-1 block text-sm font-medium text-slate-300">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autocomplete="new-password"
          required
          minlength="8"
          class="input"
        />
      </div>

      <div>
        <label for="confirm" class="mb-1 block text-sm font-medium text-slate-300">
          Confirm password
        </label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          autocomplete="new-password"
          required
          minlength="8"
          class="input"
        />
      </div>

      {#if form?.error}
        <p class="text-sm text-red-400">{form.error}</p>
      {/if}

      <button type="submit" class="btn-primary w-full">Create admin account</button>
    </form>
  </div>
</div>
