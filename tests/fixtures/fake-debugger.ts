/**
 * A `DebuggerPort` that records what was sent and replies from a script.
 *
 * `browser.screenshot` captures through `Page.captureScreenshot` rather than
 * `chrome.tabs.captureVisibleTab`, so most browser-tool tests now need a
 * debugger to talk to. Keeping one fake here stops each suite from inventing
 * its own and drifting from the real port's shape.
 */
import { DebuggerManager, type DebuggerPort } from '@/tools/debugger/debugger-manager';

/** Base64 of a one-pixel PNG — a real signature, so validation accepts it. */
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export interface FakeDebuggerPortOptions {
  /** Rejects `attach` with this error, standing in for a Chrome refusal. */
  readonly attachError?: Error;
  /** Replaces the default reply for a CDP method. */
  readonly respond?: (method: string, params?: Record<string, unknown>) => unknown;
}

export class FakeDebuggerPort implements DebuggerPort {
  readonly attached = new Set<number>();
  readonly sent: { tabId: number; method: string }[] = [];
  detachCount = 0;

  constructor(private readonly options: FakeDebuggerPortOptions = {}) {}

  attach(target: { tabId: number }): Promise<void> {
    if (this.options.attachError) return Promise.reject(this.options.attachError);
    this.attached.add(target.tabId);
    return Promise.resolve();
  }

  detach(target: { tabId: number }): Promise<void> {
    this.detachCount += 1;
    this.attached.delete(target.tabId);
    return Promise.resolve();
  }

  sendCommand(
    target: { tabId: number },
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    this.sent.push({ tabId: target.tabId, method });
    const scripted = this.options.respond?.(method, params);
    if (scripted !== undefined) return Promise.resolve(scripted);
    if (method === 'Page.captureScreenshot') {
      return Promise.resolve({ data: TINY_PNG_BASE64 });
    }
    return Promise.resolve({});
  }

  readonly onEvent = { addListener: () => undefined, removeListener: () => undefined };
  readonly onDetach = { addListener: () => undefined, removeListener: () => undefined };
}

/** A `DebuggerManager` over a fake port, returned together for assertions. */
export function fakeDebugger(options: FakeDebuggerPortOptions = {}): {
  manager: DebuggerManager;
  port: FakeDebuggerPort;
} {
  const port = new FakeDebuggerPort(options);
  return { manager: new DebuggerManager(port), port };
}
