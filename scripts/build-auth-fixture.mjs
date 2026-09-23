#!/usr/bin/env node
/**
 * Builds a second extension bundle configured against the E2E auth fixture.
 *
 * The backend origin is inlined by Vite at build time — deliberately, so it
 * cannot be set from a message — which means a build with no origin has no
 * sign-in at all. That is the right production behaviour and it makes the
 * sign-in path untestable in a real browser without a build that has one.
 *
 * So this produces exactly one extra bundle, in `dist-auth/`, pointed at the
 * fixture's HTTPS origin. It never touches `dist/`: the shipped build stays
 * unconfigured, and every other E2E spec keeps running against it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist-auth');

// Must match AUTH_BACKEND_PORT in tests/e2e/fixtures/auth-backend.ts.
const ORIGIN = 'https://localhost:8443';

if (existsSync(out)) rmSync(out, { recursive: true, force: true });

execFileSync('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_ABA_BACKEND_ORIGIN: ORIGIN },
});

execFileSync('npx', ['vite', 'build', '--config', 'vite.content.config.ts', '--outDir', out], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_ABA_BACKEND_ORIGIN: ORIGIN },
});

if (!existsSync(resolve(out, 'manifest.json'))) {
  console.error('\n✗ dist-auth/manifest.json is missing after the build.');
  process.exit(1);
}
console.log(`\n✓ Auth fixture build ready at dist-auth/ (backend ${ORIGIN})`);
