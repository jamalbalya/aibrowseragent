/**
 * Typed message bus over `chrome.runtime` / `chrome.tabs` messaging.
 *
 * Provides request IDs, correlation, timeouts and structured errors so a
 * caller never has to interpret `chrome.runtime.lastError` by hand.
 */
import { newMessageId } from '@/utils/ids';
import { createError, type AgentError } from '@/types/result';
import { getLogger } from '@/logging/logger';
import {
  classifySender,
  extensionIdentity,
  senderMayBroadcastEvent,
  type MessageSenderLike,
} from './route-trust';
import type {
  AgentEvent,
  ContentRequest,
  ContentRequestType,
  ContentResponse,
  ExtensionMessage,
  PanelRequest,
  PanelRequestType,
  PanelResponse,
  ResponseEnvelope,
} from './protocol';
import { EVENT_MESSAGE_TYPE } from './protocol';

const log = getLogger('messaging');

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function envelope<T extends string, P>(type: T, payload: P): ExtensionMessage<T, P> {
  return { id: newMessageId(), type, timestamp: Date.now(), payload };
}

/**
 * The Chrome messaging surface this module needs.
 * Narrowing it to an interface keeps the bus testable without a browser.
 */
export interface MessagingPort {
  sendMessage(message: unknown): Promise<unknown>;
  sendMessageToTab(tabId: number, message: unknown, frameId?: number): Promise<unknown>;
}

export const chromeMessagingPort: MessagingPort = {
  sendMessage: (message) => chrome.runtime.sendMessage(message),
  sendMessageToTab: (tabId, message, frameId) =>
    frameId === undefined
      ? chrome.tabs.sendMessage(tabId, message)
      : chrome.tabs.sendMessage(tabId, message, { frameId }),
};

function unwrap<T>(raw: unknown, context: string): T {
  if (raw === undefined || raw === null) {
    throw new MessagingError(
      createError('INTERNAL_ERROR', `${context} returned no response.`, {
        userMessage: 'The extension did not respond. Try reloading the side panel.',
      }),
    );
  }
  const response = raw as ResponseEnvelope<T>;
  if (response.ok === false) throw new MessagingError(response.error);
  if (response.ok === true) return response.value;
  throw new MessagingError(
    createError('INTERNAL_ERROR', `${context} returned a malformed response.`),
  );
}

export class MessagingError extends Error {
  constructor(readonly agentError: AgentError) {
    super(agentError.message);
    this.name = 'MessagingError';
  }
}

function toMessagingError(error: unknown, context: string): MessagingError {
  if (error instanceof MessagingError) return error;
  const message = error instanceof Error ? error.message : String(error);
  // Chrome surfaces "Receiving end does not exist" when no listener is present.
  if (message.includes('Receiving end does not exist')) {
    return new MessagingError(
      createError('PAGE_NOT_READY', `${context}: no listener is available.`, {
        userMessage: 'The page is not ready for automation yet. Reload the tab and try again.',
        retryable: true,
      }),
    );
  }
  if (message.includes('message port closed')) {
    return new MessagingError(
      createError('PAGE_NOT_READY', `${context}: the message port closed.`, {
        userMessage: 'The page navigated away before it could respond.',
        retryable: true,
      }),
    );
  }
  return new MessagingError(
    createError('INTERNAL_ERROR', `${context} failed.`, { technicalDetails: message }),
  );
}

/** Side panel → service worker. */
export async function sendToBackground<T extends PanelRequestType>(
  type: T,
  payload: PanelRequest<T>,
  options: { timeoutMs?: number; port?: MessagingPort } = {},
): Promise<PanelResponse<T>> {
  const port = options.port ?? chromeMessagingPort;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  try {
    const raw = await promiseWithTimeout(
      port.sendMessage(envelope(type, payload)),
      timeoutMs,
      type,
    );
    return unwrap<PanelResponse<T>>(raw, type);
  } catch (error) {
    throw toMessagingError(error, type);
  }
}

/** Service worker → content script in a specific tab. */
export async function sendToContent<T extends ContentRequestType>(
  tabId: number,
  type: T,
  payload: ContentRequest<T>,
  options: { timeoutMs?: number; port?: MessagingPort; frameId?: number } = {},
): Promise<ContentResponse<T>> {
  const port = options.port ?? chromeMessagingPort;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  try {
    const raw = await promiseWithTimeout(
      port.sendMessageToTab(tabId, envelope(type, payload), options.frameId),
      timeoutMs,
      type,
    );
    return unwrap<ContentResponse<T>>(raw, type);
  } catch (error) {
    throw toMessagingError(error, type);
  }
}

/**
 * Broadcasts an event to any open side panel.
 *
 * Failures are swallowed: with no panel open there is no receiver, and that is
 * the normal case for a background task.
 */
export function broadcastEvent(event: AgentEvent, port: MessagingPort = chromeMessagingPort): void {
  void port.sendMessage(envelope(EVENT_MESSAGE_TYPE, event)).catch(() => {
    // No listener. Expected whenever the side panel is closed.
  });
}

export type EventHandler = (event: AgentEvent) => void;

/**
 * Subscribes the side panel to broadcast events. Returns an unsubscribe fn.
 *
 * Events are accepted only from the service worker. This channel carries
 * `permission.requested`, which the panel renders as a prompt — so an event
 * from anywhere else would put someone else's text in front of the person at
 * the one moment a human is the control. The payload is never trusted to say
 * where it came from; the sender is.
 */
export function subscribeToEvents(handler: EventHandler): () => void {
  const listener = (message: unknown, sender?: MessageSenderLike): undefined => {
    const typed = message as ExtensionMessage<string, unknown> | undefined;
    if (typed?.type !== EVENT_MESSAGE_TYPE) return undefined;
    if (!senderMayBroadcastEvent(classifySender(sender, extensionIdentity()))) {
      log.warn('A broadcast event was refused: it did not come from the service worker.');
      return undefined;
    }
    try {
      handler(typed.payload as AgentEvent);
    } catch (error) {
      log.warn('Event handler threw.', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return undefined;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

function promiseWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new MessagingError(
          createError('TASK_TIMEOUT', `${label} timed out after ${ms}ms.`, {
            userMessage: 'The extension did not respond in time.',
            retryable: true,
          }),
        ),
      );
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export const responseOk = <T>(value: T): ResponseEnvelope<T> => ({ ok: true, value });
export const responseErr = (error: AgentError): ResponseEnvelope<never> => ({ ok: false, error });
