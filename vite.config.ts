import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  // better-sqlite3 is a native module; mark it external so Vite doesn't
  // try to bundle it during SSR.
  ssr: {
    external: ['better-sqlite3', '@node-rs/argon2']
  },
  server: {
    port: 5173
  }
});
