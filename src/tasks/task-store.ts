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

  getTask(id: string): Promise<AgentTask | undefined> {
    return this.area.get<AgentTask>(taskKey(id));
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
      return mutate(current);
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
      if (task) tasks.push(task);
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
