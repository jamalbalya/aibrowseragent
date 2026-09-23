/**
 * The guarded transport for authentication requests.
 *
 * It does not reimplement the egress gate: it builds an identity destination
 * and calls `guardedSend`, the same function the provider and connector
 * transports call. One authorization model, three façades.
 *
 * **It takes no task context, by design.** An authentication request is
 * started by a person clicking a button in the side panel, not by a model
 * turn, so there is no task whose reads could be carried out on it. The
 * security context it presents is therefore true rather than borrowed: a
 * fresh, untainted state that says this transfer carries nothing a page
 * produced, because no page was involved.
 *
 * That is also why this is not reachable from a task. There is no tool, no
 * `ToolRegistry` entry and no dispatch path that leads here — a model cannot
 * ask for an authentication request, so the channel cannot be used to launder
 * a task's egress through a destination the gate would otherwise refuse.
 *
 * **It creates no fourth network primitive.** `guardedSend` performs the
 * fetch, and this module supplies no implementation for it to use — not in
 * production and not in tests. It names no network primitive at all, which
 * is what keeps the three holders three, and is what `IDENTITY_AND_SYNC.md`
 * §T asks for in so many words.
 *
 * A test drives it by replacing the global the egress module falls back to,
 * which is a thing tests may do and this module may not.
 */
import { getLogger } from '@/logging/logger';
import { identityDestination } from '@/security/egress/destination';
import { guardedSend } from '@/security/egress/provider-transport';
import { ConsentStore } from '@/security/egress/consent';
import { freshTaint } from '@/security/taint/taint-state';
import type { IdentityConfig } from './identity-config';

const log = getLogger('security');

/** The bytes this transport may send. Nothing else has a shape here. */
export interface IdentityRequest {
  readonly path: string;
  readonly body: Record<string, string>;
  /** Set only for the requests that carry one. Never logged. */
  readonly bearer?: string;
}

export interface IdentityResponse {
  readonly status: number;
  readonly body: unknown;
}

/** A synthetic, non-colliding task id for the gate's records. */
const IDENTITY_CONTEXT = 'identity';

export class IdentityTransportError extends Error {
  constructor(
    readonly code: 'NOT_CONFIGURED' | 'OFF_ORIGIN' | 'REFUSED' | 'UNREACHABLE',
    message: string,
  ) {
    super(message);
    this.name = 'IdentityTransportError';
  }
}

export class IdentityTransport {
  /** Empty, and never shared with a task. See the call site below. */
  private readonly consent = new ConsentStore();

  constructor(private readonly config: IdentityConfig) {}

  /**
   * Sends one authentication request.
   *
   * The URL is built from the pinned origin and a **path**, so there is no
   * parameter in which a caller could name another host. A path that tries to
   * escape — an absolute URL, a protocol-relative one — lands off-origin and
   * is refused before any request is made.
   */
  async send(request: IdentityRequest): Promise<IdentityResponse> {
    const url = new URL(request.path, this.config.backendOrigin);
    if (url.origin !== this.config.backendOrigin) {
      throw new IdentityTransportError(
        'OFF_ORIGIN',
        'An authentication request may only be sent to the configured backend.',
      );
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (request.bearer !== undefined) headers.authorization = `Bearer ${request.bearer}`;

    let response: Response;
    try {
      response = await guardedSend(
        {
          taskId: IDENTITY_CONTEXT,
          // True rather than assumed: this request was produced by a person
          // pressing a button, and has read no page.
          taintState: freshTaint(),
          taintSalt: IDENTITY_CONTEXT,
          taintSignature: IDENTITY_CONTEXT,
          destination: identityDestination(this.config.backendOrigin, url.toString()),
          url: url.toString(),
          init: {
            method: 'POST',
            headers,
            body: JSON.stringify(request.body),
            redirect: 'manual',
          },
          // The gate records "[authentication]" rather than the body, so a
          // refresh token never reaches an evidence digest.
          payloadPolicy: 'opaque',
          describe: 'the AI Browser Agent account service',
        },
        {
          // A store of its own, never the task consent store.
          //
          // The gate does not reach the consent path for this channel: the
          // taint state is untainted, so the exfiltration verdict allows and
          // the decision is `NO_PRIVATE_DATA` before consent is consulted.
          // Passing an empty store rather than the real one is what makes
          // that structural — an authentication request cannot read, grant or
          // consume a task's consent even if the path above it changed.
          consent: this.consent,
          // No transport implementation is supplied. The egress module
          // performs the transfer, which is the only place permitted to.
        },
      );
    } catch (error) {
      if (error instanceof IdentityTransportError) throw error;
      log.warn('An authentication request could not be completed.', {
        path: request.path,
        error: error instanceof Error ? error.name : 'unknown',
      });
      throw new IdentityTransportError('UNREACHABLE', 'The account service could not be reached.');
    }

    // A redirect is never followed: a redirected authentication request is a
    // bearer token sent to an origin nobody authorised.
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new IdentityTransportError('REFUSED', 'The account service redirected unexpectedly.');
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  }
}
