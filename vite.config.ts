import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [sveltekit()],
  // better-sqlite3 is a native module; mark it external so Vite doesn't
  // try to bundle it during SSR.
  ssr: {
    external: ['better-sqlite3', '@node-rs/argon2']
  },
  server: {
    port: 5173
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Run each test file in its own worker so module mocks don't bleed across files.
    pool: 'forks',
  }
});
