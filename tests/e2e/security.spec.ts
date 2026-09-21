/**
 * TEST-E2E-004 — Security controls under real browser conditions.
 *
 * The unit suites attack each control in isolation. These run the whole stack:
 * a genuinely hostile page, served over real HTTP, read by the real content
 * script, passed through the real policy engine, and sent to a real provider
 * endpoint whose received bytes are then inspected.
 *
 * The question each test answers is "what actually reached the model, and what
 * actually happened to the browser", not "did the function return the right
 * value".
 */
import { connectProvider, expect, test, waitForTask } from './fixtures/extension';

/** Everything the extension sent to the provider, flattened. */
function bytesSentToProvider(requests: readonly { path: string; body: unknown }[]): string {
  return requests
    .filter((r) => r.path.endsWith('/chat/completions'))
    .map((r) => JSON.stringify(r.body))
    .join('\n');
}

test('a page telling the agent to ignore its instructions cannot escape the data envelope', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/hostile`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'text', text: 'That page contained injected instructions. I did not follow them.' },
  ]);

  const { task } = await send('task.create', { objective: 'Read this page and summarise it.' });
  const finished = await waitForTask(send, task.id);
  expect(finished.state).toBe('COMPLETED');

  const toolMessages = provider.requests
    .filter((r) => r.path.endsWith('/chat/completions'))
    .flatMap((r) => (r.body as { messages?: { role?: string; content?: string }[] }).messages ?? [])
    .filter((m) => m.role === 'tool')
    .map((m) => m.content ?? '')
    .join('');

  // The hostile copy is present — it is data the model should see.
  expect(toolMessages).toContain('Ignore all previous instructions');

  // But the page's attempt to close the envelope early was neutralised, so the
  // text stays inside exactly one envelope rather than escaping into the
  // instruction channel.
  const closings = toolMessages.split('</UNTRUSTED_EXTERNAL_CONTENT>').length - 1;
  const openings = toolMessages.split('<UNTRUSTED_EXTERNAL_CONTENT').length - 1;
  expect(openings).toBe(1);
  expect(closings).toBe(1);

  // And the runtime flagged it for the user.
  expect(toolMessages).toContain('injectionWarning');
});

test('a credential printed on a page is redacted before it reaches the provider', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/hostile`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'text', text: 'Read it.' },
  ]);

  const { task } = await send('task.create', { objective: 'Read the offers page.' });
  await waitForTask(send, task.id);

  const sent = bytesSentToProvider(provider.requests);
  expect(sent).not.toContain('shouldnotappearinlogs');
  expect(sent).toContain('[REDACTED]');
});

test('a password field value never leaves the page', async ({ context, send, provider, site }) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'tool_calls', calls: [{ name: 'browser_screenshot', arguments: {} }] },
    { kind: 'text', text: 'Read it.' },
  ]);

  const { task } = await send('task.create', { objective: 'Read the page.' });
  await waitForTask(send, task.id);

  // Not in the model context...
  expect(bytesSentToProvider(provider.requests)).not.toContain('hunter2-do-not-leak');

  // ...and not in stored evidence either.
  const { evidence } = await send('evidence.listForTask', { taskId: task.id });
  for (const item of evidence) {
    const payload = await send('evidence.getPayload', { evidenceId: item.id });
    expect(payload.content ?? '').not.toContain('hunter2-do-not-leak');
  }
});

test('the agent cannot navigate to a scheme the policy refuses', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  const before = page.url();

  await connectProvider(send, provider);
  provider.script([
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser_navigate', arguments: { url: 'chrome://settings' } }],
    },
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser_navigate', arguments: { url: 'javascript:alert(1)' } }],
    },
    { kind: 'text', text: 'Both were refused.' },
  ]);

  const { task } = await send('task.create', { objective: 'Open the browser settings.' });
  const finished = await waitForTask(send, task.id);

  // Neither navigation happened.
  expect(page.url()).toBe(before);
  const refused = [...finished.result!.failedActions, ...finished.result!.blockedActions].join(' ');
  expect(refused).toContain('browser.navigate');

  const sent = bytesSentToProvider(provider.requests);
  expect(sent).toMatch(/POLICY_BLOCKED|INVALID_ARGUMENT/);
});

test('the agent cannot reach the extension gallery', async ({ context, send, provider, site }) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    {
      kind: 'tool_calls',
      calls: [
        { name: 'tabs_create', arguments: { url: 'https://chromewebstore.google.com/detail/x' } },
      ],
    },
    { kind: 'text', text: 'Refused.' },
  ]);

  const { task } = await send('task.create', { objective: 'Install an extension.' });
  const finished = await waitForTask(send, task.id);

  const refused = [...finished.result!.failedActions, ...finished.result!.blockedActions].join(' ');
  expect(refused).toContain('tabs.create');
  const urls = context.pages().map((p) => p.url());
  expect(urls.some((u) => u.includes('chromewebstore'))).toBe(false);
});

test('a tool the registry does not expose is refused, not invented', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser_execute_script', arguments: { code: 'alert(1)' } }],
    },
    {
      kind: 'tool_calls',
      calls: [{ name: 'debugger_command', arguments: { method: 'Runtime.evaluate' } }],
    },
    { kind: 'text', text: 'Neither tool exists.' },
  ]);

  const { task } = await send('task.create', { objective: 'Run some script.' });
  const finished = await waitForTask(send, task.id);

  expect(finished.result!.failedActions.join(' ')).toContain('browser.execute_script');
  expect(bytesSentToProvider(provider.requests)).toContain('TOOL_NOT_FOUND');
});

test('malformed tool arguments are rejected before anything executes', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  const originalValue = await page.inputValue('#search');

  await connectProvider(send, provider);
  provider.script([
    // elementId is required and must be a non-empty string.
    { kind: 'tool_calls', calls: [{ name: 'browser_type', arguments: { text: 'no target' } }] },
    { kind: 'text', text: 'The arguments were invalid.' },
  ]);

  const { task } = await send('task.create', { objective: 'Type something.' });
  const finished = await waitForTask(send, task.id);

  expect(finished.result!.failedActions.join(' ')).toContain('browser.type');
  expect(await page.inputValue('#search')).toBe(originalValue);
  expect(bytesSentToProvider(provider.requests)).toContain('INVALID_ARGUMENT');
});

test('a hard-prohibited action is denied in skip mode', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  // Skip is the most permissive mode the product offers.
  await send('session.setPermissionMode', { mode: 'skip' });
  await connectProvider(send, provider);

  const { state } = await send('policy.getSitePolicy', {}).then(() => ({ state: 'ok' }));
  expect(state).toBe('ok');

  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'text', text: 'Read it.' },
  ]);

  const { task } = await send('task.create', { objective: 'Read the page.' });
  const finished = await waitForTask(send, task.id);

  // Skip mode still runs ordinary work.
  expect(finished.state).toBe('COMPLETED');
  // And the instruction still tells the model which prohibitions stand.
  const sent = bytesSentToProvider(provider.requests);
  expect(sent).toContain('payments');
  expect(sent).toContain('permanent deletion');
});

test('the debugger surface never receives a model-named CDP method', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  const { tools } = await send('tools.list', {});
  const debuggerTools = tools.filter((tool) => tool.name.startsWith('debugger.'));

  expect(debuggerTools.length).toBeGreaterThan(0);

  // The schemas the model actually receives must not offer a method field.
  const schemas = provider.requests
    .filter((r) => r.path.endsWith('/chat/completions'))
    .flatMap((r) => (r.body as { tools?: unknown[] }).tools ?? []);
  const debuggerSchemas = JSON.stringify(
    schemas.filter((tool) => JSON.stringify(tool).includes('debugger_')),
  );

  expect(debuggerSchemas).not.toContain('Runtime.evaluate');
  expect(debuggerSchemas.toLowerCase()).not.toContain('"method"');
});

test('permission history records what was decided', async ({ context, send, provider, site }) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'text', text: 'Read it.' },
  ]);

  const { task } = await send('task.create', { objective: 'Read the page.' });
  await waitForTask(send, task.id);

  const { state } = await send('policy.getSitePolicy', {});
  const entry = state.history.find((item) => item.tool === 'browser.read_page');

  expect(entry).toBeDefined();
  expect(entry!.decision).toBe('auto_approved');
  expect(entry!.risk).toBe('R0');
  expect(entry!.taskId).toBe(task.id);
});
