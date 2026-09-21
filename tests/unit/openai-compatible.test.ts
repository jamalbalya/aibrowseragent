/**
 * TEST-PROVIDER-001 — OpenAI-compatible adapter (REQ-PROVIDER-001).
 *
 * Exercises the wire translation both ways against a stubbed fetch, so the
 * canonical format stays isolated from provider specifics.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  OpenAICompatibleAdapter,
  ProviderRequestError,
  readServerSentEvents,
} from '@/providers/adapters/openai-compatible';
import type { CanonicalEvent } from '@/providers/core/types';
import { passthroughTransport, testEgressContext } from '../fixtures/egress';

const CONFIG = {
  providerId: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-' + 'test-abcdefghijklmnopqrstuvwxyz',
  model: 'test-model',
};

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

describe('connect', () => {
  it('requires a base URL and an API key', async () => {
    const adapter = new OpenAICompatibleAdapter(passthroughTransport(vi.fn()));
    expect((await adapter.connect({ providerId: 'x' })).authenticated).toBe(false);
    expect(
      (await adapter.connect({ providerId: 'x', baseUrl: 'https://a.test' })).authenticated,
    ).toBe(false);
  });

  it('refuses a non-https base URL so a key is never sent in the clear', async () => {
    const adapter = new OpenAICompatibleAdapter(passthroughTransport(vi.fn()));
    const result = await adapter.connect({ ...CONFIG, baseUrl: 'http://api.example.com/v1' });
    expect(result.authenticated).toBe(false);
    expect(result.error?.userMessage).toContain('https');
  });

  it('allows http on localhost for a local model server', async () => {
    const adapter = new OpenAICompatibleAdapter(passthroughTransport(vi.fn()));
    const result = await adapter.connect({ ...CONFIG, baseUrl: 'http://localhost:11434/v1' });
    expect(result.authenticated).toBe(true);
  });

  it('reports only a masked key suffix as the account label', async () => {
    const adapter = new OpenAICompatibleAdapter(passthroughTransport(vi.fn()));
    const result = await adapter.connect(CONFIG);
    expect(result.accountLabel).toContain('api.example.com');
    expect(result.accountLabel).not.toContain('sk-' + 'test-abcdefghijklmnop');
  });

  it('does not label a third-party endpoint as OpenAI', () => {
    const adapter = new OpenAICompatibleAdapter(passthroughTransport(vi.fn()));
    expect(adapter.displayName).toBe('OpenAI-compatible endpoint');
  });

  it('throws when used before connecting rather than guessing a default', async () => {
    const adapter = new OpenAICompatibleAdapter(passthroughTransport(vi.fn()));
    await expect(adapter.listModels()).rejects.toThrow(/not connected/);
  });
});

describe('generate', () => {
  it('sends the system instruction and messages in the wire format', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }),
      );
    const adapter = new OpenAICompatibleAdapter(passthroughTransport(fetchMock));
    await adapter.connect(CONFIG);

    await adapter.generate({
      egress: testEgressContext(),
      systemInstruction: 'You are a browser agent.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('test-model');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a browser agent.' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hello' });
    expect(init.headers.Authorization).toBe(`Bearer ${CONFIG.apiKey}`);
  });

  it('parses a tool call into the canonical form', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'browser_click', arguments: '{"elementId":"e3"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      }),
    );
    const adapter = new OpenAICompatibleAdapter(passthroughTransport(fetchMock));
    await adapter.connect(CONFIG);

    const response = await adapter.generate({
      egress: testEgressContext(),
      systemInstruction: 's',
      messages: [],
    });

    expect(response.finishReason).toBe('tool_call');
    expect(response.toolCalls[0]).toEqual({
      toolCallId: 'call_1',
      name: 'browser_click',
      arguments: { elementId: 'e3' },
    });
    expect(response.usage).toEqual({ promptTokens: 12, completionTokens: 4 });
  });

  it('reports malformed tool arguments instead of throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{not json' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    const adapter = new OpenAICompatibleAdapter(passthroughTransport(fetchMock));
    await adapter.connect(CONFIG);

    const response = await adapter.generate({
      egress: testEgressContext(),
      systemInstruction: 's',
      messages: [],
    });
    expect(response.toolCalls[0]?.parseError).toBeDefined();
    expect(response.toolCalls[0]?.arguments).toEqual({});
  });

  it('rejects tool arguments that are valid JSON but not an object', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [
          { message: { tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '[1,2]' } }] } },
        ],
      }),
    );
    const adapter = new OpenAICompatibleAdapter(passthroughTransport(fetchMock));
    await adapter.connect(CONFIG);
    const response = await adapter.generate({
      egress: testEgressContext(),
      systemInstruction: 's',
      messages: [],
    });
    expect(response.toolCalls[0]?.parseError).toContain('object');
  });

  it('expands tool results into separate role:tool wire messages', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: {} }] }));
    const adapter = new OpenAICompatibleAdapter(passthroughTransport(fetchMock));
    await adapter.connect(CONFIG);

    await adapter.generate({
      egress: testEgressContext(),
      systemInstruction: 's',
      messages: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'c1',
              name: 'a',
              content: '{"ok":1}',
              isError: false,
            },
            {
              type: 'tool_result',
              toolCallId: 'c2',
              name: 'b',
              content: '{"ok":2}',
              isError: false,
            },
          ],
        },
      ],
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"ok":1}' });
    expect(body.messages[2].tool_call_id).toBe('c2');
  });

  it('encodes an image part as a data URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: {} }] }));
    const adapter = new OpenAICompatibleAdapter(passthroughTransport(fetchMock));
    await adapter.connect(CONFIG);

    await adapter.generate({
      egress: testEgressContext(),
      systemInstruction: 's',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          ],
        },
      ],
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.messages[1].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' },
    });
  });

  it('translates canonical tools into the function schema', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: {} }] }));
    const adapter = new OpenAICompatibleAdapter(passthroughTransport(fetchMock));
    await adapter.connect(CONFIG);

    await adapter.generate({
      egress: testEgressContext(),
      systemInstruction: 's',
      messages: [],
      tools: [
        {
          type: 'function',
          name: 'browser_click',
          description: 'Click.',
          parameters: { type: 'object', properties: {} },
        },
      ],
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.tools[0].function.name).toBe('browser_click');
    expect(body.tool_choice).toBe('auto');
  });
});

describe('HTTP error mapping', () => {
  const cases: [number, string][] = [
    [401, 'AUTH_EXPIRED'],
    [403, 'AUTH_EXPIRED'],
    [404, 'MODEL_UNSUPPORTED'],
    [429, 'RATE_LIMITED'],
    [500, 'MODEL_ERROR'],
    [400, 'MODEL_ERROR'],
  ];

  for (const [status, code] of cases) {
    it(`maps ${status} to ${code}`, async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"x"}', { status }));
      const adapter = new OpenAICompatibleAdapter(passthroughTransport(fetchMock));
      await adapter.connect(CONFIG);

      await expect(
        adapter.generate({ egress: testEgressContext(), systemInstruction: 's', messages: [] }),
      ).rejects.toSatisfy(
        (error: unknown) => error instanceof ProviderRequestError && error.agentError.code === code,
      );
    });
  }

  it('marks a 5xx as retryable and a 400 as not', async () => {
    const make = async (status: number) => {
      const adapter = new OpenAICompatibleAdapter(
        passthroughTransport(vi.fn().mockResolvedValue(new Response('{}', { status }))),
      );
      await adapter.connect(CONFIG);
      try {
        await adapter.generate({
          egress: testEgressContext(),
          systemInstruction: 's',
          messages: [],
        });
        return null;
      } catch (error) {
        return (error as ProviderRequestError).agentError;
      }
    };
    expect((await make(503))?.retryable).toBe(true);
    expect((await make(400))?.retryable).toBe(false);
  });

  it('maps a network failure to NETWORK_ERROR without leaking the raw message', async () => {
    const adapter = new OpenAICompatibleAdapter(
      passthroughTransport(vi.fn().mockRejectedValue(new Error('ECONNREFUSED 10.0.0.5:443'))),
    );
    await adapter.connect(CONFIG);

    try {
      await adapter.generate({ egress: testEgressContext(), systemInstruction: 's', messages: [] });
      expect.unreachable();
    } catch (error) {
      const agentError = (error as ProviderRequestError).agentError;
      expect(agentError.code).toBe('NETWORK_ERROR');
      expect(agentError.userMessage).not.toContain('10.0.0.5');
    }
  });
});

describe('streaming', () => {
  it('reassembles text deltas and tool call fragments', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"browser_click","arguments":"{\\"elem"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"entId\\":\\"e1\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ];
    const adapter = new OpenAICompatibleAdapter(
      passthroughTransport(vi.fn().mockResolvedValue(sseResponse(frames))),
    );
    await adapter.connect(CONFIG);

    const events: CanonicalEvent[] = [];
    for await (const event of adapter.stream({
      egress: testEgressContext(),
      systemInstruction: 's',
      messages: [],
    })) {
      events.push(event);
    }

    const text = events
      .filter((e): e is Extract<CanonicalEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('Hello');

    const done = events.find(
      (e): e is Extract<CanonicalEvent, { type: 'done' }> => e.type === 'done',
    );
    expect(done?.response.toolCalls[0]).toEqual({
      toolCallId: 'c1',
      name: 'browser_click',
      arguments: { elementId: 'e1' },
    });
    expect(done?.response.usage).toEqual({ promptTokens: 5, completionTokens: 3 });
  });

  it('skips a malformed frame instead of killing the stream', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: {broken\n\n',
      'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const adapter = new OpenAICompatibleAdapter(
      passthroughTransport(vi.fn().mockResolvedValue(sseResponse(frames))),
    );
    await adapter.connect(CONFIG);

    const deltas: string[] = [];
    for await (const event of adapter.stream({
      egress: testEgressContext(),
      systemInstruction: 's',
      messages: [],
    })) {
      if (event.type === 'text_delta') deltas.push(event.delta);
    }
    expect(deltas.join('')).toBe('ab');
  });

  it('yields an error event instead of throwing on an HTTP failure', async () => {
    const adapter = new OpenAICompatibleAdapter(
      passthroughTransport(vi.fn().mockResolvedValue(new Response('{}', { status: 401 }))),
    );
    await adapter.connect(CONFIG);

    const events: CanonicalEvent[] = [];
    for await (const event of adapter.stream({
      egress: testEgressContext(),
      systemInstruction: 's',
      messages: [],
    })) {
      events.push(event);
    }
    expect(events[0]?.type).toBe('error');
  });
});

describe('readServerSentEvents', () => {
  const collect = async (chunks: string[]): Promise<string[]> => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const data of readServerSentEvents(stream)) out.push(data);
    return out;
  };

  it('handles a frame split across chunk boundaries', async () => {
    expect(await collect(['data: {"a"', ':1}\n\n'])).toEqual(['{"a":1}']);
  });

  it('handles CRLF frame separators', async () => {
    expect(await collect(['data: one\r\n\r\ndata: two\r\n\r\n'])).toEqual(['one', 'two']);
  });

  it('emits a trailing frame that was not terminated by a blank line', async () => {
    expect(await collect(['data: last'])).toEqual(['last']);
  });

  it('ignores comment and event lines', async () => {
    expect(await collect([': keepalive\n\nevent: ping\ndata: real\n\n'])).toEqual(['real']);
  });
});
