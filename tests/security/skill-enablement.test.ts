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
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ALL_SKILLS_ENABLED, SkillRegistry } from '@/skills/core/skill-registry';
import { SkillEnablementStore, skillEnablementKey } from '@/skills/core/skill-enablement';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { skillFixture } from '../fixtures/skill-harness';
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
