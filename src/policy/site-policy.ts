/**
 * Site-level permission state (specification section 26).
 *
 * Decisions are stored per *site* (registrable domain) rather than per origin
 * so that a user approving `app.example.com` is not re-prompted for
 * `www.example.com`, while `evil.com` stays separate.
 */
import { siteOf, parseOrigin } from '@/security/origin/origin-validator';
import type { RiskLevel } from './risk-classifier';

export type SiteDecision = 'allow' | 'block';

/**
 * The risks a standing site approval is able to cover.
 *
 * Narrower than `RiskLevel`, and narrowed for a reason that is a fact about
 * the engine rather than a preference: `evaluatePolicy` returns at its R3
 * floor before it ever reaches the branch that consults a site rule, so a
 * stored grant of R3 or above has never been honoured and never could be. A
 * type that could express one was a type that described an authority the
 * product does not have — and a rule sitting in storage saying "allow up to
 * R4" reads, to anyone auditing it, as though it did.
 */
export type GrantableRiskLevel = Extract<RiskLevel, 'R0' | 'R1' | 'R2'>;

/** The highest risk a standing grant may carry. */
export const MAX_GRANTABLE_RISK: GrantableRiskLevel = 'R2';

export function isGrantableRisk(risk: RiskLevel): risk is GrantableRiskLevel {
  return risk === 'R0' || risk === 'R1' || risk === 'R2';
}

/** Lowers a risk to what a grant may express. Never raises one. */
export function clampToGrantable(risk: RiskLevel): GrantableRiskLevel {
  return isGrantableRisk(risk) ? risk : MAX_GRANTABLE_RISK;
}

export interface SiteRule {
  readonly site: string;
  readonly decision: SiteDecision;
  /** Highest risk this standing approval covers. Higher risks still prompt. */
  readonly maxRisk: GrantableRiskLevel;
  readonly createdAt: number;
  readonly note?: string;
}

export interface PermissionHistoryEntry {
  readonly id: string;
  readonly taskId: string;
  readonly tool: string;
  readonly site: string;
  readonly risk: RiskLevel;
  readonly decision: 'approved' | 'denied' | 'auto_approved' | 'blocked';
  readonly timestamp: number;
  readonly reason: string;
}

export interface SitePolicyState {
  readonly rules: readonly SiteRule[];
  readonly history: readonly PermissionHistoryEntry[];
}

export const emptySitePolicyState = (): SitePolicyState => ({ rules: [], history: [] });

export function siteForUrl(url: string): string | null {
  const info = parseOrigin(url);
  return info ? info.site : null;
}

/** Finds the rule governing a URL, if any. Blocks take precedence over allows. */
export function findRule(state: SitePolicyState, url: string): SiteRule | null {
  const site = siteForUrl(url);
  if (!site) return null;
  const matches = state.rules.filter((rule) => rule.site === site);
  return matches.find((r) => r.decision === 'block') ?? matches[0] ?? null;
}

/**
 * Repairs rules read back from storage.
 *
 * The type above stops new rules carrying more than R2. It says nothing about
 * rules already on disk, written when the field was a plain `RiskLevel`, or
 * about a record an import supplied. Those are clamped down rather than
 * discarded: the user approved that site, and dropping the rule would silently
 * revoke a decision they made, while clamping keeps the decision and removes
 * only the part of it the engine was never going to honour anyway.
 *
 * `block` rules are untouched by the clamp. A block is a denial, and its
 * `maxRisk` bounds nothing.
 */
export function sanitiseSitePolicyState(state: SitePolicyState): SitePolicyState {
  let changed = false;
  const rules = state.rules.map((rule) => {
    if (isGrantableRisk(rule.maxRisk)) return rule;
    changed = true;
    return { ...rule, maxRisk: MAX_GRANTABLE_RISK };
  });
  return changed ? { ...state, rules } : state;
}

export function upsertRule(state: SitePolicyState, rule: SiteRule): SitePolicyState {
  const normalised: SiteRule = { ...rule, site: siteOf(rule.site) };
  return {
    ...state,
    rules: [...state.rules.filter((r) => r.site !== normalised.site), normalised],
  };
}

export function removeRule(state: SitePolicyState, site: string): SitePolicyState {
  const target = siteOf(site);
  return { ...state, rules: state.rules.filter((r) => r.site !== target) };
}

const MAX_HISTORY = 500;

export function appendHistory(
  state: SitePolicyState,
  entry: PermissionHistoryEntry,
): SitePolicyState {
  const history = [...state.history, entry];
  return {
    ...state,
    history: history.length > MAX_HISTORY ? history.slice(-MAX_HISTORY) : history,
  };
}
