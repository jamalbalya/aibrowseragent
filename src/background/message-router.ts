/**
 * Message router.
 *
 * Dispatches typed side-panel requests to handlers and guarantees every reply
 * is a `ResponseEnvelope`, so an error crosses the boundary as data rather
 * than as an unhandled rejection the panel cannot interpret.
 *
 * It is also where route trust is enforced. Every message is classified
 * before anything else happens:
 *
 *     classify sender → resolve route class → authorise → handler
 *
 * The order is the point. A refused message never reaches a handler, so it
 * cannot mutate state, resolve a pending permission or file selection, start
 * or replay anything, change policy, or produce an export — there is no
 * partially-executed case to reason about, because nothing ran.
 *
 * A route with no class is refused. Registering a handler grants nothing on
 * its own: a route added later is unreachable until someone writes down who
 * may call it, which is what keeps this from decaying one wave at a time.
 */
import { getLogger } from '@/logging/logger';
import { createError, type AgentError } from '@/types/result';
import { responseErr, responseOk } from '@/messaging/bus';
import {
  classifySender,
  extensionIdentity,
  panelRouteClass,
  senderMayInvokePanelRoute,
  type ExtensionIdentity,
  type MessageSenderLike,
  type RouteClass,
  type SenderClass,
} from '@/messaging/route-trust';
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

/** What a refusal reports. Closed vocabularies only — never a sender URL. */
export interface RouteRefusal {
  readonly route: string;
  readonly senderClass: SenderClass;
  readonly routeClass: RouteClass | undefined;
}

export interface MessageRouterOptions {
  /** Injected in tests; production resolves it from `chrome.runtime`. */
  readonly identity?: ExtensionIdentity;
  /**
   * Called when a message is refused.
   *
   * The worker uses this to write an audit record. It is given a route name
   * and a sender *class*, never the sender's URL: a URL is page-derived, and
   * page-derived text does not enter the audit trail.
   */
  readonly onRefused?: (refusal: RouteRefusal) => void;
}

export class MessageRouter {
  private readonly handlers = new Map<string, AnyHandler>();
  private identity: ExtensionIdentity | undefined;

  constructor(private readonly options: MessageRouterOptions = {}) {
    this.identity = options.identity;
  }

  on<T extends PanelRequestType>(type: T, handler: PanelHandler<T>): void {
    this.handlers.set(type, handler as AnyHandler);
  }

  /** True when a message type has a handler. */
  handles(type: string): boolean {
    return this.handlers.has(type);
  }

  /**
   * Authorises a message and routes it.
   *
   * `sender` is required rather than optional. An optional parameter would
   * make "I forgot to pass it" and "there was no sender" indistinguishable,
   * and one of those two is a bug that would silently disable the check.
   */
  async route(
    type: string,
    payload: unknown,
    sender: MessageSenderLike | undefined,
  ): Promise<ResponseEnvelope<unknown>> {
    const routeClass = panelRouteClass(type);
    const senderClass = classifySender(sender, this.resolveIdentity());

    // Trust first, and before the handler lookup: an untrusted sender learns
    // nothing about which routes exist from the shape of the refusal.
    if (routeClass === undefined || !senderMayInvokePanelRoute(senderClass, routeClass)) {
      this.refuse({ route: type, senderClass, routeClass });
      return responseErr(
        createError('PERMISSION_DENIED', 'This message is not allowed from its sender.', {
          userMessage: 'The extension refused a request that did not come from its own interface.',
          retryable: false,
        }),
      );
    }

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
      (
        message: unknown,
        sender: MessageSenderLike | undefined,
        sendResponse: (response: ResponseEnvelope<unknown>) => void,
      ) => {
        const typed = message as ExtensionMessage<string, unknown> | undefined;
        if (!typed?.type) return false;
        // Broadcast events echo back to the worker; they are not requests.
        if (typed.type === EVENT_MESSAGE_TYPE) return false;
        // An unrecognised type is left for another listener rather than
        // answered. Authorisation happens in `route` for everything this
        // router owns, refused types included.
        if (!this.handles(typed.type)) return false;

        void this.route(typed.type, typed.payload, sender).then(
          (envelope) => sendResponse(envelope),
          (error: unknown) => sendResponse(responseErr(toAgentError(error, typed.type))),
        );
        return true;
      },
    );
  }

  private resolveIdentity(): ExtensionIdentity {
    this.identity ??= extensionIdentity();
    return this.identity;
  }

  private refuse(refusal: RouteRefusal): void {
    log.warn('A message was refused by route trust.', {
      route: refusal.route,
      senderClass: refusal.senderClass,
      routeClass: refusal.routeClass ?? '(unclassified)',
    });
    try {
      this.options.onRefused?.(refusal);
    } catch (error) {
      // Reporting a refusal must not turn it into something else. The message
      // is already denied; a failure here changes nothing about that.
      log.warn('Reporting a route refusal failed.', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
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
