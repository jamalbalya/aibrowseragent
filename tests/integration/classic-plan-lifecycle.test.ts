/**
 * TEST-TASK-004 — the Classic plan lifecycle, end to end through the manager.
 *
 * TEST-SECURITY-068 proves what a plan can and cannot authorise. This proves
 * the sequence around it: a Classic task proposes and stops, an approval is
 * what restarts it, and everything that happens in between leaves the task
 * exactly as unauthorised as it was.
 *
 * Nothing here stubs the manager or the store. What is scripted is the model's
 * reply and the person's answer, because those are the two inputs the product
 * genuinely does not control.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MemoryStorageArea,
  NamespacedStorageArea,
  SerializedStorageArea,
} from '@/storage/storage-area';
import { TaskStore } from '@/tasks/task-store';
import { TaskManager, TaskManagerError } from '@/background/task-manager';
import { AgentRuntime } from '@/agent/runtime/agent-runtime';
import { createBrowserTools } from '@/tools/browser/browser-tools';
import { FieldObservationStore } from '@/policy/field-observation-store';
import { isTerminal, type AgentTask, type TaskState } from '@/tasks/task-model';
import { APPROVAL_PROVENANCE } from '@/policy/plan-model';
import { FakeBrowserAdapter } from '../fixtures/fake-browser';
import { fakeDebugger } from '../fixtures/fake-debugger';
import { FULL_CAPABILITIES, FakeProvider, textResponse } from '../fixtures/fake-provider';
import { createHarness, ScriptedPrompter } from '../fixtures/policy-harness';
import type { SemanticPage } from '@/content/semantic-tree';
import type * as MessagingBus from '@/messaging/bus';

vi.mock('@/messaging/bus', async (importOriginal) => {
  const actual = await importOriginal<typeof MessagingBus>();
  return { ...actual, broadcastEvent: vi.fn() };
});

const page: SemanticPage = {
  url: 'https://example.com/',
  title: 'Example',
  generation: 1,
  capturedAt: 1,
  readyState: 'complete',
  text: 'Hello',
  textTruncated: false,
  elements: [],
  elementsTruncated: false,
  fields: [],
  scrollY: 0,
  documentHeight: 100,
  viewportHeight: 100,
};

/** Source with comments removed, so a structural test reads code and not prose. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const planReply = (sites: string[], approach = 'Read the page and summarise it.') =>
  textResponse(JSON.stringify({ approach, sites }));

/** Lets a test change the active model the way switching providers would. */
let switchedModel = 'fake-model';

function build(script = [planReply(['example.com']), textResponse('Finished.')]) {
  const backing = new SerializedStorageArea(new MemoryStorageArea());
  const store = new TaskStore(new NamespacedStorageArea(backing, 'tasks'));

  const adapter = new FakeBrowserAdapter();
  adapter.addTab({ id: 1, url: 'https://example.com/', active: true });
  adapter.onContent((type) => (type === 'content.readPage' ? { page } : {}));

  const harness = createHarness(
    createBrowserTools({
      fieldObservations: new FieldObservationStore(),
      adapter,
      debuggerManager: fakeDebugger().manager,
    }),
    { prompter: new ScriptedPrompter({ kind: 'approve_once' }) },
  );
  const provider = new FakeProvider(script);

  const manager = new TaskManager({
    store,
    resolveProvider: () =>
      Promise.resolve({
        adapter: provider,
        capabilities: FULL_CAPABILITIES,
        providerId: 'fake',
        modelId: switchedModel,
      }),
    getPermissionMode: () => Promise.resolve('manual'),
    getActiveTabId: () => Promise.resolve(1),
  });
  manager.setRuntime(
    new AgentRuntime({ registry: harness.registry, callbacks: manager.createCallbacks() }),
  );

  return { manager, store, provider };
}

/** Polls until the task reaches one of the given states. */
async function until(
  store: TaskStore,
  taskId: string,
  states: readonly TaskState[],
  attempts = 200,
): Promise<AgentTask> {
  for (let i = 0; i < attempts; i += 1) {
    const task = await store.getTask(taskId);
    if (task && (states.includes(task.state) || isTerminal(task.state))) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Task never reached ${states.join('/')}`);
}

/**
 * Waits for a task that is parked with a proposal in front of it.
 *
 * Deliberately not "parked", full stop. A revision leaves the task parked with
 * its proposal already dropped, so a helper that only watched the state would
 * read the gap between dropping one proposal and writing the next and call it
 * a result.
 */
async function waitingWithPlan(
  store: TaskStore,
  taskId: string,
  attempts = 200,
): Promise<AgentTask> {
  for (let i = 0; i < attempts; i += 1) {
    const task = await store.getTask(taskId);
    if (task?.state === 'WAITING_FOR_USER' && task.planProposal !== undefined) return task;
    if (task && isTerminal(task.state)) {
      throw new Error(`Task finished as ${task.state} instead of waiting for a plan`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Task never parked with a proposal');
}

let ctx: ReturnType<typeof build>;

beforeEach(() => {
  switchedModel = 'fake-model';
  ctx = build();
});

describe('TEST-TASK-004: a Classic task proposes and stops', () => {
  it('01 — parks in WAITING_FOR_USER with a proposal and no authorization', async () => {
    const created = await ctx.manager.create('Summarise the page', 's1', {
      authorizationModel: 'classic',
    });
    const parked = await waitingWithPlan(ctx.store, created.id);

    expect(parked.state).toBe('WAITING_FOR_USER');
    expect(parked.planProposal?.proposedSites).toEqual(['example.com']);
    expect(parked.planProposal?.proposedBy).toBe('model');
    // The half that matters: a proposal exists and authorises nothing.
    expect(parked.planApproval).toBeUndefined();
  });

  it('02 — dispatches nothing before the plan is approved', async () => {
    // NEGATIVE CONTROL. A task that acted while its plan was still a proposal
    // would make the approval decorative. One provider request has gone out —
    // the planning turn — and no tool has run.
    const created = await ctx.manager.create('Summarise the page', 's1', {
      authorizationModel: 'classic',
    });
    const parked = await waitingWithPlan(ctx.store, created.id);

    expect(ctx.provider.requests).toHaveLength(1);
    expect(ctx.provider.requests[0]?.tools).toEqual([]);
    expect(parked.steps.filter((step) => step.kind === 'tool_call')).toEqual([]);
  });

  it('03 — a Cowork task does not plan at all', async () => {
    // The control for case 01. Without it, a build that planned for every task
    // would pass, and so would one that planned for none.
    const cowork = build([textResponse('Finished.')]);
    const created = await cowork.manager.create('Summarise the page', 's1');
    const settled = await until(cowork.store, created.id, ['COMPLETED']);

    expect(settled.planProposal).toBeUndefined();
    expect(settled.authorizationModel).toBeUndefined();
    expect(settled.state).toBe('COMPLETED');
  });

  it('04 — a model that answers with prose produces an empty plan, not a wide one', async () => {
    // Fail closed. An unparseable reply must not become "every site", and it
    // must not become an exception either: the person still gets to decide.
    const loose = build([textResponse('I will look at some websites.'), textResponse('Done.')]);
    const created = await loose.manager.create('Do the thing', 's1', {
      authorizationModel: 'classic',
    });
    const parked = await waitingWithPlan(loose.store, created.id);

    expect(parked.planProposal?.proposedSites).toEqual([]);
    expect(parked.planProposal?.approachText).toBe('I will look at some websites.');
  });
});

describe('TEST-TASK-004: approval is what starts the run', () => {
  it('05 — approving produces a separate approval record and resumes the task', async () => {
    const created = await ctx.manager.create('Summarise the page', 's1', {
      authorizationModel: 'classic',
    });
    await waitingWithPlan(ctx.store, created.id);

    await ctx.manager.approvePlanFor(created.id);
    const finished = await until(ctx.store, created.id, ['COMPLETED']);

    expect(finished.planApproval?.approvedSites).toEqual(['example.com']);
    expect(finished.planApproval?.version).toBe(1);
    expect(finished.planApproval?.approvalProvenance).toBe(APPROVAL_PROVENANCE);
    // The proposal is still there, unchanged, next to the approval rather than
    // replaced by it.
    expect(finished.planProposal?.proposedSites).toEqual(['example.com']);
    expect(finished.state).toBe('COMPLETED');
  });

  it('06 — approving twice is refused, so no amendment can be lost', async () => {
    // NEGATIVE CONTROL. A second approval would mint version 1 again and drop
    // every site the person added during the run.
    const created = await ctx.manager.create('Summarise the page', 's1', {
      authorizationModel: 'classic',
    });
    await waitingWithPlan(ctx.store, created.id);
    await ctx.manager.approvePlanFor(created.id);

    await expect(ctx.manager.approvePlanFor(created.id)).rejects.toBeInstanceOf(TaskManagerError);
  });

  it('06b — a finished task cannot be approved or re-planned', async () => {
    // NEGATIVE CONTROL. An approval on a finished task governs nothing and
    // would read, in the record and in the panel, as though it had.
    const cowork = build([textResponse('Finished.')]);
    const created = await cowork.manager.create('Do the thing', 's1');
    await until(cowork.store, created.id, ['COMPLETED']);

    await expect(cowork.manager.approvePlanFor(created.id)).rejects.toBeInstanceOf(
      TaskManagerError,
    );
    await expect(cowork.manager.revisePlan(created.id)).rejects.toBeInstanceOf(TaskManagerError);
  });

  it('07 — a live task with no proposal cannot be approved', async () => {
    // Paused rather than finished, and asserted on the reason. A finished task
    // is refused by case 06b for a different reason, and an assertion that
    // only checked the error type would prove that one instead of this one.
    const created = await ctx.manager.create('Summarise the page', 's1');
    await ctx.manager.pause(created.id);

    await expect(ctx.manager.approvePlanFor(created.id)).rejects.toThrow(/no plan to approve/i);
    await expect(ctx.manager.approvePlanFor('task_nonexistent')).rejects.toThrow(
      /no longer exists/i,
    );
  });

  it('08 — a site approved mid-run amends the plan and never becomes a site rule', async () => {
    const created = await ctx.manager.create('Summarise the page', 's1', {
      authorizationModel: 'classic',
    });
    await waitingWithPlan(ctx.store, created.id);
    await ctx.manager.approvePlanFor(created.id);
    await until(ctx.store, created.id, ['COMPLETED']);

    await ctx.manager.addSiteToPlan(created.id, 'https://other.test/page');
    const amended = await ctx.store.getTask(created.id);

    expect(amended?.planApproval?.approvedSites).toEqual(['example.com', 'other.test']);
    expect(amended?.planApproval?.version).toBe(2);
    expect(amended?.planApproval?.supersedes).toMatch(/@1$/);
  });

  it('09 — amending a task that never planned changes nothing', async () => {
    // NEGATIVE CONTROL. "Allow for this task" must not be a second route to
    // creating an authorization that nobody approved a plan for.
    const created = await ctx.manager.create('Summarise the page', 's1');
    await until(ctx.store, created.id, ['COMPLETED']);

    await ctx.manager.addSiteToPlan(created.id, 'https://other.test/page');
    expect((await ctx.store.getTask(created.id))?.planApproval).toBeUndefined();
  });
});

describe('TEST-TASK-004: asking for changes creates nothing', () => {
  it('10 — a revision drops the proposal, keeps the note and plans again', async () => {
    const revised = build([
      planReply(['first.test']),
      planReply(['second.test']),
      textResponse('Finished.'),
    ]);
    const created = await revised.manager.create('Do the thing', 's1', {
      authorizationModel: 'classic',
    });
    await waitingWithPlan(revised.store, created.id);

    await revised.manager.revisePlan(created.id, 'Use the other site instead.');
    const replanned = await waitingWithPlan(revised.store, created.id);

    expect(replanned.planProposal?.proposedSites).toEqual(['second.test']);
    // NEGATIVE CONTROL: the round trip authorised nothing.
    expect(replanned.planApproval).toBeUndefined();
    // The note reached the model, and was spent rather than left to steer
    // every future proposal.
    const second = revised.provider.requests[1];
    expect(JSON.stringify(second?.messages)).toContain('Use the other site instead.');
    expect(replanned.planRevisionNote).toBeUndefined();
  });

  it('11 — a revision after approval is refused', async () => {
    // NEGATIVE CONTROL. Re-proposing under an authorization already given
    // would produce a plan nobody approved.
    const created = await ctx.manager.create('Summarise the page', 's1', {
      authorizationModel: 'classic',
    });
    await waitingWithPlan(ctx.store, created.id);
    await ctx.manager.approvePlanFor(created.id);

    await expect(ctx.manager.revisePlan(created.id, 'change it')).rejects.toBeInstanceOf(
      TaskManagerError,
    );
  });
});

describe('TEST-TASK-004: the planning turn is not a second execution engine', () => {
  it('11b — the planning turn holds no reference to the tool registry', () => {
    // Structural, and the claim it protects is the architecture lock: there is
    // one execution path, and it is `ToolRegistry.dispatch`. A planning turn
    // that could reach the registry would be a second dispatcher running
    // before any plan had been approved.
    // Comments stripped first: the file's own header explains *why* it cannot
    // reach the registry, and matching that prose would make the test pass on
    // the explanation rather than on the code.
    const source = withoutComments(
      readFileSync(resolve(import.meta.dirname, '../../src/agent/runtime/plan-turn.ts'), 'utf8'),
    );
    expect(source).not.toMatch(/tool-registry|ToolRegistry|dispatch\(/);
    // And it is the only thing the task manager calls before an approval.
    const manager = withoutComments(
      readFileSync(resolve(import.meta.dirname, '../../src/background/task-manager.ts'), 'utf8'),
    );
    const planningBranch = manager.slice(
      manager.indexOf("task.authorizationModel === 'classic'"),
      manager.indexOf('const tabId = await this.options.getActiveTabId();'),
    );
    expect(planningBranch).toContain('this.proposePlan(');
    expect(planningBranch).not.toMatch(/registry|dispatch/i);
  });

  it('11c — a cancelled task cannot then be approved', async () => {
    // Cancellation is a decision too. An approval accepted afterwards would
    // sit on the record reading as authority for a run the person stopped.
    const created = await ctx.manager.create('Summarise the page', 's1', {
      authorizationModel: 'classic',
    });
    await waitingWithPlan(ctx.store, created.id);
    await ctx.manager.cancel(created.id);

    await expect(ctx.manager.approvePlanFor(created.id)).rejects.toThrow(/already finished/i);
    expect((await ctx.store.getTask(created.id))?.planApproval).toBeUndefined();
  });

  it('11d — switching the model does not touch the approval', async () => {
    // §60 already refuses to continue a task on a different model. What is
    // asserted here is the other half: the refusal neither consumes nor
    // widens the authorization the person gave.
    const created = await ctx.manager.create('Summarise the page', 's1', {
      authorizationModel: 'classic',
    });
    await waitingWithPlan(ctx.store, created.id);
    await ctx.manager.approvePlanFor(created.id);
    const approved = await until(ctx.store, created.id, ['COMPLETED']);

    // Parked rather than finished, so the resume actually reaches the
    // provider-identity check. A completed task is refused before that branch
    // runs, and the case would then prove nothing about it.
    await ctx.store.updateTask(created.id, (task) => ({ ...task, state: 'PAUSED' }));
    switchedModel = 'other-model';
    await ctx.manager.resume(created.id).catch(() => undefined);
    const after = await until(ctx.store, created.id, ['FAILED']);

    // The branch ran: the task refused to continue on a different model.
    expect(after.state).toBe('FAILED');
    expect(after.error?.code).toBe('POLICY_BLOCKED');
    // And it neither consumed nor widened what the person authorised.
    expect(after.planApproval).toEqual(approved.planApproval);
    expect(after.planApproval?.version).toBe(1);
  });
});

describe('TEST-TASK-004: the authorization does not travel', () => {
  it('12 — a retry carries the shape and not the approval', async () => {
    // NEGATIVE CONTROL. The retry is a new task against the same objective; an
    // inherited approval would be an authorization given against a proposal
    // this task has not made.
    const created = await ctx.manager.create('Summarise the page', 's1', {
      authorizationModel: 'classic',
    });
    await waitingWithPlan(ctx.store, created.id);
    await ctx.manager.approvePlanFor(created.id);
    await until(ctx.store, created.id, ['COMPLETED']);

    const retried = await ctx.manager.retry(created.id);
    expect(retried.id).not.toBe(created.id);
    expect(retried.authorizationModel).toBe('classic');
    expect(retried.planApproval).toBeUndefined();
    expect(retried.planProposal).toBeUndefined();
  });

  it('13 — the planning turn goes through the ordinary egress context', async () => {
    // Not a separate path to the provider: the same task id, taint, salt and
    // model identity every other request carries.
    const created = await ctx.manager.create('Summarise the page', 's1', {
      authorizationModel: 'classic',
    });
    await waitingWithPlan(ctx.store, created.id);

    const planning = ctx.provider.requests[0];
    expect(planning?.egress?.taskId).toBe(created.id);
    expect(planning?.egress?.providerId).toBe('fake');
    expect(planning?.egress?.modelId).toBe('fake-model');
    expect(planning?.egress?.taintSignature).toEqual(expect.any(String));
    // And it offers the model nothing to call.
    expect(planning?.toolChoice).toBe('none');
  });
});
