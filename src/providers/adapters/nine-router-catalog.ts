/**
 * 9Router's model catalogue, parsed.
 *
 * 9Router is a gateway: one OpenAI-compatible endpoint in front of many upstream
 * providers, discovered at run time from `GET <baseUrl>/models`. Nothing about
 * the catalogue is known at build time — not the providers, not the models, not
 * how many of either — so this module contains no provider names and no model
 * names. Its whole job is to turn an untrusted response into a hierarchy the UI
 * can show, and to do it without damaging the one value that has to survive
 * exactly: the model id.
 *
 * ## The model id is opaque
 *
 * A 9Router model id routinely contains `/` — `openai/gpt-5.x`, `vendor/model` —
 * and a *combo* id contains none at all. The `/` belongs to the identifier. It is
 * not a delimiter this build may read, split, normalise or replace, and the id
 * that goes out in a request is byte-for-byte the id the catalogue offered.
 *
 * That is not a style preference. `managementTaskId` once interpolated a model id
 * into an internal identifier and a `/` made the identifier invalid, so every
 * capability probe against `cx/gpt-5.6-terra` lost its audit record while the
 * probe itself succeeded. The fix was to stop treating an external string as an
 * internal one. This module is the same rule applied at discovery: the id is
 * carried, never parsed.
 *
 * ## The hierarchy comes from `owned_by`
 *
 * `owned_by` is the grouping signal — the field 9Router populates with the
 * upstream alias, or with the literal `combo` for a combination. Splitting the id
 * on `/` would *look* like it produced the same answer and would be wrong in
 * three ways: a combo id has no prefix to find, a prefix can disagree with
 * `owned_by` when a connection renames its alias, and the act of splitting invites
 * the caller to keep the suffix.
 *
 * ## Group identity is not the label
 *
 * Two upstreams can present the same display label. The group's identity is an
 * opaque key derived from `owned_by`, and the label is for reading. A UI that
 * keyed on the label would merge two providers into one and silently send a
 * request to whichever won.
 */
import { getLogger } from '@/logging/logger';
import { isRecordableModelId } from '@/providers/core/provider-http';
import { MAX_STRING } from '@/audit/boundaries';
import type { ModelInfo } from '@/providers/core/types';

const log = getLogger('provider');

export const NINE_ROUTER_PROVIDER_ID = 'nine-router';

/** 9Router's default local endpoint, as its own documentation gives it. */
export const NINE_ROUTER_DEFAULT_BASE_URL = 'http://localhost:20128/v1';

/**
 * The value 9Router puts in `owned_by` for a combination rather than an upstream.
 *
 * Reserved by 9Router, not by this build, which is why it is compared rather
 * than constructed: a combo is a legitimate category in the hierarchy and gets
 * its own group instead of being forced under a manufactured provider prefix.
 */
export const COMBO_OWNER = 'combo';

/** Where a model goes when `owned_by` says nothing usable. */
export const FALLBACK_GROUP_KEY = 'other';

/**
 * How wide an `owned_by` may be.
 *
 * External, so bounded — and bounded at the audit field that records it rather
 * than at a number invented here. A longer one does not discard the model: the
 * model keeps its exact id and moves to the fallback group, because losing a
 * usable model over its *grouping* metadata would be the wrong trade.
 */
export const MAX_OWNED_BY = MAX_STRING;

/** How long a group's display label may be, for the same reason. */
export const MAX_GROUP_LABEL = MAX_STRING;

/** What kind of thing a group represents. */
export type UpstreamKind = 'provider' | 'combo' | 'other';

/**
 * One level of the hierarchy: an upstream provider, or the combo category.
 *
 * `key` is the identity and `displayName` is for reading. They are separate
 * fields because they are separate concerns — see the note at the top of the
 * file about two upstreams sharing a label.
 */
export interface UpstreamGroup {
  /** Opaque, stable, derived from `owned_by`. The identity. */
  readonly key: string;
  /** Exactly what the catalogue said, when it said anything usable. */
  readonly ownedBy: string;
  /** For a person to read. Never an identity. */
  readonly displayName: string;
  readonly kind: UpstreamKind;
  /** How many models the catalogue placed here. */
  readonly modelCount: number;
}

/** A catalogue entry: a model, and which group it belongs to. */
export interface NineRouterModel extends ModelInfo {
  /** The `UpstreamGroup.key` this model sits under. */
  readonly upstreamKey: string;
}

/** Why an entry was left out, for the diagnostic. */
export type CatalogueRefusal =
  | 'not-an-object'
  | 'no-id'
  | 'id-not-a-string'
  | 'id-unrecordable'
  | 'duplicate-id'
  | 'wrong-object-kind';

export interface ModelCatalogue {
  readonly models: readonly NineRouterModel[];
  readonly groups: readonly UpstreamGroup[];
  /** One entry per refused catalogue entry, in catalogue order. */
  readonly refused: readonly { readonly reason: CatalogueRefusal; readonly at: number }[];
}

const EMPTY: ModelCatalogue = { models: [], groups: [], refused: [] };

/**
 * A stable opaque key for one `owned_by`.
 *
 * Derived rather than random so it survives a reload without being persisted
 * separately, and prefixed so it can never collide with `FALLBACK_GROUP_KEY`.
 * Case is folded and the rest is escaped, so an `owned_by` of `OpenAI` and one of
 * `openai` are one group while `a.b` and `a-b` stay two.
 */
export function upstreamKeyFor(ownedBy: string): string {
  const folded = ownedBy.trim().toLowerCase();
  if (folded.length === 0) return FALLBACK_GROUP_KEY;
  // Percent-escaping every character outside the safe set, so the mapping is
  // injective: two different owners cannot produce one key.
  const escaped = folded.replace(
    /[^a-z0-9._-]/g,
    (character) => `~${character.codePointAt(0)!.toString(16)}~`,
  );
  return `up:${escaped}`;
}

/** Whether a value is usable as an upstream alias. */
function usableOwner(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_OWNED_BY;
}

/**
 * Turns an untrusted `/models` body into a catalogue.
 *
 * Per entry rather than all-or-nothing: one malformed entry in a list of eighty
 * should cost that entry and nothing else, which is the same shape
 * `admitListing` uses for MCP tools. A refusal is counted and reported so a
 * person can see that the catalogue was incomplete — silently shortening a list
 * the user is choosing from is its own kind of lie.
 *
 * The envelope is checked too: a body that is not `{object:"list", data:[…]}` is
 * not a catalogue, and pretending an unparseable response is an empty one would
 * report "this endpoint offers no models" for what is really a broken endpoint.
 */
export function parseModelCatalogue(body: unknown): ModelCatalogue {
  if (typeof body !== 'object' || body === null) return EMPTY;
  const envelope = body as { object?: unknown; data?: unknown };
  if (!Array.isArray(envelope.data)) return EMPTY;

  const models: NineRouterModel[] = [];
  const refused: { reason: CatalogueRefusal; at: number }[] = [];
  const seen = new Set<string>();
  const counts = new Map<string, { ownedBy: string; kind: UpstreamKind; count: number }>();

  for (const [at, raw] of envelope.data.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      refused.push({ reason: 'not-an-object', at });
      continue;
    }
    const entry = raw as { id?: unknown; object?: unknown; owned_by?: unknown };

    // `object` is advisory: 9Router sets `"model"`, and an entry that says
    // something else is not one this build knows how to select.
    if (entry.object !== undefined && entry.object !== 'model') {
      refused.push({ reason: 'wrong-object-kind', at });
      continue;
    }
    if (entry.id === undefined || entry.id === null) {
      refused.push({ reason: 'no-id', at });
      continue;
    }
    if (typeof entry.id !== 'string') {
      refused.push({ reason: 'id-not-a-string', at });
      continue;
    }
    // Not trimmed: an id is opaque, and trimming would change it. An id that is
    // only whitespace is refused by the recordability check below.
    const id = entry.id;
    if (id.trim().length === 0 || !isRecordableModelId(id)) {
      // The one bound that must refuse rather than degrade: a model whose id
      // cannot be named in an audit record cannot be run with a trail, and the
      // boundary contract owns that limit rather than this file.
      refused.push({ reason: 'id-unrecordable', at });
      continue;
    }
    if (seen.has(id)) {
      // 9Router de-duplicates its own list, so a repeat means something upstream
      // collided. Keep the first and say so, as `admitListing` does.
      refused.push({ reason: 'duplicate-id', at });
      continue;
    }
    seen.add(id);

    const owner = usableOwner(entry.owned_by) ? entry.owned_by.trim() : null;
    const kind: UpstreamKind =
      owner === null ? 'other' : owner.toLowerCase() === COMBO_OWNER ? 'combo' : 'provider';
    const key = owner === null ? FALLBACK_GROUP_KEY : upstreamKeyFor(owner);

    const existing = counts.get(key);
    if (existing) counts.set(key, { ...existing, count: existing.count + 1 });
    else counts.set(key, { ownedBy: owner ?? '', kind, count: 1 });

    models.push({
      id,
      // The id *is* the display name. Shortening it to the part after a `/`
      // would show two different models as one, and would teach the reader that
      // the prefix is decoration.
      displayName: id,
      upstreamKey: key,
    });
  }

  const groups: UpstreamGroup[] = [...counts].map(([key, value]) => ({
    key,
    ownedBy: value.ownedBy,
    displayName: labelFor(key, value.ownedBy, value.kind),
    kind: value.kind,
    modelCount: value.count,
  }));
  // Providers first, then combos, then the fallback — and alphabetically within
  // each, so the list is stable across reloads rather than in response order.
  const rank: Record<UpstreamKind, number> = { provider: 0, combo: 1, other: 2 };
  groups.sort((a, b) => rank[a.kind] - rank[b.kind] || a.displayName.localeCompare(b.displayName));

  if (refused.length > 0) {
    log.warn('Some entries in the model catalogue could not be used.', {
      refused: refused.length,
      reasons: [...new Set(refused.map((entry) => entry.reason))].join(','),
    });
  }
  return { models, groups, refused };
}

/**
 * What to call a group.
 *
 * The alias as the catalogue gave it, because this build does not know 9Router's
 * upstreams and inventing friendly names for them would mean shipping a list that
 * goes stale. Only the two categories this build *does* define get a word.
 */
function labelFor(key: string, ownedBy: string, kind: UpstreamKind): string {
  if (kind === 'combo') return 'Combinations';
  if (key === FALLBACK_GROUP_KEY || ownedBy.length === 0) return 'Other';
  return ownedBy.slice(0, MAX_GROUP_LABEL);
}
