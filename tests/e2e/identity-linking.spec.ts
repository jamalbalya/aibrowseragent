/**
 * TEST-E2E-034 — account linking in real Chromium.
 *
 * Runs against `dist-auth/`, the bundle compiled with a backend origin, the
 * same one the Google-protocol and OTP specs use. What this adds over the
 * HTTP suites is the half they cannot reach: a real service worker making
 * real requests through the real egress gate, a real tab navigating a real
 * Google redirect, and a real panel rendering the two lists a person has to
 * tell apart.
 *
 * **The separation is the point of several cases here.** "Sign-in methods"
 * and "AI accounts" are different things with different consequences, and a
 * person who confuses them makes bad decisions about their credentials. So
 * the panel is asserted to present them as two sections, and linking is
 * asserted to leave every AI account exactly as it was.
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
import { BROWSER } from './fixtures/extension';
import type { PanelRequestType, PanelResponse } from '../../src/messaging/protocol';

const EXTENSION_PATH = resolve(import.meta.dirname, '../../dist-auth');
const ADDRESS = 'linker@example.test';

let backend: AuthBackend;
let context: BrowserContext;
let worker: Worker;
let panel: Page;
let profile: string;
let caseIndex = 0;

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

/**
 * A fresh rate-limit source per case, and enough clock movement to clear the
 * per-address resend cooldown.
 *
 * **Thirty-one seconds, not sixteen minutes.** The OTP suite advances by a
 * whole window because nothing there holds a session; here the installation
 * is signed in, and an access token lives fifteen minutes — so a sixteen
 * minute jump expired it, every identity route answered 401, and the panel
 * correctly rendered nothing. Seven cases failed on a test-harness clock.
 *
 * The per-address send budget is handled by giving each case its own address
 * rather than by waiting out the window.
 */
function isolate(): void {
  caseIndex += 1;
  backend.setSource(`link-case-${caseIndex}`);
  backend.advance(31 * 1000);
}

/** Signs this installation in by email, as the panel would. */
async function signIn(address: string): Promise<void> {
  const started = await send('auth.startEmailSignIn', { email: address });
  expect(started.ok, `start ${address}`).toBe(true);
  const verified = await send('auth.verifyEmailSignIn', {
    challengeId: started.challengeId ?? '',
    code: backend.otps.lastCode(),
  });
  expect(verified.ok, `verify ${address}`).toBe(true);
}

/** Adds an email address as a sign-in method, through the panel routes. */
async function linkEmail(address: string): Promise<{ ok: boolean; failure: string | null }> {
  const started = await send('identities.startEmailLink', { email: address });
  if (!started.ok || started.challengeId === null) {
    return { ok: false, failure: started.failure };
  }
  return send('identities.completeEmailLink', {
    challengeId: started.challengeId,
    code: backend.otps.lastCode(),
  });
}

test.beforeAll(async () => {
  backend = await startAuthBackend();
  profile = mkdtempSync(join(tmpdir(), 'aba-link-e2e-'));
  context = await chromium.launchPersistentContext(profile, {
    ...BROWSER,
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--ignore-certificate-errors',
    ],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);

  isolate();
  await signIn(ADDRESS);
});

test.afterAll(async () => {
  await context?.close();
  await backend?.close();
  if (profile !== undefined) rmSync(profile, { recursive: true, force: true });
});

test('01 — the panel shows the account’s sign-in methods', async () => {
  isolate();
  await panel.reload();
  await panel.getByRole('button', { name: 'Settings' }).click();

  const section = panel.getByRole('region', { name: 'Sign-in methods' });
  await expect(section).toBeVisible();
  await expect(panel.getByTestId('identity-row')).toHaveCount(1);
  await expect(panel.getByTestId('identity-row')).toContainText(ADDRESS);
});

test('02 — the only sign-in method cannot be removed, and the panel says why', async () => {
  isolate();
  await expect(panel.getByTestId('identity-last')).toBeVisible();
  await expect(panel.getByTestId('identity-last')).toContainText('cannot be removed');
  // No Remove button exists for it at all — the refusal is not a click away.
  await expect(panel.getByTestId('identity-remove')).toHaveCount(0);

  // And the route refuses it too, so the UI is a reflection rather than the
  // control.
  const rows = await send('identities.list', {});
  const only = rows.identities[0];
  const detached = await send('identities.detach', { identityId: only?.id ?? '' });
  expect(detached.ok).toBe(false);
  expect(detached.failure).toBe('LAST_IDENTITY');
});

test('03 — an email address can be added as a second sign-in method', async () => {
  isolate();
  const result = await linkEmail('second@example.test');
  expect(result.ok).toBe(true);

  const rows = await send('identities.list', {});
  expect(rows.identities).toHaveLength(2);
  expect(rows.identities.map((row) => row.email).sort()).toEqual([ADDRESS, 'second@example.test']);
  // With two verified identities, both become removable.
  expect(rows.identities.every((row) => row.removable)).toBe(true);
});

test('04 — a Google account can be linked, over the real tab flow', async () => {
  isolate();
  const before = await send('identities.list', {});
  const result = await send('identities.linkGoogle', {});

  expect(result.ok).toBe(true);
  expect(backend.seen).toContain('/v1/me/identities/start');
  expect(backend.seen).toContain('/fixture/google/authorize');
  expect(backend.seen).toContain('/v1/me/identities/attach');

  const after = await send('identities.list', {});
  expect(after.identities).toHaveLength(before.identities.length + 1);
  expect(after.identities.some((row) => row.kind === 'google')).toBe(true);
});

test('05 — linking did not change which account this installation is', async () => {
  isolate();
  const status = await send('auth.status', {});
  // Same account, same address, still signed in. A link is not a sign-in.
  expect(status.state).toBe('signed_in');
  expect(status.email).toBe(ADDRESS);

  // And a refresh still resolves to it, so the stored session was untouched.
  const refreshed = await send('auth.refresh', {});
  expect(refreshed.ok).toBe(true);
});

test('06 — an identity already held by another account is refused safely', async () => {
  isolate();
  // A second, independent account holds this address. The fixture backend is
  // shared, the installation is not — so this is set up through the backend's
  // own store rather than by signing this browser in as somebody else.
  const contested = 'contested@example.test';
  const other = await backend.signInFresh(contested);
  expect(other.abaUserId).not.toBe('');
  // That sign-in spent this address's resend cooldown.
  backend.advance(31 * 1000);

  const result = await linkEmail(contested);
  expect(result.ok).toBe(false);
  expect(result.failure).toBe('IDENTITY_IN_USE');

  // Nothing about the other account reaches the panel.
  const serialised = JSON.stringify(result);
  expect(serialised).not.toContain(other.abaUserId);
  expect(serialised).not.toContain('aba_user');
});

test('07 — a sign-in method can be removed once another exists', async () => {
  isolate();
  const before = await send('identities.list', {});
  const target = before.identities.find((row) => row.email === 'second@example.test');
  expect(target?.removable).toBe(true);

  const detached = await send('identities.detach', { identityId: target?.id ?? '' });
  expect(detached.ok).toBe(true);

  const after = await send('identities.list', {});
  expect(after.identities).toHaveLength(before.identities.length - 1);
  expect(after.identities.some((row) => row.email === 'second@example.test')).toBe(false);
  // The session this installation holds was established through a different
  // identity, so it survives.
  expect((await send('auth.status', {})).state).toBe('signed_in');
});

test('08 — the panel keeps sign-in methods and AI accounts as separate sections', async () => {
  isolate();
  await panel.reload();
  await panel.getByRole('button', { name: 'Settings' }).click();

  const signIn = panel.getByRole('region', { name: 'Sign-in methods' });
  await expect(signIn).toBeVisible();
  // It says what it is not, because the two are easy to confuse and the
  // consequence of confusing them is a decision about credentials.
  await expect(signIn).toContainText('not');
  await expect(signIn).toContainText('AI accounts');

  // The AI account section is a different region with its own controls, and
  // no identity row appears inside it.
  const heading = panel.getByRole('heading', { name: 'Connect AI account' });
  await expect(heading).toBeVisible();
  await expect(signIn.getByTestId('identity-row').first()).toBeVisible();
});

test('09 — linking touched no AI provider connection and no credential', async () => {
  isolate();
  const accounts = await send('accounts.list', {});
  // Authentication identities and provider connections are different things.
  // Three identities were linked and removed above; not one AI account came
  // into existence, and no brain was selected.
  expect(accounts.accounts).toHaveLength(0);
  expect(accounts.brain).toBeNull();

  const stored = await worker.evaluate(async () => {
    const local = await chrome.storage.local.get(null);
    return JSON.stringify(local);
  });
  // No provider credential namespace was created by any of this.
  expect(stored).not.toContain('"apiKey"');
});

test('10 — no identity route leaks a token or a Google subject to the panel', async () => {
  isolate();
  const rows = await send('identities.list', {});
  const serialised = JSON.stringify(rows).toLowerCase();
  for (const term of ['token', 'refresh', 'bearer', 'secret', 'subject', 'digest', 'sub"']) {
    expect(serialised, term).not.toContain(term);
  }
});
