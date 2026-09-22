/**
 * What survives a service-worker eviction, and what must not.
 *
 * Chrome stops the worker constantly, including partway through a skill. The
 * record here is what a later worker generation reads to know that a run was
 * in progress and where it had got to.
 *
 * **What it deliberately does not hold** is the more important half. There are
 * no step results, no tool arguments, no page text, no file contents and no
 * credentials — not because a caller is trusted to leave them out, but because
 * `SkillRunRecord` has nowhere to put them and `assertRecordSafe` refuses a
 * record that grew a field anyway. A skill's intermediate results can contain
 * anything the task has read; writing them to disk so a run could resume would
 * turn a workflow feature into a second, unaudited copy of the page.
 *
 * The consequence is that a run is **not** resumed mid-flight. The record
 * exists so the extension can say what was interrupted and stop cleanly, not
 * so it can carry on as if nothing happened. Resuming would mean re-deriving
 * step three's arguments from step one's result, and that result is gone — by
 * design. Anything else would be resuming with a security state weaker than
 * the one the run started with.
 */
import { getLogger } from '@/logging/logger';
import { update, type TransactionalStorageArea } from '@/storage/storage-area';
import type { TaintState } from '@/security/taint/taint-state';

const log = getLogger('agent');

export type SkillRunState = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/**
 * One run, as it is persisted.
 *
 * Every field is either an identifier, a counter or a security state. None of
 * them is data the skill read or produced.
 */
export interface SkillRunRecord {
  readonly runId: string;
  readonly taskId: string;
  readonly skillId: string;
  /** The exact version this run bound to. A run never floats to a newer one. */
  readonly skillVersion: string;
  /** The definition hash at the moment the run started. */
  readonly skillHash: string;
  readonly stepIndex: number;
  readonly totalSteps: number;
  readonly state: SkillRunState;
  /**
   * The task's taint when the run was last written.
   *
   * Recorded so a recovering worker can tell that a run was under way with a
   * known provenance rather than assuming a clean one. It is never used to
   * *restore* taint — the task record owns that, and taking it from here
   * would be a second source of truth for the one property that must only
   * ever grow.
   */
  readonly taintState: TaintState;
  readonly startedAt: number;
  readonly updatedAt: number;
}

/** Field names a run record may never carry. */
const PROHIBITED_FIELDS: ReadonlySet<string> = new Set(
  [
    'accessToken',
    'access_token',
    'refreshToken',
    'refresh_token',
    'apiKey',
    'api_key',
    'clientSecret',
    'client_secret',
    'codeVerifier',
    'code_verifier',
    'authorizationCode',
    'authorization_code',
    'password',
    'credential',
    'credentials',
    'cookie',
    'cookies',
    'token',
    'secret',
    'authorization',
    // Not credentials, but step data: a result, a payload or a page's content
    // has no business being persisted for a workflow to resume from.
    'arguments',
    'args',
    'result',
    'results',
    'outputs',
    'payload',
    'content',
    'body',
    'inputs',
  ].map((name) => name.toLowerCase()),
);

export class ProhibitedSkillRecordFieldError extends Error {
  constructor(readonly field: string) {
    super(
      `A skill run record may not carry "${field}". The record tracks which skill was ` +
        'running and how far it got, never what it read or produced.',
    );
    this.name = 'ProhibitedSkillRecordFieldError';
  }
}

const MAX_RECORD_DEPTH = 6;

/**
 * Rejects a record that grew a field it should not have.
 *
 * Recursive, for the same reason the audit trail's check is: a top-level scan
 * is avoided by one level of nesting, and `{ detail: { result: pageText } }`
 * is exactly the shape a caller reaches for when a flat field is refused.
 */
export function assertRecordSafe(record: Record<string, unknown>): void {
  walkRecord(record, [], 0);
}

function walkRecord(value: unknown, path: readonly string[], depth: number): void {
  if (depth > MAX_RECORD_DEPTH) {
    throw new ProhibitedSkillRecordFieldError(path.join('.') || '(root)');
  }
  if (value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      walkRecord(item, [...path, String(index)], depth + 1);
    }
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (PROHIBITED_FIELDS.has(key.toLowerCase())) {
      throw new ProhibitedSkillRecordFieldError([...path, key].join('.'));
    }
    walkRecord(nested, [...path, key], depth + 1);
  }
}

const INDEX_KEY = 'skill-runs';
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RECORDS = 50;

interface RunIndex {
  readonly runs: SkillRunRecord[];
}

export class SkillRunStore {
  constructor(
    private readonly area: TransactionalStorageArea,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Records that a run has started, before its first step. */
  async start(
    record: Omit<SkillRunRecord, 'state' | 'startedAt' | 'updatedAt' | 'stepIndex'> & {
      stepIndex?: number;
    },
  ): Promise<SkillRunRecord> {
    const full: SkillRunRecord = {
      ...record,
      stepIndex: record.stepIndex ?? 0,
      state: 'running',
      startedAt: this.now(),
      updatedAt: this.now(),
    };
    assertRecordSafe(full as unknown as Record<string, unknown>);

    await update<RunIndex>(this.area, INDEX_KEY, { runs: [] }, (index) => ({
      runs: [full, ...this.fresh(index.runs).filter((run) => run.runId !== full.runId)].slice(
        0,
        MAX_RECORDS,
      ),
    }));
    return full;
  }

  /** Moves a run forward. Called before each step, so progress is durable. */
  async advance(runId: string, stepIndex: number, taintState: TaintState): Promise<void> {
    await this.patch(runId, (run) => ({ ...run, stepIndex, taintState }));
  }

  async settle(runId: string, state: Exclude<SkillRunState, 'running'>): Promise<void> {
    await this.patch(runId, (run) => ({ ...run, state }));
  }

  async get(runId: string): Promise<SkillRunRecord | undefined> {
    const index = (await this.area.get<RunIndex>(INDEX_KEY)) ?? { runs: [] };
    return index.runs.find((run) => run.runId === runId);
  }

  async list(taskId?: string): Promise<SkillRunRecord[]> {
    const index = (await this.area.get<RunIndex>(INDEX_KEY)) ?? { runs: [] };
    const runs = this.fresh(index.runs);
    return taskId === undefined ? runs : runs.filter((run) => run.taskId === taskId);
  }

  /**
   * Marks every run still labelled `running` as interrupted.
   *
   * Run once at worker startup. A record that says `running` in a fresh
   * worker generation is by definition a run whose worker died: nothing is
   * executing it, and leaving it marked `running` would let a later reader
   * conclude that something still is.
   */
  async reconcileAfterRestart(): Promise<SkillRunRecord[]> {
    const interrupted: SkillRunRecord[] = [];
    await update<RunIndex>(this.area, INDEX_KEY, { runs: [] }, (index) => ({
      runs: this.fresh(index.runs).map((run) => {
        if (run.state !== 'running') return run;
        const next: SkillRunRecord = {
          ...run,
          state: 'interrupted',
          updatedAt: this.now(),
        };
        interrupted.push(next);
        return next;
      }),
    }));

    if (interrupted.length > 0) {
      log.warn('Skill runs were interrupted by a worker restart.', {
        count: interrupted.length,
      });
    }
    return interrupted;
  }

  async forget(runId: string): Promise<void> {
    await update<RunIndex>(this.area, INDEX_KEY, { runs: [] }, (index) => ({
      runs: index.runs.filter((run) => run.runId !== runId),
    }));
  }

  private async patch(
    runId: string,
    mutate: (run: SkillRunRecord) => SkillRunRecord,
  ): Promise<void> {
    await update<RunIndex>(this.area, INDEX_KEY, { runs: [] }, (index) => ({
      runs: index.runs.map((run) =>
        run.runId === runId ? { ...mutate(run), updatedAt: this.now() } : run,
      ),
    }));
  }

  private fresh(runs: readonly SkillRunRecord[]): SkillRunRecord[] {
    return runs.filter((run) => this.now() - run.startedAt < RETENTION_MS);
  }
}

export type SkillResumeVerdict =
  | { readonly ok: true; readonly record: SkillRunRecord }
  | { readonly ok: false; readonly reason: SkillResumeRefusal; readonly detail: string };

export type SkillResumeRefusal =
  | 'NO_RECORD'
  | 'NOT_INTERRUPTED'
  | 'SKILL_GONE'
  | 'VERSION_CHANGED'
  | 'HASH_CHANGED'
  | 'SECURITY_STATE_UNKNOWN';

/**
 * Whether an interrupted run may be reported as safely resumable.
 *
 * Every refusal here is a case where continuing would mean running something
 * other than what the user approved, or running it under a security state
 * that cannot be established. A changed hash is the interesting one: the
 * skill's id and version are the same but its definition is not, which happens
 * when a build ships an edited skill without bumping its version. Trusting the
 * version alone would then silently execute different steps than the ones the
 * run started with.
 *
 * The hash comparison is between two values this extension computed, one now
 * and one when the run started. It is not a credential and nothing is accepted
 * because it matches — a match only permits what the registry already allows.
 */
export function assessResume(
  record: SkillRunRecord | undefined,
  current: { readonly hash: string; readonly version: string } | undefined,
): SkillResumeVerdict {
  if (!record) {
    return { ok: false, reason: 'NO_RECORD', detail: 'There is no record of that run.' };
  }
  if (record.state !== 'interrupted') {
    return {
      ok: false,
      reason: 'NOT_INTERRUPTED',
      detail: `That run is ${record.state}, so there is nothing to resume.`,
    };
  }
  if (!current) {
    return {
      ok: false,
      reason: 'SKILL_GONE',
      detail: 'The skill that run was using is no longer registered.',
    };
  }
  if (current.version !== record.skillVersion) {
    return {
      ok: false,
      reason: 'VERSION_CHANGED',
      detail: 'That skill is now a different version. Start the task again.',
    };
  }
  if (current.hash !== record.skillHash) {
    return {
      ok: false,
      reason: 'HASH_CHANGED',
      detail: 'That skill changed while the run was interrupted. Start the task again.',
    };
  }
  if (record.taintState.kind === 'UNKNOWN') {
    // What the task had read could not be established, so no later step's
    // egress decision could be made honestly. Resuming would be resuming
    // with less than was known before.
    return {
      ok: false,
      reason: 'SECURITY_STATE_UNKNOWN',
      detail:
        'What that task had read could not be established, so the run cannot safely continue.',
    };
  }
  return { ok: true, record };
}
