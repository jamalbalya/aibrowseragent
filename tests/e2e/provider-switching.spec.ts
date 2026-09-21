/**
 * TEST-E2E-008 — API provider registry and switching in real Chromium
 * (Stage 3 Wave C).
 *
 * REAL BROWSER + MOCKED PROVIDER TRANSPORT. The endpoints are local servers
 * speaking the Anthropic and Gemini protocols; no commercial provider is
 * reached. LIVE PROVIDER E2E — the same trajectories against the real
 * services with project credentials — does not exist here, and nothing below
 * should be read as evidence that it does.
 *
 * What this does establish is what no in-process test can: that a real MV3
 * service worker can carry all three wire protocols over real sockets, and
 * that switching between them inside a running extension behaves the way the
 * unit and integration tests say it does.
 */
import { expect, test, waitForTask } from './fixtures/extension';

const KEY = 'test-key-abcdefghijklmnop';

test('the registry offers all three API providers and no web provider', async ({ send }) => {
  const { providers } = await send('provider.list', {});
  const ids = providers.map((provider) => provider.id).sort();

  expect(ids).toEqual(['anthropic', 'gemini', 'openai-compatible']);
  // Web providers are foundation only. None is registered, so none is
  // selectable, so no inference against an authenticated web session can be
  // started from the panel.
  expect(providers.every((provider) => provider.kind === 'api')).toBe(true);
  expect(providers.every((provider) => provider.authKind === 'api_key')).toBe(true);
});

test('a provider with its own endpoint does not demand one, and one without it does', async ({
  send,
}) => {
  const { providers } = await send('provider.list', {});
  const byId = Object.fromEntries(providers.map((provider) => [provider.id, provider]));

  expect(byId['openai-compatible']!.baseUrlRequired).toBe(true);
  expect(byId['openai-compatible']!.defaultBaseUrl).toBeUndefined();
  expect(byId.anthropic!.baseUrlRequired).toBe(false);
  expect(byId.anthropic!.defaultBaseUrl).toContain('https://');
  expect(byId.gemini!.defaultBaseUrl).toContain('https://');
});

test('the Anthropic adapter completes a real round trip over sockets', async ({
  send,
  nativeProviders,
}) => {
  const result = await send('provider.connect', {
    providerId: 'anthropic',
    baseUrl: nativeProviders.anthropicBaseUrl,
    apiKey: KEY,
    model: 'mock-claude',
  });
  expect(result.error).toBeUndefined();

  const { report } = await send('provider.runDoctor', {
    providerId: 'anthropic',
    modelId: 'mock-claude',
  });
  expect(report.readiness).toBe('AGENT_READY');
  expect(report.capabilities.toolCalling).toBe(true);
  expect(report.capabilities.streaming).toBe(true);
  // Not claimed, because this API cannot enforce it.
  expect(report.capabilities.structuredOutput).toBe(false);

  const messages = nativeProviders.requests.filter((request) =>
    request.path.startsWith('/anthropic/v1/messages'),
  );
  expect(messages.length).toBeGreaterThanOrEqual(3);
  for (const request of messages) {
    // Its own header scheme, its own required version header.
    expect(request.headers['x-api-key']).toBe(KEY);
    expect(request.headers['anthropic-version']).toBeTruthy();
    expect(request.headers.authorization).toBeUndefined();
    expect(request.path).not.toContain(KEY);
    expect(JSON.stringify(request.body)).not.toContain(KEY);
  }
});

test('the Gemini adapter completes a real round trip and sends no key in a URL', async ({
  send,
  nativeProviders,
}) => {
  const result = await send('provider.connect', {
    providerId: 'gemini',
    baseUrl: nativeProviders.geminiBaseUrl,
    apiKey: KEY,
    model: 'mock-gemini',
  });
  expect(result.error).toBeUndefined();

  const { report } = await send('provider.runDoctor', {
    providerId: 'gemini',
    modelId: 'mock-gemini',
  });
  expect(report.readiness).toBe('AGENT_READY');
  // Discovered from the endpoint rather than guessed from the model name.
  expect(report.capabilities.contextWindow).toBe(32_000);

  const gemini = nativeProviders.requests.filter((request) => request.path.startsWith('/gemini'));
  expect(gemini.length).toBeGreaterThan(0);
  for (const request of gemini) {
    // This endpoint documents a `key=` query parameter. The adapter does not
    // use it, because the egress gate builds a destination identity from the
    // URL and a credential there would reach consent keys and audit records.
    expect(request.path).not.toContain(KEY);
    expect(request.path).not.toMatch(/[?&]key=/i);
    expect(request.headers['x-goog-api-key']).toBe(KEY);
    expect(JSON.stringify(request.body ?? {})).not.toContain(KEY);
  }
});

test('a tool call from each provider drives the same browser action', async ({
  context,
  send,
  site,
  nativeProviders,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  for (const provider of [
    { id: 'anthropic', baseUrl: nativeProviders.anthropicBaseUrl, model: 'mock-claude' },
    { id: 'gemini', baseUrl: nativeProviders.geminiBaseUrl, model: 'mock-gemini' },
  ]) {
    await send('provider.connect', {
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      apiKey: KEY,
      model: provider.model,
    });
    await send('provider.runDoctor', { providerId: provider.id, modelId: provider.model });
    await send('provider.setActive', { providerId: provider.id, modelId: provider.model });

    nativeProviders.script([
      { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
      { kind: 'text', text: `Read through ${provider.id}.` },
    ]);

    const { task: started } = await send('task.create', {
      objective: 'Read the current page and summarise it.',
    });
    const task = await waitForTask(send, started.id);

    expect(task.state, `${provider.id}: ${JSON.stringify(task.result)}`).toBe('COMPLETED');
    // The canonical tool name, resolved by the shared registry rather than
    // executed by whichever adapter produced the call.
    expect(task.result?.completedActions, provider.id).toContain('browser.read_page');
  }
});

test('switching provider mid-session does not carry the previous authorization', async ({
  send,
  provider,
  nativeProviders,
}) => {
  // Start on the OpenAI-compatible endpoint and finish a task there.
  await send('provider.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: KEY,
    model: 'mock-model',
  });
  await send('provider.runDoctor', { providerId: 'openai-compatible', modelId: 'mock-model' });
  await send('provider.setActive', { providerId: 'openai-compatible', modelId: 'mock-model' });
  provider.script([{ kind: 'text', text: 'Done on the first provider.' }]);

  const { task: first } = await send('task.create', { objective: 'Say hello.' });
  expect((await waitForTask(send, first.id)).state).toBe('COMPLETED');

  // Switch. A new task must reach the new endpoint, and the old one must see
  // nothing more: authentication and consent are per provider, not per session.
  const before = provider.requests.length;
  await send('provider.connect', {
    providerId: 'gemini',
    baseUrl: nativeProviders.geminiBaseUrl,
    apiKey: KEY,
    model: 'mock-gemini',
  });
  await send('provider.runDoctor', { providerId: 'gemini', modelId: 'mock-gemini' });
  await send('provider.setActive', { providerId: 'gemini', modelId: 'mock-gemini' });
  nativeProviders.script([{ kind: 'text', text: 'Done on the second provider.' }]);

  const { task: second } = await send('task.create', { objective: 'Say hello again.' });
  const task = await waitForTask(send, second.id);

  expect(task.state, JSON.stringify(task.result)).toBe('COMPLETED');
  expect(task.result?.summary).toContain('second provider');
  const generateCalls = nativeProviders.requests.filter((request) =>
    request.path.includes(':generateContent'),
  );
  expect(generateCalls.length).toBeGreaterThan(0);
  // Nothing further reached the endpoint the task left behind.
  expect(provider.requests.length).toBe(before);
});

test('switching model re-runs the capability check rather than inheriting one', async ({
  send,
  nativeProviders,
}) => {
  await send('provider.connect', {
    providerId: 'anthropic',
    baseUrl: nativeProviders.anthropicBaseUrl,
    apiKey: KEY,
    model: 'mock-claude',
  });
  const first = await send('provider.runDoctor', {
    providerId: 'anthropic',
    modelId: 'mock-claude',
  });
  expect(first.report.modelId).toBe('mock-claude');

  // A different model is a different set of claims, and the report says so.
  const second = await send('provider.runDoctor', {
    providerId: 'anthropic',
    modelId: 'another-model',
  });
  expect(second.report.modelId).toBe('another-model');
  expect(second.report.generatedAt).toBeGreaterThanOrEqual(first.report.generatedAt);
});

test('the doctor reports CHAT_ONLY when a native provider cannot call tools', async ({
  send,
  nativeProviders,
}) => {
  nativeProviders.setToolCallingSupported(false);
  await send('provider.connect', {
    providerId: 'gemini',
    baseUrl: nativeProviders.geminiBaseUrl,
    apiKey: KEY,
    model: 'mock-gemini',
  });

  const { report } = await send('provider.runDoctor', {
    providerId: 'gemini',
    modelId: 'mock-gemini',
  });
  expect(report.readiness).toBe('CHAT_ONLY');
  expect(report.capabilities.toolCalling).toBe(false);
});

test('no provider credential appears in the service worker log', async ({
  send,
  nativeProviders,
  workerLogs,
}) => {
  for (const provider of [
    { id: 'anthropic', baseUrl: nativeProviders.anthropicBaseUrl, model: 'mock-claude' },
    { id: 'gemini', baseUrl: nativeProviders.geminiBaseUrl, model: 'mock-gemini' },
  ]) {
    await send('provider.connect', {
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      apiKey: KEY,
      model: provider.model,
    });
    await send('provider.runDoctor', { providerId: provider.id, modelId: provider.model });
  }

  expect(workerLogs.join('\n')).not.toContain(KEY);
});

test('the audit trail records each provider decision without the credential', async ({
  send,
  nativeProviders,
}) => {
  await send('provider.connect', {
    providerId: 'anthropic',
    baseUrl: nativeProviders.anthropicBaseUrl,
    apiKey: KEY,
    model: 'mock-claude',
  });
  await send('provider.runDoctor', { providerId: 'anthropic', modelId: 'mock-claude' });

  const { events } = await send('audit.list', { limit: 100 });
  const egress = events.filter((event) => event.type === 'egress.decided');
  expect(egress.length).toBeGreaterThan(0);
  expect(egress.some((event) => event.providerId === 'anthropic')).toBe(true);

  const serialised = JSON.stringify(events);
  expect(serialised).not.toContain(KEY);
  // The destination is an identity, not a URL with anything appended.
  for (const event of egress) {
    if (event.destination) expect(event.destination).not.toContain('?');
  }
});
