import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';

// Server output: the homepage is prerendered (export const prerender = true),
// the /api/audit endpoint runs on demand. Deployed as a standalone Node server.
export default defineConfig({
  site: 'https://geo-audit.kant.dev',
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  vite: {
    plugins: [tailwindcss()],
  },
});
