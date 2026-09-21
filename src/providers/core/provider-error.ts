/**
 * Structured provider failures.
 *
 * Lives in `providers/core` rather than in any one adapter: the agent runtime
 * must be able to understand a failure from *every* provider without importing
 * from a specific adapter. An adapter that threw its own error class would
 * otherwise have its error code and retry classification silently downgraded
 * to a generic model error.
 */
import type { AgentError } from '@/types/result';

export class ProviderRequestError extends Error {
  constructor(readonly agentError: AgentError) {
    super(agentError.message);
    this.name = 'ProviderRequestError';
  }
}

/**
 * Structural check rather than `instanceof`.
 *
 * Adapters may be bundled separately, and a duplicated class identity across
 * bundles would make `instanceof` fail for an error that is perfectly valid.
 */
export function isProviderRequestError(error: unknown): error is { agentError: AgentError } {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = (error as { agentError?: unknown }).agentError;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as AgentError).code === 'string' &&
    typeof (candidate as AgentError).userMessage === 'string'
  );
}
