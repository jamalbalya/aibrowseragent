/**
 * TEST-TABS-001 — Tab tools and agent tab ownership (REQ-TABS-001).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { TabOwnership, createTabTools } from '@/tools/tabs/tab-tools';
import { FakeBrowserAdapter } from '../fixtures/fake-browser';
import { createHarness, ScriptedPrompter, type Harness } from '../fixtures/policy-harness';

let adapter: FakeBrowserAdapter;
let ownership: TabOwnership;
let harness: Harness;
let prompter: ScriptedPrompter;

const dispatch = (name: string, args: Record<string, unknown>, taskId = 'task_1') =>
  harness.registry.dispatch({
    toolCallId: 'tc_1',
    taskId,
    sessionId: 's1',
    name,
    arguments: args,
    signal: new AbortController().signal,
  });

beforeEach(() => {
  adapter = new FakeBrowserAdapter();
  adapter.addTab({ id: 1, url: 'https://example.com/', title: 'Example', active: true });
  adapter.addTab({ id: 2, url: 'https://docs.test/guide', title: 'Docs' });
  ownership = new TabOwnership();
  prompter = new ScriptedPrompter({ kind: 'approve_once' });
  harness = createHarness(createTabTools({ adapter, ownership }), { prompter });
});

describe('TabOwnership', () => {
  it('tracks tabs per task and does not leak between tasks', () => {
    ownership.claim('task_a', 10);
    ownership.claim('task_b', 20);
    expect(ownership.owns('task_a', 10)).toBe(true);
    expect(ownership.owns('task_a', 20)).toBe(false);
    expect(ownership.listFor('task_b')).toEqual([20]);
  });

  it('releases and clears', () => {
    ownership.claim('t', 1);
    ownership.release('t', 1);
    expect(ownership.owns('t', 1)).toBe(false);

    ownership.claim('t', 2);
    ownership.clear('t');
    expect(ownership.listFor('t')).toEqual([]);
  });
});

describe('tabs.list', () => {
  it('lists open tabs and flags which are automatable', async () => {
    adapter.addTab({ id: 3, url: 'chrome://settings', title: 'Settings' });

    const result = await dispatch('tabs.list', {});
    const tabs = (result.envelope.result as { tabs: { tabId: number; automatable: boolean }[] })
      .tabs;

    expect(tabs).toHaveLength(3);
    expect(tabs.find((t) => t.tabId === 1)?.automatable).toBe(true);
    // Telling the model up front saves it a wasted turn.
    expect(tabs.find((t) => t.tabId === 3)?.automatable).toBe(false);
  });

  it('is read-only and runs without a prompt', async () => {
    const result = await dispatch('tabs.list', {});
    expect(result.risk).toBe('R0');
    expect(prompter.seen).toHaveLength(0);
  });
});

describe('tabs.get_active', () => {
  it('returns the focused tab', async () => {
    const result = await dispatch('tabs.get_active', {});
    expect((result.envelope.result as { tabId: number }).tabId).toBe(1);
  });

  it('reports cleanly when there is no active tab', async () => {
    adapter.tabs.clear();
    const result = await dispatch('tabs.get_active', {});
    expect(result.envelope.error?.code).toBe('TAB_NOT_FOUND');
  });
});

describe('tabs.create', () => {
  it('opens a tab and claims ownership of it', async () => {
    const result = await dispatch('tabs.create', { url: 'https://example.com/new' });
    const tabId = (result.envelope.result as { tabId: number }).tabId;

    expect(result.envelope.status).toBe('success');
    expect(ownership.owns('task_1', tabId)).toBe(true);
  });

  it('refuses a non-automatable URL', async () => {
    const result = await dispatch('tabs.create', { url: 'https://chromewebstore.google.com/x' });
    expect(result.envelope.error?.code).toBe('POLICY_BLOCKED');
  });

  it('still reports the tab when it did not finish loading', async () => {
    adapter.failLoad = true;
    const result = await dispatch('tabs.create', { url: 'https://example.com/slow' });
    const data = result.envelope.result as Record<string, unknown>;
    // An orphan tab the model does not know about would be worse than this.
    expect(result.envelope.status).toBe('success');
    expect(data.loaded).toBe(false);
    expect(data.tabId).toBeDefined();
  });
});

describe('tabs.close', () => {
  it('treats closing a tab the agent opened as low risk and does not prompt', async () => {
    const created = await dispatch('tabs.create', { url: 'https://example.com/new' });
    const tabId = (created.envelope.result as { tabId: number }).tabId;

    const result = await dispatch('tabs.close', { tabId });

    expect(result.risk).toBe('R1');
    expect(result.envelope.status).toBe('success');
    expect(ownership.owns('task_1', tabId)).toBe(false);
    // The agent cleaning up after itself should not train reflexive approval.
    expect(prompter.seen).toHaveLength(0);
  });

  it("treats closing the user's own tab as high risk and always confirms", async () => {
    const result = await dispatch('tabs.close', { tabId: 2 });

    // R3 requires approval in every mode, because it can destroy the user's work.
    expect(result.risk).toBe('R3');
    expect(prompter.seen).toHaveLength(1);
    expect(prompter.seen[0]?.summary).toContain('the user opened');
  });

  it('does not close a user tab when the user declines', async () => {
    prompter.setResponse({ kind: 'deny' });
    const result = await dispatch('tabs.close', { tabId: 2 });
    expect(result.envelope.error?.code).toBe('PERMISSION_DENIED');
    expect(adapter.tabs.has(2)).toBe(true);
  });

  it('does not treat another task’s tab as its own', async () => {
    const created = await dispatch('tabs.create', { url: 'https://example.com/new' }, 'task_a');
    const tabId = (created.envelope.result as { tabId: number }).tabId;

    const result = await dispatch('tabs.close', { tabId }, 'task_b');

    expect(result.risk).toBe('R3');
  });

  it('reports a tab that no longer exists', async () => {
    const result = await dispatch('tabs.close', { tabId: 999 });
    expect(result.envelope.error?.code).toBe('TAB_NOT_FOUND');
  });
});

describe('tabs.activate', () => {
  it('focuses the tab', async () => {
    await dispatch('tabs.activate', { tabId: 2 });
    expect(adapter.tabs.get(2)?.active).toBe(true);
    expect(adapter.tabs.get(1)?.active).toBe(false);
  });
});

describe('tabs.group', () => {
  it('groups tabs and returns the group id', async () => {
    const result = await dispatch('tabs.group', { tabIds: [1, 2], title: 'Research' });
    expect((result.envelope.result as { groupId: number }).groupId).toBe(99);
  });

  it('rejects an empty tab list at the schema', async () => {
    const result = await dispatch('tabs.group', { tabIds: [] });
    expect(result.envelope.error?.code).toBe('INVALID_ARGUMENT');
  });
});

describe('tabs.wait_for_navigation', () => {
  it('resolves when the tab finishes loading', async () => {
    const result = await dispatch('tabs.wait_for_navigation', { tabId: 1 });
    expect((result.envelope.result as { loaded: boolean }).loaded).toBe(true);
  });

  it('reports a timeout as retryable', async () => {
    adapter.failLoad = true;
    const result = await dispatch('tabs.wait_for_navigation', { tabId: 1, timeoutMs: 100 });
    expect(result.envelope.error?.code).toBe('NAVIGATION_TIMEOUT');
    expect(result.envelope.retryable).toBe(true);
  });
});

describe('tabs.get', () => {
  it('returns the named tab rather than the active one', async () => {
    const result = await dispatch('tabs.get', { tabId: 2 });
    const data = result.envelope.result as Record<string, unknown>;

    // The bug this guards against is answering with the focused tab whatever
    // was asked for, which would look right whenever the two coincide.
    expect(data.tabId).toBe(2);
    expect(data.url).toBe('https://docs.test/guide');
    expect(data.title).toBe('Docs');
    expect(data.active).toBe(false);
    expect(data.index).toBe(1);
  });

  it('returns the position a move needs, and withholds the group id', async () => {
    const result = await dispatch('tabs.get', { tabId: 1 });

    expect(Object.keys(result.envelope.result as object).sort()).toEqual([
      'active',
      'automatable',
      'index',
      'tabId',
      'title',
      'url',
      'windowId',
    ]);
  });

  it('flags a tab the agent cannot drive', async () => {
    adapter.addTab({ id: 3, url: 'chrome://settings', title: 'Settings' });
    const result = await dispatch('tabs.get', { tabId: 3 });
    expect((result.envelope.result as { automatable: boolean }).automatable).toBe(false);
  });

  it('reports a tab id that never existed', async () => {
    const result = await dispatch('tabs.get', { tabId: 999 });
    expect(result.envelope.error?.code).toBe('TAB_NOT_FOUND');
    expect(result.envelope.retryable).toBe(false);
  });

  it('reports a tab that has since been closed', async () => {
    await dispatch('tabs.close', { tabId: 2 });
    const result = await dispatch('tabs.get', { tabId: 2 });
    // Not an empty answer the model could read as "no title, no URL".
    expect(result.envelope.error?.code).toBe('TAB_NOT_FOUND');
  });

  it('rejects a missing tab id at the schema', async () => {
    const result = await dispatch('tabs.get', {});
    expect(result.envelope.error?.code).toBe('INVALID_ARGUMENT');
  });

  it('is read-only and runs without a prompt', async () => {
    const result = await dispatch('tabs.get', { tabId: 1 });
    expect(result.risk).toBe('R0');
    expect(prompter.seen).toHaveLength(0);
  });

  it('refuses a tab outside the task’s workspace', async () => {
    harness = createHarness(createTabTools({ adapter, ownership }), {
      prompter,
      resolveWorkspaceTabs: () => Promise.resolve([1]),
    });

    // Answering for any id would leak the tabs tabs.list was narrowed to hide,
    // one tab at a time.
    const result = await dispatch('tabs.get', { tabId: 2 });
    expect(result.envelope.error?.code).toBe('POLICY_BLOCKED');
    expect(result.envelope.error?.message).toContain('not part of this task\u2019s workspace');
  });

  it('leaves tabs.get_active and tabs.list answering as they did', async () => {
    const active = await dispatch('tabs.get_active', {});
    expect((active.envelope.result as { tabId: number }).tabId).toBe(1);

    const listed = await dispatch('tabs.list', {});
    expect((listed.envelope.result as { tabs: unknown[] }).tabs).toHaveLength(2);
  });
});

describe('tabs.move', () => {
  const order = () =>
    [...adapter.tabs.values()].sort((a, b) => a.index - b.index).map((tab) => tab.id);

  it('actually reorders the window', async () => {
    const result = await dispatch('tabs.move', { tabId: 1, index: 1 });
    const data = result.envelope.result as Record<string, unknown>;

    expect(result.envelope.status).toBe('success');
    expect(order()).toEqual([2, 1]);
    expect(data.fromIndex).toBe(0);
    expect(data.index).toBe(1);
    expect(data.clamped).toBe(false);
  });

  it('moves a tab to the front of a longer window', async () => {
    adapter.addTab({ id: 3, url: 'https://third.test/' });
    adapter.addTab({ id: 4, url: 'https://fourth.test/' });

    await dispatch('tabs.move', { tabId: 4, index: 0 });

    expect(order()).toEqual([4, 1, 2, 3]);
    expect(adapter.tabs.get(1)?.index).toBe(1);
  });

  it('reports the position Chrome gave the tab, not the one asked for', async () => {
    const result = await dispatch('tabs.move', { tabId: 1, index: 99 });
    const data = result.envelope.result as Record<string, unknown>;

    // chrome.tabs.move clamps instead of failing, so echoing the request would
    // be a success report for a move that did not happen as asked.
    expect(data.requestedIndex).toBe(99);
    expect(data.index).toBe(1);
    expect(data.clamped).toBe(true);
    expect(order()).toEqual([2, 1]);
  });

  it('accepts a move that changes nothing', async () => {
    const result = await dispatch('tabs.move', { tabId: 1, index: 0 });
    const data = result.envelope.result as Record<string, unknown>;

    expect(data.fromIndex).toBe(0);
    expect(data.index).toBe(0);
    expect(data.clamped).toBe(false);
    expect(order()).toEqual([1, 2]);
  });

  it('reports a tab id that does not exist', async () => {
    const result = await dispatch('tabs.move', { tabId: 999, index: 0 });
    expect(result.envelope.error?.code).toBe('TAB_NOT_FOUND');
    expect(order()).toEqual([1, 2]);
  });

  it('rejects a negative index at the schema', async () => {
    const result = await dispatch('tabs.move', { tabId: 1, index: -1 });
    expect(result.envelope.error?.code).toBe('INVALID_ARGUMENT');
    expect(order()).toEqual([1, 2]);
  });

  it('rejects a fractional index at the schema', async () => {
    const result = await dispatch('tabs.move', { tabId: 1, index: 1.5 });
    expect(result.envelope.error?.code).toBe('INVALID_ARGUMENT');
  });

  it('rejects a missing index at the schema', async () => {
    const result = await dispatch('tabs.move', { tabId: 1 });
    expect(result.envelope.error?.code).toBe('INVALID_ARGUMENT');
  });

  it('refuses a tab outside the task’s workspace, and does not move it', async () => {
    harness = createHarness(createTabTools({ adapter, ownership }), {
      prompter,
      resolveWorkspaceTabs: () => Promise.resolve([1]),
    });

    const result = await dispatch('tabs.move', { tabId: 2, index: 0 });

    expect(result.envelope.error?.code).toBe('POLICY_BLOCKED');
    expect(result.envelope.error?.message).toContain('not part of this task\u2019s workspace');
    expect(order()).toEqual([1, 2]);
  });

  it('is a low-risk change that auto-approves without a prompt', async () => {
    const result = await dispatch('tabs.move', { tabId: 1, index: 1 });
    // R1 sits with tabs.activate and tabs.reload: visible, reversible,
    // destroys nothing. A confirmation here would teach reflexive approval.
    expect(result.risk).toBe('R1');
    expect(prompter.seen).toHaveLength(0);
  });

  it('does not move a tab when the user declines in manual mode', async () => {
    harness.setMode('manual');
    prompter.setResponse({ kind: 'deny' });

    const result = await dispatch('tabs.move', { tabId: 1, index: 1 });

    expect(result.envelope.error?.code).toBe('PERMISSION_DENIED');
    expect(prompter.seen).toHaveLength(1);
    expect(order()).toEqual([1, 2]);
  });
});

describe('the workspace boundary on every tool that takes a tab id', () => {
  /** A workspace holding tab 1 only; tab 2 is open but outside it. */
  const scoped = (members: readonly number[] = [1]) => {
    harness = createHarness(createTabTools({ adapter, ownership }), {
      prompter,
      resolveWorkspaceTabs: () => Promise.resolve(members),
    });
  };

  /**
   * Written out one by one rather than generated from a table.
   *
   * Clause evidence cites `file :: exact title`, and the parity gate requires
   * the title to appear in the file as a complete string literal — so a
   * templated `${tool} refuses …` title cannot be cited at all. The gate caught
   * exactly that here, which is what it is for.
   */
  const refused = async (tool: string, args: Record<string, unknown>) => {
    scoped();
    const result = await dispatch(tool, args);
    expect(result.envelope.error?.code).toBe('POLICY_BLOCKED');
  };

  it('tabs.activate refuses a tab outside the workspace', async () => {
    await refused('tabs.activate', { tabId: 2 });
  });

  it('tabs.reload refuses a tab outside the workspace', async () => {
    await refused('tabs.reload', { tabId: 2 });
  });

  it('tabs.wait_for_navigation refuses a tab outside the workspace', async () => {
    await refused('tabs.wait_for_navigation', { tabId: 2 });
  });

  it('tabs.group refuses a tab outside the workspace', async () => {
    await refused('tabs.group', { tabIds: [2] });
  });

  it('tabs.ungroup refuses a tab outside the workspace', async () => {
    await refused('tabs.ungroup', { tabIds: [2] });
  });

  it('tabs.get and tabs.move still refuse one too', async () => {
    await refused('tabs.get', { tabId: 2 });
    await refused('tabs.move', { tabId: 2, index: 0 });
  });

  it('tabs.group refuses the whole call when one id is outside', async () => {
    scoped();
    // Not "group the ones it may": a partially applied reorganisation of the
    // user's tab strip is worse than none.
    const result = await dispatch('tabs.group', { tabIds: [1, 2] });
    expect(result.envelope.error?.code).toBe('POLICY_BLOCKED');
    expect(adapter.tabs.get(2)?.groupId).toBe(-1);
  });

  it('tabs.wait_for_navigation tells the model nothing about a tab it may not see', async () => {
    scoped();
    const result = await dispatch('tabs.wait_for_navigation', { tabId: 2 });
    // The old version returned this tab's url and title at R0 with no prompt.
    expect(JSON.stringify(result.envelope)).not.toContain('docs.test');
  });

  it('tabs.activate tells the model nothing about a tab it may not see', async () => {
    scoped();
    const result = await dispatch('tabs.activate', { tabId: 2 });
    expect(JSON.stringify(result.envelope)).not.toContain('docs.test');
    expect(adapter.tabs.get(2)?.active).toBe(false);
  });

  it('tabs.group joins the workspace group instead of making a new one', async () => {
    adapter.tabs.set(1, { ...adapter.tabs.get(1)!, groupId: 77 });
    harness = createHarness(createTabTools({ adapter, ownership }), {
      prompter,
      resolveWorkspaceTabs: () => Promise.resolve([1]),
      resolveWorkspaceGroupId: () => Promise.resolve(77),
    });

    const result = await dispatch('tabs.group', { tabIds: [1], title: 'Research' });

    expect((result.envelope.result as { groupId: number }).groupId).toBe(77);
    // Still in the workspace. Creating a new group is what used to take the
    // task's own tab out of the scope it was running in.
    expect(adapter.tabs.get(1)?.groupId).toBe(77);
    expect(adapter.groupTitles.get(77)).toBe('Research');
  });

  it('tabs.ungroup refuses to empty the workspace, and allows releasing one of several', async () => {
    scoped([1, 2]);

    const last = await dispatch('tabs.ungroup', { tabIds: [1, 2] });
    expect(last.envelope.error?.code).toBe('POLICY_BLOCKED');
    expect(last.envelope.error?.message).toContain('last tab');

    const one = await dispatch('tabs.ungroup', { tabIds: [2] });
    // Releasing a tab the task is done with only narrows its own reach.
    expect(one.envelope.status).toBe('success');
    expect(adapter.tabs.get(2)?.groupId).toBe(-1);
  });

  it('still works normally when no workspace narrowing is configured', async () => {
    // Unit harnesses without narrowing, and any future caller that has no
    // workspace, must not be broken by the guard.
    const result = await dispatch('tabs.activate', { tabId: 2 });
    expect(result.envelope.status).toBe('success');
  });
});
