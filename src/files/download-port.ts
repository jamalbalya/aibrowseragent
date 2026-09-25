/**
 * The seam between download tooling and `chrome.downloads`.
 *
 * Exists for the same reason the notification and debugger ports do: a
 * `chrome.*` call made inline is a call no test can observe. Downloads need
 * that more than most, because the interesting behaviour is the lifecycle —
 * a download that is interrupted, cancelled, or renamed by Chrome because a
 * file of that name already existed.
 *
 * `downloads` is an **optional** permission. It is not requested at install
 * time and it is not requested by the agent: a person grants it from the side
 * panel, under their own gesture, and until they do every download is refused
 * with an explanation. That keeps the installed permission set to what the
 * extension needs to work at all.
 */
import { getLogger } from '@/logging/logger';

const log = getLogger('browser');

export interface DownloadRequest {
  readonly url: string;
  /** A plain filename. Never a path — see `download-safety`. */
  readonly filename: string;
}

export type DownloadState = 'complete' | 'interrupted' | 'cancelled';

export interface DownloadOutcome {
  readonly id: number;
  readonly state: DownloadState;
  /** Name Chrome actually used, which may be uniquified. */
  readonly filename?: string;
  /**
   * Where the bytes actually came from, after any redirects Chrome followed.
   *
   * Separate from the requested URL because they can differ, and when they do
   * the difference is the interesting fact: the requested URL is what a person
   * approved, and this is what served the file.
   */
  readonly finalUrl?: string;
  readonly byteLength?: number;
  readonly mimeType?: string;
  /** Chrome's own interruption reason, e.g. `NETWORK_FAILED`. */
  readonly error?: string;
}

export interface DownloadPort {
  /** Whether the optional permission is currently granted. */
  isPermitted(): Promise<boolean>;
  start(request: DownloadRequest): Promise<number>;
  /** Resolves when the download reaches a terminal state. */
  awaitCompletion(id: number, signal: AbortSignal): Promise<DownloadOutcome>;
  cancel(id: number): Promise<void>;
}

/** The real implementation. Every call is guarded by the permission check. */
export class ChromeDownloadPort implements DownloadPort {
  async isPermitted(): Promise<boolean> {
    try {
      return await chrome.permissions.contains({ permissions: ['downloads'] });
    } catch {
      return false;
    }
  }

  async start(request: DownloadRequest): Promise<number> {
    return await chrome.downloads.download({
      url: request.url,
      filename: request.filename,
      // Never overwrite. A download that silently replaced an existing file
      // would be a way to clobber something the user cares about with content
      // chosen from a page.
      conflictAction: 'uniquify',
      // No "Save as" dialog: the filename was already validated, and a dialog
      // here would block a background task on a window the user may not see.
      saveAs: false,
    });
  }

  awaitCompletion(id: number, signal: AbortSignal): Promise<DownloadOutcome> {
    return new Promise<DownloadOutcome>((resolve, reject) => {
      const settle = (outcome: DownloadOutcome): void => {
        chrome.downloads.onChanged.removeListener(onChanged);
        signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      };

      const onAbort = (): void => {
        chrome.downloads.onChanged.removeListener(onChanged);
        void this.cancel(id).catch(() => undefined);
        reject(new Error('The download was cancelled.'));
      };

      const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
        if (delta.id !== id) return;
        const state = delta.state?.current;
        if (state !== 'complete' && state !== 'interrupted') return;
        void this.describe(id, state === 'complete' ? 'complete' : 'interrupted', delta).then(
          settle,
          (error: unknown) => {
            log.warn('Could not read the finished download.', {
              error: error instanceof Error ? error.message : String(error),
            });
            settle({ id, state: state === 'complete' ? 'complete' : 'interrupted' });
          },
        );
      };

      signal.addEventListener('abort', onAbort, { once: true });
      chrome.downloads.onChanged.addListener(onChanged);

      // A download can finish before the listener is attached, so the current
      // state is checked once rather than waited for indefinitely.
      void this.poll(id).then((settled) => {
        if (settled) settle(settled);
      });
    });
  }

  async cancel(id: number): Promise<void> {
    await chrome.downloads.cancel(id);
  }

  private async poll(id: number): Promise<DownloadOutcome | null> {
    const [item] = await chrome.downloads.search({ id });
    if (!item || item.state === 'in_progress') return null;
    return this.fromItem(item);
  }

  private async describe(
    id: number,
    state: DownloadState,
    delta: chrome.downloads.DownloadDelta,
  ): Promise<DownloadOutcome> {
    const [item] = await chrome.downloads.search({ id });
    if (!item) {
      return {
        id,
        state,
        ...(delta.error?.current === undefined ? {} : { error: delta.error.current }),
      };
    }
    return this.fromItem(item);
  }

  private fromItem(item: chrome.downloads.DownloadItem): DownloadOutcome {
    const state: DownloadState =
      item.state === 'complete'
        ? 'complete'
        : item.error === 'USER_CANCELED'
          ? 'cancelled'
          : 'interrupted';
    return {
      id: item.id,
      state,
      // The basename only. The full local path is the user's business and is
      // not needed to report that a download finished.
      ...(item.filename ? { filename: basenameOf(item.filename) } : {}),
      // Chrome reports this as the requested URL when nothing redirected, so
      // the comparison is made by the caller rather than guessed at here.
      ...(item.finalUrl ? { finalUrl: item.finalUrl } : {}),
      ...(typeof item.bytesReceived === 'number' ? { byteLength: item.bytesReceived } : {}),
      ...(item.mime ? { mimeType: item.mime } : {}),
      ...(item.error ? { error: item.error } : {}),
    };
  }
}

function basenameOf(path: string): string {
  const afterSlash = path.slice(path.lastIndexOf('/') + 1);
  return afterSlash.slice(afterSlash.lastIndexOf('\\') + 1);
}
