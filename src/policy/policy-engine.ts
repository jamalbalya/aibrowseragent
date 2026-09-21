/**
 * Policy engine (specification sections 17, 24).
 *
 * The single authority that decides whether a proposed tool call may run. It
 * consumes only facts the runtime observed — never model assertions — and its
 * output is one of ALLOW / ALLOW_WITH_CONFIRMATION / DENY.
 *
 * Evaluation order matters and is fixed:
 *   hard prohibition → site block → origin → exfiltration → risk/permission mode
 * Each stage can only make the decision stricter.
 */
import {
  type RiskLevel,
  type ProhibitedCategory,
  PROHIBITED_DESCRIPTIONS,
  RISK_RANK,
  maxRisk,
} from './risk-classifier';
import { checkNavigable, evaluateTransition } from '@/security/origin/origin-validator';
import {
  evaluateExfiltration,
  type ExfiltrationDecision,
} from '@/security/exfiltration/exfiltration-guard';
import { taintSources, unknownTaint, type TaintState } from '@/security/taint/taint-state';
import { findRule, type SitePolicyState } from './site-policy';

export type PolicyVerdict = 'ALLOW' | 'ALLOW_WITH_CONFIRMATION' | 'DENY';

/** Permission modes (specification section 25). */
export const PERMISSION_MODES = ['manual', 'auto', 'skip'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface PolicyRequest {
  readonly tool: string;
  readonly taskId: string;
  readonly risk: RiskLevel;
  /** Hard-prohibited categories this specific call falls into, if any. */
  readonly prohibited?: readonly ProhibitedCategory[];
  /** URL the tool will act on. Absent for tools with no page target. */
  readonly targetUrl?: string;
  /** URL recorded when the action was planned, for origin-drift detection. */
  readonly plannedUrl?: string;
  /** Destination for an outbound write, if this call sends data somewhere. */
  readonly writeDestination?: string;
  readonly writePayload?: unknown;
  readonly taintState?: TaintState;
}

export interface PolicyContext {
  readonly mode: PermissionMode;
  readonly sitePolicy: SitePolicyState;
  readonly allowInsecureOrigins?: boolean;
}

export interface PolicyDecision {
  readonly verdict: PolicyVerdict;
  /** Machine-readable reason, stable for tests and audit. */
  readonly code: PolicyDecisionCode;
  /** Human-readable explanation shown in the UI. */
  readonly reason: string;
  readonly effectiveRisk: RiskLevel;
  readonly exfiltration?: ExfiltrationDecision;
}

export type PolicyDecisionCode =
  | 'PROHIBITED_ACTION'
  | 'SITE_BLOCKED'
  | 'ORIGIN_NOT_AUTOMATABLE'
  | 'ORIGIN_CHANGED'
  | 'EXFILTRATION_BLOCKED'
  | 'EXFILTRATION_CONFIRM'
  | 'RISK_REQUIRES_APPROVAL'
  | 'MODE_REQUIRES_APPROVAL'
  | 'SITE_ALLOWED'
  | 'LOW_RISK'
  | 'MODE_SKIP';

/**
 * Risk at or above this level always requires explicit confirmation, in every
 * permission mode including `skip`. This is the hard floor referenced by
 * specification section 18: Auto is not "unrestricted".
 */
export const ALWAYS_CONFIRM_AT: RiskLevel = 'R3';

/** Risk at or above this level is refused outright. */
export const ALWAYS_DENY_AT: RiskLevel = 'R5';

/** In `auto` mode, risk strictly below this runs without a prompt. */
export const AUTO_APPROVE_BELOW: RiskLevel = 'R2';

export function evaluatePolicy(request: PolicyRequest, context: PolicyContext): PolicyDecision {
  let effectiveRisk = request.risk;

  // 1. Hard prohibitions. Nothing downstream can unlock these.
  if (request.prohibited && request.prohibited.length > 0) {
    const first = request.prohibited[0] as ProhibitedCategory;
    return {
      verdict: 'DENY',
      code: 'PROHIBITED_ACTION',
      reason: `Blocked by a hard safety rule: ${PROHIBITED_DESCRIPTIONS[first]}`,
      effectiveRisk: 'R5',
    };
  }
  if (RISK_RANK[effectiveRisk] >= RISK_RANK[ALWAYS_DENY_AT]) {
    return {
      verdict: 'DENY',
      code: 'PROHIBITED_ACTION',
      reason: 'This action is classified as prohibited and is never executed.',
      effectiveRisk,
    };
  }

  // 2. Site-level block, and origin automatability.
  if (request.targetUrl) {
    const rule = findRule(context.sitePolicy, request.targetUrl);
    if (rule?.decision === 'block') {
      return {
        verdict: 'DENY',
        code: 'SITE_BLOCKED',
        reason: `${rule.site} is on the blocked-sites list.`,
        effectiveRisk,
      };
    }

    const navigable = checkNavigable(
      request.targetUrl,
      context.allowInsecureOrigins === undefined
        ? {}
        : { allowInsecure: context.allowInsecureOrigins },
    );
    if (!navigable.allowed) {
      return {
        verdict: 'DENY',
        code: 'ORIGIN_NOT_AUTOMATABLE',
        reason: navigable.detail ?? 'This page cannot be automated.',
        effectiveRisk,
      };
    }

    // 3. Origin drift between planning and execution.
    if (request.plannedUrl) {
      const transition = evaluateTransition(request.plannedUrl, request.targetUrl);
      if (transition.requiresRevalidation) {
        // Read-only actions tolerate drift; anything with a side effect does not.
        if (RISK_RANK[effectiveRisk] >= RISK_RANK.R1) {
          return {
            verdict: 'ALLOW_WITH_CONFIRMATION',
            code: 'ORIGIN_CHANGED',
            reason:
              `The page moved from ${transition.from} to ${transition.to} ` +
              `(${transition.relation}) after this action was planned. Confirm before continuing.`,
            effectiveRisk: maxRisk(effectiveRisk, 'R2'),
          };
        }
        effectiveRisk = maxRisk(effectiveRisk, 'R1');
      }
    }
  }

  // 4. Outbound data movement.
  let exfiltration: ExfiltrationDecision | undefined;
  if (request.writeDestination !== undefined) {
    exfiltration = evaluateExfiltration({
      destination: request.writeDestination,
      payload: request.writePayload,
      taint: taintSources(request.taintState ?? unknownTaint('field-absent')),
    });
    if (exfiltration.verdict === 'block') {
      return {
        verdict: 'DENY',
        code: 'EXFILTRATION_BLOCKED',
        reason: exfiltration.reason,
        effectiveRisk: 'R4',
        exfiltration,
      };
    }
    if (exfiltration.verdict === 'confirm') {
      return {
        verdict: 'ALLOW_WITH_CONFIRMATION',
        code: 'EXFILTRATION_CONFIRM',
        reason: exfiltration.reason,
        effectiveRisk: maxRisk(effectiveRisk, 'R3'),
        exfiltration,
      };
    }
  }

  // 5. Risk floor that applies in every mode.
  const base = (code: PolicyDecisionCode, reason: string): PolicyDecision =>
    exfiltration === undefined
      ? { verdict: 'ALLOW_WITH_CONFIRMATION', code, reason, effectiveRisk }
      : { verdict: 'ALLOW_WITH_CONFIRMATION', code, reason, effectiveRisk, exfiltration };

  if (RISK_RANK[effectiveRisk] >= RISK_RANK[ALWAYS_CONFIRM_AT]) {
    return base(
      'RISK_REQUIRES_APPROVAL',
      'This action has a sensitive external side effect and always requires approval.',
    );
  }

  // 6. Permission mode.
  const allow = (code: PolicyDecisionCode, reason: string): PolicyDecision =>
    exfiltration === undefined
      ? { verdict: 'ALLOW', code, reason, effectiveRisk }
      : { verdict: 'ALLOW', code, reason, effectiveRisk, exfiltration };

  switch (context.mode) {
    case 'skip':
      return allow('MODE_SKIP', 'Skip mode: no approval prompt. Hard safety rules still applied.');
    case 'manual':
      if (RISK_RANK[effectiveRisk] === RISK_RANK.R0) {
        return allow('LOW_RISK', 'Read-only action.');
      }
      return base('MODE_REQUIRES_APPROVAL', 'Manual mode: every changing action is confirmed.');
    case 'auto': {
      if (RISK_RANK[effectiveRisk] < RISK_RANK[AUTO_APPROVE_BELOW]) {
        return allow('LOW_RISK', 'Low-risk action approved automatically in Auto mode.');
      }
      if (request.targetUrl) {
        const rule = findRule(context.sitePolicy, request.targetUrl);
        if (rule?.decision === 'allow' && RISK_RANK[effectiveRisk] <= RISK_RANK[rule.maxRisk]) {
          return allow(
            'SITE_ALLOWED',
            `${rule.site} is trusted for actions up to ${rule.maxRisk}.`,
          );
        }
      }
      return base('MODE_REQUIRES_APPROVAL', 'Auto mode: this action changes page state.');
    }
  }
}
