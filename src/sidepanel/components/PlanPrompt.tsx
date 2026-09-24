import { useState } from 'react';
import { MAX_REVISION_NOTE, type PlanProposal } from '@/policy/plan-model';

interface PlanPromptProps {
  readonly proposal: PlanProposal;
  readonly onApprove: () => void;
  readonly onRevise: (note: string) => void;
}

/**
 * The plan a Classic task proposes, in front of the person who decides.
 *
 * Two answers, and they are not symmetric. Approving creates the task's
 * authorization; asking for changes creates nothing at all — it sends the
 * proposal back and the task plans again, with no site approved and no
 * security state widened in the meantime.
 *
 * The approach text is model output and is rendered as text. It is shown
 * because a person deciding whether to approve a boundary deserves to read
 * what the agent says it will do inside it — not because anything enforces it.
 * The site list is the part that is enforced, so it is the part shown plainly,
 * one site per line, rather than summarised into a sentence.
 */
export function PlanPrompt({ proposal, onApprove, onRevise }: PlanPromptProps): React.JSX.Element {
  const [changing, setChanging] = useState(false);
  const [note, setNote] = useState('');

  return (
    <section className="prompt prompt--plan" data-testid="plan-prompt">
      <header className="prompt__header">
        <h2 className="prompt__title">Approve the plan</h2>
      </header>

      <p className="prompt__reason">{proposal.approachText}</p>

      <dl className="prompt__details">
        <div>
          <dt>Sites</dt>
          <dd>
            {proposal.proposedSites.length === 0 ? (
              // Honest rather than reassuring: an empty list is not "anywhere",
              // it is "nothing approved up front", and every changing action
              // will ask.
              <span className="prompt__note">
                No sites yet. The agent will ask before acting on each one.
              </span>
            ) : (
              <ul className="prompt__sites" data-testid="plan-sites">
                {proposal.proposedSites.map((site) => (
                  <li key={site}>{site}</li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>

      {changing ? (
        <div className="prompt__revision">
          <label className="prompt__label" htmlFor="plan-note">
            What should change?
          </label>
          <textarea
            id="plan-note"
            className="composer__input"
            rows={2}
            maxLength={MAX_REVISION_NOTE}
            value={note}
            placeholder="Optional. For example: use a different site, or skip the second step."
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      ) : null}

      <div className="prompt__actions">
        {changing ? (
          <>
            <button
              type="button"
              className="button button--primary"
              data-testid="plan-send-changes"
              onClick={() => {
                setChanging(false);
                onRevise(note.trim());
                setNote('');
              }}
            >
              Plan again
            </button>
            <button type="button" className="button" onClick={() => setChanging(false)}>
              Back
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="button button--primary"
              data-testid="plan-approve"
              onClick={onApprove}
            >
              Approve plan
            </button>
            <button
              type="button"
              className="button"
              data-testid="plan-make-changes"
              onClick={() => setChanging(true)}
            >
              Make changes
            </button>
          </>
        )}
      </div>

      <p className="prompt__note">
        Approving lets the agent work on these sites for this task only. Payments, account changes,
        sensitive details and anything unexpected still stop and ask.
      </p>
    </section>
  );
}
