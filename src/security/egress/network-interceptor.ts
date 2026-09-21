/**
 * Worker-scope network interception (Stage 3 B2, step 9).
 *
 * Defence in depth, and explicitly **not** the security boundary.
 *
 * The boundary is that a provider adapter is constructed with a guarded
 * transport and has no other route to the network, and that every tool that
 * can transfer data declares an egress the registry puts through the gate.
 * This module exists for the case those miss: a module added later that
 * reaches for a global primitive directly.
 *
 * What it can cover is the service-worker scope only. A content script runs in
 * its own world and a page script in another; neither is reachable from here.
 * That limitation is intrinsic to MV3 and is why content scripts are confined
 * to message passing and never originate requests.
 *
 * It is enforceable within that scope because the extension's CSP omits
 * `unsafe-eval` and a worker has no DOM, so there is no route back to a
 * pristine `fetch` once the global has been replaced — provided the
 * replacement happens before anything else could capture the original, which
 * is why this is installed first in the worker entry.
 */

import { getLogger } from '@/logging/logger';

const log = getLogger('security');

export interface InterceptorOptions {
  /**
   * Called when a primitive is used outside the guarded transport.
   *
   * Default behaviour is to refuse. An allowlist predicate exists so the
   * guarded transport itself can pass, identified by a token rather than by
   * inspecting a stack trace.
   */
  readonly allow?: (url: string) => boolean;
}

/** Marks the one call site permitted to reach the network. */
export const GUARDED_REQUEST_MARKER = Symbol.for('aiba.guarded-egress');

interface GuardedInit extends RequestInit {
  [GUARDED_REQUEST_MARKER]?: true;
}

/**
 * Replaces the worker's network primitives.
 *
 * Returns a function that restores them, used by tests. Production never
 * restores: the worker entry installs this once per lifecycle and Chrome
 * re-runs the entry on every restart, so the wrapper is always present.
 */
export function installNetworkInterceptor(options: InterceptorOptions = {}): () => void {
  const scope = globalThis as unknown as Record<string, unknown>;
  const originalFetch = scope.fetch as typeof fetch | undefined;
  const originalXhr = scope.XMLHttpRequest;
  const originalWebSocket = scope.WebSocket;
  const originalEventSource = scope.EventSource;

  const refuse = (primitive: string): never => {
    log.error('Blocked an outbound call that bypassed the egress gate.', { primitive });
    throw new Error(
      `${primitive} was called outside the guarded transport. Outbound data must pass ` +
        'the egress authorization gate.',
    );
  };

  if (originalFetch) {
    scope.fetch = (input: RequestInfo | URL, init?: GuardedInit): Promise<Response> => {
      if (init?.[GUARDED_REQUEST_MARKER] === true) return originalFetch(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (options.allow?.(url) === true) return originalFetch(input, init);
      return refuse('fetch');
    };
  }

  if (originalXhr !== undefined) {
    scope.XMLHttpRequest = function BlockedXMLHttpRequest(): never {
      return refuse('XMLHttpRequest');
    };
  }
  if (originalWebSocket !== undefined) {
    scope.WebSocket = function BlockedWebSocket(): never {
      return refuse('WebSocket');
    };
  }
  if (originalEventSource !== undefined) {
    scope.EventSource = function BlockedEventSource(): never {
      return refuse('EventSource');
    };
  }

  return () => {
    if (originalFetch) scope.fetch = originalFetch;
    if (originalXhr !== undefined) scope.XMLHttpRequest = originalXhr;
    if (originalWebSocket !== undefined) scope.WebSocket = originalWebSocket;
    if (originalEventSource !== undefined) scope.EventSource = originalEventSource;
  };
}

/** Tags an init so the interceptor lets the guarded transport through. */
export function markGuarded(init: RequestInit): RequestInit {
  return { ...init, [GUARDED_REQUEST_MARKER]: true } as GuardedInit;
}
