/**
 * Chrome DevTools Protocol manager (specification sections 6.4, 11, 16).
 *
 * The debugger is the most powerful capability in the extension, so model
 * output never reaches it directly. Only the methods on `ALLOWED_CDP_METHODS`
 * can be sent, and only through the typed helpers below — there is no
 * `debugger.command` escape hatch.
 *
 * Console and network data collected here is buffered per tab and redacted at
 * the point of collection, so a credential never sits in memory in plaintext
 * waiting to be read into model context.
 */
import { getLogger } from '@/logging/logger';
import { ToolError } from '@/types/result';
import { redact, redactHeaders } from '@/security/redaction/secret-redactor';

const log = getLogger('debugger');

/**
 * The complete set of CDP methods this extension may send.
 *
 * Every entry is read-only or a capability the tools explicitly expose.
 * Notably absent: `Runtime.evaluate`, `Runtime.callFunctionOn`,
 * `Page.addScriptToEvaluateOnNewDocument` and anything else that executes
 * attacker- or model-supplied script (specification section 46).
 */
export const ALLOWED_CDP_METHODS: readonly string[] = [
  'DOM.getDocument',
  'DOM.getOuterHTML',
  'DOM.describeNode',
  'Page.enable',
  'Page.disable',
  'Page.getNavigationHistory',
  'Page.getLayoutMetrics',
  'Page.captureScreenshot',
  'Runtime.enable',
  'Runtime.disable',
  'Log.enable',
  'Log.disable',
  'Network.enable',
  'Network.disable',
  'Network.getResponseBody',
  'Accessibility.enable',
  'Accessibility.getFullAXTree',
];

const ALLOWED = new Set(ALLOWED_CDP_METHODS);

export interface ConsoleEntry {
  readonly level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  readonly text: string;
  readonly url?: string;
  readonly lineNumber?: number;
  readonly timestamp: number;
}

export interface NetworkEntry {
  readonly requestId: string;
  readonly method: string;
  readonly url: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly mimeType?: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly failed?: boolean;
  readonly errorText?: string;
  readonly timestamp: number;
}

interface TabBuffers {
  console: ConsoleEntry[];
  network: Map<string, NetworkEntry>;
  attachedAt: number;
}

/** The `chrome.debugger` surface, isolated for testability. */
export interface DebuggerPort {
  attach(target: { tabId: number }, version: string): Promise<void>;
  detach(target: { tabId: number }): Promise<void>;
  sendCommand(
    target: { tabId: number },
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;
  onEvent: {
    addListener(
      callback: (source: { tabId?: number }, method: string, params?: unknown) => void,
    ): void;
    removeListener(
      callback: (source: { tabId?: number }, method: string, params?: unknown) => void,
    ): void;
  };
  onDetach: {
    addListener(callback: (source: { tabId?: number }, reason: string) => void): void;
    removeListener(callback: (source: { tabId?: number }, reason: string) => void): void;
  };
}

export const chromeDebuggerPort: DebuggerPort = {
  attach: (target, version) => chrome.debugger.attach(target, version),
  detach: (target) => chrome.debugger.detach(target),
  sendCommand: (target, method, params) => chrome.debugger.sendCommand(target, method, params),
  onEvent: {
    addListener: (cb) => chrome.debugger.onEvent.addListener(cb),
    removeListener: (cb) => chrome.debugger.onEvent.removeListener(cb),
  },
  onDetach: {
    addListener: (cb) => chrome.debugger.onDetach.addListener(cb),
    removeListener: (cb) => chrome.debugger.onDetach.removeListener(cb),
  },
};

const CDP_VERSION = '1.3';
const MAX_CONSOLE_ENTRIES = 200;
const MAX_NETWORK_ENTRIES = 200;

export class DebuggerManager {
  private readonly buffers = new Map<number, TabBuffers>();
  private listening = false;

  constructor(private readonly port: DebuggerPort = chromeDebuggerPort) {}

  isAttached(tabId: number): boolean {
    return this.buffers.has(tabId);
  }

  attachedTabs(): number[] {
    return [...this.buffers.keys()];
  }

  /**
   * Attaches to a tab and starts collecting console and network activity.
   *
   * Attachment shows Chrome's "is debugging this browser" banner, which is
   * intentional: the user must be able to see that deep inspection is active.
   */
  async attach(tabId: number): Promise<void> {
    if (this.buffers.has(tabId)) return;

    this.ensureListening();

    try {
      await this.port.attach({ tabId }, CDP_VERSION);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Another debugger') || message.includes('already attached')) {
        throw new ToolError('DEBUGGER_UNAVAILABLE', 'Another debugger is attached to this tab.', {
          userMessage:
            'DevTools or another extension is already debugging this tab. Close it and try again.',
        });
      }
      throw new ToolError('DEBUGGER_UNAVAILABLE', 'Could not attach the debugger.', {
        userMessage:
          'The debugger could not attach to this tab. Enterprise policy or the page type may forbid it.',
        technicalDetails: message,
      });
    }

    this.buffers.set(tabId, { console: [], network: new Map(), attachedAt: Date.now() });

    try {
      await this.send(tabId, 'Runtime.enable');
      await this.send(tabId, 'Log.enable');
      await this.send(tabId, 'Network.enable');
      await this.send(tabId, 'Page.enable');
    } catch (error) {
      // Leave the tab in a clean state rather than half-instrumented.
      await this.detach(tabId);
      throw error;
    }
    log.info('Debugger attached.', { tabId });
  }

  async detach(tabId: number): Promise<void> {
    this.buffers.delete(tabId);
    try {
      await this.port.detach({ tabId });
    } catch {
      // The tab may already be gone; detaching is best-effort.
    }
    log.debug('Debugger detached.', { tabId });
  }

  async detachAll(): Promise<void> {
    for (const tabId of this.attachedTabs()) {
      await this.detach(tabId);
    }
  }

  /**
   * Sends an allowlisted CDP command.
   *
   * The allowlist check is the security boundary: any method not on the list
   * is refused regardless of how the call was reached.
   */
  async send<T = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    if (!ALLOWED.has(method)) {
      log.error('Refused a DevTools command outside the allowlist.', { tabId, method });
      throw new ToolError(
        'POLICY_BLOCKED',
        `The DevTools method "${method}" is not on the allowlist.`,
        {
          userMessage: 'That browser inspection command is not permitted.',
        },
      );
    }
    if (!this.buffers.has(tabId)) {
      throw new ToolError('DEBUGGER_UNAVAILABLE', `The debugger is not attached to tab ${tabId}.`);
    }
    return (await this.port.sendCommand({ tabId }, method, params)) as T;
  }

  getConsole(tabId: number): readonly ConsoleEntry[] {
    return this.buffers.get(tabId)?.console ?? [];
  }

  getNetwork(tabId: number): readonly NetworkEntry[] {
    return [...(this.buffers.get(tabId)?.network.values() ?? [])];
  }

  clearBuffers(tabId: number): void {
    const buffer = this.buffers.get(tabId);
    if (!buffer) return;
    buffer.console = [];
    buffer.network = new Map();
  }

  private ensureListening(): void {
    if (this.listening) return;
    this.listening = true;
    this.port.onEvent.addListener(this.handleEvent);
    this.port.onDetach.addListener(this.handleDetach);
  }

  /** Drops listeners. Used on service-worker teardown and in tests. */
  dispose(): void {
    if (!this.listening) return;
    this.port.onEvent.removeListener(this.handleEvent);
    this.port.onDetach.removeListener(this.handleDetach);
    this.listening = false;
    this.buffers.clear();
  }

  private readonly handleDetach = (source: { tabId?: number }): void => {
    if (source.tabId === undefined) return;
    this.buffers.delete(source.tabId);
    log.debug('Debugger detached externally.', { tabId: source.tabId });
  };

  private readonly handleEvent = (
    source: { tabId?: number },
    method: string,
    params?: unknown,
  ): void => {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    const buffer = this.buffers.get(tabId);
    if (!buffer) return;

    switch (method) {
      case 'Runtime.consoleAPICalled':
        this.recordConsoleApi(buffer, params);
        break;
      case 'Runtime.exceptionThrown':
        this.recordException(buffer, params);
        break;
      case 'Log.entryAdded':
        this.recordLogEntry(buffer, params);
        break;
      case 'Network.requestWillBeSent':
        this.recordRequest(buffer, params);
        break;
      case 'Network.responseReceived':
        this.recordResponse(buffer, params);
        break;
      case 'Network.loadingFailed':
        this.recordFailure(buffer, params);
        break;
      default:
        break;
    }
  };

  private push(buffer: TabBuffers, entry: ConsoleEntry): void {
    buffer.console.push(entry);
    if (buffer.console.length > MAX_CONSOLE_ENTRIES) {
      buffer.console.splice(0, buffer.console.length - MAX_CONSOLE_ENTRIES);
    }
  }

  private recordConsoleApi(buffer: TabBuffers, params: unknown): void {
    const event = params as {
      type?: string;
      args?: { value?: unknown; description?: string }[];
      timestamp?: number;
    };
    const text = (event.args ?? [])
      .map((arg) =>
        arg.value === undefined ? (arg.description ?? '[object]') : stringify(arg.value),
      )
      .join(' ');
    this.push(buffer, {
      level: mapConsoleLevel(event.type),
      // Redact at collection time, not at read time.
      text: redact(text).slice(0, 2000),
      timestamp: event.timestamp ?? Date.now(),
    });
  }

  private recordException(buffer: TabBuffers, params: unknown): void {
    const event = params as {
      exceptionDetails?: {
        text?: string;
        exception?: { description?: string };
        url?: string;
        lineNumber?: number;
      };
      timestamp?: number;
    };
    const details = event.exceptionDetails;
    const text = details?.exception?.description ?? details?.text ?? 'Uncaught exception';
    this.push(buffer, {
      level: 'error',
      text: redact(text).slice(0, 2000),
      ...(details?.url === undefined ? {} : { url: details.url }),
      ...(details?.lineNumber === undefined ? {} : { lineNumber: details.lineNumber }),
      timestamp: event.timestamp ?? Date.now(),
    });
  }

  private recordLogEntry(buffer: TabBuffers, params: unknown): void {
    const event = params as {
      entry?: {
        level?: string;
        text?: string;
        url?: string;
        lineNumber?: number;
        timestamp?: number;
      };
    };
    const entry = event.entry;
    if (!entry?.text) return;
    this.push(buffer, {
      level: mapConsoleLevel(entry.level),
      text: redact(entry.text).slice(0, 2000),
      ...(entry.url === undefined ? {} : { url: entry.url }),
      ...(entry.lineNumber === undefined ? {} : { lineNumber: entry.lineNumber }),
      timestamp: entry.timestamp ?? Date.now(),
    });
  }

  private trimNetwork(buffer: TabBuffers): void {
    if (buffer.network.size <= MAX_NETWORK_ENTRIES) return;
    const excess = buffer.network.size - MAX_NETWORK_ENTRIES;
    let removed = 0;
    for (const key of buffer.network.keys()) {
      if (removed >= excess) break;
      buffer.network.delete(key);
      removed += 1;
    }
  }

  private recordRequest(buffer: TabBuffers, params: unknown): void {
    const event = params as {
      requestId?: string;
      request?: { url?: string; method?: string; headers?: Record<string, string> };
      timestamp?: number;
    };
    if (!event.requestId || !event.request?.url) return;
    buffer.network.set(event.requestId, {
      requestId: event.requestId,
      method: event.request.method ?? 'GET',
      // A URL can carry a token in its query string.
      url: redact(event.request.url).slice(0, 2000),
      requestHeaders: redactHeaders(event.request.headers ?? {}),
      timestamp: event.timestamp ?? Date.now(),
    });
    this.trimNetwork(buffer);
  }

  private recordResponse(buffer: TabBuffers, params: unknown): void {
    const event = params as {
      requestId?: string;
      response?: {
        status?: number;
        statusText?: string;
        mimeType?: string;
        headers?: Record<string, string>;
        url?: string;
      };
    };
    if (!event.requestId) return;
    const existing = buffer.network.get(event.requestId);
    const response = event.response;
    const base: NetworkEntry = existing ?? {
      requestId: event.requestId,
      method: 'GET',
      url: redact(response?.url ?? '').slice(0, 2000),
      requestHeaders: {},
      timestamp: Date.now(),
    };
    buffer.network.set(event.requestId, {
      ...base,
      ...(response?.status === undefined ? {} : { status: response.status }),
      ...(response?.statusText === undefined ? {} : { statusText: response.statusText }),
      ...(response?.mimeType === undefined ? {} : { mimeType: response.mimeType }),
      responseHeaders: redactHeaders(response?.headers ?? {}),
    });
    this.trimNetwork(buffer);
  }

  private recordFailure(buffer: TabBuffers, params: unknown): void {
    const event = params as { requestId?: string; errorText?: string };
    if (!event.requestId) return;
    const existing = buffer.network.get(event.requestId);
    if (!existing) return;
    buffer.network.set(event.requestId, {
      ...existing,
      failed: true,
      ...(event.errorText === undefined ? {} : { errorText: event.errorText }),
    });
  }
}

/** Renders an arbitrary console argument without producing "[object Object]". */
function stringify(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return value.toString();
    case 'symbol':
      return value.toString();
    case 'undefined':
      return 'undefined';
    case 'function':
      return '[function]';
    case 'object':
      if (value === null) return 'null';
      try {
        return JSON.stringify(value) ?? '[object]';
      } catch {
        // Circular structures and BigInt values both throw here.
        return '[unserialisable object]';
      }
  }
}

function mapConsoleLevel(raw: string | undefined): ConsoleEntry['level'] {
  switch (raw) {
    case 'error':
    case 'assert':
      return 'error';
    case 'warning':
    case 'warn':
      return 'warn';
    case 'debug':
    case 'verbose':
      return 'debug';
    case 'info':
      return 'info';
    default:
      return 'log';
  }
}
