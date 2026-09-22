/**
 * TEST-SECURITY-041 — the workspace control surface is not an authorization
 * mechanism.
 *
 * W-6 adds a UI that lets a person change what the agent can see. That is
 * exactly the kind of surface that quietly becomes a bypass: a button that
 * writes storage directly, a route the model can reach, a "remove" that
 * accepts any tab id, or a switch that drags the AI brain along with it.
 *
 * So this suite asserts the shape of the surface rather than only its happy
 * path — which routes exist, who may call them, what the panel is physically
 * capable of doing, and which fields the workspace layer is incapable of
 * naming.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PANEL_ROUTE_CLASSES } from '@/messaging/route-trust';

beforeAll(() => {
  (globalThis as unknown as { chrome: unknown }).chrome ??= {
    runtime: { id: 'testextensionidtestextensionid00', sendMessage: () => Promise.resolve() },
  };
});

const read = (relative: string): string =>
  readFileSync(resolve(import.meta.dirname, '../..', relative), 'utf8');

const once = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const WORKSPACE_ROUTES = [
  'workspace.state',
  'workspace.create',
  'workspace.switch',
  'workspace.addCurrentTab',
  'workspace.removeTab',
  'workspace.reattach',
] as const;

describe('TEST-SECURITY-041 — workspace route trust', () => {
  it('classifies every workspace route, and no more than the six that exist', () => {
    const declared = Object.keys(PANEL_ROUTE_CLASSES).filter((route) =>
      route.startsWith('workspace.'),
    );
    // Pinned. A route added later has to be classified here deliberately
    // rather than joining a loop that silently grows.
    expect(declared.sort()).toEqual([...WORKSPACE_ROUTES].sort());
  });

  it('makes the read CLASS_E and every mutation control plane', () => {
    expect(PANEL_ROUTE_CLASSES['workspace.state']).toBe('CLASS_E_PANEL_READ_ONLY');
    for (const route of WORKSPACE_ROUTES.filter((r) => r !== 'workspace.state')) {
      expect(PANEL_ROUTE_CLASSES[route]).toBe('CLASS_B_PANEL_CONTROL_PLANE');
    }
  });

  it('gives no workspace route a class a content script could satisfy', () => {
    for (const route of WORKSPACE_ROUTES) {
      // CLASS_C is worker-to-content and never content-originated; nothing
      // here may be reached from a page.
      expect(PANEL_ROUTE_CLASSES[route]).not.toBe('CLASS_C_CONTENT_DATA_PLANE');
      expect(PANEL_ROUTE_CLASSES[route]).not.toBe('CLASS_A_INTERNAL_WORKER_ONLY');
    }
  });

  it('exposes no workspace route to the model as a tool', () => {
    // The model operates *within* a workspace through the browser tools. It
    // cannot create one, switch one, or change what is in it — a model that
    // could would be able to widen its own reach.
    const toolSources = [
      'src/tools/tabs/tab-tools.ts',
      'src/tools/browser/browser-tools.ts',
      'src/tools/debugger/debugger-tools.ts',
    ].map(read);
    for (const source of toolSources) {
      expect(source).not.toContain('workspace.create');
      expect(source).not.toContain('workspace.switch');
      expect(source).not.toContain('workspace.addCurrentTab');
      expect(source).not.toContain('workspace.removeTab');
    }
  });
});

describe('TEST-SECURITY-041 — the panel cannot bypass the routes', () => {
  const panel = read('src/sidepanel/components/WorkspaceView.tsx');

  it('holds no storage access of its own', () => {
    // Every change goes through a route. The panel has no store, no
    // chrome.storage, and no way to write workspace state directly.
    expect(panel).not.toContain('chrome.storage');
    expect(panel).not.toContain('WorkspaceStore');
    expect(panel).not.toContain('workspace-store');
  });

  it('drives no browser API and no tool', () => {
    expect(panel).not.toContain('chrome.tabs');
    expect(panel).not.toContain('chrome.tabGroups');
    expect(panel).not.toContain('ToolRegistry');
  });

  it('reaches the worker only through sendToBackground', () => {
    for (const route of WORKSPACE_ROUTES) {
      if (route === 'workspace.state') continue;
      if (!panel.includes(route)) continue;
      expect(panel).toContain(`sendToBackground('${route}'`);
    }
  });

  it('never adds the current tab on its own', () => {
    // The outside-tab notice offers a button. Adding happens on a click and
    // on nothing else — not on render, not on an effect, not on a tab change.
    expect(once(panel, "sendToBackground('workspace.addCurrentTab'")).toBe(1);
    const addBlock = panel.slice(panel.indexOf('Add current tab') - 900);
    expect(addBlock).toContain('onClick');
  });
});

describe('TEST-SECURITY-041 — the worker refuses across the boundary', () => {
  const worker = read('src/background/service-worker.ts');

  it('refuses to remove a tab that is not in the active workspace', () => {
    // The comparison is against the *live* group of the active workspace, so
    // another workspace's tab — or a loose one — is refused rather than
    // ungrouped. Without it this route would be a way to rearrange somebody
    // else's scope.
    expect(
      once(
        worker,
        'if (bound === null || tab === null || tab.groupId !== bound.chromeTabGroupId) {',
      ),
    ).toBe(1);
  });

  it('verifies an added tab really joined, rather than assuming', () => {
    expect(once(worker, 'if (after?.groupId !== bound.chromeTabGroupId) {')).toBe(1);
  });

  it('refuses a workspace belonging to another user', () => {
    expect(once(worker, 'if (!workspace || workspace.abaUserId !== abaUserId) {')).toBe(1);
  });

  it('reports live tabs and reconciles a stale binding rather than showing it', () => {
    // A group that vanished is unbound on read, so a closed workspace never
    // shows tabs it no longer has.
    expect(once(worker, 'await workspaceStore.unbind(workspaceId);\n    return [];')).toBe(1);
    expect(
      once(worker, 'return await chrome.tabs.query({ groupId: bound.chromeTabGroupId });'),
    ).toBe(1);
  });
});

describe('TEST-SECURITY-041 — switching workspace changes only the workspace', () => {
  const worker = read('src/background/service-worker.ts');
  const model = read('src/workspaces/workspace-model.ts');
  const store = read('src/workspaces/workspace-store.ts');

  it('does not touch the AI brain, the account or the identity profile', () => {
    // Extract the switch handler and assert on its body rather than the whole
    // file, so an unrelated mention elsewhere cannot make this pass.
    const start = worker.indexOf("router.on('workspace.switch'");
    const body = worker.slice(start, worker.indexOf("router.on('workspace.addCurrentTab'"));
    expect(start).toBeGreaterThan(-1);
    expect(body).not.toContain('setBrain');
    expect(body).not.toContain('accountStore');
    expect(body).not.toContain('connectionId');
    expect(body).not.toContain('identityProfile');
    expect(body).toContain('workspaceStore.setActiveId(workspaceId)');
  });

  it('keeps the two dimensions structurally unable to name each other', () => {
    // The workspace layer has no reference to a connection or a model, so the
    // independence is a property of the dependency graph rather than a rule
    // someone has to remember at each call site.
    expect(model).not.toContain('connectionId');
    expect(store).not.toContain('connectionId');
    expect(store).not.toContain('modelId');
  });

  it('does not delete tasks, history or workflows when switching', () => {
    const start = worker.indexOf("router.on('workspace.switch'");
    const body = worker.slice(start, worker.indexOf("router.on('workspace.addCurrentTab'"));
    expect(body).not.toContain('taskStore.');
    expect(body).not.toContain('workflowStore');
    expect(body).not.toContain('remove(');
  });

  it('removes a tab by detaching it, never by deleting anything', () => {
    const start = worker.indexOf("router.on('workspace.removeTab'");
    const body = worker.slice(start, worker.indexOf("router.on('workspace.reattach'"));
    expect(body).toContain('chrome.tabs.ungroup');
    expect(body).not.toContain('workspaceStore.remove');
    expect(body).not.toContain('taskStore.');
  });
});

/**
 * Mutations against the shipped W-6 surface.
 *
 * Each names a guard in production code and requires it present exactly once
 * as a complete literal, paired with a behavioural case — here or in
 * `TEST-E2E-022` — that stops holding if it goes. Anchoring on whole lines
 * rather than substrings is deliberate: an earlier suite in this repository
 * anchored on a prefix and two real mutations survived because the assertion
 * matched a different line that started the same way.
 *
 * As elsewhere in this repository, these do not execute mutated modules. The
 * pairing with behaviour is what gives them force; the text assertion is what
 * proves the behaviour under test is the behaviour that ships.
 */
describe('TEST-SECURITY-041 — mutations on the shipped control surface', () => {
  const worker = read('src/background/service-worker.ts');
  const panel = read('src/sidepanel/components/WorkspaceView.tsx');
  const routeTrust = read('src/messaging/route-trust.ts');

  it('U1 — every workspace route is classified, none defaults', () => {
    for (const route of WORKSPACE_ROUTES) {
      expect(once(routeTrust, `'${route}':`)).toBe(1);
    }
  });

  it('U2 — the cross-workspace tab check in removeTab is intact', () => {
    expect(
      once(
        worker,
        'if (bound === null || tab === null || tab.groupId !== bound.chromeTabGroupId) {',
      ),
    ).toBe(1);
  });

  it('U3 — addCurrentTab verifies rather than assuming the group took', () => {
    expect(once(worker, 'if (after?.groupId !== bound.chromeTabGroupId) {')).toBe(1);
  });

  it('U4 — a workspace owned by another user is refused on switch and reattach', () => {
    expect(once(worker, 'if (!workspace || workspace.abaUserId !== abaUserId) {')).toBe(1);
    expect(
      once(worker, 'if (!workspace || workspace.abaUserId !== (await currentAbaUserId())) {'),
    ).toBe(1);
  });

  it('U5 — a stale binding is reconciled on read, never rendered', () => {
    expect(once(worker, 'await workspaceStore.unbind(workspaceId);\n    return [];')).toBe(1);
  });

  it('U6 — the tab list is a live Chrome query, not a stored list', () => {
    expect(
      once(worker, 'return await chrome.tabs.query({ groupId: bound.chromeTabGroupId });'),
    ).toBe(1);
    // No stored member id reaches the panel: `WorkspaceMember` has no tabId
    // to send, so a closed tab cannot be shown as live.
    expect(read('src/workspaces/workspace-model.ts')).not.toContain('readonly tabId');
  });

  it('U7 — the outside tab is reported, and adding needs a click', () => {
    expect(once(worker, 'inActiveWorkspace: memberIds.has(current.id),')).toBe(1);
    expect(once(panel, "sendToBackground('workspace.addCurrentTab'")).toBe(1);
  });

  it('U8 — switching never reaches the brain, the account or the identity', () => {
    const start = worker.indexOf("router.on('workspace.switch'");
    const body = worker.slice(start, worker.indexOf("router.on('workspace.addCurrentTab'"));
    expect(body).not.toContain('setBrain');
    expect(body).not.toContain('accountStore');
  });

  it('U9 — the panel cannot bypass a route', () => {
    expect(panel).not.toContain('chrome.tabs');
    expect(panel).not.toContain('chrome.storage');
  });

  it('U10 — no workspace mutation is reachable as a model tool', () => {
    const registry = read('src/tools/registry/tool-registry.ts');
    expect(registry).not.toContain('workspace.switch');
    expect(registry).not.toContain('workspace.create');
  });

  it('U11 — removing a tab ungroups it and deletes nothing', () => {
    const start = worker.indexOf("router.on('workspace.removeTab'");
    const body = worker.slice(start, worker.indexOf("router.on('workspace.reattach'"));
    expect(body).toContain('chrome.tabs.ungroup([tabId]);');
    expect(body).not.toContain('workspaceStore.remove');
  });

  it('U12 — every mutation records an audit line, and none carries a page', () => {
    for (const code of ['created', 'switched', 'tab_added', 'tab_removed', 'reattached']) {
      expect(once(worker, `code: '${code}'`)).toBe(1);
    }
    // The events carry a code and, for a membership change, an origin — never
    // a title, a URL path or anything read from a page.
    const reconciler = read('src/workspaces/workspace-reconciler.ts');
    expect(reconciler).not.toContain('tab.title,\n        kind');
  });
});
