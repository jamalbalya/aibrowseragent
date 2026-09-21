#!/usr/bin/env node
/**
 * Post-build validation.
 *
 * CI must fail on a package that would not load in Chrome, so this checks the
 * manifest's structure and that every file it references was actually emitted.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
}

if (!existsSync(dist)) {
  console.error('✗ dist/ does not exist. Run `npm run build` first.');
  process.exit(1);
}

const manifestPath = resolve(dist, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('✗ dist/manifest.json is missing.');
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  console.error(`✗ dist/manifest.json is not valid JSON: ${error.message}`);
  process.exit(1);
}

if (manifest.manifest_version !== 3) fail('manifest_version must be 3.');
if (!manifest.name) fail('manifest.name is required.');
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version ?? '')) {
  fail(`manifest.version "${manifest.version}" is not a valid Chrome extension version.`);
}

function requireFile(relative, label) {
  if (!relative) {
    fail(`${label} is not set in the manifest.`);
    return;
  }
  const full = resolve(dist, relative);
  if (!existsSync(full)) {
    fail(`${label} points at "${relative}", which was not emitted.`);
    return;
  }
  if (statSync(full).size === 0) fail(`${label} ("${relative}") is empty.`);
}

requireFile(manifest.background?.service_worker, 'background.service_worker');
requireFile(manifest.side_panel?.default_path, 'side_panel.default_path');

for (const entry of manifest.content_scripts ?? []) {
  for (const file of entry.js ?? []) requireFile(file, 'content_scripts.js');
}

for (const [size, path] of Object.entries(manifest.icons ?? {})) {
  const full = resolve(dist, path);
  if (!existsSync(full)) warnings.push(`Icon ${size} ("${path}") is missing.`);
}

// The service worker is declared as a module, so it must be emitted as one.
if (manifest.background?.type !== 'module') {
  warnings.push('background.type is not "module"; the bundled worker expects ESM.');
}

// A content script registered in the manifest is a classic script and cannot
// contain top-level import/export.
for (const entry of manifest.content_scripts ?? []) {
  for (const file of entry.js ?? []) {
    const full = resolve(dist, file);
    if (!existsSync(full)) continue;
    const source = readFileSync(full, 'utf8');
    if (/^\s*(import|export)\s/m.test(source)) {
      fail(`Content script "${file}" contains ES module syntax and will not load.`);
    }
  }
}

const csp = manifest.content_security_policy?.extension_pages ?? '';
if (csp.includes("'unsafe-eval'") || csp.includes("'unsafe-inline'")) {
  fail('The extension CSP must not allow unsafe-eval or unsafe-inline.');
}

for (const warning of warnings) console.warn(`⚠ ${warning}`);

if (errors.length > 0) {
  for (const error of errors) console.error(`✗ ${error}`);
  process.exit(1);
}

console.log(`✓ Package valid: ${manifest.name} ${manifest.version}`);
console.log(`  service worker: ${manifest.background.service_worker}`);
console.log(`  side panel:     ${manifest.side_panel.default_path}`);
console.log(`  permissions:    ${(manifest.permissions ?? []).join(', ')}`);
