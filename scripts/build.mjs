#!/usr/bin/env node
/**
 * Two-pass extension build.
 *
 * Pass 1 emits the ES-module surfaces (side panel + service worker).
 * Pass 2 emits the content script as a classic IIFE, because a script
 * registered under `content_scripts` cannot use ES module syntax.
 *
 * The manifest is then rewritten so its side-panel path matches where Vite
 * actually emitted the HTML, and the result is validated.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(args, label) {
  console.log(`\n→ ${label}`);
  const result = spawnSync('npx', args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.status !== 0) {
    console.error(`\n✗ ${label} failed.`);
    process.exit(result.status ?? 1);
  }
}

run(['vite', 'build'], 'Building side panel and service worker');
run(['vite', 'build', '--config', 'vite.content.config.ts'], 'Building content script');

// Vite emits the side panel at dist/src/sidepanel/index.html, mirroring the
// source path. Point the manifest at where the file really is.
const manifestPath = resolve(root, 'dist/manifest.json');
if (!existsSync(manifestPath)) {
  console.error('\n✗ dist/manifest.json is missing. Did public/manifest.json get copied?');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const candidates = ['src/sidepanel/index.html', 'sidepanel.html', 'sidepanel/index.html'];
const found = candidates.find((candidate) => existsSync(resolve(root, 'dist', candidate)));

if (!found) {
  console.error(`\n✗ No side panel HTML found in dist. Looked for: ${candidates.join(', ')}`);
  process.exit(1);
}

manifest.side_panel = { ...manifest.side_panel, default_path: found };
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\n✓ Build complete. Side panel: ${found}`);
console.log('  Load dist/ as an unpacked extension at chrome://extensions.');
