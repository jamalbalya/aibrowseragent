/**
 * Durable task + session persistence (specification sections 24, 52, 55, 90).
 *
 * Tasks survive side-panel close, service-worker eviction and browser restart.
 * Nothing secret is written here: provider credentials live in their own store
 * and are never copied into a task record.
 */
import { update, type StorageArea } from '@/storage/storage-area';
import { getLogger } from '@/logging/logger';
import type { AgentSession, AgentTask, TaskState } from './task-model';
import { isTerminal } from './task-model';
import type { TaintSource } from '@/security/exfiltration/exfiltration-guard';
import type { TaintState } from '@/security/taint/taint-state';
import { addTaint, parseTaintState, unknownTaint } from '@/security/taint/taint-state';

const log = getLogger('storage');

const TASK_INDEX_KEY = 'task-index';
const SESSION_INDEX_KEY = 'session-index';
const taskKey = (id: string): string => `task:${id}`;
const sessionKey = (id: string): string => `session:${id}`;

/** Newest-first list of task ids, capped so storage cannot grow without bound. */
interface TaskIndex {
  readonly ids: readonly string[];
}

export interface TaskStoreOptions {
  /** Maximum tasks retained. Older completed tasks are evicted first. */
  readonly maxTasks?: number;
}

export class TaskStore {
  private readonly maxTasks: number;

  constructor(
    private readonly area: StorageArea,
    options: TaskStoreOptions = {},
  ) {
    this.maxTasks = options.maxTasks ?? 100;
  }

  async saveTask(task: AgentTask): Promise<void> {
    await this.area.set(taskKey(task.id), task);
    await update<TaskIndex>(this.area, TASK_INDEX_KEY, { ids: [] }, (index) => ({
      ids: [task.id, ...index.ids.filter((id) => id !== task.id)],
    }));
    await this.evictOverflow();
  }

  async getTask(id: string): Promise<AgentTask | undefined> {
    const task = await this.area.get<AgentTask>(taskKey(id));
    return task === undefined ? undefined : normaliseSecurityState(task);
  }

  /**
   * Appends taint sources atomically.
   *
   * The append happens *inside* the mutator so the whole read-modify-write is
   * covered by the storage mutex. Building a task object in memory and calling
   * `saveTask` would use a blind `set`, and two tool calls finishing together
   * would silently drop one set of sources — losing security state is the one
   * failure mode this record exists to prevent.
   *
   * Returns the resulting state, or `undefined` when the task is gone. A
   * caller that cannot persist taint must not continue with the weaker state;
   * see `AgentRuntime`, which pauses.
   */
  async appendTaint(id: string, sources: readonly TaintSource[]): Promise<TaintState | undefined> {
    const updated = await this.updateTask(id, (task) => ({
      ...task,
      taintState: addTaint(task.taintState, sources),
    }));
    return updated?.taintState;
  }

  /** Replaces the salt after a corrupt or missing one, and bumps the epoch. */
  async rotateSalt(id: string, salt: string): Promise<AgentTask | undefined> {
    return this.updateTask(id, (task) => ({
      ...task,
      taintSalt: salt,
      saltEpoch: task.saltEpoch + 1,
    }));
  }

  /**
   * Atomically mutates a stored task.
   * Returns `undefined` when the task no longer exists.
   */
  async updateTask(
    id: string,
    mutate: (task: AgentTask) => AgentTask,
  ): Promise<AgentTask | undefined> {
    const key = taskKey(id);
    let missing = false;
    const next = await update<AgentTask | null>(this.area, key, null, (current) => {
      if (current === null) {
        missing = true;
        return null;
      }
      return mutate(normaliseSecurityState(current));
    });
    if (missing || next === null) {
      log.warn('Attempted to update a task that is not stored.', { taskId: id });
      return undefined;
    }
    await update<TaskIndex>(this.area, TASK_INDEX_KEY, { ids: [] }, (index) =>
      index.ids.includes(id) ? index : { ids: [id, ...index.ids] },
    );
    return next;
  }

  async listTasks(limit = 50): Promise<AgentTask[]> {
    const index = (await this.area.get<TaskIndex>(TASK_INDEX_KEY)) ?? { ids: [] };
    const tasks: AgentTask[] = [];
    for (const id of index.ids.slice(0, limit)) {
      const task = await this.area.get<AgentTask>(taskKey(id));
      if (task) tasks.push(normaliseSecurityState(task));
    }
    return tasks;
  }

  /**
   * Tasks that were mid-flight when the worker died.
   * The lifecycle manager reconciles these on startup.
   */
  async listInterrupted(): Promise<AgentTask[]> {
    const tasks = await this.listTasks(this.maxTasks);
    return tasks.filter((task) => !isTerminal(task.state));
  }

  async deleteTask(id: string): Promise<void> {
    await this.area.remove(taskKey(id));
    await update<TaskIndex>(this.area, TASK_INDEX_KEY, { ids: [] }, (index) => ({
      ids: index.ids.filter((existing) => existing !== id),
    }));
  }

  async saveSession(session: AgentSession): Promise<void> {
    await this.area.set(sessionKey(session.id), session);
    await update<TaskIndex>(this.area, SESSION_INDEX_KEY, { ids: [] }, (index) => ({
      ids: [session.id, ...index.ids.filter((id) => id !== session.id)].slice(0, 50),
    }));
  }

  getSession(id: string): Promise<AgentSession | undefined> {
    return this.area.get<AgentSession>(sessionKey(id));
  }

  async listSessions(limit = 20): Promise<AgentSession[]> {
    const index = (await this.area.get<TaskIndex>(SESSION_INDEX_KEY)) ?? { ids: [] };
    const sessions: AgentSession[] = [];
    for (const id of index.ids.slice(0, limit)) {
      const session = await this.area.get<AgentSession>(sessionKey(id));
      if (session) sessions.push(session);
    }
    return sessions;
  }

  /** Drops the oldest terminal tasks once the retention cap is exceeded. */
  private async evictOverflow(): Promise<void> {
    const index = (await this.area.get<TaskIndex>(TASK_INDEX_KEY)) ?? { ids: [] };
    if (index.ids.length <= this.maxTasks) return;

    const overflow = index.ids.slice(this.maxTasks);
    const removed: string[] = [];
    for (const id of overflow) {
      const task = await this.area.get<AgentTask>(taskKey(id));
      // Never evict a task that is still live, even if it is old.
      if (task && !isTerminal(task.state)) continue;
      await this.area.remove(taskKey(id));
      removed.push(id);
    }
    if (removed.length > 0) {
      await update<TaskIndex>(this.area, TASK_INDEX_KEY, { ids: [] }, (current) => ({
        ids: current.ids.filter((id) => !removed.includes(id)),
      }));
      log.debug('Evicted completed tasks past the retention cap.', { count: removed.length });
    }
  }
}

/** States a recovered task is moved into when the worker restarts. */
export function recoveryStateFor(state: TaskState): TaskState {
  switch (state) {
    // Work that was actively executing cannot be resumed blind: the page may
    // have moved on. Park it for the user to resume or retry explicitly.
    case 'RUNNING':
    case 'PLANNING':
    case 'WAITING_FOR_TOOL':
    case 'RECOVERING':
      return 'PAUSED';
    // An unanswered prompt is a denial once its UI is gone.
    case 'WAITING_FOR_PERMISSION':
      return 'PAUSED';
    case 'QUEUED':
    case 'WAITING_FOR_USER':
    case 'PAUSED':
      return state;
    case 'COMPLETED':
    case 'PARTIAL':
    case 'BLOCKED':
    case 'FAILED':
    case 'CANCELLED':
      return state;
  }
}

/**
 * Repairs a record read from storage so security state is never trusted raw.
 *
 * A record written by an earlier version has no `taintState`, and a record
 * that was damaged has one that does not parse. Both become `UNKNOWN`, which
 * the egress gate denies on. The alternative — treating an absent field as an
 * empty, and therefore clean, set — is precisely how a restart could make a
 * task *less* restricted than it was before.
 *
 * A missing or malformed salt is left empty here rather than invented: the
 * runtime rotates it and bumps the epoch, so the repair is recorded rather
 * than hidden, and evidence never silently falls back to an unsalted digest.
 */
export function normaliseSecurityState(task: AgentTask): AgentTask {
  const parsed = parseTaintState((task as { taintState?: unknown }).taintState);
  const salt = typeof task.taintSalt === 'string' ? task.taintSalt : '';
  const epoch = Number.isInteger(task.saltEpoch) && task.saltEpoch > 0 ? task.saltEpoch : 0;

  if (parsed === task.taintState && salt === task.taintSalt && epoch === task.saltEpoch) {
    return task;
  }
  return { ...task, taintState: parsed, taintSalt: salt, saltEpoch: epoch };
}

/** A task whose security state could not be established. */
export function hasUsableSecurityState(task: AgentTask): boolean {
  return task.taintState.kind !== 'UNKNOWN' && task.taintSalt.length > 0;
}

/** Marks a task's taint as unrecoverable after a persistence failure. */
export function withFailedPersistence(task: AgentTask): AgentTask {
  return { ...task, taintState: unknownTaint('persistence-failed') };
}
