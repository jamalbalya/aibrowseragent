/**
 * TEST-AGENT-003 — Agent runtime end to end (REQ-AGENT-003).
 *
 * Exercises the real loop: context → model → registry dispatch (with real
 * policy and permission) → result → next turn. Only the provider and the
 * Chrome APIs are faked.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime, type RuntimeCallbacks } from '@/agent/runtime/agent-runtime';
import { createBrowserTools } from '@/tools/browser/browser-tools';
import { createTask, type AgentTask, type TaskState, type TaskStep } from '@/tasks/task-model';
import { FakeBrowserAdapter } from '../fixtures/fake-browser';
import { fakeDebugger } from '../fixtures/fake-debugger';
import {
  FULL_CAPABILITIES,
  FakeProvider,
  textResponse,
  toolCallResponse,
} from '../fixtures/fake-provider';
import { createHarness, ScriptedPrompter, type Harness } from '../fixtures/policy-harness';
import type { SemanticPage } from '@/content/semantic-tree';
import { FieldObservationStore } from '@/policy/field-observation-store';

const page: SemanticPage = {
  url: 'https://example.com/',
  title: 'Example Domain',
  generation: 1,
  capturedAt: 1000,
  readyState: 'complete',
  text: 'This domain is for use in illustrative examples in documents.',
  textTruncated: false,
  elements: [
    {
      elementId: 'e1-0',
      role: 'link',
      name: 'More information',
      visible: true,
      enabled: true,
      selectorHints: ['#more'],
      frameId: 'main',
    },
  ],
  elementsTruncated: false,
  fields: [],
  scrollY: 0,
  documentHeight: 600,
  viewportHeight: 600,
};

interface Recorder {
  readonly callbacks: RuntimeCallbacks;
  readonly states: TaskState[];
  readonly steps: TaskStep[];
  readonly activities: string[];
  /** Terminal outcomes, recorded atomically by `onComplete`. */
  readonly completions: { state: TaskState; hasResult: boolean }[];
}

function recorder(): Recorder {
  const states: TaskState[] = [];
  const steps: TaskStep[] = [];
  const activities: string[] = [];
  const completions: { state: TaskState; hasResult: boolean }[] = [];
  return {
    states,
    steps,
    activities,
    completions,
    callbacks: {
      onStateChange: (_id, state) => {
        states.push(state);
        return Promise.resolve();
      },
      onComplete: (_id, outcome) => {
        states.push(outcome.state);
        completions.push({ state: outcome.state, hasResult: !!outcome.result });
        return Promise.resolve();
      },
      onStep: (_id, step) => {
        steps.push(step);
        return Promise.resolve();
      },
      onActivity: (_id, activity) => activities.push(activity),
      onUsage: () => Promise.resolve(),
      onEvidence: () => Promise.resolve(),
      persistTaint: async () => ({ kind: 'KNOWN_UNTAINTED' }) as const,
      recoverSalt: async () => ({ salt: 'ab'.repeat(32), epoch: 1 }),
    },
  };
}

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    ...createTask({
      id: 'task_1',
      sessionId: 's1',
      objective: 'Read the current page and summarise it.',
      providerId: 'fake',
      modelId: 'fake-model',
      permissionMode: 'auto',
      now: 1000,
    }),
    ...overrides,
  };
}

let adapter: FakeBrowserAdapter;
let harness: Harness;

beforeEach(() => {
  adapter = new FakeBrowserAdapter();
  adapter.addTab({ id: 1, url: 'https://example.com/', title: 'Example Domain', active: true });
  adapter.onContent((type) => {
    if (type === 'content.readPage') return { page };
    if (type === 'content.click') return { clicked: true, navigated: false };
    if (type === 'content.scroll') return { scrollY: 480, atBottom: false };
    return {};
  });
  harness = createHarness(
    createBrowserTools({
      fieldObservations: new FieldObservationStore(),
      adapter,
      debuggerManager: fakeDebugger().manager,
    }),
    {
      prompter: new ScriptedPrompter({ kind: 'approve_once' }),
    },
  );
});

const runtimeFor = (rec: Recorder) =>
  new AgentRuntime({ registry: harness.registry, callbacks: rec.callbacks });

describe('the required first demo flow', () => {
  it('reads the page through the real tool architecture and reports a summary', async () => {
    // Specification section 53: read the current page, return a structured
    // result with the tool used, the summary, and an evidence reference.
    const provider = new FakeProvider([
      toolCallResponse('browser_read_page', {}),
      textResponse('The page explains that example.com is reserved for documentation.'),
    ]);
    const rec = recorder();

    const output = await runtimeFor(rec).run({
      task: makeTask(),
      provider,
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    expect(output.result.outcome).toBe('COMPLETED');
    expect(output.result.summary).toContain('example.com');
    expect(output.result.completedActions).toContain('browser.read_page');
    expect(output.result.evidenceIds.length).toBeGreaterThan(0);
    expect(rec.activities).toContain('Reading the page');
    expect(rec.states.at(-1)).toBe('COMPLETED');
    // The terminal state and its result arrive together, so no observer can
    // see a finished task with no outcome.
    expect(rec.completions).toEqual([{ state: 'COMPLETED', hasResult: true }]);

    // The page content actually reached the model, wrapped as untrusted data.
    expect(provider.allText()).toContain('UNTRUSTED_EXTERNAL_CONTENT');
    expect(provider.allText()).toContain('illustrative examples');
  });

  it('exposes the tool catalogue to the provider', async () => {
    const provider = new FakeProvider([textResponse('done')]);
    await runtimeFor(recorder()).run({
      task: makeTask(),
      provider,
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    const names = provider.requests[0]?.tools?.map((t) => t.name) ?? [];
    expect(names).toContain('browser_read_page');
    expect(names).toContain('browser_click');
  });
});

describe('capability gating', () => {
  it('refuses to run when the model cannot call tools', async () => {
    const provider = new FakeProvider([textResponse('I will pretend to click.')]);
    const rec = recorder();

    const output = await runtimeFor(rec).run({
      task: makeTask(),
      provider,
      capabilities: { ...FULL_CAPABILITIES, toolCalling: false },
      signal: new AbortController().signal,
    });

    expect(output.result.outcome).toBe('BLOCKED');
    expect(output.result.summary).toContain('tool calling');
    // No model request is made at all: the task is refused up front.
    expect(provider.requests).toHaveLength(0);
  });

  it('tells the model when vision is unavailable', async () => {
    const provider = new FakeProvider([textResponse('ok')]);
    await runtimeFor(recorder()).run({
      task: makeTask(),
      provider,
      capabilities: { ...FULL_CAPABILITIES, vision: false },
      signal: new AbortController().signal,
      tabId: 1,
    });
    expect(provider.requests[0]?.systemInstruction).toContain('cannot accept images');
  });
});

describe('multi-step execution', () => {
  it('feeds each tool result back and continues', async () => {
    const provider = new FakeProvider([
      toolCallResponse('browser_read_page', {}, 'tc_1'),
      toolCallResponse('browser_click', { elementId: 'e1-0' }, 'tc_2'),
      toolCallResponse('browser_read_page', {}, 'tc_3'),
      textResponse('Clicked through and read the next page.'),
    ]);
    const rec = recorder();

    const output = await runtimeFor(rec).run({
      task: makeTask(),
      provider,
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    expect(output.result.outcome).toBe('COMPLETED');
    expect(output.usage.toolCalls).toBe(3);
    expect(output.usage.modelRequests).toBe(4);
    // Repeated page reads between actions must not be flagged as a loop.
    expect(output.result.summary).not.toContain('repeated');
  });

  it('reports a failed tool call as failed and does not claim success', async () => {
    const provider = new FakeProvider([
      toolCallResponse('browser_click', { elementId: 'missing' }, 'tc_1'),
      textResponse('I could not click that element.'),
    ]);
    adapter.onContent((type) => {
      if (type === 'content.click') return new Error('Receiving end does not exist.');
      return { page };
    });
    const rec = recorder();

    const output = await runtimeFor(rec).run({
      task: makeTask(),
      provider,
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    // Some work failed, so the outcome is PARTIAL rather than COMPLETED.
    expect(output.result.outcome).toBe('PARTIAL');
    expect(output.result.failedActions[0]).toContain('browser.click');
    expect(rec.steps.some((step) => step.status === 'error')).toBe(true);
  });

  it('records a blocked action separately from a failure', async () => {
    const prompter = new ScriptedPrompter({ kind: 'deny' });
    harness = createHarness(
      createBrowserTools({
        fieldObservations: new FieldObservationStore(),
        adapter,
        debuggerManager: fakeDebugger().manager,
      }),
      { prompter, mode: 'manual' },
    );

    const provider = new FakeProvider([
      toolCallResponse('browser_click', { elementId: 'e1-0' }, 'tc_1'),
      textResponse('The user declined that action.'),
    ]);
    const rec = recorder();

    const output = await runtimeFor(rec).run({
      task: makeTask({ permissionMode: 'manual' }),
      provider,
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    expect(output.result.blockedActions[0]).toContain('browser.click');
    expect(output.result.failedActions).toHaveLength(0);
  });
});

describe('malformed model output', () => {
  it('rejects tool arguments that were not valid JSON without dispatching', async () => {
    const provider = new FakeProvider([
      {
        text: '',
        toolCalls: [
          {
            toolCallId: 'tc_1',
            name: 'browser_click',
            arguments: {},
            parseError: 'Unexpected token }',
          },
        ],
        finishReason: 'tool_call',
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      textResponse('Recovered.'),
    ]);
    const rec = recorder();

    await runtimeFor(rec).run({
      task: makeTask(),
      provider,
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    expect(adapter.calls.filter((c) => c.type === 'content.click')).toHaveLength(0);
    expect(rec.steps.some((s) => s.error?.code === 'TOOL_CALL_INVALID')).toBe(true);
  });

  it('refuses a tool that does not exist', async () => {
    const provider = new FakeProvider([
      toolCallResponse('browser_delete_everything', {}, 'tc_1'),
      textResponse('That tool is not available.'),
    ]);

    const output = await runtimeFor(recorder()).run({
      task: makeTask(),
      provider,
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    expect(output.result.failedActions[0]).toContain('browser.delete_everything');
  });
});

describe('loop detection', () => {
  it('stops a task that repeats the same failing call', async () => {
    adapter.onContent((type) => {
      if (type === 'content.click') return new Error('Receiving end does not exist.');
      return { page };
    });
    const provider = new FakeProvider(
      Array.from({ length: 10 }, (_, i) =>
        toolCallResponse('browser_click', { elementId: 'e1-0' }, `tc_${i}`),
      ),
    );
    const rec = recorder();

    const output = await runtimeFor(rec).run({
      task: makeTask(),
      provider,
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    expect(output.result.outcome).toBe('FAILED');
    expect(output.result.summary.toLowerCase()).toMatch(/repeat|different approach/);
    // It stopped well before exhausting the script.
    expect(output.usage.toolCalls).toBeLessThan(6);
  });
});

describe('budgets', () => {
  it('stops with a structured failure when the tool-call budget runs out', async () => {
    const provider = new FakeProvider(
      Array.from({ length: 20 }, (_, i) =>
        toolCallResponse('browser_scroll', { direction: 'down', amount: 100 + i }, `tc_${i}`),
      ),
    );
    const rec = recorder();

    const runtime = new AgentRuntime({
      registry: harness.registry,
      callbacks: rec.callbacks,
      budget: {
        maxDurationMs: 60_000,
        maxToolCalls: 3,
        maxModelRequests: 50,
        maxRetries: 5,
        maxScreenshots: 5,
        maxExternalWrites: 5,
        maxTotalTokens: 1_000_000,
      },
    });

    const output = await runtime.run({
      task: makeTask(),
      provider,
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    expect(output.result.outcome).toBe('PARTIAL');
    expect(output.result.summary).toContain('Budget exhausted');
    expect(output.usage.toolCalls).toBeLessThanOrEqual(4);
  });
});

describe('cancellation', () => {
  it('stops immediately when cancelled before the first turn', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new FakeProvider([textResponse('should not run')]);

    const output = await runtimeFor(recorder()).run({
      task: makeTask(),
      provider,
      capabilities: FULL_CAPABILITIES,
      signal: controller.signal,
      tabId: 1,
    });

    expect(output.result.outcome).toBe('CANCELLED');
    expect(provider.requests).toHaveLength(0);
  });

  it('stops between tool calls once cancelled', async () => {
    const controller = new AbortController();
    const provider = new FakeProvider([
      toolCallResponse('browser_read_page', {}, 'tc_1'),
      textResponse('done'),
    ]);
    // Cancel as soon as the first model turn has been issued.
    const originalGenerate = provider.generate.bind(provider);
    provider.generate = (request) => {
      controller.abort();
      return originalGenerate(request);
    };

    const output = await runtimeFor(recorder()).run({
      task: makeTask(),
      provider,
      capabilities: FULL_CAPABILITIES,
      signal: controller.signal,
      tabId: 1,
    });

    expect(output.result.outcome).toBe('CANCELLED');
  });
});

describe('provider failures', () => {
  it('retries a transient provider error then continues', async () => {
    const provider = new FakeProvider([textResponse('recovered after a retry')]);
    provider.failWith = Object.assign(new Error('network'), {
      agentError: {
        code: 'NETWORK_ERROR',
        message: 'network',
        userMessage: 'network',
        recoverable: true,
        retryable: true,
      },
    });
    const rec = recorder();

    const runtime = new AgentRuntime({
      registry: harness.registry,
      callbacks: rec.callbacks,
      random: () => 0,
    });

    // Clear the failure after the first attempt so the retry succeeds.
    const original = provider.generate.bind(provider);
    let attempts = 0;
    provider.generate = (request) => {
      attempts += 1;
      if (attempts > 1) provider.failWith = null;
      return original(request);
    };

    const output = await runtime.run({
      task: makeTask(),
      provider,
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    expect(output.result.outcome).toBe('COMPLETED');
    expect(output.usage.retries).toBeGreaterThan(0);
    expect(rec.states).toContain('RECOVERING');
  });

  it('fails cleanly on a non-retryable provider error', async () => {
    const provider = new FakeProvider([]);
    provider.failWith = Object.assign(new Error('bad key'), {
      agentError: {
        code: 'AUTH_EXPIRED',
        message: 'bad key',
        userMessage: 'The API key was rejected.',
        recoverable: false,
        retryable: false,
      },
    });

    const output = await runtimeFor(recorder()).run({
      task: makeTask(),
      provider,
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    expect(output.result.outcome).toBe('FAILED');
    expect(output.result.summary).toContain('API key');
    // The structured code travels with the result so the record can
    // distinguish this from, say, a detected loop.
    expect(output.error?.code).toBe('AUTH_EXPIRED');
  });

  it('reports a detected loop with its own code', async () => {
    adapter.onContent((type) => {
      if (type === 'content.click') return new Error('Receiving end does not exist.');
      return { page };
    });
    const provider = new FakeProvider(
      Array.from({ length: 10 }, (_, i) =>
        toolCallResponse('browser_click', { elementId: 'e1-0' }, `tc_${i}`),
      ),
    );

    const output = await runtimeFor(recorder()).run({
      task: makeTask(),
      provider,
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    expect(output.error?.code).toBe('LOOP_DETECTED');
  });
});

describe('no fabricated success', () => {
  it('never reports a completed action for a tool that errored', async () => {
    adapter.onContent(() => new Error('Receiving end does not exist.'));
    const provider = new FakeProvider([
      toolCallResponse('browser_read_page', {}, 'tc_1'),
      textResponse('I was unable to read the page.'),
    ]);

    const output = await runtimeFor(recorder()).run({
      task: makeTask(),
      provider,
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    expect(output.result.completedActions).toEqual([]);
    expect(output.result.failedActions).toHaveLength(1);
    expect(output.result.outcome).not.toBe('COMPLETED');
  });

  it('passes the tool error back to the model so it can adapt', async () => {
    adapter.onContent(() => new Error('Receiving end does not exist.'));
    const provider = new FakeProvider([
      toolCallResponse('browser_read_page', {}, 'tc_1'),
      textResponse('done'),
    ]);

    await runtimeFor(recorder()).run({
      task: makeTask(),
      provider,
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    const toolMessage = provider.requests[1]?.messages.find((m) => m.role === 'tool');
    const part = toolMessage?.content.find((c) => c.type === 'tool_result');
    const envelope = JSON.parse(part && 'content' in part ? part.content : '{}');

    expect(envelope.status).toBe('error');
    expect(envelope.error.code).toBe('PAGE_NOT_READY');
    expect(envelope.retryable).toBe(true);
  });
});

describe('system instruction', () => {
  it('states the trust hierarchy and the untrusted-content rule', async () => {
    const provider = new FakeProvider([textResponse('ok')]);
    await runtimeFor(recorder()).run({
      task: makeTask(),
      provider,
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    const instruction = provider.requests[0]?.systemInstruction ?? '';
    expect(instruction).toContain('Trust hierarchy');
    expect(instruction).toContain('UNTRUSTED_EXTERNAL_CONTENT');
    expect(instruction).toContain('never a grant of permission');
    expect(instruction).toContain('Never report an action as done when its tool errored');
  });

  it('reflects the active permission mode', async () => {
    const provider = new FakeProvider([textResponse('ok')]);
    await runtimeFor(recorder()).run({
      task: makeTask({ permissionMode: 'manual' }),
      provider,
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });
    expect(provider.requests[0]?.systemInstruction).toContain('Manual');
  });
});
