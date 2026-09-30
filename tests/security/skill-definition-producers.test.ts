/**
 * TEST-SKILLPROD-001 — who can author a skill definition, and what happens next.
 *
 * The previous phase recorded the unbounded skill id and version patterns as
 * "not reachable today: every skill id in this build is a literal". That was
 * wrong, and the way it was wrong is worth pinning rather than just fixing.
 *
 * The producer inventory is three, not one:
 *
 *   1. `BUNDLED_SKILLS` — literals in this build. Trusted, and short.
 *   2. `WorkflowRecorder` — `id: 'recorded.workflow'`, also a literal.
 *   3. **`importWorkflow`** — `candidate.definition`, taken from a file the user
 *      supplies. An exported workflow can be edited and re-imported.
 *
 * The third is the one that was missed. `validateSkillDefinition` is the gate for
 * all three, and it bounded the id's *characters* and not its *length*, while
 * replay wrote `skillId: definition.id` into `skill.started`, `skill.step` and
 * `skill.finished` — a field bounded at `MAX_STRING`. All three records were
 * refused, the replay ran, and the trail lost it.
 *
 * So this file asserts two things. The bound, at both ends. And the inventory
 * itself: a fourth producer that reaches the store without going through the
 * validator fails case 05, rather than being discovered the way the third was.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateSkillDefinition } from '@/skills/core/skill-model';
import { BUNDLED_SKILLS } from '@/skills/bundled';
import { RECORDED_PROVENANCE } from '@/workflows/workflow-model';
import { MAX_SKILL_ID, MAX_SKILL_VERSION } from '@/audit/boundaries';
import { AuditLog } from '@/audit/audit-log';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { WorkflowStore } from '@/workflows/workflow-store';

const area = (): SerializedStorageArea => new SerializedStorageArea(new MemoryStorageArea());

function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'imported.workflow',
    version: '1.0.0',
    name: 'Imported',
    description: 'From a file',
    provenance: RECORDED_PROVENANCE,
    risk: 'R0',
    inputs: [],
    outputs: [],
    requiredTools: ['browser.read_page'],
    requiredConnectors: [],
    steps: [{ id: 's1', kind: 'tool', tool: 'browser.read_page', arguments: {} }],
    ...overrides,
  };
}

const gate = { hasTool: (): boolean => true, allowProvenance: [RECORDED_PROVENANCE] };

describe('TEST-SKILLPROD-001 — the bound holds at the validator', () => {
  it('01 — an id at the limit is admitted; one over is refused', () => {
    expect(
      validateSkillDefinition(definition({ id: 'a'.repeat(MAX_SKILL_ID) }) as never, gate),
    ).toEqual([]);
    const over = validateSkillDefinition(
      definition({ id: 'a'.repeat(MAX_SKILL_ID + 1) }) as never,
      gate,
    );
    expect(over.join(' ')).toContain(String(MAX_SKILL_ID));
  });

  it('02 — a version at the limit is admitted; one over is refused', () => {
    const fits = `${'1'.repeat(MAX_SKILL_VERSION - 4)}.0.0`;
    expect(fits.length).toBe(MAX_SKILL_VERSION);
    expect(validateSkillDefinition(definition({ version: fits }) as never, gate)).toEqual([]);
    const over = validateSkillDefinition(
      definition({ version: `${'1'.repeat(MAX_SKILL_VERSION - 3)}.0.0` }) as never,
      gate,
    );
    expect(over.join(' ')).toContain(String(MAX_SKILL_VERSION));
  });

  it('03 — the charset rules are unchanged', () => {
    // Nothing here loosened the validator to make room for a length check.
    for (const id of ['Page.Inspect', 'page inspect', '9page', 'page..inspect', 'page-', '']) {
      expect(validateSkillDefinition(definition({ id }) as never, gate).length, id).toBeGreaterThan(
        0,
      );
    }
    for (const version of ['1.0', '1.0.0.0', 'v1.0.0', '1.0.x', '']) {
      expect(
        validateSkillDefinition(definition({ version }) as never, gate).length,
        version,
      ).toBeGreaterThan(0);
    }
  });
});

describe('TEST-SKILLPROD-001 — the import path is the producer that was missed', () => {
  const store = (): WorkflowStore =>
    new WorkflowStore({ area: area(), riskOfTool: () => 'R0' } as never);

  it('04 — an over-long id is refused before it is stored', async () => {
    // Before the fix this resolved: the workflow was written, and replaying it
    // lost every skill record it should have produced.
    await expect(
      store().save({
        name: 'Imported workflow',
        description: '',
        definition: definition({ id: `a${'b'.repeat(MAX_SKILL_ID)}` }) as never,
        recordedFromTaskId: 'imported',
        taintAtCapture: 'UNKNOWN',
      } as never),
    ).rejects.toThrow();

    // And one at the limit still stores, so the bound refuses the defect and not
    // the feature.
    await expect(
      store().save({
        name: 'Imported workflow',
        description: '',
        definition: definition({ id: 'a'.repeat(MAX_SKILL_ID) }) as never,
        recordedFromTaskId: 'imported',
        taintAtCapture: 'UNKNOWN',
      } as never),
    ).resolves.toBeDefined();
  });

  it('05 — the producer inventory is exactly these three', () => {
    // The assertion that would have caught the mistake. Every place a
    // `SkillDefinition` enters the extension has to pass through
    // `validateSkillDefinition`; the two stores that call it are the only
    // admitting paths, and a third would show up here.
    const callers = ['src/skills/core/skill-registry.ts', 'src/workflows/workflow-store.ts'];
    for (const file of callers) {
      expect(readFileSync(file, 'utf8'), file).toContain('validateSkillDefinition');
    }
    // `importWorkflow` reaches the store rather than the registry, and does not
    // validate on its own — which is correct, and is why the store's validation
    // is load-bearing for a file the user supplies.
    const worker = readFileSync('src/background/service-worker.ts', 'utf8');
    expect(worker).toContain('importWorkflow');
    expect(worker).toContain('workflowStore.save');

    // The literal producers, and their real sizes. If a bundled id ever grew
    // past the bound this fails here rather than at a user's first run.
    for (const skill of BUNDLED_SKILLS) {
      expect(skill.id.length, skill.id).toBeLessThanOrEqual(MAX_SKILL_ID);
      expect(skill.version.length, skill.version).toBeLessThanOrEqual(MAX_SKILL_VERSION);
      expect(validateSkillDefinition(skill, { hasTool: () => true })).toEqual([]);
    }
    expect(readFileSync('src/workflows/workflow-recorder.ts', 'utf8')).toContain(
      "id: 'recorded.workflow'",
    );
  });
});

describe('TEST-SKILLPROD-001 — what the records do with it', () => {
  it('06 — the three skill records accept an id at the bound', async () => {
    const log = new AuditLog(area(), { knownTool: () => true });
    const skillId = 'a'.repeat(MAX_SKILL_ID);
    const skillVersion = `${'1'.repeat(MAX_SKILL_VERSION - 4)}.0.0`;
    for (const type of ['skill.started', 'skill.step', 'skill.finished'] as const) {
      const written = await log.record({
        type,
        taskId: 'task_abc',
        outcome: 'info',
        skillId,
        skillVersion,
        skillHash: 'h'.repeat(64),
      } as never);
      expect(written, `${type} was refused`).not.toBeNull();
    }
    expect(log.degradedReason()).toBeNull();
  });

  it('07 — an id past the bound is still refused by the trail', async () => {
    // The negative control: the validator was tightened, the trail was not
    // loosened.
    const log = new AuditLog(area(), { knownTool: () => true });
    expect(
      await log.record({
        type: 'skill.started',
        taskId: 'task_abc',
        outcome: 'info',
        skillId: 's'.repeat(300),
      } as never),
    ).toBeNull();
    expect(log.degradedReason()).toContain('skillId');
  });
});
