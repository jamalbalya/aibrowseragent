/**
 * Task and session model (specification sections 18, 23, 54, 77).
 */
import type { RiskLevel } from '@/policy/risk-classifier';
import type { AgentError } from '@/types/result';
import type { PermissionMode } from '@/policy/policy-engine';
import type { TaintState } from '@/security/taint/taint-state';
import { freshTaint } from '@/security/taint/taint-state';
import type { AuthorizationModel, PlanApproval, PlanProposal } from '@/policy/plan-model';

export const TASK_STATES = [
  'QUEUED',
  'PLANNING',
  'RUNNING',
  'WAITING_FOR_TOOL',
  'WAITING_FOR_PERMISSION',
  'WAITING_FOR_USER',
  'PAUSED',
  'RECOVERING',
  'COMPLETED',
  'PARTIAL',
  'BLOCKED',
  'FAILED',
  'CANCELLED',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/** States from which no transition is possible. */
export const TERMINAL_STATES: readonly TaskState[] = [
  'COMPLETED',
  'PARTIAL',
  'BLOCKED',
  'FAILED',
  'CANCELLED',
];

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * Allowed transitions.
 *
 * Two invariants hold across this table, both enforced by tests:
 *
 *  - Every terminal state is reachable from every live state, so a task can
 *    always be cancelled or failed cleanly. This is the specification's
 *    "never leave a task permanently stuck in RUNNING" requirement.
 *  - PAUSED is reachable from every live state. Pausing aborts the runner, so
 *    a state that could not record the pause would be left with nothing
 *    executing it and no way back.
 */
export const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  QUEUED: ['PLANNING', 'PAUSED', 'CANCELLED', 'FAILED', 'BLOCKED'],
  PLANNING: [
    'RUNNING',
    'WAITING_FOR_USER',
    'PAUSED',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'BLOCKED',
  ],
  RUNNING: [
    'PLANNING',
    'WAITING_FOR_TOOL',
    'WAITING_FOR_PERMISSION',
    'WAITING_FOR_USER',
    'PAUSED',
    'RECOVERING',
    'COMPLETED',
    'PARTIAL',
    'BLOCKED',
    'FAILED',
    'CANCELLED',
  ],
  // WAITING_FOR_USER is reachable from here because a tool can legitimately
  // need a person: choosing a file in a picker is the first such tool, and
  // there is no timeout that can substitute for someone deciding.
  WAITING_FOR_TOOL: [
    'RUNNING',
    'WAITING_FOR_USER',
    'RECOVERING',
    'PAUSED',
    'FAILED',
    'CANCELLED',
    'BLOCKED',
  ],
  WAITING_FOR_PERMISSION: ['RUNNING', 'BLOCKED', 'PAUSED', 'FAILED', 'CANCELLED'],
  WAITING_FOR_USER: ['RUNNING', 'PLANNING', 'PAUSED', 'CANCELLED', 'FAILED', 'BLOCKED'],
  PAUSED: ['RUNNING', 'PLANNING', 'CANCELLED', 'FAILED'],
  RECOVERING: ['RUNNING', 'PLANNING', 'PAUSED', 'PARTIAL', 'FAILED', 'CANCELLED', 'BLOCKED'],
  COMPLETED: [],
  PARTIAL: [],
  BLOCKED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** A single recorded step in a task's execution history. */
export interface TaskStep {
  readonly id: string;
  readonly index: number;
  readonly kind: 'plan' | 'tool_call' | 'permission' | 'error' | 'message';
  readonly summary: string;
  readonly tool?: string;
  readonly risk?: RiskLevel;
  readonly status: 'pending' | 'success' | 'error' | 'denied' | 'cancelled';
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly evidenceIds?: readonly string[];
  readonly error?: AgentError;
}

/** Consumption counters checked against `ResourceBudget`. */
export interface TaskUsage {
  readonly toolCalls: number;
  readonly modelRequests: number;
  readonly retries: number;
  readonly screenshots: number;
  readonly externalWrites: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly elapsedMs: number;
}

export const emptyUsage = (): TaskUsage => ({
  toolCalls: 0,
  modelRequests: 0,
  retries: 0,
  screenshots: 0,
  externalWrites: 0,
  promptTokens: 0,
  completionTokens: 0,
  elapsedMs: 0,
});

/** A tab the task is working with (specification section 15). */
export interface AgentTabContext {
  readonly tabId: number;
  readonly role?: string;
  readonly url?: string;
  readonly origin?: string;
  readonly createdByAgent: boolean;
  readonly lastObservedAt: number;
}

export interface AgentTask {
  readonly id: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly state: TaskState;
  readonly providerId: string;
  /**
   * The connected account this task is bound to.
   *
   * Optional because tasks created before multi-account existed have none,
   * and a task without one still runs — it simply pins on the endpoint the
   * way it always did. New tasks always carry it.
   */
  readonly connectionId?: string;
  /**
   * The browser workspace this task may act in.
   *
   * Optional because tasks created before workspaces existed have none — and
   * those are **refused** browser operations rather than exempted from the
   * boundary, because exempting them would leave it open on exactly the tasks
   * most likely to have already used it. Nothing is deleted: the task, its
   * steps and its history stay, and it continues after an explicit restart.
   *
   * Independent of `connectionId`. Switching the AI brain never changes the
   * workspace, and switching workspace never changes the brain.
   */
  readonly workspaceId?: string;
  readonly modelId: string;
  readonly permissionMode: PermissionMode;
  /**
   * Which authorization shape this task runs under.
   *
   * Fixed at creation, like the workspace, because a task whose authorization
   * shape could change mid-run would be a task whose boundary depends on when
   * you asked. Absent means `cowork`, which is what every task before this
   * existed already did: each changing action is authorised on its own.
   */
  readonly authorizationModel?: AuthorizationModel;
  /**
   * What the model proposed, when this task plans first.
   *
   * Model output. It authorizes nothing, and no policy decision reads it —
   * `planApproval` below is the only record with authority. Kept on the task
   * so the panel can show the same proposal after the worker is evicted.
   */
  readonly planProposal?: PlanProposal;
  /**
   * What the person authorised.
   *
   * Task-scoped, and deliberately stored here rather than in the site policy:
   * a plan dies with its task, so it cannot outlive the objective it was
   * approved for, cannot be inherited by a scheduled firing (which creates its
   * own task), and cannot be exported — the task record is not portable.
   */
  readonly planApproval?: PlanApproval;
  /**
   * What the person asked to change about the last proposal.
   *
   * User-authored text, carried into the next proposal request. It steers what
   * the model suggests and nothing else: no authorization reads it.
   */
  readonly planRevisionNote?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly currentStepSummary?: string;
  readonly plan: readonly string[];
  readonly steps: readonly TaskStep[];
  readonly tabs: readonly AgentTabContext[];
  readonly usage: TaskUsage;
  /**
   * What this task has read, as a monotone task-level property.
   *
   * `UNKNOWN` after a restart that could not restore it, which the egress
   * gate treats as a denial rather than as an empty set.
   */
  readonly taintState: TaintState;
  /**
   * Per-task HMAC key for egress evidence digests.
   *
   * Hex-encoded 32 bytes. Evidence stores `HMAC(taskSalt, payload)` rather
   * than a bare digest, because a bare SHA-256 of a low-entropy payload — a
   * short code, an email address — is recoverable by brute force, and equal
   * digests across tasks would reveal that two payloads matched.
   */
  readonly taintSalt: string;
  /**
   * Bumped when a salt has to be regenerated. Digests are comparable within
   * an epoch and not across one, so evidence written under an earlier epoch
   * stays readable but is not claimed to be verifiable against the new salt.
   */
  readonly saltEpoch: number;
  readonly evidenceIds: readonly string[];
  readonly error?: AgentError;
  /** Set when the final outcome is recorded. */
  readonly result?: TaskResult;
}

/** Final result contract (specification section 77). */
export interface TaskResult {
  readonly outcome: 'COMPLETED' | 'PARTIAL' | 'BLOCKED' | 'FAILED' | 'CANCELLED';
  readonly summary: string;
  readonly completedActions: readonly string[];
  readonly failedActions: readonly string[];
  readonly blockedActions: readonly string[];
  readonly externalWrites: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface AgentSession {
  readonly id: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly permissionMode: PermissionMode;
  readonly activeTaskId?: string;
  readonly createdAt: number;
  readonly lastActiveAt: number;
}

export interface CreateTaskInput {
  readonly id: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly providerId: string;
  readonly connectionId?: string;
  readonly workspaceId?: string;
  readonly modelId: string;
  readonly permissionMode: PermissionMode;
  readonly authorizationModel?: AuthorizationModel;
  readonly now: number;
  /**
   * Hex-encoded 32-byte HMAC key for egress evidence.
   *
   * Generated here when omitted. Overridable so tests are deterministic —
   * never so a caller can supply a weak one in production.
   */
  readonly taintSalt?: string;
}

/**
 * A salt is 32 bytes, hex encoded.
 *
 * Validated by shape rather than trusted: a truncated or non-hex value read
 * back from storage would silently produce a weaker key, and a short key is
 * worse than an obviously absent one because it looks present.
 */
export function isValidTaintSalt(salt: unknown): salt is string {
  return typeof salt === 'string' && /^[0-9a-f]{64}$/.test(salt);
}

/** 32 random bytes, hex encoded. */
export function generateTaintSalt(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createTask(input: CreateTaskInput): AgentTask {
  return {
    id: input.id,
    sessionId: input.sessionId,
    objective: input.objective,
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    state: 'QUEUED',
    providerId: input.providerId,
    modelId: input.modelId,
    permissionMode: input.permissionMode,
    ...(input.authorizationModel === undefined
      ? {}
      : { authorizationModel: input.authorizationModel }),
    createdAt: input.now,
    updatedAt: input.now,
    plan: [],
    steps: [],
    tabs: [],
    usage: emptyUsage(),
    taintState: freshTaint(),
    taintSalt: input.taintSalt ?? generateTaintSalt(),
    saltEpoch: 1,
    evidenceIds: [],
  };
}

/**
 * Maps a terminal state to the outcome recorded in `TaskResult`.
 * Live states have no outcome, which is why the return type is nullable.
 */
export function outcomeForState(state: TaskState): TaskResult['outcome'] | null {
  switch (state) {
    case 'COMPLETED':
      return 'COMPLETED';
    case 'PARTIAL':
      return 'PARTIAL';
    case 'BLOCKED':
      return 'BLOCKED';
    case 'FAILED':
      return 'FAILED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'QUEUED':
    case 'PLANNING':
    case 'RUNNING':
    case 'WAITING_FOR_TOOL':
    case 'WAITING_FOR_PERMISSION':
    case 'WAITING_FOR_USER':
    case 'PAUSED':
    case 'RECOVERING':
      return null;
  }
}
