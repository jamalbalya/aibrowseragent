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
