/**
 * TEST-SECURITY-068 — the Classic plan as an authorization source (Phase C).
 *
 * A plan is a person saying "these sites, for this task" once, up front,
 * instead of answering the same question at every action. That is a real
 * authorization, so the only question worth asking about it is what it cannot
 * do — and the cases below are weighted accordingly.
 *
 * Three properties carry the design, and each is tested as a property rather
 * than as a behaviour:
 *
 *   1. Proposal and approval are separate objects. The model writes one; a
 *      person's panel action produces the other. There is no field on the
 *      proposal to flip, so "the model approved its own plan" is not a bug
 *      that can be introduced by a wrong line — it has nowhere to be written.
 *   2. There is one producer, reachable from one CLASS_B route. Not one
 *      producer today: the call sites are counted from source.
 *   3. The plan is consulted at one point in the one policy engine, after
 *      every stage that can refuse. So each refusal below is not a rule the
 *      plan path re-implements; it is a rule the plan path never reaches.
 *
 * Groups:
 *   A. structure and provenance — who can produce an approval at all
 *   B. what a plan cannot clear (the negative controls, with positive halves)
 *   C. what it does clear, and exactly how far
 *   D. amendment — narrower than a standing grant, and it stays narrower
 *   E. lifetime: task-scoped, never inherited, never exported
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  evaluatePolicy,
  ALWAYS_CONFIRM_AT,
  type PolicyContext,
  type PolicyRequest,
} from '@/policy/policy-engine';
import { RISK_RANK } from '@/policy/risk-classifier';
import {
  amendPlan,
  approvePlan,
  buildProposal,
  parsePlanApproval,
  planCoversSite,
  APPROVAL_PROVENANCE,
  MAX_PROPOSED_SITES,
  PLAN_MAX_RISK,
  type PlanApproval,
} from '@/policy/plan-model';
import { clampToGrantable, emptySitePolicyState, upsertRule } from '@/policy/site-policy';
import { PermissionEngine, type PermissionResponse } from '@/policy/permission-engine';
import { PANEL_ROUTE_CLASSES, type RouteClass } from '@/messaging/route-trust';
import {
  NEVER_CROSSES_INSTALLATION_BOUNDARY,
  TASK_FIELD_PORTABILITY,
} from '@/storage/record-portability';
import {
  DATA_CLASSIFICATION,
  EXPORT_PORTABILITY,
  K1_PROTECTION,
  PORTABLE_DATA_KINDS,
} from '@/storage/data-classification';
import { buildRequest } from '@/agent/context/context-builder';
import { createTask } from '@/tasks/task-model';
import { ScriptedPrompter } from '../fixtures/policy-harness';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import type { SitePolicyState } from '@/policy/site-policy';

const SRC_ROOT = resolve(import.meta.dirname, '../../src');
const read = (relative: string): string => readFileSync(join(SRC_ROOT, relative), 'utf8');

/** An approval for `example.com`, produced the only way one can be produced. */
const approvalFor = (...sites: string[]): PlanApproval =>
  approvePlan(
    buildProposal({
      proposalId: 'prop_1',
      taskId: 'task_1',
      approachText: 'Look at the page and click the first result.',
      sites,
      now: 1_000,
    }),
    'plan_1',
    2_000,
  );

const request = (overrides: Partial<PolicyRequest> = {}): PolicyRequest => ({
  tool: 'browser.click',
  taskId: 'task_1',
  risk: 'R1',
  siteScope: 'https://example.com/page',
  ...overrides,
});

const context = (overrides: Partial<PolicyContext> = {}): PolicyContext => ({
  mode: 'manual',
  sitePolicy: emptySitePolicyState(),
  planApproval: approvalFor('example.com'),
  ...overrides,
});

/**
 * The same context with no plan at all.
 *
 * Built by removing the field rather than by setting it to `undefined`: under
 * `exactOptionalPropertyTypes` those are different things, and "absent" is the
 * one the production code actually sees.
 */
const noPlan = (overrides: Partial<PolicyContext> = {}): PolicyContext => {
  const { planApproval: _absent, ...rest } = context(overrides);
  return rest;
};

/**
 * The policy context a worker would build for a task, given a stored record.
 *
 * Mirrors `loadPolicyContext`: the record is re-parsed against the task it was
 * found on, and an approval that does not belong to it arrives absent.
 */
const planContextFor = (stored: unknown, taskId: string): Pick<PolicyContext, 'planApproval'> => {
  const parsed = parsePlanApproval(stored, taskId);
  return parsed === undefined ? {} : { planApproval: parsed };
};

/** The same request with no authorization scope established. */
const noScope = (overrides: Partial<PolicyRequest> = {}): PolicyRequest => {
  const { siteScope: _absent, ...rest } = request(overrides);
  return rest;
};

describe('TEST-SECURITY-068 group A: only a person, through one route, can approve a plan', () => {
  it('01 — a proposal carries no field that could authorise anything', () => {
    const proposal = buildProposal({
      proposalId: 'prop_1',
      taskId: 'task_1',
      approachText: 'Search and read the first result.',
      sites: ['example.com'],
      now: 1,
    });

    // Named exhaustively rather than by absence of a keyword: a future field
    // has to be added here, which is where somebody would have to think about
    // whether it grants something.
    expect(Object.keys(proposal).sort()).toEqual(
      ['approachText', 'proposalId', 'proposedAt', 'proposedBy', 'proposedSites', 'taskId'].sort(),
    );
    // And the one field naming an origin cannot name a provider.
    expect(proposal.proposedBy).toBe('model');
  });

  it('02 — exactly one module in the product can call the producer', () => {
    // By import rather than by call: a name can be shadowed, and the panel has
    // its own `approvePlan` that sends a message. What cannot be faked is
    // which modules hold the real one, so that is what is counted.
    const holders = sourceFiles().filter((file) =>
      /import\s*\{[^}]*\bapprovePlan\b[^}]*\}\s*from\s*'@\/policy\/plan-model'/s.test(read(file)),
    );
    expect(holders).toEqual(['background/task-manager.ts']);

    // And nobody reaches it sideways through a namespace import.
    const namespaced = sourceFiles().filter((file) =>
      /import\s+\*\s+as\s+\w+\s+from\s+'@\/policy\/plan-model'/.test(read(file)),
    );
    expect(namespaced).toEqual([]);
  });

  it('03 — the only caller of the producer is the plan.approve route', () => {
    const callers = sourceFiles().filter((file) => /approvePlanFor\(/.test(read(file)));
    expect(callers.filter((file) => file !== 'background/task-manager.ts')).toEqual([
      'background/service-worker.ts',
    ]);

    // And it is called from inside that route handler, not from somewhere the
    // route happens to reach.
    const worker = read('background/service-worker.ts');
    const handler = worker.slice(worker.indexOf("router.on('plan.approve'"));
    expect(handler.slice(0, 200)).toContain('approvePlanFor');
  });

  it('04 — plan.approve is control-plane, which is what restricts it to the panel', () => {
    const trust: Record<string, RouteClass> = PANEL_ROUTE_CLASSES;
    expect(trust['plan.approve']).toBe('CLASS_B_PANEL_CONTROL_PLANE');
    expect(trust['plan.revise']).toBe('CLASS_B_PANEL_CONTROL_PLANE');
  });

  it('05 — no tool, skill, connector or content module can reach the producer', () => {
    // NEGATIVE CONTROL. The model acts through tools; if a tool module could
    // import the plan model, "the model must never call approvePlan" would be
    // a convention rather than a property.
    const reachable = sourceFiles()
      .filter((file) => /^(tools|skills|connectors|content|workflows|schedules)\//.test(file))
      .filter((file) => /plan-model/.test(read(file)));
    expect(reachable).toEqual([]);
  });

  it('05b — no dynamic import reaches the plan model either', () => {
    // NEGATIVE CONTROL for case 05. A static-import census proves nothing if a
    // module can pull the producer in at call time, and `import('...')` is
    // invisible to it.
    const dynamic = sourceFiles().filter((file) =>
      /import\s*\(\s*['"`][^'"`]*plan-model/.test(read(file)),
    );
    expect(dynamic).toEqual([]);

    // And the surfaces that carry model-, page- or third-party-controlled
    // input hold no reference to the plan model at all, by any spelling.
    const surfaces = sourceFiles().filter((file) =>
      /^(tools|skills|connectors|content|workflows|schedules|providers)\//.test(file),
    );
    expect(
      surfaces.filter((file) => /plan-model|PlanApproval|approvePlan/.test(read(file))),
    ).toEqual([]);
    // The census is only worth something if it looked at something.
    expect(surfaces.length).toBeGreaterThan(20);
  });

  it('05c — an approval is bound to the task it was given for', () => {
    // NEGATIVE CONTROL. `PlanApproval.taskId` was written, stored and never
    // compared: an approval found on a task authorised that task whatever it
    // said it was for. The binding lived in where the record was kept rather
    // than in any check, so a path that copied one would have been authorised
    // by it.
    const approval = approvalFor('example.com');
    expect(parsePlanApproval(approval, 'task_1')).toEqual(approval);
    expect(parsePlanApproval(approval, 'task_2')).toBeUndefined();
    expect(parsePlanApproval({ ...approval, taskId: 'task_other' }, 'task_1')).toBeUndefined();

    // And an approval refused for the wrong task is no authorization at all,
    // not a narrower one.
    const decision = evaluatePolicy(request({ taskId: 'task_2' }), {
      ...noPlan(),
      ...planContextFor(approval, 'task_2'),
    });
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
  });

  it('06 — an approval claiming any other provenance is refused, not downgraded', () => {
    // NEGATIVE CONTROL. The single-member union is only worth something if the
    // parser enforces it on the way back out of storage.
    const genuine = approvalFor('example.com');
    expect(parsePlanApproval({ ...genuine })).toEqual(genuine);

    for (const forged of ['MODEL_PROPOSAL', 'PAGE_ACTION', 'SCHEDULED_RUN', '', null, 1]) {
      expect(parsePlanApproval({ ...genuine, approvalProvenance: forged })).toBeUndefined();
    }
    expect(APPROVAL_PROVENANCE).toBe('USER_PANEL_ACTION');
  });

  it('07 — a malformed approval is no authorization, never a weaker one', () => {
    const genuine = approvalFor('example.com');
    const broken: unknown[] = [
      null,
      'plan',
      [],
      { ...genuine, planId: '' },
      { ...genuine, version: 0 },
      { ...genuine, version: 1.5 },
      { ...genuine, approvedSites: 'example.com' },
      { ...genuine, approvedSites: ['example.com', 7] },
      { ...genuine, approvedAt: Number.NaN },
    ];
    for (const value of broken) expect(parsePlanApproval(value)).toBeUndefined();

    // And what "no authorization" means downstream: the action asks. This is
    // the half that matters — a parser that returned a stripped-down approval
    // instead of `undefined` would pass every line above and authorise here.
    expect(parsePlanApproval(broken[3])).toBeUndefined();
    const decision = evaluatePolicy(request(), noPlan());
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
    expect(decision.code).toBe('MODE_REQUIRES_APPROVAL');
  });
});

describe('TEST-SECURITY-068 group B: a plan clears nothing that refuses', () => {
  it('08 — a prohibited action is still denied on an approved site', () => {
    // NEGATIVE CONTROL. Deliberately at R2, inside what a plan can cover: a
    // prohibition at R4 would be stopped by the ceiling rather than by the
    // prohibition, and the case would prove the wrong thing.
    const decision = evaluatePolicy(
      request({ risk: 'R2', prohibited: ['financial_transaction'] }),
      context(),
    );
    expect(decision.verdict).toBe('DENY');
    expect(decision.code).toBe('PROHIBITED_ACTION');
  });

  it('09 — R5 is still denied on an approved site', () => {
    const decision = evaluatePolicy(request({ risk: 'R5' }), context());
    expect(decision.verdict).toBe('DENY');
  });

  it('10 — R4 and R3 still ask, on an approved site', () => {
    for (const risk of ['R3', 'R4'] as const) {
      const decision = evaluatePolicy(request({ risk }), context());
      expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
      expect(decision.code).toBe('RISK_REQUIRES_APPROVAL');
    }
  });

  it('11 — a blocked site is still blocked, however the plan reads', () => {
    // NEGATIVE CONTROL. The plan names `example.com`; so does the block. A
    // plan consulted before the block, or instead of it, passes everything
    // above and fails here.
    const blocked = upsertRule(emptySitePolicyState(), {
      site: 'example.com',
      decision: 'block',
      maxRisk: 'R0',
      createdAt: 1,
    });
    const decision = evaluatePolicy(request(), context({ sitePolicy: blocked }));
    expect(decision.verdict).toBe('DENY');
    expect(decision.code).toBe('SITE_BLOCKED');
  });

  it('12 — a page the browser will not automate is still refused', () => {
    const decision = evaluatePolicy(
      request({ tool: 'browser.navigate', targetUrl: 'chrome://settings' }),
      context({ planApproval: approvalFor('example.com', 'settings') }),
    );
    expect(decision.verdict).toBe('DENY');
    expect(decision.code).toBe('ORIGIN_NOT_AUTOMATABLE');
  });

  it('13 — an exfiltration block is still a denial, and a confirm still asks', () => {
    // NEGATIVE CONTROL, both halves. The destination is the approved site, so
    // a plan consulted before the egress gate would let a credential leave
    // precisely where the person said the work would happen.
    const blocked = evaluatePolicy(
      request({
        tool: 'browser.type',
        writeDestination: 'https://example.com/upload',
        writePayload: `token is ${'sk-' + 'ant-api03-abcdefghijklmnopqrstuvwxyz01'}`,
      }),
      context(),
    );
    expect(blocked.verdict).toBe('DENY');
    expect(blocked.code).toBe('EXFILTRATION_BLOCKED');

    const confirmed = evaluatePolicy(
      request({
        tool: 'browser.type',
        writeDestination: 'https://example.com/upload',
        writePayload: 'a summary of what was read',
        taintState: {
          kind: 'TAINTED',
          sources: [{ sourceType: 'page', site: 'bank.test', sensitivity: 'confidential' }],
        },
      }),
      context(),
    );
    expect(confirmed.verdict).toBe('ALLOW_WITH_CONFIRMATION');
    expect(confirmed.code).toBe('EXFILTRATION_CONFIRM');
  });

  it('14 — origin drift still asks, on an approved site', () => {
    // NEGATIVE CONTROL for G2.1 under a plan. Both URLs are on the approved
    // site; the drift is across origins within it, which is exactly the case a
    // site-granular plan would otherwise swallow.
    const decision = evaluatePolicy(
      request({
        plannedUrl: 'https://example.com/a',
        currentUrl: 'https://other.example.com/b',
      }),
      context({ planApproval: approvalFor('example.com') }),
    );
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
    expect(decision.code).toBe('ORIGIN_CHANGED');
  });

  it('15 — an unattended run does not act on a plan', () => {
    // NEGATIVE CONTROL. A scheduled firing creates its own task and so has no
    // plan to inherit; this says the same thing in the place that decides, so
    // a future path that did hand one over would still not act on it.
    //
    // At R1, deliberately. The unattended stage above only fires at R2 and up,
    // so an R2 case would be stopped by that stage and would pass just as well
    // against a plan clause that ignored `unattended` entirely — it would
    // prove the stage above and nothing about this one.
    const decision = evaluatePolicy(request({ risk: 'R1' }), context({ unattended: true }));
    expect(decision.code).not.toBe('PLAN_ALLOWED');
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');

    // And the R2 case, which the stage above stops first.
    const higher = evaluatePolicy(request({ risk: 'R2' }), context({ unattended: true }));
    expect(higher.code).toBe('UNATTENDED_REQUIRES_APPROVAL');
  });

  it('16 — the plan is consulted after every stage that can refuse', () => {
    // The structural form of cases 08-15: whatever is added to the engine
    // later, the plan stays downstream of the refusals.
    const engine = read('policy/policy-engine.ts');
    const planAt = engine.indexOf('planCoversSite(');
    expect(planAt).toBeGreaterThan(-1);
    for (const earlier of [
      "code: 'PROHIBITED_ACTION'",
      "code: 'SITE_BLOCKED'",
      "code: 'ORIGIN_NOT_AUTOMATABLE'",
      "code: 'ORIGIN_CHANGED'",
      "code: 'EXFILTRATION_BLOCKED'",
      "code: 'EXFILTRATION_CONFIRM'",
      "'RISK_REQUIRES_APPROVAL'",
      "'UNATTENDED_REQUIRES_APPROVAL'",
    ]) {
      expect(engine.indexOf(earlier), earlier).toBeLessThan(planAt);
    }
  });

  it('17 — the workspace boundary is checked before policy is evaluated at all', () => {
    // The plan lives inside `evaluatePolicy`. A tab outside the task's
    // workspace never reaches it, so the boundary is not something the plan
    // path has to re-implement — it is something it cannot get past.
    const registry = read('tools/registry/tool-registry.ts');
    expect(registry.indexOf('checkWorkspaceMember')).toBeLessThan(
      registry.indexOf('evaluatePolicy('),
    );
  });
});

describe('TEST-SECURITY-068 group C: what a plan does clear, and how far', () => {
  it('18 — an ordinary action on an approved site runs without asking', () => {
    const decision = evaluatePolicy(request({ risk: 'R1' }), context());
    expect(decision.verdict).toBe('ALLOW');
    expect(decision.code).toBe('PLAN_ALLOWED');
  });

  it('19 — the same action without a plan asks', () => {
    // The control that makes case 18 mean something. Same request, same mode,
    // no plan: Manual confirms every changing action, which is what Cowork is.
    const decision = evaluatePolicy(request({ risk: 'R1' }), noPlan());
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
    expect(decision.code).toBe('MODE_REQUIRES_APPROVAL');
  });

  it('20 — R3 and above are bounded by the floor, which returns before the plan', () => {
    expect(evaluatePolicy(request({ risk: 'R2' }), context()).code).toBe('PLAN_ALLOWED');
    expect(evaluatePolicy(request({ risk: 'R3' }), context()).code).toBe('RISK_REQUIRES_APPROVAL');

    // Said precisely, because the alternative reading is flattering and wrong.
    // `PLAN_MAX_RISK` is not what stops an R3 action: the floor at stage 5 has
    // already returned by the time the plan is consulted, so the ceiling is a
    // restatement of a bound rather than the bound itself. Removing the
    // ceiling today changes no answer.
    //
    // What makes the restatement equivalent is that the two constants are
    // adjacent — no risk level sits between the highest a plan covers and the
    // lowest that always confirms. If somebody raised the floor without
    // raising the ceiling, the ceiling would start to bind and this would say
    // so; if they raised both, it would say that too.
    expect(PLAN_MAX_RISK).toBe('R2');
    expect(RISK_RANK[ALWAYS_CONFIRM_AT]).toBe(RISK_RANK[PLAN_MAX_RISK] + 1);
    // And it is the same ceiling a standing site grant has, because a plan is
    // the same authorization with a shorter life.
    expect(clampToGrantable('R3')).toBe(PLAN_MAX_RISK);
  });

  it('21 — a site the plan does not name still asks', () => {
    // NEGATIVE CONTROL. Without this, a plan that authorised everything would
    // pass every case above.
    const decision = evaluatePolicy(
      request({ siteScope: 'https://elsewhere.test/page' }),
      context(),
    );
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
  });

  it('22 — coverage is the registrable domain, and nothing that merely looks like it', () => {
    const approval = approvalFor('example.com');
    expect(planCoversSite(approval, 'https://www.example.com/deep/path')).toBe(true);
    expect(planCoversSite(approval, 'http://example.com/')).toBe(true);
    // The three shapes that read as `example.com` and are not.
    expect(planCoversSite(approval, 'https://example.com.attacker.test/')).toBe(false);
    expect(planCoversSite(approval, 'https://notexample.com/')).toBe(false);
    expect(planCoversSite(approval, 'https://example.co/')).toBe(false);
  });

  it('23 — a call with no established scope is not covered by any plan', () => {
    // NEGATIVE CONTROL. An absent scope means the worker could not establish
    // which site this call is on. That is never evidence the plan allows it.
    const decision = evaluatePolicy(noScope(), context());
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
  });

  it('24 — an unparseable scope is not covered either', () => {
    expect(planCoversSite(approvalFor('example.com'), 'not a url')).toBe(false);
    expect(planCoversSite(undefined, 'https://example.com/')).toBe(false);
    const decision = evaluatePolicy(request({ siteScope: 'javascript:void 0' }), context());
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
  });

  it('25 — a plan authorises a task, not a mode: Skip is unchanged by one', () => {
    // Skip already allows below R3 and still stops at the floor. A plan must
    // not move either boundary, in either direction.
    const withPlan = evaluatePolicy(request({ risk: 'R2' }), context({ mode: 'skip' }));
    const without = evaluatePolicy(request({ risk: 'R2' }), noPlan({ mode: 'skip' }));
    expect(withPlan.verdict).toBe('ALLOW');
    expect(without.verdict).toBe('ALLOW');
    expect(evaluatePolicy(request({ risk: 'R3' }), context({ mode: 'skip' })).verdict).toBe(
      'ALLOW_WITH_CONFIRMATION',
    );
  });
});

describe('TEST-SECURITY-068 group D: amendment stays narrower than a grant', () => {
  it('26 — an amendment is a new version, and the old one is named', () => {
    const first = approvalFor('example.com');
    const second = amendPlan(first, 'https://other.test/page', 3_000);
    expect(second.version).toBe(2);
    expect(second.approvedSites).toEqual(['example.com', 'other.test']);
    expect(second.supersedes).toBe('plan_1@1');
    // The previous version is untouched, so "what was authorised when this ran"
    // stays answerable.
    expect(first.approvedSites).toEqual(['example.com']);
    expect(first.version).toBe(1);
  });

  it('27 — a version never advances without a real change', () => {
    // NEGATIVE CONTROL. A version that moved on every prompt would make the
    // trail unreadable, and `supersedes` would name a version that authorised
    // exactly the same thing.
    const approval = approvalFor('example.com');
    expect(amendPlan(approval, 'https://www.example.com/x', 3_000)).toBe(approval);
    expect(amendPlan(approval, '   ', 3_000)).toBe(approval);
    expect(amendPlan(approval, 'not a url at all !!', 3_000)).toBe(approval);
  });

  it('28 — "allow for this task" writes no standing site rule', async () => {
    // NEGATIVE CONTROL, and the one that separates the two answers. A plan
    // amendment that quietly wrote a `SiteRule` would outlive its task, and
    // would be indistinguishable from "always allow" to everything downstream.
    const harness = permissionHarness({ kind: 'approve_task' });
    const outcome = await harness.run();

    expect(outcome.granted).toBe(true);
    expect(harness.amended).toEqual([['task_1', 'example.com']]);
    expect((await harness.sitePolicy()).rules).toEqual([]);
  });

  it('29 — "always allow" does write one', async () => {
    // The discriminating half of case 28. Without it, a build that wrote
    // nothing for either answer would pass.
    const harness = permissionHarness({ kind: 'approve_site', maxRisk: 'R2' });
    const outcome = await harness.run();

    expect(outcome.granted).toBe(true);
    expect(harness.amended).toEqual([]);
    expect((await harness.sitePolicy()).rules.map((rule) => rule.site)).toEqual(['example.com']);
  });

  it('30 — "allow for this task" on a task with no plan approves once and widens nothing', async () => {
    // The amendment hook is absent, which is what the worker's implementation
    // amounts to for a task that never planned: there is no approval to amend.
    const harness = permissionHarness({ kind: 'approve_task' }, { amendPlan: false });
    const outcome = await harness.run();

    expect(outcome.granted).toBe(true);
    expect((await harness.sitePolicy()).rules).toEqual([]);
  });

  it('31 — an amendment that fails does not fail the action a person approved', async () => {
    const harness = permissionHarness({ kind: 'approve_task' }, { amendThrows: true });
    const outcome = await harness.run();
    // Approved once, nothing widened. Refusing here would decline what the
    // person just allowed because a record could not be updated.
    expect(outcome.granted).toBe(true);
    expect((await harness.sitePolicy()).rules).toEqual([]);
  });
});

describe('TEST-SECURITY-068 group E: a plan lives and dies with its task', () => {
  it('32 — an approval is never accepted from an imported file', () => {
    // NEGATIVE CONTROL. An imported approval would be a file deciding which
    // sites this installation may act on without asking.
    expect(TASK_FIELD_PORTABILITY.planApproval).toBe('SECURITY_SENSITIVE');
    expect(NEVER_CROSSES_INSTALLATION_BOUNDARY).toContain('planApproval');
    expect(TASK_FIELD_PORTABILITY.authorizationModel).toBe('SECURITY_SENSITIVE');
    expect(TASK_FIELD_PORTABILITY.planProposal).toBe('NOT_PORTABLE_BY_DESIGN');
  });

  it('33 — and task records do not cross the boundary at all', () => {
    expect(EXPORT_PORTABILITY.task).toBe('REQUIRES_FURTHER_SECURITY_DESIGN');
  });

  it('33b — the approval is never carried to a provider, a connector or a sync', () => {
    // Three surfaces, each checked where it is actually decided rather than by
    // reading a policy statement about it.
    //
    // Provider: the request built for a turn is constructed from the task, so
    // the only real check is what comes out of the builder.
    const task = {
      ...createTask({
        id: 'task_1',
        sessionId: 's1',
        objective: 'Do the thing',
        providerId: 'p',
        modelId: 'm',
        permissionMode: 'manual' as const,
        now: 1,
        taintSalt: 'ab'.repeat(32),
      }),
      planApproval: approvalFor('example.com'),
    };
    const built = buildRequest({
      task,
      messages: [{ role: 'user', content: [{ type: 'text', text: task.objective }] }],
      tools: [],
      hasVision: false,
    });
    const wire = JSON.stringify(built);
    expect(wire).not.toContain(APPROVAL_PROVENANCE);
    expect(wire).not.toContain('plan_1');
    expect(wire).not.toContain('approvedSites');
    // The control: the request is not empty, so the absence above means
    // something.
    expect(wire).toContain('Do the thing');

    // Connector: what a connector tool is handed is a closed struct of four
    // taint fields. A record that is not in the type cannot be read from it.
    const registry = read('tools/registry/tool-registry.ts');
    const published = registry.slice(
      registry.indexOf('readonly publishSecurityContext?:'),
      registry.indexOf('readonly publishSecurityContext?:') + 400,
    );
    expect(published).toContain('taintState');
    expect(published).not.toMatch(/plan|task:/i);

    // Sync and export: the task kind does not cross the boundary at all, so
    // there is no stripping step that could be skipped.
    expect(EXPORT_PORTABILITY.task).toBe('REQUIRES_FURTHER_SECURITY_DESIGN');
    expect(PORTABLE_DATA_KINDS).not.toContain('task');
  });

  it('33c — the approval is local state, held where the task is held', () => {
    // K1 covers credentials; a task record — objective, steps, and now the
    // plan — is the user's own work and is readable while locked so the panel
    // can list it. Stated here because "never encrypted" and "never leaves the
    // device" are different claims, and only the second one is made.
    expect(K1_PROTECTION.task).toBe('PLAINTEXT_BY_DESIGN');
    expect(DATA_CLASSIFICATION.task).toBe('USER_SELECTABLE');
  });

  it('34 — the approval is stored on the task, which is what scopes it', () => {
    // Said structurally because it is the whole lifetime argument: a plan in
    // the site policy would outlive its task; a plan on the task cannot.
    const model = read('tasks/task-model.ts');
    expect(model).toMatch(/readonly planApproval\?: PlanApproval;/);
    const sitePolicy = read('policy/site-policy.ts');
    expect(sitePolicy).not.toMatch(/planApproval/);
  });

  it('35 — approving copies the sites rather than holding the proposal’s array', () => {
    const proposal = buildProposal({
      proposalId: 'prop_1',
      taskId: 'task_1',
      approachText: 'x',
      sites: ['example.com'],
      now: 1,
    });
    const approval = approvePlan(proposal, 'plan_1', 2);
    (proposal.proposedSites as string[]).push('attacker.test');
    expect(approval.approvedSites).toEqual(['example.com']);
    expect(planCoversSite(approval, 'https://attacker.test/')).toBe(false);
  });

  it('36 — the approach text is carried for a person and never for policy', () => {
    const approval = approvalFor('example.com');
    // There is no approach on the approval at all, so no decision can read one.
    expect(Object.keys(approval)).not.toContain('approachText');
    expect(read('policy/policy-engine.ts')).not.toMatch(/approachText/);
  });

  it('36b — an earlier version cannot authorise what a later one narrowed', () => {
    // Replay. Versions are separate immutable objects, so holding version 1
    // after version 2 exists authorises version 1's sites and no others — it
    // cannot reach forward, and it cannot be used to widen version 2.
    const first = approvalFor('example.com');
    const second = amendPlan(first, 'https://other.test/', 3_000);

    expect(planCoversSite(first, 'https://other.test/')).toBe(false);
    expect(planCoversSite(second, 'https://other.test/')).toBe(true);
    // And version 1 is unchanged by the existence of version 2.
    expect(first.approvedSites).toEqual(['example.com']);
    expect(second.version).toBeGreaterThan(first.version);
  });

  it('36c — an amendment adds and never removes or replaces', () => {
    // NEGATIVE CONTROL. A "narrowing" amendment would be a silent revocation
    // that the version trail would report as an ordinary widening.
    let approval = approvalFor('a.test', 'b.test');
    for (const site of ['c.test', 'a.test', 'd.test']) {
      approval = amendPlan(approval, `https://${site}/`, 4_000);
    }
    expect(approval.approvedSites).toEqual(['a.test', 'b.test', 'c.test', 'd.test']);
    // Three requests, one of them already covered: two real changes.
    expect(approval.version).toBe(3);
  });

  it('36d — reading a stored approval back never mints a new one', () => {
    // A worker restart re-reads the record; it must not produce a different
    // approval, a later version, or a fresh timestamp.
    const approval = amendPlan(approvalFor('example.com'), 'https://other.test/', 3_000);
    const reread = parsePlanApproval(approval, 'task_1');
    expect(reread).toEqual(approval);
    expect(reread?.version).toBe(2);
    expect(reread?.supersedes).toBe('plan_1@1');
  });

  it('37 — a proposal is normalised and bounded before anyone is asked to approve it', () => {
    const proposal = buildProposal({
      proposalId: 'prop_1',
      taskId: 'task_1',
      approachText: 'x'.repeat(5_000),
      sites: [
        'https://www.example.com/deep/path',
        'EXAMPLE.com',
        '   ',
        'not a site at all !!',
        ...Array.from({ length: 40 }, (_, index) => `site${index}.test`),
      ],
      now: 1,
    });
    expect(proposal.proposedSites.length).toBeLessThanOrEqual(MAX_PROPOSED_SITES);
    // The duplicate collapsed, the junk was dropped, and the survivors are
    // keys a `SiteRule` would recognise.
    expect(proposal.proposedSites.filter((site) => site === 'example.com')).toHaveLength(1);
    expect(proposal.proposedSites).not.toContain('');
    expect(proposal.approachText.length).toBeLessThanOrEqual(2_000);
  });
});

// ---------------------------------------------------------------------------

/** Every `.ts`/`.tsx` file under `src`, as a path relative to it. */
function sourceFiles(): string[] {
  const walk = (dir: string, prefix: string): string[] =>
    readdirSync(join(SRC_ROOT, dir === '' ? '.' : dir), { withFileTypes: true }).flatMap(
      (entry) => {
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) return walk(relative, relative);
        return /\.tsx?$/.test(entry.name) ? [relative] : [];
      },
    );
  return walk('', '').sort();
}

/**
 * The real `PermissionEngine`, with a real site-policy store behind it.
 *
 * The point of the group D cases is what gets *written*, so nothing about the
 * writing is stubbed: what is scripted is the person's answer.
 */
function permissionHarness(
  response: PermissionResponse,
  options: { amendPlan?: boolean; amendThrows?: boolean } = {},
) {
  const area = new SerializedStorageArea(new MemoryStorageArea());
  const amended: [string, string][] = [];
  const loadSitePolicy = async (): Promise<SitePolicyState> =>
    (await area.get<SitePolicyState>('site-policy')) ?? emptySitePolicyState();

  const engine = new PermissionEngine({
    prompter: new ScriptedPrompter(response),
    loadSitePolicy,
    saveSitePolicy: (state) => area.set('site-policy', state),
    ...(options.amendPlan === false
      ? {}
      : {
          amendPlan: (taskId: string, site: string) => {
            if (options.amendThrows) return Promise.reject(new Error('storage is unavailable'));
            amended.push([taskId, site]);
            return Promise.resolve();
          },
        }),
  });

  return {
    amended,
    sitePolicy: loadSitePolicy,
    run: () =>
      engine.requestApproval({
        taskId: 'task_1',
        tool: 'browser.click',
        summary: 'browser.click',
        siteScopeUrl: 'https://example.com/page',
        decision: {
          verdict: 'ALLOW_WITH_CONFIRMATION',
          code: 'MODE_REQUIRES_APPROVAL',
          reason: 'Manual mode.',
          effectiveRisk: 'R1',
        },
      }),
  };
}
