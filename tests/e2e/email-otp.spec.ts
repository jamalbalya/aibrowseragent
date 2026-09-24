/**
 * TEST-E2E-033 — email one-time-code sign-in, in real Chromium.
 *
 * Runs against `dist-auth/` — the same second bundle the Google protocol spec
 * uses, pointed at a controlled backend over real HTTPS — because the shipped
 * bundle has no backend origin compiled in and therefore no sign-in at all.
 *
 * What this adds over the integration suites is the half they cannot reach: a
 * real service worker making a real request through the real egress gate, real
 * Chrome storage deciding what is durable, and a real panel rendering the
 * state machine a person actually drives.
 *
 * ## What is controlled, and what that does not prove
 *
 * **The mail transport is a fixture.** It keeps the message instead of sending
 * it, which is the only way a test can read a code. That proves the flow
 * between this extension and this backend. It proves **nothing** about a live
 * mail provider: no delivery credential exists in this repository, none is
 * configured, and live delivery is reported as unconfigured rather than
 * claimed. Nothing here is an email-deliverability test and nothing here is
 * counted as one.
 *
 * **Nothing here bypasses authentication.** Every sign-in below goes through
 * the panel's own routes and the backend's own verification. No test reaches
 * into worker internals to mint a session, and none reads a code from
 * anywhere but the thing that stood in for the mail provider.
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
const ADDRESS = 'e2e.person@example.test';

let backend: AuthBackend;
let context: BrowserContext;
let worker: Worker;
let panel: Page;
let profile: string;

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
 * A fresh rate-limiting source and a fresh per-address window for each case.
 *
 * Both are needed, and finding out which was which cost four failures. The
 * source keeps one case's per-caller budget out of the next case's way. The
 * clock advance clears the per-address cooldown and the fifteen-minute send
 * window, which the source cannot: those are counted against the **address**,
 * deliberately, so that one attacker cannot lock a stranger out by spending
 * their allowance from a different source. Moving the backend's own clock is
 * what a person waiting would do, and it is the backend's clock that decides.
 */
let caseIndex = 0;
function isolate(): void {
  caseIndex += 1;
  backend.setSource(`e2e-case-${caseIndex}`);
  backend.advance(16 * 60 * 1000);
}

/** Asks for a code at a fresh address and returns the challenge and the code. */
async function request(address: string): Promise<{ challengeId: string; code: string }> {
  const started = await send('auth.startEmailSignIn', { email: address });
  expect(started.ok, `start for ${address}`).toBe(true);
  if (started.challengeId === null) throw new Error('no challenge id');
  return { challengeId: started.challengeId, code: backend.otps.lastCode() };
}

test.beforeAll(async () => {
  backend = await startAuthBackend();
  profile = mkdtempSync(join(tmpdir(), 'aba-otp-e2e-'));
  context = await chromium.launchPersistentContext(profile, {
    // The shared fixture's options, reused rather than restated: `headless:
    // true` alone resolves to `chrome-headless-shell`, which cannot load
    // extensions at all.
    ...BROWSER,
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Relaxes the *browser* for the fixture's throwaway certificate. The
      // extension still refuses any backend origin that is not https.
      '--ignore-certificate-errors',
    ],
  });

  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
});

test.afterAll(async () => {
  await context?.close();
  await backend?.close();
  if (profile !== undefined) rmSync(profile, { recursive: true, force: true });
});

test('01 — the panel offers email sign-in and shows the address step first', async () => {
  isolate();
  await panel.getByRole('button', { name: 'Settings' }).click();

  const account = panel.getByRole('region', { name: 'AI Browser Agent account' });
  await expect(account).toBeVisible();
  await expect(panel.getByTestId('auth-signed-out')).toBeVisible();
  await expect(panel.getByTestId('auth-email-input')).toBeVisible();
  // The code step is not rendered until a code has been asked for.
  await expect(panel.getByTestId('auth-code-input')).toHaveCount(0);
});

test('02 — asking for a code reaches the backend and returns no code', async () => {
  isolate();
  const started = await send('auth.startEmailSignIn', { email: ADDRESS });

  expect(started.ok).toBe(true);
  expect(typeof started.challengeId).toBe('string');
  expect(backend.seen).toContain('/v1/auth/email/start');

  // The code exists — the fixture has it — and the response does not.
  const code = backend.otps.lastCode();
  expect(code).toMatch(/^[0-9]{6}$/);
  expect(JSON.stringify(started)).not.toContain(code);
});

test('03 — a wrong code is refused and signs nobody in', async () => {
  isolate();
  const { challengeId, code } = await request('wrong.code@example.test');
  const wrong = code === '000000' ? '111111' : '000000';

  const result = await send('auth.verifyEmailSignIn', { challengeId, code: wrong });
  expect(result.ok).toBe(false);
  expect(result.failure).toBe('INVALID_CODE');
  expect(result.remainingAttempts).toBe(4);
  expect((await send('auth.status', {})).state).toBe('signed_out');
});

/**
 * **Every completed sign-in below uses one address, and that is not tidiness.**
 * This browser profile is one installation, and an installation remembers the
 * user it belongs to: signing in as somebody else is refused by the local
 * identity profile rather than silently overwriting, because overwriting would
 * strand every connected account bound to the previous id. Case 16 asserts
 * that refusal directly. The cases that never complete a sign-in use addresses
 * of their own, because nothing about them reaches the profile.
 */
test('04 — the right code signs in, over the real transport', async () => {
  isolate();
  const { challengeId, code } = await request(ADDRESS);

  const result = await send('auth.verifyEmailSignIn', { challengeId, code });
  expect(result.ok).toBe(true);
  expect(result.email).toBe(ADDRESS);
  expect(backend.seen).toContain('/v1/auth/email/verify');

  const status = await send('auth.status', {});
  expect(status.state).toBe('signed_in');
  expect(status.email).toBe(ADDRESS);
});

test('05 — the code is in no Chrome storage area, and the session is', async () => {
  isolate();
  const code = backend.otps.lastCode();
  const stored = await worker.evaluate(async () => {
    const local = await chrome.storage.local.get(null);
    const session = await chrome.storage.session.get(null);
    return { local: JSON.stringify(local), session: JSON.stringify(session) };
  });

  // Real Chrome storage, both areas, serialised whole.
  expect(stored.local).not.toContain(code);
  expect(stored.session).not.toContain(code);
  // The session itself is there, which is what proves the search was looking
  // somewhere that holds authentication state at all.
  expect(stored.local).toContain('identity-session');
});

test('06 — the profile records email as the method, and keeps no code', async () => {
  isolate();
  const stored = await worker.evaluate(async () => {
    const local = await chrome.storage.local.get(null);
    return JSON.stringify(local);
  });
  expect(stored).toContain('"email"');
  expect(stored).toContain(ADDRESS);
  expect(stored).not.toContain(backend.otps.lastCode());
});

test('07 — a spent code cannot be replayed from the panel', async () => {
  isolate();
  await send('auth.signOut', {});
  const { challengeId, code } = await request(ADDRESS);

  expect((await send('auth.verifyEmailSignIn', { challengeId, code })).ok).toBe(true);
  await send('auth.signOut', {});

  const replayed = await send('auth.verifyEmailSignIn', { challengeId, code });
  expect(replayed.ok).toBe(false);
  expect((await send('auth.status', {})).state).toBe('signed_out');
});

test('08 — five wrong codes end the challenge, and the right one then fails', async () => {
  isolate();
  const { challengeId, code } = await request('exhaust@example.test');
  const wrong = code === '000000' ? '111111' : '000000';

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await send('auth.verifyEmailSignIn', { challengeId, code: wrong });
    expect(result.failure, `attempt ${attempt}`).toBe('INVALID_CODE');
  }
  expect((await send('auth.verifyEmailSignIn', { challengeId, code: wrong })).failure).toBe(
    'ATTEMPTS_EXHAUSTED',
  );

  const afterwards = await send('auth.verifyEmailSignIn', { challengeId, code });
  expect(afterwards.ok).toBe(false);
  expect((await send('auth.status', {})).state).toBe('signed_out');
});

test('09 — an expired code is refused, with the backend clock moved', async () => {
  isolate();
  const { challengeId, code } = await request('expiry@example.test');
  // Eleven minutes on the backend's own clock. The extension is not involved
  // in deciding this, which is the point: server time decides.
  backend.advance(11 * 60 * 1000);

  const result = await send('auth.verifyEmailSignIn', { challengeId, code });
  expect(result.ok).toBe(false);
  expect(result.failure).toBe('EXPIRED');
});

test('10 — a resend invalidates the previous code', async () => {
  isolate();
  const first = await request(ADDRESS);
  // Past the cooldown on the backend's clock, so the resend is allowed.
  backend.advance(31 * 1000);
  const second = await request(ADDRESS);
  expect(second.code).not.toBe(first.code);

  expect((await send('auth.verifyEmailSignIn', first)).ok).toBe(false);
  expect((await send('auth.verifyEmailSignIn', second)).ok).toBe(true);
  await send('auth.signOut', {});
});

test('11 — rate limiting surfaces as a wait, not as a failure to reach anything', async () => {
  isolate();
  const first = await send('auth.startEmailSignIn', { email: 'limited@example.test' });
  expect(first.ok).toBe(true);

  const immediate = await send('auth.startEmailSignIn', { email: 'limited@example.test' });
  expect(immediate.ok).toBe(false);
  expect(immediate.failure).toBe('RATE_LIMITED');
  expect(immediate.retryAfterMs ?? 0).toBeGreaterThan(0);
});

test('12 — a delivery failure is reported rather than leaving a person waiting', async () => {
  isolate();
  backend.otps.failing = true;
  try {
    const result = await send('auth.startEmailSignIn', { email: 'undeliverable@example.test' });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('DELIVERY_FAILED');
    expect(result.challengeId).toBeNull();
  } finally {
    backend.otps.failing = false;
  }
});

test('13 — the panel drives the whole flow, and the code never leaves it', async () => {
  isolate();
  await send('auth.signOut', {});
  await panel.reload();
  await panel.getByRole('button', { name: 'Settings' }).click();

  await panel.getByTestId('auth-email-input').fill(ADDRESS);
  await panel.getByTestId('auth-email-send').click();
  await expect(panel.getByTestId('auth-code-sent')).toBeVisible();

  const code = backend.otps.lastCode();
  await panel.getByTestId('auth-code-input').fill(code);
  await panel.getByTestId('auth-code-submit').click();

  await expect(panel.getByTestId('auth-signed-in')).toBeVisible();
  await expect(panel.getByTestId('auth-signed-in')).toContainText(ADDRESS);

  // The code is gone from the panel, and was never written anywhere by it.
  const afterwards = await worker.evaluate(async () => {
    const local = await chrome.storage.local.get(null);
    const session = await chrome.storage.session.get(null);
    return JSON.stringify({ local, session });
  });
  expect(afterwards).not.toContain(code);
});

test('14 — the session survives a worker restart, and the code does not come back', async () => {
  isolate();
  const code = backend.otps.lastCode();
  await killServiceWorker(context, worker);
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await panel.reload();

  const status = await send('auth.status', {});
  expect(status.state).toBe('signed_in');

  const stored = await worker.evaluate(async () => {
    const local = await chrome.storage.local.get(null);
    const session = await chrome.storage.session.get(null);
    return JSON.stringify({ local, session });
  });
  expect(stored).not.toContain(code);
});

test('15 — an email sign-in creates no provider connection and touches no key', async () => {
  isolate();
  const accounts = await send('accounts.list', {});
  // Authentication establishes an ABA identity and a session. It connects no
  // AI account, and there was none to begin with.
  expect(accounts.accounts).toHaveLength(0);
  expect(accounts.brain).toBeNull();
});

test('16 — signing in as a different person is refused, not silently accepted', async () => {
  isolate();
  await send('auth.signOut', {});
  const { challengeId, code } = await request('somebody.else@example.test');

  // The backend issues a session for this address quite correctly — it is a
  // different account, and the code proved control of that mailbox. The
  // *installation* is what refuses: this browser already holds another user's
  // data, and overwriting the profile would strand every account bound to it.
  const result = await send('auth.verifyEmailSignIn', { challengeId, code });
  expect(result.ok).toBe(false);
  expect(result.failure).toBe('DIFFERENT_USER');

  // And the refusal left no session behind, so the installation is not now
  // holding a session for a user it does not recognise.
  expect((await send('auth.status', {})).state).toBe('signed_out');
});
