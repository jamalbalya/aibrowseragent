/**
 * Turning a completed dispatch into an audit record (P-038).
 *
 * `ToolRegistry.dispatch` is the one execution authority, and this is the one
 * place a tool execution becomes an audit event. It sits on the observation
 * hook, which means it is handed a frozen, derived record of a call that has
 * already finished — so nothing here can affect the call it is describing.
 *
 * **It observes; it never authorises.** There is no path from this module to
 * a tool, a policy decision, a permission, an egress decision or a consent
 * record. It reads a value and writes a record. A failure to write is a gap
 * in the *record* of an execution that already happened, and must never be
 * reported as a failure of that execution.
 *
 * **It drops the arguments.** `DispatchObservation` carries the validated
 * arguments because the workflow recorder needs them; the audit trail must
 * not hold them, and the adapter is where they stop. Nothing below the field
 * list here reaches storage.
 */
import { getLogger } from '@/logging/logger';
import type { DispatchObservation } from '@/tools/registry/tool-registry';
import type { AuditLog, RecordableAuditEvent } from './audit-log';

const log = getLogger('agent');

export interface DispatchAuditOptions {
  readonly audit: AuditLog;
  /** The task's permission mode and taint kind, for context on the record. */
  readonly contextFor?: (taskId: string) => {
    readonly permissionMode?: string;
    readonly taintKind?: string;
  };
}

/**
 * Builds the observer the tool registry calls.
 *
 * Returns a plain function rather than a class because that is the whole of
 * it: one call in, one record out, nothing held between calls. It never
 * throws — the registry catches, but relying on that would make correctness
 * here somebody else's job.
 */
export function createDispatchAuditObserver(
  options: DispatchAuditOptions,
): (observation: DispatchObservation) => void {
  return (observation: DispatchObservation): void => {
    // Deliberately not awaited. The observation is already final and the
    // write is a record of it, so making the caller wait would put audit
    // latency on the execution path for no benefit.
    void writeRecord(options, observation).catch((error: unknown) => {
      // Never rethrown and never recorded as an audit event: recording a
      // failure to record is a recursion whose base case is the thing that
      // just failed. It goes to the redacted worker log.
      log.warn('A dispatch audit record could not be written.', {
        tool: observation.tool,
        error: error instanceof Error ? error.name : 'unknown',
      });
    });
  };
}

async function writeRecord(
  options: DispatchAuditOptions,
  observation: DispatchObservation,
): Promise<void> {
  const context = options.contextFor?.(observation.taskId) ?? {};

  // Every field is an identifier, a decision or a flag. `observation.actedOn`
  // and `observation.arguments` are both page-derived or caller-derived and
  // are read nowhere below.
  const event: RecordableAuditEvent = {
    type: observation.executed ? 'tool.invoked' : 'tool.refused',
    taskId: observation.taskId,
    tool: observation.tool,
    risk: observation.risk,
    outcome: observation.status === 'success' ? 'allowed' : 'denied',
    executed: observation.executed,
    ...(observation.errorCode === undefined ? {} : { code: observation.errorCode }),
    ...(observation.tabId === undefined ? {} : { tabId: observation.tabId }),
    // The site the authorization decision was taken about, as the registry
    // resolved it. Without it the trail could say a click happened and not
    // where, which is the question an audit is usually asked.
    ...(observation.site === undefined ? {} : { site: observation.site }),
    ...(context.permissionMode === undefined ? {} : { permissionMode: context.permissionMode }),
    ...(context.taintKind === undefined ? {} : { taintKind: context.taintKind }),
  };

  await options.audit.record(event);
}
