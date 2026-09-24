/**
 * The confirmation boundary, for a run nobody is watching.
 *
 * `PermissionBroker` asks the side panel and waits. That is the right
 * behaviour when a person is there and the wrong one when nobody is: a
 * scheduled run that raised a prompt would sit for five minutes and then be
 * denied by the broker's own timeout, which is the right answer arrived at
 * slowly, by accident, and without anybody being told why.
 *
 * This wrapper answers immediately and deliberately. It is a **filter in
 * front of the one prompter**, not a second permission path: it evaluates no
 * policy, classifies no risk, and can only ever turn a question into a
 * denial. Everything it does not deny it hands to the interactive prompter
 * unchanged.
 *
 * ## Why the decision is read from the task record
 *
 * Whether a run is unattended is a durable fact about the run, so it is read
 * from a durable place. The task's `sessionId` carries it — a scheduled run
 * executes under `unattended_<runId>`, a prefix `newSessionId()` cannot
 * produce — and the task record survives the worker eviction that would take
 * any in-memory registry with it. A run that wakes on the other side of an
 * eviction is therefore still unattended, rather than silently becoming
 * interactive because the worker forgot.
 *
 * ## Fail closed, in all three directions
 *
 * A task that cannot be found, a store that throws, and a session that is
 * unattended all produce the same answer: deny. The alternative — treating an
 * unreadable task as attended and raising a prompt into a panel nobody has
 * open — would resolve as a denial five minutes later anyway, but only after
 * a window in which a person who *did* have the panel open could approve an
 * action that a scheduled run asked for.
 */
import { getLogger } from '@/logging/logger';
import type {
  PermissionPrompter,
  PermissionRequest,
  PermissionResponse,
} from '@/policy/permission-engine';
import { isUnattendedSessionId } from '@/schedules/schedule-model';

const log = getLogger('permission');

export interface UnattendedPrompterOptions {
  /** The prompter used when a person is there. */
  readonly interactive: PermissionPrompter;
  /** Reads the session a task belongs to, from the durable task record. */
  readonly sessionOf: (taskId: string) => Promise<string | undefined>;
  /**
   * Told that an unattended run reached the confirmation boundary.
   *
   * Carries the session and the canonical tool name, and nothing else. It is
   * an observer: it cannot change the denial, and a throw from it is
   * swallowed rather than allowed to turn a denial into an error.
   */
  readonly onUnattendedRefusal?: (sessionId: string, tool: string) => void;
}

export class UnattendedPrompter implements PermissionPrompter {
  constructor(private readonly options: UnattendedPrompterOptions) {}

  async prompt(request: PermissionRequest): Promise<PermissionResponse> {
    let sessionId: string | undefined;
    try {
      sessionId = await this.options.sessionOf(request.taskId);
    } catch (error) {
      log.warn('Could not read the task behind a permission request; denying.', {
        tool: request.tool,
        error: error instanceof Error ? error.message : String(error),
      });
      return { kind: 'deny' };
    }

    if (sessionId === undefined) {
      log.warn('A permission request named a task that is not stored; denying.', {
        tool: request.tool,
      });
      return { kind: 'deny' };
    }

    if (!isUnattendedSessionId(sessionId)) {
      return this.options.interactive.prompt(request);
    }

    log.info('An unattended run reached the confirmation boundary and was stopped.', {
      tool: request.tool,
      risk: request.risk,
    });
    try {
      this.options.onUnattendedRefusal?.(sessionId, request.tool);
    } catch (error) {
      // A record of the refusal is not the refusal.
      log.debug('An unattended-refusal observer threw and was ignored.', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
    return { kind: 'deny' };
  }
}
