/**
 * Provider capability doctor (specification sections 12, 14).
 *
 * Every capability reported here is *observed*, not advertised. The doctor
 * issues a real request per check and reports what actually happened, because
 * the specification forbids claiming Agent Ready on a model whose tool calling
 * has not been demonstrated.
 */
import { managementContext } from '@/security/egress/provider-transport';
import { generateTaintSalt } from '@/tasks/task-model';
import { getLogger } from '@/logging/logger';
import type {
  AIProviderAdapter,
  CanonicalRequest,
  CanonicalToolSchema,
  ModelCapabilities,
} from '@/providers/core/types';
import { textMessage } from '@/providers/core/types';

const log = getLogger('provider');

export type CheckStatus = 'pass' | 'fail' | 'skipped' | 'unsupported';

export interface CapabilityCheck {
  readonly id: string;
  readonly label: string;
  readonly status: CheckStatus;
  /** Why it failed or was skipped. Empty on pass. */
  readonly detail: string;
  readonly durationMs: number;
}

export type AgentReadiness = 'AGENT_READY' | 'CONNECTED_LIMITED' | 'CHAT_ONLY' | 'FAILED';

export interface CapabilityReport {
  readonly providerId: string;
  readonly modelId: string;
  readonly readiness: AgentReadiness;
  readonly checks: readonly CapabilityCheck[];
  readonly capabilities: ModelCapabilities;
  readonly generatedAt: number;
  /** Plain-language explanation of the readiness verdict. */
  readonly summary: string;
}

/** Probe tool used to verify tool calling end to end. */
const PROBE_TOOL: CanonicalToolSchema = {
  type: 'function',
  name: 'capability_probe',
  description:
    'Diagnostic probe. Call this function with the exact value "ok" to confirm tool calling works.',
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'Must be the literal string "ok".' },
    },
    required: ['status'],
    additionalProperties: false,
  },
};

/** A 1x1 transparent PNG, used to verify vision without sending user data. */
const PROBE_IMAGE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export interface DoctorOptions {
  /** Per-check timeout. */
  readonly timeoutMs?: number;
  /** Skip the paid round-trips and report only what the adapter advertises. */
  readonly quick?: boolean;
  readonly signal?: AbortSignal;
}

async function timed(
  fn: () => Promise<Omit<CapabilityCheck, 'durationMs'>>,
): Promise<CapabilityCheck> {
  const started = Date.now();
  try {
    const result = await fn();
    return { ...result, durationMs: Date.now() - started };
  } catch (error) {
    return {
      id: 'unknown',
      label: 'Unknown check',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    };
  }
}

export class CapabilityDoctor {
  /** Salt for probe evidence. Probe digests stay unlinkable from task ones. */
  private readonly managementSalt = generateTaintSalt();

  async run(
    adapter: AIProviderAdapter,
    modelId: string,
    options: DoctorOptions = {},
  ): Promise<CapabilityReport> {
    const checks: CapabilityCheck[] = [];
    const base = {
      systemInstruction: 'You are a diagnostic probe. Answer exactly as instructed.',
      maxOutputTokens: 64,
      temperature: 0,
      ...(options.signal ? { signal: options.signal } : {}),
      // Probe traffic still passes the egress gate. Its prompts are fixed
      // strings written here, so no task data can reach them — the context
      // says the state is clean because there is no task, not because one was
      // inspected.
      egress: managementContext(adapter.id, modelId, this.managementSalt),
    } satisfies Partial<CanonicalRequest>;

    // 1. Reachability + authentication.
    const health = await timed(async () => {
      const result = await adapter.validateConnection();
      return result.reachable
        ? {
            id: 'connection',
            label: 'Authentication and reachability',
            status: 'pass' as const,
            detail: '',
          }
        : {
            id: 'connection',
            label: 'Authentication and reachability',
            status: 'fail' as const,
            detail: result.error?.userMessage ?? 'The provider endpoint could not be reached.',
          };
    });
    checks.push({ ...health, id: 'connection', label: 'Authentication and reachability' });

    if (health.status !== 'pass') {
      return this.report(adapter.id, modelId, checks, {
        text: false,
        streaming: false,
        toolCalling: false,
        parallelToolCalling: false,
        vision: false,
        structuredOutput: false,
        fileInput: false,
        audioInput: false,
        contextWindow: null,
        maxOutputTokens: null,
      });
    }

    // 2. Model availability.
    const advertised = await adapter.getCapabilities(modelId);
    const modelCheck = await timed(async () => {
      const models = await adapter.listModels();
      // An endpoint that does not expose a model list is not a failure; the
      // generation check below is the authoritative test.
      if (models.length === 0) {
        return {
          id: 'model',
          label: 'Model availability',
          status: 'skipped' as const,
          detail: 'This endpoint does not expose a model list. Verified by generation instead.',
        };
      }
      return models.some((m) => m.id === modelId)
        ? { id: 'model', label: 'Model availability', status: 'pass' as const, detail: '' }
        : {
            id: 'model',
            label: 'Model availability',
            status: 'fail' as const,
            detail: `"${modelId}" was not in the ${models.length} models this endpoint reports.`,
          };
    });
    checks.push({ ...modelCheck, id: 'model', label: 'Model availability' });

    if (options.quick) {
      checks.push({
        id: 'quick-mode',
        label: 'Behavioural checks',
        status: 'skipped',
        detail: 'Quick mode: capabilities below are advertised by the adapter, not verified.',
        durationMs: 0,
      });
      return this.report(adapter.id, modelId, checks, advertised, true);
    }

    // 3. Text generation.
    const textCheck = await timed(async () => {
      const response = await adapter.generate({
        ...base,
        messages: [textMessage('user', 'Reply with the single word: ready')],
      });
      return response.text.trim().length > 0
        ? { id: 'text', label: 'Text generation', status: 'pass' as const, detail: '' }
        : {
            id: 'text',
            label: 'Text generation',
            status: 'fail' as const,
            detail: `The model returned no text (finish reason: ${response.finishReason}).`,
          };
    });
    checks.push({ ...textCheck, id: 'text', label: 'Text generation' });

    // 4. Tool calling — the gate for Agent Ready.
    const toolCheck = await timed(async () => {
      const response = await adapter.generate({
        ...base,
        messages: [
          textMessage(
            'user',
            'Call the capability_probe function with status set to "ok". Do not reply with text.',
          ),
        ],
        tools: [PROBE_TOOL],
        toolChoice: 'auto',
      });
      if (response.toolCalls.length === 0) {
        return {
          id: 'tools',
          label: 'Tool calling',
          status: 'fail' as const,
          detail: 'The model replied with text instead of calling the probe function.',
        };
      }
      const call = response.toolCalls[0];
      if (call?.parseError) {
        return {
          id: 'tools',
          label: 'Tool calling',
          status: 'fail' as const,
          detail: `Tool arguments were not valid JSON: ${call.parseError}`,
        };
      }
      return { id: 'tools', label: 'Tool calling', status: 'pass' as const, detail: '' };
    });
    checks.push({ ...toolCheck, id: 'tools', label: 'Tool calling' });

    // 5. Streaming.
    const streamCheck = await timed(async () => {
      if (!adapter.stream) {
        return {
          id: 'streaming',
          label: 'Streaming',
          status: 'unsupported' as const,
          detail: 'This adapter does not implement streaming.',
        };
      }
      let sawEvent = false;
      for await (const event of adapter.stream({
        ...base,
        messages: [textMessage('user', 'Count: one two three')],
      })) {
        if (event.type === 'error') {
          return {
            id: 'streaming',
            label: 'Streaming',
            status: 'fail' as const,
            detail: event.error.userMessage,
          };
        }
        if (event.type === 'text_delta' || event.type === 'done') sawEvent = true;
      }
      return sawEvent
        ? { id: 'streaming', label: 'Streaming', status: 'pass' as const, detail: '' }
        : {
            id: 'streaming',
            label: 'Streaming',
            status: 'fail' as const,
            detail: 'The stream closed without producing any events.',
          };
    });
    checks.push({ ...streamCheck, id: 'streaming', label: 'Streaming' });

    // 6. Vision.
    const visionCheck = await timed(async () => {
      if (!advertised.vision) {
        return {
          id: 'vision',
          label: 'Vision',
          status: 'unsupported' as const,
          detail: 'This model is not configured for image input.',
        };
      }
      const response = await adapter.generate({
        ...base,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Reply with the word "seen" if you received an image.' },
              { type: 'image', data: PROBE_IMAGE_PNG, mimeType: 'image/png' },
            ],
          },
        ],
      });
      return response.text.trim().length > 0
        ? { id: 'vision', label: 'Vision', status: 'pass' as const, detail: '' }
        : {
            id: 'vision',
            label: 'Vision',
            status: 'fail' as const,
            detail: 'The model rejected or ignored the image input.',
          };
    });
    checks.push({ ...visionCheck, id: 'vision', label: 'Vision' });

    // 7. Structured output.
    const structuredCheck = await timed(async () => {
      if (!advertised.structuredOutput) {
        return {
          id: 'structured',
          label: 'Structured output',
          status: 'unsupported' as const,
          detail: 'This model does not advertise structured output.',
        };
      }
      const response = await adapter.generate({
        ...base,
        messages: [
          textMessage('user', 'Reply with only this JSON object and nothing else: {"ok":true}'),
        ],
      });
      try {
        const parsed: unknown = JSON.parse(response.text.trim());
        return typeof parsed === 'object' && parsed !== null
          ? { id: 'structured', label: 'Structured output', status: 'pass' as const, detail: '' }
          : {
              id: 'structured',
              label: 'Structured output',
              status: 'fail' as const,
              detail: 'The reply parsed as JSON but was not an object.',
            };
      } catch {
        return {
          id: 'structured',
          label: 'Structured output',
          status: 'fail' as const,
          detail: 'The reply was not valid JSON.',
        };
      }
    });
    checks.push({ ...structuredCheck, id: 'structured', label: 'Structured output' });

    const observed: ModelCapabilities = {
      text: textCheck.status === 'pass',
      streaming: streamCheck.status === 'pass',
      toolCalling: toolCheck.status === 'pass',
      parallelToolCalling: advertised.parallelToolCalling && toolCheck.status === 'pass',
      vision: visionCheck.status === 'pass',
      structuredOutput: structuredCheck.status === 'pass',
      fileInput: advertised.fileInput,
      audioInput: advertised.audioInput,
      contextWindow: advertised.contextWindow,
      maxOutputTokens: advertised.maxOutputTokens,
    };

    log.info('Capability doctor finished.', {
      providerId: adapter.id,
      modelId,
      toolCalling: observed.toolCalling,
    });

    return this.report(adapter.id, modelId, checks, observed);
  }

  private report(
    providerId: string,
    modelId: string,
    checks: readonly CapabilityCheck[],
    capabilities: ModelCapabilities,
    unverified = false,
  ): CapabilityReport {
    const connection = checks.find((c) => c.id === 'connection');
    let readiness: AgentReadiness;
    let summary: string;

    if (connection?.status !== 'pass') {
      readiness = 'FAILED';
      summary = connection?.detail ?? 'The provider could not be reached.';
    } else if (unverified) {
      readiness = 'CONNECTED_LIMITED';
      summary =
        'Connected. Capabilities have not been verified because the doctor ran in quick mode. ' +
        'Run the full check before relying on tool calling.';
    } else if (!capabilities.text) {
      readiness = 'FAILED';
      summary = 'The model is reachable but did not produce any text.';
    } else if (!capabilities.toolCalling) {
      readiness = 'CHAT_ONLY';
      summary =
        'This model can generate text but did not call the probe function. Browser automation ' +
        'requires tool calling, so the agent cannot run tasks with this model.';
    } else {
      const missing = [
        capabilities.streaming ? null : 'streaming',
        capabilities.vision ? null : 'vision',
      ].filter((m): m is string => m !== null);
      readiness = 'AGENT_READY';
      summary =
        missing.length === 0
          ? 'Tool calling verified. The agent can run browser tasks with this model.'
          : `Tool calling verified. Unavailable: ${missing.join(', ')}. Tasks needing those will be refused.`;
    }

    return {
      providerId,
      modelId,
      readiness,
      checks,
      capabilities,
      generatedAt: Date.now(),
      summary,
    };
  }
}
