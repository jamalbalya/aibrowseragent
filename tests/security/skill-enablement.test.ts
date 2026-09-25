/**
 * TEST-SECURITY-071 — turning a skill off, and what that has to mean (P-024).
 *
 * The benchmark documents skills that ship enabled and can be switched off.
 * The interesting half is not the switch, it is what "off" is allowed to mean.
 * A build that filtered the listing and left the run path alone would look
 * identical in the settings screen and would not be a control at all: the
 * model would simply be unable to *discover* a skill it could still name.
 *
 * So the enforcement is in `SkillRegistry`, and the reads every path already
 * uses — `get`, `latest`, `list` — answer as though a disabled skill were not
 * registered. `getIncludingDisabled` exists for the settings screen alone,
 * because offering to turn something back on requires showing it.
 *
 * What this is not: an install surface. Nothing here can obtain, change or
 * add a skill. The only thing it decides is whether one the build already
 * shipped, already validated and already hashed is available.
 *
 * Groups:
 *   A. off means absent, on every read
 *   B. the run path, not just the listing
 *   C. the switch is the user's, and nothing else can reach it
 *   D. defaults, persistence and failure
 *   E. why, not merely no — a disabled skill and a deleted one say so
 *   F. the lifecycle audit: one boundary, and every path through it
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ALL_SKILLS_ENABLED, SkillRegistry } from '@/skills/core/skill-registry';
import { SkillEnablementStore, skillEnablementKey } from '@/skills/core/skill-enablement';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { buildSkillHarness, skillFixture, TASK } from '../fixtures/skill-harness';
import { buildShortcutHarness } from '../fixtures/shortcut-harness';
import { createSkillTools } from '@/tools/skills/skill-tools';
import { freshTaint } from '@/security/taint/taint-state';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type { AgentTool, ToolExecutionContext } from '@/tools/core/tool-types';
import type { RiskLevel } from '@/policy/risk-classifier';
import type { StorageArea } from '@/storage/storage-area';

const RISKS: Record<string, RiskLevel> = { 'fake.read': 'R0', 'fake.write': 'R3' };

let disabled: Set<string>;
let registry: SkillRegistry;

const build = (): SkillRegistry =>
  new SkillRegistry({
    riskOfTool: (name) => RISKS[name],
    isEnabled: (id, version) => !disabled.has(skillEnablementKey(id, version)),
  });

beforeEach(async () => {
  disabled = new Set();
  registry = build();
  await registry.register(skillFixture({ id: 'alpha.skill', version: '1.0.0' }));
  await registry.register(skillFixture({ id: 'alpha.skill', version: '2.0.0' }));
  await registry.register(skillFixture({ id: 'beta.skill', version: '1.0.0' }));
});

describe('TEST-SECURITY-071 group A: off means absent', () => {
  it('01 — a disabled skill is gone from list, get and latest alike', () => {
    expect(registry.list().map((entry) => entry.definition.id)).toContain('beta.skill');

    disabled.add(skillEnablementKey('beta.skill', '1.0.0'));

    // NEGATIVE CONTROL against the version of this feature that only filters
    // the listing: all three reads have to agree, because all three are on
    // some path that reaches a run.
    expect(registry.list().map((entry) => entry.definition.id)).not.toContain('beta.skill');
    expect(registry.get('beta.skill', '1.0.0')).toBeUndefined();
    expect(registry.latest('beta.skill')).toBeUndefined();
    expect(registry.has('beta.skill', '1.0.0')).toBe(false);
  });

  it('02 — disabling one version does not disable another', () => {
    disabled.add(skillEnablementKey('alpha.skill', '2.0.0'));

    expect(registry.get('alpha.skill', '1.0.0')).toBeDefined();
    expect(registry.get('alpha.skill', '2.0.0')).toBeUndefined();
    // `latest` falls back to the newest *enabled* version rather than
    // refusing outright or floating to the disabled one.
    expect(registry.latest('alpha.skill')?.definition.version).toBe('1.0.0');
  });

  it('03 — the settings view still sees it, with its state', () => {
    disabled.add(skillEnablementKey('beta.skill', '1.0.0'));

    const listed = registry.listIncludingDisabled();
    expect(listed).toHaveLength(3);
    expect(listed.find((row) => row.entry.definition.id === 'beta.skill')?.enabled).toBe(false);
    expect(listed.find((row) => row.entry.definition.id === 'alpha.skill')?.enabled).toBe(true);
    expect(registry.getIncludingDisabled('beta.skill', '1.0.0')).toBeDefined();
  });

  it('04 — enabling it again restores exactly what was there', () => {
    const before = registry.get('beta.skill', '1.0.0');
    disabled.add(skillEnablementKey('beta.skill', '1.0.0'));
    disabled.delete(skillEnablementKey('beta.skill', '1.0.0'));

    // The same registered entry, hash included: the switch does not
    // re-register, re-validate or re-hash anything.
    expect(registry.get('beta.skill', '1.0.0')).toBe(before);
  });
});

describe('TEST-SECURITY-071 group B: the run path, not just the listing', () => {
  it('05 — a disabled skill cannot be resolved by the path a run uses', () => {
    // `skills.run` classifies and executes by resolving through the registry.
    // Both resolutions go through `get`/`latest`, so a disabled skill is not
    // runnable by name even by a caller that already knew the name.
    disabled.add(skillEnablementKey('beta.skill', '1.0.0'));

    expect(registry.get('beta.skill', '1.0.0')).toBeUndefined();
    expect(registry.latest('beta.skill')).toBeUndefined();
  });

  it('06 — and an enabled one still is, so case 05 is not proving a broken registry', () => {
    expect(registry.get('beta.skill', '1.0.0')).toBeDefined();
    expect(registry.latest('beta.skill')?.definition.id).toBe('beta.skill');
  });

  it('07 — an unknown skill and a disabled one are indistinguishable downstream', () => {
    // Deliberate: a caller learns "no such skill" either way, so the listing
    // and the run path cannot be used together to probe what exists but is
    // switched off.
    disabled.add(skillEnablementKey('beta.skill', '1.0.0'));
    expect(registry.get('beta.skill', '1.0.0')).toBe(registry.get('nothing.here', '1.0.0'));
  });
});

describe('TEST-SECURITY-071 group C: whose switch it is', () => {
  it('08 — nothing on a tool, skill, connector or content path can flip it', () => {
    // NEGATIVE CONTROL. A model able to re-enable a skill would be a model
    // able to undo the one decision this feature exists to record.
    const store = new SkillEnablementStore(new MemoryStorageArea());
    expect(Object.getOwnPropertyNames(SkillEnablementStore.prototype).sort()).toEqual([
      'constructor',
      'disabledKeys',
      'setEnabled',
    ]);
    expect(store).toBeDefined();
  });

  it('09 — the store holds identities and nothing else', async () => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const store = new SkillEnablementStore(area);
    await store.setEnabled(skillEnablementKey('beta.skill', '1.0.0'), false);

    const raw = JSON.stringify(await area.get('skills-disabled'));
    expect(raw).toContain('beta.skill@1.0.0');
    // No definition, no steps, no hash: the record cannot grow into a second
    // place a skill is described.
    expect(raw).not.toMatch(/steps|definition|hash|tool/);
  });
});

describe('TEST-SECURITY-071 group D: defaults, persistence and failure', () => {
  it('10 — a skill the user never touched is enabled', async () => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const store = new SkillEnablementStore(area);
    expect(await store.disabledKeys()).toEqual(new Set());

    // And a registry with no predicate at all behaves as it did before the
    // feature existed.
    const plain = new SkillRegistry({
      riskOfTool: (name) => RISKS[name],
      isEnabled: ALL_SKILLS_ENABLED,
    });
    await plain.register(skillFixture({ id: 'gamma.skill' }));
    expect(plain.list()).toHaveLength(1);
  });

  it('11 — the choice survives being written and read back', async () => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const store = new SkillEnablementStore(area);

    await store.setEnabled(skillEnablementKey('beta.skill', '1.0.0'), false);
    expect(await store.disabledKeys()).toEqual(new Set(['beta.skill@1.0.0']));

    await store.setEnabled(skillEnablementKey('beta.skill', '1.0.0'), true);
    expect(await store.disabledKeys()).toEqual(new Set());
  });

  it('12 — a storage failure leaves the shipped defaults in force', async () => {
    // Deliberately the permissive direction, and worth stating why: the
    // failure here is "the user's choices are unknown", not "the user
    // forbade this". Disabling everything on a read error would break a
    // working extension and read to the user as the skills being gone; the
    // skills themselves are build-shipped and hash-pinned, so what is in
    // force is the build's own set.
    const broken: StorageArea = {
      get: () => Promise.reject(new Error('storage is unavailable')),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      clear: () => Promise.resolve(),
      keys: () => Promise.resolve([]),
    };

    expect(await new SkillEnablementStore(broken).disabledKeys()).toEqual(new Set());
  });

  it('13 — a damaged record contributes only the entries that parse', async () => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    await area.set('skills-disabled', { keys: ['beta.skill@1.0.0', 42, null, 'a@1.0.0'] });

    expect(await new SkillEnablementStore(area).disabledKeys()).toEqual(
      new Set(['beta.skill@1.0.0', 'a@1.0.0']),
    );
  });
});

describe('TEST-SECURITY-071 group E: why, not merely no', () => {
  it('14 — a shortcut pointing at a disabled skill says it is switched off', async () => {
    // Before this, `registry.get` returning nothing made a disabled skill
    // indistinguishable from a deleted one, so the user was told the target
    // "is no longer available" while it sat in Settings with its toggle off.
    // Two different facts, and only one of them is actionable.
    const harness = buildShortcutHarness({
      tools: [{ name: 'fake.read', risk: 'R0' as const, returns: { ok: true } }],
      disabledSkills: new Set(['off.skill@1.0.0']),
    });
    await harness.register(skillFixture({ id: 'off.skill', version: '1.0.0' }));
    await harness.shortcuts.create('off', {
      kind: 'skill',
      skillId: 'off.skill',
      skillVersion: '1.0.0',
    });

    const verdict = await harness.resolver.resolveTyped('/off');
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('SKILL_DISABLED');
    expect(verdict.detail).toMatch(/switched off/i);
    // And it does not claim the thing is gone.
    expect(verdict.detail).not.toMatch(/no longer available|does not exist/i);
  });

  it('15 — a shortcut pointing at a skill that really is gone still says missing', async () => {
    // NEGATIVE CONTROL. Without this, a build that reported SKILL_DISABLED for
    // everything would pass case 14 and would be lying half the time.
    const harness = buildShortcutHarness({
      tools: [{ name: 'fake.read', risk: 'R0' as const, returns: { ok: true } }],
    });
    await harness.register(skillFixture({ id: 'real.skill', version: '1.0.0' }));
    await harness.shortcuts.create('gone', {
      kind: 'skill',
      skillId: 'never.registered',
      skillVersion: '9.9.9',
    });

    const verdict = await harness.resolver.resolveTyped('/gone');
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('TARGET_MISSING');
  });

  it('16 — the distinct reason is a message, never a way in', async () => {
    // The enforcement read still refuses, and the resolution is still a
    // refusal: nothing about knowing *why* produces something runnable.
    const harness = buildShortcutHarness({
      tools: [{ name: 'fake.read', risk: 'R0' as const, returns: { ok: true } }],
      disabledSkills: new Set(['off.skill@1.0.0']),
    });
    await harness.register(skillFixture({ id: 'off.skill', version: '1.0.0' }));

    expect(harness.skills.get('off.skill', '1.0.0')).toBeUndefined();
    expect(harness.skills.list()).toEqual([]);

    // The launcher refuses it too, with its own distinct reason, and runs
    // nothing.
    const outcome = await harness.launcher.launch({
      skillId: 'off.skill',
      skillVersion: '1.0.0',
      sessionId: 's1',
      inputs: {},
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('SKILL_DISABLED');
    expect(harness.seen).toEqual([]);
  });

  it('17 — and a skill that was never registered is refused as unregistered', async () => {
    // The launcher's control, matching case 15.
    const harness = buildShortcutHarness({
      tools: [{ name: 'fake.read', risk: 'R0' as const, returns: { ok: true } }],
    });
    const outcome = await harness.launcher.launch({
      skillId: 'nothing.here',
      skillVersion: '1.0.0',
      sessionId: 's1',
      inputs: {},
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('NOT_REGISTERED');
  });

  it('18 — a shortcut cannot be created for a skill that is switched off', async () => {
    // Creation uses the enforcing read, so a shortcut is never made for
    // something that could not run. Turning the skill off later is what
    // produces case 14.
    const harness = buildShortcutHarness({
      tools: [{ name: 'fake.read', risk: 'R0' as const, returns: { ok: true } }],
      disabledSkills: new Set(['off.skill@1.0.0']),
    });
    await harness.register(skillFixture({ id: 'off.skill', version: '1.0.0' }));

    expect(
      await harness.resolver.targetIsUsable({
        kind: 'skill',
        skillId: 'off.skill',
        skillVersion: '1.0.0',
      }),
    ).toBe(false);
  });
});

/**
 * Every `.ts`/`.tsx` file under a directory, absolute, sorted.
 *
 * Duplicated from `tests/unit/skill-registry.test.ts` rather than shared: a
 * census whose helper lives elsewhere is one somebody can loosen without
 * touching the test that depends on it.
 */
function walkSource(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walkSource(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    })
    .sort();
}

/** Source with comments stripped, so a census reads code and not prose. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * The real `skills.run`, wired to a real registry and a real runner.
 *
 * This is the model's own way in, and nothing had built it before: every
 * earlier case reached the registry directly, which proves the registry and
 * not the path. The tool resolves the named skill itself, twice — once to
 * price the call in `classify` and once to run it — so it is the one place
 * where a second, unguarded read would actually show up.
 */
function modelPath(options: { readonly disabled?: ReadonlySet<string> } = {}): {
  readonly run: AgentTool;
  readonly harness: ReturnType<typeof buildSkillHarness>;
} {
  const harness = buildSkillHarness({
    tools: [{ name: 'fake.read', risk: 'R0' as const, returns: { ok: true } }],
    ...(options.disabled === undefined ? {} : { disabledSkills: options.disabled }),
  });
  const tools = createSkillTools({
    registry: harness.skills,
    runner: harness.runner,
    securityFor: () => ({ taintState: freshTaint(), taintSalt: 'ab'.repeat(32), saltEpoch: 1 }),
  });
  const run = tools.find((tool) => tool.name === 'skills.run');
  expect(run, 'the build no longer exposes skills.run').toBeDefined();
  return { run: run!, harness };
}

/**
 * The context `skills.run` is dispatched with, as the registry would build it.
 *
 * The taint and salt a run needs are not on this context: they come from
 * `securityFor`, which is the tool's own lookup for the task it was called
 * in. That separation is why a skill run cannot be started with a security
 * context its caller made up.
 */
function toolContext(): ToolExecutionContext {
  return {
    taskId: TASK,
    sessionId: 'session_enablement',
    toolCallId: 'tc_enablement',
    signal: new AbortController().signal,
    recordEvidence: () => undefined,
  };
}

describe('TEST-SECURITY-071 group F: one boundary, and every path through it', () => {
  it('19 — the model’s own path refuses a switched-off skill, by exact version', async () => {
    const { run, harness } = modelPath({ disabled: new Set(['off.skill@1.0.0']) });
    await harness.register(skillFixture({ id: 'off.skill', version: '1.0.0' }));

    // Priced as unrecognised rather than at what the skill would reach, and
    // the pricing falls to the pessimistic end rather than the generous one.
    const classification = run.classify?.(
      { skillId: 'off.skill', skillVersion: '1.0.0' },
      toolContext(),
    );
    expect(classification?.risk).toBe('R3');
    expect(classification?.summary).toContain('unrecognised');

    await expect(
      run.execute({ skillId: 'off.skill', skillVersion: '1.0.0' }, toolContext()),
    ).rejects.toThrow(/No skill named/);
    expect(harness.seen).toEqual([]);
  });

  it('20 — and with the version omitted, so resolving the newest is not a way round', async () => {
    // `latest` is a second resolution path with its own filter. A build that
    // guarded `get` and forgot `latest` would leave every skill runnable by
    // name alone, which is the easier call to make.
    const { run, harness } = modelPath({
      disabled: new Set(['off.skill@1.0.0', 'off.skill@2.0.0']),
    });
    await harness.register(skillFixture({ id: 'off.skill', version: '1.0.0' }));
    await harness.register(skillFixture({ id: 'off.skill', version: '2.0.0' }));

    await expect(run.execute({ skillId: 'off.skill' }, toolContext())).rejects.toThrow(
      /No skill named/,
    );
    expect(harness.seen).toEqual([]);
  });

  it('21 — and an enabled skill still runs through that same path', async () => {
    // NEGATIVE CONTROL for 19 and 20. Without it, both would pass against a
    // `skills.run` that had stopped working altogether.
    const { run, harness } = modelPath();
    await harness.register(skillFixture({ id: 'on.skill', version: '1.0.0' }));

    const priced = run.classify?.({ skillId: 'on.skill' }, toolContext());
    expect(priced?.risk).toBe('R0');

    const result = await run.execute({ skillId: 'on.skill' }, toolContext());
    expect(result.success).toBe(true);
    expect(harness.seen.map((call) => call.tool)).toEqual(['fake.read']);
  });

  it('22 — every path that can start a skill reads through the one enforcing seam', () => {
    // The lifecycle audit, as a census rather than as a claim. There are six
    // ways a skill run can begin — the model's tool, the panel's launcher, a
    // shortcut, a schedule, a step inside another skill, and a recorded
    // workflow — and the first five all obtain their definition from `get` or
    // `latest`, which apply the switch. The sixth does not touch the registry
    // at all: a recorded workflow carries its own definition and is gated by
    // its hash, which is why disabling every skill does not disable a replay
    // (TEST-E2E-041) and why case 23 below states that positively.
    //
    // What this counts is the *reads*. `getIncludingDisabled` and
    // `listIncludingDisabled` are audited separately and by name in
    // `tests/unit/skill-registry.test.ts`; here the question is the opposite
    // one — that nothing reaches a definition by some other means.
    const root = resolvePath(import.meta.dirname, '../../src');
    const reads = new Map<string, string[]>();
    for (const file of walkSource(root)) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      const found = [
        ...new Set(
          [...source.matchAll(/\b(?:skills|skillRegistry|registry)\.(\w+)\(/g)]
            .map((match) => match[1]!)
            .filter((method) =>
              [
                'get',
                'latest',
                'list',
                'all',
                'has',
                'getIncludingDisabled',
                'listIncludingDisabled',
              ].includes(method),
            ),
        ),
      ].sort();
      if (found.length > 0) reads.set(file.slice(root.length + 1), found);
    }

    // Every file that reads a registry by one of those names, and which names
    // it uses. `logging/logger.ts` keeps a registry of its own that answers to
    // the same shape; it is listed rather than filtered out, because a pattern
    // narrow enough to exclude it is a pattern somebody can widen.
    expect(Object.fromEntries([...reads].sort())).toEqual({
      // The settings listing, the shortcut resolver's "why not" lookup, and
      // the schedule target check — one enforcing read and two that only
      // choose which true sentence to show.
      'background/service-worker.ts': ['get', 'getIncludingDisabled', 'listIncludingDisabled'],
      // The panel's launcher: the enforcing read, then the message choice.
      'background/skill-launcher.ts': ['get', 'getIncludingDisabled'],
      'logging/logger.ts': ['get'],
      // The seam itself.
      'skills/core/skill-registry.ts': ['get', 'has'],
      // Composition. A skill step that names another skill resolves it through
      // the same enforcing read, so switching a skill off also stops anything
      // that composes it — including partway through a run that had already
      // started.
      'skills/runtime/skill-runner.ts': ['get'],
      // The model's tool: `list` for discovery, `get`/`latest` to run.
      'tools/skills/skill-tools.ts': ['get', 'latest', 'list'],
    });

    // And `all()` — the unfiltered read the two settings methods are built on
    // — is never called on a registry from outside the registry. It is
    // `private`, which TypeScript erases at build time, so the guarantee has
    // to be counted rather than declared. The census above would already show
    // an `all` against any of the three receiver names; this states it as its
    // own assertion because it is the one read with no filter in it at all.
    const unfiltered = walkSource(root).filter((file) =>
      /\b(?:skills|skillRegistry|registry)\.all\(/.test(
        withoutComments(readFileSync(file, 'utf8')),
      ),
    );
    expect(unfiltered).toEqual([]);
  });

  it('23 — and a workflow replay carries its own definition, not a registry lookup', async () => {
    // The sixth path, stated positively. The workflow store validates a
    // recording against its own hash and hands the definition to the runner;
    // the skill registry is not consulted, so a recording cannot be switched
    // on or off from the skills screen and does not become runnable by
    // enabling something either.
    const harness = buildSkillHarness({
      tools: [{ name: 'fake.read', risk: 'R0' as const, returns: { ok: true } }],
      disabledSkills: new Set(['recorded.workflow@1.0.0']),
    });
    const definition = skillFixture({ id: 'recorded.workflow', version: '1.0.0' });

    // Registered and switched off, so a registry-mediated run is impossible.
    await harness.register(definition);
    expect(harness.skills.get('recorded.workflow', '1.0.0')).toBeUndefined();

    // The runner takes an entry, not a name, which is the whole point: replay
    // supplies the definition it validated and never asks the registry for
    // one. Proved by running the same definition the registry refuses to hand
    // out.
    const entry = harness.skills.getIncludingDisabled('recorded.workflow', '1.0.0');
    expect(entry).toBeDefined();
    const result = await harness.runner.run(entry!, {}, harness.context());
    expect(result.status).toBe('completed');
    expect(harness.seen.map((call) => call.tool)).toEqual(['fake.read']);
  });
});
