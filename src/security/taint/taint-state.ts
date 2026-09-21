/**
 * Task-level taint state (Stage 3 B2, roadmap sections 4I, 4J, 4K).
 *
 * Why task level and not value level: tool arguments are produced entirely by
 * the model. `AgentRuntime` forwards `call.arguments` straight from the
 * provider response, and the registry validates them against a Zod schema and
 * nothing else. A model may paraphrase, encode, translate, split or re-derive
 * anything it was shown, so no provenance attached to a value survives the
 * model boundary. Value-level tracking across that boundary would be a control
 * that looks real and is not.
 *
 * The sound alternative is to make taint a monotone property of the *task*:
 * once a task has read something sensitive, every argument the model
 * subsequently produces is treated as carrying it. That is coarse on purpose —
 * it cannot be evaded by base64, JSON, concatenation or paraphrase, because no
 * value is inspected.
 *
 * Three states, and the distinction between two of them is the whole point:
 *
 *  - `KNOWN_UNTAINTED` — provenance established, nothing sensitive read.
 *  - `TAINTED`         — provenance established, sources listed.
 *  - `UNKNOWN`         — provenance *not* established. Fails closed.
 *
 * A single empty array cannot express both "established as clean" and "never
 * written", and conflating them is exactly the defect that let the guard
 * return `allow` for a task whose taint had been lost to a worker restart.
 */

import type { DataSensitivity, TaintSource } from '@/security/exfiltration/exfiltration-guard';
import { maxSensitivity } from '@/security/exfiltration/exfiltration-guard';

/** Why provenance could not be established. Recorded for evidence and UI. */
export type UnknownTaintReason =
  'field-absent' | 'legacy-record' | 'malformed' | 'persistence-failed';

export type TaintState =
  | { readonly kind: 'KNOWN_UNTAINTED' }
  | { readonly kind: 'TAINTED'; readonly sources: readonly TaintSource[] }
  | { readonly kind: 'UNKNOWN'; readonly reason: UnknownTaintReason };

/**
 * The only trusted construction point.
 *
 * A task that has just been created has read nothing, which is the one
 * situation where "clean" is a fact rather than an assumption. Static
 * extension data and system-generated identifiers qualify on the same
 * reasoning but never need a `TaintState` of their own.
 *
 * Note what this does *not* assert. The user's objective text is untainted
 * because it is not externally derived; that says nothing about how sensitive
 * it is. A user may paste a credential into it. `payloadContainsSecret` still
 * applies to every payload at every taint state, and sensitivity is classified
 * independently.
 */
export function freshTaint(): TaintState {
  return { kind: 'KNOWN_UNTAINTED' };
}

export function unknownTaint(reason: UnknownTaintReason): TaintState {
  return { kind: 'UNKNOWN', reason };
}

/** A stable identity for a source, used for deduplication and signatures. */
function sourceIdentity(source: TaintSource): string {
  return `${source.sourceType}\u0000${source.site ?? ''}\u0000${source.sensitivity}`;
}

/**
 * Adds sources. This is the only mutation, and it only ever grows the set.
 *
 * `UNKNOWN` is absorbing: adding a source to a state whose provenance was
 * never established does not establish it. Downgrading `UNKNOWN` to `TAINTED`
 * here would quietly claim the set is complete when the whole point of
 * `UNKNOWN` is that it is not.
 */
export function addTaint(state: TaintState, sources: readonly TaintSource[]): TaintState {
  if (state.kind === 'UNKNOWN') return state;
  if (sources.length === 0) return state;

  const existing = state.kind === 'TAINTED' ? state.sources : [];
  const seen = new Set(existing.map(sourceIdentity));
  const merged = [...existing];

  for (const source of sources) {
    const identity = sourceIdentity(source);
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(source);
  }

  if (merged.length === 0) return state;
  return { kind: 'TAINTED', sources: merged };
}

/** Sources for the exfiltration guard. `UNKNOWN` yields none — callers must check the kind. */
export function taintSources(state: TaintState): readonly TaintSource[] {
  return state.kind === 'TAINTED' ? state.sources : [];
}

export function highestSensitivity(state: TaintState): DataSensitivity {
  return taintSources(state).reduce<DataSensitivity>(
    (acc, source) => maxSensitivity(acc, source.sensitivity),
    'public',
  );
}

/**
 * Normalises whatever came back from storage.
 *
 * Everything that is not a well-formed state becomes `UNKNOWN`, including the
 * Stage 2 `taint: TaintSource[]` shape. That old field cannot be promoted to
 * `KNOWN_UNTAINTED`: an empty array there means "never written", and reading it
 * as "established clean" is the fail-open this module exists to remove.
 */
export function parseTaintState(value: unknown): TaintState {
  if (value === undefined || value === null) return unknownTaint('field-absent');
  if (Array.isArray(value)) return unknownTaint('legacy-record');
  if (typeof value !== 'object') return unknownTaint('malformed');

  const candidate = value as { kind?: unknown; sources?: unknown; reason?: unknown };

  if (candidate.kind === 'KNOWN_UNTAINTED') return { kind: 'KNOWN_UNTAINTED' };

  if (candidate.kind === 'UNKNOWN') {
    const reason = candidate.reason;
    return unknownTaint(isUnknownReason(reason) ? reason : 'malformed');
  }

  if (candidate.kind === 'TAINTED') {
    if (!Array.isArray(candidate.sources)) return unknownTaint('malformed');
    const sources: TaintSource[] = [];
    for (const entry of candidate.sources) {
      const source = parseSource(entry);
      if (!source) return unknownTaint('malformed');
      sources.push(source);
    }
    // `TAINTED([])` is not a representable state: an empty source set is
    // `KNOWN_UNTAINTED`, and only `freshTaint` may produce that. A stored
    // record claiming otherwise is malformed.
    if (sources.length === 0) return unknownTaint('malformed');
    return { kind: 'TAINTED', sources };
  }

  return unknownTaint('malformed');
}

function isUnknownReason(value: unknown): value is UnknownTaintReason {
  return (
    value === 'field-absent' ||
    value === 'legacy-record' ||
    value === 'malformed' ||
    value === 'persistence-failed'
  );
}

const SENSITIVITIES: readonly string[] = ['public', 'internal', 'confidential', 'secret'];

function parseSource(value: unknown): TaintSource | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as { sourceType?: unknown; site?: unknown; sensitivity?: unknown };
  if (typeof candidate.sourceType !== 'string' || candidate.sourceType.length === 0) return null;
  if (typeof candidate.sensitivity !== 'string' || !SENSITIVITIES.includes(candidate.sensitivity)) {
    return null;
  }
  if (candidate.site !== undefined && typeof candidate.site !== 'string') return null;

  return {
    sourceType: candidate.sourceType,
    ...(candidate.site === undefined ? {} : { site: candidate.site }),
    sensitivity: candidate.sensitivity as DataSensitivity,
  };
}

/**
 * Canonical signature over the source set, for the consent key.
 *
 * Length-prefixed rather than delimiter-joined. A `sourceType` containing the
 * delimiter could otherwise be crafted to produce the signature of a different
 * logical set; prefixing each field with its length makes the encoding
 * injective, so one logical set has exactly one signature and two sets cannot
 * collide through delimiter ambiguity.
 *
 * Versioned: a format change bumps `tsig/` and invalidates every stored grant,
 * which is the safe direction to fail.
 */
export const TAINT_SIGNATURE_VERSION = 'tsig/1';

export function canonicalTaintPayload(state: TaintState): string {
  if (state.kind === 'UNKNOWN') return `${TAINT_SIGNATURE_VERSION}\nUNKNOWN:${state.reason}`;

  const entries = taintSources(state)
    .map((source) => {
      // NFC first, so two spellings of the same text encode identically, and
      // only then measure length — normalising afterwards would desynchronise
      // the prefix from the value it describes.
      const sourceType = source.sourceType.normalize('NFC');
      const site = (source.site ?? '').normalize('NFC').toLowerCase();
      const sensitivity = source.sensitivity;
      return `${sourceType.length}:${sourceType}${site.length}:${site}${sensitivity.length}:${sensitivity}`;
    })
    .sort();

  const deduplicated = entries.filter((entry, index) => entry !== entries[index - 1]);
  return `${TAINT_SIGNATURE_VERSION}\n${deduplicated.join('\n')}`;
}
