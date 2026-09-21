/**
 * Permission broker.
 *
 * Bridges the permission engine, which awaits a decision, and the side panel,
 * which renders the prompt. Requests are tracked so a panel that opens late
 * still sees anything pending, and so a request outlives a panel reload.
 *
 * A request that is never answered resolves as a denial when its deadline
 * passes: the failure mode of an unanswered prompt must be "nothing happens",
 * not "the action proceeds".
 */
import { getLogger } from '@/logging/logger';
import { broadcastEvent } from '@/messaging/bus';
import type {
  PermissionPrompter,
  PermissionRequest,
  PermissionResponse,
} from '@/policy/permission-engine';

const log = getLogger('permission');

interface Pending {
  readonly request: PermissionRequest;
  readonly resolve: (response: PermissionResponse) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface PermissionBrokerOptions {
  /** How long a prompt waits before it is treated as a denial. */
  readonly timeoutMs?: number;
  readonly notify?: (request: PermissionRequest) => void;
}

export class PermissionBroker implements PermissionPrompter {
  private readonly pending = new Map<string, Pending>();
  private readonly timeoutMs: number;

  constructor(private readonly options: PermissionBrokerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  }

  prompt(request: PermissionRequest): Promise<PermissionResponse> {
    return new Promise<PermissionResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        log.info('Permission request expired without an answer; denying.', {
          requestId: request.id,
          tool: request.tool,
        });
        broadcastEvent({ type: 'permission.resolved', requestId: request.id });
        resolve({ kind: 'deny' });
      }, this.timeoutMs);

      this.pending.set(request.id, { request, resolve, timer });
      broadcastEvent({ type: 'permission.requested', request });
      this.options.notify?.(request);
    });
  }

  /** Called when the side panel returns the user's answer. */
  respond(requestId: string, response: PermissionResponse): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) {
      // The request already timed out or was answered elsewhere.
      return false;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    broadcastEvent({ type: 'permission.resolved', requestId });
    pending.resolve(response);
    return true;
  }

  listPending(): PermissionRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  /** Denies everything outstanding. Used on cancel and on worker teardown. */
  denyAll(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      broadcastEvent({ type: 'permission.resolved', requestId: id });
      pending.resolve({ kind: 'deny' });
    }
    this.pending.clear();
  }

  denyForTask(taskId: string): void {
    for (const [id, pending] of [...this.pending]) {
      if (pending.request.taskId !== taskId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      broadcastEvent({ type: 'permission.resolved', requestId: id });
      pending.resolve({ kind: 'deny' });
    }
  }
}
