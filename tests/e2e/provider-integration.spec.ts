/**
 * TEST-E2E-002 — Provider integration over real HTTP (REQ-PROVIDER-001).
 *
 * MOCK PROVIDER E2E. The endpoint is a local server implementing the Chat
 * Completions protocol, not a commercial provider.
 *
 * Stage 1 tested the adapter against a stubbed `fetch`. That proves the wire
 * translation but not that a service worker can actually reach a provider:
 * real sockets, real headers, real CORS preflight, real SSE framing. These
 * tests make genuine HTTP requests from inside the extension.
 *
 * LIVE PROVIDER E2E — running this same trajectory against OpenAI, Anthropic
 * or Gemini with real credentials — does not exist. It is what specification
 * §87 asks for and what P-033 still needs. Nothing here should be read as
 * evidence that a commercial provider has been exercised.
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

test('a namespaced model id keeps its probe records and leaves the trail healthy', async ({
  send,
  provider,
}) => {
  // The production report, reproduced in the real extension. An
  // OpenAI-compatible endpoint configured with `cx/gpt-5.6-terra` — a routed
  // model, so the id carries a namespace — made every capability probe's
  // `egress.decided` record unwritable: the probe's pseudo-task id interpolated
  // the model id verbatim, a `/` is not an opaque identifier, and the audit log
  // refused the record before appending it. The panel then said
  // "Some stored records were lost" with `audit — corrupt`.
  //
  // Nothing about 9Router is needed to show it: the trigger is the model
  // identifier, which the mock endpoint carries exactly as a real one would.
  const model = 'cx/gpt-5.6-terra';
  provider.setModels([model]);

  await send('provider.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: 'test-key-abcdefghijklmnop',
    model,
  });
  const { report } = await send('provider.runDoctor', {
    providerId: 'openai-compatible',
    modelId: model,
  });
  expect(report.readiness).toBe('AGENT_READY');

  // The audit domain is the one that used to go CORRUPT, and it is durable —
  // a health record survives worker eviction, which is why the banner kept
  // coming back across separate tasks.
  const { snapshot } = await send('health.get', {});
  const audit = snapshot.records.find((record) => record.domain === 'audit');
  expect(audit?.state ?? 'HEALTHY').toBe('HEALTHY');
  expect(snapshot.blocked).toBe(false);

  // And the records the probes produced are actually in the trail, under the
  // name this build originates rather than as `(unknown)`.
  const { events } = await send('audit.list', { limit: 200 });
  const probes = events.filter(
    (event) => event.type === 'egress.decided' && event.tool === 'provider.request',
  );
  expect(probes.length).toBeGreaterThan(0);
  for (const probe of probes) {
    expect(probe.taskId).toMatch(/^[A-Za-z0-9_.:-]{1,80}$/);
    // The raw model id is not what identifies the probe.
    expect(probe.taskId).not.toContain('/');
  }
});
