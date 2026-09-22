/**
 * The guarded transport for connector API calls.
 *
 * It does not reimplement the egress gate. It builds a connector destination
 * and calls `guardedSend`, which is the same function the AI provider
 * transport calls — one authorization model, two façades, because a connector
 * and a provider are different domains that must not share an identity type.
 *
 * Two things this adds that the provider transport does not need:
 *
 * **Redirects are not followed.** `redirect: 'manual'` is set on every
 * request. An API that can be made to redirect is an API that can be made to
 * send a bearer token to an origin the user never authorised, and "the fetch
 * followed it" is not a decision anyone made.
 *
 * What arrives then depends on the runtime, and both shapes are handled
 * because both actually occur. In a browser, `redirect: 'manual'` yields an
 * *opaque redirect*: `type === 'opaqueredirect'`, status 0, no headers at
 * all — measured in Chromium rather than assumed. There is no target to
 * inspect, so the only honest answer is to refuse. Outside a browser, and in
 * tests, the 3xx is surfaced with its `Location`, and then the target is
 * checked against the connector's declared origins and re-authorised as its
 * own transfer if it stays inside them.
 *
 * Either way the token goes to the declared origin and stops there.
 *
 * **The token is attached here and only here.** The caller passes an
 * operation and a body; it never holds a credential, so it cannot leak one.
 */

import { getLogger } from '@/logging/logger';
import { connectorDestination } from '@/security/egress/destination';
import { guardedSend, type GuardedSendOptions } from '@/security/egress/provider-transport';
import type { EgressDecision } from '@/security/egress/egress-gate';
import type { TaintState } from '@/security/taint/taint-state';
import type { ConnectorDescriptor } from '@/connectors/core/types';
import type { TokenVault } from '@/connectors/oauth/token-vault';

const log = getLogger('security');

/** Security context for one connector call, carried with the request. */
export interface ConnectorEgressContext {
  readonly taskId: string;
  readonly taintState: TaintState;
  readonly taintSalt: string;
  readonly saltEpoch: number;
  readonly taintSignature: string;
  readonly connectorId: string;
  readonly operationId: string;
}

export interface ConnectorRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export type ConnectorTransportFailure =
  'DESTINATION_NOT_DECLARED' | 'REDIRECT_REFUSED' | 'NOT_AUTHENTICATED';

export class ConnectorTransportError extends Error {
  constructor(
    readonly failure: ConnectorTransportFailure,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorTransportError';
  }
}

export interface ConnectorTransport {
  send(request: ConnectorRequest, context: ConnectorEgressContext): Promise<Response>;
}

export interface ConnectorTransportOptions {
  readonly descriptor: ConnectorDescriptor;
  readonly vault: TokenVault;
  readonly consent: GuardedSendOptions['consent'];
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly onDecision?: (
    decision: EgressDecision,
    context: ConnectorEgressContext,
    url: string,
    payload: unknown,
  ) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** A redirect chain has to end; each hop is re-checked against the origins. */
const MAX_REDIRECTS = 3;

export function createConnectorTransport(options: ConnectorTransportOptions): ConnectorTransport {
  const now = options.now ?? (() => Date.now());
  const allowed = new Set(
    options.descriptor.apiOrigins.map((origin) => new URL(origin).origin.toLowerCase()),
  );

  /**
   * Caller headers, with any spelling of `Authorization` removed.
   *
   * Applying the credential last is only a guarantee if the caller cannot
   * have written the same header under a different casing: HTTP header names
   * are case-insensitive, so `{ authorization: 'x', Authorization: token }`
   * is two keys to an object literal and one header to `fetch`, and which
   * one survives is not something to leave to key order. Stripping every
   * spelling first makes "applied last" mean what it says.
   */
  const withoutAuthorization = (
    headers: Readonly<Record<string, string>> | undefined,
  ): Record<string, string> => {
    const kept: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (name.toLowerCase() === 'authorization') continue;
      kept[name] = value;
    }
    return kept;
  };

  const assertDeclared = (url: string): void => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ConnectorTransportError('DESTINATION_NOT_DECLARED', 'That is not a usable URL.');
    }
    if (!allowed.has(parsed.origin.toLowerCase())) {
      // Scheme, host and port all participate: a connector authorised for
      // https://api.example is not authorised for http://api.example or for
      // https://api.example:8443.
      throw new ConnectorTransportError(
        'DESTINATION_NOT_DECLARED',
        `${options.descriptor.displayName} is not configured to reach ${parsed.origin}.`,
      );
    }
  };

  return {
    async send(request: ConnectorRequest, context: ConnectorEgressContext): Promise<Response> {
      let url = request.url;
      assertDeclared(url);

      const authorization = await options.vault.authorizationHeader(options.descriptor.id, now());
      if (authorization === null) {
        throw new ConnectorTransportError(
          'NOT_AUTHENTICATED',
          `${options.descriptor.displayName} is not connected, or its authorization expired.`,
        );
      }

      for (let hop = 0; ; hop += 1) {
        const response = await guardedSend(
          {
            url,
            init: {
              method: request.method,
              headers: {
                Accept: 'application/json',
                ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...withoutAuthorization(request.headers),
                // Applied last, over headers that can no longer carry any
                // spelling of this one, so a caller cannot displace it — and
                // never earlier, so it cannot be read back out.
                Authorization: authorization,
              },
              ...(request.body === undefined ? {} : { body: request.body }),
              // Never followed automatically. See the module comment.
              redirect: 'manual',
              signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
            },
            destination: connectorDestination(options.descriptor.id, url, {
              purpose: context.operationId,
              sensitivity: options.descriptor.defaultSensitivity,
            }),
            taskId: context.taskId,
            taintState: context.taintState,
            taintSalt: context.taintSalt,
            taintSignature: context.taintSignature,
            describe: `${options.descriptor.id}/${context.operationId}`,
          },
          {
            consent: options.consent,
            ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
            ...(options.now === undefined ? {} : { now: options.now }),
            ...(options.onDecision === undefined
              ? {}
              : {
                  onDecision: (decision, payload) =>
                    options.onDecision!(decision, context, url, payload),
                }),
          },
        );

        if (isOpaqueRedirect(response)) {
          // A browser refused to follow it and told us nothing about where it
          // pointed: no status, no `Location`, no body. Reporting it as a
          // redirect refusal is the accurate description; letting it fall
          // through would surface as "the service returned 0".
          log.warn('A connector response redirected opaquely and was refused.', {
            connectorId: options.descriptor.id,
          });
          throw new ConnectorTransportError(
            'REDIRECT_REFUSED',
            `${options.descriptor.displayName} redirected this request, and the browser ` +
              'does not reveal where. The request was not followed.',
          );
        }

        if (!isRedirect(response.status)) return response;

        const location = response.headers.get('location');
        if (location === null) {
          throw new ConnectorTransportError(
            'REDIRECT_REFUSED',
            'The service redirected without saying where.',
          );
        }
        if (hop >= MAX_REDIRECTS) {
          throw new ConnectorTransportError(
            'REDIRECT_REFUSED',
            'The service redirected too many times.',
          );
        }

        const target = resolve(location, url);
        log.info('A connector response redirected; re-checking the destination.', {
          connectorId: options.descriptor.id,
          status: response.status,
        });
        // The hop is authorised on its own terms: a new destination, a new
        // gate decision, and a refusal if it leaves the declared origins.
        assertDeclared(target);
        url = target;
      }
    },
  };
}

/**
 * A redirect a browser refused to follow and will not describe.
 *
 * `redirect: 'manual'` produces an opaque-redirect filtered response, whose
 * status is 0 and whose header list is empty. `type` is the reliable signal;
 * the status is checked too because a filtered response is the only thing
 * that legitimately arrives with a status of 0.
 */
function isOpaqueRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || (response.status === 0 && !response.ok);
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function resolve(location: string, base: string): string {
  try {
    return new URL(location, base).toString();
  } catch {
    throw new ConnectorTransportError(
      'REDIRECT_REFUSED',
      'The service redirected to something that is not a URL.',
    );
  }
}

/** A transport that refuses, for a connector built without one. */
export function refusingConnectorTransport(): ConnectorTransport {
  return {
    send: () =>
      Promise.reject(
        new ConnectorTransportError(
          'NOT_AUTHENTICATED',
          'This connector was constructed without a guarded transport, so it has no ' +
            'authorised way to reach the network.',
        ),
      ),
  };
}
