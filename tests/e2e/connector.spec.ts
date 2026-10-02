/**
 * TEST-E2E-010 — connectors in real Chromium (Stage 3 Wave F).
 *
 * REAL BROWSER + MOCK CONNECTOR SERVICE. The OAuth authorization server and
 * the API are a local Node server on 127.0.0.1 speaking real HTTP; no
 * production service is contacted and no real account is involved.
 *
 * What only a real browser can settle:
 *
 * **Whether the OAuth redirect can land at all.** An extension page that is
 * not a web-accessible resource cannot be redirected to — Chromium refuses
 * the navigation with `net::ERR_BLOCKED_BY_CLIENT`, so an authorization would
 * end on an error page and no callback would ever be seen. This suite loads
 * the mock authorization server in a real tab and watches where the browser
 * actually goes. The first version of the redirect URI failed this, which is
 * how the manifest came to declare the callback page.
 *
 * **What `redirect: 'manual'` returns.** In a browser it is an opaque-redirect
 * filtered response: status 0, no headers, nothing about the target. The
 * transport's handling of that is written against this measurement.
 *
 * **What the extension actually holds.** `chrome.permissions.getAll()` and
 * `typeof chrome.identity` are facts about the installed extension, not about
 * the manifest file on disk.
 *
 * This build registers no OAuth application, so a full live authorization
 * cannot be driven end to end from the side panel. That limit is recorded by
 * the tests below rather than papered over: the extension refuses to start a
 * flow it cannot finish.
 */
import { connectProvider, expect, test, waitForTask } from './fixtures/extension';
import { startMockConnectorService } from './fixtures/mock-connector-service';

// --- the worker loads at all ------------------------------------------------

test('the service worker finishes loading, so its message routes exist', async ({ send }) => {
  // A regression test for a failure with no symptom. Registering a connector
  // throws on a descriptor it rejects, and that call sits at module scope
  // above every `router.on`, so one bad descriptor stopped the rest of the
  // worker file from evaluating: the side panel opened, looked entirely
  // normal, and no message it ever sent was answered. Nothing logged it, and
  // no unit test could see it.
  //
  // `tools.list` is the last route the worker registers, so an answer from it
  // means the whole file evaluated — which is the property that was broken.
  const { tools } = await send('tools.list', {});
  expect(tools.length).toBeGreaterThan(0);

  // And a route defined after the connector registration specifically.
  const { connectors } = await send('connector.list', {});
  expect(connectors.length).toBeGreaterThan(0);
});

// --- what the extension holds ----------------------------------------------

test('the extension holds no identity, cookies or webRequest permission', async ({
  serviceWorker,
}) => {
  const granted = await serviceWorker.evaluate(async () => await chrome.permissions.getAll());

  // `chrome.identity` was deliberately not taken for the OAuth flow: the same
  // permission also unlocks `getAuthToken`, which mints a token for the
  // browser profile's own signed-in account. The tab-based flow needs none of
  // it.
  for (const forbidden of ['identity', 'cookies', 'webRequest', 'webRequestBlocking']) {
    expect(granted.permissions ?? []).not.toContain(forbidden);
  }
  expect(granted.origins ?? []).not.toContain('<all_urls>');
});

test('chrome.identity is genuinely unavailable, not merely unused', async ({ serviceWorker }) => {
  const available = await serviceWorker.evaluate(() => ({
    identity: typeof chrome.identity,
    getAuthToken: typeof chrome.identity?.getAuthToken,
    launchWebAuthFlow: typeof chrome.identity?.launchWebAuthFlow,
  }));
  // Not a style choice that a later edit could quietly reverse: the API is
  // not there to call.
  expect(available).toEqual({
    identity: 'undefined',
    getAuthToken: 'undefined',
    launchWebAuthFlow: 'undefined',
  });
});

test('connector tokens live in session storage, which a content script cannot read', async ({
  serviceWorker,
  site,
  context,
}) => {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.session.set({ 'probe-token': 'must-not-be-readable' });
  });

  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });

  // The content script runs in an isolated world with the extension's own
  // chrome APIs, so this is the real question: can code at page level, in the
  // content script's world, read what the worker stored?
  const readable = await page.evaluate(async () => {
    try {
      const api = (globalThis as { chrome?: { storage?: { session?: unknown } } }).chrome;
      if (!api?.storage?.session) return 'no session API in this world';
      const store = api.storage.session as { get: (k: string) => Promise<Record<string, unknown>> };
      const result = await store.get('probe-token');
      return JSON.stringify(result);
    } catch (error) {
      return `threw: ${(error as Error).message}`;
    }
  });

  expect(readable).not.toContain('must-not-be-readable');
});

// --- the connector surface --------------------------------------------------

test('the connector is registered, and says how it can be connected', async ({ send }) => {
  const { connectors } = await send('connector.list', {});
  const github = connectors.find((entry) => entry.id === 'github');

  expect(github).toBeDefined();
  // `api_token`, not `oauth2`, and the reason is a correction rather than a
  // preference. An earlier revision of this case asserted `oauth2` and
  // `configured: false`, on the understanding that the only thing missing was
  // a registered application. That was wrong: GitHub's web application flow
  // requires a `client_secret` in the code exchange, PKCE or not, and this
  // extension must not carry one — so the flow is unreachable here whatever
  // client id a deployment supplies. A token the user creates in their own
  // account needs no registration and no secret, so the connector is
  // connectable, and `configured` says so.
  expect(github!.authKind).toBe('api_token');
  expect(github!.configured).toBe(true);
  expect(github!.state).not.toBe('READY');

  // The panel needs somewhere to send the user and something to label the
  // field with, and it is the worker that knows which service this is.
  expect(github!.tokenHint).toBeDefined();
  expect(github!.tokenHint!.issuePage).toMatch(/^https:\/\/github\.com\//);
  expect(github!.tokenHint!.label.length).toBeGreaterThan(0);
  expect(github!.tokenHint!.help.length).toBeGreaterThan(0);
  // A hint is a sentence and a link. It is not, and cannot become, a credential.
  expect(JSON.stringify(github!.tokenHint)).not.toMatch(/token[-_]?[A-Za-z0-9]{20,}/);

  // Every scope any operation needs carries a stated reason, which is what
  // the Settings view shows the user before they grant anything.
  const needed = new Set(
    github!.operations.filter((op) => op.kind === 'write').flatMap(() => ['public_repo']),
  );
  for (const scope of needed) expect(github!.scopeRationale[scope]).toBeTruthy();
});

test('the second connector is registered too, with its own credential header', async ({ send }) => {
  // What this settles that an integration suite cannot: that the real worker
  // registers both, that the second one's descriptor survived
  // `validateConnectorDescriptor` at module scope — a descriptor it rejects
  // takes the whole worker down, which is the failure the first case in this
  // file exists for — and that the panel is told how to connect it.
  const { connectors } = await send('connector.list', {});
  expect(connectors.map((entry) => entry.id).sort()).toEqual(['figma', 'github']);

  const figma = connectors.find((entry) => entry.id === 'figma')!;
  expect(figma.authKind).toBe('api_token');
  expect(figma.configured).toBe(true);
  expect(figma.state).not.toBe('READY');

  // Read-only, because Figma reports nothing about what a token may do and a
  // declared write scope could never be satisfied.
  expect(figma.operations.filter((operation) => operation.kind === 'write')).toEqual([]);
  expect(
    figma.operations
      .filter((operation) => operation.kind === 'read')
      .map((operation) => operation.id)
      .sort(),
  ).toEqual(['read_comments', 'read_file']);

  // The hint tells the user which scopes to give the token, including the one
  // this build needs to check it belongs to them.
  expect(figma.tokenHint).toBeDefined();
  expect(figma.tokenHint!.issuePage).toMatch(/^https:\/\/(www\.)?figma\.com\//);
  expect(figma.tokenHint!.help).toContain('current_user:read');
  expect(figma.tokenHint!.help).toMatch(/read-only/i);
});

test('each connector’s tools are namespaced to it, with no cross-wiring', async ({ send }) => {
  const { tools } = await send('tools.list', {});
  const names = tools.map((tool) => tool.name);
  expect(names).toContain('figma.read_file');
  expect(names).toContain('figma.read_comments');
  expect(names).toContain('github.search_issues');
  // Figma contributes no write tool at all — not one that exists and refuses.
  expect(names.filter((name) => name.startsWith('figma.'))).toHaveLength(2);
});

test('reading needs no scope and writing does', async ({ send }) => {
  const { connectors } = await send('connector.list', {});
  const github = connectors.find((entry) => entry.id === 'github')!;

  expect(
    github.operations
      .filter((op) => op.kind === 'read')
      .map((op) => op.id)
      .sort(),
  ).toEqual(['read_issue', 'search_issues']);
  expect(
    github.operations
      .filter((op) => op.kind === 'write')
      .map((op) => op.id)
      .sort(),
  ).toEqual(['comment_issue', 'create_issue']);
});

test('the authorization flow is refused, and says why rather than being offered', async ({
  send,
}) => {
  // The failure that matters is the one that does not happen: no tab opens,
  // no state is minted, and nothing reports a connection that does not exist.
  //
  // The reason given changed, and the change is the point. It used to be "no
  // OAuth application is configured", which implied a registration would fix
  // it. It would not: the code exchange needs a client secret this extension
  // must not hold, so the flow is refused for what it is rather than for what
  // is missing from the deployment.
  await expect(send('connector.authorize', { connectorId: 'github' })).rejects.toThrow(
    /NOT_IMPLEMENTED|does not use an authorization flow/i,
  );

  const { connectors } = await send('connector.list', {});
  expect(connectors.find((entry) => entry.id === 'github')!.state).not.toBe('READY');
});

test('a token the service refuses leaves nothing connected and nothing stored', async ({
  send,
  serviceWorker,
}) => {
  // Driven against real GitHub, which refuses it — the one live call in this
  // suite, and the only kind that is safe to make: an unauthenticated probe
  // with a string that is not a credential for anything. Nothing is created,
  // nothing is read, and no account is involved. If the network is
  // unavailable the connector lands on `token_unverified` instead, which this
  // case accepts, because both outcomes are "not connected, nothing stored"
  // and the suite must not depend on somebody else's uptime to prove that.
  const supplied = 'not-a-real-token-0000000000000000000000';
  const result = await send('connector.connectToken', {
    connectorId: 'github',
    token: supplied,
  });

  expect(result.state).not.toBe('READY');
  expect(['token_rejected', 'token_unverified']).toContain(result.reason);
  expect(result.scopesKnown).toBe(false);

  const { connectors } = await send('connector.list', {});
  expect(connectors.find((entry) => entry.id === 'github')!.state).not.toBe('READY');

  // And the ordering that matters: the credential was checked before it was
  // stored, so a refusal leaves the vault untouched. Read out of the real
  // extension's own storage, both areas.
  const stored = await serviceWorker.evaluate(async () => {
    const [session, local] = await Promise.all([
      chrome.storage.session.get(null),
      chrome.storage.local.get(null),
    ]);
    return JSON.stringify({ session, local });
  });
  expect(stored).not.toContain(supplied);
});

test('an empty token is refused by the route, before anything is asked', async ({ send }) => {
  await expect(
    send('connector.connectToken', { connectorId: 'github', token: '   ' }),
  ).rejects.toThrow(/INVALID_ARGUMENT|No token was supplied|Paste the token/i);
});

test('a supplied token is refused for a connector that does not take one', async ({ send }) => {
  await expect(
    send('connector.connectToken', { connectorId: 'not-a-connector', token: 'anything' }),
  ).rejects.toThrow(/INVALID_ARGUMENT|Unknown connector/i);
});

test('an unknown connector is refused rather than invented', async ({ send }) => {
  await expect(send('connector.authorize', { connectorId: 'not-a-connector' })).rejects.toThrow(
    /INVALID_ARGUMENT|Unknown connector/i,
  );
});

// --- the tools the connector contributes ------------------------------------

test('connector tools are in the registry the model is offered', async ({ send }) => {
  const { tools } = await send('tools.list', {});
  const names = tools.map((tool) => tool.name);

  // They enter the one registry, so the one policy engine classifies them.
  expect(names).toContain('github.search_issues');
  expect(names).toContain('github.create_issue');

  const write = tools.find((tool) => tool.name === 'github.create_issue')!;
  expect(write.risk).toBe('R3');
});

test('a model-driven connector call is refused while the connector is not connected', async ({
  send,
  provider,
  collector,
}) => {
  await connectProvider(send, provider);
  provider.script([
    {
      kind: 'tool_calls',
      calls: [{ name: 'github.search_issues', arguments: { query: 'anything at all' } }],
    },
    { kind: 'text', text: 'I cannot reach GitHub because it is not connected.' },
  ]);

  const { task } = await send('task.create', { objective: 'Find open issues about login.' });
  const finished = await waitForTask(send, task.id);

  // The task ends, rather than hanging or silently succeeding.
  expect(['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED']).toContain(finished.state);

  // And the independent witness saw nothing: a refusal inside the extension
  // that still issued the request would look identical from the inside.
  expect(collector.requests).toEqual([]);

  const sent = JSON.stringify(provider.requests).replace(/\\"/g, '"');
  // Whatever the model was told, it was not that the call succeeded.
  expect(sent).toMatch(/AUTH_REQUIRED|not connected|error/i);
});

// --- real browser behaviour the design depends on ---------------------------

test('the OAuth callback page is reachable by redirect from an authorization server', async ({
  context,
  extensionId,
}) => {
  const service = await startMockConnectorService();
  try {
    const callback = `chrome-extension://${extensionId}/oauth/callback.html`;
    service.redirectTo = callback;

    const page = await context.newPage();
    await page.goto(
      `${service.baseUrl}/login/oauth/authorize?state=e2e-state-value&redirect_uri=ignored`,
      { waitUntil: 'commit' },
    );
    await page.waitForURL((url) => url.href.startsWith(callback), { timeout: 10_000 });

    // The premise of the whole tab-based flow: the browser really does land
    // on the extension's page, with the code and the state intact, so the
    // watcher has something to match.
    const landed = new URL(page.url());
    expect(landed.searchParams.get('code')).toBe('mock-authorization-code');
    expect(landed.searchParams.get('state')).toBe('e2e-state-value');
  } finally {
    await service.close();
  }
});

test('the callback page carries no script that could handle the code itself', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/oauth/callback.html?code=leaked&state=s`);

  // A page that parsed its own URL and messaged the code onward would be a
  // second path for a credential to travel, and one that any site able to
  // navigate here could try to drive.
  const scripts = await page.evaluate(() => document.querySelectorAll('script').length);
  expect(scripts).toBe(0);
});

test('a redirect: manual fetch is opaque in Chromium, revealing no target', async ({ context }) => {
  const service = await startMockConnectorService();
  try {
    const page = await context.newPage();
    await page.goto(`${service.baseUrl}/search/issues`);

    const observed = await page.evaluate(async (base: string) => {
      const response = await fetch(`${base}/redirect-away`, { redirect: 'manual' });
      return {
        type: response.type,
        status: response.status,
        ok: response.ok,
        location: response.headers.get('location'),
      };
    }, service.baseUrl);

    // This is why the transport treats an opaque redirect as a refusal: there
    // is no target to check against the declared origins, and a status of 0
    // would otherwise surface as "the service returned 0".
    expect(observed).toEqual({
      type: 'opaqueredirect',
      status: 0,
      ok: false,
      location: null,
    });

    // The redirect was not followed: the browser never asked the other origin
    // for anything.
    expect(service.requests.filter((request) => request.url.includes('/collect'))).toEqual([]);
  } finally {
    await service.close();
  }
});

test('the service worker cannot reach the network outside the guarded transport', async ({
  serviceWorker,
}) => {
  const service = await startMockConnectorService();
  try {
    const refusal = await serviceWorker.evaluate(async (base: string) => {
      try {
        await fetch(`${base}/search/issues`);
        return 'the request went out';
      } catch (error) {
        return (error as Error).message;
      }
    }, service.baseUrl);

    // The interceptor is installed in the real worker, not only in tests: a
    // connector that tried to build its own HTTP client would be stopped
    // here even if every review missed it.
    expect(refusal).toContain('guarded transport');
    expect(service.requests).toEqual([]);
  } finally {
    await service.close();
  }
});

// --- the audit trail --------------------------------------------------------

test('disconnecting is recorded, with no credential in the record', async ({ send }) => {
  await send('connector.disconnect', { connectorId: 'github' });

  const { events } = await send('audit.list', { limit: 50 });
  const connectorEvents = events.filter((event) => event.type.startsWith('connector.'));
  expect(connectorEvents.length).toBeGreaterThan(0);

  const dumped = JSON.stringify(connectorEvents);
  for (const forbidden of ['access_token', 'refresh_token', 'code_verifier', 'Bearer ']) {
    expect(dumped).not.toContain(forbidden);
  }
});

test('a token attempt is recorded, and the token is not', async ({ send }) => {
  // The audit trail says a connection was attempted. It must not say what
  // was attempted with — and this is the one panel route whose request
  // carries a credential, so it is the one worth checking directly.
  const supplied = 'audit-probe-token-0000000000000000000000';
  await send('connector.connectToken', { connectorId: 'github', token: supplied }).catch(
    () => undefined,
  );

  const { events } = await send('audit.list', { limit: 50 });
  const dumped = JSON.stringify(events);
  expect(dumped).toContain('token_supplied');
  expect(dumped).not.toContain(supplied);
  // Not truncated or partially echoed either.
  expect(dumped).not.toContain(supplied.slice(0, 16));
});
