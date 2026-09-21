/**
 * TEST-PROVIDER-002 — Capability doctor (REQ-PROVIDER-002).
 *
 * The doctor exists to stop the product claiming capabilities it has not
 * observed. These tests focus on exactly that: what it refuses to assert.
 */
import { describe, expect, it } from 'vitest';
import { CapabilityDoctor } from '@/providers/capability-doctor/capability-doctor';
import type { CapabilityReport } from '@/providers/capability-doctor/capability-doctor';
import { createError, type ErrorCode } from '@/types/result';
import type {
  AIProviderAdapter,
  AuthResult,
  CanonicalEvent,
  CanonicalRequest,
  CanonicalResponse,
  HealthResult,
  ModelCapabilities,
  ModelInfo,
} from '@/providers/core/types';
import { FULL_CAPABILITIES } from '../fixtures/fake-provider';

interface StubOptions {
  reachable?: boolean;
  /** The failure code the health probe reports, which the doctor classifies. */
  errorCode?: ErrorCode;
  models?: string[];
  text?: string;
  emitToolCall?: boolean;
  toolParseError?: boolean;
  capabilities?: Partial<ModelCapabilities>;
  supportsStream?: boolean;
  streamFails?: boolean;
  structuredOutput?: string;
}

/** The status of one check, by id. */
function byId(report: CapabilityReport, id: string): string | undefined {
  return report.checks.find((check) => check.id === id)?.status;
}

function stub(options: StubOptions = {}): AIProviderAdapter {
  const capabilities = { ...FULL_CAPABILITIES, ...options.capabilities };

  const adapter: AIProviderAdapter = {
    id: 'stub',
    displayName: 'Stub',
    kind: 'api' as const,
    authKind: 'api_key',
    connect: (): Promise<AuthResult> => Promise.resolve({ authenticated: true }),
    disconnect: () => Promise.resolve(),
    listModels: (): Promise<ModelInfo[]> =>
      Promise.resolve((options.models ?? ['test-model']).map((id) => ({ id, displayName: id }))),
    getCapabilities: (): Promise<ModelCapabilities> => Promise.resolve(capabilities),
    validateConnection: (): Promise<HealthResult> =>
      Promise.resolve(
        options.reachable === false
          ? {
              reachable: false,
              error: createError(
                options.errorCode ?? 'NETWORK_ERROR',
                'The probe did not succeed.',
              ),
            }
          : { reachable: true, latencyMs: 1 },
      ),
    generate: (request: CanonicalRequest): Promise<CanonicalResponse> => {
      const wantsTool = (request.tools?.length ?? 0) > 0;
      if (wantsTool) {
        if (!options.emitToolCall) {
          return Promise.resolve({
            text: 'I would call that function.',
            toolCalls: [],
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1 },
          });
        }
        return Promise.resolve({
          text: '',
          toolCalls: [
            {
              toolCallId: 'c1',
              name: 'capability_probe',
              arguments: { status: 'ok' },
              ...(options.toolParseError ? { parseError: 'bad json' } : {}),
            },
          ],
          finishReason: 'tool_call',
          usage: { promptTokens: 1, completionTokens: 1 },
        });
      }

      const asked = JSON.stringify(request.messages);
      if (asked.includes('JSON object')) {
        return Promise.resolve({
          text: options.structuredOutput ?? '{"ok":true}',
          toolCalls: [],
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1 },
        });
      }
      return Promise.resolve({
        text: options.text ?? 'ready',
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
      });
    },
  };

  if (options.supportsStream !== false) {
    adapter.stream = async function* (): AsyncIterable<CanonicalEvent> {
      if (options.streamFails) {
        yield {
          type: 'error',
          error: {
            code: 'MODEL_ERROR',
            message: 'no stream',
            userMessage: 'no stream',
            recoverable: false,
            retryable: false,
          },
        };
        return;
      }
      yield { type: 'text_delta', delta: 'one' };
    };
  }

  return adapter;
}

const doctor = new CapabilityDoctor();

describe('readiness verdict', () => {
  it('reports AGENT_READY only when tool calling actually worked', async () => {
    const report = await doctor.run(stub({ emitToolCall: true }), 'test-model');
    expect(report.readiness).toBe('AGENT_READY');
    expect(report.capabilities.toolCalling).toBe(true);
  });

  it('reports CHAT_ONLY when the model answers with text instead of calling the probe', async () => {
    const report = await doctor.run(stub({ emitToolCall: false }), 'test-model');
    expect(report.readiness).toBe('CHAT_ONLY');
    expect(report.capabilities.toolCalling).toBe(false);
    expect(report.summary).toContain('tool calling');
  });

  it('treats malformed tool arguments as a tool-calling failure', async () => {
    const report = await doctor.run(
      stub({ emitToolCall: true, toolParseError: true }),
      'test-model',
    );
    expect(report.readiness).toBe('CHAT_ONLY');
  });

  it('stops at FAILED when the provider is unreachable', async () => {
    const report = await doctor.run(stub({ reachable: false }), 'test-model');
    expect(report.readiness).toBe('FAILED');
    // Nothing downstream may be claimed once the connection check failed.
    expect(report.capabilities.toolCalling).toBe(false);
    expect(report.capabilities.text).toBe(false);
    // Only the connection findings; no behavioural check was attempted.
    expect(report.checks.map((c) => c.id)).toEqual([
      'transport',
      'reachability',
      'credentials',
      'connection',
    ]);
  });

  it('separates "could not reach" from "key rejected" from "not authorized"', async () => {
    // One probe, three findings, because the fix for each is different.
    const unreachable = await doctor.run(stub({ reachable: false }), 'test-model');
    expect(byId(unreachable, 'reachability')).toBe('fail');
    expect(byId(unreachable, 'credentials')).toBe('skipped');
    expect(byId(unreachable, 'transport')).toBe('pass');

    const rejected = await doctor.run(
      stub({ reachable: false, errorCode: 'AUTH_EXPIRED' }),
      'test-model',
    );
    // A rejected key proves something there read it and said no.
    expect(byId(rejected, 'reachability')).toBe('pass');
    expect(byId(rejected, 'credentials')).toBe('fail');

    const blocked = await doctor.run(
      stub({ reachable: false, errorCode: 'POLICY_BLOCKED' }),
      'test-model',
    );
    expect(byId(blocked, 'transport')).toBe('fail');
    // Nothing was learned about the provider, so nothing is claimed about it.
    expect(byId(blocked, 'reachability')).toBe('skipped');
    expect(byId(blocked, 'credentials')).toBe('skipped');
  });

  it('reports model discovery separately from the model existing', async () => {
    const listed = await doctor.run(stub({ emitToolCall: true }), 'test-model');
    expect(byId(listed, 'discovery')).toBe('pass');

    const unlisted = await doctor.run(stub({ emitToolCall: true, models: [] }), 'test-model');
    expect(byId(unlisted, 'discovery')).toBe('unsupported');
    expect(byId(unlisted, 'model')).toBe('skipped');
  });

  it('never puts credential material in a report', async () => {
    const report = await doctor.run(
      stub({ reachable: false, errorCode: 'AUTH_EXPIRED' }),
      'test-model',
    );
    expect(JSON.stringify(report)).not.toContain('sk-');
  });

  it('reports FAILED when the model produces no text at all', async () => {
    const report = await doctor.run(stub({ emitToolCall: true, text: '   ' }), 'test-model');
    expect(report.readiness).toBe('FAILED');
  });
});

describe('individual checks', () => {
  it('fails the model check when the id is not in the reported list', async () => {
    const report = await doctor.run(stub({ emitToolCall: true, models: ['other'] }), 'missing');
    expect(report.checks.find((c) => c.id === 'model')?.status).toBe('fail');
  });

  it('skips the model check when the endpoint exposes no model list', async () => {
    const report = await doctor.run(stub({ emitToolCall: true, models: [] }), 'test-model');
    const check = report.checks.find((c) => c.id === 'model');
    expect(check?.status).toBe('skipped');
    // A gateway without /models is still usable, so readiness is unaffected.
    expect(report.readiness).toBe('AGENT_READY');
  });

  it('marks streaming unsupported when the adapter does not implement it', async () => {
    const report = await doctor.run(
      stub({ emitToolCall: true, supportsStream: false }),
      'test-model',
    );
    expect(report.checks.find((c) => c.id === 'streaming')?.status).toBe('unsupported');
    expect(report.capabilities.streaming).toBe(false);
  });

  it('marks streaming failed when the stream errors', async () => {
    const report = await doctor.run(stub({ emitToolCall: true, streamFails: true }), 'test-model');
    expect(report.checks.find((c) => c.id === 'streaming')?.status).toBe('fail');
    expect(report.capabilities.streaming).toBe(false);
    // A missing optional capability does not block agent readiness.
    expect(report.readiness).toBe('AGENT_READY');
    expect(report.summary).toContain('streaming');
  });

  it('does not claim vision when the model does not advertise it', async () => {
    const report = await doctor.run(
      stub({ emitToolCall: true, capabilities: { vision: false } }),
      'test-model',
    );
    expect(report.checks.find((c) => c.id === 'vision')?.status).toBe('unsupported');
    expect(report.capabilities.vision).toBe(false);
  });

  it('fails structured output when the reply is not valid JSON', async () => {
    const report = await doctor.run(
      stub({ emitToolCall: true, structuredOutput: 'sure, here you go!' }),
      'test-model',
    );
    expect(report.checks.find((c) => c.id === 'structured')?.status).toBe('fail');
    expect(report.capabilities.structuredOutput).toBe(false);
  });

  it('records a duration for every check', async () => {
    const report = await doctor.run(stub({ emitToolCall: true }), 'test-model');
    for (const check of report.checks) {
      expect(typeof check.durationMs).toBe('number');
    }
  });
});

describe('quick mode', () => {
  it('refuses to claim AGENT_READY on unverified capabilities', async () => {
    const report = await doctor.run(stub({ emitToolCall: true }), 'test-model', { quick: true });
    expect(report.readiness).toBe('CONNECTED_LIMITED');
    expect(report.summary).toContain('not been verified');
  });

  it('never claims parallel tool calling without a passing tool check', async () => {
    const report = await doctor.run(stub({ emitToolCall: false }), 'test-model');
    expect(report.capabilities.parallelToolCalling).toBe(false);
  });
});
