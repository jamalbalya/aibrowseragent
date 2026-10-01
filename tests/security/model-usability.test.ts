/**
 * TEST-USABILITY-001 — discovered is not the same as usable.
 *
 * ## The condition
 *
 * A gateway's `/v1/models` is the union of what its upstreams *name*. Whether
 * the connected account may actually run a given one is a separate question,
 * answered by the upstream at request time and by nothing else. Measured
 * against a real 9Router fronting a ChatGPT account: of 35 listed models,
 * several answer `"… is not supported when using Codex with a ChatGPT
 * account"` and one answers 503.
 *
 * So a model can be listed, selectable, and still not run — and that is not the
 * stale case, because the model *is* in the catalogue. It is a different fact
 * and it needs a different answer.
 *
 * ## Why there is no new state machine here
 *
 * Because the architecture already had one. `CapabilityDoctor` measures one
 * exact (connection, model) pair and returns a readiness; `capabilityScope`
 * records which pair the measurement belongs to; `lastValidated` records that
 * one was taken; `status` and `statusReason` record what it concluded. Five
 * conditions are already distinguishable from those four fields, with no model
 * names anywhere and no probing of models nobody selected:
 *
 * | condition                     | capabilityScope | lastValidated | status      |
 * | ----------------------------- | --------------- | ------------- | ----------- |
 * | discovered, never validated   | null            | null          | connected   |
 * | validated and usable          | matches         | set           | connected   |
 * | validated, account not entitled | matches       | set           | failed      |
 * | validated, temporarily failing  | matches       | set           | failed (+reason) |
 * | no longer offered (stale)     | —               | —             | `modelStale` |
 *
 * What was actually wrong was narrower than it looked, and it is what this file
 * guards: the verdict was written by a per-model measurement and then left
 * behind when that measurement was discarded, so a model the account cannot use
 * left the whole connection reading `failed` after the user had switched to one
 * that works. And the reason was never stored at all, so "rejected" and
 * "temporarily unavailable" — which send the user to different actions — both
 * reduced to `failed`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  accountAfterCatalogue,
  accountAfterSelection,
  capabilitiesApplyTo,
  type ConnectedAccount,
} from '@/providers/accounts/account-model';
import { connectionForBrain } from '@/providers/accounts/brain-projection';
import { modelSelectionState, selectionRefusal } from '@/providers/registry/model-selection';
import { UNKNOWN_CAPABILITIES, type ModelCapabilities } from '@/providers/core/types';
import { doctorVerdict } from '@/providers/capability-doctor/doctor-verdict';
import { discoverCatalogue } from '@/providers/registry/discovery';

/**
 * Model ids in the shapes a gateway produces.
 *
 * Shapes, not a list of real models: nothing in `src/` may know these names,
 * and case 09 asserts that. `LISTED`/`MISSING` is the only distinction the
 * build is allowed to make, and it makes it by comparing against a live
 * catalogue.
 */
const USABLE = 'up/model-that-runs';
const UNENTITLED = 'up/model-the-account-cannot-use';
const FLAKY = 'up/model-that-is-briefly-down';
const CATALOGUE = [USABLE, UNENTITLED, FLAKY];

/** The doctor's wording for the two failures, as the real service produced them. */
const REJECTED = 'The provider rejected the request.';
const TEMPORARY = 'The provider reported a server error. This is usually temporary.';

const MEASURED: ModelCapabilities = {
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

function account(over: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    connectionId: 'conn_1',
    abaUserId: 'user_1',
    providerId: 'nine-router',
    protocol: 'openai-compatible',
    displayName: '9Router',
    accountLabel: 'localhost (key …abcd)',
    authKind: 'api_key',
    baseUrl: 'http://localhost:20128/v1',
    modelId: USABLE,
    capabilities: null,
    capabilityScope: null,
    status: 'connected',
    lastValidated: null,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

/** An account as `runDoctor` leaves it after measuring `modelId`. */
function afterDoctor(
  modelId: string,
  verdict: { status: ConnectedAccount['status']; statusReason?: string },
  capabilities: ModelCapabilities,
): ConnectedAccount {
  return account({
    modelId,
    capabilities,
    capabilityScope: { connectionId: 'conn_1', modelId },
    lastValidated: 1_700_000_100_000,
    ...verdict,
  });
}

describe('TEST-USABILITY-001 — the five conditions are distinguishable', () => {
  it('01 — discovered but never validated claims nothing', () => {
    // In the catalogue, selectable, and no measurement exists. The connection
    // is fine; the model is simply unproven. This must not read as a failure.
    const fresh = account({ modelId: USABLE });
    expect(modelSelectionState(USABLE, CATALOGUE, true).kind).toBe('valid');
    expect(fresh.capabilityScope).toBeNull();
    expect(fresh.lastValidated).toBeNull();
    expect(fresh.status).toBe('connected');
    expect(capabilitiesApplyTo(fresh, 'conn_1', USABLE)).toBe(false);
    expect('statusReason' in fresh).toBe(false);
  });

  it('02 — validated and usable carries a measurement for that exact pair', () => {
    const healthy = afterDoctor(USABLE, { status: 'connected' }, MEASURED);
    expect(healthy.status).toBe('connected');
    expect('statusReason' in healthy).toBe(false);
    expect(capabilitiesApplyTo(healthy, 'conn_1', USABLE)).toBe(true);
    // And the measurement does not answer for any other model.
    expect(capabilitiesApplyTo(healthy, 'conn_1', UNENTITLED)).toBe(false);
  });

  it('03 — discovered but the account is not entitled: listed, measured, failed', () => {
    // The distinguishing shape. The model is still in the catalogue — so not
    // stale — and a measurement exists for this exact pair saying it failed.
    const unusable = afterDoctor(
      UNENTITLED,
      { status: 'failed', statusReason: REJECTED },
      UNKNOWN_CAPABILITIES,
    );

    expect(modelSelectionState(UNENTITLED, CATALOGUE, true).kind).toBe('valid');
    expect(unusable.modelStale).toBeUndefined();
    expect(unusable.lastValidated).not.toBeNull();
    expect(unusable.capabilityScope).toEqual({ connectionId: 'conn_1', modelId: UNENTITLED });
    expect(unusable.status).toBe('failed');
    // The real reason survives the report being discarded.
    expect(unusable.statusReason).toBe(REJECTED);
    // Nothing was demonstrated, so nothing is claimed.
    expect(unusable.capabilities?.text).toBe(false);
    expect(unusable.capabilities?.unverified).toEqual(UNKNOWN_CAPABILITIES.unverified);
  });

  it('04 — temporarily failing is stored as its own reason, not as the same thing', () => {
    // Both are `failed`, and the two reasons send the user to different
    // actions: pick another model, or try again later. Storing only the status
    // collapsed them.
    const flaky = afterDoctor(
      FLAKY,
      { status: 'failed', statusReason: TEMPORARY },
      UNKNOWN_CAPABILITIES,
    );
    const unusable = afterDoctor(
      UNENTITLED,
      { status: 'failed', statusReason: REJECTED },
      UNKNOWN_CAPABILITIES,
    );

    expect(flaky.status).toBe(unusable.status);
    expect(flaky.statusReason).not.toBe(unusable.statusReason);
    expect(flaky.statusReason).toMatch(/temporary/i);
    expect(unusable.statusReason).not.toMatch(/temporary/i);
  });

  it('05 — no longer offered is the stale case, and it is a different field', () => {
    // The one condition that is *not* about a measurement: the model is gone
    // from the catalogue, so there is nothing to measure.
    const gone = modelSelectionState(USABLE, [UNENTITLED, FLAKY], true);
    expect(gone.kind).toBe('stale');
    expect(selectionRefusal(gone)).not.toBeNull();

    const marked = accountAfterCatalogue(account({ modelId: USABLE }), true);
    expect(marked.modelStale).toBe(true);
    // Stale is not a doctor verdict: no measurement was taken or discarded.
    expect(marked.lastValidated).toBeNull();
    expect(marked.status).toBe('connected');
  });

  it('06 — a model that reappears is valid again, with no measurement invented', () => {
    const back = accountAfterCatalogue(
      accountAfterCatalogue(account({ modelId: USABLE }), true),
      false,
    );
    expect('modelStale' in back).toBe(false);
    expect(modelSelectionState(USABLE, CATALOGUE, true).kind).toBe('valid');
    // Reappearing does not mean proven: it is condition 01 again.
    expect(back.capabilityScope).toBeNull();
    expect(back.lastValidated).toBeNull();
  });
});

describe('TEST-USABILITY-001 — a verdict does not outlive its measurement', () => {
  it('07 — switching away from an unusable model clears its verdict', () => {
    // The defect. The measurement was correctly discarded and its conclusion
    // was not, so the connection kept reading `failed` — with the previous
    // model's reason attached — for a model that works.
    const unusable = afterDoctor(
      UNENTITLED,
      { status: 'failed', statusReason: REJECTED },
      UNKNOWN_CAPABILITIES,
    );
    const switched = accountAfterSelection(unusable, USABLE);

    expect(switched.modelId).toBe(USABLE);
    // Configured, not yet validated — the same words `connectionAfterSwitch`
    // has always used for the pre-account slot.
    expect(switched.status).toBe('connected');
    expect('statusReason' in switched).toBe(false);
    expect(switched.capabilityScope).toBeNull();
    expect(switched.lastValidated).toBeNull();
    expect(switched.capabilities).toBeNull();
  });

  it('08 — a verdict that still applies is kept', () => {
    // Re-selecting the model the measurement was taken on changes nothing, so
    // the verdict and its reason stay. Clearing here would discard a real
    // measurement for no reason.
    const unusable = afterDoctor(
      UNENTITLED,
      { status: 'failed', statusReason: REJECTED },
      UNKNOWN_CAPABILITIES,
    );
    const same = accountAfterSelection(unusable, UNENTITLED);
    expect(same.status).toBe('failed');
    expect(same.statusReason).toBe(REJECTED);
    expect(same.capabilityScope).toEqual({ connectionId: 'conn_1', modelId: UNENTITLED });
    expect(same.lastValidated).not.toBeNull();
  });

  it('09 — a rejected credential is not cleared by choosing another model', () => {
    // The one status that is about the account rather than the model. No choice
    // of model makes a revoked key work, so `disconnected` and its reason
    // survive a switch.
    const dead = account({
      modelId: UNENTITLED,
      status: 'disconnected',
      statusReason: 'This connection needs its API key reconnected on this device.',
    });
    const switched = accountAfterSelection(dead, USABLE);
    expect(switched.status).toBe('disconnected');
    expect(switched.statusReason).toContain('reconnected');
  });

  it('10 — the projection shows the verdict the account actually holds', () => {
    const unusable = afterDoctor(
      UNENTITLED,
      { status: 'failed', statusReason: REJECTED },
      UNKNOWN_CAPABILITIES,
    );
    // A failed measurement projects no capabilities — `capabilityScope` matches,
    // but there is nothing in it to claim.
    const projected = connectionForBrain(unusable);
    expect(projected?.modelId).toBe(UNENTITLED);
    expect(projected?.capabilities?.text ?? false).toBe(false);

    // And after switching, the projection follows the cleared verdict.
    const switched = connectionForBrain(accountAfterSelection(unusable, USABLE));
    expect(switched?.modelId).toBe(USABLE);
    expect(switched?.capabilities).toBeUndefined();
  });
});

describe('TEST-USABILITY-001 — nothing is hardcoded and nothing is probed uninvited', () => {
  it('11 — no provider or model name appears in the usability path', () => {
    // The rule this whole design exists to keep. Availability is measured, not
    // recognised: a blacklist, an allowlist or a name pattern would all be a
    // list that goes stale, and the real catalogue changed three times during
    // one afternoon of work.
    // The *protocol* vocabulary is exempt, and the exemption is the point of
    // the distinction `account-model.ts` draws in its own comment: DeepSeek,
    // Groq, Together and a local llama.cpp all speak `openai-compatible`, so a
    // protocol is a wire format this build implements, declared once and
    // closed. A **vendor** or a **model** name would be different — a list that
    // goes stale, and the real catalogue changed three times during one
    // afternoon of this work.
    const PROTOCOL_VOCABULARY = new Set(["'openai-compatible'", "'anthropic'", "'gemini'"]);
    for (const file of [
      'src/providers/registry/model-selection.ts',
      'src/providers/accounts/account-model.ts',
      'src/providers/registry/discovery.ts',
    ]) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const literal of code.match(/'[^']*'/g) ?? []) {
        if (PROTOCOL_VOCABULARY.has(literal)) continue;
        expect(
          /^'(openai|anthropic|gemini|google|claude|gpt|grok|kimi|mistral|deepseek|codex|cx\/|up\/)/i.test(
            literal,
          ),
          `${file} names a provider or model: ${literal}`,
        ).toBe(false);
      }
      // And no availability heuristic on the id itself.
      expect(code, file).not.toMatch(/\bmodelId\b[^\n]*\.(includes|startsWith|endsWith|match)\(/);
    }

    // The exemption is narrow: those three literals exist only as the protocol
    // enumeration, not as availability knowledge about a vendor.
    const accountModel = readFileSync('src/providers/accounts/account-model.ts', 'utf8');
    expect(accountModel).toContain(
      "export const PROTOCOLS = ['openai-compatible', 'anthropic', 'gemini'] as const;",
    );
    for (const literal of PROTOCOL_VOCABULARY) {
      const occurrences = accountModel.split(literal).length - 1;
      expect(occurrences, `${literal} appears only in the PROTOCOLS list`).toBe(1);
    }
  });

  it('12 — discovery probes nothing: it lists, records, and returns', () => {
    // Requirement that availability must not be established by calling every
    // model. A gateway in front of four upstreams would turn one panel refresh
    // into dozens of billed completions, and the credential would be spent to
    // populate a UI.
    const code = readFileSync('src/providers/registry/discovery.ts', 'utf8')
      .replace(/\/\*\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('adapter.listModels()');
    // No generation, no validation, no per-model loop that could reach the
    // network.
    expect(code).not.toContain('generate(');
    expect(code).not.toContain('validateConnection(');
    expect(code).not.toContain('getCapabilities(');
  });

  it('13 — a failed catalogue read never removes models from the real catalogue', () => {
    // Nothing filters the listed set by usability. The panel shows what the
    // gateway offers; the verdict is attached to the selection, not used to
    // shorten the list.
    const code = readFileSync('src/providers/registry/discovery.ts', 'utf8');
    expect(code).not.toMatch(/\.filter\([^)]*usable/i);
    expect(code).not.toMatch(/\.filter\([^)]*status/i);
  });

  it('14 — both doctor routes store the verdict through one mapping', () => {
    // Two copies of the readiness-to-status mapping is how the account route
    // and the slot route came to disagree about whether a reason is kept.
    const worker = readFileSync('src/background/service-worker.ts', 'utf8');
    const uses = worker.match(/\.\.\.doctorVerdict\(report\)/g) ?? [];
    expect(uses, 'both runDoctor routes use the shared mapping').toHaveLength(2);
    // And the inline mapping they used to carry is gone.
    expect(worker).not.toMatch(/report\.readiness === 'AGENT_READY'\s*\n?\s*\?\s*'connected'/);
  });
});

describe('TEST-USABILITY-001 — the verdict mapping itself', () => {
  // These exist because a source-text assertion is not a test of behaviour. A
  // mutation that mapped *every* readiness to `connected` — so a model the
  // account cannot use would read as fine — survived the whole suite, because
  // the mapping was private to the service worker and nothing could call it.
  // It is its own module now, and these call it.

  it('15 — only AGENT_READY is connected, and it carries no reason', () => {
    expect(doctorVerdict({ readiness: 'AGENT_READY', summary: 'all good' })).toEqual({
      status: 'connected',
    });
    // Not `{ status: 'connected', statusReason: 'all good' }`: a healthy run
    // must leave nothing behind for a later reader to show as a problem.
    expect('statusReason' in doctorVerdict({ readiness: 'AGENT_READY', summary: 'all good' })).toBe(
      false,
    );
  });

  it('16 — FAILED is failed, and the reason is kept verbatim', () => {
    expect(doctorVerdict({ readiness: 'FAILED', summary: REJECTED })).toEqual({
      status: 'failed',
      statusReason: REJECTED,
    });
    expect(doctorVerdict({ readiness: 'FAILED', summary: TEMPORARY })).toEqual({
      status: 'failed',
      statusReason: TEMPORARY,
    });
  });

  it('17 — the partial readinesses are limited, not connected and not failed', () => {
    for (const readiness of ['CONNECTED_LIMITED', 'CHAT_ONLY']) {
      const verdict = doctorVerdict({ readiness, summary: 'some of it worked' });
      expect(verdict.status, readiness).toBe('limited');
      expect(verdict.statusReason, readiness).toBe('some of it worked');
    }
  });

  it('18 — an unrecognised readiness is a limitation, never success', () => {
    // Defaulting to `connected` would turn a readiness this build does not
    // understand into a claim that the model is fine.
    const verdict = doctorVerdict({ readiness: 'SOMETHING_NEW', summary: 'x' });
    expect(verdict.status).toBe('limited');
  });

  it('19 — an empty summary produces no reason field at all', () => {
    for (const summary of ['', '   ', '\n\t']) {
      const verdict = doctorVerdict({ readiness: 'FAILED', summary });
      expect(verdict.status).toBe('failed');
      expect('statusReason' in verdict, JSON.stringify(summary)).toBe(false);
    }
  });

  it('20 — a healthy run drops a reason the record was already carrying', () => {
    // The route spreads the verdict over the stored record, so a healthy
    // verdict that merely *omitted* the reason would leave the previous
    // failure's wording attached to a model that now works. The route drops it
    // first; this is the assertion that the route still does.
    const worker = readFileSync('src/background/service-worker.ts', 'utf8');
    const accountRoute = worker.slice(
      worker.indexOf("router.on('accounts.runDoctor'"),
      worker.indexOf("router.on('accounts.setBrain'"),
    );
    expect(accountRoute).toContain('statusReason: _previous');
    const dropAt = accountRoute.indexOf('statusReason: _previous');
    const spreadAt = accountRoute.indexOf('...doctorVerdict(report)');
    expect(dropAt).toBeGreaterThan(-1);
    expect(spreadAt).toBeGreaterThan(dropAt);
  });

  it('21 — discovery returns exactly what the adapter listed', async () => {
    // Behavioural, because the source-text guard was evadable: a mutation that
    // added `.filter(...)` with a parenthesis inside the predicate slipped past
    // the regex. Nothing may shorten the list the user chooses from — a model
    // being unusable is attached to the selection, not used to hide it.
    const ids = [
      'up/plain',
      'up/has-status-in-the-name',
      'up/usable-looking',
      'combo-with-no-slash',
      'up/deep/multi/segment',
      'up/modèle-日本語-🙂',
    ];
    const adapter = {
      id: 'openai-compatible',
      listModels: () => Promise.resolve(ids.map((id) => ({ id, displayName: id }))),
    } as unknown as Parameters<typeof discoverCatalogue>[0];

    const recorded: number[] = [];
    const catalogue = await discoverCatalogue(adapter, 'openai-compatible', (_p, n) => {
      recorded.push(n);
      return Promise.resolve();
    });

    expect(catalogue.models.map((model) => model.id)).toEqual(ids);
    expect(recorded).toEqual([ids.length]);
  });
});
