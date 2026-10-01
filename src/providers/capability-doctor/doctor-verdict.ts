/**
 * What a capability-doctor run stores on the record it measured.
 *
 * ## Why this is its own module
 *
 * It was inline in `service-worker.ts`, twice — once in each `runDoctor`
 * route — and the two copies disagreed about whether the reason was kept. A
 * shared function fixed that, but a function private to the worker can only be
 * checked by reading the worker's source text, and a mutation that mapped every
 * readiness to `connected` survived the whole suite because no test could call
 * it. So it lives here, where the mapping itself is the thing under test.
 *
 * ## What the verdict is, and what it is not
 *
 * It is part of the **measurement**. `CapabilityDoctor` measures one exact
 * (connection, model) pair, so its conclusion describes that pair and not the
 * account — which is why `accountAfterSelection` discards it along with
 * `capabilities`, `capabilityScope` and `lastValidated` when the pair changes.
 * Leaving it behind meant a model the upstream account cannot use left the whole
 * connection reading `failed`, with that model's reason attached, after the user
 * had switched to a model that works.
 *
 * The reason is kept because the two failures a gateway produces are different
 * facts that send the user to different actions. Measured against a real
 * 9Router fronting a ChatGPT account: a model the account is not entitled to
 * reaches the user as *"The provider rejected the request"*, and a model whose
 * upstream is briefly down as *"The provider reported a server error. This is
 * usually temporary."* Storing only `failed` collapsed them into one.
 *
 * `disconnected` is deliberately **not** reachable from here. That status is
 * about the credential rather than the model — `noteProviderDisconnected` owns
 * it — and no capability measurement can establish it.
 */

/** The statuses a doctor run can conclude. A credential verdict is not one. */
export type DoctorStatus = 'connected' | 'limited' | 'failed';

export interface DoctorVerdict {
  readonly status: DoctorStatus;
  /** Absent on a healthy run, so a stale reason cannot outlive its failure. */
  readonly statusReason?: string;
}

/**
 * The readiness and summary a report carries, which is all this needs.
 *
 * Structural rather than importing `CapabilityReport`, so the mapping can be
 * exercised with the four readiness values directly without assembling a whole
 * report around each one.
 */
export interface DoctorOutcome {
  readonly readiness: string;
  readonly summary: string;
}

/**
 * Maps one run's outcome onto what the record should hold.
 *
 * Only `AGENT_READY` is `connected`: everything the doctor can conclude short
 * of that is a limitation the user should be told about, and `FAILED` is the
 * one that means the model did not work at all. An unrecognised readiness is
 * treated as a limitation rather than as success, because the alternative —
 * defaulting to `connected` — would turn a readiness this build does not
 * understand into a claim that the model is fine.
 */
export function doctorVerdict(report: DoctorOutcome): DoctorVerdict {
  if (report.readiness === 'AGENT_READY') return { status: 'connected' };
  const status: DoctorStatus = report.readiness === 'FAILED' ? 'failed' : 'limited';
  const reason = report.summary.trim();
  return reason.length === 0 ? { status } : { status, statusReason: report.summary };
}
