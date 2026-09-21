/**
 * TEST-POLICY-003 — Permission broker (REQ-POLICY-003).
 *
 * The broker bridges an engine that awaits a decision and a UI that may not be
 * open. Its failure mode must always be "nothing happens", never "the action
 * proceeds".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionBroker } from '@/background/permission-broker';
import type { PermissionRequest } from '@/policy/permission-engine';
import type * as MessagingBus from '@/messaging/bus';

vi.mock('@/messaging/bus', async (importOriginal) => {
  const actual = await importOriginal<typeof MessagingBus>();
  return { ...actual, broadcastEvent: vi.fn() };
});

const request = (overrides: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: 'perm_1',
  taskId: 'task_1',
  tool: 'browser.click',
  risk: 'R2',
  reason: 'Changes page state.',
  site: 'example.com',
  summary: 'browser.click {"elementId":"e1"}',
  createdAt: 0,
  elevated: false,
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PermissionBroker', () => {
  it('resolves with the response the user gave', async () => {
    const broker = new PermissionBroker();
    const pending = broker.prompt(request());

    expect(broker.listPending()).toHaveLength(1);
    broker.respond('perm_1', { kind: 'approve_once' });

    await expect(pending).resolves.toEqual({ kind: 'approve_once' });
    expect(broker.listPending()).toHaveLength(0);
  });

  it('denies a request that is never answered', async () => {
    // A prompt whose panel was closed must not hold the task open forever,
    // and must not resolve as approval.
    const broker = new PermissionBroker({ timeoutMs: 1000 });
    const pending = broker.prompt(request());

    vi.advanceTimersByTime(1001);

    await expect(pending).resolves.toEqual({ kind: 'deny' });
    expect(broker.listPending()).toHaveLength(0);
  });

  it('ignores a response for a request that already resolved', async () => {
    const broker = new PermissionBroker({ timeoutMs: 1000 });
    const pending = broker.prompt(request());
    vi.advanceTimersByTime(1001);
    await pending;

    expect(broker.respond('perm_1', { kind: 'approve_once' })).toBe(false);
  });

  it('ignores a response for an unknown request id', () => {
    expect(new PermissionBroker().respond('nope', { kind: 'approve_once' })).toBe(false);
  });

  it('denies everything on teardown', async () => {
    const broker = new PermissionBroker();
    const first = broker.prompt(request({ id: 'p1' }));
    const second = broker.prompt(request({ id: 'p2' }));

    broker.denyAll();

    await expect(first).resolves.toEqual({ kind: 'deny' });
    await expect(second).resolves.toEqual({ kind: 'deny' });
    expect(broker.listPending()).toHaveLength(0);
  });

  it('denies only the requests belonging to a cancelled task', async () => {
    const broker = new PermissionBroker();
    const mine = broker.prompt(request({ id: 'p1', taskId: 'task_1' }));
    void broker.prompt(request({ id: 'p2', taskId: 'task_2' }));

    broker.denyForTask('task_1');

    await expect(mine).resolves.toEqual({ kind: 'deny' });
    expect(broker.listPending().map((r) => r.id)).toEqual(['p2']);
  });

  it('notifies when a prompt is raised', () => {
    const notify = vi.fn();
    const broker = new PermissionBroker({ notify });
    void broker.prompt(request());
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ tool: 'browser.click' }));
  });

  it('keeps several concurrent prompts independent', async () => {
    const broker = new PermissionBroker();
    const first = broker.prompt(request({ id: 'p1' }));
    const second = broker.prompt(request({ id: 'p2' }));

    broker.respond('p2', { kind: 'approve_site', maxRisk: 'R2' });

    await expect(second).resolves.toEqual({ kind: 'approve_site', maxRisk: 'R2' });
    expect(broker.listPending().map((r) => r.id)).toEqual(['p1']);

    broker.respond('p1', { kind: 'deny' });
    await expect(first).resolves.toEqual({ kind: 'deny' });
  });
});
