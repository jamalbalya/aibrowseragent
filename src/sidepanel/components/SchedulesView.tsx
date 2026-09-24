import { useCallback, useEffect, useState } from 'react';
import { sendToBackground, MessagingError, subscribeToEvents } from '@/messaging/bus';
import type {
  ScheduleCadenceWire,
  ScheduleRunSummary,
  ScheduleSummary,
  ScheduleTargetWire,
  ShortcutSummary,
  WorkflowSummary,
} from '@/messaging/protocol';

interface SchedulesViewProps {
  readonly onClose: () => void;
}

/**
 * Scheduling a workflow, and reading what happened when it ran.
 *
 * The thing this screen has to say honestly, and says in several places, is
 * what a scheduled run will **not** do. A run the clock starts happens with
 * nobody watching, so it cannot ask anything: when it reaches an action that
 * needs approval it stops, records why, and tells the user. Nothing here
 * offers to remember an approval, to run at a higher risk level, or to
 * "always allow" — those controls do not exist, deliberately, and a person
 * who wants an action approved runs the schedule themselves with Run now.
 *
 * Missed runs are the other honest note. A schedule whose time passed while
 * the browser was closed is recorded as missed and is never run late: the
 * next occurrence goes ahead normally, and Run now is there if the user wants
 * it sooner.
 */
export function SchedulesView({ onClose }: SchedulesViewProps): React.JSX.Element {
  const [schedules, setSchedules] = useState<readonly ScheduleSummary[]>([]);
  const [runs, setRuns] = useState<readonly ScheduleRunSummary[]>([]);
  const [workflows, setWorkflows] = useState<readonly WorkflowSummary[]>([]);
  const [shortcuts, setShortcuts] = useState<readonly ShortcutSummary[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const [name, setName] = useState('');
  const [targetKey, setTargetKey] = useState('');
  const [cadenceKind, setCadenceKind] = useState<ScheduleCadenceWire['kind']>('daily');
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [weekday, setWeekday] = useState(1);
  const [day, setDay] = useState(1);
  const [month, setMonth] = useState(1);

  const refresh = useCallback(async () => {
    try {
      const [list, history, workflowList, shortcutList] = await Promise.all([
        sendToBackground('schedule.list', {}),
        sendToBackground('schedule.runs', {}),
        sendToBackground('workflow.list', {}),
        sendToBackground('shortcut.list', {}),
      ]);
      setSchedules(list.schedules);
      setRuns(history.runs);
      setWorkflows(workflowList.workflows);
      setShortcuts(shortcutList.shortcuts);
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    // A run can start, finish or be blocked while this screen is open and
    // nobody has touched anything, so the list follows the worker rather than
    // the user's clicks.
    return subscribeToEvents((event) => {
      if (event.type === 'schedules.changed') void refresh();
    });
  }, [refresh]);

  const cadence = (): ScheduleCadenceWire => {
    switch (cadenceKind) {
      case 'daily':
        return { kind: 'daily', hour, minute };
      case 'weekly':
        return { kind: 'weekly', weekday, hour, minute };
      case 'monthly':
        return { kind: 'monthly', day, hour, minute };
      case 'annual':
        return { kind: 'annual', month, day, hour, minute };
    }
  };

  const target = (): ScheduleTargetWire | null => {
    if (targetKey.startsWith('shortcut:')) {
      return { kind: 'shortcut', shortcutId: targetKey.slice('shortcut:'.length) };
    }
    if (targetKey.startsWith('workflow:')) {
      return { kind: 'workflow', workflowId: targetKey.slice('workflow:'.length) };
    }
    return null;
  };

  const create = async (): Promise<void> => {
    const chosen = target();
    if (!chosen || name.trim().length === 0) return;
    setBusy('create');
    try {
      const result = await sendToBackground('schedule.create', {
        name: name.trim(),
        target: chosen,
        cadence: cadence(),
      });
      if (result.schedule) {
        setName('');
        setTargetKey('');
        setMessage({
          tone: 'ok',
          text:
            `Scheduled “${result.schedule.displayName}”. It will run on its own, and will ` +
            'stop rather than continue if it reaches an action that needs your approval.',
        });
      } else {
        setMessage({ tone: 'error', text: result.error?.detail ?? 'That schedule was refused.' });
      }
      await refresh();
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(null);
    }
  };

  const setEnabled = async (scheduleId: string, enabled: boolean): Promise<void> => {
    setBusy(scheduleId);
    try {
      const result = await sendToBackground('schedule.setEnabled', { scheduleId, enabled });
      if (!result.schedule) {
        setMessage({ tone: 'error', text: result.error?.detail ?? 'That could not be changed.' });
      }
      await refresh();
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (scheduleId: string): Promise<void> => {
    setBusy(scheduleId);
    try {
      await sendToBackground('schedule.remove', { scheduleId });
      await refresh();
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(null);
    }
  };

  const runNow = async (scheduleId: string): Promise<void> => {
    setBusy(scheduleId);
    try {
      const result = await sendToBackground('schedule.runNow', { scheduleId });
      setMessage(
        result.run
          ? { tone: 'ok', text: outcomeText(result.run) }
          : { tone: 'error', text: result.error?.detail ?? 'That run could not start.' },
      );
      await refresh();
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(null);
    }
  };

  const cancelRun = async (runId: string): Promise<void> => {
    setBusy(runId);
    try {
      await sendToBackground('schedule.cancelRun', { runId });
      await refresh();
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="view">
      <header className="view__header">
        <h1 className="view__title">Schedules</h1>
        <button type="button" className="button button--ghost" onClick={onClose}>
          Close
        </button>
      </header>

      <p className="view__note">
        A schedule runs a workflow you have already recorded, at a time you choose. It runs with
        nobody watching, so it cannot ask you anything: if it reaches an action that needs your
        approval it stops and tells you, and you can run it yourself with Run now. A run whose time
        passed while your browser was closed is recorded as missed and is never run late.
      </p>

      {message ? (
        <p className={`banner banner--${message.tone === 'ok' ? 'info' : 'error'}`} role="status">
          {message.text}
        </p>
      ) : null}

      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <label className="field">
          <span className="field__label">Name</span>
          <input
            className="field__input"
            value={name}
            maxLength={80}
            placeholder="Morning check"
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <label className="field">
          <span className="field__label">What to run</span>
          <select
            className="field__input"
            value={targetKey}
            onChange={(event) => setTargetKey(event.target.value)}
          >
            <option value="">Choose a workflow or shortcut…</option>
            {shortcuts.map((shortcut) => (
              <option key={shortcut.shortcutId} value={`shortcut:${shortcut.shortcutId}`}>
                /{shortcut.name}
              </option>
            ))}
            {workflows.map((workflow) => (
              <option key={workflow.workflowId} value={`workflow:${workflow.workflowId}`}>
                {workflow.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">How often</span>
          <select
            className="field__input"
            value={cadenceKind}
            onChange={(event) => setCadenceKind(event.target.value as ScheduleCadenceWire['kind'])}
          >
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
            <option value="annual">Every year</option>
          </select>
        </label>

        {cadenceKind === 'weekly' ? (
          <label className="field">
            <span className="field__label">Day of the week</span>
            <select
              className="field__input"
              value={weekday}
              onChange={(event) => setWeekday(Number(event.target.value))}
            >
              {WEEKDAYS.map((label, index) => (
                <option key={label} value={index}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {cadenceKind === 'annual' ? (
          <label className="field">
            <span className="field__label">Month</span>
            <select
              className="field__input"
              value={month}
              onChange={(event) => setMonth(Number(event.target.value))}
            >
              {MONTHS.map((label, index) => (
                <option key={label} value={index + 1}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {cadenceKind === 'monthly' || cadenceKind === 'annual' ? (
          <label className="field">
            <span className="field__label">Day of the month</span>
            <input
              className="field__input"
              type="number"
              min={1}
              max={31}
              value={day}
              onChange={(event) => setDay(Number(event.target.value))}
            />
          </label>
        ) : null}

        <label className="field">
          <span className="field__label">Time</span>
          <input
            className="field__input"
            type="time"
            value={`${pad(hour)}:${pad(minute)}`}
            onChange={(event) => {
              const [h, m] = event.target.value.split(':');
              setHour(Number(h ?? 0));
              setMinute(Number(m ?? 0));
            }}
          />
        </label>

        <p className="field__hint">
          Times are your computer&rsquo;s local time, and stay at the hour you picked when the
          clocks change. A day that does not exist in a month — the 31st in February, or 29 February
          in a year that is not a leap year — is skipped rather than moved.
        </p>

        <button
          type="submit"
          className="button"
          disabled={busy === 'create' || name.trim().length === 0 || targetKey === ''}
        >
          Create schedule
        </button>
      </form>

      {schedules.length === 0 ? (
        <p className="empty">No schedules yet.</p>
      ) : (
        <ul className="list">
          {schedules.map((schedule) => {
            const history = runs.filter((run) => run.scheduleId === schedule.scheduleId);
            const running = history.find((run) => run.status === 'running');
            return (
              <li key={schedule.scheduleId} className="list__item">
                <div className="list__row">
                  <button
                    type="button"
                    className="list__main"
                    onClick={() =>
                      setOpenId(openId === schedule.scheduleId ? null : schedule.scheduleId)
                    }
                  >
                    <span className="list__name">{schedule.displayName}</span>
                    <span className="list__meta">
                      {schedule.cadenceDescription} · {schedule.targetName}
                    </span>
                    <span className="list__meta">
                      {schedule.enabled
                        ? `Next: ${formatTime(schedule.nextRunAt)}`
                        : 'Paused — it will not run'}
                      {schedule.targetUsable ? '' : ' · the thing it runs is missing'}
                    </span>
                    {schedule.lastRunStatus ? (
                      <span className={`badge badge--${schedule.lastRunStatus}`}>
                        {lastRunText(schedule)}
                      </span>
                    ) : null}
                  </button>
                </div>

                <div className="list__actions">
                  <button
                    type="button"
                    className="button button--ghost"
                    disabled={busy === schedule.scheduleId}
                    onClick={() => void runNow(schedule.scheduleId)}
                  >
                    Run now
                  </button>
                  <button
                    type="button"
                    className="button button--ghost"
                    disabled={busy === schedule.scheduleId}
                    onClick={() => void setEnabled(schedule.scheduleId, !schedule.enabled)}
                  >
                    {schedule.enabled ? 'Pause' : 'Resume'}
                  </button>
                  <button
                    type="button"
                    className="button button--ghost"
                    disabled={busy === schedule.scheduleId}
                    onClick={() => void remove(schedule.scheduleId)}
                  >
                    Delete
                  </button>
                  {running ? (
                    <button
                      type="button"
                      className="button button--ghost"
                      disabled={busy === running.runId}
                      onClick={() => void cancelRun(running.runId)}
                    >
                      Stop this run
                    </button>
                  ) : null}
                </div>

                {openId === schedule.scheduleId ? (
                  <div className="list__detail">
                    <h2 className="list__subtitle">Recent runs</h2>
                    {history.length === 0 ? (
                      <p className="empty">It has not run yet.</p>
                    ) : (
                      <ul className="list list--plain">
                        {history.slice(0, 20).map((run) => (
                          <li key={run.runId} className="list__row">
                            <span className={`badge badge--${run.status}`}>{run.status}</span>
                            <span className="list__meta">{formatTime(run.occurrenceAt)}</span>
                            <span className="list__meta">{outcomeText(run)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatTime(at: number): string {
  return new Date(at).toLocaleString();
}

/**
 * What a run's outcome means, in the user's terms.
 *
 * Written from a closed vocabulary the extension owns. Nothing here quotes a
 * tool, a page or a model — the reasons are the extension's own words, and a
 * reason this build does not know reads as "it stopped" rather than as
 * whatever string arrived.
 */
function outcomeText(run: ScheduleRunSummary): string {
  switch (run.reason) {
    case 'CONFIRMATION_REQUIRED':
      return 'Stopped: it reached an action that needs your approval. Use Run now to approve it.';
    case 'POLICY_DENIED':
      return 'Stopped: an action it needed is not permitted.';
    case 'TARGET_MISSING':
      return 'Stopped: what it runs no longer exists.';
    case 'TARGET_UNUSABLE':
      return 'Stopped: what it runs cannot be replayed.';
    case 'INPUTS_REQUIRED':
      return 'Stopped: that workflow asks for values when it runs, so it cannot run unattended.';
    case 'PERSISTENCE_BLOCKED':
      return 'Stopped: stored state is not in a state this run could rely on.';
    case 'MISSED_WHILE_ASLEEP':
      return 'Missed: the browser was not running. It was not run late.';
    case 'INTERRUPTED':
      return 'Stopped: the extension restarted while it was running. It was not resumed.';
    case 'CANCELLED':
      return 'Stopped by you.';
    case 'RUN_FAILED':
      return 'It did not finish.';
    case 'INTERNAL_ERROR':
      return 'It stopped because of an internal error.';
    default:
      return run.status === 'completed'
        ? 'Completed.'
        : run.status === 'running'
          ? 'Running now.'
          : 'It stopped.';
  }
}

function lastRunText(schedule: ScheduleSummary): string {
  const at = schedule.lastRunAt === undefined ? '' : ` · ${formatTime(schedule.lastRunAt)}`;
  return `${schedule.lastRunStatus ?? ''}${at}`;
}

function describe(error: unknown): string {
  if (error instanceof MessagingError) return error.agentError.userMessage;
  return error instanceof Error ? error.message : String(error);
}
