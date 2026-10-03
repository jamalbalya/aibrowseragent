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
  CanonicalMessage,
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
 * How long a live case may take.
 *
 * Vitest's default is five seconds, which is right for a unit test and wrong
 * for every case in this file: a real completion often exceeds it and the
 * capability doctor — eight sequential round trips — always does. The first
 * live run lost the doctor and the streaming case to that default and reported
 * them as failures of this build, which they were not.
 */
const LIVE_TIMEOUT_MS = 120_000;
const DOCTOR_TIMEOUT_MS = 240_000;

/**
 * A rate limit is not a verdict on this build.
 *
 * A free-tier key will run out partway through a run of this file — nine cases
 * make a couple of dozen real requests — and a 429 arriving on case E1 says
 * nothing whatever about whether the credential leaks into the audit trail.
 * Reporting it as a failure is how a run that proved seven things gets read as
 * a run that found a defect.
 *
 * So a rate limit is reported as **inconclusive**, loudly, and the case stops
 * there. Nothing else is: an authentication failure, a malformed request, a
 * retired model and a wrong answer all remain failures, because each of those
 * is a fact about this build or about the account, and both are what the file
 * is for.
 */
function rateLimited(error: unknown): boolean {
  const failure = (error as { failure?: { error?: { code?: string } } }).failure;
  return failure?.error?.code === 'RATE_LIMITED';
}

/** Runs a live call, or declares the case inconclusive if the account is throttled. */
async function live<T>(what: string, call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (error) {
    if (rateLimited(error)) {
      process.stdout.write(`[PROVLIVE] INCONCLUSIVE — ${what}: the account is rate limited.\n`);
      return null;
    }
    throw error;
  }
}

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

/**
 * The probe runs at module scope, not in `beforeAll`.
 *
 * `it.skipIf(...)` is evaluated while the file is being *collected*, so a flag
 * set in a hook is still `false` when every guard is read and the whole file
 * silently skips. This is the lesson `nine-router-live.test.ts` records, and
 * repeating the mistake here would cost a live run that looked green.
 */
const probe = await (async (): Promise<{
  ids: string[];
  model: string;
  unusable: string;
  unusableMessage: string;
}> => {
  const empty = { ids: [], model: '', unusable: '', unusableMessage: '' };
  if (!CONFIGURED) return empty;
  const { adapter } = harness();
  const connected = await adapter.connect(config(WANTED_MODEL || 'probe-placeholder'));
  // A model id is required to connect on two of the three protocols, so the
  // placeholder above is what lets discovery happen before one is known. It is
  // never used for a completion.
  if (!connected.authenticated && WANTED_MODEL.length === 0) return empty;
  let ids: string[] = [];
  try {
    ids = (await adapter.listModels()).map((model) => model.id);
  } catch {
    ids = [];
  }

  // An explicit choice is taken as given: the person naming it is saying they
  // know this account can run it.
  if (WANTED_MODEL.length > 0) return { ...empty, ids, model: WANTED_MODEL };

  // Otherwise: **being listed is not the same as being usable**, and finding
  // that out is one of the things only a real service can tell you. This is
  // the lesson `nine-router-live.test.ts` records about a gateway, and the
  // first version of this file did not carry it over — it took `ids[0]` and
  // then reported six failures that were not this build's fault.
  //
  // The live evidence that settled it: Google's own `/v1beta/models` offers
  // `gemini-2.5-flash`, `gemini-2.5-pro` and `gemini-2.5-flash-lite` as its
  // first three generative entries, and a `generateContent` call on each
  // answers 404 *"no longer available to new users"*. The first three.
  //
  // So a model is found by asking. Capped at eight and with the smallest
  // possible body, because every attempt spends the person's quota.
  //
  // And "runnable" is itself two questions, because the interesting cases here
  // are about tools. A first pass found `gemma-4-26b-a4b-it` — the first id
  // this account could run — which answers text and rejects function calling
  // outright, so the tool round trip had nothing to test. So a model that
  // accepts a tool is preferred, and a text-only one is kept as the fallback.
  let model = '';
  let textOnly = '';
  let unusable = '';
  let unusableMessage = '';
  for (const id of ids.slice(0, 8)) {
    const candidate = harness().adapter;
    const auth = await candidate.connect(config(id));
    if (!auth.authenticated) continue;
    const ask = (tools: boolean): CanonicalRequest => ({
      systemInstruction: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxOutputTokens: 8,
      ...(tools ? { tools: [WEATHER_TOOL], toolChoice: 'auto' as const } : {}),
      egress: taskEgress(id),
    });
    try {
      await candidate.generate(ask(false));
    } catch (error) {
      // Listed, and this account cannot run it. Recorded as it is found rather
      // than probed for separately, so the case below costs no extra calls —
      // and discovered by *asking*, never by recognising a name.
      if (unusable.length === 0) {
        unusable = id;
        const failure = (error as { failure?: { error?: { userMessage?: string } } }).failure;
        unusableMessage = failure?.error?.userMessage ?? '';
      }
      continue;
    }
    try {
      await candidate.generate(ask(true));
      model = id;
      break;
    } catch {
      // Runs, but will not take a tool. Usable for everything except the one
      // thing this file exists to exercise, so it is the fallback.
      if (textOnly.length === 0) textOnly = id;
    }
  }
  return { ids, model: model || textOnly, unusable, unusableMessage };
})();

const liveIds = probe.ids;
const MODEL = probe.model;
const UNUSABLE = probe.unusable;
const UNUSABLE_MESSAGE = probe.unusableMessage;
const LIVE = CONFIGURED && MODEL.length > 0;
/** Live *and* with a listed model this account may not run. */
const HAS_UNUSABLE = LIVE && UNUSABLE.length > 0;

process.stdout.write(
  !CONFIGURED
    ? '[PROVLIVE] skipped: ABA_LIVE_PROTOCOL / ABA_LIVE_API_KEY not set.\n'
    : !LIVE
      ? `[PROVLIVE] skipped: ${PROTOCOL} listed ${liveIds.length} model(s), none runnable.\n`
      : `[PROVLIVE] live: ${PROTOCOL}, ${liveIds.length} model(s) listed, using ${MODEL}` +
        (UNUSABLE.length > 0 ? `; ${UNUSABLE} is listed but not runnable.\n` : '.\n'),
);

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

  it.skipIf(!LIVE)(
    'A2 — the real credential authenticates',
    async () => {
      const { adapter, headers } = harness();
      const result = await adapter.connect(config(MODEL));
      expect(result.authenticated, result.error?.message ?? '').toBe(true);

      const health = await adapter.validateConnection();
      if (health.error?.code === 'RATE_LIMITED') {
        process.stdout.write('[PROVLIVE] INCONCLUSIVE — A2 probe: the account is rate limited.\n');
        return;
      }
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
    },
    LIVE_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// B — what the doctor says about this exact model
// ---------------------------------------------------------------------------

describe('TEST-LIVE-001 — B: the capability doctor, for real', () => {
  it.skipIf(!LIVE)(
    'B1 — reports an observed verdict, whatever it is',
    async () => {
      const { adapter } = harness();
      await adapter.connect(config(MODEL));
      const report = await new CapabilityDoctor().run(adapter, MODEL, { timeoutMs: 60_000 });

      // A throttled account cannot be measured, and a report full of
      // rate-limit failures is not a verdict on the model. Checked on the
      // connection probe specifically: that is the first round trip, so if it
      // was refused for quota nothing after it ran either.
      const connection = report.checks.find((check) => check.id === 'connection');
      if (connection !== undefined && /429|rate limit/i.test(connection.detail)) {
        process.stdout.write('[PROVLIVE] INCONCLUSIVE — B1 doctor: the account is rate limited.\n');
        return;
      }

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
    },
    DOCTOR_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// C — a plain completion
// ---------------------------------------------------------------------------

describe('TEST-LIVE-001 — C: generating', () => {
  it.skipIf(!LIVE)(
    'C1 — a real completion comes back with text and usage',
    async () => {
      const { adapter } = harness();
      await adapter.connect(config(MODEL));
      const response = await live('C1 completion', () =>
        adapter.generate(
          request({
            messages: [{ role: 'user', content: [{ type: 'text', text: 'Say: ready.' }] }],
          }),
        ),
      );
      if (response === null) return;
      expect(response.text.length).toBeGreaterThan(0);
      expect(response.usage.promptTokens).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );

  it.skipIf(!LIVE)(
    'C2 — streaming produces events and a final response',
    async () => {
      const { adapter } = harness();
      await adapter.connect(config(MODEL));
      if (adapter.stream === undefined) return;

      let sawDone = false;
      let text = '';
      for await (const event of adapter.stream(
        request({
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Count: 1 2 3.' }] }],
        }),
      )) {
        if (event.type === 'text_delta') text += event.delta;
        if (event.type === 'error') {
          if (event.error.code === 'RATE_LIMITED') {
            process.stdout.write('[PROVLIVE] INCONCLUSIVE — C2 stream: rate limited.\n');
            return;
          }
          throw new Error(event.error.message);
        }
        if (event.type === 'done') sawDone = true;
      }
      expect(sawDone).toBe(true);
      expect(text.length).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// C2b — a model the endpoint lists that this account cannot run
// ---------------------------------------------------------------------------

describe('TEST-LIVE-001 — C2b: listed is not runnable', () => {
  it.skipIf(!HAS_UNUSABLE)('C3 — the refusal sends the user somewhere that helps', () => {
    // This is the case a mock cannot produce, because a fixture lists what it
    // intends to serve. A real catalogue is the union of what the endpoint
    // *names*; entitlement is a separate question the endpoint answers at
    // request time.
    //
    // What is asserted is not that the request failed — it did, that is the
    // premise — but that the sentence the user is shown is **actionable**. The
    // first version of this build said *"Check it against the model list"* for
    // every `NOT_FOUND`, which in this exact case tells the user to go and
    // confirm that they were right, and leaves them believing the extension is
    // broken. The model is in the list. That is the whole problem.
    process.stdout.write(`[PROVLIVE] ${UNUSABLE} refused with: ${UNUSABLE_MESSAGE}\n`);
    expect(UNUSABLE_MESSAGE.length).toBeGreaterThan(0);
    expect(UNUSABLE_MESSAGE).not.toMatch(/check it against the model list/i);
    // It must point at the fix, which is choosing another model.
    expect(UNUSABLE_MESSAGE.toLowerCase()).toContain('model');
  });
});

// ---------------------------------------------------------------------------
// D — the turn no probe in this repository has ever taken against a real
//     endpoint: sending a tool result back and getting another answer
// ---------------------------------------------------------------------------

describe('TEST-LIVE-001 — D: a tool result, and the turn after it', () => {
  it.skipIf(!LIVE)(
    'D1 — a real two-turn tool round trip completes',
    async () => {
      const { adapter, bodies } = harness();
      await adapter.connect(config(MODEL));

      const first = await live('D1 first turn', () =>
        adapter.generate(
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
        ),
      );
      if (first === null) return;

      // A model that declines to call the tool has told us something true about
      // itself, and there is no second turn to take. Reported rather than
      // failed: this file tests this build's handling of a real provider, not
      // the provider's willingness to use a tool.
      if (first.toolCalls.length === 0) {
        process.stdout.write(
          `[PROVLIVE] ${MODEL} did not call the tool; D1 has nothing to send.\n`,
        );
        expect(first.text.length).toBeGreaterThan(0);
        return;
      }

      const call = first.toolCalls[0]!;
      expect(call.name).toBe('get_temperature');
      expect(call.parseError, 'the provider returned unparseable tool arguments').toBeUndefined();

      // The second turn. This is the shape each protocol builds differently, and
      // until now nothing has sent one to a real endpoint.
      const second = await live('D1 second turn', () =>
        adapter.generate(
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
                    // Carried, exactly as the runtime carries it. Rebuilding the call
                    // without this is what the provider refuses — and this harness
                    // made that mistake too before it caught it.
                    ...(call.providerSignature === undefined
                      ? {}
                      : { providerSignature: call.providerSignature }),
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
        ),
      );
      if (second === null) return;

      // The provider accepted the result and answered from it. "31" is in the
      // tool output and nowhere else in the conversation, so an answer carrying
      // it is an answer that read the result rather than one that ignored it.
      expect(second.text.length).toBeGreaterThan(0);
      expect(second.text).toMatch(/31/);

      // And the result really was in the request body, under whichever key this
      // protocol uses for it.
      const lastBody = bodies.at(-1) ?? '';
      expect(lastBody).toMatch(/tool_result|functionResponse|"role":"tool"/);
    },
    LIVE_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// F — the two things §87's manual half says to do first, and the one it says
//     a sustained trajectory needs
// ---------------------------------------------------------------------------

/**
 * A 24×24 PNG: left half red, right half green.
 *
 * The capability doctor's vision probe is a 1×1 transparent pixel, which
 * proves the adapter can *encode* an image and nothing about whether the model
 * read it. §87's manual procedure asks for the other thing — *"send a
 * screenshot and ask a question only answerable from the image, confirm the
 * answer is actually derived from it"* — and this is the smallest image that
 * can carry such a question. Generated rather than photographed so the
 * expected answer is a fact about the bytes.
 */
const SPLIT_IMAGE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAJElEQVR42mO4oKBAECkcMCCI' +
  'GEYNGjVo1KBRg0YNGjVo4A0CAGWZZB86DFo2AAAAAElFTkSuQmCC';

/** One tool per city, so asking about three cities needs more than one call. */
const CITY_TOOL: CanonicalToolSchema = {
  type: 'function',
  name: 'get_temperature',
  description: 'Returns the current temperature in celsius for exactly one city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'A single city name.' } },
    required: ['city'],
    additionalProperties: false,
  },
};

const CITY_TEMPERATURES: Record<string, number> = { jakarta: 31, oslo: 4, cairo: 27 };

describe('TEST-LIVE-001 — F: what a sustained trajectory and a real image show', () => {
  it.skipIf(!LIVE)(
    'F1 — many tool calls across several turns, answered from their results',
    async () => {
      // §87-07's manual half. `sustained-task.test.ts` drives thirty-six calls
      // against a fake; this drives a real conversation until the model stops
      // asking, and checks that every answer it gives came from a tool.
      //
      // Three cities and a one-city tool, so one call cannot be enough. The
      // numbers are arbitrary and appear nowhere else, which is what makes a
      // final answer containing them evidence that the results were read.
      const { adapter } = harness();
      await adapter.connect(config(MODEL));

      const messages: CanonicalMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'What is the temperature in Jakarta, in Oslo and in Cairo? Use the tool for ' +
                'each city, then give me all three numbers in one sentence.',
            },
          ],
        },
      ];

      let calls = 0;
      let turns = 0;
      let answer = '';
      // Bounded: a model that keeps calling forever is a finding, not a hang.
      while (turns < 6) {
        turns += 1;
        const reply = await live(`F1 turn ${turns}`, () =>
          adapter.generate(request({ messages, tools: [CITY_TOOL], toolChoice: 'auto' })),
        );
        if (reply === null) return;
        if (reply.toolCalls.length === 0) {
          answer = reply.text;
          break;
        }
        calls += reply.toolCalls.length;
        messages.push({
          role: 'assistant',
          content: [
            ...(reply.text.trim().length > 0 ? [{ type: 'text' as const, text: reply.text }] : []),
            ...reply.toolCalls.map((call) => ({
              type: 'tool_call' as const,
              toolCallId: call.toolCallId,
              name: call.name,
              arguments: call.arguments,
              ...(call.providerSignature === undefined
                ? {}
                : { providerSignature: call.providerSignature }),
            })),
          ],
        });
        messages.push({
          role: 'tool',
          content: reply.toolCalls.map((call) => {
            const city = call.arguments.city;
            const asked = (typeof city === 'string' ? city : '').toLowerCase();
            const celsius = CITY_TEMPERATURES[asked];
            return {
              type: 'tool_result' as const,
              toolCallId: call.toolCallId,
              name: call.name,
              content: JSON.stringify(
                celsius === undefined ? { error: `unknown city: ${asked}` } : { celsius },
              ),
              isError: celsius === undefined,
            };
          }),
        });
      }

      process.stdout.write(
        `[PROVLIVE] F1: ${calls} tool call(s) over ${turns} turn(s); answer=${JSON.stringify(
          answer.slice(0, 120),
        )}\n`,
      );

      // More than one call really happened, which is the whole point of the
      // item: `sustained-task.test.ts` proves the loop, not the provider.
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(answer.length).toBeGreaterThan(0);
      // And the numbers in the answer came from the tool, not from the model's
      // own idea of the weather.
      for (const [city, celsius] of Object.entries(CITY_TEMPERATURES)) {
        expect(answer, `${city} (${celsius})`).toContain(String(celsius));
      }
    },
    LIVE_TIMEOUT_MS,
  );

  it.skipIf(!LIVE)(
    'F2 — a real image, and a question only the image can answer',
    async () => {
      // §87's manual half, the vision item. The doctor's 1×1 transparent probe
      // proves encoding; this proves the model saw what was sent.
      const { adapter } = harness();
      await adapter.connect(config(MODEL));
      const measured = await adapter.getCapabilities(MODEL).catch(() => null);
      if (measured !== null && measured.vision === false) {
        process.stdout.write(`[PROVLIVE] F2: ${MODEL} reports no vision; nothing to ask.\n`);
        return;
      }

      const reply = await live('F2 image question', () =>
        adapter.generate(
          request({
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'image', data: SPLIT_IMAGE_PNG, mimeType: 'image/png' },
                  {
                    type: 'text',
                    text:
                      'This image is split down the middle into two solid colours. Which side ' +
                      'is red — the left or the right? Answer with exactly one word.',
                  },
                ],
              },
            ],
          }),
        ),
      );
      if (reply === null) return;

      process.stdout.write(`[PROVLIVE] F2: answered ${JSON.stringify(reply.text.trim())}\n`);
      // The left half is red in the bytes. A model that cannot see the image
      // has a fifty-fifty guess, which is why this is reported as well as
      // asserted — a wrong answer here is worth looking at rather than
      // retrying.
      expect(reply.text.toLowerCase()).toContain('left');
      expect(reply.text.toLowerCase()).not.toContain('right');
    },
    LIVE_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// E — the credential does not come back out
// ---------------------------------------------------------------------------

describe('TEST-LIVE-001 — E: the credential stays in the header', () => {
  it.skipIf(!LIVE)(
    'E1 — it is absent from the audit trail',
    async () => {
      const { adapter, log } = harness();
      await adapter.connect(config(MODEL));
      const sent = await live('E1 completion', () =>
        adapter.generate(
          request({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Say: ok.' }] }] }),
        ),
      );
      if (sent === null) return;

      const entries = await log.list(100);
      expect(entries.length).toBeGreaterThan(0);
      // Compared, never interpolated: a failure message must not print it.
      expect(JSON.stringify(entries).includes(API_KEY)).toBe(false);
    },
    LIVE_TIMEOUT_MS,
  );

  it.skipIf(!LIVE)(
    'E2 — it is absent from a real rejection',
    async () => {
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
    },
    LIVE_TIMEOUT_MS,
  );
});
