/**
 * TEST-E2E-054 — connecting an AI account, in the shipped build, with no
 * product login anywhere in it.
 *
 * REAL BROWSER. Facts about the installed extension and the browser rather
 * than about files on disk: the manifest Chrome actually loaded, the
 * permissions it actually holds, what `chrome.identity` can actually do, and
 * what the real `accounts.*` routes actually answer.
 *
 * ## The product requirement being measured
 *
 * Google is a way to *connect an AI account*, not a login gate. So the two
 * halves checked here are:
 *
 *  - **the journey needs no product sign-in.** The panel opens, the account
 *    routes answer, an account connects, a model is discovered and selected,
 *    a task runs and the request carries that account's credential and that
 *    model id — with `auth.status` reporting signed-out throughout.
 *  - **what the build says about Google is true of this build.** No Google
 *    OAuth client id is compiled into the shipped artifact, so the Google
 *    method reports itself unavailable *with a reason* rather than offering a
 *    button that cannot work. A reviewer can check that in thirty seconds and
 *    it had better match.
 *
 * ## Why the permission facts are measured and not argued
 *
 * `identity` was deliberately refused for connectors, because the same
 * permission unlocks `getAuthToken`, which can mint a token for the browser
 * profile's own Google account. Authorizing Google for the Gemini API cannot
 * avoid the permission — only `launchWebAuthFlow` intercepts Google's
 * `chromiumapp.org` redirect — so it is taken as an **optional** permission
 * and `getAuthToken` is left without a client id by shipping no `oauth2`
 * manifest key.
 *
 * That last sentence is a claim about Chrome's behaviour, so it is measured:
 * the case below grants nothing, calls `getAuthToken` in the real browser, and
 * asserts it fails. Arguing it from documentation would be the weaker form of
 * the same statement.
 *
 * ## What is *not* established here
 *
 * No live Google authorization. That needs an OAuth client registered to this
 * extension's id by the owner, and this repository holds none. The protocol
 * itself — PKCE, the callback checks, the scope refusal, the renewal — is
 * driven in `tests/security/google-provider-auth.test.ts` and
 * `tests/integration/google-account-journey.test.ts`.
 */
import { expect, test, waitForTask } from './fixtures/extension';

const KEY = 'test-key-journey-aaaaaaaaaa';
const KEY_SECOND = 'test-key-journey-bbbbbbbbbb';

test('the manifest asks for identity optionally, and for no Google client', async ({
  serviceWorker,
}) => {
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());

  // Not granted at install. A user who never connects Google never grants it.
  expect(manifest.permissions ?? []).not.toContain('identity');
  expect(manifest.optional_permissions ?? []).toContain('identity');
  // `downloads` is the other optional one and is unchanged.
  expect(manifest.optional_permissions ?? []).toEqual(['downloads', 'identity']);

  // The capability the permission was previously refused over reads its client
  // id from this key. There is none.
  expect((manifest as { oauth2?: unknown }).oauth2).toBeUndefined();

  // And the permission set that a reviewer scrutinises is untouched.
  expect(manifest.permissions ?? []).toEqual([
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
  expect(manifest.host_permissions ?? []).toEqual(['http://*/*', 'https://*/*']);
});

test('identity is not granted until asked for, and getAuthToken cannot work', async ({
  serviceWorker,
}) => {
  const state = await serviceWorker.evaluate(async () => {
    const held = await chrome.permissions.contains({ permissions: ['identity'] });
    // Called without granting anything, which is the state a fresh profile is
    // in. Two outcomes are both acceptable and both are the point: it refuses
    // because the permission is absent, or it refuses because there is no
    // client id. What must not happen is a token.
    let token: unknown = 'NOT_CALLED';
    let failed = false;
    try {
      token = await new Promise((resolve, reject) => {
        try {
          chrome.identity.getAuthToken({ interactive: false }, (result) => {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve(result);
          });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    } catch {
      failed = true;
      token = null;
    }
    return { held, failed, token };
  });

  expect(state.held).toBe(false);
  // The whole mitigation, measured: no token comes out of the browser
  // profile's own Google account.
  expect(state.failed).toBe(true);
  expect(state.token).toBeNull();
});

test('the build says truthfully which providers it can authorize with Google', async ({ send }) => {
  const methods = await send('accounts.authMethods', {});

  // Every registered provider has a row, and every row offers a way in.
  expect(methods.providers.length).toBeGreaterThanOrEqual(4);
  for (const provider of methods.providers) {
    expect(
      provider.methods.some((method) => method.kind === 'api_key'),
      provider.providerId,
    ).toBe(true);
  }

  // Exactly one is Google-authorizable, and it is Google's own.
  const google = methods.providers.filter((provider) => provider.googleAuthorizable);
  expect(google.map((provider) => provider.providerId)).toEqual(['gemini']);

  // And in this build the Google method is unavailable, because no client id
  // is compiled in — reported as such, with a reason, rather than offered.
  const method = google[0]!.methods.find((entry) => entry.kind === 'google_oauth')!;
  expect(method.configured).toBe(false);
  expect(method.unavailableReason).toMatch(/no Google OAuth client id/i);

  // The claim a user is most likely to expect, stated rather than implied.
  expect(methods.accountDiscoveryFromGoogleIdentity).toBe(false);
  expect(methods.identityPermissionGranted).toBe(false);

  // Each provider that cannot be authorized with Google says why, with a
  // source a reader can check.
  for (const provider of methods.providers) {
    if (provider.googleAuthorizable) continue;
    expect(provider.unavailable.length, provider.providerId).toBeGreaterThan(0);
    for (const item of provider.unavailable) {
      expect(item.source.startsWith('https://'), item.label).toBe(true);
    }
  }
});

test('connecting a Google account is refused honestly in this build', async ({ send }) => {
  // Not "failed": a named refusal with a sentence that sends the user to the
  // thing that does work. A build that opened a Google window with no client
  // id would show the user Google's own error page.
  const result = await send('accounts.connectGoogle', {});
  expect(result.account).toBeNull();
  expect(result.failure).toBe('NOT_CONFIGURED');
  expect(result.error?.userMessage).toMatch(/Gemini API key/i);

  // And nothing was created or selected by the attempt.
  const { accounts, brain } = await send('accounts.list', {});
  expect(accounts).toEqual([]);
  expect(brain).toBeNull();
});

test('the whole journey runs with no product sign-in at any point', async ({ send, provider }) => {
  // **The clarified requirement, end to end.** Twelve steps, and the one that
  // the previous interpretation got wrong is step 1: a user with no product
  // account opens the extension and uses it.

  // 1-2. Signed out, and the account surface answers anyway.
  const before = await send('auth.status', {});
  expect(before.state).not.toBe('signed_in');
  expect((await send('accounts.list', {})).accounts).toEqual([]);
  // 3. The connect surface is readable without connecting anything.
  expect((await send('accounts.authMethods', {})).providers.length).toBeGreaterThan(0);

  // 4. Connect, with a credential the user holds. No Google anywhere.
  const first = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: KEY,
    model: 'mock-model',
    displayName: 'Journey — first',
  });
  expect(first.error).toBeUndefined();
  const firstId = first.account!.connectionId;

  // 5. Discover what the account can actually use, from the endpoint.
  const discovered = await send('accounts.listModels', { connectionId: firstId });
  expect(discovered.models.map((model) => model.id)).toContain('mock-model');

  // 6-7. Select, then verify the selection before declaring setup complete.
  await send('accounts.setBrain', { connectionId: firstId, modelId: 'mock-model' });
  const report = await send('accounts.runDoctor', { connectionId: firstId, modelId: 'mock-model' });
  // The verification is about the pair that was selected: this model, on this
  // account. The report names the model it measured, and the account's own
  // `capabilityScope` is what ties the measurement to the connection.
  expect(report.report.modelId).toBe('mock-model');
  expect(report.report.readiness).toBeTruthy();

  // 8-9. Run a task, and assert the request carried *that* credential.
  provider.script([{ kind: 'text', text: 'Done.' }]);
  const task = await send('task.create', { objective: 'Say something.' });
  expect(await waitForTask(send, task.task.id, 40_000)).toMatchObject({ state: 'COMPLETED' });

  const keysUsed = (): string[] =>
    provider.requests
      .filter((request) => request.path.includes('/chat/completions'))
      .map((request) => (request.headers['authorization'] ?? '').replace(/^Bearer /, ''));
  expect(keysUsed()).toContain(KEY);
  expect(keysUsed()).not.toContain(KEY_SECOND);

  // 10-11. Switch, and the next request uses the new selection.
  const second = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: KEY_SECOND,
    model: 'mock-model',
    displayName: 'Journey — second',
  });
  const secondId = second.account!.connectionId;
  // Connecting a second account did not move the user off the first.
  expect((await send('accounts.list', {})).brain?.connectionId).toBe(firstId);

  await send('accounts.setBrain', { connectionId: secondId, modelId: 'mock-model' });
  await send('accounts.runDoctor', { connectionId: secondId, modelId: 'mock-model' });
  provider.script([{ kind: 'text', text: 'Done again.' }]);

  const after = await send('task.create', { objective: 'Say something else.' });
  expect(await waitForTask(send, after.task.id, 40_000)).toMatchObject({ state: 'COMPLETED' });
  expect(keysUsed()).toContain(KEY_SECOND);

  // 12. Disconnect, and the agent refuses rather than falling back.
  await send('accounts.disconnect', { connectionId: secondId });
  await send('accounts.disconnect', { connectionId: firstId });
  const empty = await send('accounts.list', {});
  expect(empty.accounts).toEqual([]);
  expect(empty.brain).toBeNull();

  // Still signed out, after all of it. That is the requirement.
  const end = await send('auth.status', {});
  expect(end.state).not.toBe('signed_in');
});

test('an account with no model can still be given one, from its own row', async ({
  send,
  provider,
}) => {
  // **The dead end this closes, measured on the real routes.** An account
  // authorized with Google always arrives with no model selected — deliberately
  // — and until now the only model picker was bound to whichever connection the
  // panel session had just connected, or to the current brain. A user who
  // authorized while another account was the brain, or who reopened the panel,
  // had a row saying "no model selected" and two buttons that both answered
  // "choose a model first", with nowhere to choose one.
  //
  // The Google path cannot be driven here — this build carries no client id —
  // so the same state is produced the way the panel now recovers from it: an
  // account exists, it has no model, and the two routes the row calls are
  // enough to fix it.
  const connected = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: 'test-key-nomodel-aaaaaaaa',
    // No model, which is the state an authorized Google account is in.
    displayName: 'No model yet',
  });
  expect(connected.error).toBeUndefined();
  const connectionId = connected.account!.connectionId;
  expect(connected.account!.modelId).toBeNull();

  // What the row's "Choose a model" button does: ask this account's own
  // endpoint, with this account's own credential.
  const listed = await send('accounts.listModels', { connectionId });
  expect(listed.models.map((model) => model.id)).toContain('mock-model');

  // And what choosing one does.
  const chosen = await send('accounts.setBrain', { connectionId, modelId: 'mock-model' });
  expect(chosen.error).toBeUndefined();

  const after = await send('accounts.list', {});
  const row = after.accounts.find((account) => account.connectionId === connectionId)!;
  expect(row.modelId).toBe('mock-model');
  expect(row.isBrain).toBe(true);

  // And it can now run — after the capability check, which is the gate and not
  // a formality. Selecting a model does not measure it, so a task started here
  // without the check is refused as `BLOCKED` on `capability_unverified`.
  // Writing this case without the doctor is how that was confirmed: the
  // product is right and the first draft of this test was not.
  await send('accounts.runDoctor', { connectionId, modelId: 'mock-model' });
  provider.script([{ kind: 'text', text: 'Done.' }]);
  const task = await send('task.create', { objective: 'Say something.' });
  expect(await waitForTask(send, task.task.id, 40_000)).toMatchObject({ state: 'COMPLETED' });

  await send('accounts.disconnect', { connectionId });
});

test('re-authorizing is refused for an account that was not connected with Google', async ({
  send,
  provider,
}) => {
  // The guard that stops a Google token being attached to an account connected
  // some other way, checked on the real route — and checked **before** the user
  // is sent to Google, so a request naming the wrong account costs nothing.
  const keyed = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: 'test-key-keyed-aaaaaaaaaa',
    model: 'mock-model',
    displayName: 'A pasted key',
  });
  const connectionId = keyed.account!.connectionId;

  const refused = await send('accounts.connectGoogle', { reconnect: connectionId });
  expect(refused.account).toBeNull();

  // **`NOT_CONFIGURED`, not `NOT_RECONNECTABLE`, and that is the right answer
  // for this build.** The route reports the configuration blocker first,
  // because a build with no Google OAuth client id cannot complete any
  // authorization and saying "that account was not connected with Google"
  // would send the user to fix the wrong thing. The reconnect guard's own
  // ordering — before the trip to Google, in a build that has a client id — is
  // pinned in `google-provider-auth.test.ts` group 06d, on the route's source,
  // because it cannot be reached from here.
  //
  // The first draft of this case expected `NOT_RECONNECTABLE` and was wrong
  // about which refusal matters more.
  expect(refused.failure).toBe('NOT_CONFIGURED');
  expect(refused.error?.userMessage).toMatch(/Gemini API key/i);

  // The security-relevant half holds either way, and is what this case is
  // really for: the named account is untouched. Same auth kind, same model,
  // still usable — no Google token was attached to a key-connected account.
  const after = await send('accounts.list', {});
  const row = after.accounts.find((account) => account.connectionId === connectionId)!;
  expect(row.authKind).toBe('api_key');
  expect(row.modelId).toBe('mock-model');
  expect(row.status).not.toBe('disconnected');

  // And an unknown connection creates nothing, rather than minting an account
  // for a connection id that does not exist.
  const before = after.accounts.length;
  await send('accounts.connectGoogle', { reconnect: 'conn_does_not_exist' });
  expect((await send('accounts.list', {})).accounts).toHaveLength(before);

  await send('accounts.disconnect', { connectionId });
});

test('a task refuses when no AI account is connected, and says which it is', async ({ send }) => {
  // The honest state of a fresh installation: explorable, and unable to run an
  // AI task until a credential exists.
  //
  // **Refused at the route, before a task record exists.** This case was first
  // written expecting a task that reached `FAILED`, which is the shape most of
  // the failure paths have. This one is better than that: there is nothing to
  // create, so nothing is created, and the user does not get a dead task in
  // their list to wonder about.
  await expect(send('task.create', { objective: 'Summarise this page.' })).rejects.toThrow(
    /AUTH_REQUIRED/,
  );
  // And the sentence names which of the two situations it is. "No AI account
  // is selected" and "no AI provider is connected" send the user to different
  // places, and reading as one is the defect this wording fixed.
  await expect(send('task.create', { objective: 'Summarise this page.' })).rejects.toThrow(
    /No AI provider is connected/i,
  );
  // Nothing was created by either attempt.
  expect((await send('task.list', {})).tasks).toEqual([]);
});
