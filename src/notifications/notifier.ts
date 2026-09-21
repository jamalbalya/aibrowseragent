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
