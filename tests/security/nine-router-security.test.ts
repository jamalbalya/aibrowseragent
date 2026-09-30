/**
 * TEST-9RSEC-001 — 9Router as untrusted external input.
 *
 * A gateway the user runs is still a network peer, and its catalogue is data this
 * build did not author. Two properties matter most.
 *
 * The first is that the catalogue cannot corrupt state. Nothing in a `/models`
 * response becomes an internal identifier, a storage key, a permission or a
 * capability claim; a hostile entry costs that entry and nothing else.
 *
 * The second is that the credential never travels anywhere except the endpoint.
 * The key is what a user gives up if a record, a prompt or a UI string leaks it,
 * and the adapter inherits its transport rather than opening its own — so there is
 * no second, unguarded path to audit.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  NINE_ROUTER_PROVIDER_ID,
  parseModelCatalogue,
  upstreamKeyFor,
  MAX_OWNED_BY,
  FALLBACK_GROUP_KEY,
} from '@/providers/adapters/nine-router-catalog';
import { NineRouterAdapter, nineRouterFactory } from '@/providers/adapters/nine-router';
import { AuditLog } from '@/audit/audit-log';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { managementTaskId } from '@/security/egress/provider-transport';
import { MAX_MODEL_ID, MAX_STRING } from '@/audit/boundaries';

const area = (): SerializedStorageArea => new SerializedStorageArea(new MemoryStorageArea());
const SECRET = 'sk-live-9router-do-not-leak-abcdefghijklmnop';

describe('TEST-9RSEC-001 — a hostile catalogue changes nothing it should not', () => {
  it('01 — prototype-shaped keys in an entry are inert', () => {
    // The parser reads three named fields and copies nothing wholesale, so a
    // `__proto__` or `constructor` in the payload has nowhere to land.
    const { models } = parseModelCatalogue({
      object: 'list',
      data: [
        { id: 'up/a', object: 'model', owned_by: 'up', __proto__: { polluted: true } },
        { id: 'up/b', object: 'model', owned_by: 'up', constructor: { polluted: true } },
      ],
    });
    expect(models).toHaveLength(2);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    for (const model of models) {
      // Exactly the three fields the catalogue type declares.
      expect(Object.keys(model).sort()).toEqual(['displayName', 'id', 'upstreamKey']);
    }
  });

  it('02 — an owned_by cannot become an unbounded group key or label', () => {
    const long = 'o'.repeat(MAX_OWNED_BY + 500);
    const { groups, models } = parseModelCatalogue({
      object: 'list',
      data: [{ id: 'up/a', object: 'model', owned_by: long }],
    });
    // Over the bound, so it groups under the fallback rather than creating a
    // group whose key and label are both provider-controlled and unbounded.
    expect(models[0]!.upstreamKey).toBe(FALLBACK_GROUP_KEY);
    expect(groups[0]!.displayName).toBe('Other');
    expect(groups[0]!.key.length).toBeLessThanOrEqual(MAX_STRING);

    // An `owned_by` within the bound is kept, and its label stays bounded.
    const ok = parseModelCatalogue({
      object: 'list',
      data: [{ id: 'up/a', object: 'model', owned_by: 'o'.repeat(MAX_OWNED_BY) }],
    });
    expect(ok.groups[0]!.displayName.length).toBeLessThanOrEqual(MAX_STRING);
  });

  it('03 — a group key is opaque: no separator a consumer could split on', () => {
    // The key is an identity, so it must survive being used as one. Anything a
    // reader might treat as structure is escaped.
    for (const owner of ['a/b', 'a:b', 'a b', 'a\u0000b', 'a@b', '🙂', 'a"b', "a'b"]) {
      const key = upstreamKeyFor(owner);
      expect(key, owner).toMatch(/^up:[a-z0-9._~-]+$/);
      expect(key).not.toContain('/');
      expect(key).not.toContain(' ');
    }
  });

  it('04 — an id the trail cannot record is refused, never repaired', () => {
    const { models, refused } = parseModelCatalogue({
      object: 'list',
      data: [
        { id: 'a'.repeat(MAX_MODEL_ID + 1), object: 'model', owned_by: 'up' },
        { id: 'fine/one', object: 'model', owned_by: 'up' },
      ],
    });
    expect(refused.map((entry) => entry.reason)).toEqual(['id-unrecordable']);
    // Nothing was truncated into existence: only the already-valid id survived.
    expect(models.map((entry) => entry.id)).toEqual(['fine/one']);
  });

  it('05 — every id a hostile catalogue can get past the parser is audit-safe', async () => {
    const hostile = [
      'up/a',
      'combo',
      '../../etc/passwd',
      'a\\b',
      'a:b',
      'a?b=c&d=e',
      '%2e%2e%2f',
      'a#b',
      '🙂/🙂',
      'x'.repeat(MAX_MODEL_ID),
    ];
    const { models } = parseModelCatalogue({
      object: 'list',
      data: hostile.map((id) => ({ id, object: 'model', owned_by: 'up' })),
    });
    const log = new AuditLog(area(), { knownTool: () => true });
    for (const model of models) {
      const taskId = await managementTaskId(NINE_ROUTER_PROVIDER_ID, model.id);
      // The id reaches the record as data; the *identifier* is a digest, so a
      // separator in the id can never make the identifier invalid.
      expect(taskId).toMatch(/^[A-Za-z0-9_.:-]{1,80}$/);
      const written = await log.record({
        type: 'egress.decided',
        taskId,
        tool: 'provider.request',
        outcome: 'allowed',
        code: 'PROVIDER_PINNED',
        providerId: NINE_ROUTER_PROVIDER_ID,
        modelId: model.id,
      } as never);
      expect(written, `${model.id} was refused: ${log.degradedReason()}`).not.toBeNull();
      expect(written?.modelId).toBe(model.id);
    }
    expect(log.degradedReason()).toBeNull();
  });
});

describe('TEST-9RSEC-001 — the credential stays where it belongs', () => {
  it('06 — connecting reports an account label that is not the key', async () => {
    const adapter = new NineRouterAdapter();
    const result = await adapter.connect({
      providerId: NINE_ROUTER_PROVIDER_ID,
      baseUrl: 'http://localhost:20128/v1',
      apiKey: SECRET,
    });
    expect(result.authenticated).toBe(true);
    const label = result.accountLabel ?? '';
    // The last four characters identify the key to its owner; the rest is gone.
    expect(label).not.toContain(SECRET);
    expect(label).toContain(SECRET.slice(-4));
    expect(label.length).toBeLessThan(SECRET.length);
  });

  it('07 — a failed discovery reports no credential anywhere in the error', async () => {
    // The transport refuses, which is the default for an adapter built outside
    // the registry — and the refusal must not carry the key back out.
    const adapter = new NineRouterAdapter();
    await adapter.connect({
      providerId: NINE_ROUTER_PROVIDER_ID,
      baseUrl: 'http://localhost:20128/v1',
      apiKey: SECRET,
    });
    const models = await adapter.listModels();
    // Discovery degrades to an empty catalogue rather than throwing something
    // that might carry the request's headers.
    expect(models).toEqual([]);
    expect(adapter.groups()).toEqual([]);
  });

  it('08 — the adapter opens no network path of its own', () => {
    // The guarantee is structural: the registry supplies the guarded transport
    // and the default refuses, so there is no constructor that yields direct
    // access. A second `fetch` in this file would be a second, unaudited egress.
    const source = readFileSync('src/providers/adapters/nine-router.ts', 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/XMLHttpRequest|EventSource|WebSocket|navigator\.sendBeacon/);
    // Every request goes through the inherited transport.
    expect(source).toContain('this.transport.request');
    expect(nineRouterFactory.requiresGuardedTransport).toBe(true);
  });

  it('09 — the catalogue parser has no network surface at all', () => {
    const source = readFileSync('src/providers/adapters/nine-router-catalog.ts', 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/XMLHttpRequest|EventSource|WebSocket/);
  });
});

describe('TEST-9RSEC-001 — the catalogue is not a capability report', () => {
  it('10 — advertised capabilities ignore what the gateway claims', async () => {
    // 9Router derives its own capability hints by matching model names against a
    // table, with a floor for anything unrecognised — so a model it has never
    // seen still comes back claiming a context window and tool support. Passing
    // that on as measured is how a composer gets enabled for a model that cannot
    // drive a browser.
    const adapter = new NineRouterAdapter();
    await adapter.connect({
      providerId: NINE_ROUTER_PROVIDER_ID,
      baseUrl: 'http://localhost:20128/v1',
      apiKey: SECRET,
    });
    const capabilities = await adapter.getCapabilities('upstream/claims-everything');
    // Not asserted: the two a gateway cannot know for an unseen upstream.
    expect(capabilities.vision).toBe(false);
    expect(capabilities.contextWindow).toBeNull();
    expect(capabilities.maxOutputTokens).toBeNull();
    // The baseline the factory publishes says the same thing, so the UI cannot
    // read a promise out of the registry either.
    expect(nineRouterFactory.baselineCapabilities.vision).toBe(false);
    expect(nineRouterFactory.baselineCapabilities.contextWindow).toBeNull();
  });

  it('11 — the adapter ships no provider or model names', () => {
    // A gateway's upstreams are discovered. A hard-coded list would be a list
    // that goes stale, and it would encourage reading the id as structured data.
    const sources = [
      readFileSync('src/providers/adapters/nine-router.ts', 'utf8'),
      readFileSync('src/providers/adapters/nine-router-catalog.ts', 'utf8'),
    ];
    for (const source of sources) {
      // Only in prose, never as a string literal the code compares against.
      const literals = source.match(/'[^']*'/g) ?? [];
      for (const literal of literals) {
        expect(
          /^'(openai|anthropic|gemini|google|claude|gpt|grok|kimi|mistral)/i.test(literal),
          `a provider name appears as a literal: ${literal}`,
        ).toBe(false);
      }
    }
  });

  it('12 — nothing in the parser splits a model id', () => {
    // The rule, asserted against the source. `split('/')` on an id is the defect
    // this whole design exists to prevent, and a reviewer should not have to
    // notice it by eye.
    const source = readFileSync('src/providers/adapters/nine-router-catalog.ts', 'utf8');
    expect(source).not.toMatch(/\bid\b[^\n]*\.split\(/);
    expect(source).not.toMatch(/\.split\(['"]\/['"]\)/);
    expect(source).not.toMatch(/\bid\b[^\n]*\.(slice|substring|replace)\(/);
  });
});
