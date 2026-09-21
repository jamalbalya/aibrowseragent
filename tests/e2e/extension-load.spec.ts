/**
 * TEST-E2E-001 — The extension loads and runs in a real Chromium.
 *
 * Unit tests prove modules behave; only this proves Chrome accepts the
 * package, starts the service worker, and mounts the side panel.
 */
import { connectProvider, expect, test, waitForTask } from './fixtures/extension';

test('the service worker registers and completes startup', async ({
  serviceWorker,
  workerLogs,
  send,
}) => {
  expect(serviceWorker.url()).toMatch(/^chrome-extension:\/\/[a-p]{32}\/service-worker\.js$/);

  // startup() logs its readiness; an exception there would leave it absent.
  const { tools } = await send('tools.list', {});
  expect(tools.length).toBeGreaterThan(0);
  expect(workerLogs.filter((line) => line.startsWith('[error]'))).toEqual([]);
});

test('every canonical tool is registered', async ({ send }) => {
  const { tools } = await send('tools.list', {});
  const names = tools.map((tool) => tool.name);

  for (const expected of [
    'browser.read_page',
    'browser.click',
    'browser.type',
    'browser.select',
    'browser.navigate',
    'browser.scroll',
    'browser.wait',
    'browser.screenshot',
    'tabs.list',
    'tabs.create',
    'tabs.close',
    'debugger.console',
    'debugger.network',
    'debugger.dom',
  ]) {
    expect(names, `${expected} should be registered`).toContain(expected);
  }

  // No tool may accept a raw DevTools method from the model.
  expect(names).not.toContain('debugger.command');
  expect(names).not.toContain('browser.execute_script');
});

test('the side panel mounts and reports no provider before one is configured', async ({
  panel,
}) => {
  await expect(panel.locator('.header__title')).toHaveText('AI Browser Agent');
  await expect(panel.locator('.status')).toContainText('No provider connected');

  // The composer must be disabled until tool calling has been verified.
  await expect(panel.locator('.composer__input')).toBeDisabled();
});

test('the message bus answers every panel request type it advertises', async ({ send }) => {
  await expect(send('session.get', {})).resolves.toHaveProperty('session');
  await expect(send('task.list', { limit: 5 })).resolves.toHaveProperty('tasks');
  await expect(send('provider.list', {})).resolves.toHaveProperty('providers');
  await expect(send('policy.getSitePolicy', {})).resolves.toHaveProperty('state');
  await expect(send('permission.listPending', {})).resolves.toHaveProperty('requests');
  await expect(send('debug.getLogs', {})).resolves.toHaveProperty('logs');
});

test('an unknown message type is refused as data, not as a crash', async ({ panel }) => {
  const envelope = await panel.evaluate(() =>
    chrome.runtime.sendMessage({
      id: 'x',
      type: 'totally.unknown',
      timestamp: Date.now(),
      payload: {},
    }),
  );
  // No listener claims it, so Chrome resolves with undefined rather than the
  // worker throwing.
  expect(envelope).toBeUndefined();
});

test('the side panel reflects a connected provider', async ({ send, panel, provider }) => {
  await connectProvider(send, provider);
  await panel.reload();
  await panel.waitForSelector('.app');

  await expect(panel.locator('.status')).toContainText('mock-model');
  await expect(panel.locator('.composer__input')).toBeEnabled();
});

test('the browser under test can actually host an MV3 extension', async ({
  context,
  serviceWorker,
  extensionId,
  site,
}) => {
  // Guard against a suite that passes because it is not testing anything.
  //
  // Playwright resolves `chrome-headless-shell` for a plain headless launch,
  // and the headless shell cannot load extensions at all. That configuration
  // did not fail loudly — every test simply timed out waiting for a service
  // worker, which reads as flakiness rather than as "the extension was never
  // there". The assertions below are only satisfiable by a real Chromium with
  // this extension genuinely installed, so they fail fast if the launch
  // regresses.
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.name).toBe('AI Browser Agent');
  expect(serviceWorker.url()).toContain(extensionId);

  // A real extension origin serving a real document.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  expect(panel.url().startsWith('chrome-extension://')).toBe(true);
  await panel.close();

  // The content script is genuinely injected into an ordinary page, which is
  // the other half of "the extension is installed" — the manifest alone would
  // not prove the browser honoured content_scripts.
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'load' });
  const tabId = await serviceWorker.evaluate(async (url: string) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/*` });
    return tab?.id ?? -1;
  }, site.baseUrl);
  expect(tabId).toBeGreaterThan(-1);

  const pong = await serviceWorker.evaluate(
    (id: number) =>
      new Promise<unknown>((resolve) => {
        chrome.tabs.sendMessage(
          id,
          { id: 'e2e_probe', type: 'content.ping', timestamp: Date.now(), payload: {} },
          (response: unknown) => resolve(chrome.runtime.lastError ? null : response),
        );
      }),
    tabId,
  );
  expect(pong).not.toBeNull();

  await page.close();
});

test('the agent works across more than one real tab', async ({
  context,
  serviceWorker,
  send,
  provider,
  site,
}) => {
  const first = await context.newPage();
  await first.goto(site.baseUrl, { waitUntil: 'load' });
  const second = await context.newPage();
  await second.goto(`${site.baseUrl}/form`, { waitUntil: 'load' });
  await first.bringToFront();

  await connectProvider(send, provider);

  const before = await serviceWorker.evaluate(() => chrome.tabs.query({}).then((t) => t.length));

  provider.script([
    {
      kind: 'tool_calls',
      calls: [{ name: 'tabs_create', arguments: { url: `${site.baseUrl}/form` } }],
    },
    { kind: 'tool_calls', calls: [{ name: 'tabs_list', arguments: {} }] },
    { kind: 'text', text: 'Opened and listed the tabs.' },
  ]);

  const { task } = await send('task.create', { objective: 'Open a second page and list tabs.' });
  const finished = await waitForTask(send, task.id);

  expect(finished.state).toBe('COMPLETED');
  const after = await serviceWorker.evaluate(() => chrome.tabs.query({}).then((t) => t.length));
  expect(after).toBe(before + 1);

  await first.close();
  await second.close();
});
