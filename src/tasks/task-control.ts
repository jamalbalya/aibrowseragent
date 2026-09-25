/**
 * Telling a pause apart from a cancellation.
 *
 * One `AbortController` per running task stops whatever is in flight, and for
 * a long time that was the whole story: `pause()` and `cancel()` both aborted
 * it and differed only in the state they wrote afterwards. The runtime saw an
 * aborted signal, could not tell which had happened, and terminated the task
 * as `CANCELLED` either way — after the manager had already written `PAUSED`.
 * So `task.pause` reported success and the task was cancelled a moment later,
 * and a cancelled task cannot be resumed. Pausing destroyed the task.
 *
 * The fix is to say which it was. `AbortController.abort()` takes a reason and
 * `AbortSignal.reason` carries it, so the signal that already reaches every
 * layer can carry the distinction with no new plumbing, no second signal and
 * no state for the two to disagree about.
 *
 * This module is deliberately tiny and owned by `tasks/`, so the runtime and
 * the manager can both read it without either depending on the other.
 */

/**
 * The reason a pause aborts with.
 *
 * A string rather than an Error: it crosses no boundary that would serialise
 * it, and a sentinel that is compared for equality cannot carry a stack, a
 * message someone might show a user, or anything page-derived.
 */
export const PAUSE_ABORT_REASON = 'aba:task-paused';

/**
 * Whether this signal was aborted because the task was paused.
 *
 * False for a cancellation, false for an abort nobody gave a reason, and false
 * for a signal that is not aborted at all — so every caller that asks this
 * question fails closed towards "cancelled", which is the outcome that stops
 * the task rather than the one that keeps it alive.
 */
export function abortedForPause(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === PAUSE_ABORT_REASON;
}
