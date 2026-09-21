/**
 * Guarded transport for provider network traffic (Stage 3 B2, step 6).
 *
 * Before this, the provider request was the one path that reached the network
 * without the policy engine ever seeing it: the runtime called
 * `provider.generate()` and the adapter called its injected `fetch` directly.
 * Page text, page HTML, console output and screenshots left the device on
 * every task through a path no tool policy applied to. Tool calls were guarded
 * while the larger channel beside them was not.
 *
 * Every adapter now reaches the network through this transport, and the
 * transport calls the gate first.
 *
 * Two properties make that hard to undo by accident:
 *
 *  - the transport is injected by the registry at `create()`, so an adapter
 *    has no other way out and cannot opt out of being handed one;
 *  - a call with no egress context is refused. An adapter that forgets to
 *    forward one fails closed rather than quietly reverting to a direct call.
 *
 * Retries are covered because each retry re-enters `generate` or `stream`,
 * and so re-enters the gate. No authorisation is carried forward from a
 * previous attempt.
 */

import { getLogger } from '@/logging/logger';
import { markGuarded } from './network-interceptor';
import type { TaintState } from '@/security/taint/taint-state';
import { authorizeEgress, type EgressDecision } from './egress-gate';
import { providerDestination } from './destination';
import type { ConsentStore } from './consent';

const log = getLogger('security');

/** Security context for one provider call, carried with the request. */
export interface EgressContext {
  readonly taskId: string;
  readonly taintState: TaintState;
  readonly taintSalt: string;
  readonly saltEpoch: number;
  readonly taintSignature: string;
  readonly providerId: string;
  readonly modelId: string;
  /**
   * Set for connection and capability probes, which carry no task data.
   *
   * These are not exempt from the gate — destination resolution, the
   * credential check and policy all still run. The flag records that the
   * clean taint state comes from there being no task behind the call, rather
   * than from a task that was examined and found clean.
   */
  readonly management?: true;
}

/**
 * What an adapter is given instead of `fetch`.
 *
 * The context is a required third argument rather than an optional one so a
 * call site that omits it is a type error, not a silent bypass.
 */
export interface ProviderTransport {
  request(url: string, init: RequestInit, context: EgressContext): Promise<Response>;
}

export class EgressDeniedError extends Error {
  constructor(
    readonly decision: EgressDecision,
    message: string,
  ) {
    super(message);
    this.name = 'EgressDeniedError';
  }
}

export interface GuardedTransportOptions {
  readonly consent: ConsentStore;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** Records the decision. A failure here fails the transfer, not the record. */
  readonly onDecision?: (
    decision: EgressDecision,
    context: EgressContext,
    url: string,
    payload: unknown,
  ) => Promise<void>;
}

/**
 * Builds the transport every provider adapter is given.
 *
 * `confirm` is treated as a denial here rather than as a prompt. The provider
 * request is issued deep inside a model turn with no user interaction
 * available; asking at that point is not possible, so the conservative
 * reading is the only correct one. Consent for a provider is established
 * before the task reaches this path.
 */
export function createGuardedTransport(options: GuardedTransportOptions): ProviderTransport {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => Date.now());

  return {
    async request(url: string, init: RequestInit, context: EgressContext): Promise<Response> {
      const destination = providerDestination(context.providerId, url, context.modelId);

      // Bodies here are already-serialised JSON strings; anything else is
      // described rather than coerced, so a stray object cannot become the
      // literal "[object Object]" in an evidence digest.
      const payload =
        init.body === undefined || init.body === null
          ? undefined
          : typeof init.body === 'string'
            ? init.body
            : '[non-string body]';

      const decision = authorizeEgress(
        {
          taskId: context.taskId,
          taintState: context.taintState,
          taintSalt: context.taintSalt,
          destination,
          payload,
          taintSignature: context.taintSignature,
          now: now(),
        },
        { consent: options.consent },
      );

      if (options.onDecision) await options.onDecision(decision, context, url, payload);

      if (decision.verdict !== 'allow') {
        log.warn('Provider request refused by the egress gate.', {
          taskId: context.taskId,
          providerId: context.providerId,
          code: decision.code,
          verdict: decision.verdict,
        });
        throw new EgressDeniedError(decision, decision.reason);
      }

      return doFetch(url, markGuarded(init));
    },
  };
}

/**
 * Context for a provider probe.
 *
 * Probes send a fixed body — a GET, or the literal `ping` — so no task data
 * can reach them. The salt is transport-scoped because there is no task to
 * own one, and it still keeps probe digests unlinkable from task digests.
 */
export function managementContext(
  providerId: string,
  modelId: string,
  salt: string,
): EgressContext {
  return {
    taskId: 'provider-management',
    taintState: { kind: 'KNOWN_UNTAINTED' },
    taintSalt: salt,
    saltEpoch: 1,
    taintSignature: 'management',
    providerId,
    modelId,
    management: true,
  };
}

/**
 * A transport that refuses everything.
 *
 * The default an adapter gets when nobody supplied one. Failing loudly here is
 * the point: a provider built outside the registry must not silently acquire
 * unguarded network access.
 */
export function refusingTransport(): ProviderTransport {
  return {
    request(): Promise<Response> {
      return Promise.reject(
        new Error(
          'This provider was constructed without a guarded transport, so it has no ' +
            'authorised way to reach the network. Create it through the provider registry.',
        ),
      );
    },
  };
}
