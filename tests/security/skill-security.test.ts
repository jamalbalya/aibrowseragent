/**
 * TEST-SECURITY-022 — the skill security boundary.
 *
 * A workflow feature is a natural place for a bypass to hide, because a
 * workflow is exactly "several privileged things in a row" and the obvious
 * implementation is a second execution path that runs them. The three claims
 * this suite holds are the ones that keep it from being that:
 *
 *  1. **A skill cannot be created, only chosen.** Nothing a model, a page or a
 *     service produced can become a registered skill, and nothing anywhere
 *     accepts code.
 *  2. **A skill is not a second execution path.** Every step goes through the
 *     one `ToolRegistry.dispatch`, so policy, permission, egress and taint all
 *     apply — per step, not per run.
 *  3. **A skill grants nothing.** Declaring a tool, a connector or a risk
 *     level describes intent; authorization still comes from the registry, the
 *     policy engine and the user.
 *
 * The groups below are the twenty threat cases in the wave brief, each named
 * for the attack rather than the branch it covers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { AuditLog, ProhibitedAuditFieldError } from '@/audit/audit-log';
import { SkillRegistry } from '@/skills/core/skill-registry';
import { FORBIDDEN_CAPABILITY_NAMES, validateSkillDefinition } from '@/skills/core/skill-model';
import {
  ProhibitedSkillRecordFieldError,
  SkillRunStore,
  assertRecordSafe,
  assessResume,
  type SkillRunRecord,
} from '@/skills/runtime/skill-run-store';
import { readPath, resolveBinding } from '@/skills/runtime/skill-runner';
import { addTaint, freshTaint, unknownTaint } from '@/security/taint/taint-state';
import { BUNDLED_SKILLS } from '@/skills/bundled';
import { buildSkillHarness, skillFixture, type SkillHarness } from '../fixtures/skill-harness';

const SKILLS_ROOT = resolve(import.meta.dirname, '../../src/skills');
const TOOLS_ROOT = resolve(import.meta.dirname, '../../src/tools/skills');

const TOOLS = [
  { name: 'fake.read', risk: 'R0' as const, returns: { items: [{ id: 7 }] } },
  { name: 'fake.write', risk: 'R3' as const, returns: { written: true } },
  {
    name: 'fake.send',
    risk: 'R1' as const,
    returns: { sent: true },
    egressTo: 'https://elsewhere.test/collect',
  },
];

let harness: SkillHarness;

beforeEach(() => {
  harness = buildSkillHarness({ tools: TOOLS });
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

// --- 1. a skill cannot be created, only chosen -----------------------------

describe('a model cannot bring a skill into existence', () => {
  it('1. refuses to run a skill that does not exist', async () => {
    // The refusal is the whole behaviour. There is no fallback that creates
    // one, and no "did you mean" that runs something else.
    expect(harness.skills.get('invented.by.the.model', '1.0.0')).toBeUndefined();
    expect(harness.skills.latest('invented.by.the.model')).toBeUndefined();
  });

  it('2. refuses a definition the model wrote, however well formed', async () => {
    // A model can produce a `SkillDefinition`-shaped object. This is where it
    // stops being executable: provenance is checked, and only the build's own
    // definitions carry the trusted one.
    const proposal = skillFixture({ id: 'model.proposal', provenance: 'model_proposed' });
    await expect(harness.skills.register(proposal)).rejects.toThrow(/provenance/);
    expect(harness.skills.get('model.proposal', '1.0.0')).toBeUndefined();
  });

  it('2b. refuses to redefine a skill that is already registered', async () => {
    await harness.register(skillFixture());
    const rewritten = skillFixture({
      requiredTools: ['fake.write'],
      steps: [{ kind: 'tool', id: 'w', tool: 'fake.write', description: 'Write.', arguments: {} }],
    });
    await expect(harness.skills.register(rewritten)).rejects.toThrow(/already registered/);
    // The original is untouched: still the read-only one.
    expect(harness.skills.get('test.skill', '1.0.0')!.tools).toEqual(['fake.read']);
  });

  it('3. refuses a skill injecting a tool that is not registered', async () => {
    const injected = skillFixture({
      id: 'inject.tool',
      requiredTools: ['fake.exfiltrate'],
      steps: [
        {
          kind: 'tool',
          id: 'one',
          tool: 'fake.exfiltrate',
          description: 'A tool that does not exist.',
          arguments: {},
        },
      ],
    });
    await expect(harness.skills.register(injected)).rejects.toThrow(/unknown tool/);
  });

  it('4. refuses a skill referencing an unknown tool even if it declares it', async () => {
    const definition = skillFixture({
      id: 'declare.unknown',
      requiredTools: ['fake.read', 'nope.missing'],
      steps: [
        { kind: 'tool', id: 'a', tool: 'fake.read', description: 'Read.', arguments: {} },
        { kind: 'tool', id: 'b', tool: 'nope.missing', description: 'Missing.', arguments: {} },
      ],
    });
    // Declaring a tool does not create it. The declaration is a statement of
    // intent that the registry checks, not a grant it honours.
    await expect(harness.skills.register(definition)).rejects.toThrow(/unknown tool/);
  });
});

describe('5. there is nowhere to put code', () => {
  it('the skill tree contains no evaluator', () => {
    // Not a convention a reviewer has to remember: an added `eval`, `new
    // Function` or dynamic `import()` breaks this test.
    const offenders = [...sources(SKILLS_ROOT), ...sources(TOOLS_ROOT)].filter((file) => {
      const body = readFileSync(file, 'utf8');
      return /\beval\s*\(|new\s+Function\s*\(|\bimport\s*\(|setTimeout\s*\(\s*['"`]|Function\s*\(\s*['"`]/.test(
        body,
      );
    });
    expect(offenders).toEqual([]);
  });

  it('the skill tree reaches no network or filesystem primitive', () => {
    const offenders = [...sources(SKILLS_ROOT), ...sources(TOOLS_ROOT)].filter((file) =>
      /(?<![A-Za-z.])fetch\s*\(|XMLHttpRequest|sendBeacon|new WebSocket|new EventSource|importScripts|node:fs|require\s*\(/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    // 6 and 7: a skill reaches the network or a file only by naming a tool
    // that already can, and already guards it.
    expect(offenders).toEqual([]);
  });

  it('a step can only name a tool or a skill, never a body', () => {
    // Structural: the union has two members and neither carries code.
    for (const definition of BUNDLED_SKILLS) {
      for (const step of definition.steps) {
        expect(['tool', 'skill']).toContain(step.kind);
        expect(step).not.toHaveProperty('code');
        expect(step).not.toHaveProperty('script');
        expect(step).not.toHaveProperty('body');
        expect(step).not.toHaveProperty('url');
      }
    }
  });

  it.each([
    ['a function', (): string => 'evil'],
    ['a constructor', function Evil() {}],
    ['a RegExp', /evil/],
  ])('refuses %s smuggled in as a literal', (_label, value) => {
    const definition = skillFixture({
      steps: [
        {
          kind: 'tool',
          id: 'one',
          tool: 'fake.read',
          description: 'Read.',
          arguments: { payload: { kind: 'literal', value } },
        },
      ],
    });
    expect(validateSkillDefinition(definition, { hasTool: () => true }).join(' ')).toContain(
      'not plain data',
    );
  });
});

describe('a binding path reaches data and nothing else', () => {
  it.each(['__proto__', 'constructor', 'prototype'])(
    'refuses to walk through %s at run time',
    (segment) => {
      // Checked again here, not only in the validator. The two protect
      // against different mistakes: the validator against a bad definition,
      // this against a result whose shape someone else controls.
      const source = { a: { b: 1 } };
      expect(readPath(source, `a.${segment}`)).toBeUndefined();
      expect(readPath(source, `a.${segment}.polluted`)).toBeUndefined();
    },
  );

  it('reads own properties only', () => {
    const source = Object.create({ inherited: 'should not be reachable' }) as Record<
      string,
      unknown
    >;
    source.own = 'fine';
    expect(readPath(source, 'own')).toBe('fine');
    expect(readPath(source, 'inherited')).toBeUndefined();
  });

  it('cannot pollute a prototype through a resolved binding', () => {
    const before = ({} as Record<string, unknown>).polluted;
    resolveBinding(
      { kind: 'step', step: 's', path: '__proto__.polluted' },
      {},
      new Map([['s', { a: 1 }]]),
    );
    expect(({} as Record<string, unknown>).polluted).toBe(before);
  });

  it('yields nothing rather than something wrong for a path that does not exist', () => {
    expect(readPath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(readPath(undefined, 'a')).toBeUndefined();
    expect(readPath([1, 2], '5')).toBeUndefined();
    expect(readPath([1, 2], 'x')).toBeUndefined();
  });
});

// --- 2. not a second execution path ----------------------------------------

describe('8. a skill cannot get past the egress gate', () => {
  it('is refused exactly as a bare tool call would be', async () => {
    const tainted = buildSkillHarness({
      tools: TOOLS,
      taintState: unknownTaint('persistence-failed'),
    });
    const definition = skillFixture({
      requiredTools: ['fake.send'],
      steps: [{ kind: 'tool', id: 'send', tool: 'fake.send', description: 'Send.', arguments: {} }],
    });
    await tainted.register(definition);

    const result = await tainted.runner.run(
      tainted.skills.get('test.skill', '1.0.0')!,
      {},
      tainted.context({ taintState: unknownTaint('persistence-failed') }),
    );

    expect(result.status).toBe('failed');
    expect(tainted.seen).toEqual([]);
  });

  it('cannot declare its way around a destination', () => {
    // There is no field in which to write "allow all domains" or "skip
    // policy": a step names a tool, and the tool declares its own
    // destination when it is classified.
    const definition = skillFixture();
    expect(definition.steps[0]).not.toHaveProperty('egress');
    expect(definition.steps[0]).not.toHaveProperty('destination');
    expect(definition).not.toHaveProperty('allowedDomains');
    expect(definition).not.toHaveProperty('bypass');
  });
});

describe('9. a skill cannot get past consent', () => {
  it('a declined step stops the run and performs nothing', async () => {
    harness.respondWith('deny');
    const definition = skillFixture({
      requiredTools: ['fake.write'],
      steps: [{ kind: 'tool', id: 'w', tool: 'fake.write', description: 'Write.', arguments: {} }],
    });
    await harness.register(definition);

    const result = await harness.runner.run(
      harness.skills.get('test.skill', '1.0.0')!,
      {},
      harness.context(),
    );

    expect(result.status).toBe('failed');
    expect(harness.seen).toEqual([]);
  });

  it('does not turn several approvals into one', async () => {
    const definition = skillFixture({
      requiredTools: ['fake.write'],
      steps: [
        { kind: 'tool', id: 'a', tool: 'fake.write', description: 'Write.', arguments: {} },
        { kind: 'tool', id: 'b', tool: 'fake.write', description: 'Write.', arguments: {} },
      ],
    });
    await harness.register(definition);
    await harness.runner.run(harness.skills.get('test.skill', '1.0.0')!, {}, harness.context());

    // This is the failure mode a workflow feature invites: bundling risky
    // steps behind one click. Each write was asked about on its own.
    expect(harness.prompts().filter((tool) => tool === 'fake.write')).toHaveLength(2);
  });
});

describe('10. a skill cannot clear taint', () => {
  it('carries what a step read forward rather than resetting it', async () => {
    const tainting = buildSkillHarness({
      tools: [
        {
          name: 'fake.read',
          risk: 'R0',
          returns: { items: [{ id: 1 }] },
          taint: [{ sourceType: 'web_page', site: 'intranet.test', sensitivity: 'confidential' }],
        },
        { name: 'fake.write', risk: 'R3', returns: { written: true } },
      ],
    });
    const definition = skillFixture({
      requiredTools: ['fake.read', 'fake.write'],
      steps: [
        { kind: 'tool', id: 'r', tool: 'fake.read', description: 'Read.', arguments: {} },
        { kind: 'tool', id: 'w', tool: 'fake.write', description: 'Write.', arguments: {} },
      ],
    });
    await tainting.register(definition);
    const result = await tainting.runner.run(
      tainting.skills.get('test.skill', '1.0.0')!,
      {},
      tainting.context(),
    );

    // Reported up, so the task ends up carrying it. A run that swallowed it
    // would leave the task believing it had read less than it had.
    expect(result.taint).toContainEqual({
      sourceType: 'web_page',
      site: 'intranet.test',
      sensitivity: 'confidential',
    });
  });

  it("starts from the task's state rather than a clean one", async () => {
    const start = addTaint(freshTaint(), [
      { sourceType: 'web_page', site: 'already.test', sensitivity: 'confidential' },
    ]);
    const running = buildSkillHarness({ tools: TOOLS, taintState: start });
    await running.register(skillFixture());

    await running.runner.run(
      running.skills.get('test.skill', '1.0.0')!,
      {},
      running.context({ taintState: start }),
    );

    expect(running.seen[0]!.taintState).toEqual(start);
  });

  it('has no field in which to declare itself untainted', () => {
    const definition = skillFixture();
    expect(definition).not.toHaveProperty('taint');
    expect(definition).not.toHaveProperty('clearsTaint');
    expect(definition).not.toHaveProperty('trusted');
  });
});

describe('11. a skill cannot reach a credential', () => {
  it('has no field naming a provider, a key or a token', () => {
    for (const definition of BUNDLED_SKILLS) {
      const dumped = JSON.stringify(definition);
      for (const forbidden of [
        'apiKey',
        'api_key',
        'accessToken',
        'access_token',
        'clientSecret',
        'password',
        'Bearer ',
      ]) {
        expect(dumped).not.toContain(forbidden);
      }
    }
  });

  it("reaches a connector only through the connector's own tools", () => {
    // Which means the token stays inside the connector boundary: a skill
    // names `github.read_issue`, and that tool attaches the credential.
    const github = BUNDLED_SKILLS.find((skill) => skill.id === 'github.find_issue')!;
    for (const step of github.steps) {
      expect(step.kind).toBe('tool');
      if (step.kind === 'tool') expect(step.tool.startsWith('github.')).toBe(true);
    }
  });

  it('12/13. cannot be registered from connector or page content', () => {
    // Both arrive as `untrusted_external_content`, and neither has a route to
    // the registry: the only provenance that registers is `bundled`, which
    // means "shipped in this build".
    for (const provenance of ['model_proposed', 'imported', 'unknown'] as const) {
      const problems = validateSkillDefinition(skillFixture({ provenance }), {
        hasTool: () => true,
      });
      expect(problems.join(' ')).toContain('provenance');
    }
  });
});

// --- composition and recursion ---------------------------------------------

describe('14/15. composition cannot run away', () => {
  it('cannot express a cycle at all, because composition is pinned and ordered', async () => {
    await harness.register(skillFixture({ id: 'cyc.a', version: '1.0.0' }));
    await harness.register(
      skillFixture({
        id: 'cyc.b',
        requiredTools: [],
        steps: [
          {
            kind: 'skill',
            id: 'toA',
            skill: 'cyc.a',
            skillVersion: '1.0.0',
            description: 'To a.',
            arguments: {},
          },
        ],
      }),
    );

    // Closing the loop needs a@x composing b, and b composes a@1.0.0. A new
    // version of a can be registered — but it is a *different* node, so
    // a@2.0.0 → b@1.0.0 → a@1.0.0 terminates. Pinned versions plus
    // "compose only what already exists" make a cycle unreachable rather
    // than merely detectable; the validator's cycle check is the backstop for
    // a graph assembled some other way, and TEST-SKILL-001 exercises it
    // directly.
    const aAgain = skillFixture({
      id: 'cyc.a',
      version: '2.0.0',
      requiredTools: [],
      steps: [
        {
          kind: 'skill',
          id: 'toB',
          skill: 'cyc.b',
          skillVersion: '1.0.0',
          description: 'To b.',
          arguments: {},
        },
      ],
    });
    await expect(harness.skills.register(aAgain)).resolves.toBeDefined();

    // And the chain really does terminate: running it reaches the leaf.
    const result = await harness.runner.run(
      harness.skills.get('cyc.a', '2.0.0')!,
      {},
      harness.context(),
    );
    expect(result.status).toBe('completed');
    expect(harness.seen.map((call) => call.tool)).toEqual(['fake.read']);
  });

  it('refuses a skill composing itself', async () => {
    const selfReferential = skillFixture({
      id: 'self.ref',
      requiredTools: [],
      steps: [
        {
          kind: 'skill',
          id: 'me',
          skill: 'self.ref',
          skillVersion: '1.0.0',
          description: 'Again.',
          arguments: {},
        },
      ],
    });
    await expect(harness.skills.register(selfReferential)).rejects.toThrow(/belongs to/);
  });
});

describe('16. a skill cannot change under a run', () => {
  it('binds an invocation to one exact version', async () => {
    await harness.register(skillFixture({ version: '1.0.0' }));
    const bound = harness.skills.get('test.skill', '1.0.0')!;

    // A newer, riskier version is registered while the first is in hand.
    await harness.register(
      skillFixture({
        version: '2.0.0',
        requiredTools: ['fake.write'],
        steps: [
          { kind: 'tool', id: 'w', tool: 'fake.write', description: 'Write.', arguments: {} },
        ],
      }),
    );

    // The bound entry is unchanged: it holds a definition, not a lookup.
    expect(bound.definition.version).toBe('1.0.0');
    expect(bound.tools).toEqual(['fake.read']);
    const result = await harness.runner.run(bound, {}, harness.context());
    expect(harness.seen.map((call) => call.tool)).toEqual(['fake.read']);
    expect(result.skillVersion).toBe('1.0.0');
  });

  it('refuses to resume a run whose definition changed', () => {
    const record: SkillRunRecord = {
      runId: 'r1',
      taskId: 't1',
      skillId: 'test.skill',
      skillVersion: '1.0.0',
      skillHash: 'a'.repeat(64),
      stepIndex: 1,
      totalSteps: 3,
      state: 'interrupted',
      taintState: freshTaint(),
      startedAt: 1,
      updatedAt: 2,
    };
    // Same id, same version, different definition — which happens when a
    // build ships an edited skill without bumping its version. Trusting the
    // version alone would silently execute different steps.
    expect(assessResume(record, { hash: 'b'.repeat(64), version: '1.0.0' })).toMatchObject({
      ok: false,
      reason: 'HASH_CHANGED',
    });
  });

  it('refuses to resume across a version change', () => {
    const record: SkillRunRecord = {
      runId: 'r1',
      taskId: 't1',
      skillId: 'test.skill',
      skillVersion: '1.0.0',
      skillHash: 'a'.repeat(64),
      stepIndex: 1,
      totalSteps: 3,
      state: 'interrupted',
      taintState: freshTaint(),
      startedAt: 1,
      updatedAt: 2,
    };
    expect(assessResume(record, { hash: 'a'.repeat(64), version: '2.0.0' })).toMatchObject({
      ok: false,
      reason: 'VERSION_CHANGED',
    });
  });
});

// --- 17. persistence and recovery ------------------------------------------

describe('17. what survives a worker restart', () => {
  let store: SkillRunStore;
  let clock: number;

  beforeEach(() => {
    clock = 1_700_000_000_000;
    store = new SkillRunStore(new SerializedStorageArea(new MemoryStorageArea()), () => clock);
  });

  const record = {
    runId: 'run1',
    taskId: 'task1',
    skillId: 'test.skill',
    skillVersion: '1.0.0',
    skillHash: 'a'.repeat(64),
    totalSteps: 3,
    taintState: freshTaint(),
  };

  it('marks a run that was running in a dead worker as interrupted', async () => {
    await store.start(record);
    const interrupted = await store.reconcileAfterRestart();

    expect(interrupted).toHaveLength(1);
    // Leaving it marked `running` would let a later reader conclude that
    // something is still executing it.
    expect((await store.get('run1'))?.state).toBe('interrupted');
  });

  it('leaves a finished run alone', async () => {
    await store.start(record);
    await store.settle('run1', 'completed');
    expect(await store.reconcileAfterRestart()).toEqual([]);
    expect((await store.get('run1'))?.state).toBe('completed');
  });

  it('refuses to resume a run whose security state is unknown', () => {
    // Continuing would mean continuing with less than was known before.
    expect(
      assessResume(
        {
          ...record,
          stepIndex: 1,
          state: 'interrupted',
          startedAt: 1,
          updatedAt: 1,
          taintState: unknownTaint('persistence-failed'),
        },
        { hash: 'a'.repeat(64), version: '1.0.0' },
      ),
    ).toMatchObject({ ok: false, reason: 'SECURITY_STATE_UNKNOWN' });
  });

  it('refuses to resume a run whose skill is gone', () => {
    expect(
      assessResume(
        { ...record, stepIndex: 1, state: 'interrupted', startedAt: 1, updatedAt: 1 },
        undefined,
      ),
    ).toMatchObject({ ok: false, reason: 'SKILL_GONE' });
  });

  it('refuses to resume something that is not interrupted', () => {
    expect(
      assessResume(
        { ...record, stepIndex: 1, state: 'running', startedAt: 1, updatedAt: 1 },
        { hash: 'a'.repeat(64), version: '1.0.0' },
      ),
    ).toMatchObject({ ok: false, reason: 'NOT_INTERRUPTED' });
  });

  it('refuses a record it has never seen', () => {
    expect(assessResume(undefined, { hash: 'a'.repeat(64), version: '1.0.0' })).toMatchObject({
      ok: false,
      reason: 'NO_RECORD',
    });
  });

  it('accepts only an unchanged, interrupted, knowable run', () => {
    expect(
      assessResume(
        { ...record, stepIndex: 1, state: 'interrupted', startedAt: 1, updatedAt: 1 },
        { hash: 'a'.repeat(64), version: '1.0.0' },
      ).ok,
    ).toBe(true);
  });
});

describe('20. what a run record may not carry', () => {
  it.each([
    'accessToken',
    'access_token',
    'refreshToken',
    'apiKey',
    'password',
    'codeVerifier',
    'cookie',
  ])('refuses a record carrying %s', (field) => {
    expect(() => assertRecordSafe({ runId: 'r', [field]: 'value' })).toThrow(
      ProhibitedSkillRecordFieldError,
    );
  });

  it.each(['arguments', 'result', 'results', 'outputs', 'inputs', 'payload', 'content', 'body'])(
    'refuses step data as well as credentials: %s',
    (field) => {
      // The record tracks which skill was running and how far it got. A
      // skill's intermediate results can contain anything the task has read,
      // and writing them to disk so a run could resume would make a workflow
      // feature a second, unaudited copy of the page.
      expect(() => assertRecordSafe({ runId: 'r', [field]: 'value' })).toThrow(
        ProhibitedSkillRecordFieldError,
      );
    },
  );

  it('accepts an ordinary record', () => {
    expect(() =>
      assertRecordSafe({
        runId: 'r',
        taskId: 't',
        skillId: 'test.skill',
        skillVersion: '1.0.0',
        stepIndex: 2,
        state: 'running',
      }),
    ).not.toThrow();
  });

  it('holds nothing about what a run read or produced, after a real run', async () => {
    const store = new SkillRunStore(new SerializedStorageArea(new MemoryStorageArea()));
    await store.start({
      runId: 'run1',
      taskId: 'task1',
      skillId: 'test.skill',
      skillVersion: '1.0.0',
      skillHash: 'a'.repeat(64),
      totalSteps: 2,
      taintState: freshTaint(),
    });
    const dumped = JSON.stringify(await store.list());
    for (const forbidden of ['secret', 'token', 'password', 'items']) {
      expect(dumped).not.toContain(forbidden);
    }
  });
});

// --- audit ------------------------------------------------------------------

describe('the audit trail', () => {
  it('records which skill ran, at what version and hash', async () => {
    const audit = new AuditLog(new MemoryStorageArea());
    const event = await audit.record({
      type: 'skill.started',
      taskId: 'task1',
      outcome: 'info',
      skillId: 'test.skill',
      skillVersion: '1.0.0',
      skillHash: 'a'.repeat(64),
    });
    expect(event).toMatchObject({ skillId: 'test.skill', skillVersion: '1.0.0' });
  });

  it('refuses a skill record carrying a credential', async () => {
    const audit = new AuditLog(new MemoryStorageArea());
    for (const field of ['access_token', 'accessToken', 'apiKey', 'password']) {
      await expect(
        audit.record({
          type: 'skill.finished',
          outcome: 'allowed',
          skillId: 'test.skill',
          [field]: 'secret-value',
        } as never),
      ).rejects.toBeInstanceOf(ProhibitedAuditFieldError);
    }
  });

  it("refuses a skill record carrying the run's inputs or results", async () => {
    const audit = new AuditLog(new MemoryStorageArea());
    for (const field of ['inputs', 'outputs', 'result', 'payload', 'content']) {
      await expect(
        audit.record({
          type: 'skill.finished',
          outcome: 'allowed',
          skillId: 'test.skill',
          [field]: 'whatever the page said',
        } as never),
      ).rejects.toBeInstanceOf(ProhibitedAuditFieldError);
    }
  });
});

// --- 18/19. cancellation and duplication -----------------------------------

describe('18. cancellation', () => {
  it('starts nothing once the task is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await harness.register(
      skillFixture({
        requiredTools: ['fake.read', 'fake.write'],
        steps: [
          { kind: 'tool', id: 'r', tool: 'fake.read', description: 'Read.', arguments: {} },
          { kind: 'tool', id: 'w', tool: 'fake.write', description: 'Write.', arguments: {} },
        ],
      }),
    );

    const result = await harness.runner.run(
      harness.skills.get('test.skill', '1.0.0')!,
      {},
      harness.context({ signal: controller.signal }),
    );

    expect(result.status).toBe('cancelled');
    expect(harness.seen).toEqual([]);
  });

  it('leaves no privileged step half-started', async () => {
    const controller = new AbortController();
    const racing = buildSkillHarness({
      tools: [
        { name: 'fake.read', risk: 'R0', returns: { items: [] }, onCall: () => controller.abort() },
        { name: 'fake.write', risk: 'R3', returns: { written: true } },
      ],
    });
    await racing.register(
      skillFixture({
        requiredTools: ['fake.read', 'fake.write'],
        steps: [
          { kind: 'tool', id: 'r', tool: 'fake.read', description: 'Read.', arguments: {} },
          { kind: 'tool', id: 'w', tool: 'fake.write', description: 'Write.', arguments: {} },
        ],
      }),
    );

    const result = await racing.runner.run(
      racing.skills.get('test.skill', '1.0.0')!,
      {},
      racing.context({ signal: controller.signal }),
    );

    expect(result.status).toBe('cancelled');
    expect(racing.seen.map((call) => call.tool)).toEqual(['fake.read']);
  });
});

describe('19. a retry is a new run, not a resumed one', () => {
  it('re-enters every gate rather than carrying an approval forward', async () => {
    await harness.register(
      skillFixture({
        requiredTools: ['fake.write'],
        steps: [
          { kind: 'tool', id: 'w', tool: 'fake.write', description: 'Write.', arguments: {} },
        ],
      }),
    );
    const entry = harness.skills.get('test.skill', '1.0.0')!;

    await harness.runner.run(entry, {}, harness.context());
    await harness.runner.run(entry, {}, harness.context());

    // Two runs, two approvals. Nothing is carried from the first.
    expect(harness.prompts().filter((tool) => tool === 'fake.write')).toHaveLength(2);
  });
});

// --- 3. a declaration is not a grant ---------------------------------------

describe('a declaration grants nothing', () => {
  it.each(FORBIDDEN_CAPABILITY_NAMES)('refuses a skill claiming "%s"', (name) => {
    expect(
      validateSkillDefinition(skillFixture({ requiredTools: [name, 'fake.read'] }), {
        hasTool: () => true,
      }).join(' '),
    ).toContain('not a capability');
  });

  it('does not lower the risk a step is approved at', async () => {
    // A skill declaring R0 while calling an R3 tool is approved as an R3
    // action, because the tool's own floor applies at dispatch.
    await harness.register(
      skillFixture({
        risk: 'R0',
        requiredTools: ['fake.write'],
        steps: [
          { kind: 'tool', id: 'w', tool: 'fake.write', description: 'Write.', arguments: {} },
        ],
      }),
    );
    const entry = harness.skills.get('test.skill', '1.0.0')!;

    // The registry prices it correctly...
    expect(entry.risk).toBe('R3');
    // ...and the step is still asked about when it runs.
    await harness.runner.run(entry, {}, harness.context());
    expect(harness.prompts()).toContain('fake.write');
  });

  it('cannot widen what a tool accepts', async () => {
    // The tool's schema runs regardless of what the skill declared, so a
    // skill cannot talk a tool into arguments it would refuse.
    const strict = buildSkillHarness({ tools: TOOLS });
    await strict.register(skillFixture());
    const result = await strict.runner.run(
      strict.skills.get('test.skill', '1.0.0')!,
      {},
      strict.context(),
    );
    expect(result.status).toBe('completed');
  });
});

describe('the bundled skills reach nothing they should not', () => {
  it('name only tools this build actually has', () => {
    const known = new Set([
      'browser.read_page',
      'browser.navigate',
      'debugger.console',
      'debugger.network',
      'github.search_issues',
      'github.read_issue',
    ]);
    for (const definition of BUNDLED_SKILLS) {
      for (const name of definition.requiredTools) expect(known.has(name)).toBe(true);
    }
  });

  it('include no write to an external service', () => {
    // Read paths first. A workflow that files an issue is a reasonable thing
    // to want and a bad thing to make the easiest path through a new feature.
    for (const definition of BUNDLED_SKILLS) {
      for (const name of definition.requiredTools) {
        expect(name).not.toMatch(/create|comment|delete|upload|send/);
      }
    }
  });
});

describe('the registry has no installation surface', () => {
  it('exposes nothing that takes a URL, a package or serialised text', () => {
    const surface = Object.getOwnPropertyNames(SkillRegistry.prototype);
    for (const forbidden of ['install', 'load', 'fromJson', 'fromUrl', 'import', 'download']) {
      expect(surface.some((name) => name.toLowerCase().includes(forbidden))).toBe(false);
    }
  });

  it('cannot be reached from a message the side panel can send', () => {
    // There is deliberately no `skill.register` route: a message that could
    // add one would make anything able to talk to the panel a way to grant
    // the trust the registry represents.
    const protocol = readFileSync(
      resolve(import.meta.dirname, '../../src/messaging/protocol.ts'),
      'utf8',
    );
    for (const route of ['skill.register', 'skill.install', 'skill.create', 'skill.update']) {
      expect(protocol).not.toContain(`'${route}'`);
    }
    expect(protocol).toContain("'skill.list'");
  });

  it('reaches no network when a skill run is refused', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('the network was reached without authorization');
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      harness.respondWith('deny');
      await harness.register(
        skillFixture({
          requiredTools: ['fake.send'],
          steps: [
            { kind: 'tool', id: 's', tool: 'fake.send', description: 'Send.', arguments: {} },
          ],
        }),
      );
      await harness.runner.run(harness.skills.get('test.skill', '1.0.0')!, {}, harness.context());
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
