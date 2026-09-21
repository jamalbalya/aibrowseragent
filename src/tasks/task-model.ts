/**
 * Task and session model (specification sections 18, 23, 54, 77).
 */
import type { RiskLevel } from '@/policy/risk-classifier';
import type { AgentError } from '@/types/result';
import type { PermissionMode } from '@/policy/policy-engine';
import type { TaintSource } from '@/security/exfiltration/exfiltration-guard';

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
  WAITING_FOR_TOOL: ['RUNNING', 'RECOVERING', 'PAUSED', 'FAILED', 'CANCELLED', 'BLOCKED'],
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
  readonly modelId: string;
  readonly permissionMode: PermissionMode;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly currentStepSummary?: string;
  readonly plan: readonly string[];
  readonly steps: readonly TaskStep[];
  readonly tabs: readonly AgentTabContext[];
  readonly usage: TaskUsage;
  /** Sources this task has read from, used by the exfiltration guard. */
  readonly taint: readonly TaintSource[];
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
  readonly modelId: string;
  readonly permissionMode: PermissionMode;
  readonly now: number;
}

export function createTask(input: CreateTaskInput): AgentTask {
  return {
    id: input.id,
    sessionId: input.sessionId,
    objective: input.objective,
    state: 'QUEUED',
    providerId: input.providerId,
    modelId: input.modelId,
    permissionMode: input.permissionMode,
    createdAt: input.now,
    updatedAt: input.now,
    plan: [],
    steps: [],
    tabs: [],
    usage: emptyUsage(),
    taint: [],
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
