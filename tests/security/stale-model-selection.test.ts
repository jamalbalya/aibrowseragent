/**
 * TEST-STALEMODEL-001 — a selection the provider no longer offers is refused,
 * never replaced.
 *
 * ## The condition this is about
 *
 * A model id belongs to the provider, and a provider may stop offering one. A
 * gateway makes that routine rather than rare. 9Router composes its ids as
 * `` `${prefix}/${model}` `` where the prefix is a per-connection field the user
 * can edit, so renaming one connection's alias renames every model under it at
 * once; and a *combination* is named by the user, so deleting one removes an id
 * with no prefix in it at all.
 *
 * ## Why "refuse" and not "repair"
 *
 * The gateway will guess if asked. 9Router resolves an unrecognised slash-less
 * id through a table of name patterns and then falls back to the provider
 * `openai`, so a deleted combination can be answered by an upstream the user
 * never chose — and if the combination's name happened to match a real model
 * there, it answers successfully and nobody is told. This build must not add a
 * second layer of guessing on top of that. The rule is exact equality, and the
 * consequence of failing it is a refusal the user can see.
 *
 * The model ids here are the shapes the user's own gateway actually returns —
 * `cx/…`, and the slash-less combination — so the cases are not hypothetical.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  modelSelectionState,
  selectionRefusal,
  type ModelSelectionState,
} from '@/providers/registry/model-selection';
import {
  accountAfterCatalogue,
  accountAfterSelection,
  type ConnectedAccount,
} from '@/providers/accounts/account-model';
import { connectionForBrain } from '@/providers/accounts/brain-projection';
import { ConsentStore, type ProviderPin } from '@/security/egress/consent';
import { providerDestination } from '@/security/egress/destination';

/** The prefix the user's gateway reports, and ids in its shape. */
const BEFORE = ['cx/gpt-6-astra', 'cx/gpt-5.6-terra', 'cx/gpt-5.4-mini', 'daily-driver-combo'];
/** The same gateway after its connection alias was renamed `cx` → `work`. */
const AFTER_RENAME = ['work/gpt-6-astra', 'work/gpt-5.6-terra', 'work/gpt-5.4-mini'];

function account(modelId: string | null, extra: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    connectionId: 'conn_1',
    abaUserId: 'user_1',
    providerId: 'nine-router',
    protocol: 'openai-compatible',
    displayName: '9Router',
    accountLabel: 'localhost:20128 (key …abcd)',
    authKind: 'api_key',
    baseUrl: 'http://localhost:20128/v1',
    modelId,
    capabilities: null,
    capabilityScope: null,
    status: 'connected',
    lastValidated: null,
    createdAt: 1_700_000_000_000,
    ...extra,
  };
}

/** Read as the routes read it: ids from a catalogue that was actually read. */
function state(selected: string | null, ids: readonly string[]): ModelSelectionState {
  return modelSelectionState(selected, ids, ids.length > 0);
}

describe('TEST-STALEMODEL-001 — the verdict', () => {
  it('A — a selected model that is still offered is valid', () => {
    const verdict = state('cx/gpt-5.6-terra', BEFORE);
    expect(verdict).toEqual({ kind: 'valid', modelId: 'cx/gpt-5.6-terra' });
    expect(selectionRefusal(verdict)).toBeNull();
  });

  it('B — a prefix rename makes the exact id stale, and names no replacement', () => {
    // The same model, by any human reading, is on offer as `work/gpt-5.6-terra`.
    // That is exactly the inference this must not make.
    const verdict = state('cx/gpt-5.6-terra', AFTER_RENAME);
    expect(verdict).toEqual({ kind: 'stale', modelId: 'cx/gpt-5.6-terra' });

    const refusal = selectionRefusal(verdict)!;
    expect(refusal).toContain('cx/gpt-5.6-terra');
    // The refusal must not offer, suggest or name the look-alike.
    for (const candidate of AFTER_RENAME) expect(refusal).not.toContain(candidate);
    expect(refusal).toContain('not be substituted');
  });

  it('C — a deleted model is stale even when a near-identical id exists', () => {
    // One character apart, same prefix, same family. A suffix or
    // longest-common-prefix match would answer with the wrong model.
    const verdict = state('cx/gpt-5.4-mini', ['cx/gpt-5.4-mini-review', 'cx/gpt-5.4']);
    expect(verdict.kind).toBe('stale');
  });

  it('D — a deleted combination is stale, and does not fall back to a provider', () => {
    // The dangerous case. A combination id has no prefix, and the gateway
    // resolves an unrecognised slash-less id by pattern-matching the name and
    // then defaulting to `openai`. If this build forwarded it anyway, the task
    // would run on an upstream nobody selected.
    const verdict = state('daily-driver-combo', AFTER_RENAME);
    expect(verdict).toEqual({ kind: 'stale', modelId: 'daily-driver-combo' });
    expect(selectionRefusal(verdict)).not.toBeNull();
  });

  it('E — an unread catalogue is indeterminate, not stale', () => {
    // A gateway that is down has not withdrawn a model. Treating "could not
    // ask" as "it is gone" would invalidate a correct selection on every
    // restart, and would train the user to re-pick a model that was fine.
    const verdict = modelSelectionState('cx/gpt-5.6-terra', [], false);
    expect(verdict).toEqual({ kind: 'indeterminate', modelId: 'cx/gpt-5.6-terra' });
    expect(selectionRefusal(verdict)).toBeNull();
  });

  it('F — no selection is not an error', () => {
    expect(state(null, BEFORE)).toEqual({ kind: 'none' });
    expect(state('', BEFORE)).toEqual({ kind: 'none' });
    expect(selectionRefusal({ kind: 'none' })).toBeNull();
  });

  it('G — the exact id reappearing makes the selection valid again', () => {
    // Symmetric, and with no stored history: the test is against the live
    // catalogue every time, so a prefix renamed back, or a connection that
    // comes back, needs no repair step.
    const gone = state('cx/gpt-5.6-terra', AFTER_RENAME);
    expect(gone.kind).toBe('stale');
    const back = state('cx/gpt-5.6-terra', BEFORE);
    expect(back).toEqual({ kind: 'valid', modelId: 'cx/gpt-5.6-terra' });
  });

  it('H — nothing about the comparison is fuzzy', () => {
    const offered = ['cx/gpt-5.6-terra'];
    for (const near of [
      'cx/gpt-5.6-terra ', // trailing space
      ' cx/gpt-5.6-terra', // leading space
      'CX/GPT-5.6-TERRA', // case
      'gpt-5.6-terra', // the suffix alone
      'cx/gpt-5.6-terr', // one character short
      'cx//gpt-5.6-terra', // doubled separator
      'work/gpt-5.6-terra', // the renamed twin
    ]) {
      expect(state(near, offered).kind, near).toBe('stale');
    }
    // And the exact one still matches, so the cases above are not passing by
    // the comparison being broken outright.
    expect(state('cx/gpt-5.6-terra', offered).kind).toBe('valid');
  });

  it('I — a multi-slash and a Unicode id compare exactly too', () => {
    for (const id of ['org/team/project/model/v2', 'modèle-日本語-🙂']) {
      expect(state(id, [id]).kind, id).toBe('valid');
      expect(state(id, ['other/model']).kind, id).toBe('stale');
    }
  });
});

describe('TEST-STALEMODEL-001 — the state persists and clears', () => {
  it('01 — a stale verdict is written onto the account', () => {
    const marked = accountAfterCatalogue(account('cx/gpt-5.6-terra'), true);
    expect(marked.modelStale).toBe(true);
    // And the exact id is untouched: the record still says what went missing.
    expect(marked.modelId).toBe('cx/gpt-5.6-terra');
  });

  it('02 — clearing removes the field rather than storing false', () => {
    const marked = accountAfterCatalogue(account('cx/gpt-5.6-terra'), true);
    const cleared = accountAfterCatalogue(marked, false);
    // Presence is the state. A stored `false` and an absent field would be two
    // spellings of the same thing, and the one that got read would decide.
    expect('modelStale' in cleared).toBe(false);
  });

  it('03 — choosing a model clears the marker', () => {
    // The user picked from a list this build had just discovered, so refusing
    // it would refuse a model that is demonstrably on offer.
    const stale = accountAfterCatalogue(account('cx/gpt-5.6-terra'), true);
    const chosen = accountAfterSelection(stale, 'work/gpt-5.6-terra');
    expect('modelStale' in chosen).toBe(false);
    expect(chosen.modelId).toBe('work/gpt-5.6-terra');
  });

  it('04 — the projection carries the marker so the panel can explain it', () => {
    const stale = accountAfterCatalogue(account('cx/gpt-5.6-terra'), true);
    const projected = connectionForBrain(stale);
    expect(projected?.modelStale).toBe(true);
    expect(projected?.modelId).toBe('cx/gpt-5.6-terra');

    // A current selection projects no marker at all.
    const fresh = connectionForBrain(account('cx/gpt-5.6-terra'));
    expect(fresh && 'modelStale' in fresh).toBe(false);
  });

  it('05 — the marker survives a restart, because it is on the stored record', () => {
    // A service-worker restart rebuilds the adapter from stored configuration
    // and discovers nothing. If the verdict were held in memory it would be
    // lost exactly when it matters, and the first task after a restart would
    // run on the stale selection.
    const stored = JSON.parse(
      JSON.stringify(accountAfterCatalogue(account('cx/gpt-5.6-terra'), true)),
    ) as ConnectedAccount;
    expect(stored.modelStale).toBe(true);
    expect(stored.modelId).toBe('cx/gpt-5.6-terra');
  });
});

describe('TEST-STALEMODEL-001 — the runtime cannot run on a stale selection', () => {
  const worker = readFileSync('src/background/service-worker.ts', 'utf8');

  it('06 — both resolve paths refuse before a credential is read', () => {
    // Asserted against the source because the alternative is to boot the
    // worker. What matters is the *order*: the refusal is above the key read,
    // so a stale selection never reaches a request builder at all and nothing
    // downstream has to remember not to substitute.
    const resolveStart = worker.indexOf('async function resolveFromAccount(');
    expect(resolveStart).toBeGreaterThan(-1);
    const resolveBody = worker.slice(resolveStart, worker.indexOf('\n}', resolveStart));
    const refusal = resolveBody.indexOf('account.modelStale === true');
    const keyRead = resolveBody.indexOf('credentialStore.getConnectionKey');
    expect(refusal).toBeGreaterThan(-1);
    expect(keyRead).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(keyRead);

    // The pre-account slot refuses on the same flag.
    expect(worker).toContain('connection.modelStale === true');
  });

  it('07 — only the discovery route may resolve a stale connection', () => {
    // It has to: it is what lets the user choose again. Every other caller
    // must get the refusal, so the escape hatch is one explicit option passed
    // from one place.
    expect(worker).toContain('options.allowStale !== true');
    const allowances = worker.match(/allowStale:\s*true/g) ?? [];
    expect(allowances).toHaveLength(1);
    const at = worker.indexOf('allowStale: true');
    const route = worker.lastIndexOf("router.on('", at);
    expect(worker.slice(route, at)).toContain('accounts.listModels');
  });

  it('08 — nothing in the selection module can choose a model', () => {
    // The rule, asserted against the source. Every repair strategy is a string
    // operation on the id, so the absence of those operations is the property.
    const source = readFileSync('src/providers/registry/model-selection.ts', 'utf8');
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of [
      '.split(',
      '.slice(',
      '.substring(',
      '.replace(',
      '.startsWith(',
      '.endsWith(',
      '.indexOf(',
      '.toLowerCase(',
      '.trim(',
      '.find(',
      '.filter(',
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    // The whole comparison is one exact membership test.
    expect(code).toContain('catalogueIds.includes(selected)');
  });
});

describe('TEST-STALEMODEL-001 — the pin is unchanged by any of this', () => {
  it('09 — a pin is still provider identity, account and the exact model', () => {
    // Stale handling must not alter what binds a task to a destination. Two
    // models at one endpoint are two recipients, and the model id is what says
    // which — so it stays in the pin, byte for byte.
    const identity = providerDestination('nine-router', 'http://localhost:20128/v1').identity ?? '';
    const pin: ProviderPin = {
      identity,
      connectionId: 'conn_1',
      modelId: 'cx/gpt-5.6-terra',
    };
    const consent = new ConsentStore();
    consent.pinProvider('task_1', pin);

    expect(consent.matchesPin('task_1', pin)).toBe(true);
    // The renamed twin is a different recipient.
    expect(consent.matchesPin('task_1', { ...pin, modelId: 'work/gpt-5.6-terra' })).toBe(false);
    // So is the same model on another account.
    expect(consent.matchesPin('task_1', { ...pin, connectionId: 'conn_2' })).toBe(false);
  });
});
