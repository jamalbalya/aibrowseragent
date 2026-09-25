#!/usr/bin/env node
/**
 * Fails when a credential-shaped value appears in tracked source.
 *
 * Reuses the extension's own redaction rules as the detector, so the scanner
 * and the runtime cannot drift apart: a pattern added for one is added for
 * both.
 *
 * Tests are NOT excluded. Their credential-shaped fixtures are assembled at
 * runtime from split literals precisely so that no scannable credential exists
 * on any line — which is also what keeps GitHub push protection from blocking
 * the repository.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Build output, not authored source. `dist-auth/` and `dist-downloads/` are
// the E2E fixture bundles and are skipped for exactly the reason `dist/` is:
// they contain the secret-redactor's own patterns, compiled in, which are what
// the redactor exists to match rather than anything anyone needs to rotate.
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-auth',
  'dist-downloads',
  'coverage',
  '.git',
  '.github',
]);
const SCAN_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.json',
  '.html',
  '.css',
  '.yml',
  '.md',
  // Migrations are tracked source and could carry a seeded credential.
  '.sql',
]);

/**
 * Paths whose credential-shaped content is intentional.
 * Each entry needs a reason; an unexplained exclusion is how a real leak hides.
 */
const ALLOWED = [
  { path: 'tests/', reason: 'Test fixtures assert that fake credentials are redacted.' },
  {
    path: 'src/security/redaction/secret-redactor.ts',
    reason: 'Contains the detection patterns themselves.',
  },
  { path: 'scripts/scan-secrets.mjs', reason: 'This scanner.' },
  { path: 'package-lock.json', reason: 'Integrity hashes are not credentials.' },
  { path: 'docs/', reason: 'Documentation shows redacted examples.' },
];

// Detection patterns, mirroring src/security/redaction/secret-redactor.ts.
const PATTERNS = [
  { id: 'openai-key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{24,}/g },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{24,}/g },
  { id: 'google-api-key', re: /\bAIza[A-Za-z0-9_-]{30,45}/g },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{30,}/g },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{20,}/g },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'stripe-key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { id: 'pem-private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

function isAllowed(relativePath) {
  return ALLOWED.some((entry) => relativePath.startsWith(entry.path));
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

const findings = [];
let scanned = 0;

for (const file of walk(root)) {
  const rel = relative(root, file);
  if (isAllowed(rel)) continue;
  if (!SCAN_EXTENSIONS.has(extname(file))) continue;

  scanned += 1;
  const lines = readFileSync(file, 'utf8').split('\n');

  lines.forEach((line, index) => {
    for (const { id, re } of PATTERNS) {
      re.lastIndex = 0;
      if (re.test(line)) findings.push({ file: rel, line: index + 1, id });
    }
  });
}

if (findings.length > 0) {
  console.error('✗ Credential-shaped values found in tracked source:\n');
  for (const finding of findings) {
    // The value itself is never printed.
    console.error(`  ${finding.file}:${finding.line} — matched "${finding.id}"`);
  }
  console.error('\nRemove the value and rotate the credential. Do not add an exclusion.');
  process.exit(1);
}

console.log(`✓ No credentials found in ${scanned} tracked files.`);
