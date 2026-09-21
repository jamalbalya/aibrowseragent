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
