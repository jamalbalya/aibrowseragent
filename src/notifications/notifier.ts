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

/** Keeps a user-chosen name inside what an operating-system toast will show. */
function trim(name: string): string {
  return name.length > 60 ? `${name.slice(0, 57)}...` : name;
}
