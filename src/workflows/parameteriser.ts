/**
 * Deciding what a recorded argument becomes.
 *
 * A recording captures the arguments a tool was actually called with. Most of
 * them must not be stored as written: a URL containing a customer id, the text
 * someone typed into a form, anything derived from a page. The parameteriser
 * turns each captured argument into one of three things — a stored literal, a
 * runtime input slot, or a refusal.
 *
 * **Three independent controls, in a fixed order.** They are not
 * interchangeable and one never stands in for another:
 *
 *   1. **Secret detection** runs on every value, always, whatever the taint.
 *      A secret-shaped value is never stored as a literal — not as a slot
 *      default, not truncated, not hashed. `KNOWN_UNTAINTED` says provenance
 *      is established; it says nothing about whether a value is safe to keep.
 *   2. **Sensitivity** — a password field, a credential-carrying argument —
 *      forces a slot regardless of everything else.
 *   3. **Taint** decides literal-versus-slot for everything that survived the
 *      first two. A task that had read a page may have derived any argument
 *      from it, and task-level taint is the finest provenance this
 *      architecture has, so the conservative reading is the only honest one.
 *
 * Secret detection can only ever *remove* a literal. It can never permit one
 * that taint would have refused.
 */
import { REDACTED, redact, isSensitiveFieldName } from '@/security/redaction/secret-redactor';
import {
  isBindableRole,
  type ElementBinding,
  type SkillBinding,
  type SkillInput,
} from '@/skills/core/skill-model';
import type { ActedOnElement } from '@/content/semantic-tree';
import type { TaintState } from '@/security/taint/taint-state';

/** Arguments whose value is a credential or a secret by the tool's own design. */
const ALWAYS_SLOT_ARGUMENTS: ReadonlySet<string> = new Set(
  ['password', 'passphrase', 'pin', 'otp', 'code', 'secret', 'token', 'apikey', 'credential'].map(
    (name) => name.toLowerCase(),
  ),
);

/**
 * Arguments that are structure rather than data.
 *
 * A boolean flag is not something a user supplies per run, so it is kept as
 * written rather than becoming a slot.
 */
const STRUCTURAL_ARGUMENTS: ReadonlySet<string> = new Set(['clearfirst', 'submit']);

/**
 * Arguments naming an element handle.
 *
 * A handle is `e<snapshot>-<index>` and is valid only for the page read that
 * minted it: a replay reads the page again, which starts a new snapshot, so a
 * stored handle is refused as stale every single time. It is therefore never
 * stored.
 *
 * What is stored instead is the declarative `ElementBinding` §49 asks for — a
 * role and an accessible name, re-resolved against a fresh read — built from
 * the descriptor the tool reported for the element it acted on. When no such
 * descriptor is available, or it cannot be stored safely, the step is left
 * out of the recording rather than recorded in a form that cannot run.
 */
const ELEMENT_HANDLE_ARGUMENTS: ReadonlySet<string> = new Set(['elementid']);

/** How long a string may be and still be plausibly structural rather than data. */
const SHORT_VALUE = 24;

export type ParameterDecision =
  | { readonly kind: 'literal'; readonly binding: SkillBinding }
  | { readonly kind: 'slot'; readonly binding: SkillBinding; readonly input: SkillInput }
  // Separate from `literal` on purpose: an element binding supplies no value.
  // It is a match predicate, re-resolved at replay against a page read, and
  // keeping it a distinct outcome is what stops page-derived text ever being
  // handled by the code path that produces stored literals.
  | { readonly kind: 'element'; readonly binding: ElementBinding }
  | { readonly kind: 'refused'; readonly reason: string };

export interface ParameteriseInput {
  readonly tool: string;
  readonly stepId: string;
  readonly argument: string;
  readonly value: unknown;
  /** The task's taint when the call was made. */
  readonly taint: TaintState;
  /** The element the call acted on, when the tool reported one. */
  readonly actedOn?: ActedOnElement;
  /** The recorded step whose page read a binding resolves against. */
  readonly elementStep?: string;
}

/**
 * Turns one captured argument into a binding.
 *
 * Returns a refusal rather than a best guess when the value cannot be stored
 * safely in any form — an `UNKNOWN` security context being the clearest case,
 * because nothing can be said about where the value came from.
 */
export function parameteriseArgument(input: ParameteriseInput): ParameterDecision {
  const { argument, value, taint } = input;
  const lower = argument.toLowerCase();

  // 0. Nothing can be said about a task whose provenance was not established,
  //    so nothing about its arguments can be stored. Fail closed.
  if (taint.kind === 'UNKNOWN') {
    return {
      kind: 'refused',
      reason: 'the task’s security context could not be established when this step ran',
    };
  }

  // 1. Secret detection, first and unconditional.
  if (looksSecret(argument, value)) {
    return slot(input, 'a value that looked like a credential');
  }

  // 2. Sensitivity by argument name, regardless of what the value looks like.
  //    An empty password is still a password field.
  if (ALWAYS_SLOT_ARGUMENTS.has(lower)) {
    return slot(input, 'a credential-carrying argument');
  }

  // A handle from one page read cannot be replayed against another, so what
  // is stored is a description of the element rather than the handle.
  if (ELEMENT_HANDLE_ARGUMENTS.has(lower)) {
    return bindElement(input);
  }

  // Structure, not data: kept as written because it is not a value a person
  // supplies per run.
  if (STRUCTURAL_ARGUMENTS.has(lower)) {
    return { kind: 'literal', binding: { kind: 'literal', value } };
  }

  // Booleans and numbers carry no page text and are not worth prompting for.
  if (typeof value === 'boolean' || typeof value === 'number') {
    return { kind: 'literal', binding: { kind: 'literal', value } };
  }

  // 3. Taint decides the rest.
  if (taint.kind === 'TAINTED') {
    if (typeof value === 'string' && value.length <= SHORT_VALUE && !hasPayloadShape(value)) {
      // Short, structural-looking strings — a role, a state, a repository
      // name — are kept so a workflow is not all slots. Anything longer may
      // be page-derived, and a slot is the safe reading.
      return { kind: 'literal', binding: { kind: 'literal', value } };
    }
    return slot(input, 'a value this task may have derived from what it read');
  }

  // KNOWN_UNTAINTED: the task had read nothing external, so the value came
  // from the user's own intent. It has already passed secret detection.
  if (typeof value === 'string' || value === null) {
    return { kind: 'literal', binding: { kind: 'literal', value } };
  }

  // Anything structured is stored only if it survives a redaction round trip
  // unchanged — a nested credential would alter it.
  return redact(JSON.stringify(value) ?? '') === (JSON.stringify(value) ?? '')
    ? { kind: 'literal', binding: { kind: 'literal', value } }
    : slot(input, 'a structured value containing something credential-shaped');
}

function slot(input: ParameteriseInput, why: string): ParameterDecision {
  const name = slotName(input.stepId, input.argument);
  return {
    kind: 'slot',
    binding: { kind: 'input', name },
    input: {
      name,
      type: 'string',
      // The description says what to supply, never what was captured. The
      // captured value is the thing that must not reach disk.
      description: `${input.argument} for ${input.tool} (not stored: ${why})`,
      required: true,
      maxLength: 4096,
    },
  };
}

/** A stable, collision-free slot name derived from where the value goes. */
export function slotName(stepId: string, argument: string): string {
  const clean = (part: string): string => part.replace(/[^A-Za-z0-9]/g, '_');
  return `${clean(stepId)}_${clean(argument)}`;
}

/**
 * Whether a value must never be stored.
 *
 * Two independent signals, either of which is enough: the argument's name
 * reads as sensitive, or the redactor alters the value — which is the same
 * check the logs, evidence and audit trail already use, so a recording cannot
 * be laxer than they are.
 */
export function looksSecret(argument: string, value: unknown): boolean {
  if (isSensitiveFieldName(argument)) return true;
  if (typeof value !== 'string') {
    const serialised = JSON.stringify(value) ?? '';
    return serialised.length > 0 && redact(serialised) !== serialised;
  }
  if (value.length === 0) return false;
  const redacted = redact(value);
  return redacted !== value || redacted.includes(REDACTED);
}

/**
 * Whether a short string still looks like carried data rather than structure.
 *
 * A URL, an email address or anything with whitespace is content even when it
 * is short, so the length shortcut above does not apply to it.
 */
function hasPayloadShape(value: string): boolean {
  return /\s/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.includes('@');
}

/**
 * How long an accessible name may be and still be worth storing.
 *
 * Short enough that a name is a label rather than a paragraph. A control
 * named by a sentence of page prose is not something a recording should be
 * carrying around, and matching on it would be brittle anyway.
 */
const MAX_BINDING_NAME = 64;

/**
 * Turns the element a step acted on into a binding, or refuses.
 *
 * Every check here decides **whether the binding may be stored at all**. None
 * of them changes where the data came from: the result always carries
 * `PAGE_DERIVED`, because it always did come from a page. Semantic validity
 * and provenance are independent properties, and passing the first never
 * grants the second.
 */
function bindElement(input: ParameteriseInput): ParameterDecision {
  const actedOn = input.actedOn;
  if (!actedOn) {
    return {
      kind: 'refused',
      reason: 'the element this step used could not be described without its page handle',
    };
  }

  // A role is page-controlled — a page sets `role="anything"`, and an element
  // with no mapping reports its tag name — so only roles a recorded
  // interaction can meaningfully target are bindable.
  if (!isBindableRole(actedOn.role)) {
    return {
      kind: 'refused',
      reason: `the element is a "${actedOn.role}", which is not something a recording can name`,
    };
  }

  const name = actedOn.name.trim();
  if (name.length === 0 || name.length > MAX_BINDING_NAME) {
    return {
      kind: 'refused',
      reason: 'the element has no short, stable name to recognise it by',
    };
  }

  // Secret detection, before anything is persisted and regardless of
  // provenance — the same check every other captured value gets. It can only
  // ever reject: passing it does not make this value authored, untainted or
  // trusted, it just removes one reason to refuse.
  if (looksSecret('name', name)) {
    return {
      kind: 'refused',
      reason: 'the element’s name looked like it contained a credential',
    };
  }

  // A name carrying selector or scheme syntax is either a mistake or an
  // attempt to smuggle one in. Refused rather than sanitised, so nothing
  // downstream has to reason about a partially-cleaned value.
  if (SELECTOR_SHAPED_NAME.test(name)) {
    return {
      kind: 'refused',
      reason: 'the element’s name looked like a selector rather than a label',
    };
  }

  // Ambiguity at record time is refused rather than pinned by position. A
  // recording that says "the third Delete button" is a recording that clicks
  // the wrong thing the moment a row is added.
  if (actedOn.matchCount !== 1) {
    return {
      kind: 'refused',
      reason: `${actedOn.matchCount} elements on the page shared that role and name`,
    };
  }

  return {
    kind: 'element',
    binding: {
      kind: 'element',
      // Recorded at origin, never inferred from the value and never changed by
      // anything above. See `BindingProvenance`.
      provenance: 'PAGE_DERIVED',
      purpose: 'ELEMENT_BINDING',
      step: input.elementStep ?? '',
      role: actedOn.role.trim().toLowerCase(),
      name,
      ...(actedOn.enabled && actedOn.visible ? { expect: 'editable' as const } : {}),
    },
  };
}

/** Selector and scheme syntax, which a label never contains. */
const SELECTOR_SHAPED_NAME = /[<>{}()[\]$*|\\/]|^[.#]|javascript:|data:|::|=>/i;
