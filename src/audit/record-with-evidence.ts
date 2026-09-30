/**
 * Recording a decision and the evidence it points at, in the one correct order.
 *
 * Four call sites in the service worker used to store the evidence blob first
 * and then write the audit record naming it. That order has a failure mode: if
 * the record is refused — and the audit log does refuse records, by design —
 * the blob stays in storage with nothing pointing at it. Evidence nothing
 * points at is worse than no evidence: it is a stored payload that no reader of
 * the trail can discover, attribute or explain, and no integrity check over the
 * trail can see that it is there.
 *
 * Nothing is given up by waiting. `buildEgressEvidence` mints the evidence id
 * as part of the reference, so the record can name the blob before the blob
 * exists.
 *
 * It lives in its own module rather than inline in the worker for one reason:
 * four copies of an ordering rule is four chances for one of them to drift back.
 */
import { getLogger } from '@/logging/logger';
import type { AuditLog, RecordableAuditEvent } from './audit-log';
import type { BuiltEgressEvidence } from '@/security/egress/egress-evidence';
import type { EvidenceStore } from '@/evidence/evidence-store';

const log = getLogger('agent');

export interface RecordWithEvidenceDeps {
  readonly audit: AuditLog;
  readonly evidence: EvidenceStore;
}

/**
 * Writes the record, then stores the evidence it names.
 *
 * **This never changes the decision being recorded.** By the time it runs the
 * egress decision has been taken and acted on; a failure here is a gap in the
 * record of something that already happened, which is the contract `AuditLog`
 * states and which must not be converted into a failed action. So it returns
 * rather than throwing, and the gap is already reported durably by the audit
 * log's own health reporting — this adds nothing to that and hides nothing
 * from it.
 *
 * The residual case is deliberate: if the record is written and the evidence
 * write then fails, the trail holds a reference to a blob that is not there.
 * That is the direction to fail in. A dangling reference is visible to anyone
 * reading the trail; an orphaned blob is visible to nobody.
 */
export async function recordWithEvidence(
  deps: RecordWithEvidenceDeps,
  built: BuiltEgressEvidence,
  event: (evidenceId: string) => RecordableAuditEvent,
): Promise<void> {
  const written = await deps.audit.record(event(built.reference.id));
  if (!written) {
    log.warn('A decision could not be recorded, so its evidence was not stored either.', {
      sourceTool: built.reference.sourceTool,
    });
    return;
  }
  await deps.evidence.put(built.reference, {
    content: JSON.stringify(built.detail),
    encoding: 'utf8',
    mimeType: 'application/json',
  });
}
