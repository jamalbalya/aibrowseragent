import type { PermissionRequest, PermissionResponse } from '@/policy/permission-engine';
import type { RiskLevel } from '@/policy/risk-classifier';
import { RISK_DESCRIPTIONS } from '@/policy/risk-classifier';

interface PermissionPromptProps {
  readonly request: PermissionRequest;
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
export function PermissionPrompt({ request, onRespond }: PermissionPromptProps): React.JSX.Element {
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

        {request.site && !request.elevated ? (
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
 */
function capForSite(risk: RiskLevel): RiskLevel {
  return risk === 'R0' || risk === 'R1' ? risk : 'R2';
}
