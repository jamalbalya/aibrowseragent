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

export interface PermissionRequest {
  readonly id: string;
  readonly taskId: string;
  readonly tool: string;
  readonly risk: RiskLevel;
  readonly reason: string;
  readonly targetUrl?: string;
  readonly site: string | null;
  readonly summary: string;
  readonly createdAt: number;
  /** True when the action moves private data outward. */
  readonly elevated: boolean;
}

export type PermissionResponse =
  | { readonly kind: 'approve_once' }
  | { readonly kind: 'approve_site'; readonly maxRisk: GrantableRiskLevel }
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
  readonly now?: () => number;
}

export interface RequestApprovalInput {
  readonly taskId: string;
  readonly tool: string;
  readonly decision: PolicyDecision;
  readonly summary: string;
  readonly targetUrl?: string;
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
      site: input.targetUrl ? siteForUrl(input.targetUrl) : null,
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

    if (response.kind === 'approve_site' && input.targetUrl) {
      const site = siteForUrl(input.targetUrl);
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
