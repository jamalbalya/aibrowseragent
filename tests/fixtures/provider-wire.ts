/**
 * Wire packs for the registered API providers.
 *
 * The conformance suite has to ask the same question of three providers that
 * answer in three different languages: "did the system prompt arrive", "is
 * there a tool call in this reply", "what does a rate limit look like". A pack
 * is that translation — one per provider, holding the credentials-shaped
 * config, the canned wire bodies, and the inspectors that read a request body
 * in that provider's own shape.
 *
 * This is deliberately *not* a lowest common denominator. If a pack could be
 * written generically the suite would stop testing the differences that make
 * a separate adapter necessary in the first place.
 *
 * Nothing here is a real credential. The keys are obvious literals chosen to
 * be unmistakable in a failure message.
 */
import { openAICompatibleFactory } from '@/providers/adapters/openai-compatible';
import { anthropicFactory } from '@/providers/adapters/anthropic';
import { geminiFactory } from '@/providers/adapters/gemini';
import type { ProviderConfig, ProviderFactory } from '@/providers/core/types';

export type WireBody = Record<string, unknown>;

export interface WireInspectors {
  /** The system instruction as it arrived, or undefined when absent. */
  systemInstruction(body: WireBody): string | undefined;
  /** Declared tool names, in order. */
  toolNames(body: WireBody): string[];
  /** Image payloads, normalised to `{ mimeType, data }`. */
  images(body: WireBody): { mimeType: string; data: string }[];
  /** Tool results as the provider carries them, normalised to text. */
  toolResults(body: WireBody): string[];
  /** Tool calls the assistant previously made, normalised to `{ name }`. */
  assistantToolCalls(body: WireBody): { name: string }[];
  /** Whether the body asks for a stream. */
  wantsStream(body: WireBody, url: string): boolean;
  /** The model the request targets, wherever the provider puts it. */
  model(body: WireBody, url: string): string;
}

export interface ProviderWirePack {
  readonly factory: ProviderFactory;
  readonly config: ProviderConfig;
  /** A model this adapter reads as accepting images. */
  readonly visionModel: string;
  /** A model this adapter reads as not accepting images. */
  readonly noVisionModel: string;
  /** Fragment every generation request URL must contain. */
  readonly generateFragment: string;
  /** Header the credential must travel in, and the value it must have. */
  readonly authHeader: string;
  authHeaderValue(apiKey: string): string;
  readonly inspect: WireInspectors;

  /** A plain text completion. */
  text(text: string): Response;
  /** A completion that calls one tool. */
  toolCall(name: string, args: Record<string, unknown>): Response;
  /** A stream: two text deltas, one tool call, usage, and a clean end. */
  stream(name: string, args: Record<string, unknown>): Response;
  /** A model list containing these ids. */
  models(ids: readonly string[]): Response;
  /** A failure with this status, in this provider's error shape. */
  failure(status: number): Response;
  /** A 200 whose body is not this provider's documented shape. */
  malformed(): Response;
  /**
   * Answers a request the adapter makes for its own housekeeping.
   *
   * Model lists and per-model capability lookups are GETs; everything else is
   * the scripted body the test cares about.
   */
  route(url: string, init: RequestInit, scripted: () => Response): Response;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function sse(frames: readonly string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function isGet(init: RequestInit): boolean {
  return (init.method ?? 'GET').toUpperCase() === 'GET';
}

// --- OpenAI-compatible -------------------------------------------------------

const openai: ProviderWirePack = {
  factory: openAICompatibleFactory,
  config: {
    providerId: 'openai-compatible',
    baseUrl: 'https://api.openai.test/v1',
    apiKey: 'sk-' + 'conformance-key-000000000000',
    model: 'gpt-4o',
  },
  visionModel: 'gpt-4o',
  noVisionModel: 'text-only-model',
  generateFragment: '/chat/completions',
  authHeader: 'Authorization',
  // A bearer token, not a bare key.
  authHeaderValue: (apiKey) => `Bearer ${apiKey}`,

  text: (text) =>
    json({
      id: 'cmpl_1',
      model: 'gpt-4o',
      choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    }),

  toolCall: (name, args) =>
    json({
      id: 'cmpl_2',
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_a',
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    }),

  stream: (name, args) =>
    sse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_s","function":{"name":${JSON.stringify(name)},"arguments":${JSON.stringify(JSON.stringify(args))}}}]}}]}\n\n`,
      'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ]),

  models: (ids) => json({ data: ids.map((id) => ({ id })) }),

  failure: (status) =>
    json(
      { error: { message: 'refused', type: 'invalid_request_error' } },
      status,
      status === 429 ? { 'retry-after': '7' } : {},
    ),

  malformed: () => new Response('not json at all', { status: 200 }),

  route: (_url, init, scripted) =>
    isGet(init) ? openai.models(['gpt-4o', 'text-only-model']) : scripted(),

  inspect: {
    systemInstruction: (body) => {
      const messages = body.messages as { role?: string; content?: unknown }[] | undefined;
      const system = messages?.find((m) => m.role === 'system');
      return typeof system?.content === 'string' ? system.content : undefined;
    },
    toolNames: (body) =>
      ((body.tools as { function?: { name?: string } }[] | undefined) ?? []).map(
        (t) => t.function?.name ?? '',
      ),
    images: (body) => {
      const messages = (body.messages as { content?: unknown }[] | undefined) ?? [];
      const found: { mimeType: string; data: string }[] = [];
      for (const message of messages) {
        if (!Array.isArray(message.content)) continue;
        for (const part of message.content as { type?: string; image_url?: { url?: string } }[]) {
          const url = part.type === 'image_url' ? (part.image_url?.url ?? '') : '';
          const match = /^data:([^;]+);base64,(.*)$/.exec(url);
          if (match) found.push({ mimeType: match[1]!, data: match[2]! });
        }
      }
      return found;
    },
    toolResults: (body) =>
      ((body.messages as { role?: string; content?: unknown }[] | undefined) ?? [])
        .filter((m) => m.role === 'tool')
        .map((m) => String(m.content)),
    assistantToolCalls: (body) =>
      ((body.messages as { tool_calls?: { function?: { name?: string } }[] }[] | undefined) ?? [])
        .flatMap((m) => m.tool_calls ?? [])
        .map((call) => ({ name: call.function?.name ?? '' })),
    wantsStream: (body) => body.stream === true,
    model: (body) => (typeof body.model === 'string' ? body.model : ''),
  },
};

// --- Anthropic ---------------------------------------------------------------

const anthropic: ProviderWirePack = {
  factory: anthropicFactory,
  config: {
    providerId: 'anthropic',
    apiKey: 'sk-ant-' + 'conformance-key-000000000000',
    model: 'claude-test-model',
  },
  visionModel: 'claude-test-model',
  noVisionModel: 'claude-2.1',
  generateFragment: '/v1/messages',
  authHeader: 'x-api-key',
  // The bare key, in this provider's own header rather than Authorization.
  authHeaderValue: (apiKey) => apiKey,

  text: (text) =>
    json({
      id: 'msg_1',
      model: 'claude-test-model',
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 11, output_tokens: 7 },
    }),

  toolCall: (name, args) =>
    json({
      id: 'msg_2',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_a', name, input: args }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 11, output_tokens: 7 },
    }),

  stream: (name, args) =>
    sse([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
      `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_s","name":${JSON.stringify(name)},"input":{}}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(JSON.stringify(args))}}}\n\n`,
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]),

  models: (ids) => json({ data: ids.map((id) => ({ id, display_name: id })) }),

  failure: (status) => {
    const type =
      status === 401
        ? 'authentication_error'
        : status === 403
          ? 'permission_error'
          : status === 404
            ? 'not_found_error'
            : status === 429
              ? 'rate_limit_error'
              : status === 529
                ? 'overloaded_error'
                : status >= 500
                  ? 'api_error'
                  : 'invalid_request_error';
    return json(
      { type: 'error', error: { type, message: 'refused' } },
      status,
      status === 429 ? { 'retry-after': '7' } : {},
    );
  },

  malformed: () => new Response('not json at all', { status: 200 }),

  route: (_url, init, scripted) =>
    isGet(init) ? anthropic.models(['claude-test-model', 'claude-2.1']) : scripted(),

  inspect: {
    // Top-level field, not a message. That placement is the whole point.
    systemInstruction: (body) => (typeof body.system === 'string' ? body.system : undefined),
    toolNames: (body) =>
      ((body.tools as { name?: string }[] | undefined) ?? []).map((t) => t.name ?? ''),
    images: (body) => {
      const messages = (body.messages as { content?: unknown }[] | undefined) ?? [];
      const found: { mimeType: string; data: string }[] = [];
      for (const message of messages) {
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content as {
          type?: string;
          source?: { media_type?: string; data?: string };
        }[]) {
          if (block.type === 'image') {
            found.push({
              mimeType: block.source?.media_type ?? '',
              data: block.source?.data ?? '',
            });
          }
        }
      }
      return found;
    },
    toolResults: (body) =>
      ((body.messages as { content?: unknown }[] | undefined) ?? [])
        .flatMap((m) =>
          Array.isArray(m.content) ? (m.content as { type?: string; content?: unknown }[]) : [],
        )
        .filter((block) => block.type === 'tool_result')
        .map((block) => String(block.content)),
    assistantToolCalls: (body) =>
      ((body.messages as { content?: unknown }[] | undefined) ?? [])
        .flatMap((m) =>
          Array.isArray(m.content) ? (m.content as { type?: string; name?: string }[]) : [],
        )
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({ name: block.name ?? '' })),
    wantsStream: (body) => body.stream === true,
    model: (body) => (typeof body.model === 'string' ? body.model : ''),
  },
};

// --- Gemini ------------------------------------------------------------------

const GEMINI_MODEL_DESCRIPTOR = {
  name: 'models/gemini-test-model',
  displayName: 'Gemini test model',
  inputTokenLimit: 32_000,
  outputTokenLimit: 8_192,
  supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
};

const gemini: ProviderWirePack = {
  factory: geminiFactory,
  config: {
    providerId: 'gemini',
    apiKey: 'AIza' + 'conformance-key-000000000000',
    model: 'gemini-test-model',
  },
  visionModel: 'gemini-test-model',
  noVisionModel: 'text-embedding-004',
  generateFragment: ':generateContent',
  authHeader: 'x-goog-api-key',
  authHeaderValue: (apiKey) => apiKey,

  text: (text) =>
    json({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
      modelVersion: 'gemini-test-model',
    }),

  toolCall: (name, args) =>
    json({
      candidates: [
        {
          content: { role: 'model', parts: [{ functionCall: { name, args } }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
    }),

  stream: (name, args) =>
    sse([
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"lo"}]}}]}\n\n',
      `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":${JSON.stringify(name)},"args":${JSON.stringify(args)}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}\n\n`,
    ]),

  models: (ids) =>
    json({
      models: ids.map((id) => ({
        ...GEMINI_MODEL_DESCRIPTOR,
        name: `models/${id}`,
        displayName: id,
      })),
    }),

  failure: (status) => {
    const statusEnum =
      status === 401
        ? 'UNAUTHENTICATED'
        : status === 403
          ? 'PERMISSION_DENIED'
          : status === 404
            ? 'NOT_FOUND'
            : status === 429
              ? 'RESOURCE_EXHAUSTED'
              : status === 503
                ? 'UNAVAILABLE'
                : status >= 500
                  ? 'INTERNAL'
                  : 'INVALID_ARGUMENT';
    return json(
      { error: { code: status, message: 'refused', status: statusEnum } },
      status,
      status === 429 ? { 'retry-after': '7' } : {},
    );
  },

  malformed: () => new Response('not json at all', { status: 200 }),

  route: (url, init, scripted) => {
    if (!isGet(init)) return scripted();
    // A per-model capability lookup, which this adapter makes before any
    // request that could be refused for an unsupported feature.
    if (/\/models\/[^/?]+$/.test(url)) {
      const id = url.slice(url.lastIndexOf('/') + 1);
      return json({ ...GEMINI_MODEL_DESCRIPTOR, name: `models/${id}`, displayName: id });
    }
    return gemini.models(['gemini-test-model']);
  },

  inspect: {
    systemInstruction: (body) => {
      const instruction = body.systemInstruction as { parts?: { text?: string }[] } | undefined;
      return instruction?.parts?.[0]?.text;
    },
    toolNames: (body) =>
      ((body.tools as { functionDeclarations?: { name?: string }[] }[] | undefined) ?? [])
        .flatMap((t) => t.functionDeclarations ?? [])
        .map((d) => d.name ?? ''),
    images: (body) =>
      (
        (body.contents as
          { parts?: { inlineData?: { mimeType?: string; data?: string } }[] }[] | undefined) ?? []
      )
        .flatMap((c) => c.parts ?? [])
        .filter((part) => part.inlineData !== undefined)
        .map((part) => ({
          mimeType: part.inlineData?.mimeType ?? '',
          data: part.inlineData?.data ?? '',
        })),
    toolResults: (body) =>
      (
        (body.contents as
          { parts?: { functionResponse?: { response?: unknown } }[] }[] | undefined) ?? []
      )
        .flatMap((c) => c.parts ?? [])
        .filter((part) => part.functionResponse !== undefined)
        .map((part) => JSON.stringify(part.functionResponse?.response)),
    assistantToolCalls: (body) =>
      ((body.contents as { parts?: { functionCall?: { name?: string } }[] }[] | undefined) ?? [])
        .flatMap((c) => c.parts ?? [])
        .filter((part) => part.functionCall !== undefined)
        .map((part) => ({ name: part.functionCall?.name ?? '' })),
    // The operation is a suffix on the path, not a field in the body.
    wantsStream: (_body, url) => url.includes(':streamGenerateContent'),
    model: (_body, url) => {
      const match = /\/models\/([^:?]+)/.exec(url);
      return match ? decodeURIComponent(match[1]!) : '';
    },
  },
};

/**
 * Every API provider the product registers.
 *
 * The conformance suite iterates this list. Adding a provider without adding
 * a pack leaves it untested, so the registry cross-check in the suite fails
 * rather than letting the omission pass quietly.
 */
export const API_PROVIDER_PACKS: readonly ProviderWirePack[] = [openai, anthropic, gemini];

export const API_PROVIDER_CASES = API_PROVIDER_PACKS.map(
  (pack) => [pack.factory.id, pack] as const,
);
