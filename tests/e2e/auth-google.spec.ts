/**
 * TEST-E2E-023 — the authentication surface in real Chromium.
 *
 * What this validates is the extension side of Google sign-in as it is
 * actually shipped: the panel renders the account block, the three auth
 * routes answer, the route-trust boundary holds, and nothing about adding
 * authentication changed a permission, a provider credential or workspace
 * authorization.
 *
 * **What it deliberately does not claim.** No build in this repository is
 * configured with a backend origin and no Google credentials exist, so a
 * click-through sign-in cannot be performed and is not simulated. The panel
 * therefore reports the standalone state, and that is asserted as the true
 * state rather than worked around — a test that faked a successful Google
 * sign-in would report coverage nobody has. Live acceptance is
 * credential-blocked and recorded as such.
 */
import { expect, test } from './fixtures/extension';

test('the panel shows the account block and reports the real configured state', async ({
  panel,
}) => {
  await panel.getByRole('button', { name: 'Settings' }).click();

  // Labelled for what it describes: this device, not an account nobody has.
  const account = panel.getByRole('region', { name: 'This device' });
  await expect(account).toBeVisible();

  // No backend origin is compiled into this build, so there is nothing to
  // sign in to. Asserted as the fact it is — and asserted as the *standalone*
  // state rather than a missing feature, which is what the panel now says.
  await expect(panel.getByTestId('auth-local-only')).toBeVisible();
  await expect(panel.getByTestId('auth-sign-in-google')).toHaveCount(0);
});

test('the auth routes answer from the panel', async ({ send }) => {
  const status = await send('auth.status', {});
  expect(status).toHaveProperty('configured');
  expect(status).toHaveProperty('state');
  // Signed out, because nothing has signed in.
  expect((status as { state: string }).state).toBe('signed_out');
  expect((status as { abaUserId: string | null }).abaUserId).toBeNull();
});

test('the status route carries no token field at all', async ({ send }) => {
  const status = await send('auth.status', {});
  const serialised = JSON.stringify(status);
  for (const term of ['token', 'refresh', 'access', 'bearer', 'secret']) {
    expect(serialised.toLowerCase(), term).not.toContain(term);
  }
});

test('signing out with no session is safe and changes nothing', async ({ send }) => {
  const before = await send('accounts.list', {});
  await expect(send('auth.signOut', {})).resolves.toHaveProperty('ok', true);
  const after = await send('accounts.list', {});
  expect(after).toEqual(before);
});

test('sign-in refuses when no backend is configured, rather than reaching out', async ({
  send,
}) => {
  const result = (await send('auth.signInWithGoogle', {})) as {
    ok: boolean;
    failure: string | null;
  };
  expect(result.ok).toBe(false);
  expect(result.failure).toBe('NOT_CONFIGURED');
});

test('authentication added no permission and no host access', async ({ serviceWorker }) => {
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.permissions).toEqual([
    'sidePanel',
    'storage',
    'unlimitedStorage',
    'tabs',
    'tabGroups',
    'scripting',
    'debugger',
    'notifications',
    'activeTab',
  ]);
  // `identity` is the one a Google sign-in would reach for, and is not here.
  expect(manifest.permissions).not.toContain('identity');
  expect(manifest.permissions).not.toContain('cookies');
  expect(manifest.host_permissions).toEqual(['http://*/*', 'https://*/*']);
  expect(manifest.host_permissions).not.toContain('<all_urls>');
});

test('the auth routes are not reachable from a page', async ({ context, extensionId, site }) => {
  const page = await context.newPage();
  // The local fixture site, so this asserts the boundary rather than the
  // sandbox's network policy.
  await page.goto(`${site.baseUrl}/form`);

  // A page may not start an authentication. If it could, it could start one
  // without the user — which is the whole point of the route-trust boundary.
  const reached = await page.evaluate(async (id) => {
    try {
      const response = await chrome.runtime.sendMessage(id, {
        id: 'x',
        type: 'auth.signInWithGoogle',
        timestamp: Date.now(),
        payload: {},
      });
      return response ?? null;
    } catch {
      return null;
    }
  }, extensionId);

  expect(reached).toBeNull();
  await page.close();
});
