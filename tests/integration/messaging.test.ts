/**
 * TEST-MESSAGING-001 — Typed message bus and router (REQ-MESSAGING-001).
 */
import { describe, expect, it, vi } from 'vitest';
import { MessageRouter } from '@/background/message-router';
import {
  MessagingError,
  sendToBackground,
  sendToContent,
  responseErr,
  responseOk,
  type MessagingPort,
} from '@/messaging/bus';
import { createError } from '@/types/result';
import { EVENT_MESSAGE_TYPE, type ExtensionMessage } from '@/messaging/protocol';
import { TEST_IDENTITY, panelSender } from '../fixtures/senders';

/** Routes messages straight into a MessageRouter, as the worker would. */
function portFor(router: MessageRouter): MessagingPort {
  const send = async (message: unknown): Promise<unknown> => {
    const typed = message as ExtensionMessage<string, unknown>;
    return router.route(typed.type, typed.payload, panelSender);
  };
  return { sendMessage: send, sendMessageToTab: (_tabId, message) => send(message) };
}

describe('MessageRouter', () => {
  it('routes a request to its handler and wraps the reply', async () => {
    const router = new MessageRouter({ identity: TEST_IDENTITY });
    router.on('task.list', ({ limit }) => Promise.resolve({ tasks: [], ...(limit ? {} : {}) }));

    const envelope = await router.route('task.list', { limit: 5 }, panelSender);
    expect(envelope).toEqual({ ok: true, value: { tasks: [] } });
  });

  it('refuses a message type that has no route class, rather than looking for a handler', async () => {
    // Default deny. An unclassified route is not "unknown" to be reported as
    // missing — it is unreachable until someone assigns it a class, which is
    // what stops a route added later from being callable by everything.
    const envelope = await new MessageRouter({ identity: TEST_IDENTITY }).route(
      'nope',
      {},
      panelSender,
    );
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe('PERMISSION_DENIED');
  });

  it('reports a classified route with no handler as data, not as a throw', async () => {
    const envelope = await new MessageRouter({ identity: TEST_IDENTITY }).route(
      'task.get',
      { taskId: 'x' },
      panelSender,
    );
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe('TOOL_NOT_FOUND');
  });

  it('converts a handler throw into a structured error envelope', async () => {
    const router = new MessageRouter({ identity: TEST_IDENTITY });
    router.on('task.get', () => Promise.reject(new Error('database unavailable at /var/db')));

    const envelope = await router.route('task.get', { taskId: 'x' }, panelSender);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe('INTERNAL_ERROR');
      // Internal detail is preserved for debugging but kept out of the
      // user-facing message.
      expect(envelope.error.userMessage).not.toContain('/var/db');
      expect(envelope.error.technicalDetails).toContain('/var/db');
    }
  });

  it('preserves a structured error a handler already produced', async () => {
    const router = new MessageRouter({ identity: TEST_IDENTITY });
    router.on('task.cancel', () =>
      Promise.reject(
        Object.assign(new Error('nope'), {
          agentError: createError('PERMISSION_DENIED', 'Not allowed.'),
        }),
      ),
    );

    const envelope = await router.route('task.cancel', { taskId: 'x' }, panelSender);
    if (!envelope.ok) expect(envelope.error.code).toBe('PERMISSION_DENIED');
  });

  it('knows which types it handles', () => {
    const router = new MessageRouter({ identity: TEST_IDENTITY });
    router.on('task.list', () => Promise.resolve({ tasks: [] }));
    expect(router.handles('task.list')).toBe(true);
    expect(router.handles('task.get')).toBe(false);
  });
});

describe('sendToBackground', () => {
  it('unwraps a successful response', async () => {
    const router = new MessageRouter({ identity: TEST_IDENTITY });
    router.on('provider.getConnection', () => Promise.resolve({ connection: null }));

    const result = await sendToBackground('provider.getConnection', {}, { port: portFor(router) });
    expect(result).toEqual({ connection: null });
  });

  it('throws a MessagingError carrying the structured error', async () => {
    const router = new MessageRouter({ identity: TEST_IDENTITY });
    router.on('task.get', () =>
      Promise.reject(
        Object.assign(new Error('x'), { agentError: createError('TAB_NOT_FOUND', 'Gone.') }),
      ),
    );

    await expect(
      sendToBackground('task.get', { taskId: 'x' }, { port: portFor(router) }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof MessagingError && error.agentError.code === 'TAB_NOT_FOUND',
    );
  });

  it('reports a missing response rather than returning undefined', async () => {
    const port: MessagingPort = {
      sendMessage: () => Promise.resolve(undefined),
      sendMessageToTab: () => Promise.resolve(undefined),
    };
    await expect(sendToBackground('session.get', {}, { port })).rejects.toBeInstanceOf(
      MessagingError,
    );
  });

  it('times out a request that never settles', async () => {
    const port: MessagingPort = {
      sendMessage: () => new Promise(() => undefined),
      sendMessageToTab: () => new Promise(() => undefined),
    };

    await expect(sendToBackground('session.get', {}, { port, timeoutMs: 20 })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof MessagingError && error.agentError.code === 'TASK_TIMEOUT',
    );
  });
});

describe('sendToContent', () => {
  it('maps a missing content script to a retryable PAGE_NOT_READY', async () => {
    const port: MessagingPort = {
      sendMessage: () => Promise.reject(new Error('Could not establish connection.')),
      sendMessageToTab: () =>
        Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')),
    };

    try {
      await sendToContent(1, 'content.ping', {}, { port });
      expect.unreachable();
    } catch (error) {
      const agentError = (error as MessagingError).agentError;
      expect(agentError.code).toBe('PAGE_NOT_READY');
      expect(agentError.retryable).toBe(true);
    }
  });

  it('maps a closed port to a retryable failure', async () => {
    const port: MessagingPort = {
      sendMessage: () => Promise.reject(new Error('x')),
      sendMessageToTab: () =>
        Promise.reject(new Error('The message port closed before a response was received.')),
    };

    try {
      await sendToContent(1, 'content.getState', {}, { port });
      expect.unreachable();
    } catch (error) {
      expect((error as MessagingError).agentError.code).toBe('PAGE_NOT_READY');
    }
  });

  it('passes the payload through to the tab', async () => {
    // A page shaped the way a real one is. `{ page: {} }` no longer gets
    // through: the transport validates the field observations a page read
    // carries, and a response missing them is a response that did not come
    // from this build's content script.
    const sendMessageToTab = vi.fn().mockResolvedValue(responseOk({ page: { fields: [] } }));
    await sendToContent(
      7,
      'content.readPage',
      { maxElements: 50 },
      { port: { sendMessage: vi.fn(), sendMessageToTab } },
    );

    const [tabId, message] = sendMessageToTab.mock.calls[0]!;
    expect(tabId).toBe(7);
    expect((message as ExtensionMessage<string, unknown>).type).toBe('content.readPage');
    expect((message as ExtensionMessage<string, { maxElements: number }>).payload).toEqual({
      maxElements: 50,
    });
  });
});

describe('envelopes', () => {
  it('builds ok and error envelopes', () => {
    expect(responseOk(1)).toEqual({ ok: true, value: 1 });
    const error = createError('NETWORK_ERROR', 'x');
    expect(responseErr(error)).toEqual({ ok: false, error });
  });

  it('gives every message an id and a timestamp', async () => {
    const sendMessage = vi.fn().mockResolvedValue(responseOk({ tasks: [] }));
    await sendToBackground('task.list', {}, { port: { sendMessage, sendMessageToTab: vi.fn() } });

    const message = sendMessage.mock.calls[0]![0] as ExtensionMessage<string, unknown>;
    expect(message.id).toMatch(/^msg_/);
    expect(typeof message.timestamp).toBe('number');
  });

  it('uses a distinct type for broadcast events so they are not routed as requests', () => {
    expect(EVENT_MESSAGE_TYPE).toBe('agent.event');
    expect(new MessageRouter({ identity: TEST_IDENTITY }).handles(EVENT_MESSAGE_TYPE)).toBe(false);
  });
});
