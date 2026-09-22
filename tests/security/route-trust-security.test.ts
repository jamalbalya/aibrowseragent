/**
 * TEST-SECURITY-026 — route trust and audit export scope (D-1, D-2).
 *
 * Until this wave every panel route was reachable by any extension context
 * that could call `chrome.runtime.sendMessage` — which includes the content
 * script running in every page. No page could originate one, for three
 * reasons: the isolated world, no `postMessage` bridge in `src/content/`, and
 * no `externally_connectable` entry. All three are true. None of them is a
 * check, and each is one line away from not being true.
 *
 * So the cases below are written against the receiver, not against the
 * current shape of the senders. Four claims:
 *
 *  1. **A route runs only for a positively identified caller.** Missing,
 *     contradictory or merely unrecognised senders are refused, not resolved
 *     to the class they most resemble.
 *  2. **A pending request id is not a credential.** Listing ids and answering
 *     with one are both privileged, because the first is what makes the
 *     second usable.
 *  3. **An export names its scope.** Nothing is inferred, and a refused scope
 *     produces no document at all.
 *  4. **Trust is a filter, never a grant.** Passing it reaches the same
 *     policy, permission, egress and consent gates as before.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MessageRouter } from '@/background/message-router';
import { PermissionBroker } from '@/background/permission-broker';
import {
  PANEL_ROUTE_CLASSES,
  classifySender,
  panelRouteClass,
  senderMayBroadcastEvent,
  senderMayInvokeContentRoute,
  senderMayInvokePanelRoute,
  type MessageSenderLike,
} from '@/messaging/route-trust';
import { AuditLog, parseAuditExportScope } from '@/audit/audit-log';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { TEST_IDENTITY, contentSender, panelSender, workerSender } from '../fixtures/senders';

/**
 * The permission broker broadcasts, and a broadcast needs `chrome.runtime`.
 * Stubbed rather than avoided, because the cases below are about the broker's
 * real behaviour: what a refused message does *not* do to a live prompt.
 */
beforeAll(() => {
  (globalThis as unknown as { chrome: unknown }).chrome ??= {
    runtime: { id: TEST_IDENTITY.extensionId, sendMessage: () => Promise.resolve(undefined) },
  };
});

const root = resolve(import.meta.dirname, '../..');
const read = (relative: string): string => readFileSync(resolve(root, relative), 'utf8');

function routerWithSpy(): {
  router: MessageRouter;
  ran: string[];
  refusals: { route: string; senderClass: string }[];
} {
  const ran: string[] = [];
  const refusals: { route: string; senderClass: string }[] = [];
  const router = new MessageRouter({
    identity: TEST_IDENTITY,
    onRefused: ({ route, senderClass }) => refusals.push({ route, senderClass }),
  });
  // Every route in the table gets a handler that records that it ran, so a
  // denial is proved by absence of the side effect rather than by the shape
  // of the reply.
  for (const route of Object.keys(PANEL_ROUTE_CLASSES)) {
    router.on(route as 'task.list', () => {
      ran.push(route);
      return Promise.resolve({ tasks: [] });
    });
  }
  return { router, ran, refusals };
}

const newAuditLog = (): AuditLog =>
  new AuditLog(new SerializedStorageArea(new MemoryStorageArea()));

describe('R1 — an untrusted sender cannot invoke a privileged route', () => {
  it('1. refuses every route to a content script, and runs none of them', async () => {
    const { router, ran } = routerWithSpy();
    for (const route of Object.keys(PANEL_ROUTE_CLASSES)) {
      const envelope = await router.route(route, {}, contentSender);
      expect(envelope.ok, `${route} was not refused`).toBe(false);
      if (!envelope.ok) expect(envelope.error.code).toBe('PERMISSION_DENIED');
    }
    expect(ran).toEqual([]);
  });

  it('2. refuses every route to the service worker itself', async () => {
    // The worker does not message its own router, and a rule that let it
    // would make "internal" a class anything could claim by looking internal.
    const { router, ran } = routerWithSpy();
    for (const route of Object.keys(PANEL_ROUTE_CLASSES)) {
      expect((await router.route(route, {}, workerSender)).ok).toBe(false);
    }
    expect(ran).toEqual([]);
  });

  it('3. refuses every route to another extension-origin document', async () => {
    const other: MessageSenderLike = {
      ...panelSender,
      url: `${TEST_IDENTITY.origin}/src/sidepanel/other.html`,
    };
    const { router, ran } = routerWithSpy();
    for (const route of Object.keys(PANEL_ROUTE_CLASSES)) {
      expect((await router.route(route, {}, other)).ok).toBe(false);
    }
    expect(ran).toEqual([]);
  });

  it('4. refuses every route to another extension', async () => {
    const { router, ran } = routerWithSpy();
    const foreign = { ...panelSender, id: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' };
    for (const route of Object.keys(PANEL_ROUTE_CLASSES)) {
      expect((await router.route(route, {}, foreign)).ok).toBe(false);
    }
    expect(ran).toEqual([]);
  });

  it('5. admits the side panel to every route, so the product still works', async () => {
    const { router, ran } = routerWithSpy();
    for (const route of Object.keys(PANEL_ROUTE_CLASSES)) {
      expect((await router.route(route, {}, panelSender)).ok, route).toBe(true);
    }
    expect(ran.length).toBe(Object.keys(PANEL_ROUTE_CLASSES).length);
  });
});

describe('R5 — missing or ambiguous sender identity fails closed', () => {
  it('6. refuses a message with no sender at all', async () => {
    const { router, ran } = routerWithSpy();
    expect((await router.route('task.create', { objective: 'x' }, undefined)).ok).toBe(false);
    expect(ran).toEqual([]);
  });

  it('7. refuses a sender whose origin is absent', async () => {
    const { origin: _origin, ...rest } = panelSender;
    const { router, ran } = routerWithSpy();
    expect((await router.route('skill.run', {}, rest)).ok).toBe(false);
    expect(ran).toEqual([]);
  });

  it('8. refuses a sender whose url is absent', async () => {
    const { url: _url, ...rest } = panelSender;
    const { router, ran } = routerWithSpy();
    expect((await router.route('workflow.replay', {}, rest)).ok).toBe(false);
    expect(ran).toEqual([]);
  });

  it('9. refuses a sender claiming our origin while pointing elsewhere', async () => {
    const { router, ran } = routerWithSpy();
    const contradictory = { ...panelSender, url: 'https://evil.test/sidepanel/index.html' };
    expect((await router.route('session.setPermissionMode', {}, contradictory)).ok).toBe(false);
    expect(ran).toEqual([]);
  });

  it('10. refuses a page-origin sender that merely omits its tab', async () => {
    const { tab: _tab, ...rest } = contentSender;
    const { router, ran } = routerWithSpy();
    expect((await router.route('audit.export', {}, rest)).ok).toBe(false);
    expect(ran).toEqual([]);
  });
});

describe('R13 — a new route is unreachable until it is classified', () => {
  it('11. refuses a registered route that has no class', async () => {
    const ran: string[] = [];
    const router = new MessageRouter({ identity: TEST_IDENTITY });
    router.on('later.feature' as 'task.list', () => {
      ran.push('later.feature');
      return Promise.resolve({ tasks: [] });
    });

    const envelope = await router.route('later.feature', {}, panelSender);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe('PERMISSION_DENIED');
    expect(ran).toEqual([]);
  });

  it('12. refuses before it looks for a handler, so a refusal reveals no route map', async () => {
    const router = new MessageRouter({ identity: TEST_IDENTITY });
    // `task.get` is classified but unregistered; `later.feature` is neither.
    // To an untrusted sender both must look the same.
    const classified = await router.route('task.get', {}, contentSender);
    const unclassified = await router.route('later.feature', {}, contentSender);
    expect(classified.ok).toBe(false);
    expect(unclassified.ok).toBe(false);
    if (!classified.ok && !unclassified.ok) {
      expect(classified.error.code).toBe(unclassified.error.code);
      expect(classified.error.code).toBe('PERMISSION_DENIED');
    }
  });

  it('13. keeps the class table total, so a route cannot be added without one', () => {
    // The table is typed `Record<PanelRequestType, RouteClass>`, so this is
    // enforced by the compiler. Asserted here as well because a later edit
    // could loosen the type, and that edit should break a test rather than
    // only a reviewer's attention.
    const source = read('src/messaging/route-trust.ts');
    expect(source).toContain('Record<PanelRequestType, RouteClass>');
    const protocol = read('src/messaging/protocol.ts');
    const declared = [...protocol.matchAll(/^ {2}'([a-z]+\.[a-zA-Z]+)':/gm)].map((m) => m[1]);
    const panelRoutes = declared.filter((name) => !name!.startsWith('content.'));
    for (const route of panelRoutes) {
      expect(panelRouteClass(route!), `${route} has no class`).toBeDefined();
    }
    expect(panelRoutes.length).toBeGreaterThan(50);
  });
});

describe('R2 and R11 — a request id is not an authorization token', () => {
  it('14. denies a content script both the id oracle and the answer, leaving the prompt pending', async () => {
    const broker = new PermissionBroker({ timeoutMs: 60_000 });
    const { router, ran } = routerWithSpy();
    // The real routes, replacing the spies for this case.
    router.on('permission.listPending', () => Promise.resolve({ requests: broker.listPending() }));
    router.on('permission.respond', ({ requestId, response }) => {
      broker.respond(requestId, response);
      return Promise.resolve({ ok: true as const });
    });

    let settled: unknown = null;
    const pending = broker
      .prompt({
        id: 'req-1',
        taskId: 'task_1',
        tool: 'browser.download',
        risk: 'R3',
        reason: 'writes a file',
        site: 'example.com',
        summary: 'Download a file.',
        createdAt: 1,
        elevated: false,
      })
      .then((value) => {
        settled = value;
      });

    // The oracle is closed…
    const listed = await router.route('permission.listPending', {}, contentSender);
    expect(listed.ok).toBe(false);

    // …and even holding the id — which a content script could learn some
    // other way — the answer is refused.
    const answered = await router.route(
      'permission.respond',
      { requestId: 'req-1', response: { kind: 'approve_site', maxRisk: 'R5' } },
      contentSender,
    );
    expect(answered.ok).toBe(false);

    await Promise.resolve();
    expect(settled).toBeNull();
    expect(broker.listPending()).toHaveLength(1);
    expect(ran).toEqual([]);

    broker.denyAll();
    await pending;
    expect(settled).toEqual({ kind: 'deny' });
  });

  it('15. classes the listing routes with the routes their ids unlock', () => {
    expect(PANEL_ROUTE_CLASSES['permission.listPending']).toBe('PANEL_CONTROL_PLANE');
    expect(PANEL_ROUTE_CLASSES['file.listPendingSelections']).toBe('PANEL_CONTROL_PLANE');
  });

  it('16. still lets the panel answer its own prompt', async () => {
    const broker = new PermissionBroker({ timeoutMs: 60_000 });
    const router = new MessageRouter({ identity: TEST_IDENTITY });
    router.on('permission.respond', ({ requestId, response }) => {
      broker.respond(requestId, response);
      return Promise.resolve({ ok: true as const });
    });

    let settled: unknown = null;
    const pending = broker
      .prompt({
        id: 'req-2',
        taskId: 'task_2',
        tool: 'browser.click',
        risk: 'R2',
        reason: 'clicks',
        site: 'example.com',
        summary: 'Click.',
        createdAt: 1,
        elevated: false,
      })
      .then((value) => {
        settled = value;
      });

    expect(
      (
        await router.route(
          'permission.respond',
          { requestId: 'req-2', response: { kind: 'approve_once' } },
          panelSender,
        )
      ).ok,
    ).toBe(true);
    await pending;
    expect(settled).toEqual({ kind: 'approve_once' });
  });
});

describe('R12 — a broadcast event cannot be forged', () => {
  it('17. admits the worker and refuses everyone else', () => {
    expect(senderMayBroadcastEvent(classifySender(workerSender, TEST_IDENTITY))).toBe(true);
    expect(senderMayBroadcastEvent(classifySender(contentSender, TEST_IDENTITY))).toBe(false);
    expect(senderMayBroadcastEvent(classifySender(panelSender, TEST_IDENTITY))).toBe(false);
    expect(senderMayBroadcastEvent(classifySender(undefined, TEST_IDENTITY))).toBe(false);
  });

  it('18. checks the sender in the panel subscription rather than the payload', () => {
    const source = read('src/messaging/bus.ts');
    const subscription = source.slice(source.indexOf('export function subscribeToEvents'));
    expect(subscription).toContain('senderMayBroadcastEvent');
    expect(subscription).toContain('classifySender');
  });
});

describe('R17 — the content receiver accepts only the worker', () => {
  it('19. admits the worker and refuses every other class', () => {
    expect(senderMayInvokeContentRoute(classifySender(workerSender, TEST_IDENTITY))).toBe(true);
    expect(senderMayInvokeContentRoute(classifySender(contentSender, TEST_IDENTITY))).toBe(false);
    expect(senderMayInvokeContentRoute(classifySender(panelSender, TEST_IDENTITY))).toBe(false);
  });

  it('20. checks the sender before it reaches an interaction handler', () => {
    const source = read('src/content/content-script.ts');
    const listener = source.slice(source.indexOf('chrome.runtime.onMessage.addListener'));
    const guard = listener.indexOf('senderMayInvokeContentRoute');
    const invoke = listener.indexOf('handler(typed.payload)');
    expect(guard).toBeGreaterThan(-1);
    expect(invoke).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(invoke);
  });

  it('21. adds no content-originated request channel', () => {
    const source = read('src/content/content-script.ts');
    expect(source).not.toContain('window.addEventListener');
    expect(source).not.toContain('postMessage');
    expect(source).not.toContain('chrome.runtime.sendMessage');
  });
});

describe('R3 and R14 — extension-context authority is not model authority', () => {
  it('22. registers no panel route as a tool', () => {
    const sources = ['src/tools', 'src/background/service-worker.ts'];
    const names = new Set<string>();
    for (const dir of sources) {
      const text = dir.endsWith('.ts')
        ? read(dir)
        : // One read of the registration surface is enough: a tool is only a
          // tool once it declares a `name`.
          readFileSync(resolve(root, 'src/tools/registry/tool-registry.ts'), 'utf8');
      for (const match of text.matchAll(/name: '([a-z_]+\.[a-z_]+)'/g)) names.add(match[1]!);
    }
    for (const route of Object.keys(PANEL_ROUTE_CLASSES)) {
      expect(names.has(route), `${route} is registered as a tool`).toBe(false);
    }
  });

  it('23. exposes no audit tool anywhere in the tool surface', () => {
    const registry = read('src/tools/registry/tool-registry.ts');
    expect(registry).not.toMatch(/name: '[^']*audit/);
  });

  it('24. does not treat model unreachability as authorization', () => {
    // The check is on the sender, not on whether a model could have asked.
    const router = read('src/background/message-router.ts');
    expect(router).toContain('classifySender');
    expect(router).toContain('senderMayInvokePanelRoute');
  });
});

describe('R4 — audit.export needs an explicit, valid scope', () => {
  it('25. refuses an omitted scope rather than choosing one', () => {
    expect(parseAuditExportScope(undefined)).toEqual({ ok: false, problem: 'missing' });
    expect(parseAuditExportScope(null)).toEqual({ ok: false, problem: 'missing' });
  });

  it('26. refuses a scope that is not an object', () => {
    for (const value of ['all', 7, true]) {
      expect(parseAuditExportScope(value).ok).toBe(false);
    }
    expect(parseAuditExportScope([{ kind: 'all' }]).ok).toBe(false);
  });

  it('27. refuses an unknown kind', () => {
    expect(parseAuditExportScope({ kind: 'everything' })).toEqual({
      ok: false,
      problem: 'unknown-kind',
    });
    expect(parseAuditExportScope({})).toEqual({ ok: false, problem: 'unknown-kind' });
  });

  it('28. refuses a task scope whose id is missing, empty or not a string', () => {
    expect(parseAuditExportScope({ kind: 'task' }).ok).toBe(false);
    expect(parseAuditExportScope({ kind: 'task', taskId: '' }).ok).toBe(false);
    expect(parseAuditExportScope({ kind: 'task', taskId: 7 }).ok).toBe(false);
    expect(parseAuditExportScope({ kind: 'task', taskId: 'has spaces' }).ok).toBe(false);
    expect(parseAuditExportScope({ kind: 'task', taskId: 'a/../b' }).ok).toBe(false);
  });

  it('29. refuses extra fields rather than trimming them', () => {
    expect(parseAuditExportScope({ kind: 'all', taskId: 'task_1' })).toEqual({
      ok: false,
      problem: 'unexpected-fields',
    });
    expect(parseAuditExportScope({ kind: 'task', taskId: 'task_1', sneaky: 1 })).toEqual({
      ok: false,
      problem: 'unexpected-fields',
    });
  });

  it('30. accepts exactly the two scopes the contract names', () => {
    expect(parseAuditExportScope({ kind: 'all' })).toEqual({ ok: true, scope: { kind: 'all' } });
    expect(parseAuditExportScope({ kind: 'task', taskId: 'task_1' })).toEqual({
      ok: true,
      scope: { kind: 'task', taskId: 'task_1' },
    });
  });

  it('31. validates before anything is read, so a refusal builds no document', () => {
    const worker = read('src/background/service-worker.ts');
    const start = worker.indexOf("router.on('audit.export'");
    const body = worker.slice(start, worker.indexOf("router.on('evidence.listForTask'"));
    expect(body.indexOf('parseAuditExportScope')).toBeLessThan(body.indexOf('auditLog.page'));
    expect(body.indexOf('parseAuditExportScope')).toBeLessThan(body.indexOf('buildAuditExport'));
  });

  it('32. keeps the export local: no network carrier and no downloads permission', () => {
    const worker = read('src/background/service-worker.ts');
    const handler = worker.slice(
      worker.indexOf("router.on('audit.export'"),
      worker.indexOf("router.on('evidence.listForTask'"),
    );
    expect(handler).not.toContain('fetch');
    expect(handler).not.toContain('chrome.downloads');
    const panel = read('src/sidepanel/components/AuditView.tsx').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(panel).not.toContain('chrome.downloads');
    expect(panel).toContain('URL.createObjectURL');
  });

  it('33. does not rest the boundary on the panel’s button labels', () => {
    // The panel offers two buttons, and that is a usability choice. What
    // makes an all-task export explicit is the scope in the request and the
    // class of the sender — both enforced in the worker, where a caller that
    // never rendered a button still meets them.
    expect(PANEL_ROUTE_CLASSES['audit.export']).toBe('PANEL_CONTROL_PLANE');
    expect(parseAuditExportScope(undefined).ok).toBe(false);
    expect(senderMayInvokePanelRoute('CONTENT_SCRIPT', 'PANEL_CONTROL_PLANE')).toBe(false);
  });
});

describe('refusal evidence holds no page-derived material', () => {
  it('34. records the route and a closed sender class, never a URL', async () => {
    const audit = newAuditLog();
    const router = new MessageRouter({
      identity: TEST_IDENTITY,
      onRefused: ({ route, senderClass }) => {
        void audit.record({ type: 'route.refused', outcome: 'denied', route, senderClass });
      },
    });
    router.on('audit.export', () => Promise.resolve({ export: null as never }));

    await router.route('audit.export', { scope: { kind: 'all' } }, contentSender);
    await vi.waitFor(async () => {
      expect((await audit.list()).length).toBe(1);
    });

    const [event] = await audit.list();
    expect(event!.type).toBe('route.refused');
    expect(event!.outcome).toBe('denied');
    expect(event!.route).toBe('audit.export');
    expect(event!.senderClass).toBe('CONTENT_SCRIPT');
    const serialised = JSON.stringify(event);
    expect(serialised).not.toContain('example.com');
    expect(serialised).not.toContain('https://');
  });

  it('35. refuses to record a sender URL even if one were passed', async () => {
    const audit = newAuditLog();
    const written = await audit.record({
      type: 'route.refused',
      outcome: 'denied',
      route: 'audit.export',
      senderClass: 'https://evil.test/page',
    } as never);
    // Not an identifier — a URL has slashes — so the record is refused whole
    // rather than stored with the URL in it.
    expect(written).toBeNull();
    expect(await audit.list()).toEqual([]);
  });

  it('36. does not let a reporting failure change the refusal', async () => {
    const { router } = routerWithSpy();
    const exploding = new MessageRouter({
      identity: TEST_IDENTITY,
      onRefused: () => {
        throw new Error('reporting is broken');
      },
    });
    exploding.on('task.create', () => Promise.resolve({ task: null as never }));
    const envelope = await exploding.route('task.create', { objective: 'x' }, contentSender);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe('PERMISSION_DENIED');
    expect(router).toBeDefined();
  });
});

describe('the OAuth callback stays a landing page', () => {
  it('37. carries no script, no postMessage and no token handling', () => {
    const page = read('public/oauth/callback.html');
    expect(page).not.toMatch(/<script/i);
    expect(page).not.toContain('postMessage');
    expect(page).not.toContain('chrome.runtime');
    expect(page).not.toContain('location.search');
  });

  it('38. is still the only web-accessible resource', () => {
    const manifest = JSON.parse(read('public/manifest.json')) as {
      web_accessible_resources: { resources: string[] }[];
      externally_connectable?: unknown;
    };
    expect(manifest.web_accessible_resources.flatMap((entry) => entry.resources)).toEqual([
      'oauth/callback.html',
    ]);
    expect(manifest.externally_connectable).toBeUndefined();
  });

  it('39. adds no external message listener anywhere', () => {
    for (const file of [
      'src/background/service-worker.ts',
      'src/background/message-router.ts',
      'src/content/content-script.ts',
      'src/messaging/bus.ts',
    ]) {
      expect(read(file)).not.toContain('onMessageExternal');
      expect(read(file)).not.toContain('onConnectExternal');
    }
  });
});

describe('R16 — D-3 semantics are untouched by this wave', () => {
  it('40. still reports a persistence failure without claiming it persists', async () => {
    const audit = newAuditLog();
    expect(audit.degradedReason()).toBeNull();
    const written = await audit.record({ type: 'not.a.type', outcome: 'denied' } as never);
    expect(written).toBeNull();
    expect(audit.degradedReason()).not.toBeNull();
    // Unchanged on purpose: the marker is in memory, and this wave neither
    // makes it persist nor pretends that it does.
    const source = read('src/audit/audit-log.ts');
    expect(source).toContain('private degraded: string | null = null');
  });

  it('41. keeps the chain described as corruption and reordering detection', () => {
    const source = read('src/audit/audit-log.ts');
    expect(source).toContain('corruption and reordering detection');
    expect(source.toLowerCase()).not.toContain('tamper-proof');
    expect(source.toLowerCase()).not.toContain('tamper proof');
  });
});
