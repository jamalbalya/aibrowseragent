/**
 * Message router.
 *
 * Dispatches typed side-panel requests to handlers and guarantees every reply
 * is a `ResponseEnvelope`, so an error crosses the boundary as data rather
 * than as an unhandled rejection the panel cannot interpret.
 */
import { getLogger } from '@/logging/logger';
import { createError, type AgentError } from '@/types/result';
import { responseErr, responseOk } from '@/messaging/bus';
import type {
  ExtensionMessage,
  PanelRequest,
  PanelRequestType,
  PanelResponse,
  ResponseEnvelope,
} from '@/messaging/protocol';
import { EVENT_MESSAGE_TYPE } from '@/messaging/protocol';

const log = getLogger('messaging');

export type PanelHandler<T extends PanelRequestType> = (
  payload: PanelRequest<T>,
) => Promise<PanelResponse<T>>;

type AnyHandler = (payload: unknown) => Promise<unknown>;

export class MessageRouter {
  private readonly handlers = new Map<string, AnyHandler>();

  on<T extends PanelRequestType>(type: T, handler: PanelHandler<T>): void {
    this.handlers.set(type, handler as AnyHandler);
  }

  /** True when a message type has a handler. */
  handles(type: string): boolean {
    return this.handlers.has(type);
  }

  async route(type: string, payload: unknown): Promise<ResponseEnvelope<unknown>> {
    const handler = this.handlers.get(type);
    if (!handler) {
      return responseErr(
        createError('TOOL_NOT_FOUND', `No handler for message type "${type}".`, {
          userMessage: 'The extension received a request it does not understand.',
        }),
      );
    }
    try {
      return responseOk(await handler(payload));
    } catch (error) {
      return responseErr(toAgentError(error, type));
    }
  }

  /**
   * Installs the `chrome.runtime.onMessage` listener.
   *
   * Returning `true` keeps the message channel open for the async reply; the
   * listener must return synchronously, hence the void-promise pattern.
   */
  attach(): void {
    chrome.runtime.onMessage.addListener(
      (message: unknown, _sender, sendResponse: (response: ResponseEnvelope<unknown>) => void) => {
        const typed = message as ExtensionMessage<string, unknown> | undefined;
        if (!typed?.type) return false;
        // Broadcast events echo back to the worker; they are not requests.
        if (typed.type === EVENT_MESSAGE_TYPE) return false;
        if (!this.handles(typed.type)) return false;

        void this.route(typed.type, typed.payload).then(
          (envelope) => sendResponse(envelope),
          (error: unknown) => sendResponse(responseErr(toAgentError(error, typed.type))),
        );
        return true;
      },
    );
  }
}

interface MaybeAgentError {
  readonly agentError?: AgentError;
}

function toAgentError(error: unknown, type: string): AgentError {
  const wrapped = (error as MaybeAgentError | null)?.agentError;
  if (wrapped?.code) return wrapped;

  log.error('Message handler failed.', {
    type,
    error: error instanceof Error ? error.message : String(error),
  });
  return createError('INTERNAL_ERROR', `Handling "${type}" failed.`, {
    userMessage: 'The extension could not complete that request.',
    technicalDetails: error instanceof Error ? error.message : String(error),
  });
}
