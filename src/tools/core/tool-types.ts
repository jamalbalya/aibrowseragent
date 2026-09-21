/**
 * Tool contract (specification sections 13, 22, 23).
 *
 * Tools are the only thing a model can ask for. Every tool declares its
 * schema, risk floor and side effects up front so the policy engine can
 * reason about a call before it runs.
 */
import type { z } from 'zod';
import type { RiskLevel, ProhibitedCategory } from '@/policy/risk-classifier';
import type { AgentError } from '@/types/result';
import type { EvidencePayload, EvidenceReference } from '@/evidence/evidence-model';
import type { TaintSource } from '@/security/exfiltration/exfiltration-guard';
import type { CarrierInput } from '@/security/egress/carrier';
import type { EgressDestination } from '@/security/egress/destination';

export type ExecutionMode =
  'immediate' | 'requires_page' | 'requires_debugger' | 'requires_connector';

/** Information a tool needs from the runtime while it executes. */
export interface ToolExecutionContext {
  readonly taskId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  /** Tab the task is currently focused on, when one applies. */
  readonly tabId?: number;
  /** URL observed when the call was authorised, for origin-drift checks. */
  readonly authorisedUrl?: string;
  /**
   * URL of the tab this call acts on, resolved before classification.
   *
   * Needed because a page write's destination is the page itself, and that
   * has to be known before the tool runs rather than discovered inside it.
   */
  readonly currentUrl?: string;
  readonly signal: AbortSignal;
  /**
   * Records evidence produced during execution.
   *
   * Both the reference and its payload are required: a reference with no
   * stored payload would appear in the UI as an evidence item that cannot be
   * opened. `byteLength` and `hash` are computed by the store, so the caller
   * does not supply them.
   */
  readonly recordEvidence: (
    reference: RecordedEvidence,
    payload: Omit<EvidencePayload, 'id'>,
  ) => void;
}

/** An evidence reference before the store computes its size and hash. */
export type RecordedEvidence = Omit<EvidenceReference, 'byteLength' | 'hash'>;

export interface ToolExecutionResult<T = unknown> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: AgentError;
  readonly evidence?: readonly EvidenceReference[];
  readonly metadata?: Record<string, unknown>;
  /** Sources this call read private data from, fed to the exfiltration guard. */
  readonly taint?: readonly TaintSource[];
}

/** An outbound transfer a call will perform. */
export interface EgressCall {
  readonly destination: EgressDestination;
  readonly carrier?: CarrierInput;
  /** What is about to be sent. Digested for evidence, never stored raw. */
  readonly payload?: unknown;
}

/**
 * Facts the runtime derives from a *validated* argument set so the policy
 * engine can evaluate the specific call rather than the tool in general.
 */
export interface CallClassification {
  /** Risk for this call. Never below the tool's declared floor. */
  readonly risk?: RiskLevel;
  readonly prohibited?: readonly ProhibitedCategory[];
  /** URL the call will act on. */
  readonly targetUrl?: string;
  /** Destination when the call sends data outward. */
  readonly writeDestination?: string;
  readonly writePayload?: unknown;
  /**
   * Declared outbound transfer for this call.
   *
   * Every tool that can cause an externally observable transfer declares one,
   * and the registry puts it through the egress gate before the tool runs.
   * A tool that declares nothing is treated as transferring nothing — which
   * is why the declaration is checked against the actual destination at the
   * primitive rather than trusted on its own.
   */
  readonly egress?: EgressCall;
  /** One-line description shown in the permission prompt. */
  readonly summary?: string;
}

/**
 * A tool.
 *
 * `TInput` is inferred from the Zod schema, so a tool implementation receives
 * parsed, validated arguments and never raw model output.
 */
export interface AgentTool<TSchema extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: TSchema;
  /** Minimum risk. Argument-aware escalation may raise it via `classify`. */
  readonly risk: RiskLevel;
  readonly executionMode: ExecutionMode;
  /** Side effects, used for the audit trail and the approval prompt. */
  readonly sideEffects: readonly string[];
  readonly timeoutMs: number;
  /** Safe to retry with identical arguments without duplicating an effect. */
  readonly idempotent: boolean;

  /** Derives call-specific policy facts from validated input. */
  classify?(input: z.infer<TSchema>, context: ToolExecutionContext): CallClassification;

  execute(input: z.infer<TSchema>, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

/** The envelope returned to the model (specification section 23). */
export interface ToolResultEnvelope {
  readonly toolCallId: string;
  readonly status: 'success' | 'error';
  readonly result?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
  readonly retryable?: boolean;
  readonly evidence?: readonly string[];
}

export function successEnvelope(
  toolCallId: string,
  result: unknown,
  evidence: readonly string[] = [],
): ToolResultEnvelope {
  return {
    toolCallId,
    status: 'success',
    result,
    ...(evidence.length > 0 ? { evidence } : {}),
  };
}

/**
 * Builds a failure envelope.
 *
 * Only `code` and `userMessage` cross into model context — `technicalDetails`
 * is deliberately dropped, because raw exception text is a leak channel.
 */
export function errorEnvelope(toolCallId: string, error: AgentError): ToolResultEnvelope {
  return {
    toolCallId,
    status: 'error',
    error: { code: error.code, message: error.userMessage },
    retryable: error.retryable,
  };
}
