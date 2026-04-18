import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{html,js,svelte,ts}'],
  theme: {
    extend: {
      colors: {
        // Accent palette for status chips; keep defaults for the rest.
        status: {
          pending: '#f59e0b',
          synced: '#10b981',
          failed: '#ef4444',
          mirror: '#6366f1'
        }
      }
    }
  },
  plugins: []
} satisfies Config;
