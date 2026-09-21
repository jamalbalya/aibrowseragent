import type { AgentTask, TaskStep } from '@/tasks/task-model';
import { isTerminal } from '@/tasks/task-model';
import { EvidenceList } from './EvidenceList';

interface TaskViewProps {
  readonly task: AgentTask | null;
  readonly activity: string | null;
  readonly onPause: (taskId: string) => void;
  readonly onResume: (taskId: string) => void;
  readonly onCancel: (taskId: string) => void;
  readonly onRetry: (taskId: string) => void;
}

/**
 * Task view.
 *
 * Renders what actually happened: each tool call with its real outcome. A step
 * that failed is shown as failed — the UI never summarises a failed run as a
 * success (specification sections 39, 76).
 */
export function TaskView({
  task,
  activity,
  onPause,
  onResume,
  onCancel,
  onRetry,
}: TaskViewProps): React.JSX.Element {
  if (!task) {
    return (
      <div className="empty">
        <p>No task yet.</p>
        <p className="empty__hint">
          Describe what you want done on the current page, for example:{' '}
          <em>Read this page and summarise it.</em>
        </p>
      </div>
    );
  }

  const finished = isTerminal(task.state);
  const running = !finished && task.state !== 'PAUSED';

  return (
    <section className="task">
      <header className="task__header">
        <p className="task__objective">{task.objective}</p>
        <span className={`badge badge--${task.state.toLowerCase()}`}>{task.state}</span>
      </header>

      {running && activity ? (
        <p className="task__activity" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          {activity}…
        </p>
      ) : null}

      {task.currentStepSummary && !finished ? (
        <p className="task__summary">{task.currentStepSummary}</p>
      ) : null}

      <div className="task__controls">
        {running ? (
          <button type="button" className="button" onClick={() => onPause(task.id)}>
            Pause
          </button>
        ) : null}
        {task.state === 'PAUSED' ? (
          <button
            type="button"
            className="button button--primary"
            onClick={() => onResume(task.id)}
          >
            Resume
          </button>
        ) : null}
        {!finished ? (
          <button type="button" className="button button--danger" onClick={() => onCancel(task.id)}>
            Stop
          </button>
        ) : (
          <button type="button" className="button" onClick={() => onRetry(task.id)}>
            Retry
          </button>
        )}
      </div>

      {task.steps.length > 0 ? (
        <ol className="steps">
          {task.steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ol>
      ) : null}

      {task.result ? <ResultPanel task={task} /> : null}

      {finished ? <EvidenceList taskId={task.id} /> : null}

      {task.error && !task.result ? (
        <div className="result result--failed">
          <h3>Failed</h3>
          <p>{task.error.userMessage}</p>
        </div>
      ) : null}

      <footer className="task__usage">
        {task.usage.toolCalls} tool calls · {task.usage.modelRequests} model requests
        {task.usage.promptTokens + task.usage.completionTokens > 0
          ? ` · ${task.usage.promptTokens + task.usage.completionTokens} tokens`
          : ''}
      </footer>
    </section>
  );
}

function StepRow({ step }: { readonly step: TaskStep }): React.JSX.Element {
  return (
    <li className={`step step--${step.status}`}>
      <span className="step__icon" aria-hidden="true">
        {stepIcon(step.status)}
      </span>
      <span className="step__body">
        {step.tool ? <code className="step__tool">{step.tool}</code> : null}
        <span className="step__summary">{step.summary}</span>
        {step.error ? <span className="step__error">{step.error.userMessage}</span> : null}
        {step.evidenceIds && step.evidenceIds.length > 0 ? (
          <span className="step__evidence">
            {step.evidenceIds.length} evidence item{step.evidenceIds.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </span>
    </li>
  );
}

function stepIcon(status: TaskStep['status']): string {
  switch (status) {
    case 'success':
      return '✓';
    case 'error':
      return '✕';
    case 'denied':
      return '⊘';
    case 'cancelled':
      return '–';
    case 'pending':
      return '·';
  }
}

function ResultPanel({ task }: { readonly task: AgentTask }): React.JSX.Element | null {
  const result = task.result;
  if (!result) return null;

  return (
    <div className={`result result--${result.outcome.toLowerCase()}`}>
      <h3>{result.outcome}</h3>
      <p className="result__summary">{result.summary}</p>

      {result.failedActions.length > 0 ? (
        <details>
          <summary>{result.failedActions.length} action(s) failed</summary>
          <ul>
            {result.failedActions.map((action, index) => (
              <li key={`${action}-${index}`}>{action}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {result.blockedActions.length > 0 ? (
        <details>
          <summary>{result.blockedActions.length} action(s) blocked</summary>
          <ul>
            {result.blockedActions.map((action, index) => (
              <li key={`${action}-${index}`}>{action}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
