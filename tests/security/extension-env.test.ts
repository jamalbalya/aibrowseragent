/**
 * TEST-SECURITY-078 — the extension's build-time configuration.
 *
 * ## The failure this file exists to prevent
 *
 * An owner follows `OWNER-CHECKLIST.md` G-6, registers a Google OAuth client,
 * sets `VITE_ABA_GOOGLE_PROVIDER_CLIENT_ID`, rebuilds, loads the extension,
 * presses *Connect with Google*, and reads *"this build carries no Google OAuth
 * client id"*. Which is true — the value had a typo — and reads as though the
 * variable had never been set.
 *
 * Failing closed at run time is right: a value that is not a Google client id
 * would send the user to an authorization screen that refuses them. What was
 * missing is anybody saying so at the moment the person who set it is
 * watching. So the build refuses a value that is present and unusable, and
 * reports an absent one as the ordinary state it is.
 *
 * ## Why one of these cases is unusual
 *
 * `scripts/check-extension-env.mjs` is plain Node and deliberately holds its
 * own copy of two predicates, because it has to run standalone — before and
 * without a build — while the run-time rules live in TypeScript. Two copies of
 * one rule is what this project normally refuses. The drift is closed from the
 * other side: group 03 drives **both** implementations over one shared table of
 * inputs and fails if either side changes alone.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  inspectClientId,
  parseQuotaProject,
  googleRedirectUri,
} from '@/providers/oauth/provider-auth-config';
import {
  clientIdProblem,
  quotaProjectProblem,
  backendOriginProblem,
  inspect,
  // @ts-expect-error — a build script, plain JS, imported here so the rules it
  // enforces are exercised rather than re-implemented. The same arrangement
  // `release-claims.test.ts` and `clause-gate.test.ts` use.
} from '../../scripts/check-extension-env.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const GOOD_CLIENT = '123456789-abcdefgh.apps.googleusercontent.com';

describe('01 — a client id that is set and unusable is refused, not ignored', () => {
  it('accepts a Google client id and trims it', () => {
    expect(inspectClientId(GOOD_CLIENT)).toEqual({ ok: true, clientId: GOOD_CLIENT });
    expect(inspectClientId(`  ${GOOD_CLIENT}  `)).toEqual({ ok: true, clientId: GOOD_CLIENT });
  });

  it('separates absent from malformed, because the fixes differ', () => {
    // Absent is the ordinary state: every published build so far. Malformed is
    // somebody mid-way through G-6 with a typo, and telling them "not
    // configured" sends them to set a variable they already set.
    for (const absent of [undefined, null, '', '   ', 42]) {
      expect(inspectClientId(absent), String(absent)).toEqual({ ok: false, problem: 'absent' });
    }
    for (const wrong of [
      'oops',
      '123456789',
      'https://accounts.google.com',
      // The suffix in the wrong place, which a copy-paste from a console can
      // produce.
      '.apps.googleusercontent.com.evil.test',
    ]) {
      expect(inspectClientId(wrong), wrong).toEqual({
        ok: false,
        problem: 'not_a_google_client_id',
      });
    }
  });

  it('fails the build for a malformed value and passes for an absent one', () => {
    expect(inspect({}).failed).toEqual([]);
    expect(inspect({ VITE_ABA_GOOGLE_PROVIDER_CLIENT_ID: GOOD_CLIENT }).failed).toEqual([]);

    const refused = inspect({ VITE_ABA_GOOGLE_PROVIDER_CLIENT_ID: 'oops' }).failed;
    expect(refused).toHaveLength(1);
    // The message names the fix and where it is written down.
    expect(refused[0]).toMatch(/apps\.googleusercontent\.com/);
    expect(refused[0]).toMatch(/G-6/);
  });

  it('says what it decided even when nothing is configured', () => {
    // Silence would be the worst outcome: an owner cannot tell a build that
    // ignored their value from one that read it.
    const { found } = inspect({});
    expect(found.join(' ')).toMatch(/NOT configured/);
    expect(found.join(' ')).toMatch(/API key path/);
  });

  it('reports the quota project, and warns when a configured client has none', () => {
    const configured = inspect({ VITE_ABA_GOOGLE_PROVIDER_CLIENT_ID: GOOD_CLIENT });
    expect(configured.found.join(' ')).toMatch(/no quota project set/);
    expect(configured.failed).toEqual([]);

    const both = inspect({
      VITE_ABA_GOOGLE_PROVIDER_CLIENT_ID: GOOD_CLIENT,
      VITE_ABA_GOOGLE_QUOTA_PROJECT: 'my-project-1',
    });
    expect(both.found.join(' ')).toMatch(/quota project my-project-1/);
    expect(both.failed).toEqual([]);
  });

  it('refuses a backend origin that is not https', () => {
    expect(inspect({ VITE_ABA_BACKEND_ORIGIN: 'http://backend.test' }).failed).toHaveLength(1);
    expect(inspect({ VITE_ABA_BACKEND_ORIGIN: 'not a url' }).failed).toHaveLength(1);
    expect(inspect({ VITE_ABA_BACKEND_ORIGIN: 'https://backend.test' }).failed).toEqual([]);
  });
});

describe('02 — a quota project travels in a header, so it is checked', () => {
  it('accepts a project id and a project number', () => {
    expect(parseQuotaProject('my-project-1')).toBe('my-project-1');
    expect(parseQuotaProject('123456789012')).toBe('123456789012');
    expect(parseQuotaProject('  my-project-1  ')).toBe('my-project-1');
  });

  it('refuses anything that could not be a project', () => {
    for (const bad of [
      undefined,
      '',
      'My-Project',
      '-leading-hyphen',
      'trailing-hyphen-',
      'tiny',
      'a'.repeat(40),
      'project with spaces',
      'project/../other',
    ]) {
      expect(parseQuotaProject(bad), String(bad)).toBeNull();
    }
  });

  it('refuses a value that would inject a header', () => {
    // The reason this is validated at all rather than passed through: it is
    // concatenated into a request header.
    for (const injected of [
      'project\r\nX-Goog-Api-Key: stolen',
      'project\nAuthorization: Bearer x',
      'project\u0000',
    ]) {
      expect(parseQuotaProject(injected), JSON.stringify(injected)).toBeNull();
    }
  });
});

describe('03 — the build script and the run-time code agree', () => {
  it('reaches the same verdict on every input, from both implementations', () => {
    // `check-extension-env.mjs` is plain Node and holds its own copy of these
    // rules so it can run before a build exists. This is what stops the two
    // copies drifting: one table, both implementations, and a failure if
    // either side changes alone.
    const clientIds: readonly [unknown, boolean][] = [
      [GOOD_CLIENT, true],
      [`  ${GOOD_CLIENT}  `, true],
      ['oops', false],
      ['', false],
      ['   ', false],
      [undefined, false],
      [42, false],
      ['.apps.googleusercontent.com.evil.test', false],
    ];
    for (const [input, usable] of clientIds) {
      expect(inspectClientId(input).ok, `run time: ${String(input)}`).toBe(usable);
      expect(clientIdProblem(input) === null, `build: ${String(input)}`).toBe(usable);
    }

    const projects: readonly [unknown, boolean][] = [
      ['my-project-1', true],
      ['123456789012', true],
      ['My-Project', false],
      ['-leading', false],
      ['tiny', false],
      ['', false],
      [undefined, false],
      ['project\r\nX: y', false],
    ];
    for (const [input, usable] of projects) {
      expect(parseQuotaProject(input) !== null, `run time: ${String(input)}`).toBe(usable);
      expect(quotaProjectProblem(input) === null, `build: ${String(input)}`).toBe(usable);
    }

    // And the third predicate, which has only a build-side implementation
    // because the run-time read lives in `identity-config.ts`.
    expect(backendOriginProblem('https://backend.test')).toBeNull();
    expect(backendOriginProblem('http://backend.test')).toBe('not_https');
  });
});

describe('04 — nothing configurable this way is a secret', () => {
  it('documents the two extension variables where a builder will look', () => {
    const example = readFileSync(resolve(ROOT, '.env.extension.example'), 'utf8');
    for (const name of [
      'VITE_ABA_GOOGLE_PROVIDER_CLIENT_ID',
      'VITE_ABA_GOOGLE_QUOTA_PROJECT',
      'VITE_ABA_BACKEND_ORIGIN',
    ]) {
      expect(example, name).toContain(name);
    }
    // And states the rule that makes the file safe to have at all.
    expect(example).toMatch(/NO SECRET BELONGS IN THIS FILE/);
    expect(example).toMatch(/inlined/i);
  });

  it('names no secret variable, because none can be configured this way', () => {
    // A `VITE_` secret is inlined into `dist/` and readable by anyone who
    // unzips the extension. The one that exists — the backend's Google client
    // secret — lives in `.env.example` and never reaches the extension.
    const example = readFileSync(resolve(ROOT, '.env.extension.example'), 'utf8');
    expect(example).not.toMatch(/VITE_[A-Z_]*SECRET/);
    expect(example).not.toMatch(/VITE_[A-Z_]*TOKEN/);
    expect(example).not.toMatch(/VITE_[A-Z_]*PASSWORD/);
  });

  it('is tracked by git, not merely present on this machine', () => {
    // **This was wrong once.** `.gitignore` excludes `.env.*` with a single
    // exception for `.env.example`, so `.env.extension.example` was ignored:
    // present locally, absent from a fresh clone, and the cases above would
    // have passed on the machine that wrote it and failed everywhere else.
    // Caught by reading the diff before committing; pinned here so the next
    // documentation file added beside it cannot repeat it.
    const ignored = spawnSync('git', ['check-ignore', '.env.extension.example'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    // `check-ignore` exits 1 when the path is NOT ignored, which is the state
    // this asserts.
    expect(ignored.status, ignored.stdout).toBe(1);
  });

  it('has no value filled in, so nothing is committed', () => {
    const example = readFileSync(resolve(ROOT, '.env.extension.example'), 'utf8');
    for (const line of example.split('\n')) {
      if (!line.startsWith('VITE_')) continue;
      expect(line, line).toMatch(/=$/);
    }
  });

  it('is checked by the build, not only available to be run', () => {
    const build = readFileSync(resolve(ROOT, 'scripts/build.mjs'), 'utf8');
    expect(build).toContain('check-extension-env.mjs');
    // Before the compile, so a refusal costs no build.
    expect(build.indexOf('check-extension-env.mjs')).toBeLessThan(
      build.indexOf("run(['vite', 'build']"),
    );
  });
});

describe('05 — the redirect is built from the live extension id', () => {
  it('produces Google’s virtual redirect for this extension', () => {
    expect(googleRedirectUri('abcdefghijklmnopabcdefghijklmnop')).toBe(
      'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/',
    );
  });

  it('is not stored, so two builds cannot share one id by accident', () => {
    // Google pins a Chrome Extension client to one extension id. An unpacked
    // build and a published one have different ids, and a stored redirect would
    // let one build send Google the other's — which Google refuses in a way
    // that reads as a user problem. Built from `chrome.runtime.id` instead.
    const worker = readFileSync(resolve(ROOT, 'src/background/service-worker.ts'), 'utf8');
    expect(worker).toContain('googleRedirectUri(chrome.runtime.id)');
  });
});
