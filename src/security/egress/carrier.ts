/**
 * Carrier capacity assessment (Stage 3 B2, roadmap section 4K).
 *
 * Because taint is a property of the task rather than of a value, every
 * navigation a tainted task performs is nominally an egress. Left there the
 * agent would ask for confirmation on every click, and a prompt that always
 * fires is a prompt users learn to dismiss — which is a security failure, not
 * a usability one.
 *
 * So this grades how much task-derived data an action can actually *carry*.
 *
 * It is routing metadata and nothing else. The return type has no allow, deny
 * or confirm in it, and no caller may reach a transfer from this result: it
 * selects which checks run, never whether the transfer happens. Every class
 * still terminates in the gate.
 */

import { parseOrigin } from '@/security/origin/origin-validator';

/**
 * - `none` a URL already seen verbatim in content the task read, unchanged
 * - `low`  same-origin, no query and no fragment
 * - `high` anything that can carry data: query, fragment, added path, form
 *          value, upload, clipboard write, DOM injection
 */
export type CarrierClass = 'none' | 'low' | 'high';

export interface CarrierInput {
  /** Destination URL, when the action navigates. */
  readonly url?: string;
  /** Origin of the page the action starts from. */
  readonly currentUrl?: string;
  /** URLs observed verbatim in content this task has already read. */
  readonly observedUrls?: readonly string[];
  /** True when the action writes a value the model supplied into a page. */
  readonly writesValue?: boolean;
}

/**
 * Classifies an action.
 *
 * Every uncertain case resolves to `high`: an unparseable URL, a missing
 * observed-URL set, an absent current page. Uncertainty here must cost a
 * confirmation, never skip one.
 */
export function assessCarrier(input: CarrierInput): CarrierClass {
  if (input.writesValue === true) return 'high';
  if (input.url === undefined) return 'high';

  const target = parseOrigin(input.url);
  if (!target) return 'high';

  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return 'high';
  }

  // A query string or fragment can carry an arbitrary amount of text, so the
  // presence of either is decisive regardless of where the URL came from.
  const hasPayloadSlot = parsed.search.length > 0 || parsed.hash.length > 0;

  const observed = input.observedUrls ?? [];
  if (!hasPayloadSlot && observed.some((candidate) => sameUrl(candidate, input.url!))) {
    return 'none';
  }

  if (hasPayloadSlot) return 'high';

  // Same-origin with no payload slot: the URL cannot convey task data beyond
  // its path, and the path is already on a site this task is working with.
  if (input.currentUrl !== undefined) {
    const current = parseOrigin(input.currentUrl);
    if (current && current.origin.toLowerCase() === target.origin.toLowerCase()) return 'low';
  }

  // Cross-origin with a path the task was not shown. The path itself is a
  // channel, so this is not `low`.
  return 'high';
}

/** Compares two URLs for the purpose of "was this link already on the page?". */
function sameUrl(a: string, b: string): boolean {
  let left: URL;
  let right: URL;
  try {
    left = new URL(a);
    right = new URL(b);
  } catch {
    return false;
  }
  return (
    left.origin.toLowerCase() === right.origin.toLowerCase() &&
    left.pathname === right.pathname &&
    left.search === right.search &&
    left.hash === right.hash
  );
}

/** Which checks a carrier class requires. Consent is the only variable. */
export function consentRequiredFor(carrier: CarrierClass): boolean {
  return carrier === 'high';
}
