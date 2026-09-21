/**
 * TEST-PROVIDER-004 — Anthropic adapter (REQ-PROVIDER-001).
 *
 * The conformance suite proves this provider answers the same security
 * questions as the others. These tests prove the opposite thing: that it is
 * genuinely a different wire format and has been translated rather than
 * reshaped into the reference adapter's.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicAdapter,
  ANTHROPIC_API_VERSION,
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  anthropicFactory,
  supportsVision,
} from '@/providers/adapters/anthropic';
import { ProviderRequestError } from '@/providers/core/provider-error';
import type { CanonicalEvent } from '@/providers/core/types';
import { passthroughTransport, testEgressContext } from '../fixtures/egress';

const CONFIG = {
  providerId: 'anthropic',
  apiKey: 'sk-ant-' + 'unit-test-key-0000000000',
  model: 'claude-test-model',
};

const egress = () => testEgressContext({ providerId: 'anthropic', modelId: 'claude-test-model' });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function okMessage(content: unknown[] = [{ type: 'text', text: 'ok' }]): Response {
  return jsonResponse({
    id: 'msg_1',
    content,
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

async function connected(fetchMock: ReturnType<typeof vi.fn>, overrides = {}) {
  const adapter = new AnthropicAdapter(passthroughTransport(fetchMock as unknown as typeof fetch));
  const result = await adapter.connect({ ...CONFIG, ...overrides });
  expect(result.authenticated).toBe(true);
  return adapter;
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[index]![1].body as string) as Record<string, unknown>;
}

describe('connect', () => {
  it('requires an API key and a model', async () => {
    const adapter = new AnthropicAdapter(passthroughTransport(vi.fn()));
    expect((await adapter.connect({ providerId: 'anthropic' })).authenticated).toBe(false);
    expect((await adapter.connect({ providerId: 'anthropic', apiKey: 'k' })).authenticated).toBe(
      false,
    );
  });

  it('says plainly that a consumer subscription is not API access', async () => {
    const adapter = new AnthropicAdapter(passthroughTransport(vi.fn()));
    const result = await adapter.connect({ providerId: 'anthropic' });
    expect(result.error?.userMessage).toMatch(/subscription .* is not API access/i);
  });

  it('defaults to the documented endpoint rather than asking for one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okMessage());
    const adapter = await connected(fetchMock);
    await adapter.generate({ systemInstruction: '', messages: [], egress: egress() });
    expect(fetchMock.mock.calls[0]![0]).toBe(`${ANTHROPIC_DEFAULT_BASE_URL}/v1/messages`);
  });

  it('refuses a base URL carrying a query string', async () => {
    // A query on the base URL is how a credential reaches a destination
    // identity, and from there consent keys, audit records and evidence.
    const adapter = new AnthropicAdapter(passthroughTransport(vi.fn()));
    const result = await adapter.connect({
      ...CONFIG,
      baseUrl: 'https://proxy.test?key=leaked',
    });
    expect(result.authenticated).toBe(false);
    expect(result.error?.code).toBe('INVALID_ARGUMENT');
  });

  it('refuses plaintext off the local machine, and allows it on loopback', async () => {
    // The rule is about a key crossing a network in the clear. Loopback
    // crosses none, and a local gateway speaking this protocol is real.
    const adapter = new AnthropicAdapter(passthroughTransport(vi.fn()));
    expect(
      (await adapter.connect({ ...CONFIG, baseUrl: 'http://proxy.example' })).authenticated,
    ).toBe(false);
    expect(
      (await adapter.connect({ ...CONFIG, baseUrl: 'http://127.0.0.1:8080' })).authenticated,
    ).toBe(true);
  });

  it('reports only a masked key suffix as the account label', async () => {
    const adapter = new AnthropicAdapter(passthroughTransport(vi.fn()));
    const result = await adapter.connect(CONFIG);
    expect(result.accountLabel).not.toContain('unit-test-key');
    expect(result.accountLabel).toContain('…0000');
  });

  it('throws when used before connecting rather than guessing a default', async () => {
    const adapter = new AnthropicAdapter(passthroughTransport(vi.fn()));
    await expect(adapter.listModels()).rejects.toThrow(/not connected/);
  });
});

describe('headers', () => {
  it('sends the key as x-api-key and pins the API version', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okMessage());
    const adapter = await connected(fetchMock);
    await adapter.generate({ systemInstruction: '', messages: [], egress: egress() });

    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(CONFIG.apiKey);
    expect(headers['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
    // Not a bearer token: that is the other provider's scheme.
    expect(headers.Authorization).toBeUndefined();
  });

  it('does not let an extra header displace the credential or the version', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okMessage());
    const adapter = await connected(fetchMock, {
      extraHeaders: { 'x-api-key': 'attacker', 'anthropic-version': '1999-01-01' },
    });
    await adapter.generate({ systemInstruction: '', messages: [], egress: egress() });

    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(CONFIG.apiKey);
    expect(headers['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
  });
});

describe('request translation', () => {
  it('places the system prompt in the top-level field, not in a message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okMessage());
    const adapter = await connected(fetchMock);
    await adapter.generate({
      systemInstruction: 'be careful',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      egress: egress(),
    });

    const body = bodyOf(fetchMock);
    expect(body.system).toBe('be careful');
    const messages = body.messages as { role: string }[];
    expect(messages.every((m) => m.role !== 'system')).toBe(true);
  });

  it('omits the system field entirely when there is no instruction', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okMessage());
    const adapter = await connected(fetchMock);
    await adapter.generate({ systemInstruction: '   ', messages: [], egress: egress() });
    expect(bodyOf(fetchMock)).not.toHaveProperty('system');
  });

  it('always sends max_tokens, because the API has no default', async () => {
    // A fresh response per call: a body can only be read once.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(okMessage()));
    const adapter = await connected(fetchMock);
    await adapter.generate({ systemInstruction: '', messages: [], egress: egress() });
    expect(bodyOf(fetchMock).max_tokens).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS);

    await adapter.generate({
      systemInstruction: '',
      messages: [],
      maxOutputTokens: 32,
      egress: egress(),
    });
    expect(bodyOf(fetchMock, 1).max_tokens).toBe(32);
  });

  it('declares tools with input_schema rather than a nested function object', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okMessage());
    const adapter = await connected(fetchMock);
    await adapter.generate({
      systemInstruction: '',
      messages: [],
      tools: [
        {
          type: 'function',
          name: 'browser_click',
          description: 'Clicks.',
          parameters: { type: 'object', properties: {} },
        },
      ],
      egress: egress(),
    });

    const tools = bodyOf(fetchMock).tools as Record<string, unknown>[];
    expect(tools[0]).toEqual({
      name: 'browser_click',
      description: 'Clicks.',
      input_schema: { type: 'object', properties: {} },
    });
    expect(bodyOf(fetchMock).tool_choice).toEqual({ type: 'auto' });
  });

  it.each([
    ['required', { type: 'any' }],
    ['none', { type: 'none' }],
    ['auto', { type: 'auto' }],
  ] as const)('maps tool choice %s', async (choice, expected) => {
    const fetchMock = vi.fn().mockResolvedValue(okMessage());
    const adapter = await connected(fetchMock);
    await adapter.generate({
      systemInstruction: '',
      messages: [],
      toolChoice: choice,
      tools: [{ type: 'function', name: 't', description: 'd', parameters: {} }],
      egress: egress(),
    });
    expect(bodyOf(fetchMock).tool_choice).toEqual(expected);
  });

  it('sends an image as a base64 source block, not a data URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okMessage());
    const adapter = await connected(fetchMock);
    await adapter.generate({
      systemInstruction: '',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', data: 'QUFBQQ==', mimeType: 'image/png' }],
        },
      ],
      egress: egress(),
    });

    const messages = bodyOf(fetchMock).messages as { content: unknown[] }[];
    expect(messages[0]!.content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'QUFBQQ==' },
    });
  });

  it('puts a tool result in a user message as a tool_result block', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okMessage());
    const adapter = await connected(fetchMock);
    await adapter.generate({
      systemInstruction: '',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              toolCallId: 'toolu_1',
              name: 'browser_click',
              arguments: { a: 1 },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'toolu_1',
              name: 'browser_click',
              content: '{"ok":true}',
              isError: false,
            },
          ],
        },
      ],
      egress: egress(),
    });

    const messages = bodyOf(fetchMock).messages as { role: string; content: unknown[] }[];
    expect(messages[0]!.role).toBe('assistant');
    expect(messages[0]!.content[0]).toEqual({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'browser_click',
      input: { a: 1 },
    });
    // The result is a user turn. There is no third role on this API.
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: '{"ok":true}',
      is_error: false,
    });
  });

  it('merges consecutive messages of the same role', async () => {
    // The API expects an alternating conversation; two user turns in a row
    // are rejected, and the runtime can legitimately produce them.
    const fetchMock = vi.fn().mockResolvedValue(okMessage());
    const adapter = await connected(fetchMock);
    await adapter.generate({
      systemInstruction: '',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'one' }] },
        { role: 'user', content: [{ type: 'text', text: 'two' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      ],
      egress: egress(),
    });

    const messages = bodyOf(fetchMock).messages as { role: string; content: unknown[] }[];
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toHaveLength(2);
    expect(messages[1]!.role).toBe('assistant');
  });

  it('drops an empty text block rather than sending one the API rejects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okMessage());
    const adapter = await connected(fetchMock);
    await adapter.generate({
      systemInstruction: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: '' }] }],
      egress: egress(),
    });
    expect(bodyOf(fetchMock).messages).toEqual([]);
  });
});

describe('response translation', () => {
  it('joins text blocks and reads tool_use blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okMessage([
        { type: 'text', text: 'first ' },
        { type: 'text', text: 'second' },
        { type: 'tool_use', id: 'toolu_x', name: 'browser_click', input: { elementId: 'e1' } },
      ]),
    );
    const adapter = await connected(fetchMock);
    const response = await adapter.generate({
      systemInstruction: '',
      messages: [],
      egress: egress(),
    });

    expect(response.text).toBe('first second');
    expect(response.toolCalls).toEqual([
      { toolCallId: 'toolu_x', name: 'browser_click', arguments: { elementId: 'e1' } },
    ]);
    expect(response.finishReason).toBe('tool_call');
  });

  it('reports non-object tool input as a parse error rather than passing it on', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okMessage([{ type: 'tool_use', id: 't', name: 'n', input: 'oops' }]));
    const adapter = await connected(fetchMock);
    const response = await adapter.generate({
      systemInstruction: '',
      messages: [],
      egress: egress(),
    });
    expect(response.toolCalls[0]!.parseError).toMatch(/JSON object/);
    expect(response.toolCalls[0]!.arguments).toEqual({});
  });

  it.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['max_tokens', 'length'],
    ['refusal', 'content_filter'],
  ] as const)('maps stop reason %s to %s', async (stop, expected) => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        content: [{ type: 'text', text: 'x' }],
        stop_reason: stop,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const adapter = await connected(fetchMock);
    const response = await adapter.generate({
      systemInstruction: '',
      messages: [],
      egress: egress(),
    });
    expect(response.finishReason).toBe(expected);
  });

  it('reads token usage from input_tokens and output_tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        content: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 42, output_tokens: 13 },
      }),
    );
    const adapter = await connected(fetchMock);
    const response = await adapter.generate({
      systemInstruction: '',
      messages: [],
      egress: egress(),
    });
    expect(response.usage).toEqual({ promptTokens: 42, completionTokens: 13 });
  });
});

describe('streaming', () => {
  it('reassembles text deltas and input_json_delta tool fragments', async () => {
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_s","name":"browser_click","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"elem"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"entId\\":\\"e1\\"}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const adapter = await connected(vi.fn().mockResolvedValue(sseResponse(frames)));

    const events: CanonicalEvent[] = [];
    for await (const event of adapter.stream({
      systemInstruction: '',
      messages: [],
      egress: egress(),
    })) {
      events.push(event);
    }

    const done = events.at(-1) as Extract<CanonicalEvent, { type: 'done' }>;
    expect(done.type).toBe('done');
    expect(done.response.text).toBe('Hello');
    expect(done.response.toolCalls).toEqual([
      { toolCallId: 'toolu_s', name: 'browser_click', arguments: { elementId: 'e1' } },
    ]);
    expect(done.response.usage).toEqual({ promptTokens: 5, completionTokens: 3 });
  });

  it('skips a malformed frame instead of ending the stream', async () => {
    const frames = [
      'data: {not json}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const adapter = await connected(vi.fn().mockResolvedValue(sseResponse(frames)));

    const events: CanonicalEvent[] = [];
    for await (const event of adapter.stream({
      systemInstruction: '',
      messages: [],
      egress: egress(),
    })) {
      events.push(event);
    }
    const done = events.at(-1) as Extract<CanonicalEvent, { type: 'done' }>;
    expect(done.response.text).toBe('ok');
  });

  it('ends the stream on a mid-stream error rather than reporting a completed turn', async () => {
    // Partial output must never be presented as a finished answer.
    const frames = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n',
    ];
    const adapter = await connected(vi.fn().mockResolvedValue(sseResponse(frames)));

    const events: CanonicalEvent[] = [];
    for await (const event of adapter.stream({
      systemInstruction: '',
      messages: [],
      egress: egress(),
    })) {
      events.push(event);
    }

    expect(events.at(-1)!.type).toBe('error');
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('drops a tool fragment whose block never started', async () => {
    // Without a start event there is no tool name, and inventing one would
    // hand the runtime a call it was never asked to make.
    const frames = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":9,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const adapter = await connected(vi.fn().mockResolvedValue(sseResponse(frames)));

    const events: CanonicalEvent[] = [];
    for await (const event of adapter.stream({
      systemInstruction: '',
      messages: [],
      egress: egress(),
    })) {
      events.push(event);
    }
    const done = events.at(-1) as Extract<CanonicalEvent, { type: 'done' }>;
    expect(done.response.toolCalls).toEqual([]);
  });
});

describe('capabilities and model listing', () => {
  it('does not claim structured output, because this API cannot enforce it', async () => {
    const adapter = await connected(vi.fn());
    const capabilities = await adapter.getCapabilities('claude-test-model');
    expect(capabilities.structuredOutput).toBe(false);
    expect(capabilities.systemInstruction).toBe(true);
    expect(capabilities.toolCalling).toBe(true);
  });

  it.each([
    ['claude-test-model', true],
    ['claude-2.1', false],
    ['claude-instant-1.2', false],
  ])('reads vision support for %s as %s', (model, expected) => {
    expect(supportsVision(model)).toBe(expected);
  });

  it('reads the model list from its own envelope', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [{ id: 'claude-a', display_name: 'Claude A' }] }));
    const adapter = await connected(fetchMock);
    const models = await adapter.listModels();
    expect(models).toEqual([
      {
        id: 'claude-a',
        displayName: 'Claude A',
        advertisedCapabilities: { vision: true },
      },
    ]);
  });

  it('returns an empty list rather than failing when listing is refused', async () => {
    const adapter = await connected(vi.fn().mockResolvedValue(jsonResponse({}, 403)));
    expect(await adapter.listModels()).toEqual([]);
  });
});

describe('error mapping', () => {
  it('prefers the reported error type over the status code', async () => {
    // A 400 whose type says authentication is a credential problem, and
    // telling the user to fix their request would send them nowhere.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { type: 'error', error: { type: 'authentication_error', message: 'bad' } },
          400,
        ),
      );
    const adapter = await connected(fetchMock);

    await expect(
      adapter.generate({ systemInstruction: '', messages: [], egress: egress() }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProviderRequestError &&
        error.category === 'authentication_failed' &&
        error.providerCode === 'authentication_error',
    );
  });

  it('treats 529 overloaded as a wait rather than a server fault', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ type: 'error', error: { type: 'overloaded_error' } }, 529));
    const adapter = await connected(fetchMock);

    await expect(
      adapter.generate({ systemInstruction: '', messages: [], egress: egress() }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProviderRequestError &&
        error.category === 'provider_unavailable' &&
        error.agentError.retryable === true,
    );
  });

  it('never puts the key in an error, however the provider replies', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(`rejected key ${CONFIG.apiKey}`, { status: 401 }));
    const adapter = await connected(fetchMock);

    const error = await adapter
      .generate({ systemInstruction: '', messages: [], egress: egress() })
      .then(
        () => null,
        (e: unknown) => e as ProviderRequestError,
      );
    // The body is echoed as a diagnostic, so the check that matters is that
    // the user-facing message and the code path never carry it.
    expect(error!.agentError.userMessage).not.toContain(CONFIG.apiKey);
    expect(error!.message).not.toContain(CONFIG.apiKey);
  });
});

describe('factory', () => {
  it('declares an API provider with a default endpoint and no required base URL', () => {
    expect(anthropicFactory.kind).toBe('api');
    expect(anthropicFactory.authKind).toBe('api_key');
    expect(anthropicFactory.baseUrl).toEqual({
      required: false,
      defaultUrl: ANTHROPIC_DEFAULT_BASE_URL,
    });
    expect(anthropicFactory.requiresGuardedTransport).toBe(true);
  });
});
