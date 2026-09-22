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
import { providerDestination, type EgressDestination } from './destination';
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
  /**
   * The connected account this request belongs to.
   *
   * Without it the pin is keyed on `providerId@origin`, which is a property
   * of the endpoint: two accounts at `api.openai.com` are indistinguishable,
   * and consent granted for one authorises the other.
   */
  readonly connectionId?: string;
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
  /**
   * Marks this as a refusal by the transport rather than a network failure.
   *
   * A plain field rather than `instanceof`, because adapters may be bundled
   * separately and a duplicated class identity would make the check fail for
   * a refusal that is perfectly real — at which point the adapter would
   * report a policy decision as a retryable network error and the runtime
   * would try again against a gate that will never say yes.
   */
  readonly transportRefusal = true;

  constructor(
    readonly decision: EgressDecision,
    message: string,
  ) {
    super(message);
    this.name = 'EgressDeniedError';
  }
}

/**
 * Thrown when an adapter has no authorised way to reach the network at all.
 *
 * Distinct from a denial: nothing was decided, because there was nothing to
 * decide with. It carries the same marker so it is classified as blocked
 * rather than retried.
 */
export class TransportUnavailableError extends Error {
  readonly transportRefusal = true;

  constructor(message: string) {
    super(message);
    this.name = 'TransportUnavailableError';
  }
}

/** Structural check for either refusal, safe across bundle boundaries. */
export function isTransportRefusal(error: unknown): error is Error {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { transportRefusal?: unknown }).transportRefusal === true
  );
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
 * One outbound transfer, described independently of who is making it.
 *
 * AI providers and connectors are different domains and must not share an
 * identity type — but they must share the *authorization*, or there would be
 * two answers to "may this data go there". This is the shape both reduce to
 * before the gate sees them.
 */
export interface GuardedSend {
  readonly url: string;
  readonly init: RequestInit;
  readonly destination: EgressDestination;
  readonly taskId: string;
  readonly taintState: TaintState;
  readonly taintSalt: string;
  readonly taintSignature: string;
  /** Short label for the refusal log. Never a payload. */
  readonly describe: string;
  /**
   * How the body is treated by the gate.
   *
   * `digest` — the default — puts the body through the credential scan and
   * the evidence digest, which is right for a data transfer.
   *
   * `opaque` replaces it with a fixed descriptor. Used for **authentication**
   * requests, where the body is a credential by construction: an OAuth token
   * exchange carries a code and a PKCE verifier, and the credential scan
   * would refuse it for containing exactly what it is supposed to contain.
   * Nothing else is relaxed — the destination is still resolved and checked,
   * policy still runs, and the decision is still recorded. What changes is
   * that a secret the user is deliberately sending to its own issuer does not
   * get digested into evidence.
   */
  readonly payloadPolicy?: 'digest' | 'opaque';
}

export interface GuardedSendOptions {
  readonly consent: ConsentStore;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly onDecision?: (decision: EgressDecision, payload: unknown) => Promise<void>;
}

/**
 * Authorises one transfer and performs it.
 *
 * The single place any outbound request is decided. Both the AI provider
 * transport and the connector transport call this; neither reimplements the
 * gate, so there is one authorization model rather than one per domain.
 *
 * `confirm` is treated as a denial. These requests are issued deep inside a
 * model turn with no user interaction available, so the conservative reading
 * is the only correct one — consent is established before the task gets here.
 */
export async function guardedSend(
  send: GuardedSend,
  options: GuardedSendOptions,
): Promise<Response> {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => Date.now());

  // Bodies here are already-serialised strings; anything else is described
  // rather than coerced, so a stray object cannot become the literal
  // "[object Object]" in an evidence digest.
  const payload =
    send.payloadPolicy === 'opaque'
      ? '[authentication]'
      : send.init.body === undefined || send.init.body === null
        ? undefined
        : typeof send.init.body === 'string'
          ? send.init.body
          : '[non-string body]';

  const decision = authorizeEgress(
    {
      taskId: send.taskId,
      taintState: send.taintState,
      taintSalt: send.taintSalt,
      destination: send.destination,
      payload,
      taintSignature: send.taintSignature,
      now: now(),
    },
    { consent: options.consent },
  );

  if (options.onDecision) await options.onDecision(decision, payload);

  if (decision.verdict !== 'allow') {
    log.warn('Outbound request refused by the egress gate.', {
      taskId: send.taskId,
      counterparty: send.describe,
      code: decision.code,
      verdict: decision.verdict,
    });
    throw new EgressDeniedError(decision, decision.reason);
  }

  return doFetch(send.url, markGuarded(send.init));
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
  return {
    request(url: string, init: RequestInit, context: EgressContext): Promise<Response> {
      return guardedSend(
        {
          url,
          init,
          destination: providerDestination(
            context.providerId,
            url,
            context.modelId,
            context.connectionId,
          ),
          taskId: context.taskId,
          taintState: context.taintState,
          taintSalt: context.taintSalt,
          taintSignature: context.taintSignature,
          describe: context.providerId,
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
    },
  };
}

/**
 * Pseudo-task id for a provider probe.
 *
 * Scoped to the provider and model rather than shared. The gate pins a task
 * to one provider destination, and a single shared id made that pin span
 * every provider at once: whichever one probed first became the only one that
 * could ever probe, so connecting a second provider failed its capability
 * check with a policy refusal.
 *
 * Nothing is given up by separating them. The pin protects a task's data from
 * reaching a second destination, and a probe has no task behind it and a
 * fixed body with nothing in it — there is no provenance for the pin to
 * protect here. Every other check still runs on every probe.
 */
export function managementTaskId(providerId: string, modelId: string): string {
  return `provider-management:${providerId}:${modelId}`;
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
    taskId: managementTaskId(providerId, modelId),
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
        new TransportUnavailableError(
          'This provider was constructed without a guarded transport, so it has no ' +
            'authorised way to reach the network. Create it through the provider registry.',
        ),
      );
    },
  };
}
