import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      out: 'build'
    }),
    csrf: {
      // CSRF origin checking is disabled because TuneFetch is a self-hosted LAN
      // app with its own session-based authentication. The SvelteKit default
      // same-origin check requires the ORIGIN env var to match every URL the app
      // is accessed from, which is impractical across direct-IP, hostname, and
      // reverse-proxy deployments.
      //
      // If you want to enable it, remove this option and set:
      //   ORIGIN=https://your-tunefetch-url   (in your Docker env)
      checkOrigin: false
    }
  }
};

export default config;
