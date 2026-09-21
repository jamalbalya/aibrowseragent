/**
 * TEST-E2E-002 — Provider integration over real HTTP (REQ-PROVIDER-001).
 *
 * Stage 1 tested the adapter against a stubbed `fetch`. That proves the wire
 * translation but not that a service worker can actually reach a provider:
 * real sockets, real headers, real CORS preflight, real SSE framing. These
 * tests make genuine HTTP requests from inside the extension.
 */
import { connectProvider, expect, test, waitForTask } from './fixtures/extension';

test('connect performs a real reachability probe against the endpoint', async ({
  send,
  provider,
}) => {
  const result = await send('provider.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: 'test-key-abcdefghijklmnop',
    model: 'mock-model',
  });

  expect(result.error).toBeUndefined();
  expect(result.connection?.providerId).toBe('openai-compatible');
});

test('the capability doctor exercises the endpoint and reports what it observed', async ({
  send,
  provider,
}) => {
  await send('provider.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: 'test-key-abcdefghijklmnop',
    model: 'mock-model',
  });

  const { report } = await send('provider.runDoctor', {
    providerId: 'openai-compatible',
    modelId: 'mock-model',
  });

  expect(report.readiness).toBe('AGENT_READY');
  expect(report.capabilities.toolCalling).toBe(true);
  expect(report.capabilities.streaming).toBe(true);

  // Every check was a real round trip, not an assumption.
  const paths = provider.requests.map((request) => request.path);
  expect(paths.filter((p) => p.endsWith('/chat/completions')).length).toBeGreaterThanOrEqual(4);
  expect(paths).toContain('/v1/models');
});

test('the API key is sent as a bearer token and never as query or body content', async ({
  send,
  provider,
}) => {
  await connectProvider(send, provider);

  const completions = provider.requests.filter((r) => r.path.endsWith('/chat/completions'));
  expect(completions.length).toBeGreaterThan(0);

  for (const request of completions) {
    expect(request.headers.authorization).toBe('Bearer test-key-abcdefghijklmnop');
    expect(request.path).not.toContain('test-key');
    expect(JSON.stringify(request.body)).not.toContain('test-key-abcdefghijklmnop');
  }
});

test('the doctor reports CHAT_ONLY when the endpoint cannot call tools', async ({
  send,
  provider,
}) => {
  provider.setToolCallingSupported(false);
  await send('provider.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: 'test-key-abcdefghijklmnop',
    model: 'mock-model',
  });

  const { report } = await send('provider.runDoctor', {
    providerId: 'openai-compatible',
    modelId: 'mock-model',
  });

  expect(report.readiness).toBe('CHAT_ONLY');
  expect(report.capabilities.toolCalling).toBe(false);
  // The stored connection must record the failure, not the hope.
  const { connection } = await send('provider.getConnection', {});
  expect(connection?.capabilities?.toolCalling).toBe(false);
  expect(connection?.status).toBe('limited');
});

test('a task is refused outright when the model cannot call tools', async ({ send, provider }) => {
  provider.setToolCallingSupported(false);
  await connectProvider(send, provider);

  const { task } = await send('task.create', { objective: 'Read this page.' });
  const finished = await waitForTask(send, task.id);

  expect(finished.state).toBe('BLOCKED');
  expect(finished.result?.summary).toContain('tool calling');
});

test('an invalid API key surfaces as an auth failure rather than a generic error', async ({
  send,
  provider,
}) => {
  await connectProvider(send, provider);
  provider.script([{ kind: 'http_error', status: 401, body: '{"error":"invalid key"}' }]);

  const { task } = await send('task.create', { objective: 'Do something.' });
  const finished = await waitForTask(send, task.id);

  expect(finished.state).toBe('FAILED');
  expect(finished.result?.summary).toMatch(/API key|credential|rejected/i);
  expect(finished.error?.code).toBe('AUTH_EXPIRED');
});

test('a rate limit is retried, then the task continues', async ({ send, provider }) => {
  await connectProvider(send, provider);
  provider.script([
    { kind: 'http_error', status: 429 },
    { kind: 'text', text: 'Recovered after the rate limit cleared.' },
  ]);

  const { task } = await send('task.create', { objective: 'Summarise something.' });
  const finished = await waitForTask(send, task.id, 40_000);

  expect(finished.state).toBe('COMPLETED');
  expect(finished.usage.retries).toBeGreaterThan(0);
});

test('a server error that never clears fails the task cleanly', async ({ send, provider }) => {
  await connectProvider(send, provider);
  provider.script([
    { kind: 'http_error', status: 500 },
    { kind: 'http_error', status: 500 },
    { kind: 'http_error', status: 500 },
    { kind: 'http_error', status: 500 },
  ]);

  const { task } = await send('task.create', { objective: 'Try something.' });
  const finished = await waitForTask(send, task.id, 45_000);

  expect(finished.state).toBe('FAILED');
  // It stopped at the retry limit rather than hammering the endpoint.
  expect(finished.usage.retries).toBeLessThanOrEqual(3);
});

test('disconnecting clears the stored credential', async ({ send, provider }) => {
  await connectProvider(send, provider);
  await send('provider.disconnect', { providerId: 'openai-compatible' });

  const { connection } = await send('provider.getConnection', {});
  expect(connection).toBeNull();

  // A task cannot start without a provider, and says so.
  await expect(send('task.create', { objective: 'Anything.' })).rejects.toThrow(/provider/i);
});

test('the canonical tool schemas reach the provider in its native format', async ({
  send,
  provider,
}) => {
  await connectProvider(send, provider);
  provider.script([{ kind: 'text', text: 'Nothing to do.' }]);

  const { task } = await send('task.create', { objective: 'Say hello.' });
  await waitForTask(send, task.id);

  const agentTurn = provider.requests
    .filter((r) => r.path.endsWith('/chat/completions'))
    .map((r) => r.body as { tools?: { function?: { name?: string } }[] })
    .find((body) => (body.tools?.length ?? 0) > 5);

  expect(agentTurn).toBeDefined();
  const names = agentTurn!.tools!.map((tool) => tool.function?.name);

  // Dots are not valid in a provider function name, so they are translated.
  expect(names).toContain('browser_read_page');
  expect(names).toContain('tabs_wait_for_navigation');
  expect(names.some((name) => name?.includes('.'))).toBe(false);
});
