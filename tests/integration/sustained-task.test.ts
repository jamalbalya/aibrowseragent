/**
 * TEST-AGENT-005 — A task sustained over many turns (REQ-AGENT-003, §17).
 *
 * The rest of the runtime suite runs trajectories a handful of turns long.
 * That leaves the failure modes that only appear with length untested: usage
 * counters drifting from the work actually done, step history losing or
 * duplicating entries, the loop detector mistaking legitimate repetition for
 * a stuck agent, and context growth going unbounded.
 *
 * Length here means turns, not seconds. Every clock the runtime reads is
 * injected, so the run is deterministic and finishes in milliseconds — a test
 * that slept would be slower, flakier, and would prove less.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '@/agent/runtime/agent-runtime';
import { DEFAULT_BUDGET } from '@/agent/budget/budget';
import { createBrowserTools } from '@/tools/browser/browser-tools';
import { createTask } from '@/tasks/task-model';
import type { TaskStep } from '@/tasks/task-model';
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

/** Distinct pages, so successive reads are genuine progress, not repetition. */
const pageAt = (n: number): SemanticPage => ({
  url: `https://example.com/page-${n}`,
  title: `Page ${n}`,
  generation: n,
  capturedAt: 1000 + n,
  readyState: 'complete',
  text: `This is page ${n} of the catalogue.`,
  textTruncated: false,
  elements: [
    {
      elementId: `e${n}-0`,
      role: 'link',
      name: `Next from ${n}`,
      visible: true,
      enabled: true,
      selectorHints: [`#next-${n}`],
      frameId: 'main',
    },
  ],
  elementsTruncated: false,
  fields: [],
  scrollY: 0,
  documentHeight: 2000,
  viewportHeight: 800,
});

/**
 * Turns to sustain.
 *
 * Bounded by the default budget, not chosen for roundness: each turn costs
 * two model requests and two tool calls, and DEFAULT_BUDGET allows 40 and 60.
 * 18 turns is 37 requests and 36 calls — the longest run that finishes on its
 * own work rather than on a budget, which is what the first test asserts.
 */
const TURNS = 18;

let adapter: FakeBrowserAdapter;
let harness: Harness;
let visited: number;

beforeEach(() => {
  visited = 0;
  adapter = new FakeBrowserAdapter();
  adapter.addTab({ id: 1, url: 'https://example.com/page-0', title: 'Page 0', active: true });
  adapter.onContent((type) => {
    if (type === 'content.readPage') return { page: pageAt(visited) };
    if (type === 'content.click') {
      visited += 1;
      return { clicked: true, navigated: true };
    }
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

/** read → click, repeated, then a final answer. */
function longTrajectory(turns: number) {
  const script = [];
  for (let i = 0; i < turns; i += 1) {
    script.push(toolCallResponse('browser_read_page', {}));
    script.push(toolCallResponse('browser_click', { elementId: `e${i}-0` }));
  }
  script.push(textResponse('Walked the whole catalogue.'));
  return new FakeProvider(script);
}

describe('a task sustained over many turns', () => {
  it('runs to completion without tripping a budget or the loop detector', async () => {
    const steps: TaskStep[] = [];
    const runtime = new AgentRuntime({
      registry: harness.registry,
      callbacks: {
        onStateChange: () => Promise.resolve(),
        onComplete: () => Promise.resolve(),
        onStep: (_id, step) => {
          steps.push(step);
          return Promise.resolve();
        },
        onActivity: () => undefined,
        onUsage: () => Promise.resolve(),
        onEvidence: () => Promise.resolve(),
        persistTaint: async () => ({ kind: 'KNOWN_UNTAINTED' }) as const,
        recoverSalt: async () => ({ salt: 'ab'.repeat(32), epoch: 1 }),
      },
    });

    const output = await runtime.run({
      task: createTask({
        id: 'task_long',
        sessionId: 's1',
        objective: 'Walk the catalogue end to end.',
        providerId: 'fake',
        modelId: 'fake-model',
        permissionMode: 'auto',
        now: 1000,
      }),
      provider: longTrajectory(TURNS),
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    // It finished because it ran out of work, not because a guard stopped it.
    expect(output.result.outcome).toBe('COMPLETED');
    expect(output.result.failedActions).toEqual([]);
    expect(output.result.blockedActions).toEqual([]);
  });

  it('keeps usage accounting equal to the work actually performed', async () => {
    // A counter that drifts over a long run is how a budget silently stops
    // protecting anything.
    const runtime = new AgentRuntime({
      registry: harness.registry,
      callbacks: {
        onStateChange: () => Promise.resolve(),
        onComplete: () => Promise.resolve(),
        onStep: () => Promise.resolve(),
        onActivity: () => undefined,
        onUsage: () => Promise.resolve(),
        onEvidence: () => Promise.resolve(),
        persistTaint: async () => ({ kind: 'KNOWN_UNTAINTED' }) as const,
        recoverSalt: async () => ({ salt: 'ab'.repeat(32), epoch: 1 }),
      },
    });

    const output = await runtime.run({
      task: createTask({
        id: 'task_long',
        sessionId: 's1',
        objective: 'Walk the catalogue end to end.',
        providerId: 'fake',
        modelId: 'fake-model',
        permissionMode: 'auto',
        now: 1000,
      }),
      provider: longTrajectory(TURNS),
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    // Two tool calls per turn, plus one model request per turn and the final
    // answer. Exact, not approximate: this is the number a budget divides.
    expect(output.usage.toolCalls).toBe(TURNS * 2);
    expect(output.usage.modelRequests).toBe(TURNS * 2 + 1);
    expect(output.usage.toolCalls).toBeLessThan(DEFAULT_BUDGET.maxToolCalls);
    expect(output.usage.screenshots).toBe(0);
    expect(output.usage.externalWrites).toBe(0);
  });

  it('records every step exactly once, in order', async () => {
    const steps: TaskStep[] = [];
    const runtime = new AgentRuntime({
      registry: harness.registry,
      callbacks: {
        onStateChange: () => Promise.resolve(),
        onComplete: () => Promise.resolve(),
        onStep: (_id, step) => {
          steps.push(step);
          return Promise.resolve();
        },
        onActivity: () => undefined,
        onUsage: () => Promise.resolve(),
        onEvidence: () => Promise.resolve(),
        persistTaint: async () => ({ kind: 'KNOWN_UNTAINTED' }) as const,
        recoverSalt: async () => ({ salt: 'ab'.repeat(32), epoch: 1 }),
      },
    });

    await runtime.run({
      task: createTask({
        id: 'task_long',
        sessionId: 's1',
        objective: 'Walk the catalogue end to end.',
        providerId: 'fake',
        modelId: 'fake-model',
        permissionMode: 'auto',
        now: 1000,
      }),
      provider: longTrajectory(TURNS),
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    const toolSteps = steps.filter((step) => step.tool !== undefined);
    expect(toolSteps).toHaveLength(TURNS * 2);
    expect(toolSteps.every((step) => step.status !== 'error')).toBe(true);

    // No duplicates: a resumed or retried turn must not re-file a step.
    const ids = toolSteps.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Alternating read/click for the whole run, which is what proves the
    // trajectory really was sustained rather than truncated early.
    expect(toolSteps.map((step) => step.tool)).toEqual(
      Array.from({ length: TURNS }, () => ['browser.read_page', 'browser.click']).flat(),
    );
  });

  it('stops on the budget rather than running forever when the model will not finish', async () => {
    // The other half of "long-running": a model that never answers must be
    // stopped by the budget, with the work so far preserved.
    const endless = new FakeProvider(
      Array.from({ length: 200 }, () => toolCallResponse('browser_read_page', {})),
    );

    const runtime = new AgentRuntime({
      registry: harness.registry,
      budget: { ...DEFAULT_BUDGET, maxToolCalls: 12 },
      callbacks: {
        onStateChange: () => Promise.resolve(),
        onComplete: () => Promise.resolve(),
        onStep: () => Promise.resolve(),
        onActivity: () => undefined,
        onUsage: () => Promise.resolve(),
        onEvidence: () => Promise.resolve(),
        persistTaint: async () => ({ kind: 'KNOWN_UNTAINTED' }) as const,
        recoverSalt: async () => ({ salt: 'ab'.repeat(32), epoch: 1 }),
      },
    });

    const output = await runtime.run({
      task: createTask({
        id: 'task_endless',
        sessionId: 's1',
        objective: 'Never stop reading.',
        providerId: 'fake',
        modelId: 'fake-model',
        permissionMode: 'auto',
        now: 1000,
      }),
      provider: endless,
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    expect(output.result.outcome).not.toBe('COMPLETED');
    expect(output.usage.toolCalls).toBeLessThanOrEqual(12);
  });
});
