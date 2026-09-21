/**
 * Evidence for egress decisions (Stage 3 B2, roadmap section 4K).
 *
 * Every gate decision is recorded so the record answers: what left, where it
 * came from, where it went, why it was allowed, who authorised it, which
 * policy evaluated it, and when.
 *
 * What is recorded is metadata, a size and a keyed digest — never the payload.
 * Summaries are assembled from a fixed vocabulary rather than written from the
 * content, because a free-text summary of a payload reintroduces exactly the
 * content the digest replaced.
 */

import { hmacContent, type EvidenceReference } from '@/evidence/evidence-model';
import { redactValue } from '@/security/redaction/secret-redactor';
import type { EgressDecision } from './egress-gate';
import type { EgressDestination } from './destination';

export interface EgressEvidenceInput {
  readonly taskId: string;
  readonly toolCallId?: string;
  readonly sourceTool: string;
  readonly destination: EgressDestination;
  readonly decision: EgressDecision;
  readonly payload?: unknown;
  readonly taintSalt: string;
  readonly saltEpoch: number;
  readonly now: number;
}

/** The parts of a gate decision worth keeping, with no payload among them. */
export interface EgressEvidenceDetail {
  readonly channel: string;
  readonly destinationIdentity: string | null;
  readonly destinationOrigin?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly tabId?: number;
  readonly frameId?: number;
  readonly verdict: string;
  readonly policyCode: string;
  readonly carrier: string;
  readonly taintSourceIds: readonly string[];
  readonly sensitivity: string;
  readonly payloadBytes: number;
  /** `HMAC(taskSalt, payload)`. Absent when there was no payload. */
  readonly payloadDigest?: string;
  readonly saltEpoch: number;
  readonly summary: string;
}

/**
 * Describes a payload without quoting it.
 *
 * Shape and size only. Every branch produces text drawn from this function's
 * own vocabulary; no value from the payload reaches the output.
 */
function describeShape(payload: unknown): string {
  if (payload === undefined || payload === null) return 'no payload';
  if (typeof payload === 'string') return `text, ${payload.length} characters`;
  if (typeof payload === 'number' || typeof payload === 'boolean') return 'a scalar value';
  if (Array.isArray(payload)) return `a list of ${payload.length} items`;
  if (typeof payload === 'object') {
    return `a record with ${Object.keys(payload).length} fields`;
  }
  return 'an opaque value';
}

function payloadBytes(payload: unknown): number {
  if (payload === undefined) return 0;
  try {
    return new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload))
      .length;
  } catch {
    return 0;
  }
}

function canonicalPayload(payload: unknown): string {
  return typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
}

/**
 * Whether a stored digest can still be checked against the task's key.
 *
 * A rotation replaces the key, so digests written under an earlier epoch
 * cannot be recomputed and are not verifiable any more. They are kept — a
 * record of a decision is still a record — but they must never be presented
 * as verified under the new key, which is what a silent epoch-blind check
 * would do.
 */
export function isVerifiableUnderCurrentSalt(
  detail: Pick<EgressEvidenceDetail, 'saltEpoch' | 'payloadDigest'>,
  currentEpoch: number,
): boolean {
  if (detail.payloadDigest === undefined) return false;
  return detail.saltEpoch === currentEpoch;
}

export interface BuiltEgressEvidence {
  readonly reference: Omit<EvidenceReference, 'byteLength' | 'hash'>;
  readonly detail: EgressEvidenceDetail;
}

/**
 * Builds the record.
 *
 * Throws when the salt is missing rather than digesting without one. A caller
 * that cannot produce evidence must not proceed with the transfer — evidence
 * is a precondition of authorisation, not a report written afterwards.
 */
export async function buildEgressEvidence(
  input: EgressEvidenceInput,
): Promise<BuiltEgressEvidence> {
  const { decision, destination } = input;

  const digest =
    input.payload === undefined
      ? undefined
      : await hmacContent(input.taintSalt, canonicalPayload(input.payload));

  const detail: EgressEvidenceDetail = {
    channel: destination.channel,
    destinationIdentity: decision.destinationIdentity,
    ...(destination.origin === undefined ? {} : { destinationOrigin: destination.origin }),
    ...(destination.providerId === undefined ? {} : { providerId: destination.providerId }),
    ...(destination.modelId === undefined ? {} : { modelId: destination.modelId }),
    ...(destination.tabId === undefined ? {} : { tabId: destination.tabId }),
    ...(destination.frameId === undefined ? {} : { frameId: destination.frameId }),
    verdict: decision.verdict,
    policyCode: decision.code,
    carrier: decision.carrier,
    taintSourceIds: decision.taintSourceIds,
    sensitivity: decision.sensitivity,
    payloadBytes: payloadBytes(input.payload),
    ...(digest === undefined ? {} : { payloadDigest: digest }),
    saltEpoch: input.saltEpoch,
    summary: describeShape(input.payload),
  };

  return {
    reference: {
      id: `egress_${input.taskId}_${input.now}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'EGRESS_DECISION',
      taskId: input.taskId,
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      sourceTool: input.sourceTool,
      createdAt: input.now,
      sensitivity: decision.sensitivity,
      // The decision record is produced by the extension, not read from a
      // page, so it is system-controlled — unlike everything it describes.
      trust: 'system_policy',
      ...(destination.origin === undefined ? {} : { origin: destination.origin }),
      label: `${decision.verdict.toUpperCase()} ${destination.channel} -> ${
        decision.destinationIdentity ?? 'unknown'
      }`,
    },
    // Redaction is belt and braces: nothing here is drawn from the payload,
    // but a destination or tool name could still carry something secret-shaped.
    detail: redactValue(detail) as EgressEvidenceDetail,
  };
}
