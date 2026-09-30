/**
 * TEST-9RCAT-001 — the 9Router catalogue parser.
 *
 * The catalogue is untrusted external data and the model id inside it is the one
 * value that has to come out byte-for-byte. Those two facts are most of this
 * file: hostile entries are refused per entry without costing the rest, and every
 * id that survives is identical to the one the gateway offered.
 *
 * The hierarchy comes from `owned_by`. Splitting the id on `/` would look like it
 * produced the same answer, and the cases below are the reasons it does not: a
 * combination has no prefix, an alias can be renamed so a prefix disagrees with
 * `owned_by`, and two upstreams can share a display label.
 */
import { describe, expect, it } from 'vitest';
import {
  COMBO_OWNER,
  FALLBACK_GROUP_KEY,
  MAX_OWNED_BY,
  NINE_ROUTER_DEFAULT_BASE_URL,
  parseModelCatalogue,
  upstreamKeyFor,
} from '@/providers/adapters/nine-router-catalog';
import { MAX_MODEL_ID } from '@/audit/boundaries';

/** A catalogue body in the shape the gateway returns. */
function body(...data: unknown[]): unknown {
  return { object: 'list', data };
}

const model = (id: string, owned_by?: unknown): unknown => ({
  id,
  object: 'model',
  ...(owned_by === undefined ? {} : { owned_by }),
});

describe('TEST-9RCAT-001 — the exact model id survives', () => {
  it('01 — an id containing a slash is kept whole', () => {
    const { models } = parseModelCatalogue(body(model('openai/gpt-5.x', 'openai')));
    expect(models).toHaveLength(1);
    // The whole point. Not `gpt-5.x`, not `openai_gpt-5.x`, not trimmed.
    expect(models[0]!.id).toBe('openai/gpt-5.x');
    expect(models[0]!.displayName).toBe('openai/gpt-5.x');
  });

  it('02 — ids of every shape come back identical', () => {
    const ids = [
      'openai/gpt-5.x',
      'anthropic/claude-x',
      'google/gemini-x',
      'vendor/model-name',
      'org/team/project/model/v2',
      'combo-name',
      'cx/gpt-5.6-terra',
      'modèle-日本語-🙂',
      'model with spaces',
      'model@v1(beta)!#?&=',
      'a',
      'A/B',
      'x'.repeat(MAX_MODEL_ID),
    ];
    const { models, refused } = parseModelCatalogue(body(...ids.map((id) => model(id, 'up'))));
    expect(refused).toEqual([]);
    expect(models.map((entry) => entry.id)).toEqual(ids);
  });

  it('03 — a model id one character past the recordable bound is refused, not truncated', () => {
    // The one bound that refuses rather than degrades: a model whose id cannot be
    // named in an audit record cannot be run with a trail. The boundary contract
    // owns that limit, and the parser does not invent a shorter one.
    const { models, refused } = parseModelCatalogue(
      body(model('y'.repeat(MAX_MODEL_ID + 1), 'up'), model('kept', 'up')),
    );
    expect(refused).toEqual([{ reason: 'id-unrecordable', at: 0 }]);
    // Refused, and nothing shortened: the surviving entry is the other one.
    expect(models.map((entry) => entry.id)).toEqual(['kept']);
  });
});

describe('TEST-9RCAT-001 — the hierarchy comes from owned_by', () => {
  it('04 — models group by owned_by, not by the id prefix', () => {
    // The id prefix and `owned_by` deliberately disagree here, which is what a
    // renamed connection alias looks like. `owned_by` wins.
    const { models, groups } = parseModelCatalogue(
      body(model('openai/gpt-5.x', 'work-openai'), model('openai/gpt-4o', 'work-openai')),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ownedBy).toBe('work-openai');
    expect(groups[0]!.modelCount).toBe(2);
    expect(new Set(models.map((entry) => entry.upstreamKey))).toEqual(new Set([groups[0]!.key]));
    // And the ids are untouched by the disagreement.
    expect(models.map((entry) => entry.id)).toEqual(['openai/gpt-5.x', 'openai/gpt-4o']);
  });

  it('05 — two upstreams stay two, even with the same label', () => {
    // A label is for reading. If the label were the identity these would merge,
    // and a request would go to whichever won.
    const { groups, models } = parseModelCatalogue(
      body(model('a/one', 'openai'), model('b/two', 'OpenAI')),
    );
    // Case-folded, so these two *are* one upstream — which is the intended
    // behaviour and is asserted rather than assumed.
    expect(groups).toHaveLength(1);

    const distinct = parseModelCatalogue(
      body(model('a/one', 'openai-eu'), model('b/two', 'openai-us')),
    );
    expect(distinct.groups).toHaveLength(2);
    expect(new Set(distinct.groups.map((group) => group.key)).size).toBe(2);
    expect(models).toHaveLength(2);
  });

  it('06 — different owners never collide on one key', () => {
    // The key is derived, so it has to be injective: `a.b` and `a-b` and `a b`
    // are three upstreams, not one.
    const owners = ['a.b', 'a-b', 'a b', 'a/b', 'a_b', 'a~b', 'ab', 'A.B'];
    const keys = owners.map(upstreamKeyFor);
    // `A.B` folds onto `a.b`, so one duplicate is expected and the rest are not.
    expect(new Set(keys).size).toBe(owners.length - 1);
    // And no derived key can be mistaken for the fallback.
    expect(keys).not.toContain(FALLBACK_GROUP_KEY);
  });

  it('06b — a provider whose alias equals a category label is still its own group', () => {
    // The concrete collision the key/label split exists for. An upstream aliased
    // `Combinations` produces the same *label* as the combo category, so a UI or
    // a store that keyed on the label would merge the two and send a request to
    // whichever won. They are two groups.
    const { groups, models } = parseModelCatalogue(
      body(model('my-combo', COMBO_OWNER), model('up/a', 'Combinations'), model('up/b', 'Other')),
    );
    expect(groups).toHaveLength(3);
    // Two of them read the same to a person...
    const labels = groups.map((group) => group.displayName);
    expect(labels.filter((label) => label === 'Combinations')).toHaveLength(2);
    // ...and none of them share an identity.
    expect(new Set(groups.map((group) => group.key)).size).toBe(3);
    // Each model sits under its own group, so the join by key is unambiguous.
    expect(new Set(models.map((entry) => entry.upstreamKey)).size).toBe(3);
    // And a provider aliased `Other` is not the fallback group.
    const other = groups.find((group) => group.ownedBy === 'Other');
    expect(other?.key).not.toBe(FALLBACK_GROUP_KEY);
  });

  it('07 — a combination is its own category, with no manufactured prefix', () => {
    const { models, groups } = parseModelCatalogue(
      body(model('my-combo', COMBO_OWNER), model('openai/gpt-5.x', 'openai')),
    );
    const combo = groups.find((group) => group.kind === 'combo');
    expect(combo).toBeDefined();
    expect(combo!.displayName).toBe('Combinations');
    const comboModel = models.find((entry) => entry.id === 'my-combo');
    // The id has no slash and none was invented for it.
    expect(comboModel!.id).toBe('my-combo');
    expect(comboModel!.upstreamKey).toBe(combo!.key);
    // Providers sort before combinations, so the list reads predictably.
    expect(groups.map((group) => group.kind)).toEqual(['provider', 'combo']);
  });

  it('08 — a missing or unusable owned_by falls back without losing the model', () => {
    const cases: unknown[] = [
      model('no-owner'),
      model('null-owner', null),
      model('empty-owner', ''),
      model('blank-owner', '   '),
      model('number-owner', 7),
      model('object-owner', { a: 1 }),
      model('long-owner', 'o'.repeat(MAX_OWNED_BY + 1)),
    ];
    const { models, groups, refused } = parseModelCatalogue(body(...cases));
    // Not one entry discarded: the model is usable even when its grouping is not.
    expect(refused).toEqual([]);
    expect(models).toHaveLength(cases.length);
    expect(new Set(models.map((entry) => entry.upstreamKey))).toEqual(
      new Set([FALLBACK_GROUP_KEY]),
    );
    const fallback = groups.find((group) => group.key === FALLBACK_GROUP_KEY);
    expect(fallback?.displayName).toBe('Other');
    expect(fallback?.kind).toBe('other');
    // And the fallback sorts last.
    expect(groups.at(-1)!.key).toBe(FALLBACK_GROUP_KEY);
  });

  it('09 — models with the same owner but different ids all stay selectable', () => {
    const { models } = parseModelCatalogue(
      body(model('up/a', 'up'), model('up/b', 'up'), model('up/c', 'up')),
    );
    expect(models.map((entry) => entry.id)).toEqual(['up/a', 'up/b', 'up/c']);
  });
});

describe('TEST-9RCAT-001 — malformed external data', () => {
  it('10 — one bad entry costs that entry and nothing else', () => {
    const { models, refused } = parseModelCatalogue(
      body(
        model('good/one', 'up'),
        null,
        'a string',
        42,
        { object: 'model' },
        { id: 99, object: 'model' },
        { id: '', object: 'model' },
        { id: '   ', object: 'model' },
        { id: 'wrong/kind', object: 'embedding' },
        model('good/two', 'up'),
      ),
    );
    expect(models.map((entry) => entry.id)).toEqual(['good/one', 'good/two']);
    expect(refused.map((entry) => entry.reason)).toEqual([
      'not-an-object',
      'not-an-object',
      'not-an-object',
      'no-id',
      'id-not-a-string',
      'id-unrecordable',
      'id-unrecordable',
      'wrong-object-kind',
    ]);
    // Positions are reported, so a diagnostic can point at the entry.
    expect(refused.map((entry) => entry.at)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('11 — a duplicate id keeps the first and reports the second', () => {
    const { models, refused } = parseModelCatalogue(
      body(model('same', 'first'), model('same', 'second')),
    );
    expect(models).toHaveLength(1);
    // The first survives, so grouping cannot be changed by a later repeat.
    expect(models[0]!.upstreamKey).toBe(upstreamKeyFor('first'));
    expect(refused).toEqual([{ reason: 'duplicate-id', at: 1 }]);
  });

  it('12 — an unparseable envelope is not an empty catalogue', () => {
    // Reporting "this gateway offers no models" for a broken response would send
    // the user looking in the wrong place.
    for (const bad of [null, undefined, 'text', 42, [], {}, { object: 'list' }, { data: {} }]) {
      const result = parseModelCatalogue(bad);
      expect(result.models, JSON.stringify(bad)).toEqual([]);
      expect(result.groups).toEqual([]);
    }
    // An envelope with an empty list genuinely is an empty catalogue.
    expect(parseModelCatalogue(body()).models).toEqual([]);
  });

  it('13 — an entry with no `object` field is accepted', () => {
    // Advisory, not required: the field is checked when present and absence is
    // not a reason to drop a model the gateway offered.
    const { models, refused } = parseModelCatalogue(body({ id: 'up/a', owned_by: 'up' }));
    expect(refused).toEqual([]);
    expect(models[0]!.id).toBe('up/a');
  });

  it('14 — the default endpoint is the documented local one', () => {
    expect(NINE_ROUTER_DEFAULT_BASE_URL).toBe('http://localhost:20128/v1');
  });
});
