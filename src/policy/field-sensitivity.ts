/**
 * Field sensitivity (Gate 1).
 *
 * The page knows whether a box is a password box; the page is also the
 * adversary. This module is the trusted half of that split: the content
 * script reports raw attributes and no conclusion, and the classification
 * happens here, in the worker, where page script cannot reach.
 *
 * Three rules make that split sound rather than decorative.
 *
 *  1. **Raw in, class out.** `FieldObservation` carries attribute strings and
 *     nothing that resembles a verdict. There is no field a page could set to
 *     "this is fine".
 *  2. **Restriction only travels upward.** A class is turned into a
 *     `FieldWriteDisposition`, and every disposition either leaves the tool's
 *     declared risk alone or raises it. Nothing here can lower a risk, clear a
 *     prohibition or satisfy a site grant.
 *  3. **Uncertainty is not permission.** An absent observation, an
 *     unrecognised control, a shadow root or a subframe all resolve to
 *     `UNKNOWN`, which is *more* restricted than `ORDINARY`, not less. A page
 *     that omits a signal therefore gains nothing by omitting it.
 *
 * Purity is part of the contract: no `chrome.*`, no `fetch`, no storage, no
 * clock, no provider, plugin or MCP import. It is imported by the service
 * worker *and* by the content script — the content script uses it only to
 * refuse (see `exceedsCeiling`), never to permit.
 */
import type { ProhibitedCategory, RiskLevel } from './risk-classifier';

/**
 * What the content script is allowed to say about a field.
 *
 * Every member is required, and "attribute absent" is the empty string rather
 * than `undefined`. An optional field would make "this key is missing"
 * indistinguishable from "the page did not set it", and the first of those is
 * a tampered payload while the second is ordinary HTML.
 */
export interface FieldObservation {
  /** The snapshot handle this observation describes. */
  readonly elementId: string;
  /** `input.type`, lowercased; for other controls, the lowercased tag name. */
  readonly fieldType: string;
  /** The literal `autocomplete` attribute, lowercased. Empty when absent. */
  readonly autocompleteToken: string;
  /** The literal `inputmode` attribute, lowercased. Empty when absent. */
  readonly inputMode: string;
  /** `maxLength`, or -1 when the control declares none. */
  readonly maxLength: number;
  /** Registrable site of the owning form's action. Empty when there is none. */
  readonly formActionSite: string;
  /** The literal `name` attribute, lowercased and truncated. */
  readonly nameHint: string;
  /** The literal `id` attribute, lowercased and truncated. */
  readonly idHint: string;
  /** Whether the element was reached through a shadow root. */
  readonly isInShadowRoot: boolean;
  /** Whether the element lives in a subframe rather than the main document. */
  readonly isInSubframe: boolean;
}

/** Longest string this module will accept in a hint field. */
export const MAX_HINT_LENGTH = 120;

/**
 * The classes a write target can fall into.
 *
 * Total and closed. `UNKNOWN` is a real member rather than an absence so that
 * every code path handling a class has to say what it does about uncertainty.
 */
export const FIELD_CLASSES = [
  'ORDINARY',
  'UNKNOWN',
  'NATIONAL_ID',
  'API_SECRET',
  'PAYMENT_INSTRUMENT',
  'OTP',
  'PASSWORD',
] as const;

export type FieldClass = (typeof FIELD_CLASSES)[number];

/**
 * How restricted each class is, relative to the others.
 *
 * Used for one thing only: deciding whether a live element is *more*
 * restricted than the ceiling a write was authorised against. It is not a risk
 * level and does not map onto one.
 *
 * `UNKNOWN` sits directly above `ORDINARY` deliberately. It has to outrank
 * `ORDINARY`, or a page could downgrade a field to unrecognised and be treated
 * as ordinary; it must not outrank the named classes, or every unreadable
 * control would masquerade as a credential and the refusals would stop meaning
 * anything.
 */
const RESTRICTION_RANK: Record<FieldClass, number> = {
  ORDINARY: 0,
  UNKNOWN: 1,
  NATIONAL_ID: 2,
  API_SECRET: 3,
  PAYMENT_INSTRUMENT: 4,
  OTP: 5,
  PASSWORD: 6,
};

/**
 * The class an unobserved target is treated as.
 *
 * Referenced by name wherever the fallback is applied, so that changing the
 * fallback is one edit and is visible in a diff rather than spread across call
 * sites as a literal.
 */
export const SAFE_FALLBACK_CLASS: FieldClass = 'UNKNOWN';

/**
 * Controls a person can type into whose type says nothing alarming.
 *
 * Closed, and anything outside it is `UNKNOWN` rather than `ORDINARY`. That
 * direction matters: a novel or misspelled type is a control this build does
 * not understand, and not understanding a control is not evidence that it is
 * safe.
 */
const ORDINARY_TYPES: ReadonlySet<string> = new Set([
  'text',
  'email',
  'search',
  'tel',
  'url',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
  'color',
  'range',
  'checkbox',
  'radio',
  'file',
  'textarea',
  'select',
  'select-one',
  'select-multiple',
  'contenteditable',
]);

/** WHATWG autocomplete tokens that name a payment instrument outright. */
const PAYMENT_AUTOCOMPLETE: ReadonlySet<string> = new Set([
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-name',
  'cc-given-name',
  'cc-family-name',
  'cc-additional-name',
  'cc-type',
]);

/** WHATWG autocomplete tokens that name a password outright. */
const PASSWORD_AUTOCOMPLETE: ReadonlySet<string> = new Set(['current-password', 'new-password']);

// Heuristics, applied only after the standard tokens above have had their
// say. Each is deliberately narrow: a false positive here costs a refusal the
// user did not need, and a refusal that fires on ordinary forms is a control
// people learn to route around.
const PASSWORD_HINT = /(?:^|[^a-z])(?:password|passwd|pwd|passphrase)(?:$|[^a-z])/;
const OTP_HINT =
  /(?:^|[^a-z])(?:otp|totp|2fa|mfa|onetimecode|one[-_ ]?time[-_ ]?(?:code|password)|(?:auth|authentication|verification|confirmation|security|sms)[-_ ]?code)(?:$|[^a-z])/;
const PAYMENT_HINT =
  /(?:^|[^a-z])(?:cardnumber|card[-_ ]?number|creditcard|credit[-_ ]?card|debit[-_ ]?card|cvv|cvc|cvv2|card[-_ ]?security|iban|bic|swift|routing[-_ ]?number|account[-_ ]?number|sort[-_ ]?code)(?:$|[^a-z])/;
const NATIONAL_ID_HINT =
  /(?:^|[^a-z])(?:ssn|social[-_ ]?security|national[-_ ]?id|nationalid|passport(?:[-_ ]?(?:no|number))?|id[-_ ]?card|tax[-_ ]?id|nino|bsn)(?:$|[^a-z])/;
const API_SECRET_HINT =
  /(?:^|[^a-z])(?:api[-_ ]?key|apikey|access[-_ ]?token|refresh[-_ ]?token|bearer[-_ ]?token|secret[-_ ]?key|client[-_ ]?secret|private[-_ ]?key|auth[-_ ]?token)(?:$|[^a-z])/;

/**
 * Classifies a write target.
 *
 * Takes `undefined` rather than demanding a caller invent an observation,
 * because "the worker has no observation for this handle" is a real and
 * frequent state — the service worker was evicted, the handle is from an
 * older snapshot, or nothing has read the page yet. All three are the same
 * answer, and that answer is not `ORDINARY`.
 */
export function classifyField(observation: FieldObservation | undefined): FieldClass {
  if (observation === undefined) return SAFE_FALLBACK_CLASS;

  // Out of reach of the page model this build actually walks. Neither is
  // produced today — `all_frames` is false and shadow roots are not traversed
  // — and both are honoured anyway, so that the day either becomes reachable
  // it arrives as a refusal rather than as a silent `ORDINARY`.
  if (observation.isInShadowRoot || observation.isInSubframe) return SAFE_FALLBACK_CLASS;

  const type = observation.fieldType;
  const token = observation.autocompleteToken;
  const hints = `${observation.nameHint} ${observation.idHint}`;

  // 1. Signals the platform itself defines. A page that sets these is telling
  //    the truth about the field in the only vocabulary browsers agree on.
  if (type === 'password') return 'PASSWORD';
  if (PASSWORD_AUTOCOMPLETE.has(token)) return 'PASSWORD';
  if (PAYMENT_AUTOCOMPLETE.has(token)) return 'PAYMENT_INSTRUMENT';
  if (token === 'one-time-code') return 'OTP';

  // 2. Name and id heuristics, in descending order of what a wrong answer
  //    costs. These are guesses about a page that may be lying; they can only
  //    add restriction, never remove it.
  if (PASSWORD_HINT.test(hints)) return 'PASSWORD';
  if (PAYMENT_HINT.test(hints)) return 'PAYMENT_INSTRUMENT';
  if (OTP_HINT.test(hints)) return 'OTP';
  if (NATIONAL_ID_HINT.test(hints)) return 'NATIONAL_ID';
  if (API_SECRET_HINT.test(hints)) return 'API_SECRET';

  // 3. Nothing named it sensitive. That is only `ORDINARY` for a control this
  //    build recognises; anything else is a control it does not understand.
  return ORDINARY_TYPES.has(type) ? 'ORDINARY' : SAFE_FALLBACK_CLASS;
}

/**
 * What a write into a field of this class is allowed to become.
 *
 * Four shapes, and none of them permits anything: `ALLOW_AT_BASELINE` leaves
 * the tool's own declared risk untouched, and the other three are strictly
 * more restrictive than it. There is deliberately no member that lowers a
 * risk, and no member that carries an approval.
 */
export type FieldWriteDisposition =
  /** Leave the tool's declared risk alone. The only non-raising disposition. */
  | { readonly kind: 'ALLOW_AT_BASELINE' }
  /** Raise the action's risk to at least this level. */
  | { readonly kind: 'RAISE_RISK'; readonly risk: RiskLevel }
  /** Produce a hard prohibition, denied by `evaluatePolicy` stage 1. */
  | { readonly kind: 'PROHIBIT'; readonly category: ProhibitedCategory }
  /** Never written by the agent at all, in any permission mode. */
  | { readonly kind: 'REFUSE' };

/**
 * Maps a class onto what the policy request may say.
 *
 * Exhaustive over `FieldClass` with no `default`, so adding a class is a
 * compile error here rather than a silent fall-through to the permissive end.
 *
 * Two choices in here are product decisions rather than derivations, and are
 * recorded as such:
 *
 *  - `PASSWORD` and `OTP` are refused rather than confirmed. An agent that can
 *    be talked into typing a credential behind a confirmation is an agent that
 *    can be talked into typing a credential; credential entry belongs to the
 *    person or to a credential manager.
 *  - `UNKNOWN` raises to `R2` and no further. Higher would turn every control
 *    this build does not recognise into a prompt, and a product that prompts
 *    constantly is one whose prompts stop being read.
 */
export function writeDisposition(fieldClass: FieldClass): FieldWriteDisposition {
  switch (fieldClass) {
    case 'ORDINARY':
      return { kind: 'ALLOW_AT_BASELINE' };
    case 'UNKNOWN':
      return { kind: 'RAISE_RISK', risk: 'R2' };
    case 'NATIONAL_ID':
    case 'API_SECRET':
      return { kind: 'RAISE_RISK', risk: 'R3' };
    case 'PAYMENT_INSTRUMENT':
      return { kind: 'PROHIBIT', category: 'payment_instrument_entry' };
    case 'OTP':
    case 'PASSWORD':
      return { kind: 'REFUSE' };
  }
}

/**
 * Whether a live element is more restricted than the ceiling a write carried.
 *
 * This is the whole of the content script's authority over a write: it may
 * answer "yes, refuse", and it has no way to express anything else. The
 * ceiling travels worker to content on the existing control route, so nothing
 * in the page or in the content script can raise it.
 *
 * Takes `unknown` rather than `FieldClass` because the value arrives over a
 * JSON channel, where the type is a claim and not a fact. A missing or
 * unrecognised ceiling is read as `ORDINARY`, the *lowest* value — so it
 * authorises the least, and every sensitive class above it is refused. Typing
 * the parameter as `FieldClass` and trusting it was the fail-open version of
 * this function: `RESTRICTION_RANK[undefined]` is `undefined`, and every
 * comparison against `undefined` is false, so an omitted ceiling would have
 * refused nothing at all.
 */
export function exceedsCeiling(live: FieldClass, ceiling: unknown): boolean {
  return RESTRICTION_RANK[live] > RESTRICTION_RANK[normaliseCeiling(ceiling)];
}

/** The lowest ceiling, for a value that does not name one. */
export function normaliseCeiling(ceiling: unknown): FieldClass {
  return isFieldClass(ceiling) ? ceiling : 'ORDINARY';
}

/** Whether a string names a class. Used when validating a received ceiling. */
export function isFieldClass(value: unknown): value is FieldClass {
  return typeof value === 'string' && (FIELD_CLASSES as readonly string[]).includes(value);
}
