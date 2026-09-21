/**
 * TEST-SECURITY-006 — DevTools allowlist and evidence redaction (REQ-SECURITY-006).
 *
 * The debugger is the most powerful capability in the extension. These tests
 * assert that model output can never name a CDP method and that console and
 * network data is redacted at collection time, not at read time.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_CDP_METHODS,
  DebuggerManager,
  type DebuggerPort,
} from '@/tools/debugger/debugger-manager';
import { createDebuggerTools } from '@/tools/debugger/debugger-tools';
import { ToolError } from '@/types/result';
import { FakeBrowserAdapter } from '../fixtures/fake-browser';
import { createHarness } from '../fixtures/policy-harness';

type EventListener = (source: { tabId?: number }, method: string, params?: unknown) => void;

class FakeDebuggerPort implements DebuggerPort {
  readonly sent: { method: string; params?: Record<string, unknown> }[] = [];
  readonly attached = new Set<number>();
  private eventListeners: EventListener[] = [];
  private detachListeners: ((source: { tabId?: number }, reason: string) => void)[] = [];
  attachError: Error | null = null;
  responses = new Map<string, unknown>();

  attach(target: { tabId: number }): Promise<void> {
    if (this.attachError) return Promise.reject(this.attachError);
    this.attached.add(target.tabId);
    return Promise.resolve();
  }
  detach(target: { tabId: number }): Promise<void> {
    this.attached.delete(target.tabId);
    return Promise.resolve();
  }
  sendCommand(
    _target: { tabId: number },
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    this.sent.push({ method, ...(params === undefined ? {} : { params }) });
    return Promise.resolve(this.responses.get(method) ?? {});
  }
  onEvent = {
    addListener: (cb: EventListener) => this.eventListeners.push(cb),
    removeListener: (cb: EventListener) => {
      this.eventListeners = this.eventListeners.filter((l) => l !== cb);
    },
  };
  onDetach = {
    addListener: (cb: (source: { tabId?: number }, reason: string) => void) =>
      this.detachListeners.push(cb),
    removeListener: (cb: (source: { tabId?: number }, reason: string) => void) => {
      this.detachListeners = this.detachListeners.filter((l) => l !== cb);
    },
  };

  emit(tabId: number, method: string, params: unknown): void {
    for (const listener of this.eventListeners) listener({ tabId }, method, params);
  }
  emitDetach(tabId: number): void {
    for (const listener of this.detachListeners) listener({ tabId }, 'target_closed');
  }
}

let port: FakeDebuggerPort;
let manager: DebuggerManager;

beforeEach(() => {
  port = new FakeDebuggerPort();
  manager = new DebuggerManager(port);
});

describe('CDP allowlist', () => {
  it('sends an allowlisted method', async () => {
    await manager.attach(1);
    await manager.send(1, 'DOM.getDocument', { depth: -1 });
    expect(port.sent.some((c) => c.method === 'DOM.getDocument')).toBe(true);
  });

  for (const method of [
    'Runtime.evaluate',
    'Runtime.callFunctionOn',
    'Page.addScriptToEvaluateOnNewDocument',
    'Page.navigate',
    'Network.setCookie',
    'Storage.getCookies',
    'Browser.close',
    'Input.dispatchKeyEvent',
    'Fetch.enable',
  ]) {
    it(`refuses ${method}, which is not on the allowlist`, async () => {
      await manager.attach(1);
      await expect(manager.send(1, method)).rejects.toBeInstanceOf(ToolError);
      expect(port.sent.some((c) => c.method === method)).toBe(false);
    });
  }

  it('does not expose any script-execution method on the allowlist', () => {
    // A single arbitrary-execution method here would make the whole tool
    // layer bypassable.
    const dangerous = ALLOWED_CDP_METHODS.filter((method) =>
      /evaluate|callFunction|addScript|compileScript|Input\.|Browser\.|Storage\.|Fetch\./i.test(
        method,
      ),
    );
    expect(dangerous).toEqual([]);
  });

  it('refuses a command when not attached', async () => {
    await expect(manager.send(1, 'DOM.getDocument')).rejects.toBeInstanceOf(ToolError);
  });

  it('exposes no tool that accepts a CDP method name', () => {
    const adapter = new FakeBrowserAdapter();
    const tools = createDebuggerTools({ adapter, manager });

    for (const tool of tools) {
      const schema = JSON.stringify(tool.inputSchema);
      expect(schema.toLowerCase(), tool.name).not.toContain('method');
      expect(schema.toLowerCase(), tool.name).not.toContain('command');
    }
    expect(tools.map((t) => t.name)).not.toContain('debugger.command');
  });
});

describe('attach lifecycle', () => {
  it('enables the domains it needs after attaching', async () => {
    await manager.attach(1);
    const methods = port.sent.map((c) => c.method);
    expect(methods).toContain('Runtime.enable');
    expect(methods).toContain('Log.enable');
    expect(methods).toContain('Network.enable');
    expect(manager.isAttached(1)).toBe(true);
  });

  it('is idempotent', async () => {
    await manager.attach(1);
    const count = port.sent.length;
    await manager.attach(1);
    expect(port.sent.length).toBe(count);
  });

  it('reports a competing debugger clearly', async () => {
    port.attachError = new Error('Another debugger is already attached to the tab');
    await expect(manager.attach(1)).rejects.toThrow();
    try {
      await manager.attach(1);
    } catch (error) {
      expect((error as ToolError).code).toBe('DEBUGGER_UNAVAILABLE');
      expect((error as ToolError).init.userMessage).toContain('DevTools');
    }
  });

  it('leaves no half-instrumented tab when enabling a domain fails', async () => {
    const failing = new FakeDebuggerPort();
    failing.sendCommand = () => Promise.reject(new Error('domain unavailable'));
    const strict = new DebuggerManager(failing);

    await expect(strict.attach(1)).rejects.toThrow();
    expect(strict.isAttached(1)).toBe(false);
  });

  it('forgets a tab that detached externally', async () => {
    await manager.attach(1);
    port.emitDetach(1);
    expect(manager.isAttached(1)).toBe(false);
  });

  it('detaches every attached tab', async () => {
    await manager.attach(1);
    await manager.attach(2);
    await manager.detachAll();
    expect(manager.attachedTabs()).toEqual([]);
  });
});

describe('console collection', () => {
  it('captures console output and maps levels', async () => {
    await manager.attach(1);
    port.emit(1, 'Runtime.consoleAPICalled', {
      type: 'warning',
      args: [{ value: 'deprecated API' }],
      timestamp: 1,
    });
    port.emit(1, 'Runtime.exceptionThrown', {
      exceptionDetails: { exception: { description: 'TypeError: x is undefined' } },
    });

    const entries = manager.getConsole(1);
    expect(entries[0]?.level).toBe('warn');
    expect(entries[1]?.level).toBe('error');
    expect(entries[1]?.text).toContain('TypeError');
  });

  it('redacts a secret at collection time, not at read time', async () => {
    // A credential must never sit in the buffer in plaintext waiting to be
    // read, because anything holding the manager could read it.
    await manager.attach(1);
    port.emit(1, 'Runtime.consoleAPICalled', {
      type: 'log',
      args: [
        {
          value: `session token: ${'eyJ' + 'hbGciOiJIUzI1NiJ9'}.${'eyJ' + 'zdWIiOiIxIn0'}.abcdefghijklmnop`,
        },
      ],
    });

    expect(manager.getConsole(1)[0]?.text).toContain('[REDACTED]');
    expect(JSON.stringify(manager.getConsole(1))).not.toContain('eyJ' + 'hbGciOiJIUzI1NiJ9');
  });

  it('renders object arguments without producing [object Object]', async () => {
    await manager.attach(1);
    port.emit(1, 'Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ value: { status: 500, path: '/api' } }],
    });
    expect(manager.getConsole(1)[0]?.text).toContain('500');
    expect(manager.getConsole(1)[0]?.text).not.toContain('[object Object]');
  });

  it('bounds the buffer so a noisy page cannot exhaust memory', async () => {
    await manager.attach(1);
    for (let i = 0; i < 500; i += 1) {
      port.emit(1, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: `m${i}` }] });
    }
    const entries = manager.getConsole(1);
    expect(entries.length).toBeLessThanOrEqual(200);
    // The most recent entries are the ones kept.
    expect(entries.at(-1)?.text).toBe('m499');
  });

  it('ignores events for a tab it is not attached to', () => {
    port.emit(99, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'x' }] });
    expect(manager.getConsole(99)).toEqual([]);
  });
});

describe('network collection', () => {
  it('records requests and merges the response', async () => {
    await manager.attach(1);
    port.emit(1, 'Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://api.test/items', method: 'POST', headers: { Accept: '*/*' } },
    });
    port.emit(1, 'Network.responseReceived', {
      requestId: 'r1',
      response: { status: 201, statusText: 'Created', mimeType: 'application/json', headers: {} },
    });

    const [entry] = manager.getNetwork(1);
    expect(entry?.method).toBe('POST');
    expect(entry?.status).toBe(201);
  });

  it('redacts request and response headers by name', async () => {
    await manager.attach(1);
    port.emit(1, 'Network.requestWillBeSent', {
      requestId: 'r1',
      request: {
        url: 'https://api.test/items',
        method: 'GET',
        headers: { Authorization: 'Bearer super-secret-value', Accept: 'application/json' },
      },
    });
    port.emit(1, 'Network.responseReceived', {
      requestId: 'r1',
      response: { status: 200, headers: { 'Set-Cookie': 'session=abc; HttpOnly' } },
    });

    const [entry] = manager.getNetwork(1);
    expect(entry?.requestHeaders.Authorization).toBe('[REDACTED]');
    expect(entry?.requestHeaders.Accept).toBe('application/json');
    expect(entry?.responseHeaders?.['Set-Cookie']).toBe('[REDACTED]');
    expect(JSON.stringify(manager.getNetwork(1))).not.toContain('super-secret-value');
  });

  it('redacts a token carried in the URL query string', async () => {
    await manager.attach(1);
    port.emit(1, 'Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://api.test/items?api_key=abcdef1234567890abcdef', method: 'GET' },
    });
    expect(manager.getNetwork(1)[0]?.url).toContain('[REDACTED]');
  });

  it('records a failure', async () => {
    await manager.attach(1);
    port.emit(1, 'Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://api.test/x', method: 'GET' },
    });
    port.emit(1, 'Network.loadingFailed', { requestId: 'r1', errorText: 'net::ERR_FAILED' });

    expect(manager.getNetwork(1)[0]?.failed).toBe(true);
    expect(manager.getNetwork(1)[0]?.errorText).toBe('net::ERR_FAILED');
  });

  it('bounds the request buffer', async () => {
    await manager.attach(1);
    for (let i = 0; i < 400; i += 1) {
      port.emit(1, 'Network.requestWillBeSent', {
        requestId: `r${i}`,
        request: { url: `https://api.test/${i}`, method: 'GET' },
      });
    }
    expect(manager.getNetwork(1).length).toBeLessThanOrEqual(200);
  });
});

describe('debugger tools', () => {
  it('returns console output wrapped as untrusted data', async () => {
    const adapter = new FakeBrowserAdapter();
    adapter.addTab({ id: 1, url: 'https://example.com/', active: true });
    const harness = createHarness(createDebuggerTools({ adapter, manager }));

    await manager.attach(1);
    port.emit(1, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'Save failed' }] });

    const result = await harness.registry.dispatch({
      toolCallId: 'tc',
      taskId: 't1',
      sessionId: 's1',
      name: 'debugger.console',
      arguments: {},
      tabId: 1,
      signal: new AbortController().signal,
    });

    const data = result.envelope.result as { entries: string };
    expect(data.entries).toContain('UNTRUSTED_EXTERNAL_CONTENT');
    expect(data.entries).toContain('Save failed');
    expect(result.evidence[0]?.type).toBe('CONSOLE');
  });

  it('refuses to inspect a non-automatable page', async () => {
    const adapter = new FakeBrowserAdapter();
    adapter.addTab({ id: 1, url: 'chrome://settings', active: true });
    const harness = createHarness(createDebuggerTools({ adapter, manager }));

    const result = await harness.registry.dispatch({
      toolCallId: 'tc',
      taskId: 't1',
      sessionId: 's1',
      name: 'debugger.dom',
      arguments: {},
      tabId: 1,
      signal: new AbortController().signal,
    });

    expect(result.envelope.error?.code).toBe('POLICY_BLOCKED');
  });
});

describe('dispose', () => {
  it('removes listeners and clears buffers', async () => {
    await manager.attach(1);
    const removeSpy = vi.spyOn(port.onEvent, 'removeListener');
    manager.dispose();
    expect(removeSpy).toHaveBeenCalled();
    expect(manager.isAttached(1)).toBe(false);
  });
});
