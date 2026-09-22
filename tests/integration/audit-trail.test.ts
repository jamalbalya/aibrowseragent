/**
 * TEST-AUDIT-001 — dispatch → observation → audit record, over the real path.
 *
 * The claim is that the trail records what actually happened: one record per
 * dispatch, with the decision the gates reached, and nothing the gates were
 * deciding about. Everything here runs over the real registry, policy engine,
 * permission engine and egress gate.
 */
import { describe, expect, it, vi } from 'vitest';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { AuditLog } from '@/audit/audit-log';
import { createDispatchAuditObserver } from '@/audit/dispatch-audit';
import { buildShortcutHarness } from '../fixtures/shortcut-harness';
import type { TaintState } from '@/security/taint/taint-state';

const UNTAINTED: TaintState = { kind: 'KNOWN_UNTAINTED' };
const SALT = 'ab'.repeat(32);

const TOOLS = [
  { name: 'fake.read', risk: 'R0' as const, returns: { title: 'A page' } },
  { name: 'fake.write', risk: 'R3' as const, returns: { written: true } },
  {
    name: 'fake.send',
    risk: 'R1' as const,
    returns: { sent: true },
    egressTo: 'https://elsewhere.test/collect',
  },
];

function withAudit(options: Parameters<typeof buildShortcutHarness>[0] = {}) {
  const audit = new AuditLog(new SerializedStorageArea(new MemoryStorageArea()), {
    // Stated: with no validator every tool name records as `(unknown)`,
    // because nothing verified it. These cases exercise the wiring, not the
    // verification, so they say which names this world knows about.
    knownTool: (name) =>
      name.startsWith('browser.') || name.startsWith('skills.') || name.startsWith('fake.'),
    now: () => 1_700_000_000_000,
  });
  const harness = buildShortcutHarness(options);
  const observer = createDispatchAuditObserver({ audit });
  return { audit, harness, observer };
}

function invocation(name: string, args: Record<string, unknown> = {}) {
  return {
    toolCallId: `tc_${Math.random().toString(16).slice(2)}`,
    taskId: 'task_skill_1',
    sessionId: 'session_skill',
    name,
    arguments: args,
    taintState: UNTAINTED,
    taintSalt: SALT,
    saltEpoch: 1,
    signal: new AbortController().signal,
  };
}

describe('every dispatch leaves exactly one record', () => {
  it('records a success as invoked and allowed', async () => {
    const { audit, harness, observer } = withAudit({ tools: TOOLS });
    const result = await harness.tools.dispatch(
      invocation('fake.read', { url: 'https://x.test/' }),
    );
    observer({
      taskId: 'task_skill_1',
      toolCallId: 'tc_1',
      tool: 'fake.read',
      arguments: { url: 'https://x.test/' },
      risk: result.risk,
      executed: result.executed,
      status: result.envelope.status,
    });

    await vi.waitFor(async () => expect((await audit.list()).length).toBe(1));
    const [event] = await audit.list();
    expect(event).toMatchObject({
      type: 'tool.invoked',
      taskId: 'task_skill_1',
      tool: 'fake.read',
      outcome: 'allowed',
      executed: true,
    });
    // The URL it was called with is nowhere in the record.
    expect(JSON.stringify(event)).not.toContain('x.test');
  });

  it('records a permission refusal as refused and denied, with nothing executed', async () => {
    const { audit, harness, observer } = withAudit({ tools: TOOLS, permissionMode: 'manual' });
    harness.respondWith('deny');

    const result = await harness.tools.dispatch(invocation('fake.write', { submit: true }));
    observer({
      taskId: 'task_skill_1',
      toolCallId: 'tc_1',
      tool: 'fake.write',
      arguments: { submit: true },
      risk: result.risk,
      executed: result.executed,
      status: result.envelope.status,
      ...(result.envelope.error ? { errorCode: result.envelope.error.code } : {}),
    });

    await vi.waitFor(async () => expect((await audit.list()).length).toBe(1));
    const [event] = await audit.list();
    expect(event?.type).toBe('tool.refused');
    expect(event?.outcome).toBe('denied');
    expect(event?.executed).toBe(false);
    expect(harness.seen).toHaveLength(0);
  });

  it('records an egress refusal without recording what was being sent', async () => {
    const { audit, harness, observer } = withAudit({ tools: TOOLS, permissionMode: 'manual' });
    harness.respondWith('deny');

    const secretish = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const result = await harness.tools.dispatch(invocation('fake.send', { body: secretish }));
    observer({
      taskId: 'task_skill_1',
      toolCallId: 'tc_1',
      tool: 'fake.send',
      arguments: { body: secretish },
      risk: result.risk,
      executed: result.executed,
      status: result.envelope.status,
    });

    await vi.waitFor(async () => expect((await audit.list()).length).toBe(1));
    expect(JSON.stringify(await audit.list())).not.toContain(secretish);
  });

  it('keeps two tasks apart in the one stream', async () => {
    const { audit } = withAudit({ tools: TOOLS });
    await audit.record({
      type: 'tool.invoked',
      taskId: 'task_a',
      tool: 'fake.read',
      outcome: 'allowed',
    });
    await audit.record({
      type: 'tool.invoked',
      taskId: 'task_b',
      tool: 'fake.read',
      outcome: 'allowed',
    });
    await audit.record({
      type: 'tool.invoked',
      taskId: 'task_a',
      tool: 'fake.read',
      outcome: 'allowed',
    });

    expect((await audit.page({ taskId: 'task_a' })).total).toBe(2);
    expect((await audit.page({ taskId: 'task_b' })).total).toBe(1);
    expect((await audit.page({})).total).toBe(3);
  });

  it('pages newest first, with a stable total', async () => {
    const { audit } = withAudit({ tools: TOOLS });
    for (let index = 0; index < 120; index += 1) {
      await audit.record({ type: 'task.state', taskId: `task_${index}`, outcome: 'info' });
    }
    const first = await audit.page({ limit: 50 });
    const second = await audit.page({ limit: 50, offset: 50 });

    expect(first.events).toHaveLength(50);
    expect(second.events).toHaveLength(50);
    expect(first.total).toBe(second.total);
    // Newest first: the head of page one outranks the head of page two.
    expect(first.events[0]!.seq).toBeGreaterThan(second.events[0]!.seq);
  });

  it('survives a failing audit write without changing what the tool did', async () => {
    const { harness } = withAudit({ tools: TOOLS });
    const inner = new MemoryStorageArea();
    const broken = new AuditLog(new SerializedStorageArea(inner), { now: () => 1 });
    vi.spyOn(inner, 'set').mockRejectedValue(new Error('QuotaExceededError'));
    const observer = createDispatchAuditObserver({ audit: broken });

    const result = await harness.tools.dispatch(invocation('fake.read', {}));
    observer({
      taskId: 'task_skill_1',
      toolCallId: 'tc_1',
      tool: 'fake.read',
      arguments: {},
      risk: result.risk,
      executed: result.executed,
      status: result.envelope.status,
    });

    // The execution stands. A gap in the record of something is not a
    // failure of the thing.
    expect(result.envelope.status).toBe('success');
    expect(result.executed).toBe(true);
    expect(harness.seen).toHaveLength(1);
    vi.restoreAllMocks();
  });
});
