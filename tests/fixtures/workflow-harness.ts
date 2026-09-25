/**
 * A recorder, store and replayer over the real dispatch path.
 *
 * Everything above the fake tools is production code — the real
 * `ToolRegistry` with its real policy, permission and egress gates, the real
 * `SkillRunner`, the real validator. The claim these suites make is that a
 * recorded workflow cannot get past any of that, so stubbing any of it would
 * make the suite prove its own stub behaved.
 */
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { TaskStore } from '@/tasks/task-store';
import type { AgentTask } from '@/tasks/task-model';
import type { PermissionMode } from '@/policy/policy-engine';
import type { PermissionPrompter } from '@/policy/permission-engine';
import type { TaintState } from '@/security/taint/taint-state';
import type { DispatchObservation } from '@/tools/registry/tool-registry';
import { WorkflowStore } from '@/workflows/workflow-store';
import { WorkflowRecorder } from '@/workflows/workflow-recorder';
import { WorkflowReplayer, type WorkflowAuditEvent } from '@/workflows/workflow-replay';
import { buildSkillHarness, type FakeToolSpec, type SkillHarness } from './skill-harness';

export interface WorkflowHarness extends SkillHarness {
  readonly store: WorkflowStore;
  readonly recorder: WorkflowRecorder;
  readonly replayer: WorkflowReplayer;
  readonly tasks: TaskStore;
  /** Every observation the registry published, in dispatch order. */
  readonly observed: DispatchObservation[];
  readonly audited: WorkflowAuditEvent[];
  /** The taint the recorder will read for a task. */
  setTaint: (taint: TaintState | undefined) => void;
  /** Swaps the observer for one of the test's own, to probe the hook itself. */
  setObserver: (observer: ((observation: DispatchObservation) => void) | null) => void;
}

export interface WorkflowHarnessOptions {
  /** Skills the user has switched off, as `id@version`. See `HarnessOptions`. */
  readonly disabledSkills?: ReadonlySet<string>;
  readonly tools?: readonly FakeToolSpec[];
  readonly permissionMode?: PermissionMode;
  readonly taint?: TaintState;
  /** Puts production code in front of the scripted prompter. See `createHarness`. */
  readonly wrapPrompter?: (inner: PermissionPrompter) => PermissionPrompter;
  /**
   * Told about a task the moment the replayer or the launcher creates one.
   *
   * The same hook the service worker uses, so the scheduling suites learn
   * which task an unattended session produced exactly as production does.
   */
  readonly onTaskChanged?: (task: AgentTask) => void;
  /** Whether a task runs unattended. See `createHarness`. */
  readonly resolveUnattended?: (taskId: string) => Promise<boolean>;
}

export function buildWorkflowHarness(options: WorkflowHarnessOptions = {}): WorkflowHarness {
  const observed: DispatchObservation[] = [];
  const audited: WorkflowAuditEvent[] = [];
  let taint: TaintState | undefined = options.taint ?? { kind: 'KNOWN_UNTAINTED' };
  let observer: ((observation: DispatchObservation) => void) | null = null;

  const recorder = new WorkflowRecorder({ taintFor: () => taint });

  const skills = buildSkillHarness({
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
    ...(options.wrapPrompter === undefined ? {} : { wrapPrompter: options.wrapPrompter }),
    ...(options.resolveUnattended === undefined
      ? {}
      : { resolveUnattended: options.resolveUnattended }),
    ...(options.disabledSkills === undefined ? {} : { disabledSkills: options.disabledSkills }),
    onDispatched: (observation) => {
      observed.push(observation);
      if (observer) {
        observer(observation);
        return;
      }
      recorder.observe(observation);
    },
  });

  const store = new WorkflowStore({
    area: new SerializedStorageArea(new MemoryStorageArea()),
    riskOfTool: (name) => skills.tools.get(name)?.risk,
  });

  const tasks = new TaskStore(new SerializedStorageArea(new MemoryStorageArea()));

  const replayer = new WorkflowReplayer({
    store,
    runner: skills.runner,
    tools: skills.tools,
    tasks,
    getPermissionMode: () => Promise.resolve(options.permissionMode ?? 'auto'),
    getActiveTabId: () => Promise.resolve(undefined),
    publishSecurityContext: () => undefined,
    audit: (event) => {
      audited.push(event);
      return Promise.resolve();
    },
    ...(options.onTaskChanged === undefined ? {} : { onTaskChanged: options.onTaskChanged }),
  });

  return {
    ...skills,
    store,
    recorder,
    replayer,
    tasks,
    observed,
    audited,
    setTaint: (next) => {
      taint = next;
    },
    setObserver: (next) => {
      observer = next;
    },
  };
}
