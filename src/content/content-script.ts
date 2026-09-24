/**
 * Content script.
 *
 * Deliberately thin (specification section 6.3): it extracts a semantic page
 * model and performs DOM interactions, and does nothing else. No planning, no
 * provider calls, no policy decisions — those live in the service worker where
 * they cannot be reached by page script.
 *
 * The script runs in an isolated world, so page JavaScript cannot call into
 * it, but the page fully controls the DOM it reads. Everything produced here
 * is therefore untrusted data.
 */
import {
  ElementRegistry,
  describeActedOn,
  extractSemanticPage,
  observeField,
} from './semantic-tree';
import { classifyField, exceedsCeiling, type FieldClass } from '@/policy/field-sensitivity';
import {
  performAttachFiles,
  performClearFiles,
  performClick,
  performScroll,
  performSelect,
  performSelectMany,
  performSetValue,
  performSetChecked,
  performType,
  resolveActionable,
  resolveFileInput,
  type InteractionFailure,
} from './interaction-engine';
import type {
  ContentRequest,
  ContentRequestType,
  ContentResponse,
  ExtensionMessage,
  ResponseEnvelope,
} from '@/messaging/protocol';
import {
  classifySender,
  extensionIdentity,
  senderMayInvokeContentRoute,
  type MessageSenderLike,
} from '@/messaging/route-trust';
import { createError } from '@/types/result';

const registry = new ElementRegistry();

/**
 * Refuses a write whose live target is more sensitive than it was authorised
 * against.
 *
 * This closes the window the worker cannot: the worker classified a field as
 * it was when the page was read, and a page is free to change it afterwards.
 * Re-observing the element here, microseconds before the write, is the only
 * place that mutation is visible at all.
 *
 * It refuses and nothing else. The ceiling is supplied by the worker and
 * travels in one direction, so there is no value this function could compute
 * that would let a write through that the worker had not already allowed —
 * the most it can do is stop one. That asymmetry is the reason this is safe to
 * run in a context the page shares a process with.
 */
function refuseIfAboveCeiling(element: Element, handle: string, ceiling: FieldClass): void {
  const live = classifyField(observeField(element, handle, 'main'));
  if (!exceedsCeiling(live, ceiling)) return;
  throw new InteractionRejection(
    'SENSITIVE_FIELD_REFUSED',
    'This field is more sensitive than the action that was approved for it. ' +
      'Read the page again so it can be checked afresh.',
  );
}

/**
 * One handler per request type, each receiving its own payload type.
 *
 * The mapped type ties payload and return value to the protocol, so adding a
 * request without handling it here is a compile error.
 */
type Handlers = {
  [K in ContentRequestType]: (
    payload: ContentRequest<K>,
  ) => ContentResponse<K> | Promise<ContentResponse<K>>;
};

const handlers: Handlers = {
  'content.ping': () => ({ ready: true as const, url: location.href }),

  'content.readPage': (payload) => ({
    page: extractSemanticPage(document, registry, {
      ...(payload.maxElements === undefined ? {} : { maxElements: payload.maxElements }),
      ...(payload.includeText === undefined ? {} : { includeText: payload.includeText }),
    }),
  }),

  'content.click': (payload) => {
    const resolved = resolveActionable(registry, payload.elementId);
    if (!resolved.ok)
      throw new InteractionRejection(resolved.error.failure, resolved.error.message);

    // Described before the action, because a click can navigate away or
    // detach the node — after which there is nothing left to describe.
    const actedOn = describeActedOn(registry, resolved.element);

    const before = location.href;
    performClick(resolved.element);
    // A synchronous same-document navigation shows up immediately; a network
    // navigation is detected by the caller via tab state, not here.
    return {
      clicked: true as const,
      navigated: location.href !== before,
      ...(actedOn === undefined ? {} : { actedOn }),
    };
  },

  'content.type': (payload) => {
    const resolved = resolveActionable(registry, payload.elementId);
    if (!resolved.ok)
      throw new InteractionRejection(resolved.error.failure, resolved.error.message);
    // Before the action: typing can change an element's own accessible name
    // — a field labelled by its contents is named after whatever is in it —
    // so describing it afterwards would describe the state the action
    // produced rather than the one it targeted.
    refuseIfAboveCeiling(resolved.element, payload.elementId, payload.sensitivityCeiling);
    const actedOn = describeActedOn(registry, resolved.element);

    performType(resolved.element, payload.text, {
      ...(payload.clearFirst === undefined ? {} : { clearFirst: payload.clearFirst }),
      ...(payload.submit === undefined ? {} : { submit: payload.submit }),
    });
    return { typed: true as const, ...(actedOn === undefined ? {} : { actedOn }) };
  },

  'content.setValue': (payload) => {
    const resolved = resolveActionable(registry, payload.elementId);
    if (!resolved.ok)
      throw new InteractionRejection(resolved.error.failure, resolved.error.message);
    refuseIfAboveCeiling(resolved.element, payload.elementId, payload.sensitivityCeiling);
    // Described before the change, for the same reason click and type are:
    // a field labelled by its own contents is named after whatever is in it.
    const actedOn = describeActedOn(registry, resolved.element);
    const result = performSetValue(resolved.element, payload.value);
    return { ...result, ...(actedOn === undefined ? {} : { actedOn }) };
  },

  'content.selectMany': (payload) => {
    const resolved = resolveActionable(registry, payload.elementId);
    if (!resolved.ok)
      throw new InteractionRejection(resolved.error.failure, resolved.error.message);
    const actedOn = describeActedOn(registry, resolved.element);
    const result = performSelectMany(resolved.element, payload.values);
    return { ...result, ...(actedOn === undefined ? {} : { actedOn }) };
  },

  'content.select': (payload) => {
    const resolved = resolveActionable(registry, payload.elementId);
    if (!resolved.ok)
      throw new InteractionRejection(resolved.error.failure, resolved.error.message);
    const actedOn = describeActedOn(registry, resolved.element);
    const result = performSelect(resolved.element, payload.value);
    return {
      selected: true as const,
      value: result.value,
      ...(actedOn === undefined ? {} : { actedOn }),
    };
  },

  'content.setChecked': (payload) => {
    const resolved = resolveActionable(registry, payload.elementId);
    if (!resolved.ok)
      throw new InteractionRejection(resolved.error.failure, resolved.error.message);
    const actedOn = describeActedOn(registry, resolved.element);
    return {
      ...performSetChecked(resolved.element, payload.checked),
      ...(actedOn === undefined ? {} : { actedOn }),
    };
  },

  /**
   * Puts already-selected files into a file input.
   *
   * Resolved through `resolveFileInput`, which allows a hidden input: the
   * usual upload control is a styled button beside one the page has hidden,
   * and the file was chosen by the user in a picker before this ran.
   */
  'content.attachFiles': (payload) => {
    const resolved = resolveFileInput(registry, payload.elementId);
    if (!resolved.ok)
      throw new InteractionRejection(resolved.error.failure, resolved.error.message);
    try {
      const result = performAttachFiles(resolved.element as HTMLInputElement, payload.files);
      return { ...result, names: [...result.names] };
    } catch (error) {
      const failure = (error as { failure?: InteractionFailure }).failure;
      throw new InteractionRejection(
        failure ?? 'WRONG_ELEMENT_TYPE',
        error instanceof Error ? error.message : 'The files could not be attached.',
      );
    }
  },

  'content.clearFiles': (payload) => {
    const resolved = resolveFileInput(registry, payload.elementId);
    if (!resolved.ok)
      throw new InteractionRejection(resolved.error.failure, resolved.error.message);
    performClearFiles(resolved.element as HTMLInputElement);
    return { cleared: true as const };
  },

  'content.scroll': (payload) => performScroll(window, payload.direction, payload.amount),

  'content.getState': () => ({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    scrollY: window.scrollY,
    documentHeight: document.documentElement.scrollHeight,
  }),

  'content.waitForSelector': (payload) => waitForSelector(payload.selector, payload.timeoutMs),
};

/** A refusal the service worker maps onto a canonical error code. */
class InteractionRejection extends Error {
  constructor(
    readonly failure: string,
    message: string,
  ) {
    super(message);
    this.name = 'InteractionRejection';
  }
}

function waitForSelector(selector: string, timeoutMs: number): Promise<{ found: boolean }> {
  // Validate before observing: an invalid selector would throw inside the
  // MutationObserver callback where it cannot be reported cleanly.
  try {
    document.querySelector(selector);
  } catch {
    return Promise.reject(
      new InteractionRejection('INVALID_SELECTOR', 'The selector is not valid CSS.'),
    );
  }

  if (document.querySelector(selector)) return Promise.resolve({ found: true });

  return new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        observer.disconnect();
        resolve({ found: false });
      },
      Math.min(timeoutMs, 60_000),
    );

    const observer = new MutationObserver(() => {
      if (document.querySelector(selector)) {
        clearTimeout(timer);
        observer.disconnect();
        resolve({ found: true });
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  });
}

function toErrorEnvelope(error: unknown): ResponseEnvelope<never> {
  if (error instanceof InteractionRejection) {
    // A sensitivity refusal is reported as one. Mapping it onto
    // `ELEMENT_NOT_FOUND` would tell the model the handle was wrong, and the
    // model would helpfully read the page again and retry — turning a refusal
    // into a loop instead of a stop.
    const code =
      error.failure === 'SENSITIVE_FIELD_REFUSED'
        ? 'POLICY_BLOCKED'
        : error.failure === 'NOT_ENABLED' || error.failure === 'NOT_VISIBLE'
          ? 'ELEMENT_NOT_INTERACTABLE'
          : 'ELEMENT_NOT_FOUND';
    return {
      ok: false,
      error: createError(code, error.message, {
        userMessage: error.message,
        retryable: error.failure !== 'SENSITIVE_FIELD_REFUSED',
      }),
    };
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return {
      ok: false,
      error: createError('ELEMENT_NOT_INTERACTABLE', error.message, {
        userMessage: error.message,
      }),
    };
  }
  return {
    ok: false,
    error: createError('INTERNAL_ERROR', 'The content script failed.', {
      // Page-derived text stays out of the model-facing message.
      technicalDetails: error instanceof Error ? error.message : String(error),
    }),
  };
}

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    sender: MessageSenderLike | undefined,
    sendResponse: (response: ResponseEnvelope<unknown>) => void,
  ) => {
    const typed = message as ExtensionMessage<ContentRequestType, unknown> | undefined;
    // Dispatch is dynamic, so the handler is widened here. The `Handlers`
    // mapped type above is what keeps each individual handler honest.
    const handler = typed
      ? (handlers as Record<string, ((payload: unknown) => unknown) | undefined>)[typed.type]
      : undefined;
    if (!typed || !handler) return false;

    // These requests arrive by `chrome.tabs.sendMessage`, which a content
    // script cannot call — but that is a property of the platform, not
    // something this extension established. Checking the sender is what makes
    // it a boundary rather than an accident of the API surface.
    if (!senderMayInvokeContentRoute(classifySender(sender, extensionIdentity()))) {
      sendResponse({
        ok: false,
        error: createError('PERMISSION_DENIED', 'This message is not allowed from its sender.'),
      });
      return false;
    }

    try {
      const result: unknown = handler(typed.payload);
      if (result instanceof Promise) {
        result.then(
          (value) => sendResponse({ ok: true, value }),
          (error: unknown) => sendResponse(toErrorEnvelope(error)),
        );
        // Keeps the message channel open for the async response.
        return true;
      }
      sendResponse({ ok: true, value: result });
    } catch (error) {
      sendResponse(toErrorEnvelope(error));
    }
    return false;
  },
);
