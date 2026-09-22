/**
 * What a recorded workflow is (P-022).
 *
 * A recording is a `SkillDefinition` with a different provenance and an
 * envelope around it. That reuse is the point: one definition shape, one
 * validator, one runner, one dispatch. P-022 adds no execution code at all —
 * replay is the P-024 runner, unchanged.
 *
 * **A recording is not trusted, and does not need to be.** It authorises
 * nothing: every step is re-adjudicated at replay by the same gates that
 * adjudicated it when it was recorded. What a recording saves is the effort
 * of re-proposing the calls, not the permission to make them.
 *
 * That is why a recording is deliberately **not** registered in the
 * `SkillRegistry` and never appears in `skills.list`. Registration is what
 * makes something model-invokable, and the `bundled`-only rule there exists
 * because a human has to review the *combination* of tools a workflow
 * reaches. A user recording a workflow is not that review. Replay is
 * therefore an explicit user action and nothing else.
 */
import type { RiskLevel } from '@/policy/risk-classifier';
import type { SkillDefinition } from '@/skills/core/skill-model';

/** Bumped when the stored shape changes in a way an older reader cannot parse. */
export const WORKFLOW_FORMAT_VERSION = 1;

export type WorkflowState = 'recording' | 'stored';

/**
 * A recording as it is stored.
 *
 * The definition carries the steps; everything else here is identity, audit
 * linkage and the security facts a later replay needs in order to revalidate.
 * There is no field for step results, captured page text or outcomes — a
 * recording stores intent, never what happened.
 */
export interface RecordedWorkflow {
  readonly workflowId: string;
  /** Incremented on every semantic edit. A hash change without one is a bug. */
  readonly version: number;
  readonly formatVersion: number;
  readonly name: string;
  readonly description: string;
  /** The steps, as an ordinary skill definition. */
  readonly definition: SkillDefinition;
  /** Computed by the store over the canonical definition. Never accepted. */
  readonly definitionHash: string;
  /** Highest risk any step reaches, recomputed at replay. */
  readonly risk: RiskLevel;
  readonly tools: readonly string[];
  readonly recordedAt: number;
  readonly updatedAt: number;
  /** The task this was recorded from, for audit linkage only. */
  readonly recordedFromTaskId: string;
  /**
   * The task's taint *kind* when recording ran.
   *
   * The kind only — never the sources, which name sites the user visited.
   * It exists so a reader can see that a recording was made from a task that
   * had read something, which is what made its arguments parameters rather
   * than literals.
   */
  readonly taintAtCapture: 'KNOWN_UNTAINTED' | 'TAINTED' | 'UNKNOWN';
  /**
   * Steps the recorder saw but could not capture, in the positions they held.
   *
   * Persisted, not merely reported once at save time. A workflow missing a
   * step does something materially different from the task it was recorded
   * from — dropping the click out of "navigate, click Login, read" leaves
   * something that completes successfully having never logged in — so a
   * reader of a stored workflow has to be able to see the gap. Reporting it
   * only at the moment of saving would leave the record looking complete to
   * everyone who opened it afterwards.
   */
  readonly droppedSteps: readonly DroppedStep[];
  readonly state: WorkflowState;
}

/** One thing the recorder watched happen and could not write down. */
export interface DroppedStep {
  /**
   * The recorded step this one followed, or `null` when it came first.
   *
   * Position rather than an index, so a reader can show the gap where it
   * actually was rather than at the end of the list.
   */
  readonly afterStepId: string | null;
  readonly tool: string;
  /** Extension-authored, never quoting what could not be stored. */
  readonly reason: string;
}

/**
 * Whether a workflow is missing anything it watched.
 *
 * Derived rather than stored, so the two cannot disagree: there is no flag to
 * forget to set and none to clear while the dropped steps remain.
 */
export function isIncomplete(record: RecordedWorkflow): boolean {
  return record.droppedSteps.length > 0;
}

/** The provenance a recording carries. Never accepted by `SkillRegistry`. */
export const RECORDED_PROVENANCE = 'recorded' as const;

/**
 * Field names a stored workflow may never carry, at any depth.
 *
 * The same reasoning as the skill run store: a recording lives on disk, and
 * anything a workflow touched can contain whatever the task had read. The
 * check is recursive because a top-level scan is avoided by one level of
 * nesting, which is the shape a caller reaches for when a flat field is
 * refused.
 */
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
    'idToken',
    'id_token',
    'password',
    'passwd',
    'secret',
    'token',
    'credential',
    'credentials',
    'cookie',
    'cookies',
    'authorization',
    'session',
    // Not credentials, but task-derived data: a recording stores intent, so a
    // result, an output or a page's content has no business being in one.
    'result',
    'results',
    'outputs',
    'payload',
    'content',
    'body',
    'evidence',
  ].map((name) => name.toLowerCase()),
);

const MAX_WORKFLOW_DEPTH = 8;

export class ProhibitedWorkflowFieldError extends Error {
  constructor(readonly field: string) {
    super(
      `A stored workflow may not carry "${field}". A recording holds the steps it would ` +
        'take, never the data those steps read or produced.',
    );
    this.name = 'ProhibitedWorkflowFieldError';
  }
}

/**
 * Two places where a key is a name somebody chose, not a field carrying data.
 *
 * `definition.outputs` is the list of outputs a definition declares — names,
 * step ids and paths, authored by the definition rather than read from
 * anything. And the keys under a step's `arguments` are the *tool's* argument
 * names, so a tool with an argument called `password` or `body` would
 * otherwise make every recording of it unstorable — including the recordings
 * where the parameteriser correctly turned that argument into a runtime slot
 * and stored no value at all.
 *
 * The exemption is on the key check only. The walk continues into both, so a
 * data field nested inside either is still refused.
 */
function keyIsAName(path: readonly string[], key: string): boolean {
  if (path.length === 1 && path[0] === 'definition' && key === 'outputs') return true;
  return (
    path.length === 4 && path[0] === 'definition' && path[1] === 'steps' && path[3] === 'arguments'
  );
}

export class MisplacedProvenanceError extends Error {
  constructor(readonly path: string) {
    super(
      `A page-derived value appears at "${path}", which is not an element binding. ` +
        'Data read out of a page may be stored only as the match predicate of a binding ' +
        'tagged ELEMENT_BINDING, and never as a value anything would use.',
    );
    this.name = 'MisplacedProvenanceError';
  }
}

/**
 * Where a page-derived value is allowed to be, and nowhere else.
 *
 * This is the structural half of the persistence rule. The rule itself is not
 * an exception to the taint model: an element binding is not a literal, it is
 * a match predicate, and its strings never become a value anything is given.
 * What this refuses is the shape that *would* be an exception — a
 * `PAGE_DERIVED` tag turning up on a literal, an input default, an output
 * declaration or loose metadata, where something downstream would read it as
 * data.
 *
 * It refuses in both directions: a page-derived tag outside an element
 * binding, and an element binding that lost its tag.
 */
export function assertProvenancePlacement(value: Record<string, unknown>): void {
  walkProvenance(value, []);
}

function walkProvenance(value: unknown, path: readonly string[]): void {
  if (value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) walkProvenance(item, [...path, String(index)]);
    return;
  }

  const record = value as Record<string, unknown>;
  const isBinding = record['kind'] === 'element';
  const tagged = record['provenance'] === 'PAGE_DERIVED' || record['purpose'] === 'ELEMENT_BINDING';

  if (tagged && !isBinding) {
    // A tag somewhere a tag does not belong. Whatever produced this either
    // copied a binding's fields onto another value or is trying to launder
    // page text through a shape that is read as data.
    throw new MisplacedProvenanceError(path.join('.') || '(root)');
  }
  if (isBinding && record['provenance'] !== 'PAGE_DERIVED' && record['provenance'] !== 'AUTHORED') {
    throw new MisplacedProvenanceError(path.join('.') || '(root)');
  }
  if (isBinding && record['purpose'] !== 'ELEMENT_BINDING') {
    throw new MisplacedProvenanceError(path.join('.') || '(root)');
  }

  for (const [key, nested] of Object.entries(record)) {
    walkProvenance(nested, [...path, key]);
  }
}

/** Rejects a stored workflow carrying anything that must not reach disk. */
export function assertWorkflowSafe(value: Record<string, unknown>): void {
  walk(value, [], 0);
}

function walk(value: unknown, path: readonly string[], depth: number): void {
  if (depth > MAX_WORKFLOW_DEPTH) {
    throw new ProhibitedWorkflowFieldError(path.join('.') || '(root)');
  }
  if (value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) walk(item, [...path, String(index)], depth + 1);
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (PROHIBITED_FIELDS.has(key.toLowerCase()) && !keyIsAName(path, key)) {
      throw new ProhibitedWorkflowFieldError([...path, key].join('.'));
    }
    walk(nested, [...path, key], depth + 1);
  }
}

/**
 * Canonical JSON: object keys sorted at every level.
 *
 * So that two definitions that mean the same thing hash the same, and a
 * reformat never looks like an edit.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`);
  return `{${entries.join(',')}}`;
}
