/**
 * TEST-ROUTING-001 — what the extension can promise about where a request went.
 *
 * ## The gateway's rules, verified
 *
 * Established from 9Router 0.5.91's own source and confirmed against a running
 * instance. These are facts about the gateway, not inferences from its
 * documentation:
 *
 * | id sent | how the gateway resolves it | on failure |
 * | --- | --- | --- |
 * | `prefix/model` | provider **is** the prefix, matched against a configured connection or a built-in provider id | `404 No active credentials for provider: <prefix>` — quotes the prefix verbatim |
 * | slash-less, recognised | that combination runs | — |
 * | slash-less, unrecognised | name-pattern table, then **defaults to `openai`** | 404 only if that provider is not connected |
 *
 * Observed live: `nonexistentprefix/some-model` → *"No active credentials for
 * provider: nonexistentprefix"*; `openai/gpt-5.6-terra` → *"… provider:
 * openai"*; `gpt-5.6-terra` and `totally-unknown-xyzzy-model` → both resolved to
 * `openai`; `claude-sonnet-4` → `anthropic`.
 *
 * ## What follows from them
 *
 * A **prefixed** id cannot be silently misrouted. The prefix is the routing key,
 * used literally, and an unknown one produces an error naming it. A
 * **slash-less** id is the only shape the gateway answers by choosing an
 * upstream itself, and it does so only when it does not recognise the id.
 *
 * So the extension's exposure is exactly one thing: sending a slash-less id
 * that the gateway no longer recognises. It cannot verify afterwards where such
 * a request went — the gateway returns no provider identity in any header or
 * body field, and the `model` it echoes is the bare name with the prefix
 * stripped, which cannot distinguish two upstreams offering the same name. The
 * only available defence is not to send an id that was never offered.
 *
 * This file pins the rules as fixtures so a future change cannot quietly start
 * sending one, and pins the two mechanisms that keep it from happening:
 * `modelSelectionState` at discovery, and `OfferedModels` at selection.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { OfferedModels } from '@/providers/registry/offered-models';
import { modelSelectionState, selectionRefusal } from '@/providers/registry/model-selection';
import { parseModelCatalogue, COMBO_OWNER } from '@/providers/adapters/nine-router-catalog';
import { NineRouterAdapter } from '@/providers/adapters/nine-router';
import { NINE_ROUTER_PROVIDER_ID } from '@/providers/adapters/nine-router-catalog';
import { AuditLog } from '@/audit/audit-log';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import {
  accountAfterOfferedSelection,
  accountAfterSelection,
  type ConnectedAccount,
} from '@/providers/accounts/account-model';
import type { CanonicalRequest } from '@/providers/core/types';
import type { ProviderTransport } from '@/security/egress/provider-transport';

const area = (): SerializedStorageArea => new SerializedStorageArea(new MemoryStorageArea());
const KEY = 'sk-' + 'routing-integrity-00000000000';

/**
 * Id shapes, named by how the gateway resolves them rather than by vendor.
 *
 * Every one of these is a shape, not a real model: nothing in `src/` may know a
 * model name, and case 17 asserts it.
 */
const PREFIXED = 'up/model-one';
const MULTI_SLASH = 'up/team/project/model/v2';
const UNICODE = 'up/modèle-日本語-🙂';
const COMBO = 'my-daily-combo';
const UNKNOWN_SLASHLESS = 'something-nobody-offers';

/** A catalogue in the shape the real gateway returns, including a combination. */
const CATALOGUE = {
  object: 'list',
  data: [
    { id: PREFIXED, object: 'model', owned_by: 'up' },
    { id: MULTI_SLASH, object: 'model', owned_by: 'up' },
    { id: UNICODE, object: 'model', owned_by: 'up' },
    { id: COMBO, object: 'model', owned_by: COMBO_OWNER },
  ],
};
const OFFERED = CATALOGUE.data.map((entry) => entry.id);

function account(modelId: string, over: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    connectionId: 'conn_1',
    abaUserId: 'user_1',
    providerId: NINE_ROUTER_PROVIDER_ID,
    protocol: 'openai-compatible',
    displayName: '9Router',
    accountLabel: 'localhost (key …abcd)',
    authKind: 'api_key',
    baseUrl: 'http://localhost:20128/v1',
    modelId,
    capabilities: null,
    capabilityScope: null,
    status: 'connected',
    lastValidated: null,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

describe('TEST-ROUTING-001 — every id shape survives, and the catalogue is the authority', () => {
  it('01 — all four shapes parse and keep their exact id', () => {
    const { models, refused } = parseModelCatalogue(CATALOGUE);
    expect(refused).toEqual([]);
    expect(models.map((model) => model.id)).toEqual(OFFERED);
  });

  it('02 — a combination is grouped by owned_by, not by the absence of a slash', () => {
    // The gateway declares a combination through `owned_by`. Inferring it from
    // "has no slash" would be reading the id for routing, which is the thing
    // this whole design refuses to do.
    const { models, groups } = parseModelCatalogue(CATALOGUE);
    const combo = models.find((model) => model.id === COMBO)!;
    const comboGroup = groups.find((group) => group.key === combo.upstreamKey)!;
    expect(comboGroup.kind).toBe('combo');
    // And the prefixed ones are a provider group, with the same id intact.
    const prefixed = models.find((model) => model.id === MULTI_SLASH)!;
    expect(groups.find((group) => group.key === prefixed.upstreamKey)!.kind).toBe('provider');
  });

  for (const [label, id] of [
    ['prefixed', PREFIXED],
    ['multi-slash', MULTI_SLASH],
    ['unicode', UNICODE],
    ['combination', COMBO],
  ] as const) {
    it(`03 — an offered ${label} id is valid and nothing is substituted`, () => {
      const state = modelSelectionState(id, OFFERED, true);
      expect(state).toEqual({ kind: 'valid', modelId: id });
      expect(selectionRefusal(state)).toBeNull();
    });
  }

  it('04 — an unknown slash-less id is stale, which is what stops it being sent', () => {
    // The one shape the gateway would resolve by choosing an upstream itself.
    const state = modelSelectionState(UNKNOWN_SLASHLESS, OFFERED, true);
    expect(state.kind).toBe('stale');
    expect(selectionRefusal(state)).toContain(UNKNOWN_SLASHLESS);
  });

  it('05 — an unknown prefixed id is stale too, by the same exact comparison', () => {
    // It would fail loudly at the gateway rather than be misrouted, but the
    // extension does not rely on that: the rule is membership, for every shape.
    expect(modelSelectionState('other/model', OFFERED, true).kind).toBe('stale');
  });

  it('06 — a deleted combination goes stale, and no look-alike is offered instead', () => {
    const afterDeletion = OFFERED.filter((id) => id !== COMBO);
    const state = modelSelectionState(COMBO, afterDeletion, true);
    expect(state.kind).toBe('stale');
    const refusal = selectionRefusal(state)!;
    for (const other of afterDeletion) expect(refusal).not.toContain(other);
  });

  it('07 — a combination that reappears is valid again', () => {
    expect(
      modelSelectionState(
        COMBO,
        OFFERED.filter((id) => id !== COMBO),
        true,
      ).kind,
    ).toBe('stale');
    expect(modelSelectionState(COMBO, OFFERED, true).kind).toBe('valid');
  });
});

describe('TEST-ROUTING-001 — a selection is checked against what was offered', () => {
  it('08 — a model from the catalogue is recognised as offered', () => {
    const offered = new OfferedModels();
    offered.record(NINE_ROUTER_PROVIDER_ID, 'conn_1', OFFERED);
    for (const id of OFFERED) {
      expect(offered.wasOffered(id, NINE_ROUTER_PROVIDER_ID, 'conn_1'), id).toBe('offered');
    }
  });

  it('09 — a hand-typed id that no discovery offered is not-offered', () => {
    // The reachable gap. `SettingsView` falls back to a free-text input when the
    // filtered list is empty — its placeholder is `gpt-4o-mini`, which is
    // slash-less — and `accountAfterSelection` clears the stale marker on the
    // grounds that the user picked from a discovered list. For a typed id that
    // is not true.
    const offered = new OfferedModels();
    offered.record(NINE_ROUTER_PROVIDER_ID, 'conn_1', OFFERED);
    expect(offered.wasOffered(UNKNOWN_SLASHLESS, NINE_ROUTER_PROVIDER_ID, 'conn_1')).toBe(
      'not-offered',
    );
    expect(offered.wasOffered('gpt-4o-mini', NINE_ROUTER_PROVIDER_ID, 'conn_1')).toBe(
      'not-offered',
    );
  });

  it('10 — nothing recorded means unknown, never not-offered', () => {
    // After a service-worker restart there is no entry. Treating that as
    // "never offered" would mark every selection stale on every restart; and
    // an endpoint that has not answered a discovery in this lifetime cannot
    // serve a request either, so asserting nothing is safe.
    const offered = new OfferedModels();
    expect(offered.wasOffered(PREFIXED, NINE_ROUTER_PROVIDER_ID, 'conn_1')).toBe('unknown');
  });

  it('11 — a failed discovery is not recorded as "offers nothing"', () => {
    // A failed discovery returns an empty list through the same path as a
    // provider that genuinely offers none. Recording it would turn "could not
    // ask" into "offers nothing", and then mark every later selection
    // not-offered.
    const offered = new OfferedModels();
    offered.record(NINE_ROUTER_PROVIDER_ID, 'conn_1', []);
    expect(offered.wasOffered(PREFIXED, NINE_ROUTER_PROVIDER_ID, 'conn_1')).toBe('unknown');

    // A later successful discovery does establish it.
    offered.record(NINE_ROUTER_PROVIDER_ID, 'conn_1', OFFERED);
    expect(offered.wasOffered(PREFIXED, NINE_ROUTER_PROVIDER_ID, 'conn_1')).toBe('offered');
  });

  it('12 — catalogues do not leak between connections or providers', () => {
    // Two accounts of one provider can front different gateways, so one
    // gateway's catalogue must never vouch for another's model.
    const offered = new OfferedModels();
    offered.record(NINE_ROUTER_PROVIDER_ID, 'conn_1', OFFERED);
    expect(offered.wasOffered(PREFIXED, NINE_ROUTER_PROVIDER_ID, 'conn_2')).toBe('unknown');
    expect(offered.wasOffered(PREFIXED, 'openai-compatible', 'conn_1')).toBe('offered');
    // (keyed per connection, so the provider argument does not widen it)
    expect(offered.wasOffered(PREFIXED, NINE_ROUTER_PROVIDER_ID)).toBe('unknown');
  });

  it('13 — the pre-account slot is keyed separately from any connection', () => {
    const offered = new OfferedModels();
    offered.record(NINE_ROUTER_PROVIDER_ID, undefined, OFFERED);
    expect(offered.wasOffered(PREFIXED, NINE_ROUTER_PROVIDER_ID)).toBe('offered');
    expect(offered.wasOffered(PREFIXED, NINE_ROUTER_PROVIDER_ID, 'conn_1')).toBe('unknown');
  });

  it('14 — exact comparison only: no shape is special-cased', () => {
    const offered = new OfferedModels();
    offered.record(NINE_ROUTER_PROVIDER_ID, 'conn_1', [PREFIXED]);
    for (const near of [
      `${PREFIXED} `,
      ` ${PREFIXED}`,
      PREFIXED.toUpperCase(),
      'model-one',
      'up//model-one',
      'other/model-one',
    ]) {
      expect(offered.wasOffered(near, NINE_ROUTER_PROVIDER_ID, 'conn_1'), near).toBe('not-offered');
    }
    expect(offered.wasOffered(PREFIXED, NINE_ROUTER_PROVIDER_ID, 'conn_1')).toBe('offered');
  });

  it('15 — selecting an offered model clears the marker; the check is what gates it', () => {
    // `accountAfterSelection` always clears. The route puts the marker back when
    // the verdict is `not-offered`, which is the whole change.
    const stale = { ...account(COMBO), modelStale: true as const };
    const chosen = accountAfterSelection(stale, PREFIXED);
    expect('modelStale' in chosen).toBe(false);
    expect(chosen.modelId).toBe(PREFIXED);
  });

  it('16 — the provenance decides whether the marker is cleared', () => {
    // Behavioural, because the previous version of this case counted
    // `wasOffered(` call sites — and a mutation that computed the verdict and
    // then ignored it kept the count at two and survived the whole suite. The
    // decision is its own function now, so it can be called.
    const stale = { ...account(COMBO), modelStale: true as const };

    // Offered: the marker goes, because the selection is current.
    const offered = accountAfterOfferedSelection(stale, PREFIXED, 'offered');
    expect('modelStale' in offered).toBe(false);
    expect(offered.modelId).toBe(PREFIXED);

    // Not offered: the marker stays, which is what stops the runtime sending
    // an id no discovery produced.
    const typed = accountAfterOfferedSelection(account(PREFIXED), UNKNOWN_SLASHLESS, 'not-offered');
    expect(typed.modelStale).toBe(true);
    expect(typed.modelId).toBe(UNKNOWN_SLASHLESS);

    // Unknown: nothing was established, so nothing is asserted.
    const unknown = accountAfterOfferedSelection(stale, PREFIXED, 'unknown');
    expect('modelStale' in unknown).toBe(false);
  });

  it('17 — both routes are wired to the check, and both discoveries feed it', () => {
    // Which call each route is written with *is* a property of the source, so
    // this one is legitimately a text assertion — unlike the behaviour above.
    // The worker cannot be instantiated here, and this is the house style for
    // checking its wiring.
    const worker = readFileSync('src/background/service-worker.ts', 'utf8');

    // The account route must pass the *measured* verdict, not a literal. A
    // mutation that hardcoded `'offered'` here kept every behavioural case
    // passing, because the decision function was still correct — it was simply
    // never told the truth.
    expect(worker).toMatch(
      /accountAfterOfferedSelection\(\s*grouped,\s*modelId,\s*offeredModels\.wasOffered\(\s*modelId,\s*existing\.providerId,\s*connectionId,?\s*\),?\s*\)/,
    );
    // No route may substitute a literal provenance for the real one.
    expect(worker).not.toMatch(/accountAfterOfferedSelection\([^)]*'(offered|unknown)'/);

    // The slot route consults it too.
    expect(worker).toMatch(/offeredModels\.wasOffered\(modelId, providerId\)/);

    // And both discovery routes feed it, or there would be nothing to consult.
    const records = worker.match(/offeredModels\.record\(/g) ?? [];
    expect(records, 'provider.listModels and accounts.listModels').toHaveLength(2);
  });

  it('18 — the health probe sends the exact selected id, unmodified', async () => {
    // The gap a mutation found: `validateConnection` builds its own body, and
    // nothing asserted the model in it. Truncating a prefixed id there would
    // produce a slash-less one — precisely the shape the gateway resolves by
    // guessing — so a probe could be answered by a different upstream and
    // report the selected model healthy when it is not.
    for (const id of [PREFIXED, MULTI_SLASH, UNICODE, COMBO]) {
      const bodies: string[] = [];
      const transport: ProviderTransport = {
        request: (_url, init) => {
          bodies.push(typeof init.body === 'string' ? init.body : '[non-string body]');
          return Promise.resolve(
            new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        },
      };
      const adapter = new NineRouterAdapter(transport);
      await adapter.connect({
        providerId: NINE_ROUTER_PROVIDER_ID,
        baseUrl: 'http://localhost:20128/v1',
        apiKey: KEY,
        model: id,
      });

      const health = await adapter.validateConnection();
      expect(health.reachable, id).toBe(true);
      const sent = JSON.parse(bodies[0]!) as { model: string };
      expect(sent.model, id).toBe(id);
      expect(bodies[0]).not.toContain(KEY);
    }
  });
});

describe('TEST-ROUTING-001 — the extension holds no opinion about routing', () => {
  it('17 — no provider or model name, and no id parsing, in the routing path', () => {
    for (const file of [
      'src/providers/registry/offered-models.ts',
      'src/providers/registry/model-selection.ts',
    ]) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // No vendor names.
      for (const literal of code.match(/'[^']*'/g) ?? []) {
        expect(
          /^'(openai|anthropic|gemini|google|claude|gpt|grok|kimi|mistral|deepseek|codex)/i.test(
            literal,
          ),
          `${file} names a provider or model: ${literal}`,
        ).toBe(false);
      }
      // And no reading of the id's structure — the gateway's own prefix rule
      // must not be reimplemented here, even to be helpful about it.
      for (const forbidden of ['.split(', '.startsWith(', '.endsWith(', '.indexOf(', '.slice(']) {
        expect(code, `${file} ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('18 — the adapter sends the selected id byte-for-byte, whatever its shape', async () => {
    // What the extension can actually promise: this exact string left the
    // device. Where the gateway took it is the gateway's to answer.
    for (const id of [PREFIXED, MULTI_SLASH, UNICODE, COMBO]) {
      const bodies: string[] = [];
      const transport: ProviderTransport = {
        request: (_url, init) => {
          // Always a serialised string from `buildBody`; narrowed rather than
          // coerced so a future non-string body is a type error here.
          bodies.push(typeof init.body === 'string' ? init.body : '[non-string body]');
          return Promise.resolve(
            new Response(
              // The gateway echoes the *bare* name, prefix stripped — observed
              // live. So the response cannot be compared with the id sent, and
              // case 19 states that limitation rather than papering over it.
              JSON.stringify({ choices: [{ message: { content: 'ok' } }], model: 'bare-name' }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        },
      };
      const adapter = new NineRouterAdapter(transport);
      await adapter.connect({
        providerId: NINE_ROUTER_PROVIDER_ID,
        baseUrl: 'http://localhost:20128/v1',
        apiKey: KEY,
        model: id,
      });
      await adapter.generate({
        systemInstruction: '',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        egress: {
          taskId: 'task_route',
          taintState: { kind: 'KNOWN_UNTAINTED' },
          taintSalt: 'ab'.repeat(32),
          saltEpoch: 1,
          taintSignature: 'routing',
          providerId: NINE_ROUTER_PROVIDER_ID,
          connectionId: 'conn_1',
          modelId: id,
        },
      } as unknown as CanonicalRequest);

      const sent = JSON.parse(bodies[0]!) as { model: string };
      expect(sent.model, id).toBe(id);
      // The credential is in the headers and nowhere in the body.
      expect(bodies[0]).not.toContain(KEY);
    }
  });

  it('19 — the response model is kept as provider-reported data, not as evidence', () => {
    // The adapter does capture what the provider said — `providerMetadata.model`
    // — and that is the right place for it: a field labelled as the provider's
    // own report. What must not happen is anything *concluding* from it.
    //
    // It could not support a conclusion anyway. The gateway echoes the **bare**
    // model name with the prefix stripped (`cx/gpt-5.6-terra` came back as
    // `gpt-5.6-terra`), so comparing it with the selected id fails for every
    // prefixed model; and "fixing" that by stripping the prefix would
    // reimplement the gateway's routing rule inside the extension and still not
    // name the upstream, which is the only thing a reader would want to know.
    const adapter = readFileSync('src/providers/adapters/openai-compatible.ts', 'utf8');
    // Captured, labelled, and handed on untouched.
    expect(adapter).toContain('providerMetadata: { model: completion.model, id: completion.id }');
    // Never compared against the configured model.
    const code = adapter.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // `completion.model === undefined` is the existence check that decides
    // whether to attach the field at all. A comparison with anything *else*
    // would be a conclusion drawn from it, so each one is read rather than
    // pattern-matched — a negative lookahead here backtracks and passes.
    const comparisons = [...code.matchAll(/completion\.model\s*(?:===|!==)\s*([A-Za-z_.$]+)/g)].map(
      (match) => match[1],
    );
    expect(comparisons.filter((operand) => operand !== 'undefined')).toEqual([]);
    expect(code).not.toMatch(/config\.model\s*(?:===|!==)\s*completion/);

    // And nothing anywhere reads it back, so no decision rests on it. If that
    // ever changes, this is the case that should be revisited first — the field
    // is not reliable enough to gate anything on.
    const readers = execSync(
      'grep -rln "providerMetadata" src/ --include=*.ts --include=*.tsx || true',
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter((line) => line.length > 0)
      .filter((line) => !line.includes('providers/adapters/'))
      .filter((line) => !line.includes('providers/core/types.ts'));
    expect(readers, 'something now reads providerMetadata').toEqual([]);
  });

  it('20 — the audit records the id that was sent, and claims nothing more', async () => {
    // The trail says "this is the model id this request carried". It does not
    // say the model ran, and it must not start to: the gateway provides no
    // evidence for that claim.
    const log = new AuditLog(area(), { knownTool: () => true });
    const written = await log.record({
      type: 'egress.decided',
      taskId: 'task_route',
      tool: 'provider.request',
      outcome: 'allowed',
      code: 'PROVIDER_BOUND',
      providerId: NINE_ROUTER_PROVIDER_ID,
      modelId: MULTI_SLASH,
    } as never);
    expect(written?.modelId).toBe(MULTI_SLASH);
    expect(written?.providerId).toBe(NINE_ROUTER_PROVIDER_ID);
    expect(log.degradedReason()).toBeNull();
    // No field asserts an upstream, because none is knowable.
    const serialised = JSON.stringify(written);
    expect(serialised).not.toMatch(/upstream|routedTo|actualModel/i);
  });

  it('21 — a connection that goes away takes its catalogue with it', () => {
    const offered = new OfferedModels();
    offered.record(NINE_ROUTER_PROVIDER_ID, 'conn_1', OFFERED);
    expect(offered.wasOffered(PREFIXED, NINE_ROUTER_PROVIDER_ID, 'conn_1')).toBe('offered');
    offered.forget('conn_1');
    expect(offered.wasOffered(PREFIXED, NINE_ROUTER_PROVIDER_ID, 'conn_1')).toBe('unknown');
  });
});
