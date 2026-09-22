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
import type { SkillBinding, SkillInput } from '@/skills/core/skill-model';
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
 * Arguments naming an element handle, which cannot be recorded at all yet.
 *
 * A handle is `e<snapshot>-<index>` and is valid only for the page read that
 * minted it: a replay reads the page again, which starts a new snapshot, so a
 * stored handle is refused as stale every single time. Storing one would put a
 * step into a workflow that can never succeed.
 *
 * The right shape is the declarative `ElementBinding` — a role and an
 * accessible name, re-resolved against a fresh read — which the validator and
 * the runner already support. The recorder cannot build one yet: the semantic
 * identity of a handle lives in the `browser.read_page` result that produced
 * it, and a dispatch observation deliberately carries no result. So a step
 * naming an element is left out of the recording, with a reason, rather than
 * recorded in a form that cannot run.
 */
const ELEMENT_HANDLE_ARGUMENTS: ReadonlySet<string> = new Set(['elementid']);

/** How long a string may be and still be plausibly structural rather than data. */
const SHORT_VALUE = 24;

export type ParameterDecision =
  | { readonly kind: 'literal'; readonly binding: SkillBinding }
  | { readonly kind: 'slot'; readonly binding: SkillBinding; readonly input: SkillInput }
  | { readonly kind: 'refused'; readonly reason: string };

export interface ParameteriseInput {
  readonly tool: string;
  readonly stepId: string;
  readonly argument: string;
  readonly value: unknown;
  /** The task's taint when the call was made. */
  readonly taint: TaintState;
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

  // A handle from one page read cannot be replayed against another.
  if (ELEMENT_HANDLE_ARGUMENTS.has(lower)) {
    return {
      kind: 'refused',
      reason:
        'this step acts on an element the recorder cannot yet describe in a way that ' +
        'would still mean the same thing on a later visit',
    };
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
