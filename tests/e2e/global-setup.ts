/**
 * Fails fast when the extension has not been built, or when the Chromium the
 * fixtures expect is missing. Both produce confusing mid-test failures
 * otherwise.
 *
 * It also produces two fixture bundles, neither of which touches `dist/`:
 *
 * - `dist-auth/`, configured against the auth fixture's HTTPS origin. The
 *   shipped bundle deliberately has no backend origin — that is what makes
 *   sign-in absent by default — so the specs that exercise the sign-in
 *   protocol need a build that has one.
 * - `dist-downloads/`, the shipped bundle with `downloads` required rather
 *   than optional, so the granted download path can be driven without a
 *   permission dialog no test harness can answer. See the build script for
 *   why that is the honest way to reach it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
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

  /*
   * A *release* build in `dist/` is worse than no build at all, because the
   * suite runs and one test fails for a reason that looks like a code defect.
   *
   * `npm run release` narrows `web_accessible_resources` to https origins, on
   * purpose — a shipped extension has no business being reachable by redirect
   * from loopback. The connector suite then cannot land the OAuth callback,
   * because Chromium refuses the redirect with `net::ERR_BLOCKED_BY_CLIENT`
   * and attributes it to the *authorization* URL, which reads as "the mock
   * service is broken".
   *
   * This was diagnosed the long way once: a passing worktree at the previous
   * commit made it look like a regression, when the only variable was that
   * `npm run release` had been run in between to read the artifact's size.
   * The check turns ten minutes of bisecting into one sentence.
   */
  const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8')) as {
    web_accessible_resources?: readonly { matches?: readonly string[] }[];
  };
  const reachable = (manifest.web_accessible_resources ?? []).flatMap(
    (entry) => entry.matches ?? [],
  );
  if (!reachable.some((match) => match.startsWith('http://127.0.0.1'))) {
    throw new Error(
      'dist/ holds a RELEASE build: its web_accessible_resources are narrowed to https, so the ' +
        'connector suite cannot land the OAuth callback from the loopback mock. ' +
        'Run "npm run build" to restore the development bundle.',
    );
  }

  // Built here rather than by separate npm scripts, so a contributor running
  // `npx playwright test` gets them without knowing they exist.
  const root = resolve(import.meta.dirname, '../..');
  for (const script of ['build-auth-fixture.mjs', 'build-downloads-fixture.mjs']) {
    execFileSync('node', [resolve(root, `scripts/${script}`)], { cwd: root, stdio: 'inherit' });
  }

  // An empty E2E_CHROMIUM_PATH means "let Playwright resolve its own browser",
  // which is what CI does after `playwright install`.
  if (CHROMIUM.length > 0 && !existsSync(CHROMIUM)) {
    throw new Error(
      `No Chromium at ${CHROMIUM}. Set E2E_CHROMIUM_PATH to a Chromium binary that ` +
        'supports extensions, or to an empty string to use Playwright\u2019s own.',
    );
  }
}
