/**
 * TEST-SECURITY-066 — the origin-drift control has a production producer.
 *
 * This suite exists because of a specific defect, and the defect was not a
 * missing control. `evaluatePolicy` has had an origin-drift rule since Stage
 * 3, `assertAutomatable` has had a matching re-check, and both were covered by
 * tests. What neither had was a *caller*: `ToolInvocation.plannedUrl` was
 * never populated by `AgentRuntime` or `SkillRunner`, so in a real browser the
 * rule never ran. It appeared only in test fixtures, which is exactly how a
 * dead control stays green for months.
 *
 * A second defect sat underneath it. The rule compared `plannedUrl` against
 * `targetUrl` — a *navigation destination*, which only `browser.navigate`
 * supplies. So for every page tool there was nothing to compare against, and
 * for `browser.navigate` the comparison was a destination against itself. Even
 * with a producer, the check could not have fired.
 *
 * So the cases below are deliberately not "does the policy engine handle
 * drift". They are:
 *
 *  A. the production loop supplies `plannedUrl`, asserted by running the real
 *     `AgentRuntime` and the real `SkillRunner` rather than by constructing a
 *     `ToolInvocation` by hand;
 *  B. the signal comes from the browser, and a model or a page cannot choose
 *     it;
 *  C. drift reaches the real policy engine through the real registry;
 *  D. a structural guard, so that a *future* dispatch site added without a
 *     planned URL fails here instead of silently going dark.
 *
 * D is the case that would have caught the original defect. It is the point of
 * the suite.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AgentRuntime, type RuntimeCallbacks } from '@/agent/runtime/agent-runtime';
import { buildSkillHarness, skillFixture } from '../fixtures/skill-harness';
import { createBrowserTools } from '@/tools/browser/browser-tools';
import { FieldObservationStore } from '@/policy/field-observation-store';
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
import type { ToolInvocation } from '@/tools/registry/tool-registry';

const SRC_ROOT = resolve(import.meta.dirname, '../../src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/** Source with comments and string literals removed, so prose cannot satisfy a code check. */
function identifiersOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

const page: SemanticPage = {
  url: 'https://example.com/',
  title: 'Example Domain',
  generation: 1,
  capturedAt: 1000,
  readyState: 'complete',
  text: 'Ordinary page text.',
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

function silentCallbacks(): { callbacks: RuntimeCallbacks; steps: TaskStep[] } {
  const steps: TaskStep[] = [];
  const callbacks: RuntimeCallbacks = {
    onStateChange: async (_id: string, _state: TaskState) => {},
    onActivity: () => {},
    onStep: async (_id: string, step: TaskStep) => {
      steps.push(step);
    },
    onComplete: async () => {},
    onEvidence: async () => {},
    onUsage: async () => {},
    persistTaint: async () => undefined,
    recoverSalt: async () => undefined,
  };
  return { callbacks, steps };
}

const task = (): AgentTask =>
  createTask({
    id: 'task_drift_1',
    objective: 'Do something ordinary.',
    sessionId: 's1',
    providerId: 'fake',
    modelId: 'fake-1',
    permissionMode: 'auto',
    now: 1000,
  });

let adapter: FakeBrowserAdapter;
let harness: Harness;
/** Every invocation the registry saw, captured by wrapping the real registry. */
let seen: ToolInvocation[];

beforeEach(() => {
  adapter = new FakeBrowserAdapter();
  adapter.addTab({ id: 1, url: 'https://example.com/', title: 'Example', active: true });
  adapter.onContent((type) => {
    if (type === 'content.readPage') return { page };
    if (type === 'content.click') return { clicked: true, navigated: false };
    return { typed: true };
  });
  harness = createHarness(
    createBrowserTools({
      fieldObservations: new FieldObservationStore(),
      adapter,
      debuggerManager: fakeDebugger().manager,
    }),
    {
      prompter: new ScriptedPrompter({ kind: 'approve_once' }),
      resolveTabUrl: (tabId) => Promise.resolve(adapter.tabs.get(tabId)?.url),
    },
  );

  seen = [];
  const realDispatch = harness.registry.dispatch.bind(harness.registry);
  // Wrapping rather than stubbing: the real dispatch still runs, so these
  // cases observe production behaviour instead of replacing it.
  harness.registry.dispatch = (invocation: ToolInvocation) => {
    seen.push(invocation);
    return realDispatch(invocation);
  };
});

// ---------------------------------------------------------------------------
// A. The production loops supply it
// ---------------------------------------------------------------------------

describe('A. the signal is produced where calls are actually made', () => {
  it('01 the agent loop supplies a planned URL on every dispatch of a turn', async () => {
    const { callbacks } = silentCallbacks();
    const runtime = new AgentRuntime({
      registry: harness.registry,
      callbacks,
      resolveTabUrl: async (tabId) => adapter.tabs.get(tabId)?.url,
    });

    await runtime.run({
      task: task(),
      provider: new FakeProvider([
        toolCallResponse('browser_read_page', {}),
        textResponse('Done.'),
      ]),
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const invocation of seen) {
      expect(invocation.plannedUrl, invocation.name).toBe('https://example.com/');
    }
  });

  it('02 the skill runner supplies a planned URL on every step', async () => {
    // The real `SkillRunner`, which is also the path workflow replay,
    // shortcuts and scheduled runs take — so one case covers all four.
    const skills = buildSkillHarness({
      tools: [{ name: 'probe.step', risk: 'R0' }],
      resolveTabUrl: () => Promise.resolve('https://example.com/'),
    });
    const stepSeen: (string | undefined)[] = [];
    const realDispatch = skills.tools.dispatch.bind(skills.tools);
    skills.tools.dispatch = (invocation: ToolInvocation) => {
      stepSeen.push(invocation.plannedUrl);
      return realDispatch(invocation);
    };

    const definition = skillFixture({
      requiredTools: ['probe.step'],
      steps: [
        { kind: 'tool', id: 's1', tool: 'probe.step', description: 'First probe.', arguments: {} },
        { kind: 'tool', id: 's2', tool: 'probe.step', description: 'Second probe.', arguments: {} },
      ],
    });
    await skills.register(definition);
    const registered = skills.skills.get(definition.id, definition.version);
    await skills.runner.run(registered!, {}, skills.context({ tabId: 1 }));

    expect(stepSeen.length).toBe(2);
    for (const planned of stepSeen) {
      expect(planned).toBe('https://example.com/');
    }
  });

  it('03 no planned URL is invented when there is no tab', async () => {
    const { callbacks } = silentCallbacks();
    const runtime = new AgentRuntime({
      registry: harness.registry,
      callbacks,
      resolveTabUrl: async (tabId) => adapter.tabs.get(tabId)?.url,
    });

    await runtime.run({
      task: task(),
      provider: new FakeProvider([toolCallResponse('tabs_list', {}), textResponse('Done.')]),
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      // No tabId: nothing to observe, so nothing is claimed.
    });

    for (const invocation of seen) {
      expect(invocation.plannedUrl, invocation.name).toBeUndefined();
    }
  });

  it('04 a browser that cannot answer yields no planned URL rather than a guess', async () => {
    const { callbacks } = silentCallbacks();
    const runtime = new AgentRuntime({
      registry: harness.registry,
      callbacks,
      resolveTabUrl: () => Promise.reject(new Error('tab is gone')),
    });

    await runtime.run({
      task: task(),
      provider: new FakeProvider([
        toolCallResponse('browser_read_page', {}),
        textResponse('Done.'),
      ]),
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    // Not knowing where a page is says nothing about whether it moved. The run
    // continues and is judged on everything else.
    expect(seen.length).toBeGreaterThan(0);
    for (const invocation of seen) {
      expect(invocation.plannedUrl, invocation.name).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// B. Where it comes from
// ---------------------------------------------------------------------------

describe('B. the browser chooses it, not the model and not the page', () => {
  it('05 a planned URL in the model’s arguments is not the planned URL', async () => {
    const { callbacks } = silentCallbacks();
    const runtime = new AgentRuntime({
      registry: harness.registry,
      callbacks,
      resolveTabUrl: async (tabId) => adapter.tabs.get(tabId)?.url,
    });

    await runtime.run({
      task: task(),
      provider: new FakeProvider([
        // The model tries to supply one. Tool arguments are validated against
        // a Zod schema that has no such field, and the invocation is built by
        // the loop rather than from the arguments.
        toolCallResponse('browser_read_page', { plannedUrl: 'https://attacker.test/' }),
        textResponse('Done.'),
      ]),
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const invocation of seen) {
      expect(invocation.plannedUrl).toBe('https://example.com/');
      expect(invocation.plannedUrl).not.toBe('https://attacker.test/');
    }
  });

  it('06 the planned URL follows the browser when the tab really moves', async () => {
    const { callbacks } = silentCallbacks();
    const runtime = new AgentRuntime({
      registry: harness.registry,
      callbacks,
      resolveTabUrl: async (tabId) => adapter.tabs.get(tabId)?.url,
    });

    adapter.setUrl(1, 'https://elsewhere.test/page');
    await runtime.run({
      task: task(),
      provider: new FakeProvider([
        toolCallResponse('browser_read_page', {}),
        textResponse('Done.'),
      ]),
      capabilities: FULL_CAPABILITIES,
      signal: new AbortController().signal,
      tabId: 1,
    });

    for (const invocation of seen) {
      expect(invocation.plannedUrl).toBe('https://elsewhere.test/page');
    }
  });
});

// ---------------------------------------------------------------------------
// C. It reaches the real decision
// ---------------------------------------------------------------------------

describe('C. drift reaches the real policy engine through the real registry', () => {
  it('07 a page that moves between planning and dispatch is confirmed', async () => {
    const prompter = new ScriptedPrompter({ kind: 'approve_once' });
    const local = createHarness(
      createBrowserTools({
        fieldObservations: new FieldObservationStore(),
        adapter,
        debuggerManager: fakeDebugger().manager,
      }),
      {
        mode: 'skip',
        prompter,
        resolveTabUrl: (tabId) => Promise.resolve(adapter.tabs.get(tabId)?.url),
      },
    );

    // Skip mode: nothing else in the engine would prompt, so a prompt here is
    // the drift rule and only the drift rule.
    const result = await local.registry.dispatch({
      toolCallId: 'tc_1',
      taskId: 't1',
      sessionId: 's1',
      name: 'browser.click',
      arguments: { elementId: 'e1-0' },
      tabId: 1,
      plannedUrl: 'https://bank.test/transfer',
      signal: new AbortController().signal,
    });

    expect(prompter.seen.length).toBe(1);
    expect(result.policy?.code).toBe('ORIGIN_CHANGED');

    // And then the tool refuses anyway. `assertAutomatable` has always
    // re-checked the origin immediately before acting; until now it was fed
    // the same empty `plannedUrl` and could not fire either. With the producer
    // in place both layers work, and they disagree on purpose: the engine asks
    // the person whether to continue, and the primitive still declines to act
    // on a page nobody authorised. Approving drift is not the same as
    // authorising the new origin, and the safe reading is the one that stops.
    expect(result.envelope.status).toBe('error');
    expect(result.envelope.error?.code).toBe('ORIGIN_CHANGED');
    expect(result.executed).toBe(true);
  });

  it('08 a declined drift confirmation stops the action', async () => {
    const local = createHarness(
      createBrowserTools({
        fieldObservations: new FieldObservationStore(),
        adapter,
        debuggerManager: fakeDebugger().manager,
      }),
      {
        mode: 'skip',
        prompter: new ScriptedPrompter({ kind: 'deny' }),
        resolveTabUrl: (tabId) => Promise.resolve(adapter.tabs.get(tabId)?.url),
      },
    );

    const result = await local.registry.dispatch({
      toolCallId: 'tc_1',
      taskId: 't1',
      sessionId: 's1',
      name: 'browser.click',
      arguments: { elementId: 'e1-0' },
      tabId: 1,
      plannedUrl: 'https://bank.test/transfer',
      signal: new AbortController().signal,
    });

    expect(result.executed).toBe(false);
    expect(result.envelope.error?.code).toBe('PERMISSION_DENIED');
  });

  it('09 a page that stayed put raises no confirmation', async () => {
    const prompter = new ScriptedPrompter({ kind: 'approve_once' });
    const local = createHarness(
      createBrowserTools({
        fieldObservations: new FieldObservationStore(),
        adapter,
        debuggerManager: fakeDebugger().manager,
      }),
      {
        mode: 'skip',
        prompter,
        resolveTabUrl: (tabId) => Promise.resolve(adapter.tabs.get(tabId)?.url),
      },
    );

    const result = await local.registry.dispatch({
      toolCallId: 'tc_1',
      taskId: 't1',
      sessionId: 's1',
      name: 'browser.click',
      arguments: { elementId: 'e1-0' },
      tabId: 1,
      plannedUrl: 'https://example.com/',
      signal: new AbortController().signal,
    });

    // The false-positive guard. A control that confirmed on every action
    // would pass case 07 and be useless.
    expect(prompter.seen.length).toBe(0);
    expect(result.policy?.code).not.toBe('ORIGIN_CHANGED');
    expect(result.envelope.status).toBe('success');
  });

  it('10 a malformed planned URL cannot lower risk or clear a confirmation', async () => {
    const prompter = new ScriptedPrompter({ kind: 'approve_once' });
    const local = createHarness(
      createBrowserTools({
        fieldObservations: new FieldObservationStore(),
        adapter,
        debuggerManager: fakeDebugger().manager,
      }),
      {
        mode: 'auto',
        prompter,
        resolveTabUrl: (tabId) => Promise.resolve(adapter.tabs.get(tabId)?.url),
      },
    );

    for (const planned of ['', 'not a url', 'javascript:alert(1)', '://', 'https://']) {
      prompter.seen.length = 0;
      const result = await local.registry.dispatch({
        toolCallId: 'tc_1',
        taskId: 't1',
        sessionId: 's1',
        name: 'browser.type',
        arguments: { elementId: 'e1-0', text: 'x', submit: true },
        tabId: 1,
        plannedUrl: planned,
        signal: new AbortController().signal,
      });
      // `submit: true` is R2, which prompts in Auto. A planned URL that could
      // not be parsed must not turn that into an allow.
      expect(result.risk, planned).toBe('R2');
      expect(prompter.seen.length, planned).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// D. The structural guard
// ---------------------------------------------------------------------------

describe('D. a future dispatch site cannot go dark the way this one did', () => {
  it('11 every file that dispatches also supplies a planned URL', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC_ROOT)) {
      if (file.endsWith('tool-registry.ts')) continue;
      const code = identifiersOnly(readFileSync(file, 'utf8'));
      if (!/\.dispatch\(\{/.test(code)) continue;
      // A tripwire, not a parser: a file that builds invocations and never
      // mentions a planned URL is the shape the original defect had.
      if (!code.includes('plannedUrl')) offenders.push(file.replace(`${SRC_ROOT}/`, ''));
    }
    expect(offenders).toEqual([]);
  });

  it('12 the known producers are exactly the two that exist', () => {
    // If a third appears, this fails and whoever added it has to decide
    // whether it can know a planned URL — which is the question that went
    // unasked last time.
    const producers = sources(SRC_ROOT)
      .filter((file) => !file.endsWith('tool-registry.ts'))
      .filter((file) => /\.dispatch\(\{/.test(identifiersOnly(readFileSync(file, 'utf8'))))
      .map((file) => file.replace(`${SRC_ROOT}/`, ''))
      .sort();

    expect(producers).toEqual(['agent/runtime/agent-runtime.ts', 'skills/runtime/skill-runner.ts']);
  });

  it('13 both producers read the URL from the browser, not from the call', () => {
    for (const relative of ['agent/runtime/agent-runtime.ts', 'skills/runtime/skill-runner.ts']) {
      const code = readFileSync(join(SRC_ROOT, relative), 'utf8');
      // Resolved through the injected browser reader...
      expect(code, relative).toContain('resolveTabUrl');
      expect(code, relative).toContain('observeTabUrl');
      // ...and never lifted out of the arguments the model produced.
      expect(identifiersOnly(code), relative).not.toMatch(
        /plannedUrl\s*[:=]\s*(?:call\.)?arguments/,
      );
      expect(identifiersOnly(code), relative).not.toMatch(/plannedUrl\s*[:=]\s*args/);
    }
  });

  it('14 the service worker resolves tab URLs in exactly one place', () => {
    const worker = readFileSync(join(SRC_ROOT, 'background/service-worker.ts'), 'utf8');
    // One definition, three consumers. Three readings of "where is this tab"
    // would eventually disagree, and the permissive one would be the bug.
    const definitions = [...worker.matchAll(/const resolveTabUrl\s*=/g)];
    expect(definitions.length).toBe(1);
    expect(worker).toContain('getTab(tabId))?.url');
  });

  it('15 the drift rule is not nested under a navigation destination again', () => {
    const engine = readFileSync(join(SRC_ROOT, 'policy/policy-engine.ts'), 'utf8');
    // The original defect in one assertion: drift compared against
    // `targetUrl`, which only `browser.navigate` supplies.
    expect(engine).toContain('evaluateTransition(request.plannedUrl, request.currentUrl)');
    expect(identifiersOnly(engine)).not.toContain(
      'evaluateTransition(request.plannedUrl, request.targetUrl)',
    );
  });
});
