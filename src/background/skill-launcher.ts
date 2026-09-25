/**
 * Running a bundled skill because a person asked, rather than because a model
 * did.
 *
 * `skills.run` already exists as a tool, which is how a *model* reaches a
 * skill. This is the same destination reached from the other side: the side
 * panel, by explicit user action. It exists because P-021 lets a shortcut
 * name a bundled skill, and a shortcut is a user action — routing it through
 * the model would mean asking a model to please invoke something and hoping
 * it complied.
 *
 * It is not a second execution path and not a shortcut-specific engine. It
 * hands the same `RegisteredSkill` to the same `SkillRunner` that the tool
 * does, and every step dispatches through the one `ToolRegistry.dispatch`,
 * with its own risk, policy, permission, egress and evidence. What differs is
 * only who asked.
 *
 * Two things it deliberately refuses to be:
 *
 * **It takes an id, not a definition.** There is no parameter here that
 * accepts steps, tools, arguments or code, so nothing can describe a skill
 * into existence. An id the registry does not know is refused, never created.
 *
 * **It is not reachable by a model.** It is a panel route, not a tool. It
 * never enters `toCanonicalSchemas`, never appears in `skills.list`, and no
 * tool anywhere calls it.
 */
import { getLogger } from '@/logging/logger';
import { newTaskId, newToolCallId } from '@/utils/ids';
import { createTask, type AgentTask } from '@/tasks/task-model';
import type { TaskStore } from '@/tasks/task-store';
import type { PermissionMode } from '@/policy/policy-engine';
import type { TaintState } from '@/security/taint/taint-state';
import { taintSignature } from '@/security/egress/consent';
import type { RegisteredSkill, SkillRegistry } from '@/skills/core/skill-registry';
import {
  SkillInputError,
  type SkillRunner,
  type SkillRunResult,
} from '@/skills/runtime/skill-runner';

const log = getLogger('agent');

/**
 * What a user-launched skill run records as its provider.
 *
 * A run started this way consults no model — the steps are fixed by the
 * definition and nothing generates new ones — so naming a provider would
 * claim a dependency the run does not have. It is also worth being able to
 * read off the task record: no model output chose any of its arguments.
 */
export const LAUNCH_PROVIDER_ID = 'none';
export const LAUNCH_MODEL_ID = 'none';

export type LaunchRefusal = 'NOT_REGISTERED' | 'INPUTS_INVALID' | 'SKILL_DISABLED';

export type LaunchOutcome =
  | { readonly ok: true; readonly taskId: string; readonly result: SkillRunResult }
  | { readonly ok: false; readonly reason: LaunchRefusal; readonly detail: string };

export interface SkillLauncherOptions {
  readonly registry: SkillRegistry;
  readonly runner: SkillRunner;
  readonly tasks: TaskStore;
  readonly getPermissionMode: () => Promise<PermissionMode>;
  /**
   * The workspace this run acts in.
   *
   * User-initiated, so it resolves or creates a workspace around the tab the
   * user is on, exactly as starting a task does.
   */
  readonly resolveWorkspaceId?: () => Promise<string | undefined>;
  readonly getActiveTabId: () => Promise<number | undefined>;
  readonly publishSecurityContext: (
    taskId: string,
    context: {
      taintState: TaintState;
      taintSalt: string;
      saltEpoch: number;
      taintSignature: string;
    },
  ) => void;
  readonly onTaskChanged?: (task: AgentTask) => void;
  readonly now?: () => number;
}

export interface LaunchRequest {
  readonly skillId: string;
  readonly skillVersion: string;
  readonly sessionId: string;
  readonly inputs: Readonly<Record<string, unknown>>;
}

export class SkillLauncher {
  private readonly running = new Map<string, AbortController>();
  private readonly now: () => number;

  constructor(private readonly options: SkillLauncherOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Runs a registered skill as the user. Refuses anything unregistered. */
  async launch(request: LaunchRequest): Promise<LaunchOutcome> {
    // Pinned exactly, and resolved once. The registry is authoritative: a
    // skill is trusted because it shipped in the build and is in there.
    const skill: RegisteredSkill | undefined = this.options.registry.get(
      request.skillId,
      request.skillVersion,
    );
    if (!skill) {
      // `get` already refused, which is the enforcement. What follows only
      // decides which true sentence the user is shown: a skill they switched
      // off is not the same thing as one that does not exist, and telling
      // them the second sends them looking for a bug.
      if (this.options.registry.getIncludingDisabled(request.skillId, request.skillVersion)) {
        return {
          ok: false,
          reason: 'SKILL_DISABLED',
          detail:
            `The "${request.skillId}" workflow is switched off. Turn it back on in Settings ` +
            'to run it.',
        };
      }
      return {
        ok: false,
        reason: 'NOT_REGISTERED',
        detail: `There is no workflow called "${request.skillId}" at that version.`,
      };
    }

    const workspaceId = await this.options.resolveWorkspaceId?.();
    const task = createTask({
      id: newTaskId(),
      sessionId: request.sessionId,
      objective: `Run the "${skill.definition.name}" workflow.`,
      providerId: LAUNCH_PROVIDER_ID,
      modelId: LAUNCH_MODEL_ID,
      // The mode in force now, never one carried forward from anywhere.
      permissionMode: await this.options.getPermissionMode(),
      // A replay and a shortcut are *activations* — the user pointing at the
      // tab in front of them — so they resolve a workspace the same way
      // starting a task does. This is not a bypass of the boundary: the
      // resolved workspace is a real one, and every membership check below
      // runs against it unchanged. What it avoids is refusing the user's own
      // deliberate action on the page they are looking at.
      ...(workspaceId === undefined ? {} : { workspaceId }),
      now: this.now(),
    });
    await this.options.tasks.saveTask(task);
    this.options.onTaskChanged?.(task);

    const controller = new AbortController();
    this.running.set(task.id, controller);

    // A fresh task has read nothing.
    const security = {
      taintState: task.taintState,
      taintSalt: task.taintSalt,
      saltEpoch: task.saltEpoch,
    };
    this.options.publishSecurityContext(task.id, {
      ...security,
      taintSignature: await taintSignature(security.taintState),
    });
    await this.setState(task.id, 'RUNNING');

    const tabId = await this.options.getActiveTabId();
    let result: SkillRunResult;
    try {
      result = await this.options.runner.run(skill, request.inputs, {
        taskId: task.id,
        sessionId: request.sessionId,
        toolCallId: newToolCallId(),
        ...(tabId === undefined ? {} : { tabId }),
        ...security,
        signal: controller.signal,
      });
    } catch (error) {
      await this.setState(task.id, 'FAILED');
      if (error instanceof SkillInputError) {
        return { ok: false, reason: 'INPUTS_INVALID', detail: error.message };
      }
      throw error;
    } finally {
      this.running.delete(task.id);
    }

    if (result.taint.length > 0) {
      await this.options.tasks.appendTaint(task.id, result.taint);
    }
    await this.setState(
      task.id,
      result.status === 'completed'
        ? 'COMPLETED'
        : result.status === 'cancelled'
          ? 'CANCELLED'
          : result.status === 'refused'
            ? 'BLOCKED'
            : 'FAILED',
      result.summary,
    );

    log.info('A user-launched skill run finished.', {
      taskId: task.id,
      skill: `${result.skillId}@${result.skillVersion}`,
      status: result.status,
    });
    return { ok: true, taskId: task.id, result };
  }

  /** Stops a running launch. Steps already taken are not undone. */
  cancel(taskId: string): boolean {
    const controller = this.running.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private async setState(
    taskId: string,
    state: AgentTask['state'],
    summary?: string,
  ): Promise<void> {
    const updated = await this.options.tasks.updateTask(taskId, (task) => ({
      ...task,
      state,
      updatedAt: this.now(),
      ...(summary === undefined ? {} : { currentStepSummary: summary }),
      ...(state === 'RUNNING' ? { startedAt: this.now() } : { finishedAt: this.now() }),
    }));
    if (updated) this.options.onTaskChanged?.(updated);
  }
}
