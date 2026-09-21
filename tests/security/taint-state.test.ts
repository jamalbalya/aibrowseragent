/**
 * TEST-SECURITY-011 — task-level taint state (Stage 3 B2, step 1).
 *
 * Covers the distinction the whole egress model rests on: "established as
 * clean" and "never established" must not be the same value. The Stage 2
 * defect was that they were, so a task whose taint had been lost to a worker
 * restart evaluated as though it had read nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  addTaint,
  canonicalTaintPayload,
  freshTaint,
  highestSensitivity,
  parseTaintState,
  taintSources,
  unknownTaint,
  type TaintState,
} from '@/security/taint/taint-state';
import type { TaintSource } from '@/security/exfiltration/exfiltration-guard';

const page: TaintSource = {
  sourceType: 'web_page',
  site: 'example.com',
  sensitivity: 'confidential',
};
const other: TaintSource = { sourceType: 'web_page', site: 'other.com', sensitivity: 'internal' };

describe('taint state construction', () => {
  it('starts a task as explicitly clean, not as an empty unknown', () => {
    expect(freshTaint()).toEqual({ kind: 'KNOWN_UNTAINTED' });
  });

  it('never represents a tainted state with an empty source list', () => {
    // TAINTED([]) would be a second spelling of "clean" and would reintroduce
    // the ambiguity this model removes.
    expect(parseTaintState({ kind: 'TAINTED', sources: [] })).toEqual({
      kind: 'UNKNOWN',
      reason: 'malformed',
    });
  });
});

describe('monotonicity', () => {
  it('grows on a new source', () => {
    const state = addTaint(freshTaint(), [page]);
    expect(state).toEqual({ kind: 'TAINTED', sources: [page] });
  });

  it('deduplicates a repeated source rather than growing', () => {
    const once = addTaint(freshTaint(), [page]);
    const twice = addTaint(once, [page]);
    expect(taintSources(twice)).toHaveLength(1);
  });

  it('accumulates distinct sources', () => {
    const state = addTaint(addTaint(freshTaint(), [page]), [other]);
    expect(taintSources(state)).toHaveLength(2);
  });

  it('never loses a source', () => {
    let state: TaintState = freshTaint();
    for (const source of [page, other, page, other]) state = addTaint(state, [source]);
    expect(taintSources(state)).toHaveLength(2);
    expect(taintSources(state)).toEqual(expect.arrayContaining([page, other]));
  });

  it('keeps UNKNOWN absorbing — adding a source does not establish provenance', () => {
    // Promoting UNKNOWN to TAINTED here would claim the set is complete when
    // the entire meaning of UNKNOWN is that it is not.
    const state = addTaint(unknownTaint('legacy-record'), [page]);
    expect(state).toEqual({ kind: 'UNKNOWN', reason: 'legacy-record' });
  });

  it('reports the highest sensitivity present', () => {
    const state = addTaint(addTaint(freshTaint(), [other]), [page]);
    expect(highestSensitivity(state)).toBe('confidential');
  });
});

describe('deserialisation fails closed', () => {
  it.each([
    ['absent', undefined, 'field-absent'],
    ['null', null, 'field-absent'],
    ['a Stage 2 array', [], 'legacy-record'],
    ['a populated Stage 2 array', [page], 'legacy-record'],
    ['a string', 'KNOWN_UNTAINTED', 'malformed'],
    ['an unrecognised kind', { kind: 'CLEAN' }, 'malformed'],
    ['sources that are not an array', { kind: 'TAINTED', sources: 'x' }, 'malformed'],
    [
      'a source missing sensitivity',
      { kind: 'TAINTED', sources: [{ sourceType: 'a' }] },
      'malformed',
    ],
    [
      'a bogus sensitivity',
      { kind: 'TAINTED', sources: [{ sourceType: 'a', sensitivity: 'x' }] },
      'malformed',
    ],
    ['an unrecognised unknown reason', { kind: 'UNKNOWN', reason: 'because' }, 'malformed'],
  ])('reads %s as UNKNOWN', (_label, value, reason) => {
    expect(parseTaintState(value)).toEqual({ kind: 'UNKNOWN', reason });
  });

  it('never promotes a legacy empty array to clean', () => {
    // The Stage 2 field initialised to [] and was never written again, so []
    // means "no record", not "nothing was read".
    const parsed = parseTaintState([]);
    expect(parsed.kind).toBe('UNKNOWN');
    expect(parsed.kind === 'KNOWN_UNTAINTED').toBe(false);
  });

  it('round-trips a well-formed state through JSON', () => {
    const state = addTaint(freshTaint(), [page, other]);
    expect(parseTaintState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('round-trips a clean state through JSON', () => {
    expect(parseTaintState(JSON.parse(JSON.stringify(freshTaint())))).toEqual(freshTaint());
  });
});

describe('canonical signature encoding', () => {
  it('is order independent', () => {
    const a = addTaint(addTaint(freshTaint(), [page]), [other]);
    const b = addTaint(addTaint(freshTaint(), [other]), [page]);
    expect(canonicalTaintPayload(a)).toBe(canonicalTaintPayload(b));
  });

  it('changes when a source is added', () => {
    const before = addTaint(freshTaint(), [page]);
    const after = addTaint(before, [other]);
    expect(canonicalTaintPayload(after)).not.toBe(canonicalTaintPayload(before));
  });

  it('is unchanged by a duplicate addition', () => {
    const once = addTaint(freshTaint(), [page]);
    expect(canonicalTaintPayload(addTaint(once, [page]))).toBe(canonicalTaintPayload(once));
  });

  it('cannot be forged by a delimiter inside a field', () => {
    // The reason the encoding is length-prefixed rather than joined: a crafted
    // sourceType must not be able to imitate a different logical set.
    const crafted = canonicalTaintPayload({
      kind: 'TAINTED',
      sources: [{ sourceType: 'web_page\n11:example.com', sensitivity: 'confidential' }],
    });
    const genuine = canonicalTaintPayload({
      kind: 'TAINTED',
      sources: [{ sourceType: 'web_page', site: 'example.com', sensitivity: 'confidential' }],
    });
    expect(crafted).not.toBe(genuine);
  });

  it('distinguishes a clean state from an unknown one', () => {
    expect(canonicalTaintPayload(freshTaint())).not.toBe(
      canonicalTaintPayload(unknownTaint('field-absent')),
    );
  });

  it('normalises Unicode so one logical site has one signature', () => {
    // Built from code points rather than written literally: a formatter would
    // otherwise normalise the source and the test would compare a string with
    // itself, passing whatever the implementation does.
    const precomposed = `caf${String.fromCharCode(0xe9)}.example`;
    const combining = `cafe${String.fromCharCode(0x301)}.example`;
    expect(precomposed).not.toBe(combining);

    const composed = canonicalTaintPayload({
      kind: 'TAINTED',
      sources: [{ sourceType: 'web_page', site: precomposed, sensitivity: 'internal' }],
    });
    const decomposed = canonicalTaintPayload({
      kind: 'TAINTED',
      sources: [{ sourceType: 'web_page', site: combining, sensitivity: 'internal' }],
    });
    expect(composed).toBe(decomposed);
  });

  it('lowercases the site so case cannot split one grant into two', () => {
    const upper = canonicalTaintPayload({
      kind: 'TAINTED',
      sources: [{ sourceType: 'web_page', site: 'EXAMPLE.com', sensitivity: 'internal' }],
    });
    const lower = canonicalTaintPayload({
      kind: 'TAINTED',
      sources: [{ sourceType: 'web_page', site: 'example.com', sensitivity: 'internal' }],
    });
    expect(upper).toBe(lower);
  });

  it('carries a version so a format change invalidates stored grants', () => {
    expect(canonicalTaintPayload(freshTaint()).startsWith('tsig/1')).toBe(true);
  });
});
