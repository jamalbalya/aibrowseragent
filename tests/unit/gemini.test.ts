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
  retryDelayFromDetails,
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
  it('requires an API key, and accepts a connection with no model yet', async () => {
    // **The second half of this used to assert the opposite, and it was
    // wrong.** `connect` refused a credential with no model, which made the
    // product's own journey impossible: connect, ask what this credential can
    // see, then choose. A user had to know a model id before they could
    // discover what the ids were — and on Gemini the obvious guesses are
    // models Google has retired.
    //
    // It also made the pasted-key path disagree with the Google authorization
    // path, which has always produced an account with `modelId: null` and left
    // `resolveBrainAccount` to refuse until one is chosen.
    //
    // A key is still required, because there is nothing to validate without
    // one. The model requirement moved to the operations that use a model;
    // the case below is that.
    const adapter = new GeminiAdapter(passthroughTransport(vi.fn()));
    expect((await adapter.connect({ providerId: 'gemini' })).authenticated).toBe(false);
    expect((await adapter.connect({ providerId: 'gemini', apiKey: 'k' })).authenticated).toBe(true);
  });

  it('refuses the operation, not the connection, when no model was chosen', async () => {
    // Where the requirement belongs: a request that needs a model is refused
    // before anything is sent, rather than a malformed one reaching the vendor
    // or a connection being withheld from somebody who has not chosen yet.
    const adapter = new GeminiAdapter(passthroughTransport(vi.fn()));
    await adapter.connect({ providerId: 'gemini', apiKey: 'k' });
    await expect(
      adapter.generate({ systemInstruction: '', messages: [], egress: egress() }),
    ).rejects.toSatisfy((error: unknown) => {
      const shown = (error as ProviderRequestError).failure.error;
      expect(shown.code).toBe('INVALID_ARGUMENT');
      expect(shown.userMessage).toMatch(/choose a model/i);
      return true;
    });
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

  it('does not report streaming as unavailable merely because it is unlisted', async () => {
    // **This test asserted the opposite, and it was wrong.** It read a missing
    // `streamGenerateContent` as proof that the model cannot stream, which was
    // a reasonable reading of a field that used to carry it.
    //
    // It does not any more. Live, `GET /v1beta/models` reports
    //   ['generateContent','countTokens','createCachedContent','batchGenerateContent']
    // for gemini-flash-latest, while `POST …:streamGenerateContent?alt=sse`
    // answers 200 with SSE frames. So the old assertion made this adapter
    // advertise `streaming: false` for every current Gemini model, the
    // capability guard refused the request, and the capability doctor's
    // streaming probe could never run — the one mechanism that would have
    // caught it was the mechanism it disabled.
    //
    // The absence is now no evidence either way, and the doctor's real probe
    // is what settles it. See `capabilitiesFromModel`.
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({ ...MODEL_DESCRIPTOR, supportedGenerationMethods: ['generateContent'] }),
      ),
    );
    const adapter = await connected(fetchMock);
    const capabilities = await adapter.getCapabilities('gemini-test-model');
    expect(capabilities.streaming).toBe(true);
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

describe('what live Gemini refused, and what it served anyway', () => {
  /**
   * Three defects that only a real endpoint could show, each pinned here
   * against the exact evidence that found it.
   */

  it('sends no schema field Google’s Schema type does not have', async () => {
    // The defect: `functionDeclarations[].parameters` is Google's `Schema`
    // message parsed by protobuf JSON, which **rejects** an unknown field
    // rather than ignoring it. A canonical tool schema declaring
    // `additionalProperties: false` — ordinary JSON Schema, accepted by every
    // other provider here, and declared by the capability doctor's own probe
    // tool — got the whole request refused with
    //   400 Unknown name "additionalProperties" … Cannot find field.
    // So Gemini tool calling failed every time, the doctor reported
    // CHAT_ONLY, and the browser agent could not run on Gemini at all.
    let sent = '';
    const adapter = new GeminiAdapter(
      passthroughTransport(
        vi.fn((_url: string, init: RequestInit) => {
          sent = typeof init.body === 'string' ? init.body : '';
          return Promise.resolve(okResponse());
        }) as unknown as typeof fetch,
      ),
    );
    await adapter.connect(CONFIG);
    await adapter.generate({
      systemInstruction: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      egress: egress(),
      tools: [
        {
          type: 'function',
          name: 'probe',
          description: 'A tool whose schema uses ordinary JSON Schema.',
          parameters: {
            type: 'object',
            $schema: 'http://json-schema.org/draft-07/schema#',
            additionalProperties: false,
            title: 'Probe args',
            properties: {
              status: { type: 'string', description: 'why', const: 'ok', examples: ['ok'] },
              nested: {
                type: 'object',
                additionalProperties: false,
                properties: { deep: { type: 'string', const: 'x' } },
              },
              list: { type: 'array', items: { type: 'string', examples: ['a'] } },
              either: { anyOf: [{ type: 'string', const: 'a' }, { type: 'number' }] },
            },
            required: ['status'],
          },
        },
      ],
    });

    const body = JSON.parse(sent) as {
      tools: { functionDeclarations: { parameters: unknown }[] }[];
    };
    const parameters = JSON.stringify(body.tools[0]!.functionDeclarations[0]!.parameters);
    // Every one of these was rejected by name, live, on gemini-flash-latest.
    for (const rejected of ['additionalProperties', '$schema', 'const', 'examples']) {
      expect(parameters, `${rejected} must not be sent`).not.toContain(rejected);
    }
    // Nested, in a list item and inside anyOf — a rejected field three levels
    // down refuses the request just as completely as one at the top.
    expect(parameters).not.toContain('"x"');
    // And the fields the type does have are still there.
    for (const kept of ['title', 'properties', 'required', 'description', 'items', 'anyOf']) {
      expect(parameters, `${kept} must survive`).toContain(kept);
    }
  });

  it('maps a nullable JSON Schema type onto Google’s spelling of it', async () => {
    let sent = '';
    const adapter = new GeminiAdapter(
      passthroughTransport(
        vi.fn((_url: string, init: RequestInit) => {
          sent = typeof init.body === 'string' ? init.body : '';
          return Promise.resolve(okResponse());
        }) as unknown as typeof fetch,
      ),
    );
    await adapter.connect(CONFIG);
    await adapter.generate({
      systemInstruction: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      egress: egress(),
      tools: [
        {
          type: 'function',
          name: 'probe',
          description: 'd',
          parameters: {
            type: 'object',
            properties: { maybe: { type: ['string', 'null'] } },
          },
        },
      ],
    });
    const body = JSON.parse(sent) as {
      tools: { functionDeclarations: { parameters: { properties: Record<string, unknown> } }[] }[];
    };
    expect(body.tools[0]!.functionDeclarations[0]!.parameters.properties.maybe).toEqual({
      type: 'string',
      nullable: true,
    });
  });

  it('does not deny streaming because the model list stopped mentioning it', async () => {
    // Live, `GET /v1beta/models` reports
    //   ['generateContent','countTokens','createCachedContent','batchGenerateContent']
    // for gemini-flash-latest — no `streamGenerateContent` — while
    // `POST …:streamGenerateContent?alt=sse` answers 200 with SSE frames.
    //
    // Reading that absence as a denial made this adapter advertise
    // `streaming: false` for every Gemini model. The capability guard then
    // refused the request, so the doctor's streaming probe could never run:
    // the one mechanism that would have caught the mistake was the mechanism
    // the mistake disabled.
    const adapter = new GeminiAdapter(
      passthroughTransport(
        vi.fn(() =>
          Promise.resolve(
            jsonResponse({
              models: [
                {
                  name: 'models/gemini-flash-latest',
                  supportedGenerationMethods: [
                    'generateContent',
                    'countTokens',
                    'createCachedContent',
                    'batchGenerateContent',
                  ],
                },
              ],
            }),
          ),
        ),
      ),
    );
    await adapter.connect({ ...CONFIG, model: 'gemini-flash-latest' });
    const capabilities = await adapter.getCapabilities('gemini-flash-latest');
    expect(capabilities.text).toBe(true);
    expect(capabilities.streaming).toBe(true);
  });

  it('actually streams on such a model, which is the behaviour the flag gates', async () => {
    // The sibling test above asserts `capabilities.streaming === true`, which
    // is a flag. The thing a user experiences is whether the agent can stream
    // at all — and the flag's only job is to let the request through the
    // capability guard. Before the fix the guard refused, so `stream()` yielded
    // an error event instead of content and no probe could ever correct it.
    //
    // So this asserts the end of the chain rather than its beginning: real SSE
    // frames out of `stream()`, on a model whose `/models` entry does not
    // mention streaming.
    let streamed = '';
    const adapter = new GeminiAdapter(
      passthroughTransport(
        vi.fn((url: string) =>
          Promise.resolve(
            url.includes(':streamGenerateContent')
              ? sseResponse([
                  `data: ${JSON.stringify({
                    candidates: [{ content: { role: 'model', parts: [{ text: 'one two' }] } }],
                  })}\n\n`,
                  `data: ${JSON.stringify({
                    candidates: [{ finishReason: 'STOP' }],
                    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
                  })}\n\n`,
                ])
              : jsonResponse({
                  ...MODEL_DESCRIPTOR,
                  supportedGenerationMethods: ['generateContent', 'countTokens'],
                }),
          ),
        ) as typeof fetch,
      ),
    );
    await adapter.connect(CONFIG);
    // The measurement the doctor would hand back, read from the same list.
    const measured = await adapter.getCapabilities('gemini-test-model');
    await adapter.connect({ ...CONFIG, measuredCapabilities: measured });

    const events: CanonicalEvent[] = [];
    for await (const event of adapter.stream({
      systemInstruction: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'count' }] }],
      egress: egress(),
    })) {
      events.push(event);
      if (event.type === 'text_delta') streamed += event.delta;
    }

    // No refusal, and real content: the guard let it through.
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(streamed).toBe('one two');
    expect(events.at(-1)?.type).toBe('done');
  });

  it('still denies both when the model is not a generative one', async () => {
    // The control: the fix must not turn streaming on for everything. An
    // embedding model reports neither.
    const adapter = new GeminiAdapter(
      passthroughTransport(
        vi.fn(() =>
          Promise.resolve(
            jsonResponse({
              models: [
                { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
              ],
            }),
          ),
        ),
      ),
    );
    await adapter.connect({ ...CONFIG, model: 'text-embedding-004' });
    const capabilities = await adapter.getCapabilities('text-embedding-004');
    expect(capabilities.text).toBe(false);
    expect(capabilities.streaming).toBe(false);
  });

  it('tells a user whose model is listed but retired to pick another one', async () => {
    // Live, Google's `/v1beta/models` offers gemini-2.5-flash, gemini-2.5-pro
    // and gemini-2.5-flash-lite as its first three generative entries, and a
    // generateContent call on each answers 404 "no longer available to new
    // users". The shared NOT_FOUND sentence — "Check it against the model
    // list" — was therefore shown in the one case where checking the list
    // confirms the user was right and leaves them believing this extension is
    // broken.
    const adapter = new GeminiAdapter(
      passthroughTransport(
        vi.fn(() =>
          Promise.resolve(
            jsonResponse(
              {
                error: {
                  code: 404,
                  status: 'NOT_FOUND',
                  message:
                    'This model models/gemini-2.5-flash is no longer available to new users. ' +
                    'Please update your code to use models/gemini-3.8-flash.',
                },
              },
              404,
            ),
          ),
        ),
      ),
    );
    await adapter.connect({ ...CONFIG, model: 'gemini-2.5-flash' });
    await expect(
      adapter.generate({
        systemInstruction: '',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        egress: egress(),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const shown = (error as ProviderRequestError).failure.error.userMessage ?? '';
      expect(shown).not.toMatch(/check it against the model list/i);
      expect(shown).toMatch(/retired/i);
      expect(shown).toMatch(/choose a different model/i);
      return true;
    });
  });

  it('still sends a misspelled id to the model list', async () => {
    // The control, and the reason the retired case had to be separated rather
    // than the sentence simply reworded: a 404 that is *not* about retirement
    // is a wrong id, and the model list is exactly where to look.
    const adapter = new GeminiAdapter(
      passthroughTransport(
        vi.fn(() =>
          Promise.resolve(
            jsonResponse(
              { error: { code: 404, status: 'NOT_FOUND', message: 'models/nope is not found.' } },
              404,
            ),
          ),
        ),
      ),
    );
    await adapter.connect({ ...CONFIG, model: 'nope' });
    await expect(
      adapter.generate({
        systemInstruction: '',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        egress: egress(),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const shown = (error as ProviderRequestError).failure.error.userMessage ?? '';
      expect(shown).toMatch(/check it against the model list/i);
      return true;
    });
  });
});

describe('the thought signature Google requires back', () => {
  it('parses it from a functionCall part and sends it back beside the call', async () => {
    // Live, `gemini-flash-lite-latest` returns a `functionCall` part with a
    // sibling `thoughtSignature`, and the turn that sends the tool result back
    // is refused without it:
    //   400 Function call is missing a thought_signature in functionCall parts.
    // So a conversation could make exactly one tool call and then died.
    const bodies: string[] = [];
    const adapter = new GeminiAdapter(
      passthroughTransport(
        vi.fn((_url: string, init: RequestInit) => {
          if (typeof init.body === 'string') bodies.push(init.body);
          return Promise.resolve(
            okResponse([
              {
                functionCall: { name: 'get_temperature', args: { city: 'Jakarta' } },
                thoughtSignature: 'opaque-signature-under-test',
              },
            ]),
          );
        }) as typeof fetch,
      ),
    );
    await adapter.connect(CONFIG);

    const first = await adapter.generate({
      systemInstruction: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      egress: egress(),
    });

    // Parsed onto the canonical call, not discarded.
    expect(first.toolCalls[0]?.providerSignature).toBe('opaque-signature-under-test');

    // And sent back as a **sibling** of `functionCall`, not inside it: Google
    // rejects an unknown field inside the call.
    await adapter.generate({
      systemInstruction: '',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ ...first.toolCalls[0]!, type: 'tool_call' }] },
      ],
      egress: egress(),
    });

    const sent = JSON.parse(bodies.at(-1)!) as {
      contents: { parts: Record<string, unknown>[] }[];
    };
    const part = sent.contents[1]!.parts[0]!;
    expect(part.thoughtSignature).toBe('opaque-signature-under-test');
    expect(part.functionCall).toMatchObject({ name: 'get_temperature' });
    expect(Object.keys(part.functionCall as object)).not.toContain('thoughtSignature');
  });

  it('keeps it through a stream, where the part is accumulated rather than mapped', async () => {
    // The streaming path held only `part.functionCall`, so the sibling field
    // was thrown away there even after the non-streaming path was fixed.
    const adapter = new GeminiAdapter(
      passthroughTransport(
        vi.fn(() =>
          Promise.resolve(
            sseResponse([
              `data: ${JSON.stringify({
                candidates: [
                  {
                    content: {
                      role: 'model',
                      parts: [
                        {
                          functionCall: { name: 'get_temperature', args: { city: 'Jakarta' } },
                          thoughtSignature: 'streamed-signature',
                        },
                      ],
                    },
                    finishReason: 'STOP',
                  },
                ],
              })}\n\n`,
            ]),
          ),
        ),
      ),
    );
    await adapter.connect(CONFIG);

    const events: CanonicalEvent[] = [];
    for await (const event of adapter.stream({
      systemInstruction: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      egress: egress(),
    })) {
      events.push(event);
    }
    const done = events.find((event) => event.type === 'done');
    expect(done?.type === 'done' && done.response.toolCalls[0]?.providerSignature).toBe(
      'streamed-signature',
    );
  });

  it('sends no signature field at all when the provider issued none', async () => {
    // The control, and it matters on the wire: a `thoughtSignature: undefined`
    // serialises to nothing in JSON but an empty string would not, and Google
    // rejects what it does not expect.
    const bodies: string[] = [];
    const adapter = new GeminiAdapter(
      passthroughTransport(
        vi.fn((_url: string, init: RequestInit) => {
          if (typeof init.body === 'string') bodies.push(init.body);
          return Promise.resolve(okResponse());
        }) as typeof fetch,
      ),
    );
    await adapter.connect(CONFIG);
    await adapter.generate({
      systemInstruction: '',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_call', toolCallId: 'x', name: 'f', arguments: {} }],
        },
      ],
      egress: egress(),
    });
    expect(bodies.at(-1)).not.toContain('thoughtSignature');
  });
});

describe('the retry guidance Google does not put in a header', () => {
  /**
   * Measured against the live free tier: the sixteenth request in a minute is
   * refused, the `Retry-After` header is **absent**, and the wait is in the
   * body as a `google.rpc.RetryInfo`. The retry policy had just been taught to
   * prefer server guidance over its own backoff, and for Gemini it would never
   * have seen any.
   */
  const LIVE_BODY = {
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: 'You exceeded your current quota.',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [
            {
              quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
              quotaValue: '15',
            },
          ],
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '11s' },
      ],
    },
  };

  it('reads the wait from the body Google actually sends', () => {
    expect(retryDelayFromDetails(LIVE_BODY.error)).toBe(11_000);
  });

  it('accepts a fractional duration and rejects anything that is not one', () => {
    const info = (retryDelay: unknown) => ({
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }],
    });
    expect(retryDelayFromDetails(info('1.5s'))).toBe(1500);
    expect(retryDelayFromDetails(info('0.100s'))).toBe(100);
    expect(retryDelayFromDetails(info('0s'))).toBe(0);
    // An error body is attacker-influenceable in general, so anything that is
    // not a plain duration is no guidance rather than a coerced number.
    for (const bad of ['11', '11 s', '-5s', 'eleven seconds', '1e3s', '', 11, null, {}]) {
      expect(retryDelayFromDetails(info(bad)), JSON.stringify(bad)).toBeUndefined();
    }
    expect(retryDelayFromDetails({ details: 'not-an-array' })).toBeUndefined();
    expect(retryDelayFromDetails({})).toBeUndefined();
    expect(retryDelayFromDetails(null)).toBeUndefined();
  });

  it('ignores a detail entry that is not RetryInfo', () => {
    // QuotaFailure arrives alongside it and has no retryDelay; a reader that
    // took the first entry would find nothing and conclude there was nothing.
    expect(
      retryDelayFromDetails({
        details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [] },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' },
        ],
      }),
    ).toBe(7000);
  });

  it('carries that wait onto the failure, so the retry policy can honour it', async () => {
    // The end the fix exists for: `decideRetryFor` prefers a stated wait over
    // its own 8-second backoff, and this is the only path by which a stated
    // wait reaches it from Google.
    const adapter = new GeminiAdapter(
      passthroughTransport(vi.fn(() => Promise.resolve(jsonResponse(LIVE_BODY, 429)))),
    );
    await adapter.connect(CONFIG);
    await expect(
      adapter.generate({
        systemInstruction: '',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        egress: egress(),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const failure = (error as ProviderRequestError).failure;
      expect(failure.error.code).toBe('RATE_LIMITED');
      expect(failure.retryAfterMs).toBe(11_000);
      // And the sentence quotes it, rather than saying "try again shortly".
      expect(failure.error.userMessage).toMatch(/11s/);
      return true;
    });
  });
});
