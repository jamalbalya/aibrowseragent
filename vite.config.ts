import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Build config for the ES-module surfaces of the extension:
 * the side panel document and the MV3 service worker.
 *
 * Content scripts are built separately (vite.content.config.ts) because
 * `content_scripts` entries registered in the manifest are classic scripts
 * and cannot use ES module syntax.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120',
    // Source maps are for development. A released package must not carry the
    // whole source tree, so the release build turns them off; `validate-release`
    // fails the build if one slips through.
    sourcemap: process.env.RELEASE_BUILD !== '1',
    rollupOptions: {
      input: {
        sidepanel: resolve(import.meta.dirname, 'src/sidepanel/index.html'),
        'service-worker': resolve(import.meta.dirname, 'src/background/service-worker.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
