import type { PermissionRequest, PermissionResponse } from '@/policy/permission-engine';
import type { RiskLevel } from '@/policy/risk-classifier';
import { RISK_DESCRIPTIONS } from '@/policy/risk-classifier';
import { clampToGrantable, isGrantableRisk, type GrantableRiskLevel } from '@/policy/site-policy';

interface PermissionPromptProps {
  readonly request: PermissionRequest;
  /**
   * True when the task this prompt belongs to is running under an approved
   * plan, which is the only case where "allow for this task" means anything.
   *
   * A display decision, not a security one: the worker amends a plan that
   * exists and does nothing where there is none, so a stale `true` here
   * approves the action and widens nothing.
   */
  readonly planned?: boolean;
  readonly onRespond: (requestId: string, response: PermissionResponse) => void;
}

/**
 * Approval prompt.
 *
 * Shows what will run, where, and why approval is needed. "Always allow on
 * this site" is offered only for ordinary actions — an elevated request
 * (private data leaving its source) is one-off by design, because a standing
 * grant is exactly what an injected page would try to obtain.
 */
export function PermissionPrompt({
  request,
  planned,
  onRespond,
}: PermissionPromptProps): React.JSX.Element {
  return (
    <section className={`prompt ${request.elevated ? 'prompt--elevated' : ''}`}>
      <header className="prompt__header">
        <h2 className="prompt__title">
          {request.elevated ? 'Sensitive action needs approval' : 'Approval needed'}
        </h2>
        <span className={`risk risk--${request.risk}`} title={RISK_DESCRIPTIONS[request.risk]}>
          {request.risk}
        </span>
      </header>

      <p className="prompt__reason">{request.reason}</p>

      <dl className="prompt__details">
        <div>
          <dt>Action</dt>
          <dd>
            <code>{request.summary}</code>
          </dd>
        </div>
        {request.site ? (
          <div>
            <dt>Site</dt>
            <dd>{request.site}</dd>
          </div>
        ) : null}
      </dl>

      <div className="prompt__actions">
        <button
          type="button"
          className="button button--primary"
          onClick={() => onRespond(request.id, { kind: 'approve_once' })}
        >
          Allow once
        </button>

        {/* Offered before the standing grant, because it is the narrower of
            the two and the one most answers want: this site, this task, gone
            when the task is. Gated on the same risk bound: a plan stops at R2,
            so on an R3 prompt this would widen the plan without covering the
            action in front of the person. */}
        {planned && request.site && !request.elevated && isGrantableRisk(request.risk) ? (
          <button
            type="button"
            className="button"
            data-testid="approve-task-site"
            onClick={() => onRespond(request.id, { kind: 'approve_task' })}
          >
            Allow {request.site} for this task
          </button>
        ) : null}

        {/* Offered only where a grant could actually cover the action being
            asked about. A standing grant stops at R2, so on an R3 prompt the
            button would write a rule that does not cover this download, this
            tab close, or this cross-site write — and the same prompt would
            appear again next time. A control that reads as "stop asking me"
            and does not is worse than no control. */}
        {request.site && !request.elevated && isGrantableRisk(request.risk) ? (
          <button
            type="button"
            className="button"
            onClick={() =>
              onRespond(request.id, {
                kind: 'approve_site',
                maxRisk: capForSite(request.risk),
              })
            }
          >
            Always allow on {request.site}
          </button>
        ) : null}

        <button
          type="button"
          className="button button--danger"
          onClick={() => onRespond(request.id, { kind: 'deny' })}
        >
          Decline
        </button>
      </div>

      {request.elevated ? (
        <p className="prompt__note">
          This action sends data collected from another source. A standing approval is not offered
          for actions like this.
        </p>
      ) : null}
    </section>
  );
}

/**
 * A standing site approval never covers more than R2.
 * R3 and above always re-prompt (specification section 26).
 *
 * The clamp lives in the policy module now, so the panel and the engine cannot
 * disagree about what a grant is allowed to say.
 */
function capForSite(risk: RiskLevel): GrantableRiskLevel {
  return clampToGrantable(risk);
}
