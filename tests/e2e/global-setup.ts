/**
 * Fails fast when the extension has not been built, or when the Chromium the
 * fixtures expect is missing. Both produce confusing mid-test failures
 * otherwise.
 *
 * It also produces `dist-auth/`, a second bundle configured against the auth
 * fixture's HTTPS origin. The shipped bundle deliberately has no backend
 * origin — that is what makes sign-in absent by default — so the one spec
 * that exercises the sign-in protocol needs a build that has one. `dist/` is
 * never touched by it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROMIUM = process.env.E2E_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

export default function globalSetup(): void {
  const dist = resolve(import.meta.dirname, '../../dist');
  const required = ['manifest.json', 'service-worker.js', 'content-script.js'];

  for (const file of required) {
    const path = resolve(dist, file);
    if (!existsSync(path) || statSync(path).size === 0) {
      throw new Error(
        `dist/${file} is missing or empty. Run "npm run build" before the E2E suite.`,
      );
    }
  }

  // Built here rather than by a separate npm script, so a contributor running
  // `npx playwright test` gets it without knowing it exists.
  const root = resolve(import.meta.dirname, '../..');
  execFileSync('node', [resolve(root, 'scripts/build-auth-fixture.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });

  // An empty E2E_CHROMIUM_PATH means "let Playwright resolve its own browser",
  // which is what CI does after `playwright install`.
  if (CHROMIUM.length > 0 && !existsSync(CHROMIUM)) {
    throw new Error(
      `No Chromium at ${CHROMIUM}. Set E2E_CHROMIUM_PATH to a Chromium binary that ` +
        'supports extensions, or to an empty string to use Playwright\u2019s own.',
    );
  }
}
