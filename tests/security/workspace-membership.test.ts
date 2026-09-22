/**
 * TEST-SECURITY-040 — a workspace narrows context and authorises nothing.
 *
 * The gap this closes: before workspaces, `listTabs()` was
 * `chrome.tabs.query({})` and a tool acted on whatever tab id it was handed.
 * A task started from one page could enumerate and act on an unrelated tab in
 * another window, because every control in the stack answered "may this
 * action happen" and none answered "is this tab in scope".
 *
 * Two properties are asserted here and nowhere else:
 *
 *  1. `checkMembership` is **pure and fails closed**. It takes live readings
 *     as arguments and has nowhere to consult a cache, which is what makes
 *     "read Chrome live" true rather than aspirational. Every refusal branch
 *     is exercised separately, because a change that collapsed two of them
 *     would still pass a test that only checked the aggregate.
 *  2. **Detach is never delete.** Every lifecycle event that removes a
 *     runtime handle leaves the durable record untouched, asserted by
 *     comparing the whole durable keyspace before and after.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MemoryStorageArea,
  NamespacedStorageArea,
  SerializedStorageArea,
} from '@/storage/storage-area';
import {
  checkMembership,
  deriveWorkspaceTitle,
  withMember,
  withoutMember,
  workspaceState,
  TAB_GROUP_ID_NONE,
  type LiveMembershipInput,
  type Workspace,
  type WorkspaceBinding,
} from '@/workspaces/workspace-model';
import { WorkspaceStore } from '@/workspaces/workspace-store';

beforeAll(() => {
  (globalThis as unknown as { chrome: unknown }).chrome ??= {
    runtime: { id: 'testextensionidtestextensionid00', sendMessage: () => Promise.resolve() },
  };
});

const USER = 'usr_123';
const OTHER_USER = 'usr_456';
const WS_A = 'ws_aaa';
const WS_B = 'ws_bbb';
const GROUP_A = 111;
const GROUP_B = 222;
const NOW = 1_700_000_000_000;

const binding = (overrides: Partial<WorkspaceBinding> = {}): WorkspaceBinding => ({
  workspaceId: WS_A,
  chromeTabGroupId: GROUP_A,
  chromeWindowId: 9,
  boundAt: NOW,
  ...overrides,
});

const workspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  workspaceId: WS_A,
  abaUserId: USER,
  title: 'Customer research',
  members: [],
  createdAt: NOW,
  lastActiveAt: NOW,
  ...overrides,
});

/** Everything positively satisfied: the one shape that is allowed. */
const eligible = (overrides: Partial<LiveMembershipInput> = {}): LiveMembershipInput => ({
  taskWorkspaceId: WS_A,
  binding: binding(),
  groupExists: true,
  tab: { id: 5, groupId: GROUP_A },
  ...overrides,
});

function stores(durable: MemoryStorageArea, runtime: MemoryStorageArea): WorkspaceStore {
  return new WorkspaceStore(
    new NamespacedStorageArea(new SerializedStorageArea(durable), 'workspaces'),
    new NamespacedStorageArea(new SerializedStorageArea(runtime), 'workspaces'),
    { newId: () => WS_A },
  );
}

async function snapshot(area: MemoryStorageArea): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const key of (await area.keys()).sort()) out[key] = await area.get(key);
  return out;
}

describe('TEST-SECURITY-040 — membership fails closed', () => {
  it('admits a tab only when every clause is positively satisfied', () => {
    expect(checkMembership(eligible())).toEqual({ ok: true });
  });

  it('refuses a task that has no workspace, without deleting anything', () => {
    // A task from before workspaces existed. Refused rather than exempted:
    // exempting it leaves the boundary open on exactly the tasks most likely
    // to have already used it.
    expect(checkMembership(eligible({ taskWorkspaceId: undefined }))).toMatchObject({
      ok: false,
      refusal: 'NO_WORKSPACE_ON_TASK',
    });
    expect(checkMembership(eligible({ taskWorkspaceId: '' }))).toMatchObject({
      ok: false,
      refusal: 'NO_WORKSPACE_ON_TASK',
    });
  });

  it('refuses when the workspace is detached', () => {
    expect(checkMembership(eligible({ binding: null }))).toMatchObject({
      ok: false,
      refusal: 'WORKSPACE_DETACHED',
    });
  });

  it('refuses a binding that belongs to a different workspace', () => {
    // The binding exists but is not this task's. Matching on group id alone
    // would let a task ride another workspace's live group.
    expect(checkMembership(eligible({ binding: binding({ workspaceId: WS_B }) }))).toMatchObject({
      ok: false,
      refusal: 'WORKSPACE_DETACHED',
    });
  });

  it('refuses when Chrome has already deleted the group', () => {
    // Chrome removes a group when its last tab leaves, so a binding goes
    // stale without the user doing anything they would call closing it.
    expect(checkMembership(eligible({ groupExists: false }))).toMatchObject({
      ok: false,
      refusal: 'GROUP_GONE',
    });
  });

  it('refuses a tab that no longer exists', () => {
    expect(checkMembership(eligible({ tab: null }))).toMatchObject({
      ok: false,
      refusal: 'TAB_GONE',
    });
  });

  it('refuses a tab the user dragged out, immediately', () => {
    // No event has to be processed first: the live groupId already says -1,
    // so the very next operation is refused.
    expect(checkMembership(eligible({ tab: { id: 5, groupId: TAB_GROUP_ID_NONE } }))).toMatchObject(
      { ok: false, refusal: 'TAB_UNGROUPED' },
    );
  });

  it('refuses a tab in another workspace', () => {
    expect(checkMembership(eligible({ tab: { id: 7, groupId: GROUP_B } }))).toMatchObject({
      ok: false,
      refusal: 'OTHER_WORKSPACE',
    });
  });

  it('never adopts an ungrouped tab into the caller’s workspace', () => {
    // The refusal is the whole behaviour: there is no branch that assigns a
    // loose tab to whoever asked about it.
    const verdict = checkMembership(eligible({ tab: { id: 9, groupId: TAB_GROUP_ID_NONE } }));
    expect(verdict.ok).toBe(false);
    expect(JSON.stringify(verdict)).not.toContain(String(GROUP_A));
  });
});

describe('TEST-SECURITY-040 — detach never deletes', () => {
  it('unbinding leaves every durable byte in place', async () => {
    const durable = new MemoryStorageArea();
    const runtime = new MemoryStorageArea();
    const store = stores(durable, runtime);
    await store.put(
      workspace({
        members: [{ origin: 'https://crm.test', title: 'CRM', addedAt: NOW, openedByAgent: false }],
      }),
    );
    await store.bind(binding());
    const before = await snapshot(durable);

    await store.unbind(WS_A);

    expect(await store.binding(WS_A)).toBeNull();
    expect(await store.state(WS_A)).toBe('detached');
    // The workspace itself, its title and its remembered members survive.
    expect(await snapshot(durable)).toEqual(before);
    expect((await store.get(WS_A))?.members.length).toBe(1);
  });

  it('unbinding a deleted Chrome group detaches without deleting', async () => {
    const durable = new MemoryStorageArea();
    const store = stores(durable, new MemoryStorageArea());
    await store.put(workspace());
    await store.bind(binding());
    const before = await snapshot(durable);

    const detached = await store.unbindGroup(GROUP_A);

    expect(detached).toBe(WS_A);
    expect(await snapshot(durable)).toEqual(before);
    expect(await store.get(WS_A)).toBeDefined();
  });

  it('a browser restart detaches every workspace and deletes none', async () => {
    const durable = new MemoryStorageArea();
    const runtime = new MemoryStorageArea();
    const store = stores(durable, runtime);
    await store.put(workspace());
    await store.bind(binding());

    // chrome.storage.session is cleared when the browser closes; local is not.
    const afterRestart = stores(durable, new MemoryStorageArea());

    expect(await afterRestart.binding(WS_A)).toBeNull();
    expect(await afterRestart.state(WS_A)).toBe('detached');
    expect((await afterRestart.get(WS_A))?.title).toBe('Customer research');
  });

  it('a worker restart keeps the binding, because session storage survives it', async () => {
    const durable = new MemoryStorageArea();
    const runtime = new MemoryStorageArea();
    const store = stores(durable, runtime);
    await store.put(workspace());
    await store.bind(binding());

    const afterWorkerRestart = stores(durable, runtime);

    expect(await afterWorkerRestart.binding(WS_A)).toEqual(binding());
    expect(await afterWorkerRestart.state(WS_A)).toBe('attached');
  });

  it('removing a member detaches that member only', () => {
    const withTwo = withMember(
      withMember(workspace(), {
        origin: 'https://a.test',
        title: 'A',
        addedAt: NOW,
        openedByAgent: false,
      }),
      { origin: 'https://b.test', title: 'B', addedAt: NOW, openedByAgent: true },
    );

    const after = withoutMember(withTwo, 'https://a.test');

    expect(after.members.map((m) => m.origin)).toEqual(['https://b.test']);
    expect(after.workspaceId).toBe(WS_A);
    expect(after.title).toBe('Customer research');
  });

  it('remembers members by origin, never by tab id', () => {
    const updated = withMember(
      withMember(workspace(), {
        origin: 'https://a.test',
        title: 'Old',
        addedAt: NOW,
        openedByAgent: false,
      }),
      { origin: 'https://a.test', title: 'New', addedAt: NOW + 1, openedByAgent: false },
    );

    // A tab id is a recyclable runtime handle; storing one would let a
    // restored record name a page it was never about.
    expect(updated.members.length).toBe(1);
    expect(updated.members[0]?.title).toBe('New');
    expect(JSON.stringify(updated)).not.toContain('tabId');
  });
});

describe('TEST-SECURITY-040 — workspace identity', () => {
  it('never treats a Chrome window as a workspace', async () => {
    const store = stores(new MemoryStorageArea(), new MemoryStorageArea());
    await store.put(workspace());
    await store.put(workspace({ workspaceId: WS_B, title: 'Engineering' }));
    // Two workspaces, same window. Supported, and the window id takes no part
    // in any membership decision.
    await store.bind(binding({ workspaceId: WS_A, chromeTabGroupId: GROUP_A, chromeWindowId: 9 }));
    await store.bind(binding({ workspaceId: WS_B, chromeTabGroupId: GROUP_B, chromeWindowId: 9 }));

    expect((await store.binding(WS_A))?.chromeTabGroupId).toBe(GROUP_A);
    expect((await store.binding(WS_B))?.chromeTabGroupId).toBe(GROUP_B);
    expect(
      checkMembership({
        taskWorkspaceId: WS_A,
        binding: await store.binding(WS_A),
        groupExists: true,
        tab: { id: 3, groupId: GROUP_B },
      }),
    ).toMatchObject({ refusal: 'OTHER_WORKSPACE' });
  });

  it('never lets one Chrome group back two workspaces', async () => {
    const store = stores(new MemoryStorageArea(), new MemoryStorageArea());
    await store.put(workspace());
    await store.put(workspace({ workspaceId: WS_B }));

    await store.bind(binding({ workspaceId: WS_A, chromeTabGroupId: GROUP_A }));
    await store.bind(binding({ workspaceId: WS_B, chromeTabGroupId: GROUP_A }));

    // Otherwise one group would mean two scopes and every check on it would
    // be ambiguous.
    expect(await store.binding(WS_A)).toBeNull();
    expect((await store.binding(WS_B))?.chromeTabGroupId).toBe(GROUP_A);
  });

  it('hides another user’s workspaces without deleting them', async () => {
    const store = stores(new MemoryStorageArea(), new MemoryStorageArea());
    await store.put(workspace());
    await store.put(workspace({ workspaceId: WS_B, abaUserId: OTHER_USER }));

    expect((await store.listFor(USER)).map((w) => w.workspaceId)).toEqual([WS_A]);
    expect((await store.list()).length).toBe(2);
  });

  it('changes the active workspace only when told to', async () => {
    const store = stores(new MemoryStorageArea(), new MemoryStorageArea());
    await store.put(workspace());

    expect(await store.getActiveId()).toBeNull();
    await store.setActiveId(WS_A);
    expect(await store.getActiveId()).toBe(WS_A);
    await expect(store.setActiveId('ws_missing')).rejects.toThrow(/No workspace/);
    // The failed selection did not clear the good one.
    expect(await store.getActiveId()).toBe(WS_A);
  });

  it('deleting a workspace is the only path that removes it', async () => {
    const durable = new MemoryStorageArea();
    const store = stores(durable, new MemoryStorageArea());
    await store.put(workspace());
    await store.bind(binding());
    await store.setActiveId(WS_A);

    // Every detaching event first: none of them removes the record.
    await store.unbindGroup(GROUP_A);
    expect(await store.get(WS_A)).toBeDefined();

    await store.remove(WS_A);

    expect(await store.get(WS_A)).toBeUndefined();
    expect(await store.getActiveId()).toBeNull();
  });

  it('derives a readable title without inventing one', () => {
    expect(deriveWorkspaceTitle('https://crm.example.test/deals')).toBe('crm.example.test');
    expect(deriveWorkspaceTitle('not a url')).toBe('Workspace');
    expect(deriveWorkspaceTitle(undefined)).toBe('Workspace');
  });

  it('reports attachment from the binding alone', () => {
    expect(workspaceState(null)).toBe('detached');
    expect(workspaceState(binding())).toBe('attached');
  });
});

/**
 * Mutations against the shipped source.
 *
 * Each names a guard in production code and requires it to be present exactly
 * once as a complete literal, paired with a behavioural case above that stops
 * holding if it goes. Anchoring on a whole line rather than a substring is
 * deliberate: an earlier suite in this repository anchored on a prefix, and
 * two real mutations survived because the assertion matched a different line
 * that happened to start the same way.
 *
 * What this does **not** do is execute a mutated module. The pairing with the
 * behavioural cases is what gives it force; the text assertion is what proves
 * the behaviour under test is the behaviour that ships.
 */
describe('TEST-SECURITY-040 — mutations on the shipped guard', () => {
  const model = readFileSync(
    resolve(import.meta.dirname, '../../src/workspaces/workspace-model.ts'),
    'utf8',
  );
  const registry = readFileSync(
    resolve(import.meta.dirname, '../../src/tools/registry/tool-registry.ts'),
    'utf8',
  );
  const tabTools = readFileSync(
    resolve(import.meta.dirname, '../../src/tools/tabs/tab-tools.ts'),
    'utf8',
  );
  const browserTools = readFileSync(
    resolve(import.meta.dirname, '../../src/tools/browser/browser-tools.ts'),
    'utf8',
  );
  const store = readFileSync(
    resolve(import.meta.dirname, '../../src/workspaces/workspace-store.ts'),
    'utf8',
  );

  const once = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

  it('W1 — dispatch calls the workspace guard before anything runs', () => {
    expect(once(registry, 'const scope = await this.options.checkWorkspaceMember(')).toBe(1);
    // And refuses rather than continuing on a failed check.
    expect(once(registry, 'if (!scope.ok) {')).toBe(1);
  });

  it('W2 — the group comparison is present and complete', () => {
    expect(once(model, 'if (input.tab.groupId !== input.binding.chromeTabGroupId) {')).toBe(1);
  });

  it('W3 — every reading the predicate uses is passed in, never cached', () => {
    // `checkMembership` takes its readings as arguments and imports no store,
    // so there is nowhere in it to consult a cache even by mistake.
    expect(model).not.toContain("from './workspace-store'");
    expect(once(model, 'export function checkMembership(input: LiveMembershipInput)')).toBe(1);
  });

  it('W4 — a binding is only trusted while its group still exists', () => {
    expect(once(model, 'if (!input.groupExists) {')).toBe(1);
  });

  it('W5 — an ungrouped tab is refused, never adopted', () => {
    expect(once(model, 'if (input.tab.groupId === TAB_GROUP_ID_NONE) {')).toBe(1);
  });

  it('W6 — a tab Chrome no longer has is refused', () => {
    expect(once(model, 'if (input.tab === null) {')).toBe(1);
  });

  it('W7 — a task with no workspace is refused', () => {
    expect(
      once(
        model,
        'if (input.taskWorkspaceId === undefined || input.taskWorkspaceId.length === 0) {',
      ),
    ).toBe(1);
  });

  it('W8 — the active workspace is never derived from the active tab', () => {
    // The only writer is an explicit selection. Nothing reads a tab to decide
    // which workspace is active.
    expect(once(store, 'async setActiveId(workspaceId: string | null): Promise<void> {')).toBe(1);
    expect(store).not.toContain('getActiveTab');
    expect(store).not.toContain('chrome.tabs');
  });

  it('W9 — workspace and AI brain stay uncoupled', () => {
    // Neither module names the other's identifier, in either direction.
    expect(model).not.toContain('connectionId');
    expect(store).not.toContain('connectionId');
    expect(model).not.toContain('modelId');
  });

  it('W10 — membership never replaces the origin check', () => {
    // `assertAutomatable` still runs on the live URL for every resolved tab,
    // so a member tab that navigated somewhere blocked is still refused.
    expect(once(browserTools, 'return assertAutomatable(active, context);')).toBe(1);
    expect(once(browserTools, 'return assertAutomatable(tab, context);')).toBe(1);
  });

  it('W11 — enumeration is narrowed to the workspace', () => {
    expect(once(tabTools, 'all.filter((tab) => context.workspaceTabIds!.includes(tab.id));')).toBe(
      1,
    );
  });

  it('W12 — the fallback tab comes from the workspace, not the browser', () => {
    expect(once(browserTools, 'const active = await activeWorkspaceTab(adapter, context);')).toBe(
      1,
    );
    // A non-member is never returned from the fallback.
    expect(
      once(tabTools, 'if (active && context.workspaceTabIds.includes(active.id)) return active;'),
    ).toBe(1);
  });

  it('W13 — nothing in the workspace layer deletes user data on a lifecycle event', () => {
    // `remove` is the only deleting method, and only an explicit user action
    // reaches it. Detach paths drop a runtime handle and nothing else.
    expect(once(store, 'async remove(workspaceId: string): Promise<void> {')).toBe(1);
    expect(once(store, 'async unbind(workspaceId: string): Promise<void> {')).toBe(1);
    const reconciler = readFileSync(
      resolve(import.meta.dirname, '../../src/workspaces/workspace-reconciler.ts'),
      'utf8',
    );
    expect(reconciler).not.toContain('store.remove(');
  });
});
