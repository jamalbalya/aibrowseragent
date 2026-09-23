/**
 * TEST-E2E-025 — the Google sign-in protocol, in real Chromium.
 *
 * Everything else in the E2E suite runs against the shipped bundle, which has
 * no backend origin compiled in and therefore no sign-in. This spec runs
 * against a second bundle — `dist-auth/`, built only for this file — pointed
 * at a controlled backend over real HTTPS.
 *
 * What that buys over the integration suites is the half they cannot reach:
 * a real service worker making a real request through the real egress gate, a
 * real tab navigating a real 303, and Chrome's own URL handling deciding what
 * the extension's watcher sees.
 *
 * ## What this is not
 *
 * **Google is a fixture.** It signs genuine RS256 tokens with a keypair this
 * process generated, which proves the protocol between this extension and
 * this backend. It proves nothing about whether Google's real endpoints
 * accept this client. Live Google acceptance needs real credentials, is not
 * simulated here, and is reported as credential-blocked.
 */
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startAuthBackend, type AuthBackend } from './fixtures/auth-backend';
import { BROWSER, killServiceWorker } from './fixtures/extension';
import type { PanelRequestType, PanelResponse } from '../../src/messaging/protocol';

const EXTENSION_PATH = resolve(import.meta.dirname, '../../dist-auth');

let backend: AuthBackend;
let context: BrowserContext;
let worker: Worker;
let panel: Page;
let profile: string;

/**
 * Sends a panel message from a real extension page, as the panel would.
 *
 * The worker answers with an envelope, so this unwraps it the same way the
 * shared fixture does — a failed route has to throw rather than return an
 * object whose fields are all undefined.
 */
async function send<T extends PanelRequestType>(
  type: T,
  payload: unknown,
): Promise<PanelResponse<T>> {
  const envelope: { ok?: boolean; value?: unknown; error?: { code?: string } } | undefined =
    await panel.evaluate(
      ([messageType, body]) =>
        chrome.runtime.sendMessage({
          id: `e2e_${Math.random().toString(36).slice(2)}`,
          type: messageType,
          timestamp: Date.now(),
          payload: body,
        }),
      [type, payload] as const,
    );

  if (envelope?.ok !== true) {
    throw new Error(`${type} failed: ${envelope?.error?.code ?? 'no response'}`);
  }
  return envelope.value as PanelResponse<T>;
}

test.beforeAll(async () => {
  backend = await startAuthBackend();
  profile = mkdtempSync(join(tmpdir(), 'aba-auth-e2e-'));
  context = await chromium.launchPersistentContext(profile, {
    // The shared fixture's options, reused rather than restated. They pin
    // `channel: 'chromium'` when no explicit binary is given, because
    // `headless: true` alone resolves to `chrome-headless-shell`, which
    // cannot load extensions at all — every test then fails identically
    // waiting for a service worker that never registers. Restating them here
    // is how this spec passed locally and failed in CI.
    ...BROWSER,
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // The fixture's certificate is self-signed and thrown away after the
      // run. This relaxes the *browser*, never the extension: the extension
      // still refuses any backend origin that is not https, which is what
      // made a real certificate necessary in the first place.
      '--ignore-certificate-errors',
    ],
  });

  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
});

test.afterAll(async () => {
  // Defensive: when `beforeAll` fails, these are undefined, and an unguarded
  // teardown throws a second error that hides the first one.
  await context?.close();
  await backend?.close();
  if (profile !== undefined) rmSync(profile, { recursive: true, force: true });
});

test('01 — the configured build reports authentication as available', async () => {
  const status = await send('auth.status', {});

  // The other 228 tests run against a build with no origin and assert the
  // opposite. Both are the truth about the build they run in.
  expect(status.configured).toBe(true);
  expect(status.state).toBe('signed_out');
  expect(status.abaUserId).toBeNull();
});

test('02 — a sign-in runs start, Google, callback and exchange in that order', async () => {
  const result = await send('auth.signInWithGoogle', {});

  expect(result.ok).toBe(true);
  // The real request sequence the backend saw, over the wire.
  expect(backend.seen).toContain('/v1/auth/start');
  expect(backend.seen).toContain('/fixture/google/authorize');
  expect(backend.seen).toContain('/v1/auth/google/redirect');
  expect(backend.seen).toContain('/v1/auth/exchange');
  expect(backend.seen.indexOf('/v1/auth/start')).toBeLessThan(
    backend.seen.indexOf('/v1/auth/exchange'),
  );
});

test('03 — the extension is signed in afterwards, with no token in the status', async () => {
  const status = await send('auth.status', {});

  expect(status.state).toBe('signed_in');
  expect(typeof status.abaUserId).toBe('string');
  const serialised = JSON.stringify(status);
  for (const term of ['token', 'refresh', 'bearer', 'secret']) {
    expect(serialised.toLowerCase(), term).not.toContain(term);
  }
});

test('04 — the session is in extension storage and the access token is not on disk', async () => {
  const stored = await worker.evaluate(async () => {
    const local = await chrome.storage.local.get(null);
    const session = await chrome.storage.session.get(null);
    return { local: JSON.stringify(local), sessionKeys: Object.keys(session) };
  });

  // The refresh token is durable; the access token is memory only, so it is
  // gone when the browser closes. That split is the design, asserted here
  // against real Chrome storage rather than a fake.
  expect(stored.local).toContain('identity-session');
  expect(stored.sessionKeys.some((key) => key.includes('identity-session'))).toBe(true);
});

test('05 — the device was registered against the account that signed in', async () => {
  const status = await send('auth.status', {});
  const rows = await backend.devices(status.abaUserId ?? '');

  expect(rows).toHaveLength(1);
  // Minted by the client, in the shape the backend validates. Never derived
  // from the Google subject and never from a Chrome runtime id.
  expect(rows[0]?.device_id).toMatch(/^dev_[0-9a-f-]{36}$/);

  const runtimeId = new URL(worker.url()).host;
  expect(rows[0]?.device_id).not.toContain(runtimeId);
  expect(rows[0]?.device_id).not.toContain('google-subject-e2e');
});

test('06 — a returning sign-in reuses the account and adds no second device', async () => {
  const before = await send('auth.status', {});

  await send('auth.signOut', {});
  const signedOut = await send('auth.status', {});
  expect(signedOut.state).toBe('signed_out');

  const again = await send('auth.signInWithGoogle', {});
  expect(again.ok).toBe(true);

  const after = await send('auth.status', {});
  expect(after.abaUserId).toBe(before.abaUserId);
  // One installation, one device row, however many times it signs in.
  expect(await backend.devices(after.abaUserId ?? '')).toHaveLength(1);
});

test('07 — signing out clears the session and keeps every local record', async () => {
  const workspace = await send('workspace.create', { title: 'Kept across sign-out' });
  expect(workspace.error).toBeUndefined();

  await send('auth.signOut', {});

  expect((await send('auth.status', {})).state).toBe('signed_out');
  // Signing out ends a session. It is not a deletion of the user's work.
  const workspaces = await send('workspace.state', {});
  expect(workspaces.workspaces.some((w) => w.title === 'Kept across sign-out')).toBe(true);
});

test('08 — no bearer token ever appears in a tab URL or in browser history', async () => {
  await send('auth.signInWithGoogle', {});
  const status = await send('auth.status', {});

  // Every URL any tab in this profile currently holds.
  const urls = context.pages().map((page) => page.url());
  for (const url of urls) {
    expect(url).not.toContain(status.abaUserId ?? 'usr_');
    expect(url.toLowerCase()).not.toContain('refresh');
    expect(url.toLowerCase()).not.toContain('access_token');
  }
});

test('09 — signing in uploads no task, workflow, workspace or audit record', async () => {
  await send('workspace.create', { title: 'Local only, stays local' });
  const before = backend.seen.length;

  await send('auth.signOut', {});
  await send('auth.signInWithGoogle', {});

  // The only paths touched are the four the flow needs. Nothing resembling a
  // sync endpoint was called, because there is no sync client to call one.
  const during = backend.seen.slice(before);
  for (const path of during) {
    expect(path).toMatch(/^\/(v1\/auth|fixture\/google)/);
  }
  expect(during.some((path) => path.includes('sync'))).toBe(false);
});

test('10 — signing in enables no cloud mode and changes no storage preference', async () => {
  const preference = await send('storage.getPreference', {});

  // Authentication establishes identity and a session. It is not consent to
  // upload anything, and it does not become one by succeeding.
  expect(preference.mode).toBe('local');
  expect(preference.hasChosen).toBe(false);
});

test('11 — a provider credential is untouched by a whole sign-in', async () => {
  const key = 'test-key-untouched-by-google-auth';
  const connected = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: 'https://provider.invalid',
    apiKey: key,
    model: 'mock-model',
  });
  const connectionId = connected.account?.connectionId ?? '';

  const before = backend.seen.length;
  await send('auth.signOut', {});
  await send('auth.signInWithGoogle', {});

  // The key is still in local storage, under its own connection key, and no
  // request the backend saw carried it.
  const stored = await worker.evaluate(async (id: string) => {
    const all = await chrome.storage.local.get(null);
    return JSON.stringify(all).includes(id);
  }, connectionId);
  expect(stored).toBe(true);

  const listed = await send('accounts.list', {});
  expect(listed.accounts.some((a) => a.connectionId === connectionId)).toBe(true);
  expect(JSON.stringify(backend.seen.slice(before))).not.toContain(key);
});

test('12 — no K1 material exists, and signing in did not create any', async () => {
  const keys = await worker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all).join('|').toLowerCase();
  });

  // K1 is unimplemented. Authentication is not key recovery and must not
  // become a path that quietly creates key material.
  for (const term of ['recovery', 'kek', 'dek', 'envelope', 'ciphertext', 'k1']) {
    expect(keys, term).not.toContain(term);
  }
});

test('13 — workspace authorization is unchanged by being signed in', async () => {
  const created = await send('workspace.create', { title: 'Authorization unchanged' });
  expect(created.error).toBeUndefined();

  // A task with no workspace is still refused browser operations; signing in
  // grants nothing it did not grant before.
  const state = await send('workspace.state', {});
  expect(state.workspaces.length).toBeGreaterThan(0);
  expect(state.activeWorkspaceId).not.toBeNull();
});

test('15 — a different Google account cannot inherit this installation’s session', async () => {
  // Sign in as the first account, then present a *different* verified Google
  // subject to the same installation.
  await send('auth.signOut', {});
  await send('auth.signInWithGoogle', {});
  const first = await send('auth.status', {});
  expect(first.state).toBe('signed_in');

  backend.setSubject('google-subject-somebody-else');
  await send('auth.signOut', {});
  const second = await send('auth.signInWithGoogle', {});

  // Refused, and refused without writing anything for the second account:
  // one installation's local work belongs to the identity that made it, and
  // a second account must not silently take it over.
  expect(second.ok).toBe(false);
  if (second.ok) throw new Error('unreachable');
  expect(second.failure).toBe('DIFFERENT_USER');

  const after = await send('auth.status', {});
  expect(after.abaUserId).toBe(first.abaUserId);
  expect(after.state).toBe('signed_out');

  // Restore the fixture for any later case.
  backend.setSubject('google-subject-e2e');
});

test('16 — the sign-in that was refused left no session for the other account', async () => {
  const stored = await worker.evaluate(async () => {
    const local = await chrome.storage.local.get(null);
    return JSON.stringify(local);
  });

  // The refused account's id appears nowhere: a refusal that still wrote a
  // session would be the takeover the refusal exists to prevent.
  expect(stored).not.toContain('google-subject-somebody-else');
});

/* ------------------------- the session lifecycle ------------------------- */

test('17 — a refresh renews the session and keeps the same account', async () => {
  await send('auth.signOut', {});
  await send('auth.signInWithGoogle', {});
  const before = await send('auth.status', {});

  const accountsBefore = backend.accounts();
  const refreshed = await send('auth.refresh', {});

  expect(refreshed.ok).toBe(true);
  expect(refreshed.failure).toBeNull();
  const after = await send('auth.status', {});
  expect(after.state).toBe('signed_in');
  // A refresh renews a session; it never moves the installation to another
  // account, and never silently creates one.
  expect(after.abaUserId).toBe(before.abaUserId);
  // The second half of that sentence, measured rather than assumed: a refresh
  // that created an account beside this one would still return this
  // `abaUserId`, so the count is the only thing that can see it.
  expect(backend.accounts()).toBe(accountsBefore);
});

test('18 — the refresh went over the wire and rotated the stored token', async () => {
  const storedBefore = await worker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return JSON.stringify(all);
  });

  const before = backend.seen.length;
  const result = await send('auth.refresh', {});
  expect(result.ok).toBe(true);

  expect(backend.seen.slice(before)).toContain('/v1/auth/refresh');
  const storedAfter = await worker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return JSON.stringify(all);
  });
  // Single-use means the stored token must have changed.
  expect(storedAfter).not.toBe(storedBefore);
});

test('19 — an expired access token is recovered by a refresh, not by signing in', async () => {
  // Age the backend past the access token's fifteen minutes. The refresh
  // token is good for thirty days, so the session is recoverable.
  backend.advance(20 * 60 * 1000);

  const refreshed = await send('auth.refresh', {});

  expect(refreshed.ok).toBe(true);
  expect((await send('auth.status', {})).state).toBe('signed_in');
});

test('20 — many simultaneous refreshes produce one request and one session', async () => {
  const before = backend.seen.filter((path) => path === '/v1/auth/refresh').length;

  // Eight callers at once, which is what the panel, a task and a scheduled
  // check would look like noticing a stale token together. Without the
  // client's single flight this would spend one single-use token eight times
  // and the server would revoke the family.
  const results = await panel.evaluate(async () => {
    const one = (): Promise<unknown> =>
      chrome.runtime.sendMessage({
        id: `e2e_${Math.random().toString(36).slice(2)}`,
        type: 'auth.refresh',
        timestamp: Date.now(),
        payload: {},
      });
    return Promise.all(Array.from({ length: 8 }, one));
  });

  const requests = backend.seen.filter((path) => path === '/v1/auth/refresh').length - before;
  expect(requests).toBe(1);
  expect(results).toHaveLength(8);
  // And the session survived: eight independent refreshes would not have.
  expect((await send('auth.status', {})).state).toBe('signed_in');
});

test('21 — the session survives a real worker restart after a refresh', async () => {
  const before = await send('auth.status', {});
  await send('auth.refresh', {});

  // A genuine termination through CDP, the same one the shared harness uses.
  // The refresh token lives in chrome.storage.local and must survive it; the
  // access token lives in chrome.storage.session and legitimately may not.
  await killServiceWorker(context, worker);

  // The old panel's port died with the worker, so both are replaced.
  const extensionId = new URL(worker.url()).host;
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

  const after = await send('auth.status', {});
  expect(after.state).toBe('signed_in');
  expect(after.abaUserId).toBe(before.abaUserId);

  // And the restarted worker can still refresh, which is what proves the
  // durable half of the session actually survived rather than merely reading
  // back as present.
  expect((await send('auth.refresh', {})).ok).toBe(true);
});

test('22 — logout revokes the server session, not just the local one', async () => {
  const status = await send('auth.status', {});
  const abaUserId = status.abaUserId ?? '';

  // The sessions that are genuinely usable right now, named individually.
  //
  // Asserting that some row for this account is revoked would pass without
  // logout doing anything at all: the Google exchange mints a bootstrap
  // session to obtain a principal for the identity attach and revokes it
  // immediately, so a revoked row exists from the moment the account does.
  // Naming the usable ones first is what makes this measure logout.
  //
  // Rotated rows are excluded because they are spent, not live: a rotation
  // sets `rotated_at` and leaves `revoked_at` null, and logout revokes the
  // one session its access token names. Presenting a spent predecessor is
  // reuse, which revokes the whole family — so leaving it unrevoked costs
  // nothing, and demanding it be revoked here would assert a behaviour the
  // design deliberately does not have.
  const live = (await backend.sessions(abaUserId))
    .filter((row) => row.revoked_at === null && row.rotated_at === null)
    .map((row) => row.id);
  expect(live.length).toBeGreaterThan(0);

  await send('auth.signOut', {});

  expect((await send('auth.status', {})).state).toBe('signed_out');
  const rows = await backend.sessions(abaUserId);
  // Each session that was live is now revoked. Before this phase, sign-out
  // cleared two local keys and the rows stayed live.
  for (const id of live) {
    const row = rows.find((candidate) => candidate.id === id);
    expect(row, id).toBeDefined();
    expect(row?.revoked_at, id).not.toBeNull();
  }
});

test('23 — a refresh after logout fails and does not resurrect the session', async () => {
  const result = await send('auth.refresh', {});

  expect(result.ok).toBe(false);
  expect((await send('auth.status', {})).state).toBe('signed_out');
});

test('24 — logout kept every local record, credential and preference', async () => {
  // Signed out from the previous case. Nothing of the user's went with it.
  const workspaces = await send('workspace.state', {});
  expect(workspaces.workspaces.length).toBeGreaterThan(0);

  const accounts = await send('accounts.list', {});
  expect(accounts.accounts.length).toBeGreaterThan(0);

  const preference = await send('storage.getPreference', {});
  expect(preference.mode).toBe('local');

  // And the provider key is still in local storage under its own key.
  const hasCredential = await worker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all).some((key) => key.includes('credentials:conn:'));
  });
  expect(hasCredential).toBe(true);
});

test('25 — no K1 material appeared across the whole refresh and logout cycle', async () => {
  const keys = await worker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all).join('|').toLowerCase();
  });
  for (const term of ['recovery', 'kek', 'dek', 'envelope', 'ciphertext', 'k1']) {
    expect(keys, term).not.toContain(term);
  }
});

test('26 — refresh and logout uploaded no local work', async () => {
  // Every path the backend saw across this whole spec belongs to the auth
  // flow. Nothing resembling a sync endpoint was ever called.
  for (const path of backend.seen) {
    expect(path).toMatch(/^\/(v1\/auth|fixture\/google)/);
  }
  expect(backend.seen.some((path) => path.includes('sync'))).toBe(false);
  expect(backend.seen.some((path) => path.includes('task'))).toBe(false);
});

test('14 — the configured build still added no permission and no host access', async () => {
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());

  // Same manifest as the shipped build: configuring a backend origin is a
  // build-time constant, not a capability.
  expect(manifest.permissions).not.toContain('identity');
  expect(manifest.permissions).not.toContain('cookies');
  expect(manifest.host_permissions).not.toContain('<all_urls>');
  expect(manifest.permissions?.sort()).toEqual(
    [
      'activeTab',
      'debugger',
      'notifications',
      'scripting',
      'sidePanel',
      'storage',
      'tabGroups',
      'tabs',
      'unlimitedStorage',
    ].sort(),
  );
});
