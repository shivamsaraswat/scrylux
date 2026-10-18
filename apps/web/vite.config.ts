import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // @scrylux/core is browser-safe (no Node built-ins) and is bundled from source, so the web
    // build doesn't depend on core's dist.
    alias: {
      '@scrylux/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // No asset becomes a data: URI, so the CSP needs no exception for them (FR-022).
    assetsInlineLimit: 0,
    // Writes dist/.vite/license.md with every bundled dependency's license (FR-006b). It ships in the
    // image; webHandler ignores dot-directories, so it is not served.
    license: true,
  },
  server: {
    proxy: {
      // changeOrigin stays false: the session endpoints check that the Origin header's host equals
      // the Host header, so the proxy must keep the browser's own Host.
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
});
