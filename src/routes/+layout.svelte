<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';
  import type { LayoutData } from './$types';

  export let data: LayoutData;

  $: pathname = $page.url.pathname;
  $: chromeless = pathname === '/login' || pathname === '/setup';

  const navItems = [
    { href: '/', label: 'Search' },
    { href: '/lists', label: 'Lists' },
    { href: '/mirrors', label: 'Mirror Health' },
    { href: '/settings', label: 'Settings' }
  ];

  function isActive(href: string): boolean {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(href + '/');
  }
</script>

{#if chromeless}
  <slot />
{:else}
  <div class="flex min-h-full flex-col">
    <header class="border-b border-slate-800 bg-slate-900/60 backdrop-blur">
      <div class="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <a href="/" class="text-lg font-semibold tracking-tight text-slate-100 no-underline">
          TuneFetch
        </a>
        <nav class="flex items-center gap-1">
          {#each navItems as item}
            <a
              href={item.href}
              class="rounded-md px-3 py-1.5 text-sm font-medium no-underline transition-colors"
              class:bg-slate-800={isActive(item.href)}
              class:text-slate-100={isActive(item.href)}
              class:text-slate-400={!isActive(item.href)}
              class:hover:text-slate-100={!isActive(item.href)}
            >
              {item.label}
            </a>
          {/each}
        </nav>
        <div class="flex items-center gap-3">
          {#if data.user}
            <span class="text-sm text-slate-400">{data.user.username}</span>
            <form method="POST" action="/logout">
              <button type="submit" class="btn-secondary text-xs">Sign out</button>
            </form>
          {/if}
        </div>
      </div>
    </header>

    <main class="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
      <slot />
    </main>
  </div>
{/if}
