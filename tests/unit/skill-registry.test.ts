/**
 * TEST-SKILL-002 — the trusted registry.
 *
 * The registry is where "this skill may run" is decided, so the tests that
 * matter are the ones about what it will not take and what it will not let
 * change underneath a run: a definition from an untrusted source, a duplicate,
 * one naming a tool the build does not have, and a version that floats.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ALL_SKILLS_ENABLED,
  SkillRegistrationError,
  SkillRegistry,
  compareVersions,
} from '@/skills/core/skill-registry';
import { skillHash } from '@/skills/core/skill-model';
import { skillFixture } from '../fixtures/skill-harness';
import { BUNDLED_SKILLS } from '@/skills/bundled';

/** Every `.ts`/`.tsx` file under a directory, absolute, sorted. */
function walkSource(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walkSource(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    })
    .sort();
}

const RISKS: Record<string, 'R0' | 'R1' | 'R3'> = {
  'fake.read': 'R0',
  'fake.write': 'R3',
  'fake.navigate': 'R1',
};

let registry: SkillRegistry;

beforeEach(() => {
  registry = new SkillRegistry({
    riskOfTool: (name) => RISKS[name],
    isEnabled: ALL_SKILLS_ENABLED,
  });
});

describe('taking a definition', () => {
  it('accepts a valid one and reports what it worked out', async () => {
    const entry = await registry.register(skillFixture());

    expect(entry.definition.id).toBe('test.skill');
    expect(entry.risk).toBe('R0');
    expect(entry.tools).toEqual(['fake.read']);
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(registry.size).toBe(1);
  });

  it('computes the hash itself rather than taking one', async () => {
    const definition = skillFixture();
    const entry = await registry.register(definition);
    // Every later comparison is then against a value this class produced,
    // not one a caller supplied.
    expect(entry.hash).toBe(await skillHash(definition));
  });

  it('refuses a second registration of the same id and version', async () => {
    await registry.register(skillFixture());
    await expect(registry.register(skillFixture())).rejects.toBeInstanceOf(SkillRegistrationError);
  });

  it('accepts two versions of one skill side by side', async () => {
    await registry.register(skillFixture({ version: '1.0.0' }));
    await registry.register(skillFixture({ version: '1.1.0' }));
    expect(registry.size).toBe(2);
    expect(registry.get('test.skill', '1.0.0')).toBeDefined();
    expect(registry.get('test.skill', '1.1.0')).toBeDefined();
  });

  it('refuses a definition naming a tool this build does not have', async () => {
    const definition = skillFixture({
      requiredTools: ['fake.nonexistent'],
      steps: [
        {
          kind: 'tool',
          id: 'one',
          tool: 'fake.nonexistent',
          description: 'Impossible.',
          arguments: {},
        },
      ],
    });
    await expect(registry.register(definition)).rejects.toThrow(/unknown tool/);
    expect(registry.size).toBe(0);
  });

  it('refuses one that did not come from the build', async () => {
    // The one check that makes a model-written definition inert.
    await expect(registry.register(skillFixture({ provenance: 'model_proposed' }))).rejects.toThrow(
      /provenance/,
    );
    expect(registry.size).toBe(0);
  });

  it('takes nothing when it refuses', async () => {
    await expect(registry.register(skillFixture({ version: 'bad' }))).rejects.toThrow();
    expect(registry.list()).toEqual([]);
    expect(registry.has('test.skill', 'bad')).toBe(false);
  });

  it('names every problem in the refusal', async () => {
    try {
      await registry.register(skillFixture({ id: 'BAD', version: 'x' }));
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(SkillRegistrationError);
      expect((error as SkillRegistrationError).problems.length).toBeGreaterThan(1);
    }
  });

  it('stops a batch at the first definition it will not take', async () => {
    await expect(
      registry.registerAll([
        skillFixture({ id: 'first.ok' }),
        skillFixture({ id: 'second.bad', version: 'nope' }),
        skillFixture({ id: 'third.ok' }),
      ]),
    ).rejects.toThrow();
    expect(registry.has('first.ok', '1.0.0')).toBe(true);
    expect(registry.has('third.ok', '1.0.0')).toBe(false);
  });
});

describe('no path in adds an untrusted skill', () => {
  it('exposes no method that takes anything but a definition', () => {
    // A reviewer adding `installFromUrl` or `registerFromJson` breaks this
    // test, which is exactly when someone should be asked why.
    //
    // The enablement methods added for P-024 are reads: they answer whether a
    // registered skill is switched on, and none of them can bring a skill
    // into the registry. `register` and `registerAll` remain the only way in,
    // and they still take a definition and nothing else.
    expect(Object.getOwnPropertyNames(SkillRegistry.prototype).sort()).toEqual([
      'all',
      'constructor',
      'enabled',
      'get',
      'getIncludingDisabled',
      'has',
      'latest',
      'list',
      'listIncludingDisabled',
      'register',
      'registerAll',
      'size',
    ]);
  });

  it('has exactly one way to reach a skill the user switched off', () => {
    // NEGATIVE CONTROL for the enforcement point. Everything on an execution
    // path goes through `get`, `latest` or `list`, which honour the switch;
    // `getIncludingDisabled` and `listIncludingDisabled` deliberately do not,
    // because a settings screen has to show a disabled skill to offer turning
    // it on. The risk is one of them being used somewhere else, so the call
    // sites are counted from source.
    const root = resolve(import.meta.dirname, '../../src');
    const callers = walkSource(root).filter((file) =>
      /getIncludingDisabled\(|listIncludingDisabled\(/.test(readFileSync(file, 'utf8')),
    );
    expect(callers.map((file) => file.slice(root.length + 1))).toEqual([
      'background/service-worker.ts',
      'skills/core/skill-registry.ts',
    ]);
  });
});

describe('resolving a version', () => {
  beforeEach(async () => {
    await registry.register(skillFixture({ version: '1.0.0' }));
    await registry.register(skillFixture({ version: '1.9.0' }));
    await registry.register(skillFixture({ version: '1.10.0' }));
  });

  it('returns the exact version asked for', () => {
    expect(registry.get('test.skill', '1.9.0')?.definition.version).toBe('1.9.0');
  });

  it('returns nothing for a version that was never registered', () => {
    expect(registry.get('test.skill', '2.0.0')).toBeUndefined();
  });

  it('compares versions numerically, so 1.10.0 is newer than 1.9.0', () => {
    expect(registry.latest('test.skill')?.definition.version).toBe('1.10.0');
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('returns nothing for a skill that does not exist', () => {
    expect(registry.latest('nope')).toBeUndefined();
  });
});

describe('composition', () => {
  it('accepts a skill composing one already registered', async () => {
    await registry.register(skillFixture({ id: 'inner.one' }));
    const outer = skillFixture({
      id: 'outer.one',
      requiredTools: [],
      steps: [
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
    const entry = await registry.register(outer);
    expect(entry.tools).toEqual(['fake.read']);
  });

  it('refuses a skill composing one that is not registered yet', async () => {
    // Order matters, and that is what keeps the graph acyclic: a skill can
    // only compose one that already exists.
    const outer = skillFixture({
      id: 'outer.two',
      requiredTools: [],
      steps: [
        {
          kind: 'skill',
          id: 'inner',
          skill: 'not.yet',
          skillVersion: '1.0.0',
          description: 'Compose.',
          arguments: {},
        },
      ],
    });
    await expect(registry.register(outer)).rejects.toThrow(/not registered/);
  });

  it('prices a composing skill at what the composed one reaches', async () => {
    await registry.register(
      skillFixture({
        id: 'inner.write',
        risk: 'R0',
        requiredTools: ['fake.write'],
        steps: [
          { kind: 'tool', id: 'w', tool: 'fake.write', description: 'Write.', arguments: {} },
        ],
      }),
    );
    const outer = await registry.register(
      skillFixture({
        id: 'outer.write',
        risk: 'R0',
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
      }),
    );
    // A skill that composes a deleting skill deletes.
    expect(outer.risk).toBe('R3');
    expect(outer.tools).toEqual(['fake.write']);
  });

  it('pins the composed version, so a newer one does not change what runs', async () => {
    await registry.register(skillFixture({ id: 'inner.pin', version: '1.0.0' }));
    const outer = skillFixture({
      id: 'outer.pin',
      requiredTools: [],
      steps: [
        {
          kind: 'skill',
          id: 'inner',
          skill: 'inner.pin',
          skillVersion: '1.0.0',
          description: 'Compose 1.0.0 exactly.',
          arguments: {},
        },
      ],
    });
    await registry.register(outer);
    await registry.register(
      skillFixture({
        id: 'inner.pin',
        version: '2.0.0',
        requiredTools: ['fake.write'],
        steps: [
          { kind: 'tool', id: 'w', tool: 'fake.write', description: 'Write.', arguments: {} },
        ],
      }),
    );

    const step = registry.get('outer.pin', '1.0.0')!.definition.steps[0]!;
    expect(step.kind === 'skill' && step.skillVersion).toBe('1.0.0');
    // Registering the newer, riskier version did not raise what the outer
    // skill was priced at.
    expect(registry.get('outer.pin', '1.0.0')!.risk).toBe('R0');
  });
});

describe('the skills this build actually ships', () => {
  it('all register against the real tool names', async () => {
    // A guard against a bundled skill that only validates in a test's
    // imagination: these are the definitions the worker registers, checked
    // against every tool name the product has.
    const real = new SkillRegistry({
      isEnabled: ALL_SKILLS_ENABLED,
      riskOfTool: (name) =>
        [
          'browser.read_page',
          'browser.navigate',
          'debugger.console',
          'debugger.network',
          'github.search_issues',
          'github.read_issue',
        ].includes(name)
          ? 'R1'
          : undefined,
    });
    await real.registerAll(BUNDLED_SKILLS);
    expect(real.size).toBe(BUNDLED_SKILLS.length);
  });

  it('all declare bundled provenance', () => {
    for (const definition of BUNDLED_SKILLS) {
      expect(definition.provenance).toBe('bundled');
    }
  });

  it('carry no step that is anything but a tool or a registered skill', () => {
    for (const definition of BUNDLED_SKILLS) {
      for (const step of definition.steps) {
        expect(['tool', 'skill']).toContain(step.kind);
      }
    }
  });

  it('ask for no forbidden capability', () => {
    for (const definition of BUNDLED_SKILLS) {
      for (const name of [...definition.requiredTools, ...definition.requiredConnectors]) {
        expect(name).not.toMatch(/^(admin|root|bypass|all|any|\*)$/i);
      }
    }
  });
});
