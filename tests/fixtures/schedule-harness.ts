/**
 * A schedule store and runner over the real execution pipeline.
 *
 * Everything above the fake tools is production code: the real `ScheduleStore`
 * with its real occurrence claim, the real `ScheduleRunner`, the real
 * `UnattendedPrompter` in front of the real `PermissionEngine`, the real
 * `ToolRegistry` with its real policy, permission and egress gates, the real
 * `SkillRunner`, `WorkflowStore`, `WorkflowReplayer`, `ShortcutStore` and
 * `SkillLauncher`.
 *
 * That matters more here than in most harnesses. The claim under test is that
 * a scheduled run **cannot** get past the confirmation boundary, and a suite
 * that stubbed the prompter would be proving that its own stub said no. Here
 * the scripted prompter is told to *approve* everything, and the denial has to
 * come from production code or not at all.
 */
import {
  MemoryStorageArea,
  SerializedStorageArea,
  type TransactionalStorageArea,
} from '@/storage/storage-area';
import type { PermissionPrompter } from '@/policy/permission-engine';
import { UnattendedPrompter } from '@/background/unattended-prompter';
import { ScheduleStore } from '@/schedules/schedule-store';
import {
  ScheduleRunner,
  type ScheduleAuditEvent,
  type ScheduleNotification,
  type ScheduledExecution,
  type TargetResolution,
} from '@/background/schedule-runner';
import { isUnattendedSessionId, type ScheduleTarget } from '@/schedules/schedule-model';
import { isIncomplete } from '@/workflows/workflow-model';
import { buildShortcutHarness, type ShortcutHarness } from './shortcut-harness';
import type { WorkflowHarnessOptions } from './workflow-harness';

export interface ScheduleHarness extends ShortcutHarness {
  readonly schedules: ScheduleStore;
  readonly scheduler: ScheduleRunner;
  /** Schedule audit events, kept apart from the workflow trail the base harness collects. */
  readonly scheduleAudit: ScheduleAuditEvent[];
  readonly notified: ScheduleNotification[];
  /** Every instant the runner asked Chrome to wake it at. `null` means cleared. */
  readonly wakeUps: (number | null)[];
  /**
   * The raw area behind the schedule store.
   *
   * Two suites need it, and neither reaches around a security control with
   * it: one points a schedule's clock at an instant so a daily cadence does
   * not take a day to test, and the other reads the bytes back to prove
   * nothing page-derived is in them. The occurrence claim is never touched.
   */
  readonly rawSchedules: TransactionalStorageArea;
  /** Everything the schedule store has written, as one string. */
  dumpSchedules: () => Promise<string>;
  /** Moves the harness clock. Everything reads time from here. */
  setNow: (at: number) => void;
  now: () => number;
}

export interface ScheduleHarnessOptions extends WorkflowHarnessOptions {
  /** The instant the harness starts at. */
  readonly startAt?: number;
}

/** A Monday, 09:00 local, chosen so weekday arithmetic is readable in tests. */
export const HARNESS_START = new Date(2026, 0, 5, 9, 0, 0, 0).getTime();

export function buildScheduleHarness(options: ScheduleHarnessOptions = {}): ScheduleHarness {
  let clock = options.startAt ?? HARNESS_START;
  const now = (): number => clock;

  const scheduleAudit: ScheduleAuditEvent[] = [];
  const notified: ScheduleNotification[] = [];
  const wakeUps: (number | null)[] = [];

  // The runner needs the harness's hooks and the hooks need the runner, so
  // the cycle is closed through this box rather than by forward-declaring
  // either one. Nothing reads it until a run is under way, which is long
  // after the runner is built.
  const late: { runner?: ScheduleRunner } = {};

  const base = buildShortcutHarness({
    ...options,
    // The same hook the worker uses: the runner learns which task an
    // unattended session produced the moment the task is created, which is
    // what makes an in-flight run cancellable.
    onTaskChanged: (task) => {
      late.runner?.observeTask(task.id, task.sessionId);
    },
    // The same fact the service worker gives the policy engine, read the
    // same way: from the durable task record, never from memory.
    resolveUnattended: async (taskId) => {
      const task = await base.tasks.getTask(taskId);
      return task === undefined || isUnattendedSessionId(task.sessionId);
    },
    wrapPrompter: (inner: PermissionPrompter) =>
      new UnattendedPrompter({
        interactive: inner,
        sessionOf: async (taskId) => (await base.tasks.getTask(taskId))?.sessionId,
        onUnattendedRefusal: (sessionId) => {
          late.runner?.noteConfirmationRefusal(sessionId);
        },
      }),
  });

  const rawSchedules = new SerializedStorageArea(new MemoryStorageArea());
  const schedules = new ScheduleStore({ area: rawSchedules, now });

  const resolveTarget = async (target: ScheduleTarget): Promise<TargetResolution> => {
    if (target.kind === 'shortcut') {
      const record = await base.shortcuts.get(target.shortcutId);
      if (!record) {
        return { ok: false, reason: 'TARGET_MISSING', detail: 'That shortcut is gone.' };
      }
      const verdict = await base.resolver.resolveRecord(record);
      if (!verdict.ok) {
        return {
          ok: false,
          reason: verdict.reason === 'TARGET_MISSING' ? 'TARGET_MISSING' : 'TARGET_UNUSABLE',
          detail: verdict.detail,
        };
      }
      return resolveTarget(
        verdict.resolution.targetKind === 'workflow'
          ? { kind: 'workflow', workflowId: verdict.resolution.targetId }
          : {
              kind: 'skill',
              skillId: verdict.resolution.targetId,
              skillVersion: verdict.resolution.targetVersion ?? '',
            },
      );
    }

    if (target.kind === 'workflow') {
      const record = await base.store.get(target.workflowId);
      if (!record) {
        return { ok: false, reason: 'TARGET_MISSING', detail: 'That workflow is gone.' };
      }
      if (isIncomplete(record)) {
        return { ok: false, reason: 'TARGET_UNUSABLE', detail: 'That recording is incomplete.' };
      }
      if (record.definition.inputs.some((input) => input.required)) {
        return { ok: false, reason: 'INPUTS_REQUIRED', detail: 'It asks for values when it runs.' };
      }
      return { ok: true, kind: 'workflow', workflowId: record.workflowId };
    }

    const entry = base.skills.get(target.skillId, target.skillVersion);
    if (!entry) {
      return { ok: false, reason: 'TARGET_MISSING', detail: 'That workflow is not registered.' };
    }
    if (entry.definition.inputs.some((input) => input.required)) {
      return { ok: false, reason: 'INPUTS_REQUIRED', detail: 'It asks for values when it runs.' };
    }
    return {
      ok: true,
      kind: 'skill',
      skillId: entry.definition.id,
      skillVersion: entry.definition.version,
    };
  };

  const asExecution = (outcome: {
    ok: boolean;
    taskId?: string;
    status?: string;
    reason?: string;
    detail?: string;
    steps?: readonly { error?: { code: string } }[];
  }): ScheduledExecution => {
    if (!outcome.ok || outcome.taskId === undefined) {
      return {
        ok: false,
        reason: outcome.reason === 'INPUTS_INVALID' ? 'INPUTS_REQUIRED' : 'TARGET_UNUSABLE',
        detail: outcome.detail ?? 'The run could not start.',
      };
    }
    const status = outcome.status;
    let refusal: 'POLICY_BLOCKED' | 'PERMISSION_DENIED' | undefined;
    for (const step of outcome.steps ?? []) {
      if (step.error?.code === 'POLICY_BLOCKED') {
        refusal = 'POLICY_BLOCKED';
        break;
      }
      if (step.error?.code === 'PERMISSION_DENIED') {
        refusal = 'PERMISSION_DENIED';
        break;
      }
    }
    return {
      ok: true,
      taskId: outcome.taskId,
      status:
        status === 'completed' || status === 'cancelled' || status === 'refused'
          ? status
          : 'failed',
      ...(refusal === undefined ? {} : { refusal }),
    };
  };

  const scheduler = new ScheduleRunner({
    store: schedules,
    now,
    resolveTarget,
    runWorkflow: async ({ workflowId, sessionId }) => {
      const outcome = await base.replayer.replay({ workflowId, sessionId, inputs: {} });
      return asExecution(
        outcome.ok
          ? {
              ok: true,
              taskId: outcome.taskId,
              status: outcome.result.status,
              steps: outcome.result.steps,
            }
          : { ok: false, reason: outcome.reason, detail: outcome.detail },
      );
    },
    runSkill: async ({ skillId, skillVersion, sessionId }) => {
      const outcome = await base.launcher.launch({ skillId, skillVersion, sessionId, inputs: {} });
      return asExecution(
        outcome.ok
          ? {
              ok: true,
              taskId: outcome.taskId,
              status: outcome.result.status,
              steps: outcome.result.steps,
            }
          : { ok: false, reason: outcome.reason, detail: outcome.detail },
      );
    },
    cancelTask: (taskId) => base.replayer.cancel(taskId) || base.launcher.cancel(taskId),
    audit: (event) => {
      scheduleAudit.push(event);
      return Promise.resolve();
    },
    notify: (event) => {
      notified.push(event);
    },
    setWakeUp: (at) => {
      wakeUps.push(at ?? null);
      return Promise.resolve();
    },
  });

  late.runner = scheduler;

  return {
    ...base,
    schedules,
    rawSchedules,
    dumpSchedules: async () => {
      const entries: unknown[] = [];
      for (const key of await rawSchedules.keys()) {
        entries.push({ key, value: await rawSchedules.get(key) });
      }
      return JSON.stringify(entries);
    },
    scheduler,
    scheduleAudit,
    notified,
    wakeUps,
    now,
    setNow: (at) => {
      clock = at;
    },
  };
}
