/**
 * Where recordings live.
 *
 * The store owns three things no caller may supply: the canonical form of a
 * definition, its hash, and its version. A caller that could hand in a hash
 * could hand in one computed over something else, so the hash a record
 * carries is always one this class produced over the bytes it is about to
 * persist.
 *
 * Nothing here executes anything. Saving, updating and reading are storage
 * operations; the only thing that runs a workflow is an explicit replay, and
 * that lives elsewhere and goes through `SkillRunner`.
 */
import { newId } from '@/utils/ids';
import { hashContent } from '@/evidence/evidence-model';
import type { TransactionalStorageArea } from '@/storage/storage-area';
import { RecordStore } from '@/storage/record-store';
import type { PersistenceHealthStore } from '@/storage/persistence-health';
import {
  effectiveSkillRisk,
  validateSkillDefinition,
  toolsReachedBy,
  type SkillDefinition,
} from '@/skills/core/skill-model';
import type { RiskLevel } from '@/policy/risk-classifier';
import {
  assertProvenancePlacement,
  assertWorkflowSafe,
  canonicalJson,
  RECORDED_PROVENANCE,
  WORKFLOW_FORMAT_VERSION,
  type DroppedStep,
  type RecordedWorkflow,
} from './workflow-model';

const MAX_WORKFLOWS = 50;

/** The pre-local-first layout: one key holding every workflow. */
const LEGACY_BLOB_KEY = 'workflows';

/**
 * Accepts a stored workflow, or does not.
 *
 * Deliberately shape-only. Integrity — whether the stored definition still
 * canonicalises to its stored hash — is checked by `verifyIntegrity` before
 * every replay, and must stay there: a record that fails it should be
 * *listed and refused with a reason*, not silently absent from the panel.
 */
function isStorableWorkflow(candidate: unknown): candidate is RecordedWorkflow {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const record = candidate as Partial<RecordedWorkflow>;
  return (
    typeof record.workflowId === 'string' &&
    typeof record.definitionHash === 'string' &&
    typeof record.formatVersion === 'number' &&
    typeof record.definition === 'object' &&
    record.definition !== null
  );
}

export class WorkflowValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`This workflow cannot be stored — ${problems.join('; ')}`);
    this.name = 'WorkflowValidationError';
  }
}

export interface WorkflowStoreOptions {
  readonly area: TransactionalStorageArea;
  /** The risk of a registered tool, or `undefined` when it does not exist. */
  readonly riskOfTool: (name: string) => RiskLevel | undefined;
  readonly now?: () => number;
  readonly health?: PersistenceHealthStore;
}

export interface SaveWorkflowInput {
  readonly name: string;
  readonly description: string;
  readonly definition: SkillDefinition;
  readonly recordedFromTaskId: string;
  readonly taintAtCapture: RecordedWorkflow['taintAtCapture'];
  /** What the recorder watched happen and could not write down. */
  readonly droppedSteps?: readonly DroppedStep[];
}

export class WorkflowStore {
  private readonly now: () => number;
  private readonly records: RecordStore<RecordedWorkflow>;

  constructor(private readonly options: WorkflowStoreOptions) {
    this.now = options.now ?? (() => Date.now());
    this.records = new RecordStore<RecordedWorkflow>({
      area: options.area,
      kind: 'workflows',
      version: WORKFLOW_FORMAT_VERSION,
      identify: (record) => record.workflowId,
      validate: isStorableWorkflow,
      max: MAX_WORKFLOWS,
      // Upgrading from the single-value layout is automatic and happens on
      // first read. Nothing is re-signed or re-hashed on the way through:
      // a record moves as it was written, so `verifyIntegrity` still means
      // what it meant before the move.
      legacy: [
        {
          kind: 'blob',
          key: LEGACY_BLOB_KEY,
          version: WORKFLOW_FORMAT_VERSION,
          extract: (stored) =>
            typeof stored === 'object' &&
            stored !== null &&
            Array.isArray(
              (
                stored as {
                  workflows?: unknown;
                }
              ).workflows,
            )
              ? (stored as { workflows: readonly unknown[] }).workflows
              : [],
        },
      ],
      ...(options.health === undefined ? {} : { health: options.health }),
    });
  }

  /**
   * Validates a recording and stores it. Executes nothing.
   *
   * Worth stating because it is the lifecycle guarantee: this method persists
   * and returns. There is no path from here to `SkillRunner`, and nothing
   * about saving a recording causes its steps to run.
   */
  async save(input: SaveWorkflowInput): Promise<RecordedWorkflow> {
    const problems = this.validate(input.definition);
    if (problems.length > 0) throw new WorkflowValidationError(problems);

    const workflowId = newId('workflow');
    const record = await this.build(workflowId, 1, input);

    await this.records.put(record);
    return record;
  }

  /**
   * Replaces a stored workflow's definition. Executes nothing.
   *
   * A semantic edit always produces a new canonical form, a new hash and a
   * new version, and is fully revalidated — there is no in-place mutation
   * that would leave a hash describing something the record no longer holds.
   */
  async update(workflowId: string, input: SaveWorkflowInput): Promise<RecordedWorkflow> {
    const existing = await this.get(workflowId);
    if (!existing) throw new WorkflowValidationError(['that workflow does not exist']);

    const problems = this.validate(input.definition);
    if (problems.length > 0) throw new WorkflowValidationError(problems);

    const record = await this.build(workflowId, existing.version + 1, input);
    // In place: editing a workflow does not make it the newest one.
    await this.records.replace(record);
    return record;
  }

  async get(workflowId: string): Promise<RecordedWorkflow | undefined> {
    return this.records.get(workflowId);
  }

  async list(): Promise<RecordedWorkflow[]> {
    return [...(await this.records.list())];
  }

  async remove(workflowId: string): Promise<void> {
    await this.records.remove(workflowId);
  }

  /**
   * Re-derives the hash from what is stored and compares.
   *
   * Called before every replay. A record whose stored definition no longer
   * canonicalises to its stored hash was altered underneath the store — by a
   * partial write, or by something editing extension storage directly — and
   * replaying it would run steps nobody recorded.
   */
  async verifyIntegrity(record: RecordedWorkflow): Promise<boolean> {
    return (await this.canonicalHash(record.definition)) === record.definitionHash;
  }

  /**
   * The full validation a definition must pass, at save and before replay.
   *
   * Storage-time validation alone is never enough: tools are removed between
   * a recording and its replay, and schemas change under them.
   */
  validate(definition: SkillDefinition): string[] {
    const problems = validateSkillDefinition(definition, {
      hasTool: (name) => this.options.riskOfTool(name) !== undefined,
      // A recording is storable, and only a recording. `bundled` belongs to
      // the registry; a model-written or imported definition belongs nowhere.
      allowProvenance: [RECORDED_PROVENANCE],
    });

    // Composition is not recorded: a recording captures tool calls, and a
    // step naming another workflow would be a reference this store cannot
    // resolve or version.
    for (const step of definition.steps) {
      if (step.kind !== 'tool') {
        problems.push(`step "${step.id}" is not a tool call, which a recording cannot hold`);
      }
    }

    // Checked here as well as before disk, because `validate` is what runs
    // again before every replay: a record that acquired a misplaced
    // page-derived value after it was stored must not run.
    try {
      assertProvenancePlacement(definition as unknown as Record<string, unknown>);
    } catch (error) {
      problems.push(
        error instanceof Error ? error.message : 'a page-derived value is in the wrong place',
      );
    }
    return problems;
  }

  private async build(
    workflowId: string,
    version: number,
    input: SaveWorkflowInput,
  ): Promise<RecordedWorkflow> {
    const resolve = (): undefined => undefined;
    const record: RecordedWorkflow = {
      workflowId,
      version,
      formatVersion: WORKFLOW_FORMAT_VERSION,
      name: input.name,
      description: input.description,
      definition: input.definition,
      definitionHash: await this.canonicalHash(input.definition),
      risk: effectiveSkillRisk(input.definition, this.options.riskOfTool, resolve),
      tools: toolsReachedBy(input.definition, resolve),
      recordedAt: this.now(),
      updatedAt: this.now(),
      recordedFromTaskId: input.recordedFromTaskId,
      taintAtCapture: input.taintAtCapture,
      droppedSteps: input.droppedSteps ?? [],
      state: 'stored',
    };

    // The last two gates before disk. The first refuses a record that grew a
    // field for a credential or a page's text; the second refuses a
    // page-derived value anywhere other than the one place it is allowed —
    // the match predicate of an element binding.
    assertWorkflowSafe(record as unknown as Record<string, unknown>);
    assertProvenancePlacement(record as unknown as Record<string, unknown>);
    return record;
  }

  /** Store-computed, over the canonical form. Never taken from a caller. */
  private async canonicalHash(definition: SkillDefinition): Promise<string> {
    return await hashContent(canonicalJson(canonicalDefinition(definition)));
  }
}

/**
 * Everything that decides what a workflow does, and nothing that does not.
 *
 * Renaming a workflow leaves the hash alone; changing a step, an argument or
 * a declared tool changes it.
 */
function canonicalDefinition(definition: SkillDefinition): Record<string, unknown> {
  return {
    id: definition.id,
    version: definition.version,
    risk: definition.risk,
    provenance: definition.provenance,
    requiredTools: [...definition.requiredTools].sort(),
    requiredConnectors: [...definition.requiredConnectors].sort(),
    inputs: definition.inputs.map((entry) => ({
      name: entry.name,
      type: entry.type,
      required: entry.required,
      ...(entry.maxLength === undefined ? {} : { maxLength: entry.maxLength }),
    })),
    outputs: definition.outputs.map((entry) => ({
      name: entry.name,
      step: entry.step,
      path: entry.path,
    })),
    steps: definition.steps.map((step) => ({
      kind: step.kind,
      id: step.id,
      ...(step.kind === 'tool' ? { tool: step.tool } : { skill: step.skill }),
      optional: step.optional === true,
      arguments: step.arguments,
    })),
  };
}
