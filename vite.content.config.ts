import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Content scripts must be emitted as a single self-contained classic script.
 * `format: 'iife'` with inlined dynamic imports guarantees that.
 */
export default defineConfig({
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome120',
    // Off for a release build, for the same reason as the main config: a
    // published package should not carry the source tree.
    sourcemap: process.env.RELEASE_BUILD !== '1',
    lib: {
      entry: resolve(import.meta.dirname, 'src/content/content-script.ts'),
      formats: ['iife'],
      name: 'AiBrowserAgentContentScript',
      fileName: () => 'content-script.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true, extend: true },
    },
  },
});
