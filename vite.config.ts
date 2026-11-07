import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: true,
    port: 5173,
    // Dev/preview server is reached through a proxied host (e.g. the sandbox
    // preview at https://<port>-<id>.e2b.app), so do not restrict Host headers.
    allowedHosts: true,
  },
  preview: {
    host: true,
    allowedHosts: true,
  },
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
  },
});
