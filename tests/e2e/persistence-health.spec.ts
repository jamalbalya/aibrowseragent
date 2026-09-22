/**
 * TEST-E2E-016 — persistence health across a real worker death (D-3).
 *
 * REAL BROWSER. The whole point of this wave is what happens when the service
 * worker that noticed a failure stops existing, and MV3 eviction is not
 * something a unit test can stage: an in-memory flag and a persisted record
 * behave identically until the process goes away.
 *
 * So the worker is really terminated here, by closing its CDP target, and the
 * question asked afterwards is the one that matters — does the extension come
 * back knowing what it lost, or does it come back looking fine?
 */
import {
  connectProvider,
  expect,
  killServiceWorker,
  openPanel,
  test,
  ask,
} from './fixtures/extension';

interface Snapshot {
  readonly records: { domain: string; state: string; reason: string }[];
  readonly gating: string;
  readonly blocked: boolean;
}

/** Writes a health record the way a failing store would, through real storage. */
async function reportFailure(
  serviceWorker: { evaluate: (fn: string) => Promise<unknown> },
  domain: string,
  state: string,
): Promise<void> {
  // Written through `chrome.storage.local` directly, under the namespace the
  // worker reads, because staging a real quota failure in Chromium is not
  // something a test can do on demand. What is being proved here is the
  // *lifecycle* — that a record written before a death is honoured after one
  // — and the failure paths that write it are covered in the unit and
  // security suites.
  await serviceWorker.evaluate(`
    (async () => {
      const key = 'health:persistence-health';
      await chrome.storage.local.set({
        [key]: { records: [{ domain: ${JSON.stringify(domain)}, state: ${JSON.stringify(state)},
                 reason: 'staged by an end-to-end test', since: Date.now(), reports: 1 }] },
      });
    })()
  `);
}

test('a persistence failure survives a real worker termination', async ({
  context,
  extensionId,
  serviceWorker,
  send,
}) => {
  const before = (await send('health.get', {})) as unknown as { snapshot: Snapshot };
  expect(before.snapshot.blocked).toBe(false);
  expect(before.snapshot.gating).toBe('HEALTHY');

  await reportFailure(serviceWorker, 'task-security', 'DEGRADED');

  // The worker that wrote it is destroyed. A flag in its memory would go with
  // it; this is the whole test.
  await killServiceWorker(context, serviceWorker);
  const panel = await openPanel(context, extensionId);

  const after = await ask<{ snapshot: Snapshot }>(panel, 'health.get', {});
  expect(after.snapshot.gating).toBe('DEGRADED');
  expect(after.snapshot.blocked).toBe(true);
  await panel.close();
});

test('a task cannot be started while persistence is degraded, and can be after acknowledgement', async ({
  context,
  extensionId,
  provider,
  send,
  serviceWorker,
}) => {
  await connectProvider(send, provider);
  provider.script([{ kind: 'text', text: 'done' }]);

  await reportFailure(serviceWorker, 'task-security', 'DEGRADED');
  await killServiceWorker(context, serviceWorker);
  const panel = await openPanel(context, extensionId);

  // Refused, and refused by policy rather than by an error that reads as a
  // transient fault someone would retry.
  await expect(ask(panel, 'task.create', { objective: 'do something' })).rejects.toThrow(
    /POLICY_BLOCKED/,
  );

  // A person says they have seen it. Nothing was repaired — that is the point
  // of it being a person's action rather than an automatic recovery.
  const cleared = await ask<{ snapshot: Snapshot }>(panel, 'health.acknowledge', {
    domain: 'task-security',
  });
  expect(cleared.snapshot.blocked).toBe(false);

  const created = await ask<{ task: { id: string } }>(panel, 'task.create', {
    objective: 'do something',
  });
  expect(created.task.id).toBeTruthy();
  await ask(panel, 'task.cancel', { taskId: created.task.id });
  await panel.close();
});

test('a degraded audit trail does not stop a task', async ({
  context,
  extensionId,
  provider,
  send,
  serviceWorker,
}) => {
  // The opposite requirement, in the same mechanism. A gap in the record of
  // an execution that already happened must not become a stopped execution —
  // so the audit domain is reported and is deliberately not a gate.
  await connectProvider(send, provider);
  provider.script([{ kind: 'text', text: 'done' }]);

  await reportFailure(serviceWorker, 'audit', 'IRRECOVERABLE');
  await killServiceWorker(context, serviceWorker);
  const panel = await openPanel(context, extensionId);

  const snapshot = await ask<{ snapshot: Snapshot }>(panel, 'health.get', {});
  expect(snapshot.snapshot.records.find((record) => record.domain === 'audit')?.state).toBe(
    'IRRECOVERABLE',
  );
  expect(snapshot.snapshot.blocked).toBe(false);

  const created = await ask<{ task: { id: string } }>(panel, 'task.create', {
    objective: 'do something',
  });
  expect(created.task.id).toBeTruthy();
  await ask(panel, 'task.cancel', { taskId: created.task.id });
  await panel.close();
});

test('health is not reachable from a content script', async ({ context, site }) => {
  // The routes added by this wave are classified like every other one, so
  // this is a regression guard on the class table as much as on the routes.
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const isolated: number[] = [];
  cdp.on('Runtime.executionContextCreated', ({ context: created }) => {
    const aux = created.auxData as { type?: string } | undefined;
    if (aux?.type === 'isolated') isolated.push(created.id);
  });
  await cdp.send('Runtime.enable');
  await page.goto(`${site.baseUrl}/`);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const contextId = isolated.at(-1);
  expect(contextId, 'the content script did not run').toBeTruthy();

  for (const route of ['health.get', 'health.acknowledge']) {
    const { result } = await cdp.send('Runtime.evaluate', {
      contextId: contextId!,
      expression: `chrome.runtime.sendMessage({ id: 'x', type: ${JSON.stringify(route)},
        timestamp: Date.now(), payload: { domain: 'task-security' } })
        .catch(() => ({ ok: false, error: { code: 'THREW' } }))`,
      awaitPromise: true,
      returnByValue: true,
    });
    const envelope = result.value as { ok: boolean; error?: { code: string } };
    expect(envelope.ok, `${route} was not refused`).toBe(false);
    expect(envelope.error?.code).toBe('PERMISSION_DENIED');
  }
  await cdp.detach();
  await page.close();
});
