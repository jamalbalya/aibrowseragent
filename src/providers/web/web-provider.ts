/**
 * Authenticated web provider foundation (Stage 3 D1–D3).
 *
 * This is the part of the web-provider story that can be built without
 * opening the inference gate: knowing which provider a tab belongs to,
 * knowing whether the user is signed in, and pausing a task while they sign
 * in themselves.
 *
 * **There is no inference here.** Nothing in this module reads a model reply,
 * submits a prompt, or treats a provider's interface as an API. D4 and D5
 * remain closed; this exists so that when they are opened there is already a
 * correct identity and authentication model underneath them, rather than one
 * invented in the same change that starts sending data.
 *
 * Identity is decided by explicit user selection, corroborated by origin. It
 * is never inferred from page content: any site can render something that
 * looks like an AI chat, and "this page has a message list and a text box"
 * would make provider impersonation a matter of writing convincing markup.
 */

import { parseOrigin } from '@/security/origin/origin-validator';
import type { ProviderKind, ProviderStateReason } from '@/providers/core/provider-kind';

/**
 * A registered web provider.
 *
 * Deliberately data, not code. Adding a provider is a registry entry with an
 * origin and a couple of landmark selectors; it is not a bespoke integration,
 * and no provider gets a code path of its own in the core.
 */
export interface WebProviderDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly kind: Extract<ProviderKind, 'web'>;
  /** Canonical origins this provider legitimately serves from. */
  readonly origins: readonly string[];
  /** Where to send the user to sign in. Must be one of `origins`. */
  readonly loginUrl: string;
  /**
   * Coarse page landmarks used only to tell "signed in" from "signed out".
   *
   * Selectors, never values. Nothing here may address a password field, a
   * one-time-code field, or any input whose contents are secret — the rule is
   * enforced by `validateWebProvider`, not left to reviewer discipline.
   */
  readonly signedInLandmarks: readonly string[];
  readonly signedOutLandmarks: readonly string[];
}

/**
 * Selectors that must never appear in a landmark.
 *
 * A landmark answers a yes/no question about page structure. The moment it can
 * address a credential field, the detection mechanism becomes a way to observe
 * one, and the boundary in the privacy statement stops being true.
 */
const FORBIDDEN_LANDMARK_PATTERNS: readonly RegExp[] = [
  /type\s*=\s*["']?password/i,
  /\bpassword\b/i,
  /\bpasswd\b/i,
  /\botp\b/i,
  /one[-_]?time/i,
  /\bmfa\b/i,
  /\b2fa\b/i,
  /\btotp\b/i,
  /verification[-_]?code/i,
  /\bsecret\b/i,
  /\btoken\b/i,
  /autocomplete\s*=\s*["']?current-password/i,
];

export interface ValidationProblem {
  readonly field: string;
  readonly detail: string;
}

/**
 * Validates a definition before it can be registered.
 *
 * Registration-time rather than use-time on purpose: a provider whose
 * landmarks could read a password should never become registrable, so the
 * failure happens when someone writes the entry rather than when a user runs
 * a task.
 */
export function validateWebProvider(
  definition: WebProviderDefinition,
): readonly ValidationProblem[] {
  const problems: ValidationProblem[] = [];

  if (definition.id.trim().length === 0) {
    problems.push({ field: 'id', detail: 'A provider id is required.' });
  }
  if (definition.origins.length === 0) {
    problems.push({ field: 'origins', detail: 'At least one origin is required.' });
  }

  for (const origin of definition.origins) {
    const parsed = parseOrigin(origin);
    if (!parsed) {
      problems.push({ field: 'origins', detail: `"${origin}" is not a usable origin.` });
      continue;
    }
    if (parsed.protocol !== 'https:') {
      problems.push({
        field: 'origins',
        detail: `"${origin}" is not https. A provider session must not be driven over http.`,
      });
    }
  }

  const loginOrigin = parseOrigin(definition.loginUrl);
  if (!loginOrigin) {
    problems.push({ field: 'loginUrl', detail: 'The login URL is not a usable URL.' });
  } else if (
    !definition.origins.some((o) => canonicalOrigin(o) === loginOrigin.origin.toLowerCase())
  ) {
    // A login URL outside the provider's own origins is how a registry entry
    // becomes a phishing redirect.
    problems.push({
      field: 'loginUrl',
      detail: 'The login URL must be on one of the provider’s own origins.',
    });
  }

  for (const [field, selectors] of [
    ['signedInLandmarks', definition.signedInLandmarks],
    ['signedOutLandmarks', definition.signedOutLandmarks],
  ] as const) {
    for (const selector of selectors) {
      for (const pattern of FORBIDDEN_LANDMARK_PATTERNS) {
        if (pattern.test(selector)) {
          problems.push({
            field,
            detail: `Selector "${selector}" could address credential input and is prohibited.`,
          });
          break;
        }
      }
    }
  }

  return problems;
}

/** `scheme://host[:port]`, lowercased. `null` when it is not a usable origin. */
export function canonicalOrigin(url: string): string | null {
  const parsed = parseOrigin(url);
  return parsed ? parsed.origin.toLowerCase() : null;
}

export type OriginMatch = 'match' | 'mismatch' | 'unknown';

/**
 * Compares a tab's URL against the provider the user selected.
 *
 * Selection is authoritative and this only corroborates it. A mismatch is not
 * a reason to go looking for which provider the page "really" is — that search
 * is exactly the page-content guessing this design refuses.
 */
export function corroborateOrigin(
  definition: WebProviderDefinition,
  tabUrl: string | undefined,
): OriginMatch {
  if (tabUrl === undefined) return 'unknown';
  const actual = canonicalOrigin(tabUrl);
  if (actual === null) return 'unknown';
  const permitted = definition.origins.map(canonicalOrigin).filter((o): o is string => o !== null);
  return permitted.includes(actual) ? 'match' : 'mismatch';
}

/**
 * The coarse observation the extension is allowed to make about a tab.
 *
 * Presence or absence of landmarks and the settled URL. No field values, no
 * storage, no cookies — the shape of this type is the limit of what detection
 * may consider, and there is nowhere in it to put a secret.
 */
export interface AuthSignal {
  readonly tabUrl?: string;
  readonly signedInLandmarkFound?: boolean;
  readonly signedOutLandmarkFound?: boolean;
  /** True once navigation has stopped; a mid-flight page proves nothing. */
  readonly settled: boolean;
  readonly tabClosed?: boolean;
}

export interface AuthAssessment {
  readonly authenticated: boolean;
  readonly reason: ProviderStateReason;
}

/**
 * Decides whether a signed-in state can be confirmed.
 *
 * Every uncertain case resolves to "not authenticated". The cost of that is a
 * task that stays paused and a user who is asked to sign in again; the cost of
 * the opposite is a task proceeding against a provider it only assumed was
 * ready. Those are not comparable, so the function never guesses.
 */
export function assessAuthentication(
  definition: WebProviderDefinition,
  signal: AuthSignal,
): AuthAssessment {
  if (signal.tabClosed === true) {
    return { authenticated: false, reason: 'tab_closed' };
  }
  if (!signal.settled) {
    return { authenticated: false, reason: 'ambiguous_signal' };
  }

  const origin = corroborateOrigin(definition, signal.tabUrl);
  if (origin === 'mismatch') return { authenticated: false, reason: 'origin_changed' };
  if (origin === 'unknown') return { authenticated: false, reason: 'ambiguous_signal' };

  // Both or neither is not an answer. Treating "both" as signed in would let a
  // transitional page — one still showing a sign-in prompt beside the app
  // shell — be read as success.
  if (signal.signedInLandmarkFound === true && signal.signedOutLandmarkFound === true) {
    return { authenticated: false, reason: 'ambiguous_signal' };
  }
  if (signal.signedOutLandmarkFound === true) {
    return { authenticated: false, reason: 'no_session' };
  }
  if (signal.signedInLandmarkFound === true) {
    return { authenticated: true, reason: 'authenticated' };
  }

  return { authenticated: false, reason: 'ambiguous_signal' };
}

/**
 * Registry of web providers.
 *
 * Empty in this wave. The type exists, the validation exists, and nothing is
 * registered: registering a provider is the D5 step, and it requires that
 * provider's terms to have been verified first.
 */
export class WebProviderRegistry {
  private readonly providers = new Map<string, WebProviderDefinition>();

  register(definition: WebProviderDefinition): void {
    const problems = validateWebProvider(definition);
    if (problems.length > 0) {
      const detail = problems.map((p) => `${p.field}: ${p.detail}`).join('; ');
      throw new Error(`Web provider "${definition.id}" is not registrable — ${detail}`);
    }
    if (this.providers.has(definition.id)) {
      throw new Error(`Web provider "${definition.id}" is already registered.`);
    }
    this.providers.set(definition.id, definition);
  }

  get(id: string): WebProviderDefinition | undefined {
    return this.providers.get(id);
  }

  list(): WebProviderDefinition[] {
    return [...this.providers.values()];
  }

  /**
   * Resolves a provider from an explicit selection.
   *
   * There is no lookup by origin on purpose. Answering "which provider is this
   * page?" from the page is the inference this design rejects; the caller must
   * say which provider it means, and the origin is then checked against it.
   */
  resolveSelected(selectedId: string | undefined): WebProviderDefinition | undefined {
    if (selectedId === undefined) return undefined;
    return this.providers.get(selectedId);
  }
}
