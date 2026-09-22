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
const FORBIDDEN_EXTENSIONS = ['.map', '.ts', '.tsx', '.md', '.log'];
for (const rel of relPaths) {
  const ext = extname(rel);
  if (FORBIDDEN_EXTENSIONS.includes(ext)) {
    fail(`Development artefact in the package: ${rel}`);
  }
}

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
