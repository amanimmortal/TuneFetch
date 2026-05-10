<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';
  import type { LayoutData } from './$types';

  export let data: LayoutData;

  $: pathname = $page.url.pathname;
  $: chromeless = pathname === '/login' || pathname === '/setup';

  const ADMIN_NAV = [
    { href: '/', label: 'Search' },
    { href: '/lists', label: 'Playlists' },
    { href: '/mirrors', label: 'Mirror Health' },
    { href: '/settings', label: 'Settings' }
  ];

  const SIMPLE_NAV = [
    { href: '/', label: 'Search' },
    { href: '/lists', label: 'Playlists' }
  ];

  $: navItems = data.isAdmin ? ADMIN_NAV : SIMPLE_NAV;
  $: redirectTo = $page.url.pathname + $page.url.search;

  const isActive = (p: string, href: string) =>
    href === '/' ? p === '/' : p === href || p.startsWith(href + '/');
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
            {@const active = isActive(pathname, item.href)}
            <a
              href={item.href}
              class="rounded-md px-3 py-1.5 text-sm font-medium no-underline transition-colors"
              class:bg-slate-800={active}
              class:text-slate-100={active}
              class:text-slate-400={!active}
              class:hover:text-slate-100={!active}
            >
              {item.label}
            </a>
          {/each}
        </nav>
        <div class="flex items-center gap-3">
          {#if data.user}
            <span class="hidden text-sm text-slate-400 sm:inline">{data.user.username}</span>
            <form method="POST" action="/admin-mode">
              <input type="hidden" name="value" value={data.isAdmin ? 'false' : 'true'} />
              <input type="hidden" name="redirectTo" value={redirectTo} />
              <button
                type="submit"
                class="rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:text-slate-200"
                title={data.isAdmin ? 'Switch to simple mode' : 'Switch to admin mode'}
              >
                {data.isAdmin ? 'Admin: on' : 'Admin: off'}
              </button>
            </form>
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
