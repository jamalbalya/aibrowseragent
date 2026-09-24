/**
 * Permission engine.
 *
 * Turns an `ALLOW_WITH_CONFIRMATION` policy decision into a concrete approval
 * outcome by asking the user, and records the result in permission history.
 *
 * The engine owns no security logic of its own: it cannot upgrade a DENY, and
 * a pending request that is never answered resolves as denied.
 */
import { newId } from '@/utils/ids';
import { getLogger } from '@/logging/logger';
import type { RiskLevel } from './risk-classifier';
import type { PolicyDecision } from './policy-engine';
import {
  appendHistory,
  upsertRule,
  type GrantableRiskLevel,
  type PermissionHistoryEntry,
  type SitePolicyState,
  siteForUrl,
} from './site-policy';

const log = getLogger('permission');

/**
 * The site a standing grant is written against.
 *
 * One function, used by both the prompt and the write, so the site a person
 * was shown is exactly the site that gets stored. Two derivations would
 * eventually disagree, and the disagreement would be a grant for a site
 * nobody was asked about.
 */
function grantSiteFor(input: {
  readonly siteScopeUrl?: string;
  readonly targetUrl?: string;
}): string | null {
  const url = input.siteScopeUrl ?? input.targetUrl;
  return url ? siteForUrl(url) : null;
}

export interface PermissionRequest {
  readonly id: string;
  readonly taskId: string;
  readonly tool: string;
  readonly risk: RiskLevel;
  readonly reason: string;
  readonly targetUrl?: string;
  /**
   * The site a standing grant would be written against.
   *
   * Distinct from `targetUrl`, which is where a navigation is going. A page
   * action has no destination and still has a site, and offering "always
   * allow" only where a destination exists is what limited standing grants to
   * navigation.
   */
  readonly siteScopeUrl?: string;
  readonly site: string | null;
  readonly summary: string;
  readonly createdAt: number;
  /** True when the action moves private data outward. */
  readonly elevated: boolean;
}

export type PermissionResponse =
  | { readonly kind: 'approve_once' }
  | { readonly kind: 'approve_site'; readonly maxRisk: GrantableRiskLevel }
  /**
   * Approve this site for the rest of this task, and no further.
   *
   * Offered only to a task running under an approved plan, and it adds the
   * site to that plan. Deliberately *not* a weaker `approve_site`: nothing is
   * written to the site policy, so the authorization ends when the task does
   * and no later task inherits it. It carries no `maxRisk` because a plan has
   * one ceiling, fixed in the engine, that a prompt cannot raise.
   */
  | { readonly kind: 'approve_task' }
  | { readonly kind: 'deny' };

export interface PermissionOutcome {
  readonly granted: boolean;
  readonly response: PermissionResponse;
}

/** Presents a request to the user. The side panel supplies the implementation. */
export interface PermissionPrompter {
  prompt(request: PermissionRequest): Promise<PermissionResponse>;
}

/** Denies everything. Used when no UI is attached (e.g. a scheduled run). */
export class DenyAllPrompter implements PermissionPrompter {
  prompt(): Promise<PermissionResponse> {
    return Promise.resolve({ kind: 'deny' });
  }
}

export interface PermissionEngineOptions {
  readonly prompter: PermissionPrompter;
  readonly loadSitePolicy: () => Promise<SitePolicyState>;
  readonly saveSitePolicy: (state: SitePolicyState) => Promise<void>;
  /**
   * Mirrors the decision into the unified audit trail.
   *
   * Optional so the engine can be tested alone. A failure here must not fail
   * the decision: refusing an action because its record could not be written
   * would turn an observability problem into a functional one.
   */
  readonly onDecision?: (entry: PermissionHistoryEntry) => Promise<void>;
  /**
   * Adds a site to a task's approved plan.
   *
   * The engine hands over the site the person was shown and nothing else: it
   * does not build the approval, does not decide whether one exists, and
   * cannot create one where there is none. The worker's implementation amends
   * an existing approval or does nothing, which is what keeps this from being
   * a second route to authorising a task that never planned.
   *
   * Absent in tests and wherever no plan exists; an `approve_task` response
   * then approves this one action and widens nothing, which is the honest
   * reading of a button that could not do what it said.
   */
  readonly amendPlan?: (taskId: string, site: string) => Promise<void>;
  readonly now?: () => number;
}

export interface RequestApprovalInput {
  readonly taskId: string;
  readonly tool: string;
  readonly decision: PolicyDecision;
  readonly summary: string;
  readonly targetUrl?: string;
  /** See `PermissionRequest.siteScopeUrl`. */
  readonly siteScopeUrl?: string;
  readonly signal?: AbortSignal;
}

export class PermissionEngine {
  private readonly now: () => number;

  constructor(private readonly options: PermissionEngineOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Resolves a policy decision into an approval outcome.
   *
   * A DENY is recorded and returned as-is; the engine never asks the user to
   * override a denial.
   */
  async requestApproval(input: RequestApprovalInput): Promise<PermissionOutcome> {
    const { decision } = input;

    if (decision.verdict === 'DENY') {
      await this.record(input, 'blocked', decision.reason);
      return { granted: false, response: { kind: 'deny' } };
    }

    if (decision.verdict === 'ALLOW') {
      await this.record(input, 'auto_approved', decision.reason);
      return { granted: true, response: { kind: 'approve_once' } };
    }

    const request: PermissionRequest = {
      id: newId('perm'),
      taskId: input.taskId,
      tool: input.tool,
      risk: decision.effectiveRisk,
      reason: decision.reason,
      ...(input.targetUrl === undefined ? {} : { targetUrl: input.targetUrl }),
      ...(input.siteScopeUrl === undefined ? {} : { siteScopeUrl: input.siteScopeUrl }),
      // The authorization scope decides which site a standing grant names. It
      // falls back to the navigation destination only because the two
      // coincide for the tools that have both, and because a prompt with no
      // site simply offers no standing grant.
      site: grantSiteFor(input),
      summary: input.summary,
      createdAt: this.now(),
      elevated: decision.code === 'EXFILTRATION_CONFIRM',
    };

    if (input.signal?.aborted) {
      await this.record(input, 'denied', 'Task was cancelled before approval.');
      return { granted: false, response: { kind: 'deny' } };
    }

    let response: PermissionResponse;
    try {
      response = await this.options.prompter.prompt(request);
    } catch (error) {
      log.warn('Permission prompt failed; treating as denial.', {
        tool: input.tool,
        error: error instanceof Error ? error.message : String(error),
      });
      response = { kind: 'deny' };
    }

    if (response.kind === 'deny') {
      await this.record(input, 'denied', 'The user declined this action.');
      return { granted: false, response };
    }

    if (response.kind === 'approve_task') {
      const site = grantSiteFor(input);
      // No site, no amendment — and still an approval of this one action. A
      // prompt with no site offers no standing anything, here or above.
      if (site && this.options.amendPlan) {
        try {
          await this.options.amendPlan(input.taskId, site);
        } catch (error) {
          // The action was approved by a person; failing it now because the
          // plan could not be widened would refuse what they just allowed.
          // The narrower outcome is the safe one: this call runs, the next on
          // the same site asks again.
          log.warn('A site could not be added to the task plan.', {
            taskId: input.taskId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (response.kind === 'approve_site') {
      const site = grantSiteFor(input);
      if (site) {
        const state = await this.options.loadSitePolicy();
        await this.options.saveSitePolicy(
          upsertRule(state, {
            site,
            decision: 'allow',
            maxRisk: response.maxRisk,
            createdAt: this.now(),
            note: `Approved while running ${input.tool}.`,
          }),
        );
      }
    }

    await this.record(input, 'approved', 'The user approved this action.');
    return { granted: true, response };
  }

  private async record(
    input: RequestApprovalInput,
    decision: PermissionHistoryEntry['decision'],
    reason: string,
  ): Promise<void> {
    const entry: PermissionHistoryEntry = {
      id: newId('ph'),
      taskId: input.taskId,
      tool: input.tool,
      site: (input.targetUrl ? siteForUrl(input.targetUrl) : null) ?? '(no site)',
      risk: input.decision.effectiveRisk,
      decision,
      timestamp: this.now(),
      reason,
    };
    const state = await this.options.loadSitePolicy();
    await this.options.saveSitePolicy(appendHistory(state, entry));

    if (this.options.onDecision) {
      try {
        await this.options.onDecision(entry);
      } catch (error) {
        log.warn('Permission decision could not be added to the audit trail.', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    log.debug('Permission decision recorded.', {
      tool: entry.tool,
      decision: entry.decision,
      risk: entry.risk,
    });
  }
}
