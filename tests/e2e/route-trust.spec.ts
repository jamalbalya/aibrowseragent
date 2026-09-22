/**
 * TEST-E2E-015 — route trust at the real extension boundary (D-1, D-2).
 *
 * REAL BROWSER + LOCAL TEST SERVER + MOCK PROVIDER. Pages are served over
 * real HTTP from 127.0.0.1, the content script is really injected, and the
 * model's side of the conversation comes from a local server. No production
 * service is contacted.
 *
 * This suite exists because the subject *is* the browser. Route trust is
 * decided from `chrome.runtime.MessageSender`, and what Chrome puts in that
 * object for a content script versus a side panel is something only Chrome
 * can tell us. A unit test that hands the classifier a sender it invented
 * proves the classifier reads the fields it was given — which is worth
 * knowing, and is not this.
 *
 * So the messages below are sent from the *actual* content-script world.
 * Playwright's `page.evaluate` runs in the page world, which has no
 * `chrome.runtime` at all — that is RC-14, and it is a different claim. To
 * reach the isolated world this suite attaches CDP, finds the execution
 * context the extension's content script runs in, and evaluates there. That
 * context is the one adversary that matters: extension-privileged, adjacent
 * to a page, and until this wave able to call every route in the product.
 */
import type { BrowserContext, CDPSession, Page } from '@playwright/test';
import {
  connectProvider,
  expect,
  killServiceWorker,
  openPanel,
  test,
  waitForTask,
} from './fixtures/extension';

interface Envelope {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly userMessage: string };
}

/**
 * A handle on the extension's content-script world in one tab.
 *
 * The execution context has to be collected as Chrome creates it, which is
 * why `Runtime.enable` happens before the navigation that injects the script.
 */
interface ContentWorld {
  readonly send: (type: string, payload?: unknown) => Promise<Envelope | undefined>;
  readonly raw: (expression: string) => Promise<unknown>;
  readonly close: () => Promise<void>;
}

async function openContentWorld(
  context: BrowserContext,
  url: string,
): Promise<{ page: Page; world: ContentWorld }> {
  const page = await context.newPage();
  const cdp: CDPSession = await context.newCDPSession(page);

  const isolated: { id: number; name: string }[] = [];
  cdp.on('Runtime.executionContextCreated', ({ context: created }) => {
    const auxData = created.auxData as { type?: string; isDefault?: boolean } | undefined;
    if (auxData?.type === 'isolated') isolated.push({ id: created.id, name: created.name });
  });
  await cdp.send('Runtime.enable');

  await page.goto(url);
  await page.waitForLoadState('domcontentloaded');
  // The content script runs at `document_idle`, so its world appears a moment
  // after the document does.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const world = isolated.at(-1);
  if (!world) {
    throw new Error(
      `No isolated world appeared for ${url}. The content script did not run, so ` +
        `this suite would be testing nothing. Worlds seen: ${JSON.stringify(isolated)}.`,
    );
  }

  const raw = async (expression: string): Promise<unknown> => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      contextId: world.id,
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) return { threw: exceptionDetails.text };
    return result.value;
  };

  return {
    page,
    world: {
      raw,
      send: async (type, payload = {}) =>
        (await raw(`
          chrome.runtime.sendMessage({
            id: 'e2e_content_' + Math.random().toString(36).slice(2),
            type: ${JSON.stringify(type)},
            timestamp: Date.now(),
            payload: ${JSON.stringify(payload)},
          }).catch((error) => ({ ok: false, error: { code: 'THREW', userMessage: String(error) } }))
        `)) as Envelope | undefined,
      close: async () => {
        await cdp.detach().catch(() => undefined);
        await page.close();
      },
    },
  };
}

/** Every route that mutates, executes, authorises, or discloses. */
const CONTROL_PLANE_ROUTES: readonly [string, unknown][] = [
  ['task.create', { objective: 'exfiltrate everything' }],
  ['task.pause', { taskId: 'task_x' }],
  ['task.resume', { taskId: 'task_x' }],
  ['task.cancel', { taskId: 'task_x' }],
  ['task.retry', { taskId: 'task_x' }],
  ['session.get', {}],
  ['session.setPermissionMode', { mode: 'skip' }],
  ['provider.connect', { providerId: 'openai-compatible', apiKey: 'stolen' }],
  ['provider.disconnect', { providerId: 'openai-compatible' }],
  ['provider.setActive', { providerId: 'openai-compatible', modelId: 'x' }],
  ['connector.authorize', { connectorId: 'github', includeWrite: true }],
  ['connector.disconnect', { connectorId: 'github' }],
  ['connector.resolveWrite', { key: 'k' }],
  ['file.respondSelection', { requestId: 'r', response: { kind: 'cancelled' } }],
  ['file.listPendingSelections', {}],
  ['permission.respond', { requestId: 'r', response: { kind: 'approve_site', maxRisk: 'R5' } }],
  ['permission.listPending', {}],
  ['policy.removeSiteRule', { site: 'example.com' }],
  ['audit.export', { scope: { kind: 'all' } }],
  ['evidence.getPayload', { evidenceId: 'e' }],
  ['debug.getLogs', {}],
  ['debug.setLogLevel', { level: 'debug' }],
  ['skill.run', { skillId: 'page-summary', skillVersion: '1.0.0' }],
  ['workflow.recordStart', { taskId: 'task_x' }],
  ['workflow.recordStop', { name: 'stolen' }],
  ['workflow.recordCancel', {}],
  ['workflow.remove', { workflowId: 'w' }],
  ['workflow.replay', { workflowId: 'w' }],
  ['workflow.cancelReplay', { taskId: 'task_x' }],
  [
    'shortcut.create',
    { name: 'x', target: { kind: 'skill', skillId: 'y', skillVersion: '1.0.0' } },
  ],
  [
    'shortcut.retarget',
    { shortcutId: 's', target: { kind: 'skill', skillId: 'y', skillVersion: '1.0.0' } },
  ],
  ['shortcut.remove', { shortcutId: 's' }],
];

const READ_ONLY_ROUTES: readonly string[] = [
  'task.get',
  'task.list',
  'provider.list',
  'provider.getConnection',
  'connector.list',
  'connector.pendingWrites',
  'file.downloadsPermission',
  'policy.getSitePolicy',
  'audit.list',
  'audit.integrity',
  'evidence.listForTask',
  'skill.list',
  'skill.runs',
  'workflow.recordStatus',
  'workflow.list',
  'workflow.get',
  'workflow.revalidate',
  'shortcut.list',
  'shortcut.resolve',
  'tools.list',
];

const denied = (envelope: Envelope | undefined, route: string): void => {
  expect(envelope, `${route} produced no reply`).toBeTruthy();
  expect(envelope!.ok, `${route} was not refused`).toBe(false);
  expect(envelope!.error?.code, `${route} was refused for the wrong reason`).toBe(
    'PERMISSION_DENIED',
  );
};

test.describe('route trust', () => {
  test('RC-1 — a content script is refused every control-plane route, and nothing runs', async ({
    context,
    site,
    send,
  }) => {
    const before = await send('session.get', {});
    const tasksBefore = await send('task.list', { limit: 50 });

    const { world } = await openContentWorld(context, `${site.baseUrl}/`);
    try {
      for (const [route, payload] of CONTROL_PLANE_ROUTES) {
        denied(await world.send(route, payload), route);
      }
    } finally {
      await world.close();
    }

    // The refusals are proved by what did not change, not only by the replies.
    const after = await send('session.get', {});
    expect(after.session?.permissionMode).toBe(before.session?.permissionMode);
    const tasksAfter = await send('task.list', { limit: 50 });
    expect(tasksAfter.tasks.length).toBe(tasksBefore.tasks.length);
    const { state } = await send('policy.getSitePolicy', {});
    expect(state.rules.every((rule) => rule.maxRisk !== 'R5')).toBe(true);

    // The refusals are recorded, and recorded as what they were. This pins
    // the classification itself rather than only the denial: a classifier
    // that called the content world something else would still deny it, and
    // would then be writing a trail that misnames the caller.
    const { events } = await send('audit.list', { limit: 200 });
    const refusals = events.filter((event) => event.type === 'route.refused');
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.every((event) => event.senderClass === 'CONTENT_SCRIPT')).toBe(true);
    expect(refusals.some((event) => event.route === 'task.create')).toBe(true);
    expect(refusals.some((event) => event.route === 'permission.respond')).toBe(true);
    // Nothing page-derived travels with a refusal.
    const serialised = JSON.stringify(refusals);
    expect(serialised).not.toContain('127.0.0.1');
    expect(serialised).not.toContain('http');
  });

  test('RC-1b — a content script is refused the read-only routes too', async ({
    context,
    site,
  }) => {
    const { world } = await openContentWorld(context, `${site.baseUrl}/`);
    try {
      for (const route of READ_ONLY_ROUTES) {
        denied(await world.send(route, {}), route);
      }
    } finally {
      await world.close();
    }
  });

  test('RC-2 — a content script cannot list a pending permission, nor answer one', async ({
    context,
    provider,
    send,
    site,
  }) => {
    await connectProvider(send, provider);
    await send('session.setPermissionMode', { mode: 'manual' });
    provider.script([
      {
        kind: 'tool_calls',
        calls: [{ name: 'browser.navigate', arguments: { url: `${site.baseUrl}/` } }],
      },
      { kind: 'text', text: 'done' },
    ]);

    const { task } = await send('task.create', { objective: 'open the form' });

    // Wait for a real prompt to be outstanding.
    let pendingId: string | undefined;
    for (let attempt = 0; attempt < 60 && !pendingId; attempt += 1) {
      const { requests } = await send('permission.listPending', {});
      pendingId = requests[0]?.id;
      if (!pendingId) await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(pendingId, 'no permission prompt appeared to attack').toBeTruthy();

    const { world } = await openContentWorld(context, `${site.baseUrl}/`);
    try {
      // The id oracle is closed…
      denied(await world.send('permission.listPending', {}), 'permission.listPending');
      // …and holding the id changes nothing. `approve_site` is the sharp one:
      // it would both approve this action and write a lasting rule.
      denied(
        await world.send('permission.respond', {
          requestId: pendingId,
          response: { kind: 'approve_site', maxRisk: 'R5' },
        }),
        'permission.respond',
      );
    } finally {
      await world.close();
    }

    // Still waiting for a person, and no rule was written.
    const { requests } = await send('permission.listPending', {});
    expect(requests.some((request) => request.id === pendingId)).toBe(true);
    const { state } = await send('policy.getSitePolicy', {});
    expect(state.rules.every((rule) => rule.maxRisk !== 'R5')).toBe(true);

    await send('permission.respond', { requestId: pendingId!, response: { kind: 'deny' } });
    await send('task.cancel', { taskId: task.id });
  });

  test('RC-3 — the side panel still reaches the same routes', async ({ send }) => {
    // The boundary is worth nothing if it also stops the product working.
    for (const route of READ_ONLY_ROUTES.filter(
      (name) =>
        ![
          'task.get',
          'workflow.get',
          'workflow.revalidate',
          'evidence.listForTask',
          'skill.runs',
          'shortcut.resolve',
        ].includes(name),
    )) {
      await expect(send(route as 'tools.list', {})).resolves.toBeTruthy();
    }
    await expect(send('session.get', {})).resolves.toHaveProperty('session');
    await expect(send('audit.list', { limit: 5 })).resolves.toHaveProperty('events');
    await expect(send('policy.getSitePolicy', {})).resolves.toHaveProperty('state');
  });

  test('RC-4/RC-5 — a page-origin sender is refused however it is shaped', async ({
    context,
    site,
  }) => {
    // Two different origins, two different tabs: the refusal is about the
    // sender's class, not about one page.
    const first = await openContentWorld(context, `${site.baseUrl}/`);
    const second = await openContentWorld(context, `${site.baseUrl}/details`);
    try {
      denied(await first.world.send('task.create', { objective: 'x' }), 'task.create/first');
      denied(await second.world.send('task.create', { objective: 'x' }), 'task.create/second');
      denied(await second.world.send('audit.export', { scope: { kind: 'all' } }), 'audit.export');
    } finally {
      await first.world.close();
      await second.world.close();
    }
  });

  test('RC-6 — reloading the panel does not lock the user out', async ({
    context,
    extensionId,
  }) => {
    // Nothing is pinned to a document id, because a panel reload is a normal
    // thing for a person to do and must not read as an attack.
    const panel = await openPanel(context, extensionId);
    const first = await panel.evaluate(() =>
      chrome.runtime.sendMessage({
        id: 'a',
        type: 'tools.list',
        timestamp: Date.now(),
        payload: {},
      }),
    );
    expect((first as Envelope).ok).toBe(true);

    await panel.reload();
    await panel.waitForSelector('.app', { timeout: 15_000 });
    const second = await panel.evaluate(() =>
      chrome.runtime.sendMessage({
        id: 'b',
        type: 'tools.list',
        timestamp: Date.now(),
        payload: {},
      }),
    );
    expect((second as Envelope).ok).toBe(true);
    await panel.close();
  });

  test('RC-7 — route trust is back before anything else is, after a worker restart', async ({
    context,
    extensionId,
    serviceWorker,
    site,
  }) => {
    await killServiceWorker(context, serviceWorker);
    const panel = await openPanel(context, extensionId);

    const { world } = await openContentWorld(context, `${site.baseUrl}/`);
    try {
      denied(await world.send('task.create', { objective: 'x' }), 'task.create');
      denied(await world.send('session.setPermissionMode', { mode: 'skip' }), 'setPermissionMode');
    } finally {
      await world.close();
    }

    const panelReply = await panel.evaluate(() =>
      chrome.runtime.sendMessage({
        id: 'c',
        type: 'tools.list',
        timestamp: Date.now(),
        payload: {},
      }),
    );
    expect((panelReply as Envelope).ok).toBe(true);
    await panel.close();
  });

  test('RC-8 — an answer to a prompt that is gone still changes nothing', async ({ send }) => {
    const answered = await send('permission.respond', {
      requestId: 'req_that_never_existed',
      response: { kind: 'approve_site', maxRisk: 'R5' },
    });
    expect(answered.ok).toBe(true);
    const { state } = await send('policy.getSitePolicy', {});
    expect(state.rules.every((rule) => rule.maxRisk !== 'R5')).toBe(true);
  });

  test('RC-9 — an export with no scope is refused', async ({ panel }) => {
    const envelope: Envelope = await panel.evaluate(() =>
      chrome.runtime.sendMessage({
        id: 'no-scope',
        type: 'audit.export',
        timestamp: Date.now(),
        payload: {},
      }),
    );
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('INVALID_ARGUMENT');
    expect(envelope.value).toBeUndefined();
  });

  test('RC-10/RC-11 — an explicit scope is honoured, and says what it is', async ({
    provider,
    send,
  }) => {
    await connectProvider(send, provider);
    provider.script([{ kind: 'text', text: 'nothing to do' }]);
    const { task } = await send('task.create', { objective: 'say nothing' });
    await waitForTask(send, task.id);

    const all = await send('audit.export', { scope: { kind: 'all' } });
    expect(all.export.scope).toEqual({ kind: 'all' });
    expect(all.export.eventCount).toBeGreaterThan(0);

    const one = await send('audit.export', { scope: { kind: 'task', taskId: task.id } });
    expect(one.export.scope).toEqual({ kind: 'task', taskId: task.id });
    for (const event of one.export.events) {
      if (event.taskId !== undefined) expect(event.taskId).toBe(task.id);
    }
    expect(one.export.eventCount).toBeLessThanOrEqual(all.export.eventCount);
  });

  test('RC-12 — a malformed scope is refused rather than narrowed', async ({ panel }) => {
    const attempts = [
      { kind: 'everything' },
      { kind: 'task' },
      { kind: 'task', taskId: '' },
      { kind: 'task', taskId: 7 },
      { kind: 'all', taskId: 'task_1' },
      'all',
      [{ kind: 'all' }],
      null,
    ];
    for (const scope of attempts) {
      const envelope: Envelope = await panel.evaluate(
        (value) =>
          chrome.runtime.sendMessage({
            id: 'bad-scope',
            type: 'audit.export',
            timestamp: Date.now(),
            payload: { scope: value },
          }),
        scope,
      );
      expect(envelope.ok, `${JSON.stringify(scope)} was accepted`).toBe(false);
      expect(envelope.error?.code).toBe('INVALID_ARGUMENT');
    }
  });

  test('RC-13 — a forged event from a content script never reaches the panel', async ({
    context,
    extensionId,
    site,
  }) => {
    const panel = await openPanel(context, extensionId);
    // Watch what the panel's own subscription hands to React.
    await panel.evaluate(() => {
      (window as unknown as { seen: unknown[] }).seen = [];
      chrome.runtime.onMessage.addListener((message: unknown) => {
        (window as unknown as { seen: unknown[] }).seen.push(message);
        return undefined;
      });
    });

    const { world } = await openContentWorld(context, `${site.baseUrl}/`);
    try {
      await world.raw(`
        chrome.runtime.sendMessage({
          id: 'forged',
          type: 'agent.event',
          timestamp: Date.now(),
          payload: {
            type: 'permission.requested',
            request: {
              id: 'forged-1', taskId: 'task_forged', tool: 'browser.click',
              risk: 'R0', reason: 'Cancel (safe)', site: 'your-bank.example',
              summary: 'Cancel (safe)', createdAt: Date.now(), elevated: false,
            },
          },
        }).catch(() => undefined)
      `);
    } finally {
      await world.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 600));

    // The envelope may arrive at the listener — Chrome broadcasts runtime
    // messages to every extension page — but the subscription that feeds the
    // UI refuses it, so no prompt is rendered.
    await expect(panel.getByText('Cancel (safe)')).toHaveCount(0);
    await expect(panel.getByText('your-bank.example')).toHaveCount(0);
    await panel.close();
  });

  test('RC-14 — page-world script cannot reach the extension at all', async ({ context, site }) => {
    const page = await context.newPage();
    await page.goto(`${site.baseUrl}/`);
    const reach = await page.evaluate(() => ({
      hasChrome: typeof (globalThis as { chrome?: unknown }).chrome !== 'undefined',
      hasRuntime:
        typeof (globalThis as { chrome?: { runtime?: unknown } }).chrome?.runtime !== 'undefined',
      hasSend:
        typeof (globalThis as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome?.runtime
          ?.sendMessage === 'function',
    }));
    expect(reach.hasSend).toBe(false);
    expect(reach.hasRuntime).toBe(false);
    await page.close();
  });

  test('RC-15 — an unclassified route is refused even from the panel', async ({ panel }) => {
    const envelope: Envelope = await panel.evaluate(() =>
      chrome.runtime.sendMessage({
        id: 'future',
        type: 'future.route',
        timestamp: Date.now(),
        payload: {},
      }),
    );
    // No handler is registered for it either, so Chrome reports no receiver
    // rather than a refusal envelope. Both are a denial; what matters is that
    // it does not run. The registered-but-unclassified case — the one a
    // future wave would actually create — is covered in the security suite,
    // where a handler can be attached to prove it never fires.
    expect(envelope === undefined || envelope.ok === false).toBe(true);
  });
});
