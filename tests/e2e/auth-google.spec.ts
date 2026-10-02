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

test('the sign-in ownership conflict is unreachable in the shipped build', async ({
  send,
  serviceWorker,
  context,
  site,
}) => {
  // **This case exists to settle a claim I made and should not have.**
  //
  // A defect was found and fixed in `ef66e4e`: signing in with Google put
  // persistence into `RECOVERY_REQUIRED`, which `TaskManager` treats as
  // work-blocking, so every `task.create` was refused. The previous report
  // then told the owner that the artifact pending Chrome Web Store review
  // "contains the sign-in defect" and that "a reviewer who signs in with
  // Google and then runs a task will find it refused".
  //
  // **That was wrong**, and this is the measurement. The defect needs a
  // *completed* sign-in, because the conflict is between a local installation
  // id and a **profile** id — and the profile is written only by
  // `recordSignIn`, which `signInWithGoogle` cannot reach when no backend
  // origin is compiled in. The shipped build has none. So no profile is ever
  // written, the two ids never disagree, and the conflict never fires.
  //
  // It was reachable in exactly one build: `dist-auth`, the fixture built for
  // `auth-google-protocol.spec.ts` with an origin inlined. That is a test
  // artifact and has never been uploaded anywhere.
  //
  // This runs against the shipped `dist`, which is what a reviewer installs.
  const status = await send('auth.status', {});
  expect(status.configured).toBe(false);
  expect(status.state).toBe('signed_out');

  // Both sign-in paths refuse before anything is recorded. Email as well as
  // Google: either would write the profile, so one of them succeeding would
  // make the conflict reachable.
  const google = (await send('auth.signInWithGoogle', {})) as { failure: string | null };
  expect(google.failure).toBe('NOT_CONFIGURED');
  const email = (await send('auth.startEmailSignIn', { email: 'someone@example.test' })) as {
    failure: string | null;
  };
  expect(email.failure).toBe('NOT_CONFIGURED');

  // No profile exists, so there is no second id to disagree with the local
  // one. Read out of the real extension's own storage.
  const stored = await serviceWorker.evaluate(async () => {
    const local = await chrome.storage.local.get(null);
    return {
      keys: Object.keys(local),
      profile: JSON.stringify(local['identity-profile:profile'] ?? null),
      health: JSON.stringify(local['health:persistence-health'] ?? null),
    };
  });
  expect(stored.profile).toBe('null');
  expect(stored.keys).not.toContain('identity-profile:profile');

  // And therefore persistence is not blocked. The defect's whole effect was
  // this record saying RECOVERY_REQUIRED.
  expect(stored.health).not.toContain('RECOVERY_REQUIRED');

  // The end a reviewer would actually reach: a task is created. Needs a page
  // the agent may act on and a connected provider, so this is the full path
  // rather than a probe of the health record.
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();

  const created = await send('task.create', { objective: 'Read this page.' }).catch(
    (error: unknown) => ({ failed: error instanceof Error ? error.message : String(error) }),
  );
  // Either it was created, or it was refused for the *provider* reason — this
  // spec connects none. What must not happen is POLICY_BLOCKED, which is what
  // the defect produced.
  const describe = JSON.stringify(created);
  expect(describe).not.toContain('POLICY_BLOCKED');
  expect(describe).not.toContain('Stored state needs to be reviewed');

  await target.close();
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
    'alarms',
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
