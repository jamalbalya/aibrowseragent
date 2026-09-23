/**
 * TEST-E2E-027 — what a new installation actually says for itself.
 *
 * This is a copy phase, so the temptation is to assert strings. Strings are
 * the weakest thing available: they pass when the sentence is present and say
 * nothing about whether the product reads as usable. So these assert the
 * properties the wording exists to create, and check the *absence* of the
 * framings the phase set out to remove.
 *
 * Three of them are negative controls in the literal sense — they would have
 * passed before this phase only by accident, and they fail if the old framing
 * comes back:
 *
 *  - nothing on the ordinary path asks for a login;
 *  - no backend configuration is reachable from any settings surface;
 *  - connecting an AI account is independent of extension identity.
 *
 * Everything runs against the shipped `dist/` build, which has no configured
 * backend — the state every real user is in.
 */
import { connectProvider, expect, test } from './fixtures/extension';

/** Words a person using this should never have to meet on the normal path. */
const INFRASTRUCTURE_WORDS = [
  'backend',
  'database',
  'postgres',
  'api endpoint',
  'reverse proxy',
  'docker',
  'vps',
  'kubernetes',
  'migration',
  'pkce',
  'oauth token',
  'access token',
  'refresh token',
  'principal',
  'identity provider',
];

test('first launch offers work, not a sign-up', async ({ panel }) => {
  const welcome = panel.getByTestId('welcome-notice');
  await expect(welcome).toBeVisible();

  // The reassurance comes before the ask, which is the whole design: a
  // standalone product whose first sentence is about something missing has
  // already lost the argument.
  const text = (await welcome.innerText()).toLowerCase();
  expect(text).toContain('without an account');
  expect(text.indexOf('without an account')).toBeLessThan(text.indexOf('connect'));

  // The single call to action is connecting an account the user already has.
  await expect(panel.getByTestId('welcome-connect')).toBeVisible();
});

test('nothing on the normal path asks the user to sign in', async ({ panel }) => {
  // The whole first screen, as a person meets it.
  const body = (await panel.locator('body').innerText()).toLowerCase();

  // NEGATIVE CONTROL. Before this phase the account block read "signing in is
  // not available in this build", which is an apology for a missing feature.
  // If that framing returns, this fails.
  expect(body).not.toContain('sign in');
  expect(body).not.toContain('signing in is not available');
  expect(body).not.toContain('log in');
  expect(body).not.toContain('create an account');
});

test('the settings screen never offers a login or a server to configure', async ({ panel }) => {
  await panel.getByRole('button', { name: 'Settings' }).click();

  const body = (await panel.locator('body').innerText()).toLowerCase();

  // The standalone state, said as a state rather than a lack.
  await expect(panel.getByTestId('auth-local-only')).toBeVisible();
  expect(body).toContain('on this device');

  // NEGATIVE CONTROL, and the one the test id alone does not give: the block
  // used to read "signing in is not available in this build" under the same
  // id, which is an apology for a missing feature rather than a description
  // of how the product works. Asserting the id is visible would pass either
  // way, so the old sentence is named.
  expect(body).not.toContain('not available in this build');
  expect(body).not.toContain('signing in is not available');
  // And the region is labelled for what it describes.
  await expect(panel.getByRole('region', { name: 'This device' })).toBeVisible();
  await expect(panel.getByRole('region', { name: 'AI Browser Agent account' })).toHaveCount(0);

  // NEGATIVE CONTROL: no backend configuration is reachable from here. A
  // build that compiled one in, or a panel that offered one, fails this.
  for (const word of INFRASTRUCTURE_WORDS) {
    expect(body, word).not.toContain(word);
  }
  // And no sign-in button exists to press.
  await expect(panel.getByTestId('auth-sign-in-google')).toHaveCount(0);
});

test('the local identity is never rendered anywhere in the UI', async ({ panel }) => {
  const screens: string[] = [];
  screens.push(await panel.locator('body').innerText());
  await panel.getByRole('button', { name: 'Settings' }).click();
  screens.push(await panel.locator('body').innerText());
  // Including behind the technical details disclosure, which is the one place
  // it would be defensible to show it — and still does not.
  await panel.getByTestId('technical-details').click();
  screens.push(await panel.locator('body').innerText());

  for (const screen of screens) {
    // The opaque installation label means nothing to a person, and showing it
    // would make an internal partition key look like an account number.
    expect(screen).not.toMatch(/loc_[0-9a-f]{8}/);
    expect(screen).not.toMatch(/usr_[0-9a-f]{8}/);
    expect(screen.toLowerCase()).not.toContain('abauserid');
    expect(screen.toLowerCase()).not.toContain('installation id');
  }
});

test('technical details are opt-in and stay collapsed', async ({ panel }) => {
  await panel.getByRole('button', { name: 'Settings' }).click();

  const details = panel.getByTestId('technical-details');
  await expect(details).toBeVisible();
  // Closed by default: diagnostics are not part of setting anything up.
  expect(await details.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);

  await details.click();
  expect(await details.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(true);
  // And what it reports is a symptom a person could act on, not a state name.
  await expect(panel.getByTestId('technical-storage')).toContainText('working normally');
});

test('the data explanation is precise about where AI requests go', async ({ panel }) => {
  await panel.getByRole('button', { name: 'Settings' }).click();

  await expect(panel.getByTestId('storage-mode')).toContainText('stored on this device');
  // The claim that is easy to overstate. "Nothing leaves this device" would
  // be false — an AI request has to reach the service the user connected —
  // so the copy draws the line where it really is.
  const traffic = panel.getByTestId('storage-traffic');
  await expect(traffic).toContainText('directly to the AI service you connect');
  const body = (await panel.locator('body').innerText()).toLowerCase();
  expect(body).not.toContain('nothing leaves this device');
  expect(body).not.toContain('nothing ever leaves');
});

test('connecting an AI account needs no extension identity and changes none', async ({
  panel,
  serviceWorker,
  send,
  provider,
}) => {
  const ownerBefore = await serviceWorker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const key = Object.keys(all).find((name) => name.includes('identity-local'));
    return key === undefined ? null : JSON.stringify(all[key]);
  });

  // NEGATIVE CONTROL for coupling: the whole connect-and-select flow runs
  // with no sign-in anywhere in the path, and the auth state is untouched
  // afterwards.
  await connectProvider(send, provider);

  const status = await send('auth.status', {});
  expect(status.state).toBe('signed_out');
  expect(status.abaUserId).toBeNull();

  const ownerAfter = await serviceWorker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const key = Object.keys(all).find((name) => name.includes('identity-local'));
    return key === undefined ? null : JSON.stringify(all[key]);
  });
  expect(ownerAfter).toBe(ownerBefore);

  // And the welcome notice steps aside once there is an account to use.
  await panel.reload();
  await expect(panel.getByTestId('welcome-notice')).toHaveCount(0);
});

test('local features work with no AI account connected', async ({ send, panel }) => {
  // The composer is disabled without a model, which is honest — but the rest
  // of the product is not gated behind it, and these routes prove it by
  // answering.
  const created = await send('workspace.create', { title: 'Reading' });
  expect(created.workspaceId).toBeTruthy();

  const health = await send('health.get', {});
  expect(health.snapshot.blocked).toBe(false);

  // And the reason the composer is disabled is about the AI account, not
  // about an AI Browser Agent account.
  const composer = panel.getByPlaceholder(/connect an ai account to start/i);
  await expect(composer).toBeVisible();
});
