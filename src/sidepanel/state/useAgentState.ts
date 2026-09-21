/**
 * Side-panel state.
 *
 * The panel is a view over state the service worker owns (specification
 * section 6.1). It holds no authoritative task state of its own: closing and
 * reopening the panel re-reads everything from the worker, which is what makes
 * a task survive the panel being closed.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { sendToBackground, subscribeToEvents, MessagingError } from '@/messaging/bus';
import { isTerminal, type AgentTask } from '@/tasks/task-model';
import type { PermissionRequest, PermissionResponse } from '@/policy/permission-engine';
import type { PermissionMode } from '@/policy/policy-engine';
import type { ProviderConnection } from '@/providers/registry/provider-registry';
import type { AgentError } from '@/types/result';

export interface AgentState {
  readonly tasks: readonly AgentTask[];
  readonly activeTask: AgentTask | null;
  readonly permissionRequests: readonly PermissionRequest[];
  readonly connection: ProviderConnection | null;
  readonly permissionMode: PermissionMode;
  readonly activity: string | null;
  readonly error: AgentError | null;
  readonly loading: boolean;
}

function asAgentError(error: unknown): AgentError {
  if (error instanceof MessagingError) return error.agentError;
  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error),
    userMessage: 'Something went wrong in the side panel.',
    recoverable: false,
    retryable: false,
  };
}

export function useAgentState() {
  const [tasks, setTasks] = useState<readonly AgentTask[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [permissionRequests, setPermissionRequests] = useState<readonly PermissionRequest[]>([]);
  const [connection, setConnection] = useState<ProviderConnection | null>(null);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('auto');
  const [activity, setActivity] = useState<string | null>(null);
  const [error, setError] = useState<AgentError | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [taskList, session, providerConnection, pending] = await Promise.all([
        sendToBackground('task.list', { limit: 25 }),
        sendToBackground('session.get', {}),
        sendToBackground('provider.getConnection', {}),
        sendToBackground('permission.listPending', {}),
      ]);
      setTasks(taskList.tasks);
      setConnection(providerConnection.connection);
      setPermissionRequests(pending.requests);
      if (session.session) setPermissionMode(session.session.permissionMode);

      // Select the newest live task so reopening the panel lands on the work
      // that is actually in progress. A functional update reads the current
      // selection without making this callback depend on it.
      setActiveTaskId((current) => {
        if (current !== null) return current;
        const live = taskList.tasks.find((task) => !isTerminal(task.state));
        return (live ?? taskList.tasks[0])?.id ?? null;
      });
      setError(null);
    } catch (caught) {
      setError(asAgentError(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial load plus the event subscription: this effect synchronises the
    // panel with the service worker, which is exactly what effects are for.
    // The state updates happen after an await, not during the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();

    return subscribeToEvents((event) => {
      switch (event.type) {
        case 'task.updated':
          setTasks((current) => {
            const index = current.findIndex((task) => task.id === event.task.id);
            if (index === -1) return [event.task, ...current];
            const next = [...current];
            next[index] = event.task;
            return next;
          });
          setActiveTaskId((current) => current ?? event.task.id);
          break;
        case 'task.activity':
          setActivity(event.activity);
          break;
        case 'permission.requested':
          setPermissionRequests((current) =>
            current.some((r) => r.id === event.request.id) ? current : [...current, event.request],
          );
          break;
        case 'permission.resolved':
          setPermissionRequests((current) => current.filter((r) => r.id !== event.requestId));
          break;
        case 'provider.statusChanged':
          setConnection(event.connection);
          break;
        case 'task.streamDelta':
        case 'log':
          break;
      }
    });
  }, [refresh]);

  const activeTask = useMemo(
    () => tasks.find((task) => task.id === activeTaskId) ?? null,
    [tasks, activeTaskId],
  );

  // The activity line belongs to a running task. Deriving it at render time
  // rather than clearing it in an effect keeps the two in step: a finished
  // task can never render a stale "Clicking…".
  const visibleActivity = activeTask && !isTerminal(activeTask.state) ? activity : null;

  const run = useCallback(async <T>(operation: () => Promise<T>): Promise<T | null> => {
    try {
      const result = await operation();
      setError(null);
      return result;
    } catch (caught) {
      setError(asAgentError(caught));
      return null;
    }
  }, []);

  const startTask = useCallback(
    async (objective: string) => {
      const result = await run(() => sendToBackground('task.create', { objective }));
      if (result) {
        setTasks((current) => [result.task, ...current]);
        setActiveTaskId(result.task.id);
      }
    },
    [run],
  );

  const pauseTask = useCallback(
    (taskId: string) => run(() => sendToBackground('task.pause', { taskId })),
    [run],
  );
  const resumeTask = useCallback(
    (taskId: string) => run(() => sendToBackground('task.resume', { taskId })),
    [run],
  );
  const cancelTask = useCallback(
    (taskId: string) => run(() => sendToBackground('task.cancel', { taskId })),
    [run],
  );
  const retryTask = useCallback(
    async (taskId: string) => {
      const result = await run(() => sendToBackground('task.retry', { taskId }));
      if (result) setActiveTaskId(result.task.id);
    },
    [run],
  );

  const respondToPermission = useCallback(
    async (requestId: string, response: PermissionResponse) => {
      setPermissionRequests((current) => current.filter((r) => r.id !== requestId));
      await run(() => sendToBackground('permission.respond', { requestId, response }));
    },
    [run],
  );

  const changePermissionMode = useCallback(
    async (mode: PermissionMode) => {
      setPermissionMode(mode);
      await run(() => sendToBackground('session.setPermissionMode', { mode }));
    },
    [run],
  );

  const state: AgentState = {
    tasks,
    activeTask,
    permissionRequests,
    connection,
    permissionMode,
    activity: visibleActivity,
    error,
    loading,
  };

  return {
    ...state,
    setActiveTaskId,
    refresh,
    startTask,
    pauseTask,
    resumeTask,
    cancelTask,
    retryTask,
    respondToPermission,
    changePermissionMode,
    dismissError: () => setError(null),
  };
}
