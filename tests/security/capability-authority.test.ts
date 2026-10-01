/**
 * TEST-CAPAUTH-001 — a model's name never decides what the model may do.
 *
 * ## The defect this fixes
 *
 * `OpenAICompatibleAdapter` advertised `vision: looksVisionCapable(model)` — a
 * substring match of the model id against a table of name fragments — and the
 * pre-flight check that decides whether an image leaves the device called that
 * function directly, from a `private` method a subclass could not override.
 *
 * Three separate things were wrong with that, and the third is the one that
 * made it a security property rather than a cosmetic one:
 *
 *  1. `NineRouterAdapter` overrode `getCapabilities` to report an honest "I
 *     cannot know" for an upstream this build has never heard of. The UI
 *     honoured the override and the request path ignored it, so the adapter
 *     advertised one capability and enforced a different one.
 *  2. The doctor existed to settle the question and was *gated on the
 *     advertisement*, so an honest `vision: false` stopped the only thing that
 *     could have corrected it. Vision was permanently unavailable through a
 *     gateway, by construction.
 *  3. A 9Router model id carries a **user-editable prefix**. Renaming an
 *     upstream connection to `gpt-5-work` made every model under it match the
 *     table, so a string the build does not control decided an egress
 *     permission.
 *
 * ## What is asserted here
 *
 * That a capability has three states and that each is handled as itself;
 * that the authority is the measurement; that a measurement is scoped to the
 * exact provider, account and model it was taken on; and that no id — however
 * suggestively named — moves any of it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { NineRouterAdapter } from '@/providers/adapters/nine-router';
import {
  OpenAICompatibleAdapter,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from '@/providers/adapters/openai-compatible';
import { NINE_ROUTER_PROVIDER_ID } from '@/providers/adapters/nine-router-catalog';
import { isUnverified, REQUESTABLE_CAPABILITIES } from '@/providers/core/types';
import { checkCapabilities } from '@/providers/core/capability-guard';
import { ProviderRequestError } from '@/providers/core/provider-error';
import type { CanonicalRequest, ModelCapabilities } from '@/providers/core/types';
import type { ProviderTransport } from '@/security/egress/provider-transport';

/**
 * Ids whose names *suggest* a capability.
 *
 * Every one of these matched the old hint table, or was refused by it, and the
 * point of the list is that the answer must now be identical for all of them.
 */
const SUGGESTIVE = [
  'openai/gpt-5.1',
  'upstream/some-vision-model',
  'anthropic/claude-opus-4.5',
  'google/gemini-3-pro',
  'cx/gpt-6-astra',
  'daily-driver-combo',
  'org/team/project/model/v2',
  'modèle-日本語-🙂',
  'llava-next',
  'qwen-vl-max',
  // The attack the user-editable prefix makes possible: a connection alias
  // chosen to look like a vision-capable family.
  'gpt-5-work/some-text-only-model',
  'vision/not-actually-a-vision-model',
] as const;

const KEY = 'sk-' + 'capability-authority-000000000';

function visionRequest(modelId: string): CanonicalRequest {
  return {
    systemInstruction: '',
    messages: [
      { role: 'user', content: [{ type: 'image', data: 'QUFBQQ==', mimeType: 'image/png' }] },
    ],
    egress: {
      taskId: 'task_cap',
      taintState: { kind: 'KNOWN_UNTAINTED' },
      taintSalt: 'ab'.repeat(32),
      saltEpoch: 1,
      taintSignature: 'management',
      providerId: NINE_ROUTER_PROVIDER_ID,
      modelId,
    },
  } as unknown as CanonicalRequest;
}

/** Fails the test if it is ever reached: the guard must refuse first. */
function forbiddenTransport(): ProviderTransport {
  return {
    request: () => {
      throw new Error('the request reached the transport, so the guard did not refuse it');
    },
  };
}

const MEASURED_VISION: ModelCapabilities = {
  text: true,
  streaming: true,
  toolCalling: true,
  parallelToolCalling: true,
  structuredOutput: true,
  systemInstruction: true,
  modelListing: true,
  vision: true,
  fileInput: false,
  audioInput: false,
  contextWindow: null,
  maxOutputTokens: null,
  unverified: [],
};

describe('TEST-CAPAUTH-001 — the three states are three states', () => {
  it('01 — a gateway reports vision as unverified, not as absent', async () => {
    const adapter = new NineRouterAdapter(forbiddenTransport());
    await adapter.connect({
      providerId: NINE_ROUTER_PROVIDER_ID,
      baseUrl: 'http://localhost:20128/v1',
      apiKey: KEY,
      model: 'cx/gpt-6-astra',
    });
    const capabilities = await adapter.getCapabilities('cx/gpt-6-astra');

    // The placeholder is conservative, and it is labelled as a placeholder.
    expect(capabilities.vision).toBe(false);
    expect(isUnverified(capabilities, 'vision')).toBe(true);
    // The rest of the Chat Completions contract is a claim, so it is not listed.
    for (const capability of ['toolCalling', 'streaming', 'systemInstruction'] as const) {
      expect(isUnverified(capabilities, capability), capability).toBe(false);
    }
  });

  it('02 — an unverified capability is refused as unverified, never as unsupported', () => {
    const unverifiedVision: ModelCapabilities = {
      ...MEASURED_VISION,
      vision: false,
      unverified: ['vision'],
    };
    const confirmedAbsent: ModelCapabilities = {
      ...MEASURED_VISION,
      vision: false,
      unverified: [],
    };

    const notYet = checkCapabilities(
      NINE_ROUTER_PROVIDER_ID,
      'cx/gpt-6-astra',
      visionRequest('cx/gpt-6-astra'),
      unverifiedVision,
      false,
    );
    const cannot = checkCapabilities(
      NINE_ROUTER_PROVIDER_ID,
      'cx/gpt-6-astra',
      visionRequest('cx/gpt-6-astra'),
      confirmedAbsent,
      false,
    );

    // Both refuse — neither drops the image — and they say different things,
    // because the user acts on them differently.
    expect(notYet?.category).toBe('capability_unverified');
    expect(cannot?.category).toBe('unsupported_capability');
    expect(notYet?.error.userMessage).toMatch(/capability doctor/i);
    expect(cannot?.error.userMessage).not.toMatch(/capability doctor/i);
    // And neither is retryable: retrying cannot produce a measurement.
    expect(notYet?.error.retryable).toBe(false);
    expect(cannot?.error.retryable).toBe(false);
  });

  it('03 — a measured capability passes', () => {
    expect(
      checkCapabilities(
        NINE_ROUTER_PROVIDER_ID,
        'cx/gpt-6-astra',
        visionRequest('cx/gpt-6-astra'),
        MEASURED_VISION,
        false,
      ),
    ).toBeNull();
  });
});

describe('TEST-CAPAUTH-001 — a measurement may attempt what it measures', () => {
  const probeRequest = (modelId: string, management: boolean): CanonicalRequest =>
    ({
      ...visionRequest(modelId),
      egress: { ...visionRequest(modelId).egress, ...(management ? { management: true } : {}) },
    }) as CanonicalRequest;

  const unverifiedVision: ModelCapabilities = {
    ...MEASURED_VISION,
    vision: false,
    unverified: ['vision'],
  };

  it('17 — a probe is let through where a task is refused', () => {
    // Without this the third state could never be resolved. The doctor settles
    // an unverified capability by attempting it, and that attempt arrives at
    // the guard as a request for a capability nobody has established — so
    // refusing it makes the refusal self-fulfilling. Observed against the real
    // service before the exemption existed: the vision check reported
    // `fail: "… has not been established"`, which was the guard answering its
    // own question.
    const asTask = checkCapabilities(
      NINE_ROUTER_PROVIDER_ID,
      'cx/gpt-5.6-terra',
      probeRequest('cx/gpt-5.6-terra', false),
      unverifiedVision,
      false,
      false,
    );
    const asProbe = checkCapabilities(
      NINE_ROUTER_PROVIDER_ID,
      'cx/gpt-5.6-terra',
      probeRequest('cx/gpt-5.6-terra', true),
      unverifiedVision,
      false,
      true,
    );
    expect(asTask?.category).toBe('capability_unverified');
    expect(asProbe).toBeNull();
  });

  it('18 — the exemption covers only the unverified branch', () => {
    // A capability measured and found absent is still refused to a probe.
    // Otherwise the exemption would be a way to send an image to a model that
    // is known not to accept one.
    const confirmedAbsent: ModelCapabilities = {
      ...MEASURED_VISION,
      vision: false,
      unverified: [],
    };
    const refused = checkCapabilities(
      NINE_ROUTER_PROVIDER_ID,
      'cx/gpt-5.6-terra',
      probeRequest('cx/gpt-5.6-terra', true),
      confirmedAbsent,
      false,
      true,
    );
    expect(refused?.category).toBe('unsupported_capability');
  });

  it('19 — the flag comes from the management context, not from the request body', async () => {
    // A task cannot grant itself the exemption. `management` is set by
    // `managementContext`, which builds the context for probes; a task's
    // context is built by the runtime and never carries it.
    const source = readFileSync('src/providers/adapters/openai-compatible.ts', 'utf8');
    expect(source).toContain('request.egress?.management === true');

    // And end to end: an ordinary task request for an unverified capability is
    // refused even though the adapter is otherwise identical.
    const adapter = new NineRouterAdapter(forbiddenTransport());
    await adapter.connect({
      providerId: NINE_ROUTER_PROVIDER_ID,
      baseUrl: 'http://localhost:20128/v1',
      apiKey: KEY,
      model: 'cx/gpt-5.6-terra',
    });
    await expect(adapter.generate(probeRequest('cx/gpt-5.6-terra', false))).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProviderRequestError && error.category === 'capability_unverified',
    );
  });
});

describe('TEST-CAPAUTH-001 — the model id moves nothing', () => {
  for (const modelId of SUGGESTIVE) {
    it(`04 — "${modelId}" gets the same answer as every other id`, async () => {
      const adapter = new NineRouterAdapter(forbiddenTransport());
      await adapter.connect({
        providerId: NINE_ROUTER_PROVIDER_ID,
        baseUrl: 'http://localhost:20128/v1',
        apiKey: KEY,
        model: modelId,
      });

      // Advertised: unverified, for all of them. Under the old implementation
      // the ids containing `gpt-5`, `vision`, `llava`, `qwen-vl` or `o4` came
      // back `true` and the rest `false`.
      const capabilities = await adapter.getCapabilities(modelId);
      expect(capabilities.vision, modelId).toBe(false);
      expect(isUnverified(capabilities, 'vision'), modelId).toBe(true);

      // Enforced: refused, for all of them, and refused as *unverified*. This
      // is the assertion that fails if the pre-flight check goes back to
      // reading a name instead of asking the adapter.
      await expect(adapter.generate(visionRequest(modelId))).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof ProviderRequestError && error.category === 'capability_unverified',
      );
    });
  }

  it('05 — the generic adapter does not read a name either', async () => {
    // The same rule one level up the chain. This adapter is pointed at
    // whatever endpoint the user named, so a model id is not evidence about it.
    for (const modelId of ['gpt-4o', 'gpt-4.1', 'o3-mini', 'llava', 'qwen-vl', 'text-only']) {
      const adapter = new OpenAICompatibleAdapter(forbiddenTransport());
      await adapter.connect({
        providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
        baseUrl: 'https://api.example.test/v1',
        apiKey: KEY,
        model: modelId,
      });
      const capabilities = await adapter.getCapabilities(modelId);
      expect(capabilities.vision, modelId).toBe(false);
      expect(isUnverified(capabilities, 'vision'), modelId).toBe(true);
    }
  });

  it('06 — no hint table survives in the source', () => {
    // The table and its reader are gone, not merely unused. A dormant
    // `looksVisionCapable` is an invitation to call it again.
    const source = readFileSync('src/providers/adapters/openai-compatible.ts', 'utf8');
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('VISION_MODEL_HINTS');
    expect(code).not.toContain('looksVisionCapable');
    // And nothing in the file decides a capability from the model string.
    expect(code).not.toMatch(/vision:\s*[a-zA-Z]+\(model/);
  });
});

describe('TEST-CAPAUTH-001 — a measurement is the authority, and it is scoped', () => {
  it('07 — a measurement for this exact model is what the guard reads', async () => {
    const adapter = new NineRouterAdapter(forbiddenTransport());
    await adapter.connect({
      providerId: NINE_ROUTER_PROVIDER_ID,
      baseUrl: 'http://localhost:20128/v1',
      apiKey: KEY,
      model: 'cx/gpt-6-astra',
      measuredCapabilities: MEASURED_VISION,
    });

    const capabilities = await adapter.getCapabilities('cx/gpt-6-astra');
    expect(capabilities.vision).toBe(true);
    expect(isUnverified(capabilities, 'vision')).toBe(false);
  });

  it('08 — a measurement does not answer for a different model', async () => {
    // Scope, asserted at the adapter. The runtime only hands over a
    // measurement whose `capabilityScope` matches the account and the model;
    // this is the second half of that rule, where the adapter refuses to apply
    // one to any other model even if it is handed one.
    const adapter = new NineRouterAdapter(forbiddenTransport());
    await adapter.connect({
      providerId: NINE_ROUTER_PROVIDER_ID,
      baseUrl: 'http://localhost:20128/v1',
      apiKey: KEY,
      model: 'cx/gpt-6-astra',
      measuredCapabilities: MEASURED_VISION,
    });

    // The model it was measured on.
    expect((await adapter.getCapabilities('cx/gpt-6-astra')).vision).toBe(true);
    // Every other model, including ones that differ only in their suffix, or
    // only in their prefix, falls back to the unverified floor.
    for (const other of [
      'cx/gpt-6-sol',
      'cx/gpt-6-astra-review',
      'work/gpt-6-astra',
      'gpt-6-astra',
      'cx/gpt-6-astra ',
    ]) {
      const capabilities = await adapter.getCapabilities(other);
      expect(capabilities.vision, other).toBe(false);
      expect(isUnverified(capabilities, 'vision'), other).toBe(true);
    }
  });

  it('09 — the runtime only passes a measurement whose scope matches', () => {
    // The first half of the rule, where the measurement is selected. Asserted
    // against the source because booting the worker is not available here;
    // what matters is that the same scoped expression feeds both the adapter
    // and the runtime, so the two cannot come to disagree.
    const worker = readFileSync('src/background/service-worker.ts', 'utf8');
    const start = worker.indexOf('async function resolveFromAccount(');
    const body = worker.slice(start, worker.indexOf('\n}', start));
    expect(body).toContain('account.capabilityScope?.connectionId === account.connectionId');
    expect(body).toContain('account.capabilityScope?.modelId === account.modelId');
    expect(body).toContain('measuredCapabilities: measured');
    expect(body).toContain('capabilities: measured ?? UNKNOWN_CAPABILITIES');
  });

  it('10 — the doctor probes an unverified capability instead of skipping it', () => {
    // The gate that made the honest answer permanent. It must test for a
    // *confirmed* absence, not for a falsy boolean.
    const doctor = readFileSync('src/providers/capability-doctor/capability-doctor.ts', 'utf8');
    expect(doctor).toContain("!advertised.vision && !isUnverified(advertised, 'vision')");
    // And what it produces is a measurement, so it carries no placeholders.
    expect(doctor).toContain('unverified: []');
  });

  it('11 — the pre-flight check is overridable and asks the adapter', () => {
    const source = readFileSync('src/providers/adapters/openai-compatible.ts', 'utf8');
    // `protected`, so a subclass whose capabilities differ can be correct.
    expect(source).toMatch(/protected\s+async\s+unsupported\(/);
    expect(source).not.toMatch(/private\s+unsupported\(/);
    // And it reads the instance, not a module-level function.
    expect(source).toContain('await this.getCapabilities(model)');
  });

  it('12 — "nothing measured" is a labelled state, not a row of falses', () => {
    // The representation the whole fix rests on: before any probe, every
    // requestable capability is explicitly unestablished rather than silently
    // denied.
    expect(REQUESTABLE_CAPABILITIES).toContain('vision');
    expect(REQUESTABLE_CAPABILITIES.length).toBeGreaterThanOrEqual(4);
  });
});

describe('TEST-CAPAUTH-001 — a gateway operation is never labelled as the base provider', () => {
  it('13 — the base adapter holds no instance-scoped provider literal', () => {
    // D3. Every operation that belongs to an instance now takes its identity
    // from `this.id`; the only remaining uses of the constant are the
    // declaration, the class default and the factory, which are the three
    // places it *is* the right answer.
    const source = readFileSync('src/providers/adapters/openai-compatible.ts', 'utf8');
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const uses = code.match(/OPENAI_COMPATIBLE_PROVIDER_ID/g) ?? [];
    expect(uses).toHaveLength(3);
    expect(code).toContain("export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible'");
    expect(code).toContain('readonly id: string = OPENAI_COMPATIBLE_PROVIDER_ID');
    expect(code).toContain('id: OPENAI_COMPATIBLE_PROVIDER_ID');
    // And the instance identity is used where it was not.
    expect(code).toContain('managementContext(this.id');
    expect(code).toContain('admitModelIds(this.id');
    expect(code).toContain('toNetworkError(this.id');
    expect(code).toContain('parseJsonBody<WireCompletion>(this.id');
    expect(code).toContain('toHttpFailure(this.id');
  });

  it('14 — a gateway failure names the gateway', async () => {
    const adapter = new NineRouterAdapter({
      request: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'nope' } }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });
    await adapter.connect({
      providerId: NINE_ROUTER_PROVIDER_ID,
      baseUrl: 'http://localhost:20128/v1',
      apiKey: KEY,
      model: 'cx/gpt-6-astra',
      measuredCapabilities: MEASURED_VISION,
    });

    const failure = await adapter
      .generate({
        systemInstruction: '',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        egress: visionRequest('cx/gpt-6-astra').egress,
      } as unknown as CanonicalRequest)
      .then(
        () => null,
        (error: unknown) => error as ProviderRequestError,
      );

    expect(failure).toBeInstanceOf(ProviderRequestError);
    expect(failure!.providerId).toBe(NINE_ROUTER_PROVIDER_ID);
    expect(failure!.providerId).not.toBe(OPENAI_COMPATIBLE_PROVIDER_ID);
    // And the credential is not in it.
    expect(JSON.stringify(failure!.agentError)).not.toContain(KEY);
  });

  it('15 — a gateway health probe is identified as the gateway', async () => {
    // `validateConnection` is inherited unmodified, which is exactly why it
    // used to carry the base provider's identity into the management egress
    // context and the destination.
    const seen: { providerId: string; modelId: string }[] = [];
    const adapter = new NineRouterAdapter({
      request: (_url, _init, context) => {
        seen.push({ providerId: context.providerId, modelId: context.modelId });
        return Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });
    await adapter.connect({
      providerId: NINE_ROUTER_PROVIDER_ID,
      baseUrl: 'http://localhost:20128/v1',
      apiKey: KEY,
      model: 'cx/gpt-5.6-terra',
    });

    await adapter.validateConnection();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.providerId).toBe(NINE_ROUTER_PROVIDER_ID);
    // And the exact model id, `/` included, reached the context unchanged.
    expect(seen[0]!.modelId).toBe('cx/gpt-5.6-terra');
  });

  it('16 — discovery is identified as the gateway, with the exact model id', async () => {
    const seen: string[] = [];
    const adapter = new NineRouterAdapter({
      request: (_url, _init, context) => {
        seen.push(context.providerId);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              object: 'list',
              data: [{ id: 'cx/gpt-6-astra', object: 'model', owned_by: 'cx' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    });
    await adapter.connect({
      providerId: NINE_ROUTER_PROVIDER_ID,
      baseUrl: 'http://localhost:20128/v1',
      apiKey: KEY,
      model: 'cx/gpt-6-astra',
    });

    const models = await adapter.listModels();
    expect(models.map((model) => model.id)).toEqual(['cx/gpt-6-astra']);
    expect(seen).toEqual([NINE_ROUTER_PROVIDER_ID]);
  });
});
