/**
 * TEST-UI-001 — Approval notifications (REQ-POLICY-002, §25).
 *
 * These are not cosmetic. A notification is rendered by the operating system,
 * outside every boundary this extension controls, and can outlive the task in
 * a notification centre — so what it may contain is a security rule, not a
 * presentation choice. It also sits on the permission path, where a failure
 * must not be allowed to strand an approval the user is waiting on.
 *
 * Headless Chromium surfaces no notifications at all, so none of this is
 * observable end to end. The port seam is what makes it testable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Notifier, type NotificationPort } from '@/notifications/notifier';

type Shown = Parameters<NotificationPort['create']>[0];

class RecordingPort implements NotificationPort {
  readonly shown: Shown[] = [];
  failWith: Error | undefined;

  create(options: Shown): Promise<string> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.shown.push(options);
    return Promise.resolve(`n_${this.shown.length}`);
  }
}

let port: RecordingPort;

const notifierWith = (isEnabled: () => Promise<boolean>) => new Notifier({ port, isEnabled });
const enabled = () => notifierWith(() => Promise.resolve(true));

beforeEach(() => {
  port = new RecordingPort();
});

describe('when notifications are enabled', () => {
  it('tells the user which tool is waiting', async () => {
    await enabled().permissionRequested('browser.click');

    expect(port.shown).toHaveLength(1);
    expect(port.shown[0]?.title).toBe('Approval needed');
    expect(port.shown[0]?.message).toContain('browser.click');
  });

  it('sends a basic notification with the extension icon', async () => {
    await enabled().permissionRequested('tabs.close');

    expect(port.shown[0]?.type).toBe('basic');
    expect(port.shown[0]?.iconUrl).toBe('icons/icon-128.png');
  });
});

describe('what a notification may contain', () => {
  it('carries the tool name and nothing else from the call', async () => {
    // The notifier is given only the tool name, so there is no path by which
    // an argument could reach the OS. This pins that signature: a future
    // change that starts passing arguments has to change this test first.
    await enabled().permissionRequested('browser.type');

    const body = JSON.stringify(port.shown[0]);
    expect(body).toContain('browser.type');
    expect(body).not.toMatch(/password|secret|value|text|selector/i);
  });

  it('does not leak a tool name that itself looks like page content', async () => {
    // Defensive: whatever the caller passes ends up in the message, so the
    // message is asserted to be exactly the sentence plus that name.
    await enabled().permissionRequested('browser.click');

    expect(port.shown[0]?.message).toBe('The agent is waiting for approval to run browser.click.');
  });
});

describe('when the user has turned notifications off', () => {
  it('shows nothing at all', async () => {
    await notifierWith(() => Promise.resolve(false)).permissionRequested('browser.click');

    expect(port.shown).toEqual([]);
  });

  it('reads the setting on every call, so turning it off takes effect at once', async () => {
    // The setting is read live rather than captured at construction: a user
    // who disables notifications mid-task should stop seeing them.
    let on = true;
    const notifier = notifierWith(() => Promise.resolve(on));

    await notifier.permissionRequested('browser.click');
    on = false;
    await notifier.permissionRequested('browser.navigate');

    expect(port.shown).toHaveLength(1);
    expect(port.shown[0]?.message).toContain('browser.click');
  });

  it('stays quiet when the setting cannot be read', async () => {
    // Failing closed: a missed notification delays a task, while notifying
    // against the user's wishes is the extension overriding a setting.
    const notifier = notifierWith(() => Promise.reject(new Error('storage unavailable')));

    await expect(notifier.permissionRequested('browser.click')).resolves.toBeUndefined();
    expect(port.shown).toEqual([]);
  });
});

describe('when Chrome refuses to show it', () => {
  it('does not fail the approval the user is waiting on', async () => {
    // Chrome rejects when notifications are blocked at the OS level, and
    // headless Chromium has no notification surface at all. Neither may take
    // down the permission flow.
    port.failWith = new Error('Notifications are blocked.');

    await expect(enabled().permissionRequested('browser.click')).resolves.toBeUndefined();
  });

  it('survives a rejection that is not an Error', async () => {
    port.failWith = 'blocked' as unknown as Error;

    await expect(enabled().permissionRequested('browser.click')).resolves.toBeUndefined();
  });
});

describe('the default port', () => {
  it('is used when none is injected', async () => {
    // Guards the production path: the seam must not have made the real
    // chrome.notifications call unreachable.
    const create = vi.fn().mockResolvedValue('n_1');
    vi.stubGlobal('chrome', { notifications: { create } });

    await new Notifier({ isEnabled: () => Promise.resolve(true) }).permissionRequested(
      'browser.click',
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ title: 'Approval needed' });
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// Task endings (§53 "task completed", "task failed")
// ---------------------------------------------------------------------------

describe('telling the user a task ended', () => {
  it('announces a completed task', async () => {
    await enabled().taskFinished('task_1', 'COMPLETED');

    expect(port.shown).toHaveLength(1);
    expect(port.shown[0]?.title).toBe('Task finished');
  });

  it('announces a failed task', async () => {
    await enabled().taskFinished('task_1', 'FAILED');

    expect(port.shown).toHaveLength(1);
    expect(port.shown[0]?.title).toBe('Task failed');
  });

  it('announces a partly finished task, because part is not all', async () => {
    await enabled().taskFinished('task_1', 'PARTIAL');

    expect(port.shown[0]?.title).toBe('Task partly finished');
  });

  it('announces a task that stopped because something was not permitted', async () => {
    await enabled().taskFinished('task_1', 'BLOCKED');

    expect(port.shown[0]?.title).toBe('Task stopped');
  });

  it('says nothing when the user cancelled it themselves', async () => {
    // They were present, they did it, and they know. This is a decision
    // rather than an omission, so it is pinned.
    await enabled().taskFinished('task_1', 'CANCELLED');

    expect(port.shown).toEqual([]);
  });

  it('says nothing for a state that is not an ending', async () => {
    await enabled().taskFinished('task_1', 'RUNNING');

    expect(port.shown).toEqual([]);
  });

  it('announces one task once, however many times it is told', async () => {
    // `TaskManager.transition` treats a move to the state a task is already
    // in as allowed, so the lifecycle observer can fire twice for one ending.
    const notifier = enabled();
    await notifier.taskFinished('task_1', 'COMPLETED');
    await notifier.taskFinished('task_1', 'COMPLETED');
    await notifier.taskFinished('task_1', 'FAILED');

    expect(port.shown).toHaveLength(1);
    expect(port.shown[0]?.title).toBe('Task finished');
  });

  it('keeps separate tasks separate', async () => {
    const notifier = enabled();
    await notifier.taskFinished('task_1', 'COMPLETED');
    await notifier.taskFinished('task_2', 'COMPLETED');

    expect(port.shown).toHaveLength(2);
  });

  it('stays silent when the user turned notifications off', async () => {
    await notifierWith(() => Promise.resolve(false)).taskFinished('task_1', 'COMPLETED');

    expect(port.shown).toEqual([]);
  });

  it('does not replay a missed ending when the setting is turned back on', async () => {
    // A task is announced at most once whatever the setting said at the time.
    // Someone enabling notifications is asking about the next task, not
    // asking to be told about one that already finished.
    let on = false;
    const notifier = notifierWith(() => Promise.resolve(on));
    await notifier.taskFinished('task_1', 'COMPLETED');
    on = true;
    await notifier.taskFinished('task_1', 'COMPLETED');

    expect(port.shown).toEqual([]);
  });

  it('does not throw when the browser refuses the notification', async () => {
    // A toast is a supporting signal, never task authority. The task that
    // finished has already finished; nothing about it may depend on this.
    port.failWith = new Error('Notifications are blocked.');

    await expect(enabled().taskFinished('task_1', 'COMPLETED')).resolves.toBeUndefined();
  });
});

describe('what a task notification may contain', () => {
  const STATES = ['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED'] as const;

  it('is given the task id and a state, so nothing else can reach the OS', async () => {
    // The signature is the control. An objective is user-typed and a summary
    // is model-authored, and both can carry whatever was read from a page; a
    // notification outlives the task in a notification centre. A change that
    // starts passing either has to change this test first.
    for (const state of STATES) {
      await enabled().taskFinished(`task_${state}`, state);
    }

    for (const shown of port.shown) {
      expect(shown.message).not.toMatch(/https?:/);
      expect(shown.message).not.toMatch(/sk-|Bearer|password|token/i);
    }
  });

  it('never carries the task id itself', async () => {
    // An identifier tells the user nothing and correlates the toast with the
    // trail for anyone reading over their shoulder.
    await enabled().taskFinished('task_7f3a9c', 'COMPLETED');

    expect(JSON.stringify(port.shown[0])).not.toContain('task_7f3a9c');
  });
});

describe('telling the user a connector needs reconnecting', () => {
  it('names the connector and what has to happen', async () => {
    await enabled().connectorAuthExpired('GitHub');

    expect(port.shown).toHaveLength(1);
    expect(port.shown[0]?.title).toBe('Reconnect needed');
    expect(port.shown[0]?.message).toContain('GitHub');
  });

  it('stays silent when the user turned notifications off', async () => {
    await notifierWith(() => Promise.resolve(false)).connectorAuthExpired('GitHub');

    expect(port.shown).toEqual([]);
  });

  it('does not throw when the browser refuses it', async () => {
    port.failWith = new Error('blocked');

    await expect(enabled().connectorAuthExpired('GitHub')).resolves.toBeUndefined();
  });
});
