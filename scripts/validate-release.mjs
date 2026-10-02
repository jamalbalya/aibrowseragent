#!/usr/bin/env node
/**
 * Release validation (Stage 3 Wave A).
 *
 * `validate-package.mjs` answers "would Chrome load this?". This answers a
 * different question: "is this the artifact we intended to publish?".
 *
 * The two are separate because a package can load perfectly and still be
 * wrong to ship — carrying a source map that reveals the whole tree, a test
 * fixture, an absolute path from the build machine, or a version that
 * disagrees with the one in `package.json`. None of those break loading, and
 * all of them are mistakes that are far cheaper to catch here than after a
 * store review.
 *
 * It does not check Chrome Web Store policy. Policy is published by Google,
 * changes independently of this repository, and is not verifiable from here;
 * claiming otherwise in a script would be inventing a fact.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWebAccessibleResources } from './release-rules.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const errors = [];
const notes = [];

const fail = (message) => errors.push(message);
const note = (message) => notes.push(message);

if (!existsSync(dist)) {
  console.error('✗ dist/ does not exist. Run `npm run build` first.');
  process.exit(1);
}

/** Every file in the package, relative to dist. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(dist);
const relPaths = files.map((f) => relative(dist, f).split('\\').join('/'));

// ---------------------------------------------------------------------------
// A2b. No platform metadata.
//
// Vite copies `publicDir` wholesale, so a `.DS_Store` left in `public/` by the
// Finder reached `dist/` and then the archive — 6 KB of this machine's
// metadata inside the extension, and an artifact whose contents depended on
// the operating system that built it. `scripts/build.mjs` prunes it; this is
// the assertion that the pruning still runs, because the packaging check below
// only proves the archive is stable against *repeated* packing on one machine,
// which litter satisfies perfectly well.
// ---------------------------------------------------------------------------
const LITTER = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];
const littered = relPaths.filter((path) => LITTER.includes(path.split('/').pop()));
if (littered.length > 0) {
  fail(
    `The build output carries platform metadata: ${littered.join(', ')}. ` +
      'It must not be shipped, and it makes the artifact depend on the machine ' +
      'that built it.',
  );
}

// ---------------------------------------------------------------------------
// A3. Version is single-sourced.
// ---------------------------------------------------------------------------
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));

if (pkg.version !== manifest.version) {
  fail(
    `Version divergence: package.json is ${pkg.version} and the manifest is ` +
      `${manifest.version}. A published build must be identifiable by one number.`,
  );
}

// ---------------------------------------------------------------------------
// A1. Nothing development-only ships.
// ---------------------------------------------------------------------------
/**
 * The one Markdown file that must ship, and why it is named rather than the
 * rule below being widened.
 *
 * Documentation is a development artefact, which is why `.md` is forbidden.
 * This file is not documentation: four MIT dependencies are compiled into the
 * bundles, and MIT requires their notices accompany the distribution. Shipping
 * without it makes the package non-compliant, and widening the rule to all
 * Markdown would let the next stray document through on this one's warrant.
 */
const REQUIRED_NOTICES = 'THIRD-PARTY-NOTICES.md';

const FORBIDDEN_EXTENSIONS = ['.map', '.ts', '.tsx', '.md', '.log'];
for (const rel of relPaths) {
  if (rel === REQUIRED_NOTICES) continue;
  const ext = extname(rel);
  if (FORBIDDEN_EXTENSIONS.includes(ext)) {
    fail(`Development artefact in the package: ${rel}`);
  }
}

// ---------------------------------------------------------------------------
// The licence notices reached the package.
//
// `check:notices` proves the repository's copy matches the installed licences.
// It says nothing about whether that copy ships, and for most of this
// project's life it did not: the file was generated, checked, and then left
// behind at packaging time. The obligation is discharged by the artifact, so
// it is asserted on the artifact.
// ---------------------------------------------------------------------------
if (!relPaths.includes(REQUIRED_NOTICES)) {
  fail(
    `${REQUIRED_NOTICES} is missing from the package. Bundled MIT dependencies ` +
      'require their notices accompany the distribution, so this artifact may ' +
      'not be published.',
  );
} else if (readFileSync(resolve(dist, REQUIRED_NOTICES), 'utf8').trim().length === 0) {
  fail(`${REQUIRED_NOTICES} ships empty, which discharges no licence obligation.`);
}

/**
 * Debug and development artefacts that reach the *contents* rather than the
 * file list.
 *
 * The extension checks above catch a `.map` or a `.ts` that was packaged. These
 * catch the things that compile into a bundle and survive minification: a
 * `debugger` statement pauses a reviewer's devtools, a `console.log` prints
 * whatever it was given wherever it ends up, and a test fixture name means a
 * module that should not be reachable is.
 *
 * Added after an audit scanned the artifact by hand and found none of them. A
 * confirmation nobody enforces decays into a claim, so the scan became a
 * check — and it costs nothing when it passes.
 *
 * `eval` and `new Function` are listed although the CSP already forbids them at
 * run time: a bundle containing one is a bundle that intends to use it, and
 * finding out at review time that the CSP is doing the refusing is worse than
 * not shipping it.
 */
const DEBUG_PATTERNS = [
  {
    id: 'A `debugger` statement',
    // Bounded by a statement boundary so a property or identifier containing
    // the word — `chrome.debugger`, which this extension legitimately uses —
    // is not matched.
    re: /(^|[;{}\s])debugger\s*[;}]/m,
    why: 'it pauses a reviewer’s devtools and has no place in a release.',
  },
  {
    id: 'A `console.log` call',
    re: /\bconsole\s*\.\s*log\s*\(/,
    why: 'the logger is the one path that redacts; this one is not.',
  },
  {
    id: 'An `eval` call',
    re: /[^.\w]eval\s*\(/,
    why: 'the CSP forbids it at run time, so shipping one is shipping a failure.',
  },
  {
    id: 'A `new Function` constructor',
    re: /\bnew\s+Function\s*\(/,
    why: 'it is `eval` by another name and the CSP forbids it too.',
  },
  {
    id: 'A test fixture reference',
    re: /\b(mock-provider|mock-connector-service|mock-mcp-server|test-site|auth-backend)\b/,
    why: 'a module that should not be reachable from the bundle is.',
  },
  {
    id: 'A test-runner reference',
    re: /\b(vitest|@playwright\/test)\b/,
    why: 'a development dependency reached the bundle.',
  },
];

const FORBIDDEN_PATHS = [
  /(^|\/)tests?\//i,
  /(^|\/)__tests__\//i,
  /(^|\/)fixtures?\//i,
  /(^|\/)e2e\//i,
  /(^|\/)coverage\//i,
  /(^|\/)node_modules\//,
  /(^|\/)\.env/,
  /(^|\/)\.git/,
];
for (const rel of relPaths) {
  for (const pattern of FORBIDDEN_PATHS) {
    if (pattern.test(rel)) fail(`Path that must not ship: ${rel}`);
  }
}

// ---------------------------------------------------------------------------
// A1. No build-machine paths, and no credential-shaped strings.
// ---------------------------------------------------------------------------
const TEXT_EXTENSIONS = new Set(['.js', '.json', '.html', '.css']);

/**
 * Credential shapes, kept deliberately narrow.
 *
 * A broad "looks like a long token" rule fires on minified code and would be
 * turned off within a week, which is worse than not having it. These are
 * issuer-prefixed forms that do not occur by accident.
 */
const SECRET_PATTERNS = [
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'google-api-key', re: /\bAIza[A-Za-z0-9_-]{30,}/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  // Requires an actual key body. The header alone appears in this project's
  // own redaction patterns, and flagging the detector as the thing it detects
  // is the kind of false positive that gets a check disabled.
  {
    id: 'private-key-block',
    re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{40,}/,
  },
];

// An absolute path from the machine that produced the build. Harmless to
// Chrome, but it leaks a directory layout and usually a username.
const BUILD_PATH_PATTERNS = [/\/(?:home|Users)\/[A-Za-z0-9._-]+\//, /[A-Z]:\\Users\\/];

for (const full of files) {
  const rel = relative(dist, full).split('\\').join('/');
  if (!TEXT_EXTENSIONS.has(extname(rel))) continue;
  if (statSync(full).size > 8 * 1024 * 1024) {
    note(`Skipped scanning ${rel}: larger than 8 MB.`);
    continue;
  }

  const content = readFileSync(full, 'utf8');

  for (const { id, re } of SECRET_PATTERNS) {
    if (re.test(content)) fail(`Credential-shaped value (${id}) found in ${rel}.`);
  }
  for (const re of BUILD_PATH_PATTERNS) {
    if (re.test(content)) fail(`Build-machine path leaked into ${rel}.`);
  }
  if (/\/\/# sourceMappingURL=/.test(content)) {
    fail(`${rel} references a source map, which is not intended for release.`);
  }
  for (const { id, re, why } of DEBUG_PATTERNS) {
    if (re.test(content)) fail(`${id} in ${rel} — ${why}`);
  }
}

// ---------------------------------------------------------------------------
// A2. Remote code and permissions.
// ---------------------------------------------------------------------------
if (relPaths.some((rel) => rel === 'manifest.json') === false) {
  fail('manifest.json is missing from the package.');
}

const hostPermissions = manifest.host_permissions ?? [];
if (hostPermissions.includes('<all_urls>')) {
  fail('host_permissions contains <all_urls>, which was removed for a security reason.');
}
for (const permission of manifest.permissions ?? []) {
  if (permission.includes('://') || permission === '<all_urls>') {
    fail(`permissions contains a host pattern: ${permission}`);
  }
}

for (const failure of checkWebAccessibleResources(manifest)) fail(failure);

// The locked architectural prohibitions, asserted on the manifest that actually
// ships.
//
// `security-invariants.test.ts` already asserts these against
// `public/manifest.json`, and that is a different artifact: `build.mjs`
// transforms the manifest on the way out — it is what strips the loopback
// `web_accessible_resources` entry a few lines above — so a transform that
// *added* one of these keys would pass every test in the repository and ship.
// The point of this file is to be the last thing between a build and a store, so
// the prohibitions are re-checked here on the bytes in the package.
//
// Each is locked by the product's architecture rather than by taste:
// `externally_connectable` would let a web page message the extension directly,
// `nativeMessaging` would let it run a local process, and neither exists in any
// design this project has approved.
for (const key of [
  'externally_connectable',
  'nativeMessaging',
  'devtools_page',
  'chrome_url_overrides',
]) {
  if (key in manifest) {
    fail(`manifest declares ${key}, which no approved design for this extension uses.`);
  }
}
for (const permission of manifest.permissions ?? []) {
  if (permission === 'nativeMessaging' || permission === 'debugger.attach') {
    fail(`permissions contains ${permission}, which no approved design uses.`);
  }
}
// `optional_permissions` is a grant the user can give later, so a host pattern
// hiding there would be the same escalation the loop above refuses in
// `permissions` — reachable one dialog away rather than not at all.
for (const permission of manifest.optional_permissions ?? []) {
  if (permission.includes('://') || permission === '<all_urls>') {
    fail(`optional_permissions contains a host pattern: ${permission}`);
  }
}

const csp = manifest.content_security_policy?.extension_pages ?? '';
if (!csp) fail('The extension declares no content_security_policy.');
if (/unsafe-eval|unsafe-inline/.test(csp)) fail('CSP allows unsafe-eval or unsafe-inline.');

// Scripts loaded from anywhere other than the package itself are remote code.
for (const full of files) {
  const rel = relative(dist, full).split('\\').join('/');
  if (extname(rel) !== '.html') continue;
  const html = readFileSync(full, 'utf8');
  const remote = html.match(/<script[^>]+src=["'](https?:)?\/\/[^"']+["']/i);
  if (remote) fail(`${rel} loads a remote script: ${remote[0]}`);
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
for (const message of notes) console.log(`  note: ${message}`);

if (errors.length > 0) {
  console.error('\n✗ Release validation failed:\n');
  for (const message of errors) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(`✓ Release artefact valid: ${pkg.name} ${pkg.version}`);
console.log(`  files:       ${relPaths.length}`);
console.log(`  permissions: ${(manifest.permissions ?? []).join(', ')}`);
console.log(`  host access: ${hostPermissions.join(', ') || 'none'}`);
console.log('  note: Chrome Web Store policy is NOT checked here and must be verified separately.');
