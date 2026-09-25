/**
 * User-facing notifications (specification section 25).
 *
 * The agent can be waiting for approval while the side panel is closed and
 * the user is working in another window. A notification is the only way they
 * find out; without one the task stalls silently until they happen to look.
 *
 * `chrome.notifications` sits behind a port for the same reason the debugger
 * and messaging surfaces do: it makes the behaviour testable without a
 * browser. That matters more here than elsewhere, because headless Chromium
 * does not surface notifications at all, so an end-to-end test cannot observe
 * one and the rules below would otherwise go unverified.
 */
import { getLogger } from '@/logging/logger';
import type { TaskState } from '@/tasks/task-model';

const log = getLogger('ui');

/** The `chrome.notifications` surface this module needs. */
export interface NotificationPort {
  create(options: {
    type: 'basic';
    iconUrl: string;
    title: string;
    message: string;
    priority: number;
  }): Promise<string>;
}

export const chromeNotificationPort: NotificationPort = {
  create: (options) => chrome.notifications.create(options),
};

export interface NotifierDeps {
  readonly port?: NotificationPort;
  /** Reads the live setting, so a change takes effect without a restart. */
  readonly isEnabled: () => Promise<boolean>;
}

const ICON = 'icons/icon-128.png';

export class Notifier {
  private readonly port: NotificationPort;

  /**
   * Tasks whose ending has already been announced.
   *
   * `TaskManager.transition` treats a move to the state a task is already in
   * as allowed, so a second call with the same terminal state reaches the
   * lifecycle observer again. That is harmless for the audit trail, which is
   * recording that something was observed, and not harmless here: two toasts
   * for one task is a bug the user sees.
   *
   * In memory, and that is sufficient rather than a compromise. A revived
   * worker reconciles `listInterrupted()`, which filters terminal tasks out,
   * so an already-finished task is never transitioned again by a later worker
   * — the duplicate this guards against can only happen inside one worker's
   * life, which is exactly as long as this set lives. The eviction test
   * proves the claim rather than restating it.
   */
  private readonly announced = new Set<string>();

  constructor(private readonly deps: NotifierDeps) {
    this.port = deps.port ?? chromeNotificationPort;
  }

  /**
   * Tells the user a tool is waiting for their approval.
   *
   * Only the tool's canonical name is included. The arguments are deliberately
   * left out: they routinely carry text read from the page, and a notification
   * is rendered by the operating system, outside every boundary this extension
   * controls — it can persist in a notification centre long after the task is
   * gone. The name alone is enough for the user to decide to open the panel.
   */
  async permissionRequested(tool: string): Promise<void> {
    if (!(await this.enabled())) return;

    await this.show({
      type: 'basic',
      iconUrl: ICON,
      title: 'Approval needed',
      message: `The agent is waiting for approval to run ${tool}.`,
      priority: 2,
    });
  }

  /**
   * Tells the user what one of their schedules did.
   *
   * A schedule runs while nobody is looking — that is the entire point — so
   * the notification is the only way its outcome is ever seen. All four
   * lifecycle points are surfaced, and the one that matters most is
   * `blocked`: a run that stopped at the confirmation boundary did *not*
   * happen, and a user who was not told would believe it had.
   *
   * The schedule's name is included because the user typed it themselves.
   * Nothing else is: not the tool, not the site, not the step, and not the
   * reason in any words but this extension's own — a notification is rendered
   * by the operating system, outside every boundary this extension controls,
   * and can outlive the task in a notification centre.
   */
  /**
   * Tells the user their task ended, and nothing about what it did.
   *
   * Specification section 53 requires a notification for a completed task and
   * for a failed one. The reason it matters is the reason the benchmark gives
   * for its own: the user started something and went to do something else, so
   * the toast is the only thing that brings them back.
   *
   * **The message carries no objective, no summary, no result, no site and no
   * tool.** Every one of those is either page-derived or model-authored, and a
   * notification is rendered by the operating system, outside every boundary
   * this extension controls, where it can sit in a notification centre long
   * after the task is gone. What ended, and how, is the whole of it — a user
   * who wants to know more opens the panel, which is inside.
   *
   * `CANCELLED` deliberately says nothing: the user cancelled it themselves,
   * so they were present and already know. A toast telling somebody what they
   * just did is noise, not news.
   */
  async taskFinished(taskId: string, state: TaskState): Promise<void> {
    if (this.announced.has(taskId)) return;
    // Marked before the setting is read, so a task is announced at most once
    // whatever the answer. A user who turns notifications on mid-task is
    // asking about the next one, not owed a replay of this one.
    this.announced.add(taskId);

    const notice = TASK_NOTICES[state];
    if (!notice) return;
    if (!(await this.enabled())) return;

    await this.show({
      type: 'basic',
      iconUrl: ICON,
      title: notice.title,
      message: notice.message,
      priority: notice.priority,
    });
  }

  /**
   * Tells the user a connector needs authorizing again.
   *
   * Specification section 53. The grant expired while nobody was looking, and
   * the next thing that needs it fails for a reason the user cannot guess
   * from the failure.
   *
   * The display name comes from a descriptor that shipped in the build, so it
   * is a constant this project wrote — not a service response, not a token
   * claim and not anything the connector returned.
   */
  async connectorAuthExpired(displayName: string): Promise<void> {
    if (!(await this.enabled())) return;

    await this.show({
      type: 'basic',
      iconUrl: ICON,
      title: 'Reconnect needed',
      message: `"${trim(displayName)}" needs to be connected again before it can be used.`,
      priority: 2,
    });
  }

  async scheduleStarted(name: string): Promise<void> {
    await this.scheduleNotice('Scheduled task started', `"${trim(name)}" is running.`, 0);
  }

  async scheduleCompleted(name: string): Promise<void> {
    await this.scheduleNotice('Scheduled task finished', `"${trim(name)}" completed.`, 0);
  }

  async scheduleFailed(name: string): Promise<void> {
    await this.scheduleNotice('Scheduled task failed', `"${trim(name)}" did not finish.`, 2);
  }

  /**
   * The one this phase exists to produce.
   *
   * `needsApproval` distinguishes the two ways a run stops, because they ask
   * different things of the user: one is waiting for them, and the other is
   * telling them something was not allowed at all.
   */
  async scheduleBlocked(name: string, needsApproval: boolean): Promise<void> {
    await this.scheduleNotice(
      'Scheduled task stopped',
      needsApproval
        ? `"${trim(name)}" needs your approval to continue. Open the panel and run it yourself.`
        : `"${trim(name)}" was stopped because an action it needed is not permitted.`,
      2,
    );
  }

  private async scheduleNotice(title: string, message: string, priority: number): Promise<void> {
    if (!(await this.enabled())) return;
    await this.show({ type: 'basic', iconUrl: ICON, title, message, priority });
  }

  private async enabled(): Promise<boolean> {
    try {
      return await this.deps.isEnabled();
    } catch (error) {
      // A settings read failure must not decide to notify. Staying quiet is
      // the conservative option: a missed notification delays a task, while a
      // notification the user disabled is a setting the extension ignored.
      log.debug('Could not read the notification setting.', { error: describe(error) });
      return false;
    }
  }

  /**
   * Shows a notification, swallowing any failure.
   *
   * This runs on the permission path. Chrome refuses notifications when the
   * user has blocked them at the OS level, and headless Chromium has no
   * notification surface at all. Neither is a reason to fail an approval the
   * user is waiting on, so the error is logged and the flow continues.
   */
  private async show(options: Parameters<NotificationPort['create']>[0]): Promise<void> {
    try {
      await this.port.create(options);
    } catch (error) {
      log.debug('Could not show a notification.', { error: describe(error) });
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What each ending is announced as, and which are announced at all.
 *
 * A total map over the terminal states rather than a chain of conditions, so
 * adding a task state is a compile error here instead of a silent omission.
 * `PARTIAL` and `BLOCKED` are not named by section 53 and are included for the
 * reason `scheduleBlocked` already is: a task that stopped without finishing
 * did not do what was asked, and a user who was not told would believe it had.
 */
const TASK_NOTICES: Partial<
  Record<TaskState, { title: string; message: string; priority: number }>
> = {
  COMPLETED: {
    title: 'Task finished',
    message: 'The agent finished the task you started.',
    priority: 0,
  },
  PARTIAL: {
    title: 'Task partly finished',
    message: 'The agent finished part of the task you started. Open the panel to see the rest.',
    priority: 2,
  },
  BLOCKED: {
    title: 'Task stopped',
    message: 'The agent stopped because an action it needed is not permitted.',
    priority: 2,
  },
  FAILED: {
    title: 'Task failed',
    message: 'The agent could not finish the task you started.',
    priority: 2,
  },
};

/** Keeps a user-chosen name inside what an operating-system toast will show. */
function trim(name: string): string {
  return name.length > 60 ? `${name.slice(0, 57)}...` : name;
}
