/**
 * Scripted AI provider.
 *
 * Returns a predetermined sequence of responses so runtime behaviour can be
 * asserted without a network call. Also records every request, which is how
 * the security tests verify that no secret reached the provider.
 */
import type {
  AIProviderAdapter,
  AuthResult,
  CanonicalRequest,
  CanonicalResponse,
  HealthResult,
  ModelCapabilities,
  ModelInfo,
} from '@/providers/core/types';

export const FULL_CAPABILITIES: ModelCapabilities = {
  text: true,
  streaming: true,
  toolCalling: true,
  parallelToolCalling: true,
  vision: true,
  structuredOutput: true,
  fileInput: false,
  audioInput: false,
  contextWindow: 128_000,
  maxOutputTokens: 4096,
};

export function toolCallResponse(
  name: string,
  args: Record<string, unknown>,
  id = 'tc_1',
): CanonicalResponse {
  return {
    text: '',
    toolCalls: [{ toolCallId: id, name, arguments: args }],
    finishReason: 'tool_call',
    usage: { promptTokens: 10, completionTokens: 5 },
  };
}

export function textResponse(text: string): CanonicalResponse {
  return {
    text,
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 5 },
  };
}

export class FakeProvider implements AIProviderAdapter {
  readonly id = 'fake';
  readonly displayName = 'Fake provider';
  readonly kind = 'api' as const;

  readonly authKind = 'api_key' as const;

  readonly requests: CanonicalRequest[] = [];
  private index = 0;
  /** Thrown instead of returning, to exercise error paths. */
  failWith: Error | null = null;

  constructor(private readonly script: CanonicalResponse[] = []) {}

  connect(): Promise<AuthResult> {
    return Promise.resolve({ authenticated: true });
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([{ id: 'fake-model', displayName: 'Fake model' }]);
  }
  getCapabilities(): Promise<ModelCapabilities> {
    return Promise.resolve(FULL_CAPABILITIES);
  }
  validateConnection(): Promise<HealthResult> {
    return Promise.resolve({ reachable: true, latencyMs: 1 });
  }

  generate(request: CanonicalRequest): Promise<CanonicalResponse> {
    this.requests.push(request);
    if (this.failWith) return Promise.reject(this.failWith);

    const next = this.script[this.index];
    this.index += 1;
    // Running past the script means the runtime looped further than the test
    // expected; ending the turn makes that visible rather than hanging.
    return Promise.resolve(next ?? textResponse('Script exhausted.'));
  }

  /** Everything this provider was ever sent, flattened for leak assertions. */
  allText(): string {
    return JSON.stringify(this.requests);
  }
}
