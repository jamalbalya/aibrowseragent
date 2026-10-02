import { useCallback, useEffect, useState } from 'react';
import { sendToBackground, MessagingError } from '@/messaging/bus';
import type { PanelResponse, ShortcutSummary, WorkflowSummary } from '@/messaging/protocol';
import { interleave } from '@/workflows/step-digest';

interface WorkflowsViewProps {
  /** The task whose calls a new recording would capture. */
  readonly activeTaskId: string | null;
  readonly onClose: () => void;
  readonly onReplayStarted: (taskId: string) => void;
}

type Verdict = {
  ok: boolean;
  reason?: string;
  detail?: string;
  risk?: string;
  riskChanged?: boolean;
};

/**
 * Recording and replaying workflows.
 *
 * The lifecycle is deliberately visible in this file, because it is a security
 * property rather than a UX one: recording, saving and reviewing run nothing.
 * The only control that executes anything is Replay, and pressing it runs the
 * steps through the same gates as any other work — the permission prompts
 * appear again, because a stored workflow pre-approves nothing.
 *
 * Replayed workflows are also the reason there is no "add to skills" button
 * anywhere here. A recording stays out of the skill list, so the model never
 * sees it and can never choose to run one; the person who recorded it is the
 * only thing that starts it.
 */
export function WorkflowsView({
  activeTaskId,
  onClose,
  onReplayStarted,
}: WorkflowsViewProps): React.JSX.Element {
  const [workflows, setWorkflows] = useState<readonly WorkflowSummary[]>([]);
  const [recording, setRecording] = useState(false);
  const [recordedSteps, setRecordedSteps] = useState(0);
  /**
   * The captured steps, and the steps that could not be captured.
   *
   * Held separately from `recordedSteps` rather than derived from it, because
   * the count is what the Stop button is disabled on and these are what the
   * person checks their recording against. The list is collapsed by default:
   * the panel is narrow, and a recording that is going fine needs the number
   * and nothing else.
   */
  const [recordedList, setRecordedList] = useState<PanelResponse<'workflow.recordStatus'>['steps']>(
    [],
  );
  const [recordedSkipped, setRecordedSkipped] = useState<
    PanelResponse<'workflow.recordStatus'>['skipped']
  >([]);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [shortcuts, setShortcuts] = useState<readonly ShortcutSummary[]>([]);
  const [skills, setSkills] = useState<PanelResponse<'skill.list'>['skills']>([]);
  const [naming, setNaming] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  /**
   * §50's two narrowings, offered on the same form as the name.
   *
   * Both are restrictions, so the default for each is "no restriction" and
   * neither can grant anything. `allowedTools` is free text because the tool
   * set is not fixed — an MCP server adds to it — and the worker names the
   * refusal precisely when an entry cannot be a tool.
   */
  const [confirmEachAction, setConfirmEachAction] = useState(false);
  const [allowedToolsText, setAllowedToolsText] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [list, status, shortcutList, skillList] = await Promise.all([
        sendToBackground('workflow.list', {}),
        sendToBackground('workflow.recordStatus', {}),
        sendToBackground('shortcut.list', {}),
        sendToBackground('skill.list', {}),
      ]);
      setWorkflows(list.workflows);
      setRecording(status.recording);
      setRecordedSteps(status.stepCount);
      setRecordedList(status.steps);
      setRecordedSkipped(status.skipped);
      setShortcuts(shortcutList.shortcuts);
      setSkills(skillList.skills);
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) });
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await refresh();
    })();
    // While a recording runs this poll is the only feedback that anything is
    // being captured, so it is polled rather than left stale. It carries the
    // steps as well as the count, because a rising count does not tell the
    // person whether the step they just took is the step that was recorded.
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const start = async (): Promise<void> => {
    if (!activeTaskId) return;
    setBusy('record');
    try {
      await sendToBackground('workflow.recordStart', { taskId: activeTaskId });
      setMessage({
        tone: 'ok',
        text: 'Recording. Carry on with the task — each completed step is captured.',
      });
      await refresh();
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(null);
    }
  };

  const stop = async (): Promise<void> => {
    setBusy('record');
    try {
      const result = await sendToBackground('workflow.recordStop', {
        name: name.trim(),
        description: description.trim(),
      });
      setName('');
      setDescription('');
      setMessage(
        result.workflow
          ? {
              tone: 'ok',
              text:
                `Saved “${result.workflow.name}”. It is stored, not started — review it below ` +
                'and replay it when you want it to run.',
            }
          : { tone: 'error', text: 'Nothing was captured, so no workflow was saved.' },
      );
      await refresh();
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (): Promise<void> => {
    setBusy('record');
    try {
      await sendToBackground('workflow.recordCancel', {});
      setMessage({ tone: 'ok', text: 'Recording discarded. Nothing was saved.' });
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const review = async (workflowId: string): Promise<void> => {
    setOpenId(openId === workflowId ? null : workflowId);
    setInputs({});
    if (openId === workflowId) return;
    try {
      // Checks the workflow against the world as it is now. Runs nothing —
      // this is how a workflow that can no longer run says so without half
      // executing to find out.
      const verdict = await sendToBackground('workflow.revalidate', { workflowId });
      setVerdicts((current) => ({ ...current, [workflowId]: verdict }));
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) });
    }
  };

  const replay = async (workflow: WorkflowSummary): Promise<void> => {
    setBusy(workflow.workflowId);
    setMessage(null);
    try {
      const outcome = await sendToBackground('workflow.replay', {
        workflowId: workflow.workflowId,
        inputs,
      });
      if (outcome.taskId) onReplayStarted(outcome.taskId);
      setMessage({
        tone: outcome.ok ? 'ok' : 'error',
        text: outcome.ok
          ? `Replayed “${workflow.name}”. ${outcome.summary ?? ''}`
          : (outcome.detail ?? outcome.summary ?? 'The replay did not finish.'),
      });
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(null);
    }
  };

  /**
   * Gives an existing target a name. Runs nothing.
   *
   * A collision comes back as a message naming what it clashed with, rather
   * than being merged or silently renamed — two distinct choices must not
   * become one executable shortcut.
   */
  const addShortcut = async (target: ShortcutSummaryTarget, label: string): Promise<void> => {
    setBusy('shortcut');
    try {
      const allowedTools = allowedToolsText
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const result = await sendToBackground('shortcut.create', {
        name: newName,
        target,
        ...(allowedTools.length === 0 ? {} : { allowedTools }),
        ...(confirmEachAction ? { permissionProfile: 'confirm-each-action' } : {}),
      });
      setMessage(
        result.shortcut
          ? { tone: 'ok', text: `/${result.shortcut.name} now runs ${label}.` }
          : { tone: 'error', text: result.error?.detail ?? 'That name could not be used.' },
      );
      if (result.shortcut) {
        setNaming(null);
        setNewName('');
        setAllowedToolsText('');
        setConfirmEachAction(false);
      }
      await refresh();
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(null);
    }
  };

  const removeShortcut = async (shortcutId: string): Promise<void> => {
    setBusy('shortcut');
    try {
      await sendToBackground('shortcut.remove', { shortcutId });
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const nameForm = (target: ShortcutSummaryTarget, label: string): React.JSX.Element => (
    <>
      <span className="settings__actions">
        <input
          className="field__input"
          value={newName}
          maxLength={48}
          placeholder="qa-regression"
          aria-label="Shortcut name"
          onChange={(event) => setNewName(event.target.value)}
        />
        <button
          type="button"
          className="button"
          disabled={busy !== null || newName.trim().length === 0}
          onClick={() => void addShortcut(target, label)}
        >
          Save
        </button>
        <button type="button" className="button button--ghost" onClick={() => setNaming(null)}>
          Cancel
        </button>
      </span>
      <div className="field">
        <input
          className="field__input"
          value={allowedToolsText}
          placeholder="browser.read_page, browser.click"
          aria-label="Tools this shortcut may use"
          onChange={(event) => setAllowedToolsText(event.target.value)}
        />
        <p className="field__hint">
          Optional. Names the only tools this shortcut’s run may use — it can restrict what the
          agent reaches, never widen it. Leave empty for no restriction.
        </p>
      </div>
      <label className="field__hint">
        <input
          type="checkbox"
          checked={confirmEachAction}
          aria-label="Confirm every action in this shortcut’s run"
          onChange={(event) => setConfirmEachAction(event.target.checked)}
        />{' '}
        Confirm every action, whatever the permission mode is set to. This can only make a run
        stricter.
      </label>
    </>
  );

  const remove = async (workflowId: string): Promise<void> => {
    setBusy(workflowId);
    try {
      await sendToBackground('workflow.remove', { workflowId });
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings">
      <header className="settings__header">
        <h2>Workflows</h2>
        <button type="button" className="button button--ghost" onClick={onClose}>
          Close
        </button>
      </header>

      {message ? (
        <div className={`banner banner--${message.tone === 'ok' ? 'info' : 'error'}`} role="status">
          {message.text}
        </div>
      ) : null}

      <section className="settings__section">
        <h3>Record</h3>
        <p className="field__hint">
          Recording watches the steps a task completes and saves them as a workflow you can run
          again. It captures what was done — it never runs anything itself, and saving a recording
          does not start it.
        </p>

        {recording ? (
          <>
            <p className="field__hint">
              Recording — {recordedSteps} step{recordedSteps === 1 ? '' : 's'} captured so far.
            </p>
            {recordedSteps > 0 || recordedSkipped.length > 0 ? (
              <>
                <button
                  type="button"
                  className="button button--ghost"
                  aria-expanded={stepsOpen}
                  onClick={() => setStepsOpen((open) => !open)}
                >
                  {stepsOpen ? 'Hide steps' : `Steps (${recordedSteps})`}
                </button>
                {stepsOpen ? (
                  <StepList steps={recordedList} droppedSteps={recordedSkipped} />
                ) : null}
              </>
            ) : null}
            {recordedSkipped.length > 0 ? (
              <p className="banner banner--error" role="alert">
                {recordedSkipped.length} step{recordedSkipped.length === 1 ? '' : 's'} could not be
                recorded, so saving now would store something that does not do what this task did.
                Open the steps to see where the gap is.
              </p>
            ) : null}
            <label className="field">
              <span className="field__label">Name</span>
              <input
                className="field__input"
                value={name}
                maxLength={120}
                placeholder="What this workflow does"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="field">
              <span className="field__label">Description</span>
              <input
                className="field__input"
                value={description}
                maxLength={500}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <div className="settings__actions">
              <button
                type="button"
                className="button"
                disabled={busy !== null || recordedSteps === 0}
                onClick={() => void stop()}
              >
                Stop and save
              </button>
              <button
                type="button"
                className="button button--ghost"
                disabled={busy !== null}
                onClick={() => void cancel()}
              >
                Discard
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            className="button"
            disabled={busy !== null || activeTaskId === null}
            onClick={() => void start()}
          >
            {activeTaskId === null ? 'Start a task first' : 'Start recording this task'}
          </button>
        )}
      </section>

      <section className="settings__section">
        <h3>Shortcuts</h3>
        <p className="field__hint">
          A shortcut is a name for a workflow you already have. Type it in the composer with a
          leading slash. It runs the same thing, with the same permission prompts — a name grants
          nothing.
        </p>
        {shortcuts.length === 0 ? (
          <p className="field__hint">No shortcuts yet. Add one from a workflow below.</p>
        ) : (
          <ul className="sites">
            {shortcuts.map((shortcut) => (
              <li key={shortcut.shortcutId} className="sites__row">
                <span className={shortcut.usable ? '' : 'shortcut--broken'}>
                  <strong className="shortcut__name">/{shortcut.name}</strong> —{' '}
                  {shortcut.targetName}
                </span>
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={busy !== null}
                  onClick={() => void removeShortcut(shortcut.shortcutId)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="settings__section">
        <h3>Built-in workflows</h3>
        <p className="field__hint">
          These ship with the extension and cannot be changed. Give one a shortcut to run it by
          name.
        </p>
        <ul className="sites">
          {skills.map((skill) => (
            <li key={`${skill.id}@${skill.version}`} className="sites__row">
              <span>
                <strong>{skill.name}</strong>{' '}
                <span className={`badge badge--risk-${skill.risk.toLowerCase()}`}>
                  {skill.risk}
                </span>
              </span>
              {naming === `skill:${skill.id}` ? (
                nameForm(
                  { kind: 'skill', skillId: skill.id, skillVersion: skill.version },
                  skill.name,
                )
              ) : (
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    setNaming(`skill:${skill.id}`);
                    setNewName('');
                  }}
                >
                  Add shortcut
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="settings__section">
        <h3>Saved workflows</h3>
        {workflows.length === 0 ? (
          <p className="field__hint">
            No workflows yet. Record one from a task to save the steps it took.
          </p>
        ) : (
          <ul className="sites">
            {workflows.map((workflow) => {
              const verdict = verdicts[workflow.workflowId];
              const open = openId === workflow.workflowId;
              return (
                <li key={workflow.workflowId} className="sites__row sites__row--stacked">
                  <div className="sites__head">
                    <span>
                      <strong>{workflow.name}</strong> — {workflow.steps.length} step
                      {workflow.steps.length === 1 ? '' : 's'}{' '}
                      <span className={`badge badge--risk-${workflow.risk.toLowerCase()}`}>
                        {workflow.risk}
                      </span>
                    </span>
                    <span className="settings__actions">
                      <button
                        type="button"
                        className="button button--ghost"
                        onClick={() => void review(workflow.workflowId)}
                      >
                        {open ? 'Hide' : 'Review'}
                      </button>
                      {naming === `workflow:${workflow.workflowId}` ? (
                        nameForm(
                          { kind: 'workflow', workflowId: workflow.workflowId },
                          workflow.name,
                        )
                      ) : (
                        <button
                          type="button"
                          className="button button--ghost"
                          disabled={busy !== null || workflow.incomplete}
                          onClick={() => {
                            setNaming(`workflow:${workflow.workflowId}`);
                            setNewName('');
                          }}
                        >
                          Add shortcut
                        </button>
                      )}
                      <button
                        type="button"
                        className="button button--ghost"
                        disabled={busy !== null}
                        onClick={() => void remove(workflow.workflowId)}
                      >
                        Delete
                      </button>
                    </span>
                  </div>

                  {open ? (
                    <div className="workflow__detail">
                      <p className="field__hint">{workflow.description}</p>
                      {workflow.incomplete ? (
                        <p className="banner banner--error" role="alert">
                          This recording is missing {workflow.droppedSteps.length} step
                          {workflow.droppedSteps.length === 1 ? '' : 's'} the task actually took, so
                          it cannot be replayed — running the rest would do something different from
                          what was recorded. Record it again.
                        </p>
                      ) : null}

                      <StepList steps={workflow.steps} droppedSteps={workflow.droppedSteps} />

                      {workflow.inputs.length > 0 ? (
                        <div className="workflow__inputs">
                          <p className="field__hint">
                            These values were not stored — supply them for this run.
                          </p>
                          {workflow.inputs.map((input) => (
                            <label key={input.name} className="field">
                              <span className="field__label">{input.description}</span>
                              <input
                                className="field__input"
                                value={inputs[input.name] ?? ''}
                                onChange={(event) =>
                                  setInputs((current) => ({
                                    ...current,
                                    [input.name]: event.target.value,
                                  }))
                                }
                              />
                            </label>
                          ))}
                        </div>
                      ) : null}

                      {verdict && !verdict.ok ? (
                        <p className="banner banner--error" role="alert">
                          {verdict.detail}
                        </p>
                      ) : null}
                      {verdict?.ok && verdict.riskChanged ? (
                        <p className="field__hint">
                          A tool this workflow uses has changed its risk since it was recorded. It
                          will run at {verdict.risk}.
                        </p>
                      ) : null}

                      <p className="field__hint">
                        Replaying asks for permission again, step by step. Nothing was approved in
                        advance by recording it.
                      </p>
                      <button
                        type="button"
                        className="button"
                        disabled={busy !== null || verdict?.ok === false || workflow.incomplete}
                        onClick={() => void replay(workflow)}
                      >
                        Replay
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * The step list, used by the review surface and by a running recording.
 *
 * One component, because a recording that reads differently while it is being
 * made from how it reads once saved is a recording the person cannot check.
 * It renders what it is given and fetches nothing, so it has no opinion about
 * whether the steps are still being captured.
 */
export function StepList({
  steps,
  droppedSteps,
}: {
  readonly steps: WorkflowSummary['steps'];
  readonly droppedSteps: WorkflowSummary['droppedSteps'];
}): React.JSX.Element {
  return (
    <ol className="workflow__steps">
      {interleave({ steps, droppedSteps }).map((entry) =>
        entry.kind === 'step' ? (
          <li key={entry.step.id}>
            <code>{entry.step.tool}</code>
            <ul className="workflow__args">
              {Object.entries(entry.step.arguments).map(([argument, binding]) => (
                <li key={argument}>
                  <span className="workflow__arg">{argument}</span>
                  <span className={`workflow__binding workflow__binding--${binding.kind}`}>
                    {binding.detail}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ) : (
          <li key={`dropped-${entry.index}`} className="workflow__dropped">
            <span className="workflow__droppedTag">[NOT RECORDED]</span>{' '}
            <code>{entry.dropped.tool}</code>
            <p className="workflow__droppedReason">Reason: {entry.dropped.reason}</p>
          </li>
        ),
      )}
    </ol>
  );
}

/** What a shortcut may point at. A reference, never a definition. */
type ShortcutSummaryTarget =
  | { kind: 'workflow'; workflowId: string }
  | { kind: 'skill'; skillId: string; skillVersion: string };

function describe(error: unknown): string {
  if (error instanceof MessagingError) return error.agentError.userMessage;
  return error instanceof Error ? error.message : String(error);
}
