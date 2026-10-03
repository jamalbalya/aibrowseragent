/**
 * Finding again an element whose handle has gone stale.
 *
 * ## The rung this adds to the recovery ladder
 *
 * `P-032-C6` describes a worked recovery sequence — refresh the page model,
 * find the target, retry, screenshot fallback, alternate locator, model
 * recovery — and this repository had the first three. When a handle went
 * stale, every path ended in the same sentence to the model: *"Read the page
 * again to get current handles."*
 *
 * That works, and it costs a model turn for a mechanical problem. Worse, it
 * only works if the model chooses to re-read: one that retries the same handle
 * loops, and one that gives up strands a task the page would have allowed. A
 * page that re-renders between the read and the click — a React list settling,
 * a spinner resolving, a toast appearing — is the ordinary case, not an edge
 * one.
 *
 * So before reporting the handle unusable, the element is looked for again.
 *
 * ## Why role and name, and why nothing else
 *
 * Because that is already this build's answer to "what identifies an element
 * declaratively". `describeActedOn` produces exactly this pair, and a workflow
 * binding is matched on exactly this pair. A third identity scheme here would
 * be a third set of behaviours to reason about, and the two that exist would
 * not be the ones under test.
 *
 * ## Why a unique match, and never the nth
 *
 * The descriptor carries a position, and using it is tempting and wrong. The
 * parameteriser already settled this, for a reason worth repeating verbatim:
 * *"Ambiguity at record time is refused rather than pinned by position. A
 * recording that says 'the third Delete button' is a recording that clicks the
 * wrong thing the moment a row is added."*
 *
 * The same holds with more force here, because this runs **after** the page has
 * demonstrably changed. If two elements now share the role and the name, the
 * page is not the page the model read, and guessing between them is how an
 * agent deletes the wrong row. Zero matches and two matches are both refusals.
 *
 * ## What this does not do
 *
 * It does not bypass a single check. A relocated element goes through the same
 * visibility, enabled and field-sensitivity gates as any other, because
 * relocation happens during resolution and every one of those runs after it.
 * And it is **reported**: a caller learns the element was re-found, so a click
 * on a node the model did not literally name is visible in the result and in
 * the audit trail rather than being indistinguishable from an ordinary one.
 */

import { accessibleName, roleOf, type ElementDescriptor } from './semantic-tree';

export type RelocationRefusal =
  /** The handle predates what the registry still remembers. */
  | 'NOT_REMEMBERED'
  /** The descriptor has no name, so it would match on role alone. */
  | 'NOT_IDENTIFIABLE'
  /** Nothing on the page matches it any more. */
  | 'GONE'
  /** More than one element matches, so choosing would be guessing. */
  | 'AMBIGUOUS';

export type Relocation =
  | { readonly ok: true; readonly element: Element }
  | { readonly ok: false; readonly refusal: RelocationRefusal; readonly matches: number };

/**
 * Normalises a name for comparison.
 *
 * Collapsed whitespace and case-folded, because the two readings happen at
 * different moments and a page can re-render the same label with different
 * spacing. Not trimmed of punctuation or truncated: a label that differs by
 * more than whitespace is a different label, and deciding otherwise is how a
 * match becomes a guess.
 */
function comparable(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Looks for the element a descriptor was taken from, among current candidates.
 *
 * `candidates` is the page's interactive set as it is **now**, supplied by the
 * caller rather than read here, so this function is a pure decision that a
 * test can drive with any DOM.
 */
export function relocate(
  descriptor: ElementDescriptor | undefined,
  candidates: readonly Element[],
): Relocation {
  if (descriptor === undefined) return { ok: false, refusal: 'NOT_REMEMBERED', matches: 0 };

  const name = comparable(descriptor.name);
  // A nameless descriptor would match on role, which on a page of buttons is
  // every button. `describeActedOn` refuses to describe a nameless element for
  // the same reason.
  if (name.length === 0) return { ok: false, refusal: 'NOT_IDENTIFIABLE', matches: 0 };

  const role = descriptor.role.trim().toLowerCase();
  const matched = candidates.filter(
    (candidate) =>
      roleOf(candidate).trim().toLowerCase() === role &&
      comparable(accessibleName(candidate)) === name,
  );

  if (matched.length === 0) return { ok: false, refusal: 'GONE', matches: 0 };
  if (matched.length > 1) {
    return { ok: false, refusal: 'AMBIGUOUS', matches: matched.length };
  }
  return { ok: true, element: matched[0]! };
}

/**
 * What to tell the model when relocation did not succeed.
 *
 * Distinct sentences, because the three refusals ask for different things and
 * one message would send the model to do the wrong one. `AMBIGUOUS` in
 * particular must not read as "try again" — the page has two of these now, and
 * what is needed is a fresh read so the model can choose.
 */
export function relocationMessage(refusal: RelocationRefusal, matches: number): string {
  switch (refusal) {
    case 'GONE':
      return (
        'This element handle is from an earlier snapshot and the element is no longer on the ' +
        'page. Read the page again to get current handles.'
      );
    case 'AMBIGUOUS':
      return (
        `This element handle is from an earlier snapshot, and ${matches} elements on the page ` +
        'now share its role and name. Read the page again and choose between them.'
      );
    case 'NOT_IDENTIFIABLE':
    case 'NOT_REMEMBERED':
      return (
        'This element handle is from an earlier snapshot of the page. Read the page again to ' +
        'get current handles.'
      );
  }
}
