/**
 * User-mediated file selection.
 *
 * The extension has no filesystem access and this does not give it any. The
 * only route to local bytes is a person opening a file picker and choosing
 * something, and this is the bridge between a task that needs a file and the
 * side panel that can ask for one.
 *
 * What that rules out is the shape the model would otherwise reach for. A
 * request like "upload the report" does not name a path, and a model that
 * supplied one — `/Users/someone/.ssh/id_rsa`, say — would be proposing an
 * arbitrary local read. There is nowhere in this request type to put a path,
 * so the proposal cannot be expressed, let alone honoured. The task says what
 * it needs the file *for*; the user decides what that is.
 *
 * Mirrors `PermissionBroker` deliberately, including its failure direction:
 * an unanswered request resolves as **cancelled**, never as a selection. A
 * prompt nobody answered must leave the task without a file, not with one
 * somebody did not choose.
 */
import { getLogger } from '@/logging/logger';
import { broadcastEvent } from '@/messaging/bus';
import { newId } from '@/utils/ids';

const log = getLogger('agent');

/**
 * What the side panel is asked to show.
 *
 * `purpose` is the model's own description of why a file is wanted, shown to
 * the user so they can judge the request. It is model output and is rendered
 * as text, never interpreted. `accept` is a hint copied from the page's own
 * file input; it narrows the picker and is not a security control.
 */
export interface FileSelectionRequest {
  readonly id: string;
  readonly taskId: string;
  readonly purpose: string;
  readonly accept?: string;
  readonly multiple: boolean;
  /** Origin the file is intended for, so the prompt can name it. */
  readonly destinationOrigin?: string;
  readonly requestedAt: number;
}

/** One file as the panel read it. Bytes are base64; messaging is JSON. */
export interface SelectedFilePayload {
  readonly name: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly dataBase64: string;
}

export type FileSelectionResponse =
  | { readonly kind: 'selected'; readonly files: readonly SelectedFilePayload[] }
  | { readonly kind: 'cancelled'; readonly reason?: string };

interface Pending {
  readonly request: FileSelectionRequest;
  readonly resolve: (response: FileSelectionResponse) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface FileSelectionBrokerOptions {
  /**
   * How long a request waits before it is treated as cancelled.
   *
   * Longer than a permission prompt: choosing a file means leaving the
   * browser, opening a picker and finding something, and a person who does
   * that should not come back to a task that gave up.
   */
  readonly timeoutMs?: number;
  readonly notify?: (request: FileSelectionRequest) => void;
  /** Parks the task while the picker is open, so the UI says what it is doing. */
  readonly onWaiting?: (request: FileSelectionRequest) => void;
  /** Returns the task to running once the request settles, however it settled. */
  readonly onSettled?: (request: FileSelectionRequest) => void;
  readonly now?: () => number;
}

export class FileSelectionBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: FileSelectionBrokerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
  }

  request(input: Omit<FileSelectionRequest, 'id' | 'requestedAt'>): Promise<FileSelectionResponse> {
    const request: FileSelectionRequest = {
      ...input,
      id: newId('filereq'),
      requestedAt: this.now(),
    };

    return new Promise<FileSelectionResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        log.info('File selection expired without an answer; treating it as cancelled.', {
          requestId: request.id,
          taskId: request.taskId,
        });
        broadcastEvent({ type: 'file.selectionResolved', requestId: request.id });
        this.options.onSettled?.(request);
        resolve({ kind: 'cancelled', reason: 'The file request timed out.' });
      }, this.timeoutMs);

      this.pending.set(request.id, { request, resolve, timer });
      broadcastEvent({ type: 'file.selectionRequested', request });
      this.options.onWaiting?.(request);
      this.options.notify?.(request);
    });
  }

  /** Called when the side panel returns what the user chose. */
  respond(requestId: string, response: FileSelectionResponse): boolean {
    const pending = this.pending.get(requestId);
    // Already answered or already expired. Reported rather than thrown: a
    // panel that reloads mid-pick can legitimately answer twice.
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    broadcastEvent({ type: 'file.selectionResolved', requestId });
    this.options.onSettled?.(pending.request);
    pending.resolve(response);
    return true;
  }

  listPending(): FileSelectionRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  cancelAll(reason = 'The extension stopped waiting for a file.'): void {
    for (const [id, pending] of [...this.pending]) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      broadcastEvent({ type: 'file.selectionResolved', requestId: id });
      this.options.onSettled?.(pending.request);
      pending.resolve({ kind: 'cancelled', reason });
    }
  }

  cancelForTask(taskId: string, reason = 'The task ended before a file was chosen.'): void {
    for (const [id, pending] of [...this.pending]) {
      if (pending.request.taskId !== taskId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      broadcastEvent({ type: 'file.selectionResolved', requestId: id });
      this.options.onSettled?.(pending.request);
      pending.resolve({ kind: 'cancelled', reason });
    }
  }
}
