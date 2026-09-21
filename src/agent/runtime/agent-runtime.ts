/**
 * Agent runtime (specification sections 18, 19, 25, 50, 77).
 *
 * The loop:
 *
 *   build context → call model → if tool calls: dispatch each through the
 *   registry (which validates, authorises and executes) → append results →
 *   repeat, until the model answers with text, a budget is exhausted, a loop
 *   is detected, or the task is cancelled.
 *
 * The runtime holds no security logic of its own. It cannot execute a tool
 * except through `ToolRegistry.dispatch`, and it cannot bypass the policy
 * engine, so a compromised or confused model is bounded by the same rules in
 * every code path.
 */
import { getLogger } from '@/logging/logger';
import { createError, type AgentError } from '@/types/result';
import { newId } from '@/utils/ids';
import { sleep } from '@/utils/time';
import type { CanonicalMessage, CanonicalToolCall } from '@/providers/core/types';
import { isProviderRequestError } from '@/providers/core/provider-error';
import type { AIProviderAdapter, ModelCapabilities } from '@/providers/core/types';
import type { ToolRegistry } from '@/tools/registry/tool-registry';
import { fromWireName } from '@/tools/registry/tool-registry';
import { buildRequest, type ContextBudget } from '@/agent/context/context-builder';
import { LoopDetector, hashArguments } from '@/agent/loop-detection/loop-detector';
import { checkBudget, DEFAULT_BUDGET, type ResourceBudget } from '@/agent/budget/budget';
import { decideRetry, DEFAULT_RETRY_POLICY } from '@/agent/recovery/retry-policy';
import type { TaintSource } from '@/security/exfiltration/exfiltration-guard';
import type { TaintState } from '@/security/taint/taint-state';
import { taintSignature } from '@/security/egress/consent';
import type { EvidenceReference } from '@/evidence/evidence-model';
import { isValidTaintSalt } from '@/tasks/task-model';
import type { AgentTask, TaskResult, TaskState, TaskStep, TaskUsage } from '@/tasks/task-model';

const log = getLogger('agent');

/** Side effects the runtime reports back to the task manager. */
export interface RuntimeCallbacks {
  onStateChange(taskId: string, state: TaskState, summary?: string): Promise<void>;
  /**
   * Records the final outcome.
   *
   * The terminal state and the result must land in a single update. Writing
   * the state first and the result afterwards leaves a window in which an
   * observer — the side panel, or anything reading the store — sees a finished
   * task with no outcome recorded.
   */
  onComplete(
    taskId: string,
    outcome: { state: TaskState; result: TaskResult; usage: TaskUsage; error?: AgentError },
  ): Promise<void>;
  onStep(taskId: string, step: TaskStep): Promise<void>;
  onActivity(taskId: string, activity: string): void;
  onUsage(taskId: string, usage: TaskUsage): Promise<void>;
  onEvidence(taskId: string, evidence: readonly EvidenceReference[]): Promise<void>;
  /**
   * Persists newly acquired taint atomically and returns the resulting state.
   *
   * Returning `undefined` means the append could not be persisted. The runtime
   * treats that as a security failure and pauses rather than continuing with a
   * state weaker than the one it just observed.
   */
  persistTaint(taskId: string, sources: readonly TaintSource[]): Promise<TaintState | undefined>;
  /**
   * Restores a usable evidence key when the stored one is missing or damaged.
   *
   * Returns the salt and epoch actually in force afterwards, or `undefined`
   * when recovery could not be persisted — in which case the task pauses
   * rather than proceeding with a security state it cannot record.
   */
  recoverSalt(taskId: string): Promise<{ salt: string; epoch: number } | undefined>;
  onTextDelta?(taskId: string, delta: string): void;
}

export interface RuntimeOptions {
  readonly registry: ToolRegistry;
  readonly callbacks: RuntimeCallbacks;
  readonly budget?: ResourceBudget;
  readonly contextBudget?: ContextBudget;
  /** Injected for deterministic tests. */
  readonly now?: () => number;
  readonly random?: () => number;
}

export interface RunInput {
  readonly task: AgentTask;
  readonly provider: AIProviderAdapter;
  readonly capabilities: ModelCapabilities;
  readonly signal: AbortSignal;
  /** Tab the task is focused on, when it has one. */
  readonly tabId?: number;
  /** Prior conversation when resuming an interrupted task. */
  readonly history?: readonly CanonicalMessage[];
}

export interface RunOutput {
  readonly result: TaskResult;
  readonly messages: readonly CanonicalMessage[];
  readonly usage: TaskUsage;
  /**
   * The structured failure, when the task ended in one.
   *
   * `result.summary` carries the human explanation; this carries the code, so
   * the task record can distinguish LOOP_DETECTED from AUTH_EXPIRED without
   * parsing prose.
   */
  readonly error?: AgentError;
}

export class AgentRuntime {
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: RuntimeOptions) {
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
  }

  async run(input: RunInput): Promise<RunOutput> {
    const { task, provider, capabilities, signal } = input;
    const budget = this.options.budget ?? DEFAULT_BUDGET;
    const startedAt = this.now();

    // Tool calling is the hard requirement for running a task at all.
    if (!capabilities.toolCalling) {
      return this.terminate(
        task,
        'BLOCKED',
        'The selected model does not support tool calling, so it cannot operate the browser. ' +
          'Choose a model that passes the tool-calling check in the capability doctor.',
        [],
        this.emptyUsage(startedAt),
      );
    }

    const messages: CanonicalMessage[] = [
      ...(input.history ?? []),
      { role: 'user', content: [{ type: 'text', text: task.objective }] },
    ];
    const detector = new LoopDetector();
    // Task-level, not value-level: see `taint-state.ts` for why nothing finer
    // survives the model boundary.
    let taintState: TaintState = task.taintState;

    const evidenceIds: string[] = [...task.evidenceIds];
    const completed: string[] = [];
    const failed: string[] = [];
    const blocked: string[] = [];
    const externalWrites: string[] = [];

    let usage: TaskUsage = { ...task.usage, elapsedMs: 0 };
    let stepIndex = task.steps.length;

    // A damaged evidence key is repaired before anything is sent, not worked
    // around. Rotation replaces the key and bumps the epoch; it never touches
    // taint, so recovering the ability to record a transfer is not a route to
    // recovering permission to make one.
    let taintSalt = task.taintSalt;
    let saltEpoch = task.saltEpoch;
    if (!isValidTaintSalt(taintSalt)) {
      const recovered = await this.options.callbacks.recoverSalt(task.id);
      if (recovered === undefined) {
        return this.terminate(
          task,
          'PARTIAL',
          'Paused: the key used to record outbound transfers could not be restored, so no ' +
            'transfer can be authorised. Resume once storage is available.',
          evidenceIds,
          usage,
        );
      }
      taintSalt = recovered.salt;
      saltEpoch = recovered.epoch;
    }

    const tools = this.options.registry.toCanonicalSchemas();

    await this.options.callbacks.onStateChange(task.id, 'PLANNING', 'Planning the approach.');

    for (;;) {
      if (signal.aborted) {
        return this.terminate(task, 'CANCELLED', 'The task was cancelled.', evidenceIds, usage);
      }

      usage = { ...usage, elapsedMs: this.now() - startedAt };
      const budgetCheck = checkBudget(usage, budget);
      if (budgetCheck.exhausted) {
        log.warn('Task stopped on budget exhaustion.', {
          taskId: task.id,
          dimension: budgetCheck.dimension,
        });
        return this.terminate(
          task,
          completed.length > 0 ? 'PARTIAL' : 'FAILED',
          `${budgetCheck.detail ?? 'A resource budget was exhausted.'} ` +
            'The task stopped rather than continuing past its limit.',
          evidenceIds,
          usage,
          { completed, failed, blocked, externalWrites },
        );
      }

      // ---- Model turn -------------------------------------------------
      this.options.callbacks.onActivity(task.id, 'Thinking');
      await this.options.callbacks.onStateChange(task.id, 'RUNNING');

      // Built fresh on every turn, so a retry re-enters the gate with the
      // taint the task has *now* rather than inheriting an earlier decision.
      const request = buildRequest({
        task,
        messages,
        tools,
        hasVision: capabilities.vision,
        ...(this.options.contextBudget === undefined ? {} : { budget: this.options.contextBudget }),
        signal,
        egress: {
          taskId: task.id,
          taintState,
          taintSalt,
          saltEpoch,
          taintSignature: await taintSignature(taintState),
          providerId: task.providerId,
          modelId: task.modelId,
        },
      });

      let response;
      try {
        response = await provider.generate(request);
      } catch (error) {
        const agentError = toProviderError(error);
        if (agentError.code === 'USER_CANCELLED') {
          return this.terminate(task, 'CANCELLED', 'The task was cancelled.', evidenceIds, usage);
        }

        // A transient provider failure gets a bounded retry; anything else stops.
        const retry = decideRetry(
          agentError.code,
          usage.retries + 1,
          DEFAULT_RETRY_POLICY,
          this.random,
        );
        if (retry.shouldRetry) {
          usage = { ...usage, retries: usage.retries + 1 };
          await this.options.callbacks.onStateChange(task.id, 'RECOVERING', retry.reason);
          this.options.callbacks.onActivity(task.id, `Retrying after a provider error`);
          try {
            await sleep(retry.delayMs, signal);
          } catch {
            return this.terminate(task, 'CANCELLED', 'The task was cancelled.', evidenceIds, usage);
          }
          continue;
        }

        await this.recordStep(task.id, stepIndex++, {
          kind: 'error',
          summary: agentError.userMessage,
          status: 'error',
          error: agentError,
        });
        return this.terminate(
          task,
          completed.length > 0 ? 'PARTIAL' : 'FAILED',
          agentError.userMessage,
          evidenceIds,
          usage,
          { completed, failed, blocked, externalWrites },
          agentError,
        );
      }

      usage = {
        ...usage,
        modelRequests: usage.modelRequests + 1,
        promptTokens: usage.promptTokens + response.usage.promptTokens,
        completionTokens: usage.completionTokens + response.usage.completionTokens,
      };
      await this.options.callbacks.onUsage(task.id, usage);

      // ---- Final answer ----------------------------------------------
      if (response.toolCalls.length === 0) {
        const text = response.text.trim();
        await this.recordStep(task.id, stepIndex++, {
          kind: 'message',
          summary: text.slice(0, 200),
          status: 'success',
        });
        // A task that never did anything but also never failed is complete
        // only in the trivial sense; report PARTIAL when work was attempted
        // and some of it failed.
        const outcome: TaskResult['outcome'] =
          failed.length > 0 || blocked.length > 0 ? 'PARTIAL' : 'COMPLETED';
        return this.terminate(task, outcome, text || 'The task finished.', evidenceIds, usage, {
          completed,
          failed,
          blocked,
          externalWrites,
        });
      }

      messages.push({
        role: 'assistant',
        content: [
          ...(response.text.trim().length > 0
            ? [{ type: 'text' as const, text: response.text }]
            : []),
          ...response.toolCalls.map((call) => ({
            type: 'tool_call' as const,
            toolCallId: call.toolCallId,
            name: call.name,
            arguments: call.arguments,
          })),
        ],
      });

      // ---- Tool turn --------------------------------------------------
      const resultParts: CanonicalMessage['content'][number][] = [];

      for (const call of response.toolCalls) {
        if (signal.aborted) {
          return this.terminate(task, 'CANCELLED', 'The task was cancelled.', evidenceIds, usage);
        }

        const canonicalName = fromWireName(call.name);

        // Arguments the provider could not serialise never reach dispatch.
        if (call.parseError) {
          const error = createError(
            'TOOL_CALL_INVALID',
            `Arguments for ${canonicalName} were not valid JSON.`,
            { userMessage: `The model produced malformed arguments: ${call.parseError}` },
          );
          resultParts.push(this.toolResultPart(call, { status: 'error', error }));
          failed.push(`${canonicalName}: malformed arguments`);
          await this.recordStep(task.id, stepIndex++, {
            kind: 'tool_call',
            tool: canonicalName,
            summary: `${canonicalName} was called with malformed arguments.`,
            status: 'error',
            error,
          });
          continue;
        }

        this.options.callbacks.onActivity(task.id, describeActivity(canonicalName));
        await this.options.callbacks.onStateChange(task.id, 'WAITING_FOR_TOOL');

        const dispatch = await this.options.registry.dispatch({
          toolCallId: call.toolCallId,
          taskId: task.id,
          sessionId: task.sessionId,
          name: call.name,
          arguments: call.arguments,
          ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
          taintState,
          taintSalt,
          saltEpoch,
          taintSignature: await taintSignature(taintState),
          signal,
        });

        usage = {
          ...usage,
          toolCalls: usage.toolCalls + 1,
          ...(dispatch.envelope.evidence && dispatch.evidence.some((e) => e.type === 'SCREENSHOT')
            ? { screenshots: usage.screenshots + 1 }
            : {}),
        };

        if (dispatch.evidence.length > 0) {
          evidenceIds.push(...dispatch.evidence.map((item) => item.id));
          await this.options.callbacks.onEvidence(task.id, dispatch.evidence);
        }
        // Persist before the next model turn. An eviction between here and
        // the next tool call must not be able to forget what this one read.
        if (dispatch.taint.length > 0) {
          const persisted = await this.options.callbacks.persistTaint(task.id, dispatch.taint);
          if (persisted === undefined) {
            return this.terminate(
              task,
              'PARTIAL',
              'Paused: the record of what this task has read could not be saved, so no ' +
                'further action can be authorised. Resume once storage is available.',
              evidenceIds,
              usage,
              { completed, failed, blocked, externalWrites },
            );
          }
          taintState = persisted;
        }

        const success = dispatch.envelope.status === 'success';
        const errorCode = dispatch.envelope.error?.code;

        if (success) {
          completed.push(canonicalName);
          if (dispatch.policy?.exfiltration !== undefined) {
            externalWrites.push(canonicalName);
            usage = { ...usage, externalWrites: usage.externalWrites + 1 };
          }
        } else if (errorCode === 'POLICY_BLOCKED' || errorCode === 'PERMISSION_DENIED') {
          blocked.push(`${canonicalName}: ${dispatch.envelope.error?.message ?? 'refused'}`);
        } else {
          failed.push(`${canonicalName}: ${dispatch.envelope.error?.message ?? 'failed'}`);
        }

        await this.recordStep(task.id, stepIndex++, {
          kind: 'tool_call',
          tool: canonicalName,
          risk: dispatch.risk,
          summary: `${canonicalName} ${success ? 'succeeded' : (dispatch.envelope.error?.message ?? 'failed')}`,
          status: success
            ? 'success'
            : errorCode === 'PERMISSION_DENIED' || errorCode === 'POLICY_BLOCKED'
              ? 'denied'
              : 'error',
          evidenceIds: dispatch.evidence.map((item) => item.id),
          ...(dispatch.envelope.error === undefined
            ? {}
            : {
                error: createError(
                  (errorCode ?? 'INTERNAL_ERROR') as AgentError['code'],
                  dispatch.envelope.error.message,
                ),
              }),
        });

        resultParts.push(this.toolResultPart(call, dispatch.envelope));

        // ---- Loop detection ---------------------------------------------
        detector.record({
          tool: canonicalName,
          argsHash: hashArguments(call.arguments),
          success,
          ...(errorCode === undefined ? {} : { errorCode: errorCode as AgentError['code'] }),
          timestamp: this.now(),
          // R0 tools observe without changing anything, so they never reset
          // another call's repetition streak.
          mutating: dispatch.risk !== 'R0',
        });
        const loop = detector.check();
        if (loop.detected) {
          messages.push({ role: 'tool', content: resultParts });
          log.warn('Loop detected; stopping the task.', {
            taskId: task.id,
            kind: loop.kind,
            tool: loop.tool,
          });
          const error = createError('LOOP_DETECTED', loop.detail ?? 'The task stopped repeating.', {
            userMessage: loop.detail ?? 'The agent repeated the same action without progress.',
            recoverable: true,
          });
          await this.recordStep(task.id, stepIndex++, {
            kind: 'error',
            summary: loop.detail ?? 'Loop detected.',
            status: 'error',
            error,
          });
          return this.terminate(
            task,
            completed.length > 0 ? 'PARTIAL' : 'FAILED',
            error.userMessage,
            evidenceIds,
            usage,
            { completed, failed, blocked, externalWrites },
            error,
          );
        }
      }

      messages.push({ role: 'tool', content: resultParts });
      await this.options.callbacks.onUsage(task.id, usage);
    }
  }

  private toolResultPart(
    call: CanonicalToolCall,
    envelope: { status: string; result?: unknown; error?: { code: string; message: string } },
  ): CanonicalMessage['content'][number] {
    return {
      type: 'tool_result',
      toolCallId: call.toolCallId,
      name: call.name,
      content: JSON.stringify(envelope),
      isError: envelope.status !== 'success',
    };
  }

  private async recordStep(
    taskId: string,
    index: number,
    partial: Omit<TaskStep, 'id' | 'index' | 'startedAt' | 'finishedAt'>,
  ): Promise<void> {
    const now = this.now();
    await this.options.callbacks.onStep(taskId, {
      id: newId('step'),
      index,
      startedAt: now,
      finishedAt: now,
      ...partial,
    });
  }

  private emptyUsage(startedAt: number): TaskUsage {
    return {
      toolCalls: 0,
      modelRequests: 0,
      retries: 0,
      screenshots: 0,
      externalWrites: 0,
      promptTokens: 0,
      completionTokens: 0,
      elapsedMs: this.now() - startedAt,
    };
  }

  private async terminate(
    task: AgentTask,
    outcome: TaskResult['outcome'],
    summary: string,
    evidenceIds: readonly string[],
    usage: TaskUsage,
    actions: {
      completed: readonly string[];
      failed: readonly string[];
      blocked: readonly string[];
      externalWrites: readonly string[];
    } = { completed: [], failed: [], blocked: [], externalWrites: [] },
    error?: AgentError,
  ): Promise<RunOutput> {
    const result: TaskResult = {
      outcome,
      summary,
      completedActions: [...actions.completed],
      failedActions: [...actions.failed],
      blockedActions: [...actions.blocked],
      externalWrites: [...actions.externalWrites],
      evidenceIds: [...evidenceIds],
    };

    await this.options.callbacks.onComplete(task.id, {
      state: outcome,
      result,
      usage,
      ...(error === undefined ? {} : { error }),
    });
    log.info('Task finished.', { taskId: task.id, outcome, toolCalls: usage.toolCalls });

    return {
      result,
      messages: [],
      usage,
      ...(error === undefined ? {} : { error }),
    };
  }
}

function toProviderError(error: unknown): AgentError {
  // Structural, so every adapter's structured failure keeps its code and its
  // retry classification rather than being flattened to MODEL_ERROR.
  if (isProviderRequestError(error)) return error.agentError;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return createError('USER_CANCELLED', 'The request was cancelled.');
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return createError('NETWORK_ERROR', 'The provider did not respond in time.', {
      retryable: true,
    });
  }
  return createError('MODEL_ERROR', 'The provider request failed.', {
    userMessage: 'The AI provider request failed.',
    technicalDetails: error instanceof Error ? error.message : String(error),
  });
}

/** Human-readable activity label for the side panel. */
function describeActivity(tool: string): string {
  const labels: Record<string, string> = {
    'browser.read_page': 'Reading the page',
    'browser.click': 'Clicking',
    'browser.type': 'Typing',
    'browser.select': 'Choosing an option',
    'browser.navigate': 'Navigating',
    'browser.scroll': 'Scrolling',
    'browser.wait': 'Waiting',
    'browser.screenshot': 'Taking a screenshot',
    'browser.reload': 'Reloading',
    'browser.go_back': 'Going back',
    'browser.go_forward': 'Going forward',
    'tabs.list': 'Listing tabs',
    'tabs.create': 'Opening a tab',
    'tabs.close': 'Closing a tab',
    'tabs.activate': 'Switching tabs',
    'debugger.console': 'Checking the console',
    'debugger.network': 'Checking network activity',
    'debugger.dom': 'Inspecting the DOM',
    'debugger.page_state': 'Checking page state',
  };
  return labels[tool] ?? `Running ${tool}`;
}
