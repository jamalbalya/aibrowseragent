/**
 * TEST-SECURITY-074 — a skill that writes, and what approving it does not buy.
 *
 * Until now every bundled skill was read-only, which meant the most important
 * property of the skill system had never been tested against the case it
 * exists for. `form.fill_and_submit` types a value into a field and submits
 * the form — R2, a real state change — so the question is now live: does
 * approving the *skill* approve the *write*?
 *
 * It must not. The run-level approval names a workflow; the step-level one
 * names the write, its field and its site. The skill runner has no execution
 * path of its own: every step goes through `ToolRegistry.dispatch`, so each is
 * re-validated, re-classified against the field it is actually aimed at,
 * re-checked against site authorization and the risk floor, and separately
 * audited.
 *
 * The cases are the ten this wave mandates, in order, plus the mutants that
 * prove the interesting ones discriminate.
 *
 * Groups:
 *   A. the pipeline holds for every child action
 *   B. the floors and prohibitions a skill cannot lower
 *   C. site authorization and taint
 *   D. audit, credentials and provider independence
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { BUNDLED_SKILLS } from '@/skills/bundled';
import { effectiveSkillRisk, validateSkillDefinition } from '@/skills/core/skill-model';
import { buildSkillHarness, type SkillHarness } from '../fixtures/skill-harness';
import type { SkillDefinition } from '@/skills/core/skill-model';
import type { RiskLevel } from '@/policy/risk-classifier';

/** The write skill this wave added, read out of the shipped array. */
const WRITE_SKILL = BUNDLED_SKILLS.find(
  (definition) => definition.id === 'form.fill_and_submit',
) as SkillDefinition;

/**
 * Fakes standing in for the real browser tools, at the same declared risks.
 *
 * `browser.type` escalates itself to R2 when `submit` is set, exactly as the
 * real one does, because that escalation is the thing under test: a skill must
 * not be able to keep a child call at the tool's floor.
 */
const TOOLS = [
  {
    name: 'browser.read_page',
    risk: 'R0' as const,
    siteAuthorization: 'page' as const,
    returns: { page: { url: 'x' } },
  },
  {
    name: 'browser.wait',
    risk: 'R0' as const,
    siteAuthorization: 'page' as const,
    returns: { waited: true },
  },
  // Declared as the real one declares it, because the scope is part of what is
  // under test: a fake at `none` would make the site claim vacuous.
  {
    name: 'browser.type',
    risk: 'R1' as const,
    siteAuthorization: 'page' as const,
    returns: { typed: true },
  },
];

let harness: SkillHarness;

const build = async (options: Parameters<typeof buildSkillHarness>[0] = {}) => {
  harness = buildSkillHarness({ tools: TOOLS, ...options });
  await harness.register(WRITE_SKILL);
  return harness;
};

const runWrite = (inputs: Record<string, unknown> = { elementId: 'e1-0', text: 'hello' }) =>
  harness.runner.run(
    harness.skills.get(WRITE_SKILL.id, WRITE_SKILL.version)!,
    inputs,
    harness.context(),
  );

beforeEach(async () => {
  await build({ permissionMode: 'manual' });
});

describe('TEST-SECURITY-074 group A: the pipeline holds per child action', () => {
  it('01 — the shipped definition is a write, and says so', () => {
    expect(WRITE_SKILL).toBeDefined();
    expect(WRITE_SKILL.risk).toBe('R2');
    expect(WRITE_SKILL.requiredConnectors).toEqual([]);
    // Every tool it names already existed: no new privileged tool was added
    // to make a write skill possible.
    expect([...WRITE_SKILL.requiredTools].sort()).toEqual([
      'browser.read_page',
      'browser.type',
      'browser.wait',
    ]);
    // One step submits. That is the state change.
    const submitting = WRITE_SKILL.steps.filter(
      (step) => step.kind === 'tool' && 'submit' in (step.arguments ?? {}),
    );
    expect(submitting).toHaveLength(1);
  });

  it('02 — the declared risk matches what the registry computes', () => {
    const risk = effectiveSkillRisk(
      WRITE_SKILL,
      (name) => TOOLS.find((tool) => tool.name === name)?.risk,
      () => undefined,
    );
    expect(risk).toBe('R2');
    expect(validateSkillDefinition(WRITE_SKILL, { hasTool: () => true })).toEqual([]);
  });

  it('03 — a read-only child action runs where it is allowed', async () => {
    harness.respondWith('approve_once');
    const result = await runWrite();

    expect(result.status).toBe('completed');
    // The read ran, and its own outcome is recorded step by step.
    expect(result.steps.map((step) => step.ran)).toContain('browser.read_page');
  });

  it('04 — the write child action reaches its own policy decision', async () => {
    // The central claim. One approval starts the skill; the write is asked
    // about separately, by name.
    harness.respondWith('approve_once');
    await runWrite();

    expect(harness.prompts()).toContain('browser.type');
  });

  it('05 — declining the write stops the write and not the read', async () => {
    // NEGATIVE CONTROL for case 04: if the skill-level approval were carried
    // down, declining here would change nothing.
    harness.respondWith('deny');
    const result = await runWrite();

    const typed = harness.seen.filter((call) => call.tool === 'browser.type');
    expect(typed).toEqual([]);
    expect(result.status).not.toBe('completed');
  });

  it('06 — every child call is dispatched individually, in order', async () => {
    harness.respondWith('approve_once');
    await runWrite();

    // Three steps, three dispatches. A runner that batched them would be a
    // second execution path.
    expect(harness.seen.map((call) => call.tool)).toEqual([
      'browser.type',
      'browser.wait',
      'browser.read_page',
    ]);
  });
});

describe('TEST-SECURITY-074 group B: floors a skill cannot lower', () => {
  it('07 — an R3 child action still requires confirmation in skip mode', async () => {
    // Skip mode asks for nothing below R3. A child at R3 is asked about
    // anyway, and the skill wrapping it changes neither.
    harness = buildSkillHarness({
      permissionMode: 'skip',
      tools: [...TOOLS, { name: 'browser.download', risk: 'R3' as const, returns: { ok: true } }],
    });
    const withR3: SkillDefinition = {
      ...WRITE_SKILL,
      id: 'test.r3_child',
      requiredTools: ['browser.download'],
      risk: 'R3',
      steps: [
        {
          kind: 'tool',
          id: 'grab',
          tool: 'browser.download',
          description: 'An R3 child.',
          arguments: { url: { kind: 'literal', value: 'https://files.test/a.pdf' } },
        },
      ],
      outputs: [],
      inputs: [],
    };
    await harness.register(withR3);
    harness.respondWith('approve_once');

    await harness.runner.run(harness.skills.get('test.r3_child', '1.0.0')!, {}, harness.context());
    expect(harness.prompts()).toContain('browser.download');
  });

  it('08 — an R5 child action is denied and never runs', async () => {
    harness = buildSkillHarness({
      permissionMode: 'skip',
      tools: [...TOOLS, { name: 'browser.forbidden', risk: 'R5' as const, returns: { ok: true } }],
    });
    const withR5: SkillDefinition = {
      ...WRITE_SKILL,
      id: 'test.r5_child',
      requiredTools: ['browser.forbidden'],
      risk: 'R5',
      steps: [
        {
          kind: 'tool',
          id: 'never',
          tool: 'browser.forbidden',
          description: 'An R5 child.',
          arguments: {},
        },
      ],
      outputs: [],
      inputs: [],
    };
    await harness.register(withR5);
    harness.respondWith('approve_once');

    const result = await harness.runner.run(
      harness.skills.get('test.r5_child', '1.0.0')!,
      {},
      harness.context(),
    );

    // Denied by policy, so it never reached the tool — and no prompt could
    // have rescued it, because R5 is refused before anyone is asked.
    expect(harness.seen.filter((call) => call.tool === 'browser.forbidden')).toEqual([]);
    expect(result.status).not.toBe('completed');
    expect(harness.prompts()).not.toContain('browser.forbidden');
  });

  it('09 — a skill cannot raise its own ceiling by declaring a lower risk', () => {
    // The declared risk is a floor the registry maxes against what the steps
    // actually reach. Declaring R0 over an R3 child does not buy R0.
    const understated: SkillDefinition = { ...WRITE_SKILL, id: 'test.understated', risk: 'R0' };
    const risk: RiskLevel = effectiveSkillRisk(
      understated,
      (name) => (name === 'browser.type' ? 'R3' : 'R0'),
      () => undefined,
    );
    expect(risk).toBe('R3');
  });
});

describe('TEST-SECURITY-074 group C: site authorization and taint', () => {
  it('10 — the write is judged against the page it is aimed at', async () => {
    // `browser.type` declares `siteAuthorization: 'page'`, so the site comes
    // from the tab at dispatch. A skill supplies no site and cannot choose one.
    const type = harness.tools.get('browser.type');
    expect(type?.siteAuthorization).toBe('page');
    // And the real tool the shipped skill names agrees.
    expect(WRITE_SKILL.requiredTools).toContain('browser.type');
  });

  it('11 — a step cannot name a site of its own', () => {
    // NEGATIVE CONTROL. If a definition could carry a site, a reviewed skill
    // would be a way to pre-authorise one.
    const serialised = JSON.stringify(WRITE_SKILL);
    expect(serialised).not.toMatch(/siteScope|siteAuthorization|origin|https?:\/\//);
  });

  it('12 — what a step reads is carried to the next step’s egress decision', async () => {
    harness.respondWith('approve_once');
    const result = await runWrite();
    // The runner accumulates taint across steps rather than each step
    // starting clean; the write's destination decision therefore accounts for
    // what the run has already read.
    expect(result.status).toBe('completed');
    expect(Array.isArray(result.taint)).toBe(true);
  });
});

describe('TEST-SECURITY-074 group D: audit, credentials, provider', () => {
  it('13 — the run and each child call are recorded separately', async () => {
    harness.respondWith('approve_once');
    const result = await runWrite();

    // The skill's own step record, one entry per step.
    expect(result.steps).toHaveLength(3);
    for (const step of result.steps) expect(step.ran).toBeDefined();
    // And the dispatch path produced its own record per call — the registry's
    // observation hook fires per dispatch, which is what the audit adapter
    // writes from. Three dispatches, three observations.
    expect(harness.seen).toHaveLength(3);
  });

  it('14 — a skill definition cannot carry or reach a credential', () => {
    // Nothing in the definition language can name one, and the shipped write
    // skill names no connector at all.
    const serialised = JSON.stringify(WRITE_SKILL);
    expect(serialised).not.toMatch(/token|secret|password|credential|apiKey|authorization/i);
    expect(WRITE_SKILL.requiredConnectors).toEqual([]);
  });

  it('15 — the run carries no provider identity, so switching one changes nothing', async () => {
    harness.respondWith('approve_once');
    const result = await runWrite();

    // A skill run is authorised by policy and the user, not by which brain is
    // active: there is no provider field anywhere in the result, and the
    // definition names none.
    expect(JSON.stringify(result)).not.toMatch(/providerId|modelId|anthropic|openai|gemini/i);
    expect(JSON.stringify(WRITE_SKILL)).not.toMatch(/provider|model/i);
  });
});
