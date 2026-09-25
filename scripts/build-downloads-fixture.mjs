#!/usr/bin/env node
/**
 * Produces `dist-downloads/`: the shipped bundle with one manifest delta.
 *
 * ## Why this exists
 *
 * `downloads` is an optional permission, and the only place it is ever
 * requested is a button in the side panel that calls
 * `chrome.permissions.request` inside its own click handler. Chrome honours
 * that request — a real `page.click()` does supply the activation — and then
 * shows its own confirmation dialog, which is browser chrome rather than page
 * content. Playwright can drive the click; it cannot answer the dialog, and
 * the promise never settles. That is a limitation of the test harness, not of
 * Chrome and not of this extension: the granting *dialog* is what cannot be
 * automated.
 *
 * The *granted* path is a different thing entirely, and nothing about it
 * needs a gesture. It needs the permission to be present. So this bundle
 * supplies it the only legitimate way a test can: by declaring it required in
 * the manifest, which is a build-time fact Chrome grants at install. Nothing
 * mutates Chrome's permission state at runtime, no API is mocked, and
 * `ChromeDownloadPort.isPermitted()` still asks `chrome.permissions.contains`
 * and still gets a real answer.
 *
 * ## The one delta
 *
 * `downloads` moves from `optional_permissions` into `permissions`. That is
 * the whole difference, and this script proves it rather than asserting it:
 * every other file is copied byte for byte from `dist/`, the file lists are
 * compared, and the two manifests are diffed key by key with anything beyond
 * those two keys treated as a failure.
 *
 * `dist/` is never modified. The shipped build keeps `downloads` optional,
 * and the spec that proves a download is refused without it keeps running
 * against that build.
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'dist');
const out = resolve(root, 'dist-downloads');

/** The permission this fixture makes required. The only thing that moves. */
const MOVED = 'downloads';

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

if (!existsSync(join(source, 'manifest.json'))) {
  fail('dist/manifest.json is missing. Run "npm run build" first.');
}

if (existsSync(out)) rmSync(out, { recursive: true, force: true });
cpSync(source, out, { recursive: true });

// -- Patch the manifest ------------------------------------------------------

const shipped = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));

// The delta is only meaningful if the starting point is the one described.
// A manifest that already required `downloads`, or that no longer offers it
// optionally, would make this fixture silently test something else.
if (!Array.isArray(shipped.optional_permissions) || !shipped.optional_permissions.includes(MOVED)) {
  fail(`dist/manifest.json does not list "${MOVED}" under optional_permissions.`);
}
if (!Array.isArray(shipped.permissions) || shipped.permissions.includes(MOVED)) {
  fail(`dist/manifest.json already requires "${MOVED}"; this fixture would be a no-op.`);
}

const patched = {
  ...shipped,
  permissions: [...shipped.permissions, MOVED],
};
const remaining = shipped.optional_permissions.filter((name) => name !== MOVED);
// An extension with nothing optional left has no `optional_permissions` key,
// rather than an empty array. This is what the manifest would honestly look
// like if `downloads` had been required all along.
if (remaining.length > 0) patched.optional_permissions = remaining;
else delete patched.optional_permissions;

writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(patched, null, 2)}\n`, 'utf8');

// -- Prove the delta is the only one ----------------------------------------

const CHANGED_KEYS = new Set(['permissions', 'optional_permissions']);
for (const key of new Set([...Object.keys(shipped), ...Object.keys(patched)])) {
  if (CHANGED_KEYS.has(key)) continue;
  if (JSON.stringify(shipped[key]) !== JSON.stringify(patched[key])) {
    fail(`manifest key "${key}" differs between dist/ and dist-downloads/.`);
  }
}
if (JSON.stringify(patched.permissions) !== JSON.stringify([...shipped.permissions, MOVED])) {
  fail('permissions changed by more than the one appended entry.');
}
if (JSON.stringify(patched.optional_permissions ?? []) !== JSON.stringify(remaining)) {
  fail('optional_permissions changed by more than the one removed entry.');
}

// -- Prove every other file is the shipped one ------------------------------

function walk(dir, base = dir, found = new Map()) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, base, found);
    else
      found.set(
        relative(base, path),
        createHash('sha256').update(readFileSync(path)).digest('hex'),
      );
  }
  return found;
}

const before = walk(source);
const after = walk(out);

if (before.size !== after.size) {
  fail(`dist/ has ${before.size} files and dist-downloads/ has ${after.size}.`);
}
for (const [path, digest] of before) {
  const copied = after.get(path);
  if (copied === undefined) fail(`dist-downloads/${path} is missing.`);
  if (path === 'manifest.json') {
    if (copied === digest) fail('manifest.json was not patched at all.');
    continue;
  }
  if (copied !== digest) fail(`dist-downloads/${path} is not byte-identical to dist/${path}.`);
}

console.log(
  `\n✓ Downloads fixture ready at dist-downloads/ ` +
    `(${before.size} files, "${MOVED}" required instead of optional)`,
);
