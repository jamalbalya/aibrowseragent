/**
 * A real HTTP server speaking the Anthropic and Gemini wire protocols.
 *
 * REAL BROWSER + MOCKED PROVIDER TRANSPORT. This is not a commercial
 * provider, and nothing exercised against it is evidence that one has been
 * reached. What it does prove is the part a stubbed `fetch` cannot: that the
 * extension's service worker can actually carry these two protocols over
 * sockets — real headers, real CORS preflight, real SSE framing — rather than
 * only translating them correctly in memory.
 *
 * Both protocols are served from one process, under separate path prefixes,
 * so a test can switch a task between them without coordinating two servers.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ScriptedToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export type NativeReply =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool_calls'; readonly calls: readonly ScriptedToolCall[] }
  | { readonly kind: 'http_error'; readonly status: number };

export interface RecordedRequest {
  readonly path: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface NativeProviders {
  /** Base URL for the Anthropic adapter. */
  readonly anthropicBaseUrl: string;
  /** Base URL for the Gemini adapter. */
  readonly geminiBaseUrl: string;
  readonly requests: readonly RecordedRequest[];
  script(replies: readonly NativeReply[]): void;
  setToolCallingSupported(supported: boolean): void;
  reset(): void;
  close(): Promise<void>;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

const ANTHROPIC_MODELS = ['mock-claude'];
const GEMINI_MODELS = ['mock-gemini'];

interface AnthropicBody {
  readonly system?: string;
  readonly stream?: boolean;
  readonly tools?: { name?: string }[];
  readonly messages?: { role?: string; content?: unknown }[];
}

interface GeminiBody {
  readonly systemInstruction?: { parts?: { text?: string }[] };
  readonly tools?: { functionDeclarations?: { name?: string }[] }[];
  readonly contents?: { role?: string; parts?: { text?: string }[] }[];
}

/**
 * Recognises the capability doctor's probes.
 *
 * The doctor is infrastructure every test has to get past, so the server
 * answers its probes itself and a test's script describes only the agent
 * turns it is actually about.
 */
function doctorProbe(
  lastUserText: string,
  probesTools: boolean,
  toolCallingSupported: boolean,
): NativeReply | null {
  if (probesTools) {
    return toolCallingSupported
      ? { kind: 'tool_calls', calls: [{ name: 'capability_probe', arguments: { status: 'ok' } }] }
      : { kind: 'text', text: 'I would call that function.' };
  }
  if (lastUserText.includes('JSON object')) return { kind: 'text', text: '{"ok":true}' };
  if (lastUserText.includes('single word: ready')) return { kind: 'text', text: 'ready' };
  if (lastUserText.startsWith('Count:')) return { kind: 'text', text: 'one two three' };
  if (lastUserText.includes('received an image')) return { kind: 'text', text: 'seen' };
  if (lastUserText === 'ping') return { kind: 'text', text: 'pong' };
  return null;
}

// --- Anthropic shapes --------------------------------------------------------

function anthropicMessage(reply: NativeReply): Record<string, unknown> {
  const content =
    reply.kind === 'tool_calls'
      ? reply.calls.map((call, index) => ({
          type: 'tool_use',
          id: `toolu_${index}`,
          name: call.name,
          input: call.arguments,
        }))
      : [{ type: 'text', text: reply.kind === 'text' ? reply.text : '' }];

  return {
    id: 'msg_mock',
    type: 'message',
    role: 'assistant',
    model: 'mock-claude',
    content,
    stop_reason: reply.kind === 'tool_calls' ? 'tool_use' : 'end_turn',
    usage: { input_tokens: 20, output_tokens: 8 },
  };
}

/** Typed SSE events, with tool input split mid-token like a real provider. */
function anthropicFrames(reply: NativeReply): string[] {
  const frames = [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 20 } } })}\n\n`,
  ];

  if (reply.kind === 'tool_calls') {
    reply.calls.forEach((call, index) => {
      const args = JSON.stringify(call.arguments);
      const half = Math.ceil(args.length / 2);
      frames.push(
        `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${index}`, name: call.name, input: {} } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: args.slice(0, half) } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: args.slice(half) } })}\n\n`,
      );
    });
    frames.push(
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } })}\n\n`,
    );
  } else {
    const text = reply.kind === 'text' ? reply.text : '';
    frames.push(
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    );
    text.split(' ').forEach((word, i) => {
      frames.push(
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: i === 0 ? word : ` ${word}` } })}\n\n`,
      );
    });
    frames.push(
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } })}\n\n`,
    );
  }

  frames.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  return frames;
}

// --- Gemini shapes -----------------------------------------------------------

function geminiResponse(reply: NativeReply): Record<string, unknown> {
  const parts =
    reply.kind === 'tool_calls'
      ? reply.calls.map((call) => ({ functionCall: { name: call.name, args: call.arguments } }))
      : [{ text: reply.kind === 'text' ? reply.text : '' }];

  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8, totalTokenCount: 28 },
    modelVersion: 'mock-gemini',
  };
}

/** Repeated response envelopes, with no terminating sentinel. */
function geminiFrames(reply: NativeReply): string[] {
  if (reply.kind === 'tool_calls') {
    return [`data: ${JSON.stringify(geminiResponse(reply))}\n\n`];
  }
  const text = reply.kind === 'text' ? reply.text : '';
  const words = text.split(' ');
  const frames = words.map(
    (word, i) =>
      `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: i === 0 ? word : ` ${word}` }] } }] })}\n\n`,
  );
  frames.push(
    `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8 } })}\n\n`,
  );
  return frames;
}

function geminiModel(id: string): Record<string, unknown> {
  return {
    name: `models/${id}`,
    displayName: id,
    inputTokenLimit: 32_000,
    outputTokenLimit: 8_192,
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
  };
}

/** Last user text, whichever protocol carried it. */
function anthropicUserText(body: AnthropicBody): string {
  const last = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
  if (typeof last?.content === 'string') return last.content;
  if (!Array.isArray(last?.content)) return '';
  return (last.content as { type?: string; text?: string }[])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

function geminiUserText(body: GeminiBody): string {
  const last = [...(body.contents ?? [])].reverse().find((c) => c.role !== 'model');
  return (last?.parts ?? [])
    .map((part) => part.text)
    .filter((text): text is string => typeof text === 'string')
    .join('\n');
}

export async function startNativeProviders(): Promise<NativeProviders> {
  const requests: RecordedRequest[] = [];
  let replies: NativeReply[] = [];
  let cursor = 0;
  let toolCallingSupported = true;

  const nextReply = (probe: NativeReply | null): NativeReply => {
    if (probe) return probe;
    const reply = replies[cursor] ?? { kind: 'text' as const, text: 'Mock script exhausted.' };
    cursor += 1;
    return reply;
  };

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(body));
  };

  const sendFrames = (res: ServerResponse, frames: string[]): void => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...CORS,
    });
    for (const frame of frames) res.write(frame);
    res.end();
  };

  const handle = (req: IncomingMessage, res: ServerResponse, raw: string): void => {
    const path = req.url ?? '';
    let parsed: unknown = null;
    try {
      parsed = raw.length > 0 ? JSON.parse(raw) : null;
    } catch {
      parsed = raw;
    }
    requests.push({
      path,
      method: req.method ?? 'GET',
      headers: req.headers as Record<string, string>,
      body: parsed,
    });

    // The extension is an opaque origin to this server, so CORS must be open
    // for the service worker's fetch to succeed.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    // --- Anthropic ---------------------------------------------------------
    if (path.startsWith('/anthropic/v1/models')) {
      send(res, 200, { data: ANTHROPIC_MODELS.map((id) => ({ id, display_name: id })) });
      return;
    }
    if (path.startsWith('/anthropic/v1/messages')) {
      const body = (parsed ?? {}) as AnthropicBody;
      const probe = doctorProbe(
        anthropicUserText(body),
        body.tools?.some((tool) => tool.name === 'capability_probe') ?? false,
        toolCallingSupported,
      );
      const reply = nextReply(probe);
      if (reply.kind === 'http_error') {
        send(res, reply.status, { type: 'error', error: { type: 'api_error', message: 'mock' } });
        return;
      }
      if (body.stream) {
        sendFrames(res, anthropicFrames(reply));
        return;
      }
      send(res, 200, anthropicMessage(reply));
      return;
    }

    // --- Gemini ------------------------------------------------------------
    if (path.startsWith('/gemini/v1beta/models')) {
      const isGenerate = path.includes(':');
      if (!isGenerate) {
        // Either the list, or a single model's descriptor.
        const single = /\/models\/([^/?]+)$/.exec(path);
        send(
          res,
          200,
          single ? geminiModel(single[1]!) : { models: GEMINI_MODELS.map(geminiModel) },
        );
        return;
      }

      const body = (parsed ?? {}) as GeminiBody;
      const probe = doctorProbe(
        geminiUserText(body),
        body.tools?.some((tool) =>
          (tool.functionDeclarations ?? []).some((d) => d.name === 'capability_probe'),
        ) ?? false,
        toolCallingSupported,
      );
      const reply = nextReply(probe);
      if (reply.kind === 'http_error') {
        send(res, reply.status, {
          error: { code: reply.status, message: 'mock', status: 'INTERNAL' },
        });
        return;
      }
      if (path.includes(':streamGenerateContent')) {
        sendFrames(res, geminiFrames(reply));
        return;
      }
      send(res, 200, geminiResponse(reply));
      return;
    }

    send(res, 404, { error: 'unknown route' });
  };

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => handle(req, res, body));
  });

  // The extension's fetch keeps connections alive, and `server.close()` waits
  // for every open socket. Without forcing them shut, teardown hangs.
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    // Loopback, so the API key never crosses a network in the clear.
    anthropicBaseUrl: `http://127.0.0.1:${port}/anthropic`,
    geminiBaseUrl: `http://127.0.0.1:${port}/gemini/v1beta`,
    requests,
    script(next) {
      replies = [...next];
      cursor = 0;
    },
    setToolCallingSupported(supported) {
      toolCallingSupported = supported;
    },
    reset() {
      requests.length = 0;
      replies = [];
      cursor = 0;
      toolCallingSupported = true;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
