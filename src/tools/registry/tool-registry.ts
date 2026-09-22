/**
 * Tool registry and execution envelope (specification sections 13, 17, 24, 46).
 *
 * This module is the single choke point between model output and any real
 * effect. The order below is fixed and every stage can only make the outcome
 * stricter:
 *
 *   lookup → schema validation → classification → policy → permission
 *          → execution (timeout + cancellation) → sanitisation → evidence
 *
 * A tool cannot be invoked any other way: the runtime holds no direct
 * references to tool implementations.
 */
import { z } from 'zod';
import { getLogger } from '@/logging/logger';
import { createError, ToolError, type AgentError } from '@/types/result';
import { withTimeout } from '@/utils/time';
import { redactValue } from '@/security/redaction/secret-redactor';
import { maxRisk, type RiskLevel } from '@/policy/risk-classifier';
import { evaluatePolicy, type PolicyContext, type PolicyDecision } from '@/policy/policy-engine';
import type { PermissionEngine } from '@/policy/permission-engine';
import type { EvidenceReference, EvidencePayload } from '@/evidence/evidence-model';
import type { EvidenceStore } from '@/evidence/evidence-store';
import { unknownTaint, type TaintState } from '@/security/taint/taint-state';
import { authorizeEgress, type EgressDecision } from '@/security/egress/egress-gate';
import type { ConsentStore } from '@/security/egress/consent';
import type { EgressEvidenceInput } from '@/security/egress/egress-evidence';
import type { TaintSource } from '@/security/exfiltration/exfiltration-guard';
import type { CanonicalToolSchema } from '@/providers/core/types';
import type {
  AgentTool,
  RecordedEvidence,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolResultEnvelope,
} from '@/tools/core/tool-types';
import { errorEnvelope, successEnvelope } from '@/tools/core/tool-types';
import type { ActedOnElement } from '@/content/semantic-tree';

const log = getLogger('tool');

export interface ToolInvocation {
  readonly toolCallId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly tabId?: number;
  /** URL observed when the model proposed this call. */
  readonly plannedUrl?: string;
  /**
   * Task-level taint, carried as a state rather than a bare list so an
   * unestablished provenance stays distinguishable from an empty one.
   */
  readonly taintState?: TaintState;
  /** Per-task evidence key. Absent denies any declared egress. */
  readonly taintSalt?: string;
  readonly saltEpoch?: number;
  /** Signature over the taint set, for the consent key. */
  readonly taintSignature?: string;
  readonly signal: AbortSignal;
}

export interface ToolDispatchResult {
  readonly envelope: ToolResultEnvelope;
  readonly evidence: readonly EvidenceReference[];
  /** Risk actually applied, after argument-aware escalation. */
  readonly risk: RiskLevel;
  readonly policy?: PolicyDecision;
  readonly taint: readonly TaintSource[];
  /** True when the call reached the tool implementation. */
  readonly executed: boolean;
}

export interface ToolRegistryOptions {
  readonly permissionEngine: PermissionEngine;
  readonly loadPolicyContext: () => Promise<PolicyContext>;
  /**
   * Where evidence payloads are persisted.
   *
   * Optional so tool behaviour can be tested without a store; when it is
   * absent the references are still returned, but nothing is written and a
   * warning is logged rather than the omission passing silently.
   */
  readonly evidenceStore?: EvidenceStore;
  /**
   * Egress authorization.
   *
   * Optional so tool behaviour can be tested in isolation. A tool that
   * declares an egress while this is absent is not silently allowed: the
   * declaration is what makes the transfer visible, and a registry built
   * without this simply cannot run such a tool in production — the service
   * worker always supplies it.
   */
  /** Resolves a tab's current URL, so a page-write destination is knowable. */
  readonly resolveTabUrl?: (tabId: number) => Promise<string | undefined>;
  /**
   * Is this tab live context for this task's workspace?
   *
   * A **narrowing filter** and nothing more. It runs before policy,
   * permission, consent, egress and taint, and can only subtract: a tab it
   * admits still faces every one of them, unchanged. Membership decides
   * eligibility; it never decides authorization.
   *
   * Optional so tool behaviour can be tested in isolation. Absent, no
   * narrowing happens and every existing control still applies — the service
   * worker always supplies it.
   */
  readonly checkWorkspaceMember?: (
    taskId: string,
    tabId: number,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * The tabs this task's workspace holds right now, read live from Chrome.
   *
   * Narrowing again, in the other direction: it bounds what a tool can
   * *enumerate*, not only what it can act on. Listing every tab in the
   * browser told the model what the user had open even when acting on those
   * tabs would have been refused.
   */
  readonly resolveWorkspaceTabs?: (taskId: string) => Promise<readonly number[]>;
  /** The Chrome group backing this task's workspace, for tab creation. */
  readonly resolveWorkspaceGroupId?: (taskId: string) => Promise<number | undefined>;
  readonly egress?: {
    readonly consent: ConsentStore;
    readonly record: (input: EgressEvidenceInput) => Promise<void>;
  };
  /**
   * Publishes the task's security context before a tool runs.
   *
   * A tool that reaches an external service — a connector — has to send under
   * the task's own taint, and `ToolExecutionContext` deliberately carries the
   * task id without the taint. Rather than widening that type for everything,
   * the registry hands the context to one subscriber, so a connector inherits
   * what the task accumulated instead of inventing a clean context.
   */
  /**
   * Notified after a dispatch has fully resolved.
   *
   * Strictly observational, and the type is what makes that true rather than
   * a rule someone has to remember. The observer receives a
   * `DispatchObservation` — a derived, deep-cloned, recursively frozen record
   * — and never the live `ToolInvocation` or `ToolDispatchResult`. It gets no
   * policy object, no permission decision, no evidence payload and no
   * `AbortSignal`, so there is nothing in its hands that authorisation could
   * be expressed through.
   *
   * It is called after the result exists, on a path the `return` does not
   * depend on, and anything it throws is caught. An observer therefore cannot
   * modify, block, retry or re-authorise a call that has already been
   * decided. See `observe` below.
   */
  readonly onDispatched?:
    | ((observation: DispatchObservation) => void)
    | readonly ((observation: DispatchObservation) => void)[];
  readonly publishSecurityContext?: (
    taskId: string,
    context: {
      taintState: TaintState;
      taintSalt: string;
      saltEpoch: number;
      taintSignature: string;
    },
  ) => void;
}

/**
 * What an observer is allowed to know about a completed dispatch.
 *
 * Deliberately the minimum P-022 recording needs. Every field is a value or a
 * frozen clone; nothing here references live state, and nothing here is an
 * object a control reads. Adding a field is a security decision, not a
 * convenience.
 */
/**
 * What `run` returns internally, before `dispatch` strips it.
 *
 * `actedOn` never leaves this class on the result path: `dispatch`
 * destructures it away, so no caller — the agent runtime, the skill runner,
 * a tool — can see it, and it cannot reach a result envelope or model
 * context. Its only exit is the observation hook.
 */
type InternalDispatchResult = ToolDispatchResult & { readonly actedOn?: ActedOnElement };

export interface DispatchObservation {
  readonly taskId: string;
  readonly toolCallId: string;
  /** Canonical tool name, after wire-name translation. */
  readonly tool: string;
  /** The schema-validated arguments, deep-cloned and frozen. */
  readonly arguments: Readonly<Record<string, unknown>>;
  /** Risk actually applied, after argument-aware escalation. */
  readonly risk: RiskLevel;
  /** Whether the call reached the tool implementation. */
  readonly executed: boolean;
  readonly status: 'success' | 'error';
  /**
   * The element this call acted on, described declaratively.
   *
   * Present only when a tool reported one, and page-derived when it is. It
   * exists so a recording can name an element the way §49 asks — a role and
   * an accessible name — rather than a handle that is meaningless after the
   * page read that minted it. It carries no handle, no selector and no
   * markup, and like every other field here it arrives frozen.
   */
  readonly actedOn?: ActedOnElement;
  /** The canonical failure code, when there was one. Never a message. */
  readonly errorCode?: string;
  /** Tab the call acted on, when one applied. */
  readonly tabId?: number;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  constructor(private readonly options: ToolRegistryOptions) {}

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: readonly AgentTool[]): void {
    for (const tool of tools) this.register(tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  /**
   * Provider-neutral tool declarations (specification section 71).
   *
   * `allowed` restricts the exposed set — a skill or shortcut can narrow the
   * surface without the tools themselves knowing about it.
   */
  toCanonicalSchemas(allowed?: readonly string[]): CanonicalToolSchema[] {
    return this.list()
      .filter((tool) => !allowed || allowed.includes(tool.name))
      .map((tool) => ({
        type: 'function' as const,
        // Provider function names must be identifier-safe; canonical names use
        // dots (`browser.click`) so they are translated here and back on the
        // way in.
        name: toWireName(tool.name),
        description: tool.description,
        parameters: z.toJSONSchema(tool.inputSchema, { io: 'input' }),
      }));
  }

  /**
   * Validates, authorises and executes one tool call.
   *
   * Never throws: every failure path returns an envelope, because an
   * unhandled exception here would become untrusted text in model context.
   *
   * The observation hook fires here rather than inside `run`, and that
   * placement is the enforcement: the result already exists and is already
   * the value this method returns, so nothing an observer does can reach it.
   * Sprinkling the call through `run`'s several return points would have made
   * the ordering a convention instead of a structure.
   */
  async dispatch(invocation: ToolInvocation): Promise<ToolDispatchResult> {
    // Destructured away rather than passed through: `actedOn` is page-derived
    // text for the observation hook alone, and a caller that received it
    // could put it somewhere page text does not belong.
    const { actedOn, ...result } = await this.run(invocation);
    this.observe(invocation, result, actedOn);
    return result;
  }

  /**
   * Hands an observer a frozen copy of what happened.
   *
   * Three things make this observation-only rather than merely
   * documented-as-observation-only:
   *
   *  - the observer is given a `DispatchObservation`, which has no reference
   *    to the invocation or the result;
   *  - every value in it is structure-cloned and then recursively frozen, so
   *    a mutation attempt throws in strict mode and changes nothing either
   *    way;
   *  - it is called after the result is final, and anything it throws is
   *    caught here. An observer cannot block a call that was already
   *    authorised and already ran.
   *
   * A clone that fails is not worked around: the observation is dropped
   * rather than substituted with a live reference.
   */
  private observe(
    invocation: ToolInvocation,
    result: ToolDispatchResult,
    actedOn: ActedOnElement | undefined,
  ): void {
    const configured = this.options.onDispatched;
    if (!configured) return;
    // Typed explicitly: `Array.isArray` widens a readonly union to `any[]`,
    // and an `any` here would quietly disable the checks on the call below.
    const observers: readonly ((observation: DispatchObservation) => void)[] =
      typeof configured === 'function' ? [configured] : configured;
    if (observers.length === 0) return;

    let observation: DispatchObservation;
    try {
      observation = deepFreeze({
        taskId: invocation.taskId,
        toolCallId: invocation.toolCallId,
        tool: fromWireName(invocation.name),
        arguments: structuredClone(invocation.arguments),
        risk: result.risk,
        executed: result.executed,
        status: result.envelope.status,
        ...(result.envelope.error === undefined ? {} : { errorCode: result.envelope.error.code }),
        ...(invocation.tabId === undefined ? {} : { tabId: invocation.tabId }),
        ...(actedOn === undefined ? {} : { actedOn: structuredClone(actedOn) }),
      });
    } catch (caught) {
      log.warn('A dispatch observation could not be prepared and was dropped.', {
        tool: fromWireName(invocation.name),
        error: caught instanceof Error ? caught.name : 'unknown',
      });
      return;
    }

    // Each observer in its own try/catch, so one broken bystander does not
    // silence the others. Ordering is deliberately not a contract: an
    // observer sees a result that is already final, so nothing it does — or
    // fails to do — can reach the call it is watching.
    for (const observer of observers) {
      try {
        observer(observation);
      } catch (caught) {
        // Swallowed on purpose. An observer is a bystander; one that throws
        // is a broken bystander, not a veto.
        log.warn('A dispatch observer threw and was ignored.', {
          tool: observation.tool,
          error: caught instanceof Error ? caught.name : 'unknown',
        });
      }
    }
  }

  private async run(invocation: ToolInvocation): Promise<InternalDispatchResult> {
    const canonicalName = fromWireName(invocation.name);
    const tool = this.tools.get(canonicalName);

    if (!tool) {
      const error = createError('TOOL_NOT_FOUND', `No tool named "${canonicalName}".`, {
        userMessage: `The model asked for a tool that does not exist: ${canonicalName}.`,
      });
      return this.refuse(invocation, error, 'R0');
    }

    // 1. Schema validation. Model output never reaches an implementation raw.
    const parsed = tool.inputSchema.safeParse(invocation.arguments);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      const error = createError('INVALID_ARGUMENT', `Invalid arguments for ${canonicalName}.`, {
        userMessage: `Arguments for ${canonicalName} did not match its schema. ${issues}`,
      });
      return this.refuse(invocation, error, tool.risk);
    }

    // Published before classification, so a connector tool's `classify` and
    // `execute` both see the same context the gate will evaluate against.
    if (
      this.options.publishSecurityContext &&
      invocation.taintState !== undefined &&
      invocation.taintSalt !== undefined
    ) {
      this.options.publishSecurityContext(invocation.taskId, {
        taintState: invocation.taintState,
        taintSalt: invocation.taintSalt,
        saltEpoch: invocation.saltEpoch ?? 1,
        taintSignature: invocation.taintSignature ?? '',
      });
    }

    // 1a. Workspace scope.
    //
    //     Before anything is classified, authorised or executed: is this tab
    //     even in scope for this task? Until workspaces existed the answer
    //     was always yes, because `listTabs()` was `chrome.tabs.query({})`
    //     and a tool acted on whatever id it was handed — so a task started
    //     from one page could reach an unrelated tab in another window.
    //
    //     This only ever subtracts. Everything below still runs on a tab it
    //     admits, and nothing here can turn a "deny" from policy, consent or
    //     the egress gate into an allow.
    if (invocation.tabId !== undefined && this.options.checkWorkspaceMember) {
      const scope = await this.options.checkWorkspaceMember(invocation.taskId, invocation.tabId);
      if (!scope.ok) {
        log.warn('A tool was refused a tab outside its workspace.', {
          taskId: invocation.taskId,
          tool: fromWireName(invocation.name),
        });
        return this.refuse(
          invocation,
          createError('POLICY_BLOCKED', scope.reason, { userMessage: scope.reason }),
          tool.risk,
        );
      }
    }

    const workspaceTabIds = this.options.resolveWorkspaceTabs
      ? await this.options.resolveWorkspaceTabs(invocation.taskId)
      : undefined;
    const workspaceGroupId = await this.options.resolveWorkspaceGroupId?.(invocation.taskId);

    const recorded: { reference: RecordedEvidence; payload: Omit<EvidencePayload, 'id'> }[] = [];
    const currentUrl =
      invocation.tabId !== undefined && this.options.resolveTabUrl
        ? await this.options.resolveTabUrl(invocation.tabId)
        : undefined;
    const context: ToolExecutionContext = {
      taskId: invocation.taskId,
      sessionId: invocation.sessionId,
      toolCallId: invocation.toolCallId,
      ...(invocation.tabId === undefined ? {} : { tabId: invocation.tabId }),
      ...(invocation.plannedUrl === undefined ? {} : { authorisedUrl: invocation.plannedUrl }),
      ...(currentUrl === undefined ? {} : { currentUrl }),
      ...(workspaceTabIds === undefined ? {} : { workspaceTabIds }),
      ...(workspaceGroupId === undefined ? {} : { workspaceGroupId }),
      signal: invocation.signal,
      recordEvidence: (reference, payload) => recorded.push({ reference, payload }),
    };

    // 2. Argument-aware classification. A tool may raise its own risk but the
    //    declared floor always applies.
    const classification = tool.classify?.(parsed.data, context) ?? {};
    const risk = maxRisk(tool.risk, classification.risk ?? tool.risk);

    // 3. Policy.
    const policyContext = await this.options.loadPolicyContext();
    const decision = evaluatePolicy(
      {
        tool: canonicalName,
        taskId: invocation.taskId,
        risk,
        ...(classification.prohibited === undefined
          ? {}
          : { prohibited: classification.prohibited }),
        ...(classification.targetUrl === undefined ? {} : { targetUrl: classification.targetUrl }),
        ...(invocation.plannedUrl === undefined ? {} : { plannedUrl: invocation.plannedUrl }),
        ...(classification.writeDestination === undefined
          ? {}
          : { writeDestination: classification.writeDestination }),
        ...(classification.writePayload === undefined
          ? {}
          : { writePayload: classification.writePayload }),
        ...(invocation.taintState === undefined ? {} : { taintState: invocation.taintState }),
      },
      policyContext,
    );

    // 3b. Egress. Every declared outbound transfer passes the gate before the
    //     tool runs, so no primitive capable of an externally observable
    //     transfer executes ahead of the decision.
    let egressDecision: EgressDecision | undefined;
    let effective = decision;
    if (classification.egress !== undefined && this.options.egress !== undefined) {
      egressDecision = authorizeEgress(
        {
          taskId: invocation.taskId,
          taintState: invocation.taintState ?? unknownTaint('field-absent'),
          taintSalt: invocation.taintSalt ?? '',
          destination: classification.egress.destination,
          ...(classification.egress.payload === undefined
            ? {}
            : { payload: classification.egress.payload }),
          ...(classification.egress.carrier === undefined
            ? {}
            : { carrierInput: classification.egress.carrier }),
          ...(invocation.taintSignature === undefined
            ? {}
            : { taintSignature: invocation.taintSignature }),
          now: Date.now(),
        },
        { consent: this.options.egress.consent },
      );

      await this.options.egress.record({
        taskId: invocation.taskId,
        toolCallId: invocation.toolCallId,
        sourceTool: canonicalName,
        destination: classification.egress.destination,
        decision: egressDecision,
        ...(classification.egress.payload === undefined
          ? {}
          : { payload: classification.egress.payload }),
        taintSalt: invocation.taintSalt ?? '',
        saltEpoch: invocation.saltEpoch ?? 0,
        now: Date.now(),
      });

      // The stricter of the two verdicts wins. Tool risk and data egress are
      // separate questions and neither stands in for the other.
      if (egressDecision.verdict === 'deny') {
        effective = {
          verdict: 'DENY',
          code: 'EXFILTRATION_BLOCKED',
          reason: egressDecision.reason,
          effectiveRisk: 'R4',
        };
      } else if (egressDecision.verdict === 'confirm' && decision.verdict !== 'DENY') {
        effective = {
          verdict: 'ALLOW_WITH_CONFIRMATION',
          code: 'EXFILTRATION_CONFIRM',
          reason: egressDecision.reason,
          effectiveRisk: maxRisk(decision.effectiveRisk, 'R3'),
        };
      }
    }

    // 4. Permission.
    const approval = await this.options.permissionEngine.requestApproval({
      taskId: invocation.taskId,
      tool: canonicalName,
      decision: effective,
      summary: classification.summary ?? describeCall(tool, parsed.data),
      ...(classification.targetUrl === undefined ? {} : { targetUrl: classification.targetUrl }),
      ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
    });

    if (!approval.granted) {
      const code = effective.verdict === 'DENY' ? 'POLICY_BLOCKED' : 'PERMISSION_DENIED';
      const error = createError(code, effective.reason, { userMessage: effective.reason });
      log.info('Tool call refused before execution.', {
        tool: canonicalName,
        verdict: decision.verdict,
        code: decision.code,
      });
      return {
        envelope: errorEnvelope(invocation.toolCallId, error),
        evidence: [],
        risk: decision.effectiveRisk,
        policy: decision,
        taint: [],
        executed: false,
      };
    }

    // 5. Execution, bounded by the tool's timeout and the task's abort signal.
    if (invocation.signal.aborted) {
      return this.refuse(
        invocation,
        createError('USER_CANCELLED', 'The task was cancelled before this tool ran.'),
        risk,
      );
    }

    let result: ToolExecutionResult;
    try {
      result = await withTimeout(tool.execute(parsed.data, context), tool.timeoutMs, canonicalName);
    } catch (caught) {
      const error = toAgentError(caught, canonicalName);
      log.warn('Tool execution failed.', { tool: canonicalName, code: error.code });
      // Evidence captured before the failure is still worth keeping: it is
      // often exactly what explains the failure.
      return {
        envelope: errorEnvelope(invocation.toolCallId, error),
        evidence: await this.persistEvidence(recorded),
        risk,
        policy: decision,
        taint: [],
        executed: true,
      };
    }

    if (!result.success) {
      const error =
        result.error ??
        createError('INTERNAL_ERROR', `${canonicalName} reported failure without an error.`);
      return {
        envelope: errorEnvelope(invocation.toolCallId, error),
        evidence: await this.persistEvidence(recorded),
        risk,
        policy: decision,
        taint: result.taint ?? [],
        executed: true,
      };
    }

    // 6. Sanitisation before the result enters model context, and persistence
    //    of anything the tool recorded as evidence.
    const sanitised = redactValue(result.data);
    const allEvidence = await this.persistEvidence(recorded);

    log.debug('Tool call completed.', { tool: canonicalName, risk });

    return {
      envelope: successEnvelope(
        invocation.toolCallId,
        sanitised,
        allEvidence.map((item) => item.id),
      ),
      evidence: allEvidence,
      risk,
      policy: decision,
      taint: result.taint ?? [],
      executed: true,
      // Not sanitised into the envelope and not part of `sanitised`: it goes
      // to the observation hook and is dropped by `dispatch`.
      ...(result.actedOn === undefined ? {} : { actedOn: result.actedOn }),
    };
  }

  /**
   * Writes each recorded item to the evidence store.
   *
   * The store redacts and hashes the payload and returns the completed
   * reference, so a reference the caller receives always has a payload behind
   * it. A single failed write does not fail the tool call.
   */
  private async persistEvidence(
    recorded: readonly { reference: RecordedEvidence; payload: Omit<EvidencePayload, 'id'> }[],
  ): Promise<EvidenceReference[]> {
    if (recorded.length === 0) return [];

    const store = this.options.evidenceStore;
    if (!store) {
      log.warn('No evidence store is configured; evidence was not persisted.', {
        count: recorded.length,
      });
      return recorded.map((item) => ({
        ...item.reference,
        byteLength: item.payload.content.length,
      }));
    }

    const stored: EvidenceReference[] = [];
    for (const item of recorded) {
      try {
        stored.push(await store.put(item.reference, item.payload));
      } catch (error) {
        log.warn('Could not persist an evidence item.', {
          evidenceId: item.reference.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return stored;
  }

  private refuse(
    invocation: ToolInvocation,
    error: AgentError,
    risk: RiskLevel,
  ): ToolDispatchResult {
    return {
      envelope: errorEnvelope(invocation.toolCallId, error),
      evidence: [],
      risk,
      taint: [],
      executed: false,
    };
  }
}

/** `browser.click` → `browser_click`. */
export /**
 * Freezes a structure all the way down.
 *
 * `Object.freeze` is shallow, so freezing only the top of an observation
 * would leave `arguments.someObject.field` writable — which is precisely the
 * field an observer would reach for.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

export function toWireName(name: string): string {
  return name.replace(/\./g, '_');
}

/** `browser_click` → `browser.click`, restoring only the first separator. */
export function fromWireName(name: string): string {
  if (name.includes('.')) return name;
  const index = name.indexOf('_');
  return index === -1 ? name : `${name.slice(0, index)}.${name.slice(index + 1)}`;
}

function toAgentError(caught: unknown, tool: string): AgentError {
  if (caught instanceof ToolError) return caught.toAgentError();
  if (caught instanceof DOMException && caught.name === 'TimeoutError') {
    return createError('TASK_TIMEOUT', `${tool} timed out.`, {
      userMessage: `${tool} did not finish in time.`,
      retryable: true,
    });
  }
  if (caught instanceof DOMException && caught.name === 'AbortError') {
    return createError('USER_CANCELLED', `${tool} was cancelled.`);
  }
  // Unexpected exception: the message may contain page data, so it is kept in
  // technicalDetails and withheld from the model-facing userMessage.
  return createError('INTERNAL_ERROR', `${tool} threw an unexpected error.`, {
    userMessage: `${tool} failed unexpectedly.`,
    technicalDetails: caught instanceof Error ? caught.message : String(caught),
  });
}

/** One-line human summary of a call, used in permission prompts. */
function describeCall(tool: AgentTool, input: unknown): string {
  const redacted = redactValue(input);
  let rendered: string;
  try {
    rendered = JSON.stringify(redacted) ?? '{}';
  } catch {
    rendered = '{…}';
  }
  if (rendered.length > 200) rendered = `${rendered.slice(0, 200)}…`;
  return `${tool.name} ${rendered}`;
}
