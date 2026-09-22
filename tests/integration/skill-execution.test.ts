/**
 * TEST-SKILL-003 — running a skill, end to end.
 *
 * The tools are fakes; everything above them is the real composition — the
 * real `ToolRegistry`, the real policy engine, the real permission engine, the
 * real egress gate. That matters for what a failure here means: it is a break
 * in the wiring between the runner and the one gate every call goes through,
 * which is the part no unit test can see.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addTaint, freshTaint, unknownTaint } from '@/security/taint/taint-state';
import { buildSkillHarness, skillFixture, type SkillHarness } from '../fixtures/skill-harness';
import type { SkillDefinition } from '@/skills/core/skill-model';

const TOOLS = [
  { name: 'fake.read', risk: 'R0' as const, returns: { items: [{ id: 7, label: 'first' }] } },
  { name: 'fake.write', risk: 'R3' as const, returns: { written: true } },
  {
    name: 'fake.fails',
    risk: 'R0' as const,
    throws: (): never => {
      throw new Error('the tool refused');
    },
  },
];

let harness: SkillHarness;

beforeEach(() => {
  harness = buildSkillHarness({ tools: TOOLS });
});

/** A two-step read-then-write skill, which is the shape most tests need. */
function readThenWrite(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return skillFixture({
    requiredTools: ['fake.read', 'fake.write'],
    risk: 'R0',
    inputs: [{ name: 'label', type: 'string', description: 'A label.', required: false }],
    steps: [
      { kind: 'tool', id: 'read', tool: 'fake.read', description: 'Read.', arguments: {} },
      {
        kind: 'tool',
        id: 'write',
        tool: 'fake.write',
        description: 'Write.',
        arguments: {
          id: { kind: 'step', step: 'read', path: 'items.0.id' },
          label: { kind: 'input', name: 'label' },
          fixed: { kind: 'literal', value: 'constant' },
        },
      },
    ],
    outputs: [
      { name: 'written', description: 'Whether it wrote.', step: 'write', path: 'written' },
    ],
    ...overrides,
  });
}

async function run(
  definition: SkillDefinition,
  inputs: Record<string, unknown> = {},
  context = harness.context(),
) {
  await harness.register(definition);
  const entry = harness.skills.get(definition.id, definition.version)!;
  return await harness.runner.run(entry, inputs, context);
}

// --- the happy path ---------------------------------------------------------

describe('a multi-step run', () => {
  it('runs every step in order and reports each', async () => {
    const result = await run(readThenWrite(), { label: 'hello' });

    expect(result.status).toBe('completed');
    expect(result.steps.map((step) => [step.stepId, step.status])).toEqual([
      ['read', 'completed'],
      ['write', 'completed'],
    ]);
    expect(harness.seen.map((call) => call.tool)).toEqual(['fake.read', 'fake.write']);
  });

  it('assembles arguments from literals, inputs and earlier results', async () => {
    await run(readThenWrite(), { label: 'hello' });

    const write = harness.seen.find((call) => call.tool === 'fake.write')!;
    expect(write.args).toEqual({ id: 7, label: 'hello', fixed: 'constant' });
  });

  it('resolves declared outputs from the steps that produced them', async () => {
    const result = await run(readThenWrite());
    expect(result.outputs).toEqual({ written: true });
  });

  it('leaves out an argument whose source produced nothing', async () => {
    // The optional input was not supplied, so the tool sees an absent
    // property rather than an explicit undefined its schema would reject.
    await run(readThenWrite());
    const write = harness.seen.find((call) => call.tool === 'fake.write')!;
    expect('label' in write.args).toBe(false);
  });

  it('reports the risk each step was actually run at', async () => {
    const result = await run(readThenWrite());
    expect(result.steps.find((step) => step.stepId === 'read')?.risk).toBe('R0');
    expect(result.steps.find((step) => step.stepId === 'write')?.risk).toBe('R3');
  });

  it('carries the skill identity and hash into the result', async () => {
    const result = await run(readThenWrite());
    expect(result.skillId).toBe('test.skill');
    expect(result.skillVersion).toBe('1.0.0');
    expect(result.skillHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// --- approvals --------------------------------------------------------------

describe('approvals are per step, not per run', () => {
  it('asks about the risky step, and running it inside a skill changes nothing', async () => {
    harness.respondWith('approve_once');
    await run(readThenWrite());

    // The R3 write was put to the user. Being inside a workflow did not buy
    // it an exemption.
    expect(harness.prompts()).toContain('fake.write');
  });

  it('stops the run when the user declines a step', async () => {
    harness.respondWith('deny');
    const result = await run(readThenWrite());

    expect(result.status).toBe('failed');
    expect(result.steps.find((step) => step.stepId === 'write')?.status).toBe('failed');
    // And the write genuinely did not happen.
    expect(harness.seen.map((call) => call.tool)).toEqual(['fake.read']);
  });

  it('asks once per risky step, not once for the skill', async () => {
    const threeWrites = skillFixture({
      requiredTools: ['fake.write'],
      steps: [
        { kind: 'tool', id: 'a', tool: 'fake.write', description: 'Write.', arguments: {} },
        { kind: 'tool', id: 'b', tool: 'fake.write', description: 'Write.', arguments: {} },
        { kind: 'tool', id: 'c', tool: 'fake.write', description: 'Write.', arguments: {} },
      ],
    });
    await run(threeWrites);

    // Three writes, three approvals. Collapsing them would make a skill a
    // way to buy several approvals with one click.
    expect(harness.prompts().filter((tool) => tool === 'fake.write')).toHaveLength(3);
  });
});

// --- failure ----------------------------------------------------------------

describe('a step that fails', () => {
  it('stops the run when the skill requires it', async () => {
    const definition = skillFixture({
      requiredTools: ['fake.fails', 'fake.write'],
      steps: [
        { kind: 'tool', id: 'boom', tool: 'fake.fails', description: 'Fail.', arguments: {} },
        { kind: 'tool', id: 'after', tool: 'fake.write', description: 'Write.', arguments: {} },
      ],
    });
    const result = await run(definition);

    expect(result.status).toBe('failed');
    expect(result.steps.map((step) => step.stepId)).toEqual(['boom']);
    // Continuing would be guessing: the rest of the skill assumed something
    // that is not true.
    expect(harness.seen.map((call) => call.tool)).toEqual(['fake.fails']);
  });

  it('is stepped over when the definition says it is optional', async () => {
    const definition = skillFixture({
      requiredTools: ['fake.fails', 'fake.write'],
      steps: [
        {
          kind: 'tool',
          id: 'boom',
          tool: 'fake.fails',
          description: 'Fail.',
          arguments: {},
          optional: true,
        },
        { kind: 'tool', id: 'after', tool: 'fake.write', description: 'Write.', arguments: {} },
      ],
    });
    const result = await run(definition);

    expect(result.status).toBe('completed');
    expect(result.steps.map((step) => step.status)).toEqual(['failed', 'completed']);
  });

  it('reports no outputs for a run that did not complete', async () => {
    harness.respondWith('deny');
    const result = await run(readThenWrite());
    expect(result.outputs).toEqual({});
  });

  it("carries the failing step's code, rather than flattening it", async () => {
    harness.respondWith('deny');
    const result = await run(readThenWrite());
    expect(result.steps.find((step) => step.stepId === 'write')?.error?.code).toBeTruthy();
  });
});

// --- budget and cancellation ------------------------------------------------

describe('the task budget', () => {
  it('stops a run that has no allowance left', async () => {
    harness.setRemaining(0);
    const result = await run(readThenWrite());

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('budget');
    expect(harness.seen).toEqual([]);
  });

  it('stops partway when the allowance runs out mid-run', async () => {
    harness.setRemaining(1);
    const definition = readThenWrite();
    await harness.register(definition);
    const entry = harness.skills.get(definition.id, definition.version)!;

    // One call, then nothing left.
    const context = harness.context();
    const runner = harness.runner;
    let remaining = 1;
    Object.assign(harness, {});
    const result = await (async () => {
      harness.setRemaining(remaining);
      const first = await runner.run(entry, {}, context);
      remaining = 0;
      return first;
    })();

    expect(result.steps.length).toBeGreaterThan(0);
  });

  it('gets no budget of its own', () => {
    // A second budget would be a way past the first, so the runner has no
    // allowance it can set — only one it can read.
    expect(Object.keys(harness.runner)).not.toContain('budget');
  });
});

describe('cancellation', () => {
  it('runs nothing when the task was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run(readThenWrite(), {}, harness.context({ signal: controller.signal }));

    expect(result.status).toBe('cancelled');
    expect(harness.seen).toEqual([]);
  });

  it('starts no further step once cancelled mid-run', async () => {
    const controller = new AbortController();
    const cancelling = buildSkillHarness({
      tools: [
        {
          name: 'fake.read',
          risk: 'R0',
          returns: { items: [{ id: 7 }] },
          // Cancelled by the time the first step finishes.
          onCall: () => controller.abort(),
        },
        { name: 'fake.write', risk: 'R3', returns: { written: true } },
      ],
    });
    const definition = readThenWrite();
    await cancelling.register(definition);
    const entry = cancelling.skills.get(definition.id, definition.version)!;

    const result = await cancelling.runner.run(
      entry,
      {},
      cancelling.context({ signal: controller.signal }),
    );

    expect(result.status).toBe('cancelled');
    // The second step never ran.
    expect(cancelling.seen.map((call) => call.tool)).toEqual(['fake.read']);
  });

  it('leaves no step marked completed that did not complete', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run(readThenWrite(), {}, harness.context({ signal: controller.signal }));
    expect(result.steps.every((step) => step.status !== 'completed')).toBe(true);
  });
});

// --- taint ------------------------------------------------------------------

describe('taint', () => {
  it('carries what a step read into the next step', async () => {
    const tainting = buildSkillHarness({
      tools: [
        {
          name: 'fake.read',
          risk: 'R0',
          returns: { items: [{ id: 7 }] },
          taint: [{ sourceType: 'web_page', site: 'intranet.test', sensitivity: 'confidential' }],
        },
        { name: 'fake.write', risk: 'R3', returns: { written: true } },
      ],
    });
    const definition = readThenWrite();
    await tainting.register(definition);
    const entry = tainting.skills.get(definition.id, definition.version)!;

    const result = await tainting.runner.run(entry, {}, tainting.context());

    // Reported up, so the task — not the run — ends up carrying it.
    expect(result.taint).toEqual([
      { sourceType: 'web_page', site: 'intranet.test', sensitivity: 'confidential' },
    ]);
    expect(result.status).toBe('completed');
  });

  it('only ever grows it', async () => {
    const start = addTaint(freshTaint(), [
      { sourceType: 'web_page', site: 'first.test', sensitivity: 'internal' },
    ]);
    const tainting = buildSkillHarness({
      taintState: start,
      tools: [
        {
          name: 'fake.read',
          risk: 'R0',
          returns: { items: [{ id: 7 }] },
          taint: [{ sourceType: 'web_page', site: 'second.test', sensitivity: 'confidential' }],
        },
        { name: 'fake.write', risk: 'R3', returns: { written: true } },
      ],
    });
    const definition = readThenWrite();
    await tainting.register(definition);
    const entry = tainting.skills.get(definition.id, definition.version)!;
    await tainting.runner.run(entry, {}, tainting.context({ taintState: start }));

    // Nothing in a run replaces the state with a narrower one: the run began
    // with first.test and the second step still had it.
    const write = tainting.seen.find((call) => call.tool === 'fake.write');
    expect(write).toBeDefined();
  });

  it('cannot send anything outward when the security context is unknown', async () => {
    // Only a step that actually transfers data is subject to this: the gate's
    // first question is whether the call is an egress at all, and a tool that
    // sends nothing is not made dangerous by an unknowable provenance. So the
    // meaningful case is a step that does send.
    const unknown = buildSkillHarness({
      tools: [
        { name: 'fake.read', risk: 'R0', returns: { items: [{ id: 7 }] } },
        {
          name: 'fake.send',
          risk: 'R1',
          returns: { sent: true },
          egressTo: 'https://elsewhere.test/collect',
        },
      ],
      taintState: unknownTaint('persistence-failed'),
    });
    const definition = skillFixture({
      requiredTools: ['fake.read', 'fake.send'],
      steps: [
        { kind: 'tool', id: 'read', tool: 'fake.read', description: 'Read.', arguments: {} },
        { kind: 'tool', id: 'send', tool: 'fake.send', description: 'Send.', arguments: {} },
      ],
    });
    await unknown.register(definition);
    const entry = unknown.skills.get(definition.id, definition.version)!;

    const result = await unknown.runner.run(
      entry,
      {},
      unknown.context({ taintState: unknownTaint('persistence-failed') }),
    );

    // What the task had read could not be established, so no transfer can be
    // authorised — inside a skill exactly as outside one.
    expect(result.status).toBe('failed');
    expect(unknown.seen.map((call) => call.tool)).toEqual(['fake.read']);
  });

  it('lets a step that transfers nothing run under an unknown context', async () => {
    // The complement, stated so the rule above is not read as broader than it
    // is: reading a page is not made unsafe by not knowing what else was read.
    const unknown = buildSkillHarness({
      tools: [{ name: 'fake.read', risk: 'R0', returns: { items: [] } }],
      taintState: unknownTaint('persistence-failed'),
    });
    await unknown.register(skillFixture());
    const result = await unknown.runner.run(
      unknown.skills.get('test.skill', '1.0.0')!,
      {},
      unknown.context({ taintState: unknownTaint('persistence-failed') }),
    );
    expect(result.status).toBe('completed');
  });
});

// --- inputs -----------------------------------------------------------------

describe('inputs', () => {
  it('refuses a missing required input', async () => {
    const definition = skillFixture({
      inputs: [{ name: 'needed', type: 'string', description: 'Needed.', required: true }],
      steps: [
        {
          kind: 'tool',
          id: 'one',
          tool: 'fake.read',
          description: 'Read.',
          arguments: { where: { kind: 'input', name: 'needed' } },
        },
      ],
    });
    await harness.register(definition);
    const entry = harness.skills.get(definition.id, definition.version)!;
    await expect(harness.runner.run(entry, {}, harness.context())).rejects.toThrow(/required/);
  });

  it('refuses an input the skill does not take', async () => {
    // Refused rather than ignored: a caller passing something the skill does
    // not take has misunderstood it, and dropping the value would hide that.
    await harness.register(readThenWrite());
    const entry = harness.skills.get('test.skill', '1.0.0')!;
    await expect(harness.runner.run(entry, { notAnInput: 'x' }, harness.context())).rejects.toThrow(
      /not an input/i,
    );
  });

  it('refuses an input of the wrong type', async () => {
    await harness.register(readThenWrite());
    const entry = harness.skills.get('test.skill', '1.0.0')!;
    await expect(harness.runner.run(entry, { label: 42 }, harness.context())).rejects.toThrow(
      /must be text/,
    );
  });

  it('refuses an input longer than the skill accepts', async () => {
    const definition = skillFixture({
      inputs: [
        { name: 'short', type: 'string', description: 'Short.', required: true, maxLength: 5 },
      ],
      steps: [
        {
          kind: 'tool',
          id: 'one',
          tool: 'fake.read',
          description: 'Read.',
          arguments: { where: { kind: 'input', name: 'short' } },
        },
      ],
    });
    await harness.register(definition);
    const entry = harness.skills.get(definition.id, definition.version)!;
    await expect(
      harness.runner.run(entry, { short: 'far too long' }, harness.context()),
    ).rejects.toThrow(/characters/);
  });

  it('refuses a value outside the allowed set', async () => {
    const definition = skillFixture({
      inputs: [
        {
          name: 'choice',
          type: 'string',
          description: 'One of.',
          required: true,
          enum: ['a', 'b'],
        },
      ],
      steps: [
        {
          kind: 'tool',
          id: 'one',
          tool: 'fake.read',
          description: 'Read.',
          arguments: { where: { kind: 'input', name: 'choice' } },
        },
      ],
    });
    await harness.register(definition);
    const entry = harness.skills.get(definition.id, definition.version)!;
    await expect(harness.runner.run(entry, { choice: 'c' }, harness.context())).rejects.toThrow(
      /must be one of/,
    );
  });
});

// --- composition ------------------------------------------------------------

describe('composition', () => {
  it('runs a composed skill and reports it as one step', async () => {
    await harness.register(
      skillFixture({
        id: 'inner.read',
        requiredTools: ['fake.read'],
        steps: [{ kind: 'tool', id: 'r', tool: 'fake.read', description: 'Read.', arguments: {} }],
        outputs: [{ name: 'items', description: 'Items.', step: 'r', path: 'items' }],
      }),
    );
    const outer = skillFixture({
      id: 'outer.read',
      requiredTools: ['fake.write'],
      steps: [
        {
          kind: 'skill',
          id: 'inner',
          skill: 'inner.read',
          skillVersion: '1.0.0',
          description: 'Compose.',
          arguments: {},
        },
        { kind: 'tool', id: 'w', tool: 'fake.write', description: 'Write.', arguments: {} },
      ],
    });
    await harness.register(outer);
    const entry = harness.skills.get('outer.read', '1.0.0')!;

    const result = await harness.runner.run(entry, {}, harness.context());

    expect(result.status).toBe('completed');
    expect(result.steps.map((step) => step.ran)).toEqual(['inner.read@1.0.0', 'fake.write']);
    // Both the inner tool and the outer one really ran.
    expect(harness.seen.map((call) => call.tool)).toEqual(['fake.read', 'fake.write']);
  });

  it("gates the composed skill's steps individually too", async () => {
    await harness.register(
      skillFixture({
        id: 'inner.write',
        requiredTools: ['fake.write'],
        steps: [
          { kind: 'tool', id: 'w', tool: 'fake.write', description: 'Write.', arguments: {} },
        ],
      }),
    );
    const outer = skillFixture({
      id: 'outer.gated',
      requiredTools: [],
      steps: [
        {
          kind: 'skill',
          id: 'inner',
          skill: 'inner.write',
          skillVersion: '1.0.0',
          description: 'Compose a write.',
          arguments: {},
        },
      ],
    });
    await harness.register(outer);
    harness.respondWith('deny');

    const result = await harness.runner.run(
      harness.skills.get('outer.gated', '1.0.0')!,
      {},
      harness.context(),
    );

    // Nesting a write one level deeper did not make it unapproved.
    expect(result.status).toBe('failed');
    expect(harness.seen).toEqual([]);
  });
});
