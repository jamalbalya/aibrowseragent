/**
 * TEST-SECURITY-014 — provider transport conformance (V-5).
 *
 * The security boundary for provider traffic is that an adapter is built with
 * a guarded transport and has no other route out. These tests hold that
 * property rather than assuming it: every registered factory is exercised,
 * and the negative cases prove an adapter handed a hostile or absent
 * transport reaches nothing at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderRegistry } from '@/providers/registry/provider-registry';
import {
  OpenAICompatibleAdapter,
  openAICompatibleFactory,
} from '@/providers/adapters/openai-compatible';
import {
  createGuardedTransport,
  refusingTransport,
  EgressDeniedError,
  type EgressContext,
} from '@/security/egress/provider-transport';
import { ConsentStore } from '@/security/egress/consent';
import { addTaint, freshTaint, unknownTaint } from '@/security/taint/taint-state';
import type { TaintSource } from '@/security/exfiltration/exfiltration-guard';

/** Every factory the product registers. Extend this when a provider is added. */
const REGISTERED_FACTORIES = [openAICompatibleFactory];

const CONFIG = {
  providerId: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-' + 'test-abcdefghijklmnopqrstuvwxyz',
  model: 'test-model',
};

const page: TaintSource = {
  sourceType: 'web_page',
  site: 'intranet.example',
  sensitivity: 'confidential',
};

function context(overrides: Partial<EgressContext> = {}): EgressContext {
  return {
    taskId: 'task_1',
    taintState: freshTaint(),
    taintSalt: 'ab'.repeat(32),
    saltEpoch: 1,
    taintSignature: 'sig',
    providerId: 'openai-compatible',
    modelId: 'test-model',
    ...overrides,
  };
}

function jsonBody(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

let consent: ConsentStore;
beforeEach(() => {
  consent = new ConsentStore();
});

describe('every registered factory is built guarded', () => {
  it.each(REGISTERED_FACTORIES.map((f) => [f.id, f] as const))(
    '%s receives the registry transport',
    async (_id, factory) => {
      const reached: string[] = [];
      const transport = {
        request: (url: string) => {
          reached.push(url);
          return Promise.resolve(jsonBody());
        },
      };
      const registry = new ProviderRegistry({ transport });
      registry.register(factory);

      const adapter = registry.get(factory.id);
      await adapter.connect(CONFIG);
      await adapter.generate({ systemInstruction: 's', messages: [], egress: context() });

      expect(reached).toHaveLength(1);
      expect(reached[0]).toContain('/chat/completions');
    },
  );

  it.each(REGISTERED_FACTORIES.map((f) => [f.id, f] as const))(
    '%s performs no network call when its transport throws',
    async (_id, factory) => {
      // The conformance check: an adapter handed a transport that refuses must
      // surface the refusal, not find another way out.
      const fetchSpy = vi.fn(() => {
        throw new Error('the network was reached without authorization');
      });
      vi.stubGlobal('fetch', fetchSpy);

      const registry = new ProviderRegistry({
        transport: {
          request: () => Promise.reject(new Error('refused by transport')),
        },
      });
      registry.register(factory);
      const adapter = registry.get(factory.id);
      await adapter.connect(CONFIG);

      await expect(
        adapter.generate({ systemInstruction: 's', messages: [], egress: context() }),
      ).rejects.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    },
  );

  it('a registry built without a transport produces an adapter that refuses', async () => {
    const registry = new ProviderRegistry();
    registry.register(openAICompatibleFactory);
    const adapter = registry.get(openAICompatibleFactory.id);
    await adapter.connect(CONFIG);

    await expect(
      adapter.generate({ systemInstruction: 's', messages: [], egress: context() }),
    ).rejects.toThrow();
  });

  it('an adapter constructed outside the registry refuses rather than reaching out', async () => {
    const adapter = new OpenAICompatibleAdapter();
    await adapter.connect(CONFIG);
    await expect(
      adapter.generate({ systemInstruction: 's', messages: [], egress: context() }),
    ).rejects.toThrow();
  });

  it('refusingTransport rejects every call', async () => {
    await expect(refusingTransport().request('https://x.example', {}, context())).rejects.toThrow(
      /guarded transport/i,
    );
  });
});

describe('a request with no egress context cannot be authorised', () => {
  it('refuses rather than assuming the task is clean', async () => {
    const inner = vi.fn(() => Promise.resolve(jsonBody()));
    const registry = new ProviderRegistry({
      transport: { request: () => inner() },
    });
    registry.register(openAICompatibleFactory);
    const adapter = registry.get(openAICompatibleFactory.id);
    await adapter.connect(CONFIG);

    // No `egress` on the request.
    await expect(adapter.generate({ systemInstruction: 's', messages: [] })).rejects.toThrow();
    expect(inner).not.toHaveBeenCalled();
  });
});

describe('the guarded transport gates the network', () => {
  it('lets an authorised request through', async () => {
    const inner = vi.fn(() => Promise.resolve(jsonBody()));
    const transport = createGuardedTransport({
      consent,
      fetchImpl: inner,
    });

    await transport.request(
      'https://api.example.com/v1/chat/completions',
      { body: '{}' },
      context(),
    );
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('does not call fetch at all when the gate denies', async () => {
    const inner = vi.fn(() => Promise.resolve(jsonBody()));
    const transport = createGuardedTransport({
      consent,
      fetchImpl: inner,
    });

    await expect(
      transport.request(
        'https://api.example.com/v1/chat/completions',
        { body: '{}' },
        context({ taintState: unknownTaint('malformed') }),
      ),
    ).rejects.toBeInstanceOf(EgressDeniedError);

    // The assertion that matters: refusal happens before the primitive, not
    // after a response is discarded.
    expect(inner).not.toHaveBeenCalled();
  });

  it('re-evaluates every call rather than carrying one decision forward', async () => {
    const inner = vi.fn(() => Promise.resolve(jsonBody()));
    const transport = createGuardedTransport({
      consent,
      fetchImpl: inner,
    });
    const url = 'https://api.example.com/v1/chat/completions';

    await transport.request(url, { body: '{}' }, context());
    expect(inner).toHaveBeenCalledTimes(1);

    // A retry of the same call, now on a task whose provenance was lost. An
    // authorisation carried forward from the first attempt would let it pass.
    await expect(
      transport.request(url, { body: '{}' }, context({ taintState: unknownTaint('malformed') })),
    ).rejects.toBeInstanceOf(EgressDeniedError);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('denies a switch to a different provider mid-task', async () => {
    const inner = vi.fn(() => Promise.resolve(jsonBody()));
    const transport = createGuardedTransport({
      consent,
      fetchImpl: inner,
    });
    const tainted = addTaint(freshTaint(), [page]);

    await transport.request(
      'https://api.example.com/v1/chat/completions',
      { body: '{}' },
      context({ taintState: tainted }),
    );
    expect(inner).toHaveBeenCalledTimes(1);

    await expect(
      transport.request(
        'https://evil.example/v1/chat/completions',
        { body: '{}' },
        context({ taintState: tainted, providerId: 'openai-compatible' }),
      ),
    ).rejects.toBeInstanceOf(EgressDeniedError);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('denies a switch to a different model mid-task', async () => {
    const inner = vi.fn(() => Promise.resolve(jsonBody()));
    const transport = createGuardedTransport({
      consent,
      fetchImpl: inner,
    });
    const tainted = addTaint(freshTaint(), [page]);
    const url = 'https://api.example.com/v1/chat/completions';

    await transport.request(url, { body: '{}' }, context({ taintState: tainted }));
    await expect(
      transport.request(url, { body: '{}' }, context({ taintState: tainted, modelId: 'other' })),
    ).rejects.toBeInstanceOf(EgressDeniedError);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('denies a credential-shaped body before the primitive', async () => {
    const inner = vi.fn(() => Promise.resolve(jsonBody()));
    const transport = createGuardedTransport({
      consent,
      fetchImpl: inner,
    });

    await expect(
      transport.request(
        'https://api.example.com/v1/chat/completions',
        { body: JSON.stringify({ api_key: 'abcdefghijklmnopqrstuv' }) },
        context(),
      ),
    ).rejects.toBeInstanceOf(EgressDeniedError);
    expect(inner).not.toHaveBeenCalled();
  });

  it('records a decision for a refusal, not only for a success', async () => {
    const seen: string[] = [];
    const transport = createGuardedTransport({
      consent,
      fetchImpl: () => Promise.resolve(jsonBody()),
      onDecision: (decision) => {
        seen.push(`${decision.verdict}:${decision.code}`);
        return Promise.resolve();
      },
    });

    await expect(
      transport.request(
        'https://api.example.com/v1/chat/completions',
        { body: '{}' },
        context({ taintState: unknownTaint('malformed') }),
      ),
    ).rejects.toBeInstanceOf(EgressDeniedError);

    expect(seen).toEqual(['deny:SECURITY_CONTEXT_UNKNOWN']);
  });
});

describe('streaming and repeated calls stay guarded', () => {
  it('gates a streaming request the same way', async () => {
    const inner = vi.fn(() =>
      Promise.resolve(
        new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );
    const registry = new ProviderRegistry({
      transport: createGuardedTransport({
        consent,
        fetchImpl: inner,
      }),
    });
    registry.register(openAICompatibleFactory);
    const adapter = registry.get(openAICompatibleFactory.id);
    await adapter.connect(CONFIG);

    // The adapter is the receiver; calling through it keeps `this` bound.
    for await (const _event of adapter.stream?.({
      systemInstruction: 's',
      messages: [],
      egress: context(),
    }) ?? []) {
      // Drain.
    }
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('gates each call in a tool-calling loop, not just the first', async () => {
    const inner = vi.fn(() => Promise.resolve(jsonBody()));
    const registry = new ProviderRegistry({
      transport: createGuardedTransport({
        consent,
        fetchImpl: inner,
      }),
    });
    registry.register(openAICompatibleFactory);
    const adapter = registry.get(openAICompatibleFactory.id);
    await adapter.connect(CONFIG);

    const tainted = addTaint(freshTaint(), [page]);
    await adapter.generate({ systemInstruction: 's', messages: [], egress: context() });
    await adapter.generate({
      systemInstruction: 's',
      messages: [],
      egress: context({ taintState: tainted }),
    });
    expect(inner).toHaveBeenCalledTimes(2);

    // Third turn, provenance lost. Nothing carries over from the first two.
    await expect(
      adapter.generate({
        systemInstruction: 's',
        messages: [],
        egress: context({ taintState: unknownTaint('persistence-failed') }),
      }),
    ).rejects.toThrow();
    expect(inner).toHaveBeenCalledTimes(2);
  });
});
