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

// A release build narrows `web_accessible_resources`.
//
// The OAuth callback page is reachable by redirect from an authorization
// server, which is why it is web-accessible at all. The loopback matches
// beside `https://github.com/*` exist so the end-to-end suite's mock
// authorization server — which runs on 127.0.0.1 — can perform the same
// redirect a real one does. That is a test affordance, and in a shipped
// build it would widen the set of origins allowed to load an extension page
// to every page served from loopback, and hand any of them a way to confirm
// the extension is installed.
//
// So the development build keeps them and the release build drops them.
// The difference is strictly a narrowing, it is asserted by
// `scripts/validate-release.mjs` rather than trusted, and the callback page
// itself carries no script in either build.
if (process.env.RELEASE_BUILD === '1' && Array.isArray(manifest.web_accessible_resources)) {
  manifest.web_accessible_resources = manifest.web_accessible_resources.map((entry) => {
    const matches = (entry.matches ?? []).filter((match) => match.startsWith('https://'));
    if (matches.length === 0) {
      console.error(
        `\n✗ Narrowing web_accessible_resources left no match for ${JSON.stringify(entry.resources)}.`,
      );
      process.exit(1);
    }
    return { ...entry, matches };
  });
  console.log('  release: web_accessible_resources narrowed to https origins');
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\n✓ Build complete. Side panel: ${found}`);
console.log('  Load dist/ as an unpacked extension at chrome://extensions.');
