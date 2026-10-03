/**
 * TEST-LIVE-001 — the connect-to-execute journey against a real provider.
 *
 * ## Why this file exists
 *
 * Every other provider suite in this repository is mocked, and that is the
 * right default: a suite that needs somebody's API key is a suite that fails
 * for everybody who does not have one. `nine-router-live.test.ts` is the one
 * exception, and it proved what the exception buys — the gateway named models
 * in a shape no fixture had, and listed models the account was not entitled to
 * run. Neither could have been discovered from this side of the socket.
 *
 * But that file speaks one protocol to one gateway. The three protocols a user
 * is most likely to bring a key for — Anthropic, Gemini and anything
 * OpenAI-compatible — had **no** way to be exercised for real. So an owner
 * holding a key had no command to run, and no claim about those providers
 * could ever move past "mocked".
 *
 * This file is that command. It speaks whichever protocol it is pointed at.
 *
 * ## The question it is built around
 *
 * Not "does the key work" — `validateConnection` answers that, and a mock can
 * fake it. The question is the one a mock structurally cannot reach:
 *
 *   **can a provider connect successfully and still fail when the agent
 *   attempts to execute a real task?**
 *
 * There is a specific reason to think it can. The capability doctor proves
 * tool calling with a *single* turn: it sends one tiny tool and checks that a
 * call comes back. A task does something the doctor never does — it sends the
 * tool's **result** back and asks for another turn. That second turn is where
 * the three protocols differ most (Anthropic puts a `tool_result` block in a
 * user message; Gemini correlates a `functionResponse` by name because no id
 * exists; the Chat Completions shape uses a separate `role: "tool"` entry),
 * and it is the first thing a real task does that no probe here has ever
 * demonstrated against a real endpoint. Case D is that round trip.
 *
 * ## Running it
 *
 * ```
 * ABA_LIVE_PROTOCOL=anthropic|gemini|openai-compatible \
 * ABA_LIVE_API_KEY=… \
 * ABA_LIVE_BASE_URL=…            # required for openai-compatible only
 * ABA_LIVE_MODEL=…               # optional; discovered when omitted
 *   npx vitest run tests/integration/provider-live.test.ts
 * ```
 *
 * Every case skips when those are absent, which is how `npm run verify` sees
 * it. The run is announced on stdout so a file that skipped everything is
 * never mistaken for a file that passed.
 *
 * ## This spends money
 *
 * Deliberately, and only when somebody sets the variables above. It makes a
 * handful of small requests — a discovery, a connection probe, two short
 * completions, one stream — against the account whose key is supplied. Nothing
 * here runs by default, nothing here is wired into `verify`, and no credential
 * is read from anywhere but the environment.
 *
 * ## The credential
 *
 * Read from the environment and written nowhere. No literal, no fixture, no
 * interpolation into an assertion message. The cases assert its absence from
 * the audit trail and from every error this build produces — after first
 * asserting that the request really did carry it, because otherwise those
 * absences would prove only that nothing happened.
 */
import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '@/providers/registry/provider-registry';
import { API_PROVIDER_FACTORIES } from '@/providers/registry/api-providers';
import { CapabilityDoctor } from '@/providers/capability-doctor/capability-doctor';
import { createGuardedTransport } from '@/security/egress/provider-transport';
import { ConsentStore } from '@/security/egress/consent';
import { AuditLog } from '@/audit/audit-log';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { ANTHROPIC_PROVIDER_ID } from '@/providers/adapters/anthropic';
import { GEMINI_PROVIDER_ID } from '@/providers/adapters/gemini';
import { OPENAI_COMPATIBLE_PROVIDER_ID } from '@/providers/adapters/openai-compatible';
import { NINE_ROUTER_PROVIDER_ID } from '@/providers/adapters/nine-router-catalog';
import type {
  AIProviderAdapter,
  CanonicalRequest,
  CanonicalToolSchema,
} from '@/providers/core/types';
import type { EgressContext } from '@/security/egress/provider-transport';

/** The protocols this file can be pointed at, and the provider id for each. */
const PROVIDER_IDS: Record<string, string> = {
  anthropic: ANTHROPIC_PROVIDER_ID,
  gemini: GEMINI_PROVIDER_ID,
  'openai-compatible': OPENAI_COMPATIBLE_PROVIDER_ID,
  'nine-router': NINE_ROUTER_PROVIDER_ID,
};

const PROTOCOL = process.env.ABA_LIVE_PROTOCOL ?? '';
const API_KEY = process.env.ABA_LIVE_API_KEY ?? '';
const BASE_URL = process.env.ABA_LIVE_BASE_URL ?? '';
const WANTED_MODEL = process.env.ABA_LIVE_MODEL ?? '';
const PROVIDER_ID = PROVIDER_IDS[PROTOCOL] ?? '';

/**
 * An OpenAI-compatible endpoint has no default: the adapter requires a base
 * URL precisely because "OpenAI-compatible" names a shape, not a host. The
 * other two default to their published endpoints.
 */
const NEEDS_BASE_URL = PROTOCOL === 'openai-compatible';
const CONFIGURED =
  PROVIDER_ID.length > 0 && API_KEY.length > 0 && (!NEEDS_BASE_URL || BASE_URL.length > 0);

const area = (): SerializedStorageArea => new SerializedStorageArea(new MemoryStorageArea());

/** The production transport, with the real gate and a recorder on the way out. */
function harness(): {
  adapter: AIProviderAdapter;
  log: AuditLog;
  urls: string[];
  headers: Record<string, string>[];
  bodies: string[];
} {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const bodies: string[] = [];
  const log = new AuditLog(area(), { knownTool: () => true });
  const consent = new ConsentStore();

  const transport = createGuardedTransport({
    consent,
    // The real `fetch`, wrapped only to observe. What goes out is what the
    // adapter built.
    fetchImpl: ((url: string, init: RequestInit) => {
      urls.push(url);
      headers.push({ ...((init.headers ?? {}) as Record<string, string>) });
      if (typeof init.body === 'string') bodies.push(init.body);
      return fetch(url, init);
    }) as unknown as typeof fetch,
    onDecision: async (decision, context) => {
      await log.record({
        type: 'egress.decided',
        taskId: context.taskId,
        tool: 'provider.request',
        outcome: decision.verdict === 'allow' ? 'allowed' : 'denied',
        code: decision.code,
        providerId: context.providerId,
        modelId: context.modelId,
        ...(decision.destinationIdentity === null
          ? {}
          : { destination: decision.destinationIdentity }),
      } as never);
    },
  });

  const registry = new ProviderRegistry({ transport });
  for (const factory of API_PROVIDER_FACTORIES) registry.register(factory);
  return { adapter: registry.get(PROVIDER_ID), log, urls, headers, bodies };
}

function config(model: string): Parameters<AIProviderAdapter['connect']>[0] {
  return {
    providerId: PROVIDER_ID,
    ...(BASE_URL.length === 0 ? {} : { baseUrl: BASE_URL }),
    apiKey: API_KEY,
    credentialScheme: 'api_key' as const,
    model,
  };
}

function taskEgress(modelId: string): EgressContext {
  return {
    taskId: 'task_live_provider',
    taintState: { kind: 'KNOWN_UNTAINTED' },
    taintSalt: 'cd'.repeat(32),
    saltEpoch: 1,
    taintSignature: 'live-integration',
    providerId: PROVIDER_ID,
    connectionId: 'conn_live_provider',
    modelId,
  };
}

/**
 * The probe runs at module scope, not in `beforeAll`.
 *
 * `it.skipIf(...)` is evaluated while the file is being *collected*, so a flag
 * set in a hook is still `false` when every guard is read and the whole file
 * silently skips. This is the lesson `nine-router-live.test.ts` records, and
 * repeating the mistake here would cost a live run that looked green.
 */
const probe = await (async (): Promise<{ ids: string[]; model: string }> => {
  if (!CONFIGURED) return { ids: [], model: '' };
  const { adapter } = harness();
  const connected = await adapter.connect(config(WANTED_MODEL || 'probe-placeholder'));
  // A model id is required to connect on two of the three protocols, so the
  // placeholder above is what lets discovery happen before one is known. It is
  // never used for a completion.
  if (!connected.authenticated && WANTED_MODEL.length === 0) return { ids: [], model: '' };
  let ids: string[] = [];
  try {
    ids = (await adapter.listModels()).map((model) => model.id);
  } catch {
    ids = [];
  }
  // An explicit choice wins; otherwise the first id the endpoint itself named.
  const model = WANTED_MODEL.length > 0 ? WANTED_MODEL : (ids[0] ?? '');
  return { ids, model };
})();

const liveIds = probe.ids;
const MODEL = probe.model;
const LIVE = CONFIGURED && MODEL.length > 0;

process.stdout.write(
  !CONFIGURED
    ? '[PROVLIVE] skipped: ABA_LIVE_PROTOCOL / ABA_LIVE_API_KEY not set.\n'
    : !LIVE
      ? `[PROVLIVE] skipped: ${PROTOCOL} named no usable model.\n`
      : `[PROVLIVE] live: ${PROTOCOL}, ${liveIds.length} model(s) discovered, using ${MODEL}.\n`,
);

/** One tiny tool, and the result that is sent back for it. */
const WEATHER_TOOL: CanonicalToolSchema = {
  type: 'function',
  name: 'get_temperature',
  description: 'Returns the current temperature in celsius for one city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'The city to report on.' } },
    required: ['city'],
    additionalProperties: false,
  },
};

function request(partial: Partial<CanonicalRequest>): CanonicalRequest {
  return {
    systemInstruction: 'You are a terse assistant. Answer in one short sentence.',
    messages: [],
    maxOutputTokens: 256,
    egress: taskEgress(MODEL),
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// A — discovery and connection, against the real endpoint
// ---------------------------------------------------------------------------

describe('TEST-LIVE-001 — A: connecting', () => {
  it.skipIf(!CONFIGURED)('A1 — the endpoint names at least one model', () => {
    // A protocol that cannot list models is a legitimate finding, not a
    // failure, as long as a model was named explicitly.
    expect(
      liveIds.length > 0 || WANTED_MODEL.length > 0,
      `${PROTOCOL} listed no models and ABA_LIVE_MODEL was not set`,
    ).toBe(true);
  });

  it.skipIf(!LIVE)('A2 — the real credential authenticates', async () => {
    const { adapter, headers } = harness();
    const result = await adapter.connect(config(MODEL));
    expect(result.authenticated, result.error?.message ?? '').toBe(true);

    const health = await adapter.validateConnection();
    expect(health.reachable, health.error?.message ?? '').toBe(true);

    // The credential really did go out — which is what makes the absences
    // asserted in section E mean something.
    const sent = headers.map((set) =>
      Object.fromEntries(Object.entries(set).map(([k, v]) => [k.toLowerCase(), v])),
    );
    expect(
      sent.some((set) => Object.values(set).some((value) => value.includes(API_KEY))),
      'no request carried the credential',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B — what the doctor says about this exact model
// ---------------------------------------------------------------------------

describe('TEST-LIVE-001 — B: the capability doctor, for real', () => {
  it.skipIf(!LIVE)('B1 — reports an observed verdict, whatever it is', async () => {
    const { adapter } = harness();
    await adapter.connect(config(MODEL));
    const report = await new CapabilityDoctor().run(adapter, MODEL, { timeoutMs: 60_000 });

    // Not asserted to be AGENT_READY. A chat-only model is a true answer about
    // a real model, and a test that demanded otherwise would be asserting the
    // owner's choice of model rather than this build's behaviour. What is
    // asserted is that the verdict was *observed*: every check either ran or
    // said why it did not.
    process.stdout.write(
      `[PROVLIVE] ${MODEL}: ${report.readiness} — ` +
        report.checks.map((check) => `${check.id}=${check.status}`).join(' ') +
        '\n',
    );
    expect(report.checks.length).toBeGreaterThan(0);
    for (const check of report.checks) {
      expect(['pass', 'fail', 'skipped', 'unsupported']).toContain(check.status);
      if (check.status !== 'pass') expect(check.detail.length).toBeGreaterThan(0);
    }
    expect(report.capabilities.unverified).not.toContain('toolCalling');
  });
});

// ---------------------------------------------------------------------------
// C — a plain completion
// ---------------------------------------------------------------------------

describe('TEST-LIVE-001 — C: generating', () => {
  it.skipIf(!LIVE)('C1 — a real completion comes back with text and usage', async () => {
    const { adapter } = harness();
    await adapter.connect(config(MODEL));
    const response = await adapter.generate(
      request({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Say: ready.' }] }] }),
    );
    expect(response.text.length).toBeGreaterThan(0);
    expect(response.usage.promptTokens).toBeGreaterThan(0);
  });

  it.skipIf(!LIVE)('C2 — streaming produces events and a final response', async () => {
    const { adapter } = harness();
    await adapter.connect(config(MODEL));
    if (adapter.stream === undefined) return;

    let sawDone = false;
    let text = '';
    for await (const event of adapter.stream(
      request({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Count: 1 2 3.' }] }] }),
    )) {
      if (event.type === 'text_delta') text += event.delta;
      if (event.type === 'error') throw new Error(event.error.message);
      if (event.type === 'done') sawDone = true;
    }
    expect(sawDone).toBe(true);
    expect(text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// D — the turn no probe in this repository has ever taken against a real
//     endpoint: sending a tool result back and getting another answer
// ---------------------------------------------------------------------------

describe('TEST-LIVE-001 — D: a tool result, and the turn after it', () => {
  it.skipIf(!LIVE)('D1 — a real two-turn tool round trip completes', async () => {
    const { adapter, bodies } = harness();
    await adapter.connect(config(MODEL));

    const first = await adapter.generate(
      request({
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'What is the temperature in Jakarta right now?' }],
          },
        ],
        tools: [WEATHER_TOOL],
        toolChoice: 'auto',
      }),
    );

    // A model that declines to call the tool has told us something true about
    // itself, and there is no second turn to take. Reported rather than
    // failed: this file tests this build's handling of a real provider, not
    // the provider's willingness to use a tool.
    if (first.toolCalls.length === 0) {
      process.stdout.write(`[PROVLIVE] ${MODEL} did not call the tool; D1 has nothing to send.\n`);
      expect(first.text.length).toBeGreaterThan(0);
      return;
    }

    const call = first.toolCalls[0]!;
    expect(call.name).toBe('get_temperature');
    expect(call.parseError, 'the provider returned unparseable tool arguments').toBeUndefined();

    // The second turn. This is the shape each protocol builds differently, and
    // until now nothing has sent one to a real endpoint.
    const second = await adapter.generate(
      request({
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'What is the temperature in Jakarta right now?' }],
          },
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
                content: JSON.stringify({ celsius: 31 }),
                isError: false,
              },
            ],
          },
        ],
        tools: [WEATHER_TOOL],
      }),
    );

    // The provider accepted the result and answered from it. "31" is in the
    // tool output and nowhere else in the conversation, so an answer carrying
    // it is an answer that read the result rather than one that ignored it.
    expect(second.text.length).toBeGreaterThan(0);
    expect(second.text).toMatch(/31/);

    // And the result really was in the request body, under whichever key this
    // protocol uses for it.
    const lastBody = bodies.at(-1) ?? '';
    expect(lastBody).toMatch(/tool_result|functionResponse|"role":"tool"/);
  });
});

// ---------------------------------------------------------------------------
// E — the credential does not come back out
// ---------------------------------------------------------------------------

describe('TEST-LIVE-001 — E: the credential stays in the header', () => {
  it.skipIf(!LIVE)('E1 — it is absent from the audit trail', async () => {
    const { adapter, log } = harness();
    await adapter.connect(config(MODEL));
    await adapter.generate(
      request({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Say: ok.' }] }] }),
    );

    const entries = await log.list(100);
    expect(entries.length).toBeGreaterThan(0);
    // Compared, never interpolated: a failure message must not print it.
    expect(JSON.stringify(entries).includes(API_KEY)).toBe(false);
  });

  it.skipIf(!LIVE)('E2 — it is absent from a real rejection', async () => {
    const { adapter, log } = harness();
    // A credential that is wrong in a way only the provider can judge. Built
    // from the real one so it is the same shape, and never valid.
    const connected = await adapter.connect({ ...config(MODEL), apiKey: `${API_KEY}-invalid` });
    if (!connected.authenticated) {
      expect(JSON.stringify(connected.error ?? {}).includes(API_KEY)).toBe(false);
      return;
    }
    const health = await adapter.validateConnection();
    expect(health.reachable).toBe(false);
    expect(JSON.stringify(health.error ?? {}).includes(API_KEY)).toBe(false);
    expect(JSON.stringify(await log.list(100)).includes(API_KEY)).toBe(false);
  });
});
