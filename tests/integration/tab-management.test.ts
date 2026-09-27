/**
 * TEST-TABS-002 — tabs.get and tabs.move through the real agent loop
 * (REQ-TABS-001, specification §10).
 *
 * The unit suite dispatches these two tools directly. This one runs the leg
 * that matters for the parity claim: the tools are declared by
 * `createTabTools`, which is what the service worker registers, the model is
 * offered them in its catalogue, it calls them by name, and the real registry
 * carries the call through policy to the browser adapter. Only the provider
 * and the Chrome APIs are faked.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime, type RuntimeCallbacks } from '@/agent/runtime/agent-runtime';
import { TabOwnership, createTabTools } from '@/tools/tabs/tab-tools';
import { createTask, type AgentTask } from '@/tasks/task-model';
import { FakeBrowserAdapter } from '../fixtures/fake-browser';
import {
  FULL_CAPABILITIES,
  FakeProvider,
  textResponse,
  toolCallResponse,
} from '../fixtures/fake-provider';
import { createHarness, ScriptedPrompter, type Harness } from '../fixtures/policy-harness';

const callbacks: RuntimeCallbacks = {
  onStateChange: () => Promise.resolve(),
  onComplete: () => Promise.resolve(),
  onStep: () => Promise.resolve(),
  onActivity: () => {},
  onUsage: () => Promise.resolve(),
  onEvidence: () => Promise.resolve(),
  persistTaint: async () => ({ kind: 'KNOWN_UNTAINTED' }) as const,
  recoverSalt: async () => ({ salt: 'ab'.repeat(32), epoch: 1 }),
};

const task = (): AgentTask =>
  createTask({
    id: 'task_1',
    sessionId: 's1',
    objective: 'Put the documentation tab first.',
    providerId: 'fake',
    modelId: 'fake-model',
    permissionMode: 'auto',
    now: 1000,
  });

let adapter: FakeBrowserAdapter;
let harness: Harness;

const order = () =>
  [...adapter.tabs.values()].sort((a, b) => a.index - b.index).map((tab) => tab.id);

/** What the model was actually handed back, unwrapped from the transcript. */
const toolResults = (provider: FakeProvider): string[] =>
  provider.requests.flatMap((request) =>
    request.messages.flatMap((message) =>
      message.role === 'tool'
        ? message.content.flatMap((part) =>
            part.type === 'tool_result' ? [String(part.content)] : [],
          )
        : [],
    ),
  );

const run = (provider: FakeProvider) =>
  new AgentRuntime({ registry: harness.registry, callbacks }).run({
    task: task(),
    provider,
    capabilities: FULL_CAPABILITIES,
    signal: new AbortController().signal,
    tabId: 1,
  });

beforeEach(() => {
  adapter = new FakeBrowserAdapter();
  adapter.addTab({ id: 1, url: 'https://example.com/', title: 'Example', active: true });
  adapter.addTab({ id: 2, url: 'https://docs.test/guide', title: 'Docs' });
  adapter.addTab({ id: 3, url: 'https://third.test/', title: 'Third' });
  harness = createHarness(createTabTools({ adapter, ownership: new TabOwnership() }), {
    prompter: new ScriptedPrompter({ kind: 'approve_once' }),
  });
});

describe('tool declaration', () => {
  it('offers both tools to the model by name', async () => {
    const provider = new FakeProvider([textResponse('nothing to do')]);
    await run(provider);

    const names = provider.requests[0]?.tools?.map((t) => t.name) ?? [];
    // The registration in createTabTools is what the service worker installs,
    // so a tool missing here is a tool the model can never call in production.
    expect(names).toContain('tabs_get');
    expect(names).toContain('tabs_move');
  });
});

describe('the model reordering tabs', () => {
  it('reads a tab’s position and then moves it, changing the real order', async () => {
    const provider = new FakeProvider([
      toolCallResponse('tabs_get', { tabId: 2 }),
      toolCallResponse('tabs_move', { tabId: 2, index: 0 }),
      textResponse('The documentation tab is now first.'),
    ]);

    const output = await run(provider);

    expect(output.result.outcome).toBe('COMPLETED');
    expect(output.result.completedActions).toEqual(
      expect.arrayContaining(['tabs.get', 'tabs.move']),
    );
    // The browser state, not the narration.
    expect(order()).toEqual([2, 1, 3]);
  });

  it('gives the model the tab it asked about, not the active one', async () => {
    const provider = new FakeProvider([
      toolCallResponse('tabs_get', { tabId: 3 }),
      textResponse('done'),
    ]);
    await run(provider);

    const seen = provider.allText();
    expect(seen).toContain('https://third.test/');
    // Tab 1 is the active tab and the run's ambient tab; answering with it
    // would be the defect this tool exists to rule out.
    expect(seen).not.toContain('https://example.com/');
  });

  it('tells the model the position Chrome actually used', async () => {
    const provider = new FakeProvider([
      toolCallResponse('tabs_move', { tabId: 1, index: 42 }),
      textResponse('done'),
    ]);
    await run(provider);

    // Clamped to the end of a three-tab window. A run that echoed 42 back
    // would leave the model planning against a window that does not exist.
    expect(order()).toEqual([2, 3, 1]);
    const result = toolResults(provider).join('');
    expect(result).toContain('"index":2');
    expect(result).toContain('"requestedIndex":42');
    expect(result).toContain('"clamped":true');
  });

  it('reports a tab that is gone as a failed call, not a silent no-op', async () => {
    const provider = new FakeProvider([
      toolCallResponse('tabs_move', { tabId: 999, index: 0 }),
      textResponse('That tab no longer exists.'),
    ]);

    const output = await run(provider);

    // PARTIAL rather than COMPLETED: a run in which a tool errored did not do
    // everything it was asked to, and §76 forbids reporting otherwise.
    expect(output.result.outcome).toBe('PARTIAL');
    expect(toolResults(provider).join('')).toContain('TAB_NOT_FOUND');
    expect(order()).toEqual([1, 2, 3]);
  });
});
