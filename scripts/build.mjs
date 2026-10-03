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
import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
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

// Before anything is compiled, so a value that is set and unusable stops the
// build at the moment the person who set it is watching — rather than being
// ignored, which looks identical to never having set it.
run(['node', 'scripts/check-extension-env.mjs'], 'Checking optional extension build configuration');

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

// A release build declares `identity` only if it can actually use it.
//
// Exactly one flow needs that permission: authorizing a Google account for the
// Gemini API, which `chrome.identity.launchWebAuthFlow` is the only way to
// perform. Connectors deliberately do not use it — `connectors/oauth/auth-flow-port.ts`
// says why — so with no Google OAuth client id compiled in, nothing in the
// build can request it. `accounts.connectGoogle` returns `NOT_CONFIGURED`
// before it ever reaches the permission ask.
//
// Declaring a permission the build cannot reach is a least-privilege defect and
// a Chrome Web Store review risk: the policy requires a permission to be
// necessary for functionality, and "it is for a feature this build has no
// configuration for" is not a justification anybody should have to give. The
// published 0.1.0 listing declares `downloads` alone, so adding `identity` in
// an update would be a new permission declaration for a capability the
// installer cannot use.
//
// Keyed on the **built bundle** rather than on the environment, for the reason
// `validate-release.mjs` gives about its own copy of this pattern: the bundle
// is the record of what the build decided, and a `.env` edited afterwards
// cannot make this disagree with the artifact. The whole client id is matched,
// never the bare suffix — `provider-auth-config.ts` contains that suffix in the
// check that validates one, so a substring test reports every build as
// configured.
//
// Release builds only, so a development build keeps the permission and every
// test that drives the real `chrome.permissions` surface is unaffected. The
// rule is a strict narrowing and `validate-release.mjs` asserts it rather than
// trusting it.
if (process.env.RELEASE_BUILD === '1' && Array.isArray(manifest.optional_permissions)) {
  const CLIENT_ID = /[0-9]{6,}-[a-z0-9]{6,}\.apps\.googleusercontent\.com/;
  const googleConfigured = ['service-worker.js', 'sidepanel.js']
    .map((name) => resolve(root, 'dist', name))
    .filter((file) => existsSync(file))
    .some((file) => CLIENT_ID.test(readFileSync(file, 'utf8')));
  if (!googleConfigured) {
    const before = manifest.optional_permissions.length;
    manifest.optional_permissions = manifest.optional_permissions.filter(
      (name) => name !== 'identity',
    );
    if (manifest.optional_permissions.length !== before) {
      console.log('  release: identity dropped — no Google OAuth client id is compiled in');
    }
    if (manifest.optional_permissions.length === 0) delete manifest.optional_permissions;
  } else {
    console.log('  release: identity kept — a Google OAuth client id is compiled in');
  }
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// The licence notices travel with the package, because that is what reaches a
// user.
//
// Four MIT dependencies are compiled into the bundles, and MIT requires the
// notice accompany the software rather than merely exist near it. The file is
// generated from the installed licences and `npm run check:notices` fails the
// build when it drifts — but that only keeps the repository copy truthful, and
// the repository is not what anyone installs. Copying it here is the step that
// discharges the obligation, and `scripts/validate-release.mjs` asserts it
// arrived rather than trusting that this line still runs.
const NOTICES = 'THIRD-PARTY-NOTICES.md';
const noticesSource = resolve(root, NOTICES);
if (!existsSync(noticesSource)) {
  console.error(`\n✗ ${NOTICES} is missing. Run \`npm run notices\` to generate it.`);
  process.exit(1);
}
copyFileSync(noticesSource, resolve(root, 'dist', NOTICES));

// Platform litter, removed before anything is packaged.
//
// Vite copies `publicDir` wholesale, so a `.DS_Store` that macOS leaves in
// `public/` is copied into `dist/` and then into the release archive — where it
// was, 6 KB of Finder metadata inside the extension. Two things were wrong with
// that: it ships a file that is nobody's business but this machine's, and it
// makes the artifact depend on the operating system that built it, so the
// "deterministic over repeated packing" check passed while the same commit
// produced a different archive on Linux.
//
// Pruned here rather than by deleting `public/.DS_Store`, because Finder puts
// it back.
const LITTER = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
function prune(dir) {
  let removed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) removed += prune(full);
    else if (LITTER.has(entry.name)) {
      rmSync(full);
      removed += 1;
    }
  }
  return removed;
}
const pruned = prune(resolve(root, 'dist'));
if (pruned > 0) console.log(`  pruned ${pruned} platform metadata file(s) from dist/`);

console.log(`\n✓ Build complete. Side panel: ${found}`);
console.log('  Load dist/ as an unpacked extension at chrome://extensions.');
