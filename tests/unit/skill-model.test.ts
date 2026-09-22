/**
 * TEST-SKILL-001 — skill definitions, and what will not become one.
 *
 * A skill is trusted because the registry holds it, and the registry holds it
 * because this validator let it in. So the interesting cases are all
 * rejections: a definition naming a tool that does not exist, one claiming a
 * capability nothing grants, one reaching through a prototype, one composing
 * itself. Each would be a way to describe a privilege into being, and each has
 * to fail at registration rather than at some later moment when a user is
 * halfway through approving something.
 */
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_CAPABILITY_NAMES,
  MAX_COMPOSITION_DEPTH,
  MAX_STEPS_PER_SKILL,
  effectiveSkillRisk,
  isPlainData,
  skillHash,
  skillKey,
  toolsReachedBy,
  validateSkillDefinition,
  type SkillDefinition,
} from '@/skills/core/skill-model';
import { skillFixture } from '../fixtures/skill-harness';

const KNOWN_TOOLS = new Set(['fake.read', 'fake.write', 'browser.navigate', 'browser.read_page']);

function check(definition: SkillDefinition, others: readonly SkillDefinition[] = []): string[] {
  return validateSkillDefinition(definition, {
    hasTool: (name) => KNOWN_TOOLS.has(name),
    getSkill: (id, version) => others.find((other) => other.id === id && other.version === version),
  });
}

describe('a definition that is fine', () => {
  it('validates', () => {
    expect(check(skillFixture())).toEqual([]);
  });

  it('validates with inputs, outputs and several steps', () => {
    const definition = skillFixture({
      requiredTools: ['fake.read', 'fake.write'],
      inputs: [
        { name: 'target', type: 'string', description: 'Where.', required: true, maxLength: 64 },
      ],
      steps: [
        {
          kind: 'tool',
          id: 'read',
          tool: 'fake.read',
          description: 'Read.',
          arguments: { where: { kind: 'input', name: 'target' } },
        },
        {
          kind: 'tool',
          id: 'write',
          tool: 'fake.write',
          description: 'Write.',
          arguments: {
            value: { kind: 'step', step: 'read', path: 'items.0.id' },
            fixed: { kind: 'literal', value: 42 },
          },
        },
      ],
      outputs: [{ name: 'result', description: 'What came back.', step: 'write', path: 'id' }],
    });
    expect(check(definition)).toEqual([]);
  });
});

// --- the rejections that matter --------------------------------------------

describe('a definition that names something that does not exist', () => {
  it('is refused for an unknown tool', () => {
    const definition = skillFixture({
      requiredTools: ['fake.nonexistent'],
      steps: [
        {
          kind: 'tool',
          id: 'one',
          tool: 'fake.nonexistent',
          description: 'Do the impossible.',
          arguments: {},
        },
      ],
    });
    // A skill cannot bring a capability into being by naming it. An unknown
    // tool is a broken skill, not a new one.
    expect(check(definition).join(' ')).toContain('unknown tool');
  });

  it('is refused for a step reading an input that was never declared', () => {
    const definition = skillFixture({
      steps: [
        {
          kind: 'tool',
          id: 'one',
          tool: 'fake.read',
          description: 'Read.',
          arguments: { where: { kind: 'input', name: 'undeclared' } },
        },
      ],
    });
    expect(check(definition).join(' ')).toContain('undeclared input');
  });

  it('is refused for an output reading a step that does not exist', () => {
    const definition = skillFixture({
      outputs: [{ name: 'x', description: 'x', step: 'nope', path: 'a' }],
    });
    expect(check(definition).join(' ')).toContain('does not exist');
  });
});

describe('forward and circular references', () => {
  it('refuses a step reading a step that runs after it', () => {
    // Steps run in order, so a binding may only read what has already
    // produced a result. That is what makes a cycle within one skill
    // inexpressible rather than merely detected.
    const definition = skillFixture({
      requiredTools: ['fake.read', 'fake.write'],
      steps: [
        {
          kind: 'tool',
          id: 'first',
          tool: 'fake.read',
          description: 'Read.',
          arguments: { value: { kind: 'step', step: 'second', path: 'id' } },
        },
        {
          kind: 'tool',
          id: 'second',
          tool: 'fake.write',
          description: 'Write.',
          arguments: {},
        },
      ],
    });
    expect(check(definition).join(' ')).toContain('does not run before it');
  });

  it('refuses a step reading itself', () => {
    const definition = skillFixture({
      steps: [
        {
          kind: 'tool',
          id: 'one',
          tool: 'fake.read',
          description: 'Read.',
          arguments: { value: { kind: 'step', step: 'one', path: 'id' } },
        },
      ],
    });
    expect(check(definition).join(' ')).toContain('does not run before it');
  });

  it('refuses a skill composing itself', () => {
    const definition = skillFixture({
      steps: [
        {
          kind: 'skill',
          id: 'recurse',
          skill: 'test.skill',
          skillVersion: '1.0.0',
          description: 'Run me again.',
          arguments: {},
        },
      ],
      requiredTools: [],
    });
    expect(check(definition, [definition]).join(' ')).toContain('composes the skill it belongs to');
  });

  it('refuses a composition cycle between two skills', () => {
    // a → b → a. Neither one composes itself, so only walking the graph
    // finds it.
    const a: SkillDefinition = skillFixture({
      id: 'cycle.a',
      requiredTools: [],
      steps: [
        {
          kind: 'skill',
          id: 'toB',
          skill: 'cycle.b',
          skillVersion: '1.0.0',
          description: 'Go to b.',
          arguments: {},
        },
      ],
    });
    const b: SkillDefinition = skillFixture({
      id: 'cycle.b',
      requiredTools: [],
      steps: [
        {
          kind: 'skill',
          id: 'toA',
          skill: 'cycle.a',
          skillVersion: '1.0.0',
          description: 'Go back to a.',
          arguments: {},
        },
      ],
    });
    expect(check(a, [a, b]).join(' ')).toContain('cycle');
  });

  it('refuses composition deeper than the limit', () => {
    const chain: SkillDefinition[] = [];
    for (let i = 0; i <= MAX_COMPOSITION_DEPTH + 2; i += 1) {
      chain.push(
        skillFixture({
          id: `chain.s${i}`,
          requiredTools: [],
          steps: [
            {
              kind: 'skill',
              id: 'next',
              skill: `chain.s${i + 1}`,
              skillVersion: '1.0.0',
              description: 'Deeper.',
              arguments: {},
            },
          ],
        }),
      );
    }
    expect(check(chain[0]!, chain).join(' ')).toContain('deeper than');
  });

  it('refuses composing a skill that is not registered', () => {
    const definition = skillFixture({
      requiredTools: [],
      steps: [
        {
          kind: 'skill',
          id: 'missing',
          skill: 'nope.missing',
          skillVersion: '1.0.0',
          description: 'Compose nothing.',
          arguments: {},
        },
      ],
    });
    expect(check(definition).join(' ')).toContain('not');
  });
});

describe('capability claims', () => {
  it.each(FORBIDDEN_CAPABILITY_NAMES)('refuses a skill requiring "%s"', (name) => {
    // None of these corresponds to anything the permission system grants, so
    // a skill asking for one is either confused or trying its luck. Refusing
    // at registration means no user is ever shown "this skill requires
    // admin", which is exactly the prompt someone clicks through.
    const definition = skillFixture({ requiredTools: [name, 'fake.read'] });
    expect(check(definition).join(' ')).toContain('not a capability');
  });

  it('refuses a forbidden name however it is capitalised', () => {
    const definition = skillFixture({ requiredTools: ['BYPASS', 'fake.read'] });
    expect(check(definition).join(' ')).toContain('not a capability');
  });

  it('refuses a connector claim of the same kind', () => {
    const definition = skillFixture({ requiredConnectors: ['unrestricted'] });
    expect(check(definition).join(' ')).toContain('not a connector');
  });

  it('refuses a step using a tool the skill did not declare', () => {
    const definition = skillFixture({
      requiredTools: ['fake.read'],
      steps: [
        { kind: 'tool', id: 'a', tool: 'fake.read', description: 'Read.', arguments: {} },
        { kind: 'tool', id: 'b', tool: 'fake.write', description: 'Write.', arguments: {} },
      ],
    });
    expect(check(definition).join(' ')).toContain('not in requiredTools');
  });

  it('refuses a skill declaring a tool it never uses', () => {
    // Privilege asked for and not needed is the thing least privilege is
    // against, so it fails rather than being tidied away.
    const definition = skillFixture({ requiredTools: ['fake.read', 'fake.write'] });
    expect(check(definition).join(' ')).toContain('which no step uses');
  });
});

describe('paths', () => {
  it.each([
    ['__proto__', 'a.__proto__.polluted'],
    ['constructor', 'a.constructor.constructor'],
    ['prototype', 'a.prototype.x'],
  ])('refuses a path reaching %s', (_label, path) => {
    // `a.constructor.constructor` is the classic route from a data path to
    // the Function constructor. It is not addressable.
    const definition = skillFixture({
      requiredTools: ['fake.read', 'fake.write'],
      steps: [
        { kind: 'tool', id: 'read', tool: 'fake.read', description: 'Read.', arguments: {} },
        {
          kind: 'tool',
          id: 'write',
          tool: 'fake.write',
          description: 'Write.',
          arguments: { value: { kind: 'step', step: 'read', path } },
        },
      ],
    });
    expect(check(definition).join(' ')).toContain('not data');
  });

  it.each([
    ['a path with spaces', 'a b'],
    ['a path with a slash', 'a/b'],
    ['a path with brackets', 'a[0]'],
    ['an empty path', ''],
  ] as [string, string][])('refuses %s', (_label, path) => {
    const definition = skillFixture({
      requiredTools: ['fake.read', 'fake.write'],
      steps: [
        { kind: 'tool', id: 'read', tool: 'fake.read', description: 'Read.', arguments: {} },
        {
          kind: 'tool',
          id: 'write',
          tool: 'fake.write',
          description: 'Write.',
          arguments: { value: { kind: 'step', step: 'read', path } },
        },
      ],
    });
    expect(check(definition).join(' ')).toContain('unusable path');
  });

  it('refuses a path that reaches too deep', () => {
    const definition = skillFixture({
      requiredTools: ['fake.read', 'fake.write'],
      steps: [
        { kind: 'tool', id: 'read', tool: 'fake.read', description: 'Read.', arguments: {} },
        {
          kind: 'tool',
          id: 'write',
          tool: 'fake.write',
          description: 'Write.',
          arguments: { value: { kind: 'step', step: 'read', path: 'a.b.c.d.e.f.g.h' } },
        },
      ],
    });
    expect(check(definition).join(' ')).toContain('levels deep');
  });
});

describe('literals are data', () => {
  it.each([
    ['a function', () => 'evil'],
    ['a class instance', new Date()],
    ['a RegExp', /evil/],
    ['a Map', new Map()],
  ])('refuses %s as a literal', (_label, value) => {
    // This is where "no code in a skill" stops being a convention: a literal
    // with behaviour is not a value a definition may carry.
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
    expect(check(definition).join(' ')).toContain('not plain data');
  });

  it('accepts ordinary JSON', () => {
    const definition = skillFixture({
      steps: [
        {
          kind: 'tool',
          id: 'one',
          tool: 'fake.read',
          description: 'Read.',
          arguments: {
            payload: {
              kind: 'literal',
              value: { a: 1, b: [true, null, 'text'], c: { nested: 2 } },
            },
          },
        },
      ],
    });
    expect(check(definition)).toEqual([]);
  });

  it('judges plain data structurally', () => {
    expect(isPlainData({ a: [1, 'two', false, null] })).toBe(true);
    expect(isPlainData(() => 1)).toBe(false);
    expect(isPlainData(new Date())).toBe(false);
    expect(isPlainData(Object.create({ inherited: 1 }) as object)).toBe(false);
  });
});

describe('structural limits', () => {
  it('refuses a skill with no steps', () => {
    expect(check(skillFixture({ steps: [], requiredTools: [] })).join(' ')).toContain(
      'at least one step',
    );
  });

  it('refuses more steps than the limit', () => {
    const steps = Array.from({ length: MAX_STEPS_PER_SKILL + 1 }, (_, i) => ({
      kind: 'tool' as const,
      id: `s${i}`,
      tool: 'fake.read',
      description: 'Read.',
      arguments: {},
    }));
    expect(check(skillFixture({ steps })).join(' ')).toContain('at most');
  });

  it('refuses two steps with the same id', () => {
    const definition = skillFixture({
      steps: [
        { kind: 'tool', id: 'same', tool: 'fake.read', description: 'Read.', arguments: {} },
        { kind: 'tool', id: 'same', tool: 'fake.read', description: 'Read again.', arguments: {} },
      ],
    });
    expect(check(definition).join(' ')).toContain('used twice');
  });

  it('refuses a version that is not major.minor.patch', () => {
    for (const version of ['1.0', 'v1.0.0', 'latest', '1.0.0-beta']) {
      expect(check(skillFixture({ version })).join(' ')).toContain('version');
    }
  });

  it('refuses an unusable id', () => {
    for (const id of ['', 'Has Spaces', 'UPPER', '../escape']) {
      expect(check(skillFixture({ id })).join(' ')).toContain('usable skill id');
    }
  });

  it('refuses a risk level that is not one', () => {
    expect(
      check(skillFixture({ risk: 'R9' as unknown as SkillDefinition['risk'] })).join(' '),
    ).toContain('risk level');
  });

  it('reports every problem at once rather than the first', () => {
    // Someone writing a skill should see everything wrong with it, not one
    // problem per attempt.
    const problems = check(
      skillFixture({ id: 'BAD', version: 'x', requiredTools: ['admin', 'fake.read'] }),
    );
    expect(problems.length).toBeGreaterThan(2);
  });
});

describe('provenance is the trust decision', () => {
  it.each(['model_proposed', 'imported', 'unknown'] as const)(
    'refuses a definition with "%s" provenance',
    (provenance) => {
      // A model can produce a `SkillDefinition`-shaped object. This is the
      // one check that makes it inert: it can be held, logged and shown, and
      // it cannot be registered.
      const definition = skillFixture({ provenance });
      expect(check(definition).join(' ')).toContain('provenance');
    },
  );

  it('accepts only bundled', () => {
    expect(check(skillFixture({ provenance: 'bundled' }))).toEqual([]);
  });
});

// --- derived facts ----------------------------------------------------------

describe('effective risk', () => {
  const riskOf = (name: string) =>
    name === 'fake.write' ? ('R3' as const) : name === 'fake.read' ? ('R0' as const) : undefined;

  it('is the highest risk any step reaches', () => {
    const definition = skillFixture({
      risk: 'R0',
      requiredTools: ['fake.read', 'fake.write'],
      steps: [
        { kind: 'tool', id: 'a', tool: 'fake.read', description: 'Read.', arguments: {} },
        { kind: 'tool', id: 'b', tool: 'fake.write', description: 'Write.', arguments: {} },
      ],
    });
    // Understating the declared risk makes a skill stricter to approve, not
    // laxer: the floor never lowers what its tools are worth.
    expect(effectiveSkillRisk(definition, riskOf, () => undefined)).toBe('R3');
  });

  it('never falls below the declared floor', () => {
    const definition = skillFixture({ risk: 'R2' });
    expect(effectiveSkillRisk(definition, riskOf, () => undefined)).toBe('R2');
  });

  it('follows composition, so a skill that composes a write is a write', () => {
    const inner = skillFixture({
      id: 'inner.write',
      risk: 'R0',
      requiredTools: ['fake.write'],
      steps: [{ kind: 'tool', id: 'w', tool: 'fake.write', description: 'Write.', arguments: {} }],
    });
    const outer = skillFixture({
      id: 'outer.compose',
      risk: 'R0',
      requiredTools: [],
      steps: [
        {
          kind: 'skill',
          id: 'inner',
          skill: 'inner.write',
          skillVersion: '1.0.0',
          description: 'Compose.',
          arguments: {},
        },
      ],
    });
    expect(
      effectiveSkillRisk(outer, riskOf, (id) => (id === 'inner.write' ? inner : undefined)),
    ).toBe('R3');
  });

  it('assumes the worst for a tool it cannot price', () => {
    // Guessing low here would be the wrong way to be wrong.
    const definition = skillFixture({ risk: 'R0' });
    expect(
      effectiveSkillRisk(
        definition,
        () => undefined,
        () => undefined,
      ),
    ).toBe('R3');
  });
});

describe('the tools a skill reaches', () => {
  it('includes those reached only through composition', () => {
    const inner = skillFixture({
      id: 'inner.one',
      requiredTools: ['fake.write'],
      steps: [{ kind: 'tool', id: 'w', tool: 'fake.write', description: 'Write.', arguments: {} }],
    });
    const outer = skillFixture({
      id: 'outer.one',
      requiredTools: ['fake.read'],
      steps: [
        { kind: 'tool', id: 'r', tool: 'fake.read', description: 'Read.', arguments: {} },
        {
          kind: 'skill',
          id: 'inner',
          skill: 'inner.one',
          skillVersion: '1.0.0',
          description: 'Compose.',
          arguments: {},
        },
      ],
    });
    expect(toolsReachedBy(outer, (id) => (id === 'inner.one' ? inner : undefined))).toEqual([
      'fake.read',
      'fake.write',
    ]);
  });
});

describe('the definition hash', () => {
  it('is stable across two computations', async () => {
    const definition = skillFixture();
    expect(await skillHash(definition)).toBe(await skillHash(definition));
  });

  it('ignores things that do not change what the skill does', async () => {
    const base = skillFixture();
    const renamed = skillFixture({
      name: 'A different display name',
      description: 'Also different.',
    });
    expect(await skillHash(renamed)).toBe(await skillHash(base));
  });

  it('changes when a step does', async () => {
    const base = skillFixture();
    const changed = skillFixture({
      steps: [
        {
          kind: 'tool',
          id: 'one',
          tool: 'fake.read',
          description: 'Read something.',
          arguments: { extra: { kind: 'literal', value: 1 } },
        },
      ],
    });
    expect(await skillHash(changed)).not.toBe(await skillHash(base));
  });

  it('changes when the declared tools do', async () => {
    const base = skillFixture();
    const widened = skillFixture({ requiredTools: ['fake.read', 'fake.write'] });
    expect(await skillHash(widened)).not.toBe(await skillHash(base));
  });

  it('changes when the risk does', async () => {
    expect(await skillHash(skillFixture({ risk: 'R3' }))).not.toBe(
      await skillHash(skillFixture({ risk: 'R0' })),
    );
  });

  it('is a hex digest, not the definition', async () => {
    const hash = await skillHash(skillFixture());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('fake.read');
  });
});

describe('skill keys', () => {
  it('pair an id with a version', () => {
    expect(skillKey('a.b', '1.2.3')).toBe('a.b@1.2.3');
  });
});
