/**
 * Resource budgets (specification sections 27, 75).
 *
 * Budgets bound both safety and cost. Exhaustion produces a structured
 * failure, never a silent stop.
 */
import type { TaskUsage } from '@/tasks/task-model';

export interface ResourceBudget {
  readonly maxDurationMs: number;
  readonly maxToolCalls: number;
  readonly maxModelRequests: number;
  readonly maxRetries: number;
  readonly maxScreenshots: number;
  readonly maxExternalWrites: number;
  readonly maxTotalTokens: number;
}

export const DEFAULT_BUDGET: ResourceBudget = {
  maxDurationMs: 10 * 60 * 1000,
  maxToolCalls: 60,
  maxModelRequests: 40,
  maxRetries: 12,
  maxScreenshots: 20,
  maxExternalWrites: 10,
  maxTotalTokens: 400_000,
};

export type BudgetDimension =
  | 'duration'
  | 'toolCalls'
  | 'modelRequests'
  | 'retries'
  | 'screenshots'
  | 'externalWrites'
  | 'tokens';

export interface BudgetCheck {
  readonly exhausted: boolean;
  readonly dimension?: BudgetDimension;
  readonly detail?: string;
}

export function checkBudget(usage: TaskUsage, budget: ResourceBudget): BudgetCheck {
  const over = (
    dimension: BudgetDimension,
    used: number,
    limit: number,
    unit: string,
  ): BudgetCheck | null =>
    used >= limit
      ? {
          exhausted: true,
          dimension,
          detail: `Budget exhausted: ${used} of ${limit} ${unit} used.`,
        }
      : null;

  return (
    over('duration', usage.elapsedMs, budget.maxDurationMs, 'ms of runtime') ??
    over('toolCalls', usage.toolCalls, budget.maxToolCalls, 'tool calls') ??
    over('modelRequests', usage.modelRequests, budget.maxModelRequests, 'model requests') ??
    over('retries', usage.retries, budget.maxRetries, 'retries') ??
    over('screenshots', usage.screenshots, budget.maxScreenshots, 'screenshots') ??
    over('externalWrites', usage.externalWrites, budget.maxExternalWrites, 'external writes') ??
    over(
      'tokens',
      usage.promptTokens + usage.completionTokens,
      budget.maxTotalTokens,
      'tokens',
    ) ?? { exhausted: false }
  );
}
