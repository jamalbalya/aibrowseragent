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

export interface SiteRule {
  readonly site: string;
  readonly decision: SiteDecision;
  /** Highest risk this standing approval covers. Higher risks still prompt. */
  readonly maxRisk: RiskLevel;
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
