import { useState } from 'react';
import { useAgentState } from './state/useAgentState';
import { Header } from './components/Header';
import { PersistenceBanner } from './components/PersistenceBanner';
import { TaskComposer } from './components/TaskComposer';
import { TaskView } from './components/TaskView';
import { PermissionPrompt } from './components/PermissionPrompt';
import { PlanPrompt } from './components/PlanPrompt';
import { FilePrompt } from './components/FilePrompt';
import { SettingsView } from './components/SettingsView';
import { WorkflowsView } from './components/WorkflowsView';
import { SchedulesView } from './components/SchedulesView';
import { AuditView } from './components/AuditView';
import { WelcomeNotice } from './components/WelcomeNotice';

export function App(): React.JSX.Element {
  const agent = useAgentState();
  const [showSettings, setShowSettings] = useState(false);
  const [showWorkflows, setShowWorkflows] = useState(false);
  const [showSchedules, setShowSchedules] = useState(false);
  const [showAudit, setShowAudit] = useState(false);

  // A provider that has not demonstrated tool calling cannot run a task, so
  // the composer is disabled rather than letting the task fail at the first
  // model turn.
  const ready = agent.connection?.capabilities?.toolCalling === true;
  const connected = agent.connection !== null && agent.connection !== undefined;
  // Said in the user's terms rather than the system's. The second case is a
  // real limitation of the model they chose, not of this extension, and the
  // wording keeps that straight without naming the check that found it.
  const disabledReason = !connected
    ? 'Connect an AI account to start.'
    : !ready
      ? 'This AI model has not shown it can use browser actions. Check it in Settings.'
      : undefined;

  // A proposal is shown only while it is still a proposal. Once the task has
  // an approval, the plan is what the run is bounded by rather than something
  // waiting on an answer.
  const activeTaskId = agent.activeTask?.id ?? '';
  const plan =
    agent.activeTask?.state === 'WAITING_FOR_USER' &&
    agent.activeTask.planApproval === undefined &&
    agent.activeTask.planProposal !== undefined
      ? agent.activeTask.planProposal
      : null;

  // Which tasks are running under an approved plan, so a prompt from one can
  // offer "allow for this task". Read from the task records rather than from
  // the prompt, because whether a plan exists is the worker's fact.
  const plannedTaskIds = new Set(
    agent.tasks.filter((task) => task.planApproval !== undefined).map((task) => task.id),
  );

  if (showSettings) {
    return (
      <div className="app">
        <SettingsView
          connection={agent.connection}
          onClose={() => setShowSettings(false)}
          onChanged={() => void agent.refresh()}
        />
      </div>
    );
  }

  if (showAudit) {
    return (
      <div className="app">
        <AuditView
          activeTaskId={agent.activeTask?.id ?? null}
          onClose={() => setShowAudit(false)}
        />
      </div>
    );
  }

  if (showSchedules) {
    return (
      <div className="app">
        <SchedulesView onClose={() => setShowSchedules(false)} />
      </div>
    );
  }

  if (showWorkflows) {
    return (
      <div className="app">
        <WorkflowsView
          activeTaskId={agent.activeTask?.id ?? null}
          onClose={() => setShowWorkflows(false)}
          onReplayStarted={(taskId) => {
            agent.setActiveTaskId(taskId);
            void agent.refresh();
          }}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <Header
        connection={agent.connection}
        permissionMode={agent.permissionMode}
        onChangeMode={(mode) => void agent.changePermissionMode(mode)}
        onOpenSettings={() => setShowSettings(true)}
        onOpenWorkflows={() => setShowWorkflows(true)}
        onOpenSchedules={() => setShowSchedules(true)}
        onOpenAudit={() => setShowAudit(true)}
      />

      {/* Above the task error, because a lost record is a condition rather
          than a failed action, and it stays until someone deals with it. */}
      <PersistenceBanner />

      {agent.error ? (
        <div className="banner banner--error" role="alert">
          <span>{agent.error.userMessage}</span>
          <button type="button" className="button button--ghost" onClick={agent.dismissError}>
            Dismiss
          </button>
        </div>
      ) : null}

      {/* A plan waiting for approval comes before the action prompts: a task
          that has not been authorised at all has no action to approve yet. */}
      {plan ? (
        <PlanPrompt
          proposal={plan}
          onApprove={() => void agent.approvePlan(activeTaskId)}
          onRevise={(note) => void agent.revisePlan(activeTaskId, note)}
        />
      ) : null}

      {agent.permissionRequests.map((request) => (
        <PermissionPrompt
          key={request.id}
          request={request}
          planned={plannedTaskIds.has(request.taskId)}
          onRespond={(requestId, response) => void agent.respondToPermission(requestId, response)}
        />
      ))}

      {agent.fileRequests.map((request) => (
        <FilePrompt
          key={request.id}
          request={request}
          onRespond={(requestId, files) => void agent.respondToFileRequest(requestId, files)}
        />
      ))}

      <main className="main">
        {/* Only until an AI account exists. A standing explanation of what the
            product is would become a standing apology for what it is not. */}
        {!agent.loading && !connected ? (
          <WelcomeNotice onConnect={() => setShowSettings(true)} />
        ) : null}

        {agent.loading ? (
          <p className="empty">Loading…</p>
        ) : (
          <TaskView
            task={agent.activeTask}
            activity={agent.activity}
            onPause={(id) => void agent.pauseTask(id)}
            onResume={(id) => void agent.resumeTask(id)}
            onCancel={(id) => void agent.cancelTask(id)}
            onRetry={(id) => void agent.retryTask(id)}
          />
        )}

        {agent.tasks.length > 1 ? (
          <section className="history">
            <h2 className="history__title">Recent tasks</h2>
            <ul className="history__list">
              {agent.tasks.slice(0, 10).map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    className={`history__item ${task.id === agent.activeTask?.id ? 'history__item--active' : ''}`}
                    onClick={() => agent.setActiveTaskId(task.id)}
                  >
                    <span className="history__objective">{task.objective}</span>
                    <span className={`badge badge--${task.state.toLowerCase()}`}>{task.state}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>

      <TaskComposer
        disabled={!ready}
        {...(disabledReason === undefined ? {} : { disabledReason })}
        onSubmit={(objective, authorizationModel) =>
          void agent.startTask(objective, authorizationModel)
        }
        onRunShortcut={async (resolution) => {
          // The shortcut is spent here: what runs is the route that already
          // existed for that kind of target, so every gate applies as it
          // would have without a name in front of it.
          await agent.runShortcutTarget(resolution);
        }}
      />
    </div>
  );
}
