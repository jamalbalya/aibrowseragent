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
import type { FileSelectionRequest } from '@/background/file-broker';
import { MAX_FILE_BYTES, MAX_FILES_PER_SELECTION } from '@/files/file-model';

export interface AgentState {
  readonly tasks: readonly AgentTask[];
  readonly activeTask: AgentTask | null;
  readonly permissionRequests: readonly PermissionRequest[];
  readonly fileRequests: readonly FileSelectionRequest[];
  readonly connection: ProviderConnection | null;
  readonly permissionMode: PermissionMode;
  readonly activity: string | null;
  readonly error: AgentError | null;
  readonly loading: boolean;
}

/**
 * Reads a file into base64.
 *
 * Base64 rather than a `File` or an `ArrayBuffer` because extension messaging
 * is a JSON channel: neither survives the trip to the service worker.
 */
async function toBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  // Chunked, because spreading a multi-megabyte array into `String.fromCharCode`
  // overflows the argument limit.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
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
  const [fileRequests, setFileRequests] = useState<readonly FileSelectionRequest[]>([]);
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
        case 'file.selectionRequested':
          setFileRequests((current) =>
            current.some((r) => r.id === event.request.id) ? current : [...current, event.request],
          );
          break;
        case 'file.selectionResolved':
          setFileRequests((current) => current.filter((r) => r.id !== event.requestId));
          break;
        case 'provider.statusChanged':
          setConnection(event.connection);
          break;
        case 'accounts.changed':
          // The settings view owns the account list and refreshes itself.
          // Nothing in the main panel reads it, so there is nothing to do
          // here — stated as a case rather than left to the default, because
          // the exhaustiveness check is what will make the next event someone
          // adds get a decision instead of silence.
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

  /**
   * Runs what a confirmed shortcut resolved to.
   *
   * The shortcut is already spent by this point: it produced an id, and what
   * happens here is the route that already existed for that kind of target.
   * There is no shortcut-specific execution, so every permission, policy and
   * egress decision happens exactly as it would have without a name in front
   * of it.
   */
  const runShortcutTarget = useCallback(
    async (resolution: {
      targetKind: string;
      targetId: string;
      targetVersion?: string;
    }): Promise<void> => {
      if (resolution.targetKind === 'workflow') {
        await run(() =>
          sendToBackground('workflow.replay', { workflowId: resolution.targetId, inputs: {} }),
        );
      } else if (resolution.targetKind === 'skill' && resolution.targetVersion !== undefined) {
        await run(() =>
          sendToBackground('skill.run', {
            skillId: resolution.targetId,
            skillVersion: resolution.targetVersion as string,
          }),
        );
      }
      await refresh();
    },
    [run, refresh],
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

  /**
   * Hands the worker what the user chose.
   *
   * The read happens here, in the panel, because this is where a real file
   * picker and a real user gesture exist. Nothing below this point can ask
   * for a file; it can only receive one that was already chosen.
   */
  const respondToFileRequest = useCallback(
    async (requestId: string, files: readonly File[] | null) => {
      if (files === null || files.length === 0) {
        await run(() =>
          sendToBackground('file.respondSelection', {
            requestId,
            response: { kind: 'cancelled', reason: 'The user closed the file picker.' },
          }),
        );
        return;
      }

      if (files.length > MAX_FILES_PER_SELECTION) {
        setError({
          code: 'INVALID_ARGUMENT',
          message: 'Too many files.',
          userMessage: `Choose at most ${MAX_FILES_PER_SELECTION} files.`,
          recoverable: true,
          retryable: false,
        });
        return;
      }

      const payloads: {
        name: string;
        mimeType: string;
        byteLength: number;
        dataBase64: string;
      }[] = [];
      for (const file of files) {
        if (file.size > MAX_FILE_BYTES) {
          setError({
            code: 'INVALID_ARGUMENT',
            message: 'File too large.',
            userMessage: `"${file.name}" is larger than this extension will carry.`,
            recoverable: true,
            retryable: false,
          });
          return;
        }
        payloads.push({
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          byteLength: file.size,
          dataBase64: await toBase64(file),
        });
      }

      await run(() =>
        sendToBackground('file.respondSelection', {
          requestId,
          response: { kind: 'selected', files: payloads },
        }),
      );
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
    fileRequests,
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
    runShortcutTarget,
    pauseTask,
    resumeTask,
    cancelTask,
    retryTask,
    respondToPermission,
    respondToFileRequest,
    changePermissionMode,
    dismissError: () => setError(null),
  };
}
