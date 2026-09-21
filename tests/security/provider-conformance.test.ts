/**
 * TEST-SECURITY-019 — API provider conformance (Stage 3 Wave C).
 *
 * One suite, run against every registered API provider factory. It exists
 * because "we added a provider" must not be able to mean "we added a second
 * way out": the security properties that hold for the reference adapter —
 * the transport is the only route to the network, a request with no security
 * context is refused, a model switch re-enters the gate — have to hold for
 * all of them, and the way to know that is to ask all of them the same
 * questions.
 *
 * The suite is provider-independent in its *questions*, not in its
 * *expectations*. Each provider answers in its own wire format and the pack
 * in `tests/fixtures/provider-wire.ts` translates, so a provider that quietly
 * started speaking someone else's dialect would fail here rather than pass by
 * resembling the others.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderRegistry } from '@/providers/registry/provider-registry';
import {
  isRetryableCategory,
  providerFailure,
  ProviderRequestError,
  type ProviderErrorCategory,
} from '@/providers/core/provider-error';
import { decideRetryFor, DEFAULT_RETRY_POLICY } from '@/agent/recovery/retry-policy';
import { PROVIDER_OPERATIONS } from '@/providers/core/types';
import {
  createGuardedTransport,
  managementTaskId,
  refusingTransport,
  type EgressContext,
  type ProviderTransport,
} from '@/security/egress/provider-transport';
import { ConsentStore } from '@/security/egress/consent';
import { addTaint, freshTaint, unknownTaint } from '@/security/taint/taint-state';
import type { TaintSource } from '@/security/exfiltration/exfiltration-guard';
import type {
  AIProviderAdapter,
  CanonicalEvent,
  CanonicalRequest,
  CanonicalToolSchema,
} from '@/providers/core/types';
import {
  API_PROVIDER_CASES,
  API_PROVIDER_PACKS,
  type ProviderWirePack,
} from '../fixtures/provider-wire';

const PROBE_TOOL: CanonicalToolSchema = {
  type: 'function',
  name: 'browser_click',
  description: 'Clicks an element.',
  parameters: {
    type: 'object',
    properties: { elementId: { type: 'string' } },
    required: ['elementId'],
    additionalProperties: false,
  },
};

const privatePage: TaintSource = {
  sourceType: 'web_page',
  site: 'intranet.example',
  sensitivity: 'confidential',
};

function context(pack: ProviderWirePack, overrides: Partial<EgressContext> = {}): EgressContext {
  return {
    taskId: 'task_conformance',
    taintState: freshTaint(),
    taintSalt: 'ab'.repeat(32),
    saltEpoch: 1,
    taintSignature: 'sig',
    providerId: pack.factory.id,
    modelId: pack.config.model ?? '',
    ...overrides,
  };
}

function request(
  pack: ProviderWirePack,
  overrides: Partial<CanonicalRequest> = {},
): CanonicalRequest {
  return {
    systemInstruction: 'You are the agent body.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    egress: context(pack),
    ...overrides,
  };
}

/** Records every request an adapter makes and replies with a scripted body. */
interface Recorder {
  readonly transport: ProviderTransport;
  readonly calls: { url: string; init: RequestInit }[];
  /** Generation calls only: the housekeeping GETs are filtered out. */
  bodies(): Record<string, unknown>[];
  urls(): string[];
  script(response: Response | (() => Response)): void;
}

function recorder(pack: ProviderWirePack, initial?: Response | (() => Response)): Recorder {
  const calls: { url: string; init: RequestInit }[] = [];
  let scripted: () => Response = () => pack.text('ok');
  if (initial) scripted = typeof initial === 'function' ? initial : () => initial;

  return {
    calls,
    transport: {
      request: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(pack.route(url, init, scripted));
      },
    },
    bodies: () =>
      calls
        .filter((call) => typeof call.init.body === 'string')
        .map((call) => JSON.parse(call.init.body as string) as Record<string, unknown>),
    urls: () => calls.map((call) => call.url),
    script: (response) => {
      scripted = typeof response === 'function' ? response : () => response;
    },
  };
}

async function connected(
  pack: ProviderWirePack,
  transport: ProviderTransport,
  model?: string,
): Promise<AIProviderAdapter> {
  const registry = new ProviderRegistry({ transport });
  registry.register(pack.factory);
  const adapter = registry.get(pack.factory.id);
  const config = model === undefined ? pack.config : { ...pack.config, model };
  const result = await adapter.connect(config);
  expect(result.authenticated).toBe(true);
  return adapter;
}

async function drain(events: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const collected: CanonicalEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

let consent: ConsentStore;
beforeEach(() => {
  consent = new ConsentStore();
});

describe('the suite covers every registered API provider', () => {
  it('has a pack for each one', () => {
    // The guard against a provider being added without being conformance
    // tested: the registry is the source of truth, not this file.
    expect(API_PROVIDER_PACKS.map((p) => p.factory.id).sort()).toEqual([
      'anthropic',
      'gemini',
      'openai-compatible',
    ]);
  });
});

describe.each(API_PROVIDER_CASES)('%s', (_id, pack) => {
  // 1. provider identity
  it('reports a stable identity that matches its factory', async () => {
    const adapter = await connected(pack, recorder(pack).transport);
    expect(adapter.id).toBe(pack.factory.id);
    expect(adapter.displayName).toBe(pack.factory.displayName);
    expect(adapter.displayName.trim().length).toBeGreaterThan(0);
  });

  // 2. provider kind
  it('is an API provider, on both the factory and the adapter', async () => {
    const adapter = await connected(pack, recorder(pack).transport);
    expect(pack.factory.kind).toBe('api');
    expect(adapter.kind).toBe('api');
  });

  // 3. auth kind
  it('declares an API key auth kind and sends the key in a header', async () => {
    expect(pack.factory.authKind).toBe('api_key');
    const rec = recorder(pack);
    const adapter = await connected(pack, rec.transport);
    await adapter.generate(request(pack));

    const headers = rec.calls[0]!.init.headers as Record<string, string>;
    expect(headers[pack.authHeader]).toBe(pack.authHeaderValue(pack.config.apiKey!));
    // And in no other header, however the provider frames it.
    const elsewhere = Object.entries(headers).filter(
      ([name, value]) => name !== pack.authHeader && value.includes(pack.config.apiKey!),
    );
    expect(elsewhere).toEqual([]);
  });

  // 4. canonical request generation
  it('translates a canonical request into its own wire shape', async () => {
    const rec = recorder(pack);
    const adapter = await connected(pack, rec.transport);
    await adapter.generate(
      request(pack, {
        systemInstruction: 'SYSTEM-MARKER',
        tools: [PROBE_TOOL],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'find the button' }] }],
      }),
    );

    const call = rec.calls.find((c) => c.url.includes(pack.generateFragment))!;
    const body = JSON.parse(call.init.body as string) as Record<string, unknown>;
    expect(pack.inspect.systemInstruction(body)).toBe('SYSTEM-MARKER');
    expect(pack.inspect.toolNames(body)).toEqual(['browser_click']);
    expect(pack.inspect.model(body, call.url)).toBe(pack.config.model);
  });

  // 5. canonical response parsing
  it('parses its own response shape into the canonical one', async () => {
    const rec = recorder(pack, () => pack.text('the canonical answer'));
    const adapter = await connected(pack, rec.transport);
    const response = await adapter.generate(request(pack));

    expect(response.text).toBe('the canonical answer');
    expect(response.toolCalls).toEqual([]);
    expect(response.finishReason).toBe('stop');
    expect(response.usage.promptTokens).toBe(11);
    expect(response.usage.completionTokens).toBe(7);
  });

  // 6. text generation
  it('generates text through the transport and nowhere else', async () => {
    const forbidden = vi.fn(() => {
      throw new Error('the network was reached without authorization');
    });
    vi.stubGlobal('fetch', forbidden);
    try {
      const rec = recorder(pack, () => pack.text('hi'));
      const adapter = await connected(pack, rec.transport);
      const response = await adapter.generate(request(pack));
      expect(response.text).toBe('hi');
      expect(rec.urls().some((url) => url.includes(pack.generateFragment))).toBe(true);
      expect(forbidden).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // 7. streaming
  it('streams deltas, a tool call and a final response', async () => {
    const rec = recorder(pack, () => pack.stream('browser_click', { elementId: 'e1' }));
    const adapter = await connected(pack, rec.transport);
    const events = await drain(adapter.stream!(request(pack, { tools: [PROBE_TOOL] })));

    const text = events
      .filter((e): e is Extract<CanonicalEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('Hello');

    const toolEvents = events.filter(
      (e): e is Extract<CanonicalEvent, { type: 'tool_call' }> => e.type === 'tool_call',
    );
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]!.toolCall.name).toBe('browser_click');
    expect(toolEvents[0]!.toolCall.arguments).toEqual({ elementId: 'e1' });

    const done = events.at(-1);
    expect(done?.type).toBe('done');

    const streamCall = rec.calls.find((c) => typeof c.init.body === 'string')!;
    const body = JSON.parse(streamCall.init.body as string) as Record<string, unknown>;
    expect(pack.inspect.wantsStream(body, streamCall.url)).toBe(true);
  });

  // 8. tool calling
  it('round-trips a tool call and its result in its own representation', async () => {
    const rec = recorder(pack, () => pack.toolCall('browser_click', { elementId: 'e7' }));
    const adapter = await connected(pack, rec.transport);

    const first = await adapter.generate(request(pack, { tools: [PROBE_TOOL] }));
    expect(first.finishReason).toBe('tool_call');
    expect(first.toolCalls).toHaveLength(1);
    const call = first.toolCalls[0]!;
    expect(call.name).toBe('browser_click');
    expect(call.arguments).toEqual({ elementId: 'e7' });
    expect(call.parseError).toBeUndefined();
    // An id is always present, even where the provider has no such concept.
    expect(call.toolCallId.length).toBeGreaterThan(0);

    rec.script(() => pack.text('done'));
    await adapter.generate(
      request(pack, {
        tools: [PROBE_TOOL],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'click it' }] },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                toolCallId: call.toolCallId,
                name: call.name,
                arguments: call.arguments,
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool_result',
                toolCallId: call.toolCallId,
                name: call.name,
                content: '{"ok":true}',
                isError: false,
              },
            ],
          },
        ],
      }),
    );

    const body = rec.bodies().at(-1)!;
    expect(pack.inspect.assistantToolCalls(body)).toEqual([{ name: 'browser_click' }]);
    expect(pack.inspect.toolResults(body).join('')).toContain('true');
  });

  // 9. repeated / multiple calls
  it('re-enters the gate on every call rather than carrying one decision forward', async () => {
    const inner = vi.fn((url: string, init: RequestInit) =>
      pack.route(url, init, () => pack.text('ok')),
    );
    const guarded = createGuardedTransport({
      consent,
      fetchImpl: ((url: string, init: RequestInit) =>
        Promise.resolve(inner(url, init))) as unknown as typeof fetch,
    });
    const adapter = await connected(pack, guarded);

    await adapter.generate(request(pack));
    await adapter.generate(
      request(pack, {
        egress: context(pack, { taintState: addTaint(freshTaint(), [privatePage]) }),
      }),
    );
    const before = inner.mock.calls.length;
    expect(before).toBeGreaterThanOrEqual(2);

    // Third turn, provenance lost. Nothing carries over from the first two.
    await expect(
      adapter.generate(
        request(pack, {
          egress: context(pack, { taintState: unknownTaint('persistence-failed') }),
        }),
      ),
    ).rejects.toThrow();
    expect(inner.mock.calls.length).toBe(before);
  });

  // 10. vision where supported
  it('carries an image in its own representation when the model accepts one', async () => {
    const rec = recorder(pack, () => pack.text('seen'));
    const adapter = await connected(pack, rec.transport, pack.visionModel);
    await adapter.generate(
      request(pack, {
        egress: context(pack, { modelId: pack.visionModel }),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this' },
              { type: 'image', data: 'QUFBQQ==', mimeType: 'image/png' },
            ],
          },
        ],
      }),
    );

    const body = rec.bodies().at(-1)!;
    expect(pack.inspect.images(body)).toEqual([{ mimeType: 'image/png', data: 'QUFBQQ==' }]);
  });

  // 11. invalid credentials
  it('reports a rejected key as an authentication failure', async () => {
    const rec = recorder(pack, () => pack.failure(401));
    const adapter = await connected(pack, rec.transport);

    await expect(adapter.generate(request(pack))).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProviderRequestError &&
        error.category === 'authentication_failed' &&
        error.agentError.code === 'AUTH_EXPIRED' &&
        error.agentError.retryable === false,
    );
  });

  // 12. expired / not-entitled authentication
  it('separates "not permitted" from "key rejected"', async () => {
    const rec = recorder(pack, () => pack.failure(403));
    const adapter = await connected(pack, rec.transport);

    await expect(adapter.generate(request(pack))).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProviderRequestError &&
        error.category === 'access_denied' &&
        error.agentError.retryable === false,
    );
  });

  // 13. rate limiting
  it('normalises a rate limit and keeps the server-supplied backoff', async () => {
    const rec = recorder(pack, () => pack.failure(429));
    const adapter = await connected(pack, rec.transport);

    await expect(adapter.generate(request(pack))).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProviderRequestError &&
        error.category === 'rate_limited' &&
        error.agentError.code === 'RATE_LIMITED' &&
        error.agentError.retryable === true &&
        error.retryAfterMs === 7000,
    );
  });

  // 14. unsupported capability
  it('refuses an image on a model that cannot read one, rather than dropping it', async () => {
    const rec = recorder(pack, () => pack.text('should never be reached'));
    const adapter = await connected(pack, rec.transport, pack.noVisionModel);
    const before = rec.calls.length;

    await expect(
      adapter.generate(
        request(pack, {
          egress: context(pack, { modelId: pack.noVisionModel }),
          messages: [
            {
              role: 'user',
              content: [{ type: 'image', data: 'QUFBQQ==', mimeType: 'image/png' }],
            },
          ],
        }),
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProviderRequestError &&
        error.category === 'unsupported_capability' &&
        error.agentError.code === 'MODEL_UNSUPPORTED' &&
        error.agentError.retryable === false,
    );

    // The silent-downgrade check: no generation request was made at all.
    expect(rec.calls.filter((c) => c.url.includes(pack.generateFragment)).length).toBe(
      rec.calls.slice(0, before).filter((c) => c.url.includes(pack.generateFragment)).length,
    );
  });

  // 15. transport injection
  it('is built with the registry transport and uses it', async () => {
    const rec = recorder(pack);
    const registry = new ProviderRegistry({ transport: rec.transport });
    registry.register(pack.factory);
    const adapter = registry.get(pack.factory.id);
    await adapter.connect(pack.config);
    await adapter.generate(request(pack));

    expect(rec.urls().some((url) => url.includes(pack.generateFragment))).toBe(true);
    expect(pack.factory.requiresGuardedTransport).toBe(true);
  });

  // 16. blocked transport
  it('reaches nothing when its transport refuses', async () => {
    const forbidden = vi.fn(() => {
      throw new Error('the network was reached without authorization');
    });
    vi.stubGlobal('fetch', forbidden);
    try {
      const registry = new ProviderRegistry({
        transport: { request: () => Promise.reject(new Error('refused by transport')) },
      });
      registry.register(pack.factory);
      const adapter = registry.get(pack.factory.id);
      await adapter.connect(pack.config);

      await expect(adapter.generate(request(pack))).rejects.toThrow();
      expect(forbidden).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // 17. provider / model switch
  it('loses its authorization when the model changes mid-task', async () => {
    const inner = vi.fn((url: string, init: RequestInit) =>
      pack.route(url, init, () => pack.text('ok')),
    );
    const guarded = createGuardedTransport({
      consent,
      fetchImpl: ((url: string, init: RequestInit) =>
        Promise.resolve(inner(url, init))) as unknown as typeof fetch,
    });
    const adapter = await connected(pack, guarded);
    const tainted = addTaint(freshTaint(), [privatePage]);

    await adapter.generate(request(pack, { egress: context(pack, { taintState: tainted }) }));
    const before = inner.mock.calls.length;

    // The pin binds provider identity *and* model, so a different model is a
    // different authorization question.
    // Reported as blocked rather than as a network fault. The distinction is
    // load-bearing: a network fault is retryable, and retrying a refusal
    // would send the same denied request again.
    await expect(
      adapter.generate(
        request(pack, {
          egress: context(pack, { taintState: tainted, modelId: 'some-other-model' }),
        }),
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProviderRequestError &&
        error.category === 'transport_blocked' &&
        error.agentError.code === 'POLICY_BLOCKED' &&
        error.agentError.retryable === false,
    );
    expect(inner.mock.calls.length).toBe(before);
  });

  // 18. retry re-enters authorization
  it('re-authorises a retry instead of reusing the first attempt’s decision', async () => {
    let attempt = 0;
    const inner = vi.fn((url: string, init: RequestInit) =>
      pack.route(url, init, () => {
        attempt += 1;
        // 500 rather than 503: every provider reads it the same way, so the
        // category this asserts is the same question for all of them.
        return attempt === 1 ? pack.failure(500) : pack.text('recovered');
      }),
    );
    const decisions: string[] = [];
    const guarded = createGuardedTransport({
      consent,
      fetchImpl: ((url: string, init: RequestInit) =>
        Promise.resolve(inner(url, init))) as unknown as typeof fetch,
      onDecision: (decision) => {
        decisions.push(`${decision.verdict}:${decision.code}`);
        return Promise.resolve();
      },
    });
    const adapter = await connected(pack, guarded);

    // First attempt: a transient failure the policy would retry.
    await expect(adapter.generate(request(pack))).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProviderRequestError &&
        error.category === 'transient_provider_failure' &&
        error.agentError.retryable === true,
    );

    const afterFirst = decisions.length;
    const response = await adapter.generate(request(pack));
    expect(response.text).toBe('recovered');
    // The retry produced its own decision rather than inheriting one.
    expect(decisions.length).toBeGreaterThan(afterFirst);

    // And the gate can still refuse the retry on its own terms.
    await expect(
      adapter.generate(
        request(pack, { egress: context(pack, { taintState: unknownTaint('malformed') }) }),
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProviderRequestError && error.category === 'transport_blocked',
    );
  });

  // 19. no direct network path
  it('refuses rather than reaching out when built without a transport', async () => {
    const forbidden = vi.fn(() => {
      throw new Error('the network was reached without authorization');
    });
    vi.stubGlobal('fetch', forbidden);
    try {
      const registry = new ProviderRegistry();
      registry.register(pack.factory);
      const adapter = registry.get(pack.factory.id);
      await adapter.connect(pack.config);

      await expect(adapter.generate(request(pack))).rejects.toThrow();
      expect(forbidden).not.toHaveBeenCalled();

      // And the same for one built outside the registry entirely.
      const orphan = pack.factory.create(refusingTransport());
      await orphan.connect(pack.config);
      await expect(orphan.generate(request(pack))).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof ProviderRequestError &&
          error.category === 'transport_blocked' &&
          // Not a retryable network error: there is no transport to retry with.
          error.agentError.retryable === false &&
          /guarded transport/i.test(error.message),
      );
      expect(forbidden).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // 20. malformed provider response
  it('reports an unreadable 200 as malformed rather than as an empty answer', async () => {
    const rec = recorder(pack, () => pack.malformed());
    const adapter = await connected(pack, rec.transport);

    await expect(adapter.generate(request(pack))).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProviderRequestError &&
        error.category === 'malformed_response' &&
        // Malformed is never retryable: the same body would come back.
        error.agentError.retryable === false,
    );
  });

  // 21. provider error normalisation
  it('normalises every status into one category vocabulary, keeping its own code', async () => {
    const expectations: [number, string][] = [
      [401, 'authentication_failed'],
      [403, 'access_denied'],
      [404, 'unsupported_capability'],
      [429, 'rate_limited'],
      [500, 'transient_provider_failure'],
      [400, 'invalid_request'],
    ];

    for (const [status, category] of expectations) {
      const rec = recorder(pack, () => pack.failure(status));
      const adapter = await connected(pack, rec.transport);
      const error = await adapter.generate(request(pack)).then(
        () => null,
        (e: unknown) => e as ProviderRequestError,
      );

      expect(error, `status ${status}`).toBeInstanceOf(ProviderRequestError);
      expect(error!.category, `status ${status}`).toBe(category);
      expect(error!.providerId).toBe(pack.factory.id);
      expect(error!.httpStatus).toBe(status);
      // The provider's own vocabulary survives beside the normalised one.
      if (pack.factory.id !== 'openai-compatible') {
        expect(error!.providerCode, `status ${status}`).toBeDefined();
      }
      // Never the credential, in any field the UI or a log might render.
      const serialised = JSON.stringify(error!.agentError);
      expect(serialised).not.toContain(pack.config.apiKey);
    }
  });
});

describe('registry entries declare what the conformance suite relies on', () => {
  it.each(API_PROVIDER_CASES)(
    '%s declares its operations and transport requirement',
    (_id, pack) => {
      const factory = pack.factory;
      expect(factory.requiresGuardedTransport).toBe(true);
      expect(factory.operations.length).toBeGreaterThan(0);
      for (const operation of factory.operations) {
        expect(PROVIDER_OPERATIONS).toContain(operation);
      }
      // Every pack exercises streaming and tool calling, so every provider has
      // to claim them; a provider that did not would need its own suite.
      expect(factory.operations).toContain('stream');
      expect(factory.operations).toContain('toolCalling');
      expect(factory.baselineCapabilities.text).toBe(true);
      expect(factory.baselineCapabilities.systemInstruction).toBe(true);
    },
  );

  it.each(API_PROVIDER_CASES)('%s never puts a credential in a URL', async (_id, pack) => {
    const rec = recorder(pack, () => pack.text('ok'));
    const adapter = await connected(pack, rec.transport);
    await adapter.generate(request(pack));
    await adapter.listModels();
    await drain(adapter.stream!(request(pack)));

    for (const url of rec.urls()) {
      expect(url).not.toContain(pack.config.apiKey);
      expect(url).not.toMatch(/[?&](key|api_?key|access_token)=/i);
    }
  });
});

describe('normalised categories drive the one retry policy', () => {
  /**
   * The join §20 describes: a provider-specific failure becomes a category,
   * the category decides retryability, and the existing policy does the rest.
   * Asserted per provider because each maps its own vocabulary, and a
   * provider that classified a rejected key as transient would retry it.
   */
  const NEVER_RETRY: ProviderErrorCategory[] = [
    'authentication_failed',
    'access_denied',
    'invalid_request',
    'unsupported_capability',
    'malformed_response',
    'transport_blocked',
  ];

  it.each(NEVER_RETRY)('never retries %s', (category) => {
    const failure = providerFailure('any', category, 'no');
    expect(isRetryableCategory(category)).toBe(false);
    expect(decideRetryFor(failure.error, 1).shouldRetry).toBe(false);
  });

  it.each(['rate_limited', 'transient_provider_failure', 'provider_unavailable'] as const)(
    'retries %s within the policy limit',
    (category) => {
      const failure = providerFailure('any', category, 'try again');
      expect(isRetryableCategory(category)).toBe(true);
      expect(decideRetryFor(failure.error, 1, DEFAULT_RETRY_POLICY, () => 0).shouldRetry).toBe(
        true,
      );
      // And still bounded: the classification does not buy unlimited attempts.
      expect(
        decideRetryFor(
          failure.error,
          DEFAULT_RETRY_POLICY.maxAttempts,
          DEFAULT_RETRY_POLICY,
          () => 0,
        ).shouldRetry,
      ).toBe(false);
    },
  );

  it('separates a 5xx from an unreadable reply, which share one error code', () => {
    // Both are MODEL_ERROR. Only one is worth another attempt, and the code
    // alone cannot tell them apart — which is why the category decides.
    const transient = providerFailure('any', 'transient_provider_failure', 'server error');
    const malformed = providerFailure('any', 'malformed_response', 'unreadable');
    expect(transient.error.code).toBe(malformed.error.code);
    expect(decideRetryFor(transient.error, 1, DEFAULT_RETRY_POLICY, () => 0).shouldRetry).toBe(
      true,
    );
    expect(decideRetryFor(malformed.error, 1, DEFAULT_RETRY_POLICY, () => 0).shouldRetry).toBe(
      false,
    );
  });

  it.each(API_PROVIDER_CASES)(
    '%s classifies each status the way the policy will act on it',
    async (_id, pack) => {
      const cases: [number, boolean][] = [
        [401, false],
        [403, false],
        [400, false],
        [404, false],
        [429, true],
        [500, true],
      ];
      for (const [status, shouldRetry] of cases) {
        const rec = recorder(pack, () => pack.failure(status));
        const adapter = await connected(pack, rec.transport);
        const error = await adapter.generate(request(pack)).then(
          () => null,
          (e: unknown) => e as ProviderRequestError,
        );
        expect(
          decideRetryFor(error!.agentError, 1, DEFAULT_RETRY_POLICY, () => 0).shouldRetry,
          `${pack.factory.id} ${status}`,
        ).toBe(shouldRetry);
      }
    },
  );
});

describe('connecting a second provider does not lock out the first', () => {
  /**
   * Regression for a real defect this suite's real-browser counterpart found.
   *
   * Every provider's capability probe used one shared pseudo-task id, and the
   * gate pins a task to one provider destination. So whichever provider
   * probed first became the only one that ever could: connecting a second
   * provider failed its capability check with a policy refusal, and the task
   * that followed reported "this model does not support tool calling" — a
   * wrong answer to a question that was never asked.
   */
  it('gives each provider and model its own probe identity', () => {
    const ids = new Set<string>();
    for (const pack of API_PROVIDER_PACKS) {
      ids.add(managementTaskId(pack.factory.id, pack.config.model ?? ''));
    }
    expect(ids.size).toBe(API_PROVIDER_PACKS.length);
    // And a model change within one provider is a separate identity too.
    expect(managementTaskId('anthropic', 'a')).not.toBe(managementTaskId('anthropic', 'b'));
  });

  it('probes every provider in turn through one shared gate', async () => {
    const guarded = createGuardedTransport({
      consent,
      fetchImpl: () => Promise.resolve(new Response('{}', { status: 200 })),
    });

    // One consent store, one transport, three providers — the arrangement the
    // service worker actually builds.
    for (const pack of API_PROVIDER_PACKS) {
      const registry = new ProviderRegistry({ transport: guarded });
      registry.register(pack.factory);
      const adapter = registry.get(pack.factory.id);
      await adapter.connect(pack.config);

      const health = await adapter.validateConnection();
      expect(health.error?.code, pack.factory.id).not.toBe('POLICY_BLOCKED');
    }
  });
});
