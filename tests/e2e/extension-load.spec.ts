/**
 * TEST-E2E-001 — The extension loads and runs in a real Chromium.
 *
 * Unit tests prove modules behave; only this proves Chrome accepts the
 * package, starts the service worker, and mounts the side panel.
 */
import { connectProvider, expect, test } from './fixtures/extension';

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
