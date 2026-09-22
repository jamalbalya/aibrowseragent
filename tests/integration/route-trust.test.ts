/**
 * TEST-ROUTETRUST-002 — route trust wired to real collaborators (D-1, D-2).
 *
 * The unit suite proves the classifier reads the fields it is given, and the
 * real-Chromium suite proves Chrome produces those fields. This one sits in
 * between and proves the *composition*: a real `MessageRouter` in front of
 * real handlers, a real `PermissionBroker` holding a live prompt, a real
 * `AuditLog` over real storage.
 *
 * What that catches which neither neighbour does: a check that is correct in
 * isolation but wired after the side effect, a refusal that resolves a
 * pending request on its way out, or an export document built before the
 * request was authorised.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { MessageRouter } from '@/background/message-router';
import { PermissionBroker } from '@/background/permission-broker';
import {
  AuditLog,
  buildAuditExport,
  describeScopeProblem,
  parseAuditExportScope,
} from '@/audit/audit-log';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { createError } from '@/types/result';
import {
  classifySender,
  senderMayBroadcastEvent,
  senderMayInvokeContentRoute,
} from '@/messaging/route-trust';
import { TEST_IDENTITY, contentSender, panelSender, workerSender } from '../fixtures/senders';
import type { PermissionRequest } from '@/policy/permission-engine';

beforeAll(() => {
  // The broker broadcasts, and a broadcast needs `chrome.runtime`.
  (globalThis as unknown as { chrome: unknown }).chrome ??= {
    runtime: { id: TEST_IDENTITY.extensionId, sendMessage: () => Promise.resolve(undefined) },
  };
});

const request = (id: string, taskId: string): PermissionRequest => ({
  id,
  taskId,
  tool: 'browser.download',
  risk: 'R3',
  reason: 'writes a file',
  site: 'example.com',
  summary: 'Download a file.',
  createdAt: 1,
  elevated: false,
});

/**
 * The worker's composition, in miniature: the routes this wave protects,
 * wired to the collaborators that actually hold the state.
 */
function worldUnderTest() {
  const audit = new AuditLog(new SerializedStorageArea(new MemoryStorageArea()));
  const broker = new PermissionBroker({ timeoutMs: 60_000 });
  const ran: string[] = [];
  const refusals: { route: string; senderClass: string }[] = [];

  const router = new MessageRouter({
    identity: TEST_IDENTITY,
    onRefused: ({ route, senderClass }) => {
      refusals.push({ route, senderClass });
      void audit.record({ type: 'route.refused', outcome: 'denied', route, senderClass });
    },
  });

  router.on('permission.listPending', () => {
    ran.push('permission.listPending');
    return Promise.resolve({ requests: broker.listPending() });
  });
  router.on('permission.respond', ({ requestId, response }) => {
    ran.push('permission.respond');
    broker.respond(requestId, response);
    return Promise.resolve({ ok: true as const });
  });
  router.on('task.create', () => {
    ran.push('task.create');
    return Promise.resolve({ task: { id: 'task_created' } as never });
  });
  router.on('audit.export', async ({ scope, limit }) => {
    ran.push('audit.export');
    const verdict = parseAuditExportScope(scope);
    if (!verdict.ok) {
      throw Object.assign(new Error('bad scope'), {
        agentError: createError('INVALID_ARGUMENT', `refused: ${verdict.problem}`, {
          userMessage: describeScopeProblem(verdict.problem),
        }),
      });
    }
    const chosen = verdict.scope;
    const page = await audit.page({
      ...(chosen.kind === 'task' ? { taskId: chosen.taskId } : {}),
      limit: Math.min(limit ?? 2000, 5000),
    });
    return {
      export: buildAuditExport(page.events, Date.now(), chosen, await audit.verifyIntegrity()),
    };
  });

  return { audit, broker, router, ran, refusals };
}

describe('a route reaches its handler only for the panel', () => {
  it('routes a panel message through to the handler', async () => {
    const { router, ran } = worldUnderTest();
    const envelope = await router.route('task.create', { objective: 'x' }, panelSender);
    expect(envelope.ok).toBe(true);
    expect(ran).toEqual(['task.create']);
  });

  it('does not execute the handler for a content-script message', async () => {
    const { router, ran, refusals } = worldUnderTest();
    const envelope = await router.route('task.create', { objective: 'x' }, contentSender);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe('PERMISSION_DENIED');
    expect(ran).toEqual([]);
    expect(refusals).toEqual([{ route: 'task.create', senderClass: 'CONTENT_SCRIPT' }]);
  });

  it('records the refusal in the real trail, with no page-derived material', async () => {
    const { router, audit } = worldUnderTest();
    await router.route('task.create', { objective: 'x' }, contentSender);
    // The write is fire-and-forget on the refusal path.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const events = await audit.list();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('route.refused');
    expect(events[0]?.senderClass).toBe('CONTENT_SCRIPT');
    expect(JSON.stringify(events[0])).not.toContain('example.com');
  });
});

describe('a pending request survives a refused answer', () => {
  it('leaves the prompt waiting for a person, and binds the answer to the request', async () => {
    const { router, broker } = worldUnderTest();
    let settled: unknown = null;
    const pending = broker.prompt(request('req-1', 'task_1')).then((value) => {
      settled = value;
    });

    // Refused: the id oracle stays closed…
    expect((await router.route('permission.listPending', {}, contentSender)).ok).toBe(false);
    // …and the answer is refused even though the id is correct.
    expect(
      (
        await router.route(
          'permission.respond',
          { requestId: 'req-1', response: { kind: 'approve_site', maxRisk: 'R5' } },
          contentSender,
        )
      ).ok,
    ).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBeNull();
    expect(broker.listPending()).toHaveLength(1);

    // The panel answers its own prompt, and the binding still holds: an id
    // that names nothing resolves nothing.
    expect(
      (
        await router.route(
          'permission.respond',
          { requestId: 'req-does-not-exist', response: { kind: 'approve_once' } },
          panelSender,
        )
      ).ok,
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBeNull();

    await router.route(
      'permission.respond',
      { requestId: 'req-1', response: { kind: 'approve_once' } },
      panelSender,
    );
    await pending;
    expect(settled).toEqual({ kind: 'approve_once' });
  });

  it('keeps two prompts independent when one is refused', async () => {
    const { router, broker } = worldUnderTest();
    const first = broker.prompt(request('req-a', 'task_a'));
    const second = broker.prompt(request('req-b', 'task_b'));

    await router.route(
      'permission.respond',
      { requestId: 'req-a', response: { kind: 'deny' } },
      contentSender,
    );
    expect(
      broker
        .listPending()
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(['req-a', 'req-b']);

    broker.denyAll();
    expect(await first).toEqual({ kind: 'deny' });
    expect(await second).toEqual({ kind: 'deny' });
  });
});

describe('the event channel and the content channel', () => {
  it('admits only the worker to each', () => {
    expect(senderMayBroadcastEvent(classifySender(workerSender, TEST_IDENTITY))).toBe(true);
    expect(senderMayInvokeContentRoute(classifySender(workerSender, TEST_IDENTITY))).toBe(true);
    for (const sender of [contentSender, panelSender, undefined]) {
      const senderClass = classifySender(sender, TEST_IDENTITY);
      expect(senderMayBroadcastEvent(senderClass)).toBe(false);
      expect(senderMayInvokeContentRoute(senderClass)).toBe(false);
    }
  });
});

describe('audit.export through the real route', () => {
  async function seeded() {
    const world = worldUnderTest();
    await world.audit.record({ type: 'task.created', outcome: 'info', taskId: 'task_one' });
    await world.audit.record({ type: 'task.completed', outcome: 'allowed', taskId: 'task_one' });
    await world.audit.record({ type: 'task.created', outcome: 'info', taskId: 'task_two' });
    return world;
  }

  it('exports only the named task for a task scope', async () => {
    const { router } = await seeded();
    const envelope = await router.route(
      'audit.export',
      { scope: { kind: 'task', taskId: 'task_one' } },
      panelSender,
    );
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    const document_ = (
      envelope.value as { export: { events: { taskId?: string }[]; scope: unknown } }
    ).export;
    expect(document_.scope).toEqual({ kind: 'task', taskId: 'task_one' });
    expect(document_.events.every((event) => event.taskId === 'task_one')).toBe(true);
    expect(document_.events).toHaveLength(2);
  });

  it('exports every task for an all scope, and says so in the artefact', async () => {
    const { router } = await seeded();
    const envelope = await router.route('audit.export', { scope: { kind: 'all' } }, panelSender);
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    const document_ = (envelope.value as { export: { events: unknown[]; scope: unknown } }).export;
    expect(document_.scope).toEqual({ kind: 'all' });
    expect(document_.events.length).toBe(3);
  });

  it('refuses an omitted scope, and builds no document', async () => {
    const { router } = await seeded();
    const envelope = await router.route('audit.export', {}, panelSender);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe('INVALID_ARGUMENT');
    expect(envelope).not.toHaveProperty('value');
  });

  it('refuses every malformed scope the contract names', async () => {
    const { router } = await seeded();
    const bad = [
      null,
      'all',
      7,
      [{ kind: 'all' }],
      {},
      { kind: 'unknown' },
      { kind: 'task' },
      { kind: 'task', taskId: '' },
      { kind: 'task', taskId: 7 },
      { kind: 'all', taskId: 'task_one' },
    ];
    for (const scope of bad) {
      const envelope = await router.route('audit.export', { scope }, panelSender);
      expect(envelope.ok, `${JSON.stringify(scope)} was accepted`).toBe(false);
      if (!envelope.ok) expect(envelope.error.code).toBe('INVALID_ARGUMENT');
    }
  });

  it('refuses an all-task export to a content script before any scope is read', async () => {
    const { router, ran } = await seeded();
    const envelope = await router.route('audit.export', { scope: { kind: 'all' } }, contentSender);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe('PERMISSION_DENIED');
    // The handler never ran, so `parseAuditExportScope` was never reached and
    // no document was built. Sender first, scope second.
    expect(ran).toEqual([]);
  });

  it('exports an empty, correctly scoped document for a task with no records', async () => {
    // Not an error: a task that did nothing has nothing to show, and the
    // artefact still names the scope it is an export of. Stated because the
    // scope validator checks an identifier's shape, not whether a task with
    // that id exists — nothing cross-task can leak either way.
    const { router } = await seeded();
    const envelope = await router.route(
      'audit.export',
      { scope: { kind: 'task', taskId: 'task_absent' } },
      panelSender,
    );
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    const document_ = (envelope.value as { export: { events: unknown[]; scope: unknown } }).export;
    expect(document_.events).toEqual([]);
    expect(document_.scope).toEqual({ kind: 'task', taskId: 'task_absent' });
  });
});
