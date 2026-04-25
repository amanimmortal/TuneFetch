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
      // List trusted origins for CSRF protection. Empty array = strict same-origin.
      // Add your reverse-proxy origin here if form actions break, e.g.:
      //   trustedOrigins: ['https://tunefetch.example.com']
      // For local dev add 'http://localhost:5173'.
      trustedOrigins: []
    }
  }
};

export default config;
