/**
 * TEST-PROVIDER-005 — Gemini adapter (REQ-PROVIDER-001).
 *
 * The conformance suite proves this provider answers the same security
 * questions as the others. These tests prove the differences were translated
 * rather than flattened — in particular the two that have no counterpart in
 * either other adapter: tool calls with no id, and an authentication
 * mechanism whose documented alternative would put a credential in a URL.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  bareModelId,
  GeminiAdapter,
  GEMINI_DEFAULT_BASE_URL,
  geminiFactory,
} from '@/providers/adapters/gemini';
import { ProviderRequestError } from '@/providers/core/provider-error';
import type { CanonicalEvent } from '@/providers/core/types';
import { passthroughTransport, testEgressContext } from '../fixtures/egress';

const CONFIG = {
  providerId: 'gemini',
  apiKey: 'AIza' + 'unit-test-key-0000000000',
  model: 'gemini-test-model',
};

const egress = () => testEgressContext({ providerId: 'gemini', modelId: 'gemini-test-model' });

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

const MODEL_DESCRIPTOR = {
  name: 'models/gemini-test-model',
  displayName: 'Gemini test model',
  inputTokenLimit: 32_000,
  outputTokenLimit: 8_192,
  supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
};

function okResponse(parts: unknown[] = [{ text: 'ok' }]): Response {
  return jsonResponse({
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  });
}

/**
 * A fetch that answers housekeeping GETs itself and everything else from the
 * script, because this adapter looks a model up before a request it might
 * have to refuse.
 */
function routed(script: () => Response): ReturnType<typeof vi.fn> {
  return vi.fn((_url: string, init: RequestInit) => {
    if ((init.method ?? 'GET').toUpperCase() === 'GET') {
      return Promise.resolve(jsonResponse(MODEL_DESCRIPTOR));
    }
    return Promise.resolve(script());
  });
}

async function connected(fetchMock: ReturnType<typeof vi.fn>, overrides = {}) {
  const adapter = new GeminiAdapter(passthroughTransport(fetchMock as unknown as typeof fetch));
  const result = await adapter.connect({ ...CONFIG, ...overrides });
  expect(result.authenticated).toBe(true);
  return adapter;
}

function posts(
  fetchMock: ReturnType<typeof vi.fn>,
): { url: string; body: Record<string, unknown> }[] {
  return fetchMock.mock.calls
    .filter((call) => typeof (call[1] as RequestInit).body === 'string')
    .map((call) => ({
      url: call[0] as string,
      body: JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>,
    }));
}

describe('connect', () => {
  it('requires an API key and a model', async () => {
    const adapter = new GeminiAdapter(passthroughTransport(vi.fn()));
    expect((await adapter.connect({ providerId: 'gemini' })).authenticated).toBe(false);
    expect((await adapter.connect({ providerId: 'gemini', apiKey: 'k' })).authenticated).toBe(
      false,
    );
  });

  it('defaults to the documented endpoint', async () => {
    const fetchMock = routed(() => okResponse());
    const adapter = await connected(fetchMock);
    await adapter.generate({ systemInstruction: '', messages: [], egress: egress() });
    expect(posts(fetchMock)[0]!.url).toBe(
      `${GEMINI_DEFAULT_BASE_URL}/models/gemini-test-model:generateContent`,
    );
  });

  it('refuses a base URL with a query string, which is where a key could hide', async () => {
    // This endpoint also documents a `key=` query parameter. The adapter does
    // not use it, and will not accept a base URL that could smuggle one in:
    // the egress gate builds a destination identity from the request URL, so
    // a credential there would reach consent keys, audit records and evidence.
    const adapter = new GeminiAdapter(passthroughTransport(vi.fn()));
    const result = await adapter.connect({
      ...CONFIG,
      baseUrl: `${GEMINI_DEFAULT_BASE_URL}?key=x`,
    });
    expect(result.authenticated).toBe(false);
    expect(result.error?.userMessage).toMatch(/never in the URL/i);
  });

  it('accepts a model id with or without the models/ prefix', async () => {
    const fetchMock = routed(() => okResponse());
    const adapter = await connected(fetchMock, { model: 'models/gemini-test-model' });
    await adapter.generate({ systemInstruction: '', messages: [], egress: egress() });
    // Normalised once, so the path is never built with a doubled prefix.
    expect(posts(fetchMock)[0]!.url).toContain('/models/gemini-test-model:generateContent');
    expect(bareModelId('models/x')).toBe('x');
    expect(bareModelId('x')).toBe('x');
  });
});

describe('authentication', () => {
  it('sends the key as a header and never in a URL', async () => {
    const fetchMock = routed(() => okResponse());
    const adapter = await connected(fetchMock);
    await adapter.generate({ systemInstruction: '', messages: [], egress: egress() });
    await adapter.listModels();

    for (const call of fetchMock.mock.calls) {
      const url = call[0] as string;
      expect(url).not.toContain(CONFIG.apiKey);
      expect(url).not.toMatch(/[?&]key=/i);
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers['x-goog-api-key']).toBe(CONFIG.apiKey);
    }
  });

  it('does not let an extra header displace the credential', async () => {
    const fetchMock = routed(() => okResponse());
    const adapter = await connected(fetchMock, {
      extraHeaders: { 'x-goog-api-key': 'attacker' },
    });
    await adapter.generate({ systemInstruction: '', messages: [], egress: egress() });
    const headers = fetchMock.mock.calls.at(-1)![1].headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe(CONFIG.apiKey);
  });
});

describe('request translation', () => {
  it('sends the system prompt as systemInstruction, not as a turn', async () => {
    const fetchMock = routed(() => okResponse());
    const adapter = await connected(fetchMock);
    await adapter.generate({
      systemInstruction: 'be careful',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      egress: egress(),
    });

    const body = posts(fetchMock)[0]!.body;
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'be careful' }] });
    const contents = body.contents as { role: string }[];
    expect(contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
  });

  it('calls the assistant role "model"', async () => {
    const fetchMock = routed(() => okResponse());
    const adapter = await connected(fetchMock);
    await adapter.generate({
      systemInstruction: '',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'prior' }] }],
      egress: egress(),
    });
    expect((posts(fetchMock)[0]!.body.contents as { role: string }[])[0]!.role).toBe('model');
  });

  it('declares tools under functionDeclarations with a tool config mode', async () => {
    const fetchMock = routed(() => okResponse());
    const adapter = await connected(fetchMock);
    await adapter.generate({
      systemInstruction: '',
      messages: [],
      toolChoice: 'required',
      tools: [
        {
          type: 'function',
          name: 'browser_click',
          description: 'Clicks.',
          parameters: { type: 'object' },
        },
      ],
      egress: egress(),
    });

    const body = posts(fetchMock)[0]!.body;
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          { name: 'browser_click', description: 'Clicks.', parameters: { type: 'object' } },
        ],
      },
    ]);
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY' } });
  });

  it('sends an image as inlineData', async () => {
    const fetchMock = routed(() => okResponse());
    const adapter = await connected(fetchMock);
    await adapter.generate({
      systemInstruction: '',
      messages: [
        { role: 'user', content: [{ type: 'image', data: 'QUFBQQ==', mimeType: 'image/png' }] },
      ],
      egress: egress(),
    });
    const contents = posts(fetchMock)[0]!.body.contents as { parts: unknown[] }[];
    expect(contents[0]!.parts[0]).toEqual({
      inlineData: { mimeType: 'image/png', data: 'QUFBQQ==' },
    });
  });

  it('sends a tool result as a functionResponse object keyed by name', async () => {
    // There are no call ids on this API, so the name is the correlation key
    // and the result must be an object rather than the canonical JSON string.
    const fetchMock = routed(() => okResponse());
    const adapter = await connected(fetchMock);
    await adapter.generate({
      systemInstruction: '',
      messages: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'fc_0_browser_click',
              name: 'browser_click',
              content: '{"ok":true}',
              isError: false,
            },
          ],
        },
      ],
      egress: egress(),
    });

    const contents = posts(fetchMock)[0]!.body.contents as { parts: unknown[] }[];
    expect(contents[0]!.parts[0]).toEqual({
      functionResponse: { name: 'browser_click', response: { ok: true } },
    });
  });

  it('wraps non-object tool output rather than dropping it', async () => {
    const fetchMock = routed(() => okResponse());
    const adapter = await connected(fetchMock);
    await adapter.generate({
      systemInstruction: '',
      messages: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'x',
              name: 'read',
              content: 'plain text',
              isError: false,
            },
          ],
        },
      ],
      egress: egress(),
    });
    const contents = posts(fetchMock)[0]!.body.contents as { parts: unknown[] }[];
    expect(contents[0]!.parts[0]).toEqual({
      functionResponse: { name: 'read', response: { result: 'plain text' } },
    });
  });

  it('states a failed tool result in the payload, since there is no error flag', async () => {
    const fetchMock = routed(() => okResponse());
    const adapter = await connected(fetchMock);
    await adapter.generate({
      systemInstruction: '',
      messages: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'x',
              name: 'read',
              content: '{"code":"DENIED"}',
              isError: true,
            },
          ],
        },
      ],
      egress: egress(),
    });
    const contents = posts(fetchMock)[0]!.body.contents as { parts: unknown[] }[];
    expect(contents[0]!.parts[0]).toEqual({
      functionResponse: { name: 'read', response: { error: { code: 'DENIED' } } },
    });
  });
});

describe('response translation', () => {
  it('synthesises a tool call id, because the provider has none', async () => {
    const fetchMock = routed(() =>
      okResponse([{ functionCall: { name: 'browser_click', args: { elementId: 'e1' } } }]),
    );
    const adapter = await connected(fetchMock);
    const response = await adapter.generate({
      systemInstruction: '',
      messages: [],
      egress: egress(),
    });

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]!.name).toBe('browser_click');
    expect(response.toolCalls[0]!.toolCallId).toBe('fc_0_browser_click');
    expect(response.finishReason).toBe('tool_call');
  });

  it('gives parallel calls distinct ids', async () => {
    const fetchMock = routed(() =>
      okResponse([
        { functionCall: { name: 'a', args: {} } },
        { functionCall: { name: 'a', args: {} } },
      ]),
    );
    const adapter = await connected(fetchMock);
    const response = await adapter.generate({
      systemInstruction: '',
      messages: [],
      egress: egress(),
    });
    const ids = response.toolCalls.map((c) => c.toolCallId);
    expect(new Set(ids).size).toBe(2);
  });

  it('reports a blocked prompt as a content filter rather than an empty answer', async () => {
    const fetchMock = routed(() =>
      jsonResponse({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } }),
    );
    const adapter = await connected(fetchMock);
    const response = await adapter.generate({
      systemInstruction: '',
      messages: [],
      egress: egress(),
    });
    expect(response.finishReason).toBe('content_filter');
  });

  it.each([
    ['STOP', 'stop'],
    ['MAX_TOKENS', 'length'],
    ['SAFETY', 'content_filter'],
    ['RECITATION', 'content_filter'],
  ] as const)('maps finish reason %s to %s', async (reason, expected) => {
    const fetchMock = routed(() =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: reason }] }),
    );
    const adapter = await connected(fetchMock);
    const response = await adapter.generate({
      systemInstruction: '',
      messages: [],
      egress: egress(),
    });
    expect(response.finishReason).toBe(expected);
  });

  it('refuses a 200 that carries an error object', async () => {
    const fetchMock = routed(() =>
      jsonResponse({ error: { code: 429, message: 'slow down', status: 'RESOURCE_EXHAUSTED' } }),
    );
    const adapter = await connected(fetchMock);
    await expect(
      adapter.generate({ systemInstruction: '', messages: [], egress: egress() }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProviderRequestError && error.category === 'rate_limited',
    );
  });
});

describe('streaming', () => {
  it('reads repeated response envelopes with no terminating sentinel', async () => {
    const frames = [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"lo"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"browser_click","args":{"elementId":"e1"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2}}\n\n',
    ];
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(
        (init.method ?? 'GET').toUpperCase() === 'GET'
          ? jsonResponse(MODEL_DESCRIPTOR)
          : sseResponse(frames),
      ),
    );
    const adapter = await connected(fetchMock);

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
    expect(done.response.toolCalls[0]!.arguments).toEqual({ elementId: 'e1' });
    expect(done.response.usage).toEqual({ promptTokens: 4, completionTokens: 2 });
    // The operation is a path suffix, and the framing is requested with alt=sse.
    expect(posts(fetchMock)[0]!.url).toContain(':streamGenerateContent?alt=sse');
  });

  it('ends the stream on an error envelope rather than reporting a completed turn', async () => {
    const frames = [
      'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n',
      'data: {"error":{"code":503,"status":"UNAVAILABLE","message":"busy"}}\n\n',
    ];
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(
        (init.method ?? 'GET').toUpperCase() === 'GET'
          ? jsonResponse(MODEL_DESCRIPTOR)
          : sseResponse(frames),
      ),
    );
    const adapter = await connected(fetchMock);

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
});

describe('capability discovery', () => {
  it('reads supported methods and token limits from the endpoint', async () => {
    const fetchMock = routed(() => okResponse());
    const adapter = await connected(fetchMock);
    const capabilities = await adapter.getCapabilities('gemini-test-model');

    expect(capabilities.text).toBe(true);
    expect(capabilities.streaming).toBe(true);
    expect(capabilities.contextWindow).toBe(32_000);
    expect(capabilities.maxOutputTokens).toBe(8_192);
  });

  it('reports streaming as unavailable when the endpoint does not list it', async () => {
    // The honest outcome: the doctor and the capability guard both read this,
    // so a model that cannot stream is refused rather than silently degraded.
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({ ...MODEL_DESCRIPTOR, supportedGenerationMethods: ['generateContent'] }),
      ),
    );
    const adapter = await connected(fetchMock);
    const capabilities = await adapter.getCapabilities('gemini-test-model');
    expect(capabilities.streaming).toBe(false);
  });

  it('falls back to conservative defaults when discovery fails', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({}, 500)));
    const adapter = await connected(fetchMock);
    const capabilities = await adapter.getCapabilities('gemini-test-model');
    expect(capabilities.text).toBe(true);
    expect(capabilities.contextWindow).toBeNull();
  });

  it('caches discovery so it does not run before every turn', async () => {
    const fetchMock = routed(() => okResponse());
    const adapter = await connected(fetchMock);
    await adapter.getCapabilities('gemini-test-model');
    const afterFirst = fetchMock.mock.calls.length;
    await adapter.getCapabilities('gemini-test-model');
    expect(fetchMock.mock.calls.length).toBe(afterFirst);
  });

  it('lists only models that can actually generate content', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          models: [
            MODEL_DESCRIPTOR,
            {
              name: 'models/text-embedding-004',
              displayName: 'Embeddings',
              supportedGenerationMethods: ['embedContent'],
            },
          ],
        }),
      ),
    );
    const adapter = await connected(fetchMock);
    const models = await adapter.listModels();
    expect(models.map((m) => m.id)).toEqual(['gemini-test-model']);
  });
});

describe('error mapping', () => {
  it('prefers the status enum over the HTTP code', async () => {
    // This endpoint reports several distinct conditions as 400, and only the
    // enum tells a rejected key apart from a malformed request.
    const fetchMock = routed(() =>
      jsonResponse({ error: { code: 400, message: 'bad key', status: 'UNAUTHENTICATED' } }, 400),
    );
    const adapter = await connected(fetchMock);

    await expect(
      adapter.generate({ systemInstruction: '', messages: [], egress: egress() }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProviderRequestError &&
        error.category === 'authentication_failed' &&
        error.providerCode === 'UNAUTHENTICATED',
    );
  });

  it('treats UNAVAILABLE as a wait rather than a server fault', async () => {
    const fetchMock = routed(() =>
      jsonResponse({ error: { code: 503, status: 'UNAVAILABLE' } }, 503),
    );
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

  it('never puts the key in a user-facing error', async () => {
    const fetchMock = routed(() => new Response(`rejected ${CONFIG.apiKey}`, { status: 401 }));
    const adapter = await connected(fetchMock);
    const error = await adapter
      .generate({ systemInstruction: '', messages: [], egress: egress() })
      .then(
        () => null,
        (e: unknown) => e as ProviderRequestError,
      );
    expect(error!.agentError.userMessage).not.toContain(CONFIG.apiKey);
    expect(error!.message).not.toContain(CONFIG.apiKey);
  });
});

describe('factory', () => {
  it('declares an API provider with a default endpoint', () => {
    expect(geminiFactory.kind).toBe('api');
    expect(geminiFactory.authKind).toBe('api_key');
    expect(geminiFactory.baseUrl).toEqual({
      required: false,
      defaultUrl: GEMINI_DEFAULT_BASE_URL,
    });
    expect(geminiFactory.requiresGuardedTransport).toBe(true);
  });
});
