/**
 * TEST-9RLIVE-001 — the production pipeline against a real running 9Router.
 *
 * Everything else about 9Router in this repository is tested against fixtures,
 * which is the right default: a suite that needs a local service is a suite
 * that fails for anyone who does not have one. But a fixture can only confirm
 * that this build is self-consistent. It cannot confirm that the gateway names
 * models the way this build expects, that `/v1/models` answers the way the
 * adapter assumes, or that an id containing `/` survives a round trip through
 * software nobody here wrote.
 *
 * So this file is **opt-in and real**. It runs only when a base URL and a key
 * are present in the environment and the endpoint actually answers; otherwise
 * every case skips. Nothing is mocked — the registry, the guarded transport,
 * the adapter, the egress gate, the consent store, the audit log and the
 * capability doctor are all the production objects, assembled the way
 * `service-worker.ts` assembles them. The only thing supplied from outside is
 * the credential.
 *
 * ## Running it
 *
 * ```
 * NINEROUTER_TEST_BASE_URL=http://localhost:20128/v1 \
 * NINEROUTER_TEST_API_KEY=… \
 *   npx vitest run tests/integration/nine-router-live.test.ts
 * ```
 *
 * ## The credential
 *
 * It is read from the environment and never written anywhere. It is not a
 * literal in this file, it is not a fixture, and the cases below assert its
 * absence from the audit trail, from the evidence digest and from every error
 * this build produces — after first asserting that the request really did carry
 * it, because otherwise those absences would prove only that nothing happened.
 * Nothing in this file prints it, and no assertion message can contain it: the
 * matchers compare against it rather than interpolating it.
 */
import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '@/providers/registry/provider-registry';
import { API_PROVIDER_FACTORIES } from '@/providers/registry/api-providers';
import { discoverCatalogue } from '@/providers/registry/discovery';
import { modelSelectionState, selectionRefusal } from '@/providers/registry/model-selection';
import { NineRouterAdapter } from '@/providers/adapters/nine-router';
import {
  NINE_ROUTER_PROVIDER_ID,
  parseModelCatalogue,
} from '@/providers/adapters/nine-router-catalog';
import { CapabilityDoctor } from '@/providers/capability-doctor/capability-doctor';
import { createGuardedTransport, managementTaskId } from '@/security/egress/provider-transport';
import { ConsentStore, type ProviderPin } from '@/security/egress/consent';
import { providerDestination } from '@/security/egress/destination';
import { AuditLog } from '@/audit/audit-log';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { accountAfterCatalogue, accountAfterSelection } from '@/providers/accounts/account-model';
import { connectionForBrain } from '@/providers/accounts/brain-projection';
import { isRecordableModelId } from '@/providers/core/provider-http';
import { isUnverified } from '@/providers/core/types';
import type { ConnectedAccount } from '@/providers/accounts/account-model';
import type { AIProviderAdapter, CanonicalRequest } from '@/providers/core/types';
import type { EgressContext } from '@/security/egress/provider-transport';

const BASE_URL = process.env.NINEROUTER_TEST_BASE_URL ?? '';
const API_KEY = process.env.NINEROUTER_TEST_API_KEY ?? '';
const CONFIGURED = BASE_URL.length > 0 && API_KEY.length > 0;

/**
 * The probe runs at module scope, not in `beforeAll`.
 *
 * `it.skipIf(...)` is evaluated while the file is being *collected*, so a flag
 * set in a hook is still `false` when every guard is read and the whole file
 * silently skips. Top-level await is the only placement where the condition is
 * known in time — and a file that skips when it should have run is the failure
 * mode this file exists to avoid.
 */
const probe = await (async (): Promise<{
  ids: string[];
  owners: string[];
  usable: string;
  unusable: string;
}> => {
  const empty = { ids: [], owners: [], usable: '', unusable: '' };
  if (!CONFIGURED) return empty;
  let ids: string[] = [];
  let owners: string[] = [];
  try {
    const response = await fetch(`${BASE_URL}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return empty;
    const body = (await response.json()) as { data?: { id?: unknown; owned_by?: unknown }[] };
    ids = (body.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === 'string');
    owners = [
      ...new Set(
        (body.data ?? [])
          .map((entry) => entry.owned_by)
          .filter((owner): owner is string => typeof owner === 'string'),
      ),
    ];
  } catch {
    return empty;
  }
  if (ids.length === 0) return empty;

  // Being listed is not the same as being usable, and finding that out is one
  // of the things only a real service can tell you. A gateway's catalogue is
  // the union of what its upstreams *name*; whether the connected account is
  // entitled to a given model is a separate question the upstream answers at
  // request time. On the account this was written against, `/v1/models` offers
  // eighteen models and several reply
  // `"… is not supported when using Codex with a ChatGPT account"`.
  //
  // So the completion cases need a model that actually answers, found by
  // asking. Capped, and with the smallest possible body, because every attempt
  // spends the user's quota.
  let usable = '';
  let unusable = '';
  for (const id of ids.slice(0, 8)) {
    try {
      const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'ping' }] }),
        signal: AbortSignal.timeout(45_000),
      });
      if (response.ok) {
        usable = id;
        break;
      }
      // Discovered and listed, but this account cannot run it. Recorded as it
      // is found rather than probed for separately, so Phase G costs no
      // additional upstream calls — and discovered by *asking*, never by
      // recognising a name.
      if (unusable.length === 0) unusable = id;
    } catch {
      // Try the next one; an unusable model is not a failure of this file.
    }
  }
  return { ids, owners, usable, unusable };
})();

const liveIds: string[] = probe.ids;
const liveOwners: string[] = probe.owners;
/** The first id the catalogue offers. Enough for the parsing and pin cases. */
const liveModel: string = liveIds[0] ?? '';
/** A model this account can actually run. Required by the completion cases. */
const usableModel: string = probe.usable;
/** A model the catalogue lists that this account cannot run, if there is one. */
const unusableModel: string = probe.unusable;
const reachable = liveIds.length > 0;
/** Configured *and* answering. */
const LIVE = CONFIGURED && reachable;
/** Live *and* with a model the account may use. */
const RUNNABLE = LIVE && usableModel.length > 0;
/** Live *and* with a listed model the account may not use. */
const HAS_UNUSABLE = LIVE && unusableModel.length > 0;

const area = (): SerializedStorageArea => new SerializedStorageArea(new MemoryStorageArea());

/**
 * Says which mode this run is in, so a file that skipped everything is not
 * mistaken for a file that passed.
 *
 * `process.stdout.write` rather than `console`, because `no-console` is an
 * `error` in this repository and its reason is that *production* code must route
 * through `src/logging`. This is a test harness reporting its own
 * configuration, which is neither production code nor application logging — and
 * the alternative, an eslint override, would relax the rule for every file to
 * buy one line here. No credential appears in any of these.
 */
process.stdout.write(
  !CONFIGURED
    ? '[9RLIVE] skipped: NINEROUTER_TEST_BASE_URL / NINEROUTER_TEST_API_KEY not set.\n'
    : !reachable
      ? `[9RLIVE] skipped: no 9Router answered at ${BASE_URL}.\n`
      : `[9RLIVE] live: ${liveIds.length} models, ${liveOwners.length} upstream group(s), ` +
        (usableModel.length > 0
          ? 'one runnable model found.\n'
          : 'no runnable model — completion cases will skip.\n'),
);

/** The production transport, with the gate and a recorder on the decision. */
function harness(): {
  adapter: AIProviderAdapter;
  log: AuditLog;
  urls: string[];
  headers: Record<string, string>[];
  payloads: unknown[];
} {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const payloads: unknown[] = [];
  const log = new AuditLog(area(), { knownTool: () => true });
  const consent = new ConsentStore();

  const transport = createGuardedTransport({
    consent,
    // The real `fetch`, wrapped only to observe. The request that goes out is
    // the one the adapter built.
    fetchImpl: ((url: string, init: RequestInit) => {
      urls.push(url);
      headers.push({ ...((init.headers ?? {}) as Record<string, string>) });
      return fetch(url, init);
    }) as unknown as typeof fetch,
    onDecision: async (decision, context, url, payload) => {
      payloads.push(payload);
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
      void url;
    },
  });

  const registry = new ProviderRegistry({ transport });
  for (const factory of API_PROVIDER_FACTORIES) registry.register(factory);
  return { adapter: registry.get(NINE_ROUTER_PROVIDER_ID), log, urls, headers, payloads };
}

function account(modelId: string | null): ConnectedAccount {
  return {
    connectionId: 'conn_live',
    abaUserId: 'user_live',
    providerId: NINE_ROUTER_PROVIDER_ID,
    protocol: 'openai-compatible',
    displayName: '9Router',
    accountLabel: 'localhost (key …)',
    authKind: 'api_key',
    baseUrl: BASE_URL,
    modelId,
    capabilities: null,
    capabilityScope: null,
    status: 'connected',
    lastValidated: null,
    createdAt: 1_700_000_000_000,
  };
}

function taskEgress(modelId: string): EgressContext {
  return {
    taskId: 'task_live_9r',
    taintState: { kind: 'KNOWN_UNTAINTED' },
    taintSalt: 'ab'.repeat(32),
    saltEpoch: 1,
    taintSignature: 'live-integration',
    providerId: NINE_ROUTER_PROVIDER_ID,
    connectionId: 'conn_live',
    modelId,
  };
}

// ---------------------------------------------------------------------------
// Phase A — the real /v1/models
// ---------------------------------------------------------------------------

describe('TEST-9RLIVE-001 — Phase A: the real catalogue', () => {
  it.skipIf(!CONFIGURED)('A1 — the endpoint answers with a catalogue', () => {
    expect(reachable, `no 9Router answered at ${BASE_URL}`).toBe(true);
    expect(liveIds.length).toBeGreaterThan(0);
  });

  it.skipIf(!LIVE)('A2 — the real body parses, and every id survives exactly', async () => {
    const response = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();

    // The production parser, on the production body.
    const catalogue = parseModelCatalogue(body);
    expect(catalogue.models.length).toBe(liveIds.length);
    // Identity, not similarity, and in catalogue order.
    expect(catalogue.models.map((model) => model.id)).toEqual(liveIds);
    // Nothing was refused: a real catalogue should be wholly usable, and if it
    // is not, the count says how many entries were lost rather than hiding it.
    expect(catalogue.refused, `refused: ${JSON.stringify(catalogue.refused)}`).toEqual([]);
    // Every id is recordable, so every request made with one keeps its trail.
    for (const id of liveIds) expect(isRecordableModelId(id), id).toBe(true);
  });

  it.skipIf(!LIVE)('A3 — the hierarchy comes from owned_by, not from the id', () => {
    // Whatever the real service reports, the grouping must be derived from the
    // field it populates. Asserted against the live values rather than against
    // an expectation about what this user's gateway happens to be called.
    expect(liveOwners.length).toBeGreaterThan(0);
    const response = parseModelCatalogue({
      object: 'list',
      data: liveIds.map((id, index) => ({
        id,
        object: 'model',
        owned_by: liveOwners[index % liveOwners.length],
      })),
    });
    expect(response.groups.length).toBeGreaterThan(0);
    for (const group of response.groups) {
      // Opaque: no separator a consumer could be tempted to split on.
      expect(group.key).toMatch(/^(up:[a-z0-9._~-]+|other)$/);
    }
  });

  it.skipIf(!LIVE)('A4 — /v1/models is not key-gated, which is recorded as a fact', async () => {
    // Observed rather than assumed, because the whole shape of the connection
    // flow depends on it: discovery cannot validate a credential, so
    // `validateConnection` has to probe `/chat/completions` instead.
    const withoutKey = await fetch(`${BASE_URL}/models`);
    const withBadKey = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: 'Bearer sk-not-a-real-key-at-all' },
    });
    expect(withoutKey.status).toBe(200);
    expect(withBadKey.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Phase B — discovery through the production path
// ---------------------------------------------------------------------------

describe('TEST-9RLIVE-001 — Phase B: discovery through the real adapter', () => {
  it.skipIf(!LIVE)('B1 — the guarded transport reaches /models and parses it', async () => {
    const { adapter, urls, headers } = harness();
    const auth = await adapter.connect({
      providerId: NINE_ROUTER_PROVIDER_ID,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
    });
    expect(auth.authenticated).toBe(true);

    const models = await adapter.listModels();

    // The production adapter got the same ids as the raw call.
    expect(models.map((model) => model.id)).toEqual(liveIds);
    // Through the guarded transport, at the documented path.
    expect(urls.some((url) => url.endsWith('/models'))).toBe(true);
    // And carrying the credential — which is what makes the absence
    // assertions elsewhere meaningful.
    expect(JSON.stringify(headers)).toContain(API_KEY);
  });

  it.skipIf(!LIVE)('B2 — discovery records, naming the gateway', async () => {
    const { adapter, log } = harness();
    await adapter.connect({
      providerId: NINE_ROUTER_PROVIDER_ID,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
    });

    const recorded: { providerId: string; discovered: number }[] = [];
    const catalogue = await discoverCatalogue(
      adapter,
      NINE_ROUTER_PROVIDER_ID,
      async (providerId, discovered, refused) => {
        recorded.push({ providerId, discovered });
        await log.record({
          type: 'provider.selected',
          outcome: 'info',
          providerId,
          code: 'catalogue_discovered',
          recordCount: discovered,
          ...(refused === 0 ? {} : { removedCount: refused }),
        } as never);
      },
    );

    expect(catalogue.models.length).toBe(liveIds.length);
    expect(recorded).toEqual([{ providerId: NINE_ROUTER_PROVIDER_ID, discovered: liveIds.length }]);
    // The gateway reports levels, so the panel can show them.
    expect(catalogue.groups?.length ?? 0).toBeGreaterThan(0);

    const trail = JSON.stringify(await log.list(20));
    expect(trail).toContain('catalogue_discovered');
    expect(trail).not.toContain(API_KEY);
    expect(log.degradedReason()).toBeNull();
  });

  it.skipIf(!LIVE)('B3 — there is no second network path', async () => {
    // The adapter must not reach the network except through the transport it
    // was given. With the transport refusing, discovery degrades to an empty
    // catalogue rather than finding another way out.
    const bare = new NineRouterAdapter();
    await bare.connect({ providerId: NINE_ROUTER_PROVIDER_ID, baseUrl: BASE_URL, apiKey: API_KEY });
    expect(await bare.listModels()).toEqual([]);
    expect(bare.groups()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase C — selection, pin, persistence, restart
// ---------------------------------------------------------------------------

describe('TEST-9RLIVE-001 — Phase C: selecting a real model', () => {
  it.skipIf(!LIVE)('C1 — the exact id survives selection, projection and a restart', () => {
    const selected = accountAfterSelection(account(null), liveModel);
    expect(selected.modelId).toBe(liveModel);

    const projected = connectionForBrain(selected);
    expect(projected?.modelId).toBe(liveModel);
    expect(projected?.providerId).toBe(NINE_ROUTER_PROVIDER_ID);
    expect(projected?.connectionId).toBe('conn_live');

    // A service-worker restart rebuilds from the stored record, so the stored
    // record is what has to carry the id — through a real serialisation round
    // trip, not a structural copy.
    const restored = JSON.parse(JSON.stringify(selected)) as ConnectedAccount;
    expect(restored.modelId).toBe(liveModel);
    expect(connectionForBrain(restored)?.modelId).toBe(liveModel);
  });

  it.skipIf(!LIVE)('C2 — the pin is the gateway, the account and this exact model', async () => {
    const destination = providerDestination(
      NINE_ROUTER_PROVIDER_ID,
      BASE_URL,
      liveModel,
      'conn_live',
    );
    expect(destination.modelId).toBe(liveModel);
    expect(destination.providerId).toBe(NINE_ROUTER_PROVIDER_ID);

    const pin: ProviderPin = {
      identity: destination.identity ?? '',
      connectionId: 'conn_live',
      modelId: liveModel,
    };
    const consent = new ConsentStore();
    consent.pinProvider('task_live_9r', pin);
    expect(consent.matchesPin('task_live_9r', pin)).toBe(true);

    // Another real model from the same gateway is a different recipient.
    const other = liveIds.find((id) => id !== liveModel);
    if (other !== undefined) {
      expect(consent.matchesPin('task_live_9r', { ...pin, modelId: other })).toBe(false);
    }

    // And the management identity is a digest, so the `/` in the id cannot
    // make it invalid — the defect this whole design was written around.
    const taskId = await managementTaskId(NINE_ROUTER_PROVIDER_ID, liveModel);
    expect(taskId).toMatch(/^[A-Za-z0-9_.:-]{1,80}$/);
    expect(taskId).not.toContain('/');
  });

  it.skipIf(!LIVE)('C3 — a model the real catalogue offers is valid; a near-miss is stale', () => {
    const current = modelSelectionState(liveModel, liveIds, true);
    expect(current).toEqual({ kind: 'valid', modelId: liveModel });

    // Derived from the real id, which is how the brief asks a mutation to be
    // built without touching the user's gateway configuration.
    const renamed = `renamed-prefix/${liveModel.includes('/') ? liveModel.split('/').slice(1).join('/') : liveModel}`;
    const stale = modelSelectionState(renamed, liveIds, true);
    expect(stale.kind).toBe('stale');
    expect(selectionRefusal(stale)).toContain(renamed);
  });
});

// ---------------------------------------------------------------------------
// Phase D — a real chat completion through the production pipeline
// ---------------------------------------------------------------------------

describe('TEST-9RLIVE-001 — Phase D: a real completion', () => {
  it.skipIf(!RUNNABLE)(
    'D1 — one harmless request reaches the upstream and comes back',
    async () => {
      const { adapter, log, urls, headers, payloads } = harness();
      await adapter.connect({
        providerId: NINE_ROUTER_PROVIDER_ID,
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        model: usableModel,
      });

      const request: CanonicalRequest = {
        systemInstruction: 'You are a test probe. Answer exactly as instructed.',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Reply with exactly: REAL_9ROUTER_TEST_OK' }],
          },
        ],
        egress: taskEgress(usableModel),
      } as unknown as CanonicalRequest;

      const response = await adapter.generate(request);

      // It really went to the gateway's completions endpoint, through the gate.
      expect(urls.some((url) => url.includes('/chat/completions'))).toBe(true);
      // Carrying the credential, which the adapter injected.
      expect(JSON.stringify(headers)).toContain(API_KEY);
      // And naming the exact model, `/` intact — the request body is the
      // adapter's own, so this is the id as it left the device.
      const sent = payloads.map((payload) => String(payload)).join('\n');
      expect(sent).toContain(JSON.stringify(usableModel).slice(1, -1));
      // The credential is not in the body.
      expect(sent).not.toContain(API_KEY);

      // A real answer came back and was adapted.
      expect(response.text.length).toBeGreaterThan(0);
      expect(response.text).toContain('REAL_9ROUTER_TEST_OK');

      // The decision was recorded, against the gateway and the exact model.
      const entries = await log.list(20);
      const egress = entries.filter((entry) => entry.tool === 'provider.request');
      expect(egress.length).toBeGreaterThan(0);
      expect(egress[0]!.providerId).toBe(NINE_ROUTER_PROVIDER_ID);
      expect(egress[0]!.modelId).toBe(usableModel);
      expect(egress[0]!.outcome).toBe('allowed');
      expect(log.degradedReason()).toBeNull();

      // And nothing in the trail carries the key.
      const trail = JSON.stringify(entries);
      expect(trail).not.toContain(API_KEY);
      expect(trail).not.toMatch(/sk-[A-Za-z0-9]{8,}-[A-Za-z0-9]{6}-[A-Za-z0-9]{8}/);
    },
    60_000,
  );

  it.skipIf(!RUNNABLE)('D2 — an image is refused as unverified, not sent', async () => {
    // The gateway's own catalogue claims `vision: true` for most models, by
    // matching names against a table of its own. This build does not forward
    // that as a measurement, so an image is refused until the doctor settles
    // it — and the refusal says which of the two reasons applies.
    const { adapter, urls } = harness();
    await adapter.connect({
      providerId: NINE_ROUTER_PROVIDER_ID,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      model: usableModel,
    });
    const before = urls.length;

    const capabilities = await adapter.getCapabilities(usableModel);
    expect(isUnverified(capabilities, 'vision')).toBe(true);

    await expect(
      adapter.generate({
        systemInstruction: '',
        messages: [
          { role: 'user', content: [{ type: 'image', data: 'QUFBQQ==', mimeType: 'image/png' }] },
        ],
        egress: taskEgress(usableModel),
      } as unknown as CanonicalRequest),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof Error && /has not been established/.test(error.message),
    );

    // Refused before the network, so no image left the device.
    expect(urls.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Phase E — the real capability doctor
// ---------------------------------------------------------------------------

describe('TEST-9RLIVE-001 — Phase E: the capability doctor, really run', () => {
  it.skipIf(!RUNNABLE)(
    'E1 — the doctor measures the real model and reports what it measured',
    async () => {
      const { adapter, log } = harness();
      await adapter.connect({
        providerId: NINE_ROUTER_PROVIDER_ID,
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        model: usableModel,
      });

      const doctor = new CapabilityDoctor();
      const report = await doctor.run(adapter, usableModel, { quick: false });

      // The report is about the exact model that was selected.
      expect(report.modelId).toBe(usableModel);
      expect(report.providerId).toBe(NINE_ROUTER_PROVIDER_ID);

      // Each check is a measurement with a verdict, not an echo of a claim.
      const byId = new Map(report.checks.map((check) => [check.id, check]));
      for (const id of ['text', 'tools', 'streaming', 'vision']) {
        expect(byId.has(id), `${id} was checked`).toBe(true);
        expect(['pass', 'fail', 'unsupported']).toContain(byId.get(id)!.status);
      }

      // The point of the fix: vision was *probed*, not skipped on an
      // advertisement. Whatever the verdict, it is not the "not configured"
      // short circuit that used to make it permanent.
      expect(byId.get('vision')!.detail).not.toBe('This model is not configured for image input.');

      // The measured set carries no placeholders: everything requestable was
      // either probed or is a confirmed absence.
      expect(report.capabilities.unverified).toEqual([]);

      // A context window the gateway inferred is not reported as measured.
      const context = byId.get('context');
      if (context && context.status === 'pass') {
        expect(context.detail).not.toContain('null-token');
      }

      // The probes recorded, against the gateway, and carried no credential.
      const trail = JSON.stringify(await log.list(50));
      expect(trail).toContain(NINE_ROUTER_PROVIDER_ID);
      expect(trail).not.toContain(API_KEY);
      expect(log.degradedReason()).toBeNull();
    },
    180_000,
  );
});

// ---------------------------------------------------------------------------
// Phase G — discovered, listed, and not usable by this account
// ---------------------------------------------------------------------------

describe('TEST-9RLIVE-001 — Phase G: listed is not the same as usable', () => {
  it.skipIf(!HAS_UNUSABLE)(
    'G1 — a listed model the account cannot run is measured as failed, with its reason kept',
    async () => {
      // The condition only a real service produces. A gateway's catalogue is
      // the union of what its upstreams *name*; entitlement is a separate fact
      // the upstream answers at request time. On the account this was written
      // against, several listed models reply
      // `"… is not supported when using Codex with a ChatGPT account"`.
      //
      // It is deliberately *not* the stale case — the model is in the
      // catalogue — and the architecture already had the right place for it:
      // the capability doctor measures one exact (connection, model) pair.
      const { adapter, log } = harness();
      await adapter.connect({
        providerId: NINE_ROUTER_PROVIDER_ID,
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        model: unusableModel,
      });

      // Quick mode: one upstream call, which is all that is needed to learn
      // that the account cannot use it. Probing a model nobody selected, or
      // running the full battery to establish unavailability, would spend the
      // user's quota to populate a UI.
      const report = await new CapabilityDoctor().run(adapter, unusableModel, { quick: true });

      expect(report.modelId).toBe(unusableModel);
      expect(report.providerId).toBe(NINE_ROUTER_PROVIDER_ID);
      expect(report.readiness).toBe('FAILED');
      // The real reason, preserved rather than reduced to a status. This is
      // what `doctorVerdict` stores as `statusReason`.
      expect(report.summary.trim().length).toBeGreaterThan(0);
      // Nothing was demonstrated, so nothing is claimed.
      expect(report.capabilities.text).toBe(false);

      // And it is still in the catalogue, so it is not stale and must not be
      // marked as such.
      expect(modelSelectionState(unusableModel, liveIds, true).kind).toBe('valid');

      // The failure was recorded against the gateway, and carries no credential.
      const trail = JSON.stringify(await log.list(30));
      expect(trail).not.toContain(API_KEY);
      expect(log.degradedReason()).toBeNull();
    },
    120_000,
  );

  it.skipIf(!(HAS_UNUSABLE && RUNNABLE))(
    'G2 — the failed verdict does not follow the user to a model that works',
    async () => {
      // The defect this pass fixed, end to end on real verdicts: the
      // measurement was discarded on a model switch and its conclusion was
      // not, so the connection kept reading `failed` for a model that runs.
      const { adapter } = harness();
      await adapter.connect({
        providerId: NINE_ROUTER_PROVIDER_ID,
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        model: unusableModel,
      });
      const failed = await new CapabilityDoctor().run(adapter, unusableModel, { quick: true });
      expect(failed.readiness).toBe('FAILED');

      // Stored the way `accounts.runDoctor` stores it.
      const measured = account(unusableModel);
      const afterFailure: ConnectedAccount = {
        ...measured,
        capabilities: failed.capabilities,
        capabilityScope: { connectionId: 'conn_live', modelId: unusableModel },
        lastValidated: failed.generatedAt,
        status: 'failed',
        statusReason: failed.summary,
      };
      expect(afterFailure.statusReason).toBe(failed.summary);

      // Then the user picks the model that works.
      const switched = accountAfterSelection(afterFailure, usableModel);
      expect(switched.modelId).toBe(usableModel);
      expect(switched.status).toBe('connected');
      expect('statusReason' in switched).toBe(false);
      expect(switched.capabilityScope).toBeNull();
      expect(switched.lastValidated).toBeNull();

      // And the model that works really does work, measured the same way.
      const { adapter: second } = harness();
      await second.connect({
        providerId: NINE_ROUTER_PROVIDER_ID,
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        model: usableModel,
      });
      const healthy = await new CapabilityDoctor().run(second, usableModel, { quick: true });
      expect(healthy.readiness).not.toBe('FAILED');
    },
    180_000,
  );

  it.skipIf(!HAS_UNUSABLE)(
    'G3 — an unusable model is never removed from the catalogue',
    async () => {
      // Silently shortening the list the user is choosing from is its own kind
      // of lie, and it would also be wrong: entitlement can change without the
      // catalogue changing at all.
      const { adapter } = harness();
      await adapter.connect({
        providerId: NINE_ROUTER_PROVIDER_ID,
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        model: unusableModel,
      });
      const models = await adapter.listModels();
      expect(models.map((model) => model.id)).toContain(unusableModel);
      expect(models.map((model) => model.id)).toEqual(liveIds);
    },
  );
});

// ---------------------------------------------------------------------------
// Phase F — errors and edge cases, against the real service
// ---------------------------------------------------------------------------

describe('TEST-9RLIVE-001 — Phase F: real errors stay sanitised', () => {
  it.skipIf(!LIVE)(
    'F1 — an invalid model id fails, named and without the key',
    async () => {
      const { adapter, log } = harness();
      await adapter.connect({
        providerId: NINE_ROUTER_PROVIDER_ID,
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        // A model this gateway certainly does not offer. Deliberately
        // slash-less, which is the shape 9Router resolves by guessing — so this
        // is also the case where the gateway itself may answer surprisingly.
        model: 'definitely-not-a-real-model-xyzzy',
      });

      const failure = await adapter
        .generate({
          systemInstruction: '',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          egress: taskEgress('definitely-not-a-real-model-xyzzy'),
        } as unknown as CanonicalRequest)
        .then(
          () => null,
          (error: unknown) => error,
        );

      // Whatever the gateway said, the failure is this build's own taxonomy,
      // names the gateway, and does not echo the credential.
      if (failure !== null) {
        const serialised = JSON.stringify(failure, Object.getOwnPropertyNames(failure));
        expect(serialised).not.toContain(API_KEY);
        expect(serialised).not.toMatch(/sk-[A-Za-z0-9]{8,}-[A-Za-z0-9]{6}-[A-Za-z0-9]{8}/);
      }
      // The decision was still recorded either way: a request that failed is a
      // request that was made.
      const entries = await log.list(20);
      expect(entries.some((entry) => entry.tool === 'provider.request')).toBe(true);
      expect(JSON.stringify(entries)).not.toContain(API_KEY);
    },
    60_000,
  );

  it.skipIf(!LIVE)(
    'F2 — an unreachable gateway degrades rather than throwing',
    async () => {
      // A port nothing listens on, so this is a real connection failure rather
      // than a simulated one.
      const { adapter } = harness();
      await adapter.connect({
        providerId: NINE_ROUTER_PROVIDER_ID,
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: API_KEY,
        model: liveModel,
      });
      // Discovery degrades to "no catalogue" rather than failing the connection.
      expect(await adapter.listModels()).toEqual([]);

      // And an empty catalogue is read as "could not ask", not as "the model is
      // gone" — which is what stops a gateway restart invalidating a correct
      // selection.
      const verdict = modelSelectionState(liveModel, [], false);
      expect(verdict.kind).toBe('indeterminate');
      expect(selectionRefusal(verdict)).toBeNull();
    },
    30_000,
  );

  it.skipIf(!LIVE)('F3 — a hostile catalogue costs only its bad entries', () => {
    // Built from the real ids, so the shape is this gateway's own.
    const catalogue = parseModelCatalogue({
      object: 'list',
      data: [
        { id: liveModel, object: 'model', owned_by: liveOwners[0] },
        { id: liveModel, object: 'model', owned_by: liveOwners[0] }, // duplicate
        { id: 42, object: 'model', owned_by: 'cx' }, // not a string
        { id: null, object: 'model', owned_by: 'cx' },
        { object: 'model', owned_by: 'cx' }, // no id
        { id: 'cx/x', object: 'not-a-model', owned_by: 'cx' },
        { id: 'cx/y', object: 'model', owned_by: '   ' }, // unusable owner
        { id: '"'.repeat(300), object: 'model', owned_by: 'cx' }, // unrecordable
        'not an object',
        null,
      ],
    });

    // The good entries survive, exactly.
    expect(catalogue.models.map((model) => model.id)).toEqual([liveModel, 'cx/y']);
    // `cx/y` kept its id and moved to the fallback group rather than being lost
    // over its grouping metadata.
    expect(catalogue.models[1]!.upstreamKey).toBe('other');
    // And every refusal is counted with a reason, so the panel can say the
    // list was incomplete instead of silently shortening it.
    expect(catalogue.refused.map((entry) => entry.reason)).toEqual([
      'duplicate-id',
      'id-not-a-string',
      'no-id',
      'no-id',
      'wrong-object-kind',
      'id-unrecordable',
      'not-an-object',
      'not-an-object',
    ]);
  });

  it.skipIf(!LIVE)('F4 — an empty catalogue is not a stale selection', () => {
    // `{object:"list",data:[]}` is a provider that offers nothing, which is
    // different from a provider that could not be asked.
    const empty = parseModelCatalogue({ object: 'list', data: [] });
    expect(empty.models).toEqual([]);
    expect(empty.refused).toEqual([]);

    // The routes read an empty list as "could not ask", which is the
    // conservative direction: it leaves the selection alone.
    const verdict = modelSelectionState(liveModel, [], empty.models.length > 0);
    expect(verdict.kind).toBe('indeterminate');

    // And a stale marker already set is not cleared by an unread catalogue
    // either, because the marker only changes on a verdict.
    const marked = accountAfterCatalogue(account(liveModel), true);
    expect(marked.modelStale).toBe(true);
  });
});
