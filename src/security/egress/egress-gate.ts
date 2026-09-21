/**
 * The centralized egress authorization gate (Stage 3 B2, roadmap section 4K).
 *
 * One entry point answers one question: may *this data* go *there*?
 *
 * It is deliberately not the same question as any of these, and none of them
 * substitutes for it:
 *
 *   tool risk                how damaging is this action?
 *   destination authorization  may we talk to this host at all?
 *   consent                  has the user approved this transfer?
 *   provider authentication  who is the counterparty?
 *
 * Order is fixed and the transfer is always last:
 *
 *   security context -> destination -> carrier -> policy -> consent
 *                    -> evidence -> authorization -> transfer
 *
 * Fails closed. `UNKNOWN` taint, an unresolvable destination, a missing salt
 * or an unavailable policy all deny. Absence of security metadata is never
 * read as evidence that a transfer is safe.
 */

import { getLogger } from '@/logging/logger';
import {
  evaluateExfiltration,
  matchedSecretRule,
  type DataSensitivity,
} from '@/security/exfiltration/exfiltration-guard';
import { highestSensitivity, taintSources, type TaintState } from '@/security/taint/taint-state';
import { assessCarrier, type CarrierClass, type CarrierInput } from './carrier';
import { describeDestination, isExternalChannel, type EgressDestination } from './destination';
import { exceedsCeiling, type ConsentKey, type ConsentStore, type ProviderPin } from './consent';

const log = getLogger('security');

/**
 * Channels whose risk is a function of URL capacity.
 *
 * Everything else — a provider request, a connector call — transfers a
 * payload deliberately, so grading the container tells you nothing.
 */
const CARRIER_GRADED: ReadonlySet<string> = new Set([
  'navigation',
  'page_write',
  'web_ai_provider',
  'clipboard',
  'download',
]);

export type EgressVerdict = 'allow' | 'confirm' | 'deny';

export interface EgressDecision {
  readonly verdict: EgressVerdict;
  readonly code: EgressDecisionCode;
  readonly reason: string;
  readonly carrier: CarrierClass;
  readonly destinationIdentity: string | null;
  readonly sensitivity: DataSensitivity;
  readonly taintSourceIds: readonly string[];
  /** Present when the caller should record or request consent under this key. */
  readonly consentKey?: ConsentKey;
}

export type EgressDecisionCode =
  | 'NOT_AN_EGRESS'
  | 'SECURITY_CONTEXT_UNKNOWN'
  | 'DESTINATION_UNKNOWN'
  | 'SECRET_PAYLOAD'
  | 'POLICY_BLOCKED'
  | 'CONSENT_REQUIRED'
  | 'CONSENT_PRESENT'
  | 'PROVIDER_BOUND'
  | 'CARRIER_CANNOT_CONVEY'
  | 'NO_PRIVATE_DATA';

export interface EgressRequest {
  readonly taskId: string;
  readonly taintState: TaintState;
  /** Hex salt for evidence digests. Empty means the record is damaged. */
  readonly taintSalt: string;
  readonly destination: EgressDestination;
  readonly payload?: unknown;
  readonly carrierInput?: CarrierInput;
  /** Pre-computed signature over the taint set, for the consent key. */
  readonly taintSignature?: string;
  readonly now: number;
}

export interface EgressGateOptions {
  readonly consent: ConsentStore;
}

/**
 * Authorises one transfer.
 *
 * Returns `confirm` rather than prompting: prompting belongs to the permission
 * layer, and keeping the gate free of I/O is what lets it be exercised
 * exhaustively in tests.
 */
export function authorizeEgress(
  request: EgressRequest,
  options: EgressGateOptions,
): EgressDecision {
  const sources = taintSources(request.taintState);
  const taintSourceIds = sources.map((source) => `${source.sourceType}:${source.site ?? '-'}`);
  const sensitivity = highestSensitivity(request.taintState);

  // A declared non-egress still comes through here, so that "this transfers
  // nothing" is an assertion on the record rather than an omission.
  if (!isExternalChannel(request.destination.channel)) {
    return {
      verdict: 'allow',
      code: 'NOT_AN_EGRESS',
      reason: 'This action does not send data outside the extension.',
      carrier: 'none',
      destinationIdentity: request.destination.identity,
      sensitivity,
      taintSourceIds,
    };
  }

  // 1. Security context. Unknown provenance denies before anything else is
  //    considered — including before the destination is looked at, because a
  //    recognisable destination must not make an unknowable payload safe.
  if (request.taintState.kind === 'UNKNOWN') {
    log.warn('Egress denied: task security context could not be established.', {
      taskId: request.taskId,
      reason: request.taintState.reason,
    });
    return {
      verdict: 'deny',
      code: 'SECURITY_CONTEXT_UNKNOWN',
      reason:
        'What this task has already read could not be established, so no outbound ' +
        'transfer can be authorised. Start the task again.',
      carrier: 'high',
      destinationIdentity: request.destination.identity,
      sensitivity: 'secret',
      taintSourceIds,
    };
  }

  if (request.taintSalt.length === 0) {
    return {
      verdict: 'deny',
      code: 'SECURITY_CONTEXT_UNKNOWN',
      reason: 'This task is missing the key used to record outbound transfers.',
      carrier: 'high',
      destinationIdentity: request.destination.identity,
      sensitivity: 'secret',
      taintSourceIds,
    };
  }

  // 2. Destination. An identity that could not be canonicalised is unknown,
  //    and unknown denies rather than falling back to the raw string.
  if (request.destination.identity === null) {
    return {
      verdict: 'deny',
      code: 'DESTINATION_UNKNOWN',
      reason: 'The destination of this transfer could not be identified.',
      carrier: 'high',
      destinationIdentity: null,
      sensitivity,
      taintSourceIds,
    };
  }

  // 3. Credentials never leave, at any taint state, to any destination.
  const secretRule = request.payload === undefined ? null : matchedSecretRule(request.payload);
  if (secretRule !== null) {
    log.warn('Egress denied: credential-shaped payload.', {
      taskId: request.taskId,
      rule: secretRule,
    });
    return {
      verdict: 'deny',
      code: 'SECRET_PAYLOAD',
      reason:
        `This transfer contains credential-shaped data (${secretRule}) and cannot be ` +
        'sent anywhere.',
      carrier: 'high',
      destinationIdentity: request.destination.identity,
      sensitivity: 'secret',
      taintSourceIds,
    };
  }

  // 4. Carrier. Routing metadata: it selects which checks run below, and has
  //    no path of its own to a transfer.
  //
  //    Carrier capacity is a question about URLs — how much data a link or a
  //    form field can convey. It does not apply to a provider request, whose
  //    payload is the point rather than an incidental slot, so those channels
  //    are graded `none` and their decision rests on taint and destination
  //    instead. A URL-bearing channel that arrives without carrier input is
  //    graded `high`: uncertainty costs a confirmation, never skips one.
  const carrier: CarrierClass = CARRIER_GRADED.has(request.destination.channel)
    ? request.carrierInput === undefined
      ? 'high'
      : assessCarrier(request.carrierInput)
    : 'none';

  // 5. Policy over the taint set and the destination.
  const exfiltration = evaluateExfiltration({
    destination: request.destination.origin ?? request.destination.identity,
    payload: request.payload,
    taint: sources,
  });

  if (exfiltration.verdict === 'block') {
    return {
      verdict: 'deny',
      code: 'POLICY_BLOCKED',
      reason: exfiltration.reason,
      carrier,
      destinationIdentity: request.destination.identity,
      sensitivity: 'secret',
      taintSourceIds,
    };
  }

  const consentKey: ConsentKey = {
    taskId: request.taskId,
    destinationIdentity: request.destination.identity,
    taintSignature: request.taintSignature ?? '',
    sensitivityCeiling: sensitivity,
    channel: request.destination.channel,
  };

  // A provider request to the destination this task is already bound to.
  //
  // The user chose the provider, connected it and started the task against
  // it; sending that task's data there is what they asked for. A prompt on
  // every model turn would fire dozens of times per task and would be
  // dismissed rather than read, which makes the control weaker, not stronger.
  // The pin is what keeps this narrow: it is set from user configuration on
  // the first request and never from model output, so a switch to any other
  // destination mid-task falls through to consent below.
  const pin: ProviderPin | undefined =
    request.destination.channel === 'ai_provider' && request.destination.identity !== null
      ? { identity: request.destination.identity, modelId: request.destination.modelId ?? '' }
      : undefined;
  const pinned =
    request.destination.channel === 'ai_provider'
      ? options.consent.pinnedProvider(request.taskId)
      : undefined;
  // A task bound to one provider and now asked to reach another is a switch,
  // and a switch re-evaluates rather than inheriting. Recorded before the
  // allow paths below so no fast path can skip past it.
  const providerSwitched =
    pin !== undefined && pinned !== undefined && !options.consent.matchesPin(request.taskId, pin);

  if (pin !== undefined) {
    if (pinned === undefined) options.consent.pinProvider(request.taskId, pin);
    if (!providerSwitched) {
      return {
        verdict: 'allow',
        code: 'PROVIDER_BOUND',
        reason: `This task's configured provider, ${describeDestination(request.destination)}.`,
        carrier,
        destinationIdentity: request.destination.identity,
        sensitivity,
        taintSourceIds,
        consentKey,
      };
    }
  }

  // Two independent questions, and consent needs a yes to both.
  //
  //   Is there foreign private data?  the exfiltration verdict answers this,
  //                                   and it already discounts same-site and
  //                                   public sources — writing a page's own
  //                                   content back to that same page conveys
  //                                   nothing it does not have.
  //   Can this action carry it?       the carrier class answers this.
  //
  // So a `none` carrier skips the consent check even when foreign data is
  // present, because a URL the page displayed verbatim conveys nothing the
  // task derived. It skips nothing else: context, destination, credentials,
  // policy and evidence have all already run above.
  //
  // A channel that is not carrier-graded has no `none` to earn: its payload is
  // sent deliberately, so it can always convey. Reading `carrier === 'none'`
  // as "cannot convey" there would allow every provider request unconditionally.
  const carrierCanConvey = !CARRIER_GRADED.has(request.destination.channel) || carrier !== 'none';

  if (!providerSwitched && (exfiltration.verdict === 'allow' || !carrierCanConvey)) {
    return {
      verdict: 'allow',
      code: carrierCanConvey ? 'NO_PRIVATE_DATA' : 'CARRIER_CANNOT_CONVEY',
      reason: carrierCanConvey
        ? exfiltration.reason
        : 'This action cannot carry anything the task has read.',
      carrier,
      destinationIdentity: request.destination.identity,
      sensitivity,
      taintSourceIds,
      consentKey,
    };
  }

  // 6. Consent.
  if (request.taintSignature === undefined) {
    return {
      verdict: 'deny',
      code: 'SECURITY_CONTEXT_UNKNOWN',
      reason: 'The taint signature for this transfer could not be computed.',
      carrier,
      destinationIdentity: request.destination.identity,
      sensitivity,
      taintSourceIds,
    };
  }

  const existing = options.consent.find({
    key: consentKey,
    now: request.now,
    ...(request.destination.providerId === undefined
      ? {}
      : { providerId: request.destination.providerId }),
    ...(request.destination.modelId === undefined ? {} : { modelId: request.destination.modelId }),
  });

  if (existing && !exceedsCeiling(existing.sensitivityCeiling, sensitivity)) {
    return {
      verdict: 'allow',
      code: 'CONSENT_PRESENT',
      reason: `Already approved for ${describeDestination(request.destination)} in this task.`,
      carrier,
      destinationIdentity: request.destination.identity,
      sensitivity,
      taintSourceIds,
      consentKey,
    };
  }

  return {
    verdict: 'confirm',
    code: 'CONSENT_REQUIRED',
    reason:
      exfiltration.verdict === 'confirm'
        ? exfiltration.reason
        : `This will send data to ${describeDestination(request.destination)}. Approval is required.`,
    carrier,
    destinationIdentity: request.destination.identity,
    sensitivity,
    taintSourceIds,
    consentKey,
  };
}
