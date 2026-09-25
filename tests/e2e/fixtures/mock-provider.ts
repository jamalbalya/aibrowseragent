/**
 * A real HTTP server speaking the OpenAI Chat Completions protocol.
 *
 * Stage 1 tested the adapter against a stubbed `fetch`, which proves the
 * translation logic but not that the extension can actually reach a provider
 * from a service worker over the network, with real headers, real streaming
 * frames and real CORS behaviour. This server closes that gap: the extension
 * makes genuine HTTP requests to it.
 *
 * Responses are scripted so a test can drive an exact agent trajectory.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ScriptedToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export type ScriptedReply =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool_calls'; readonly calls: readonly ScriptedToolCall[] }
  | { readonly kind: 'http_error'; readonly status: number; readonly body?: string };

export interface RecordedRequest {
  readonly path: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface MockProvider {
  readonly baseUrl: string;
  /** Every request the extension made, in order. */
  readonly requests: readonly RecordedRequest[];
  /** Queues replies consumed in order by /chat/completions. */
  script(replies: readonly ScriptedReply[]): void;
  /** Models returned by /models. Empty simulates a gateway without the route. */
  setModels(ids: readonly string[]): void;
  /**
   * Makes the endpoint behave as if it cannot call tools, so a test can
   * exercise the doctor's CHAT_ONLY path.
   */
  setToolCallingSupported(supported: boolean): void;
  reset(): void;
  close(): Promise<void>;
}

interface WireRequest {
  readonly model?: string;
  readonly stream?: boolean;
  readonly tools?: { function?: { name?: string } }[];
  readonly messages?: { role?: string; content?: unknown }[];
}

/**
 * Placeholder a scripted tool call can use for a value the model would only
 * learn at run time.
 *
 * A file id is minted when the user picks a file, so a fixed script cannot
 * contain one. Substituting the id from the most recent tool result is what a
 * real model does — it reads the id out of the result it was just handed —
 * and it keeps the script readable.
 */
const FILE_ID_PLACEHOLDER = '$lastFileId';

/**
 * The same, for an element handle.
 *
 * A handle is minted by `browser.read_page` and is valid only for that
 * snapshot, so a fixed script cannot contain one. A real model reads it out of
 * the page it was just handed, which is what this imitates.
 */
const ELEMENT_ID_PLACEHOLDER = '$lastElementId';

/** The newest file id the conversation has carried back to the model. */
function lastFileId(request: WireRequest): string | null {
  const ids: string[] = [];
  for (const message of request.messages ?? []) {
    if (typeof message.content !== 'string') continue;
    for (const match of message.content.matchAll(/"fileId":"(file_[^"]+)"/g)) {
      if (match[1]) ids.push(match[1]);
    }
  }
  return ids.at(-1) ?? null;
}

/**
 * The same, for an element chosen by what it is rather than by where it sits.
 *
 * `$element(<role>,<name>)` is replaced with the handle of the element whose
 * role and accessible name match exactly, taken from the most recent page
 * model in the conversation. A fixed handle like `e1-3` names a position in a
 * snapshot, which moves whenever the page does; role and name are what a real
 * model reads off the page model and what a recorded binding later matches
 * on, so a script written this way says which control it means.
 *
 * Unresolved on purpose when nothing matches: the placeholder is left in
 * place, the tool refuses the handle, and the test fails saying so — which is
 * a better failure than silently acting on whatever happened to be first.
 */
const ELEMENT_BY_DESCRIPTION = /\$element\(([a-zA-Z]+),([^)]*)\)/g;

/** Escapes a literal for use inside a regular expression. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The handle the newest page model gave the element with this role and name.
 *
 * The *newest*, because a handle is snapshot-scoped: an earlier read's handle
 * is stale and would be refused, so the only useful answer is the last one.
 */
function elementByDescription(request: WireRequest, role: string, name: string): string | null {
  const pattern = new RegExp(
    `\\{"elementId":"(e[0-9]+-[0-9]+)","role":"${escapeForRegExp(role)}","name":"${escapeForRegExp(name)}"`,
    'g',
  );
  const ids: string[] = [];
  for (const message of request.messages ?? []) {
    if (typeof message.content !== 'string') continue;
    for (const match of message.content.matchAll(pattern)) {
      if (match[1]) ids.push(match[1]);
    }
  }
  return ids.at(-1) ?? null;
}

/** The handle of the first clickable element the page model carried back. */
function lastElementId(request: WireRequest, role: string): string | null {
  const ids: string[] = [];
  const pattern = new RegExp(`\\{"elementId":"(e[0-9]+-[0-9]+)","role":"${role}"`, 'g');
  for (const message of request.messages ?? []) {
    if (typeof message.content !== 'string') continue;
    for (const match of message.content.matchAll(pattern)) {
      if (match[1]) ids.push(match[1]);
    }
  }
  return ids[0] ?? null;
}

/** Replaces the placeholders in a scripted reply with the real ids. */
function resolvePlaceholders(reply: ScriptedReply, request: WireRequest): ScriptedReply {
  if (reply.kind !== 'tool_calls') return reply;

  const substitutions: [string, string][] = [];
  const fileId = lastFileId(request);
  if (fileId !== null) substitutions.push([FILE_ID_PLACEHOLDER, fileId]);
  const elementId = lastElementId(request, 'button');
  if (elementId !== null) substitutions.push([ELEMENT_ID_PLACEHOLDER, elementId]);

  const resolve = (text: string): string =>
    substitutions
      .reduce((carried, [placeholder, value]) => carried.replaceAll(placeholder, value), text)
      .replace(ELEMENT_BY_DESCRIPTION, (whole, role: string, name: string) => {
        const handle = elementByDescription(request, role.trim(), name.trim());
        return handle ?? whole;
      });

  return {
    ...reply,
    calls: reply.calls.map((call) => ({
      ...call,
      arguments: JSON.parse(resolve(JSON.stringify(call.arguments))) as Record<string, unknown>,
    })),
  };
}

/**
 * Recognises the capability doctor's probes.
 *
 * The doctor is infrastructure every test needs to get past, so the mock
 * answers its probes on its own. Scripts then describe only the agent
 * trajectory under test, which is what the test is actually about.
 */
function doctorProbe(request: WireRequest, toolCallingSupported: boolean): ScriptedReply | null {
  const probesTools = request.tools?.some((tool) => tool.function?.name === 'capability_probe');
  if (probesTools) {
    return toolCallingSupported
      ? { kind: 'tool_calls', calls: [{ name: 'capability_probe', arguments: { status: 'ok' } }] }
      : { kind: 'text', text: 'I would call that function.' };
  }

  const lastUserText = [...(request.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'user');
  const text = typeof lastUserText?.content === 'string' ? lastUserText.content : '';

  if (text.includes('JSON object')) return { kind: 'text', text: '{"ok":true}' };
  if (text.includes('single word: ready')) return { kind: 'text', text: 'ready' };
  if (text.startsWith('Count:')) return { kind: 'text', text: 'one two three' };
  if (text === 'ping') return { kind: 'text', text: 'pong' };

  return null;
}

function completion(reply: ScriptedReply, model: string): Record<string, unknown> {
  if (reply.kind === 'tool_calls') {
    return {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: reply.calls.map((call, index) => ({
              id: `call_${index}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 8 },
    };
  }
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: reply.kind === 'text' ? reply.text : '' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 8 },
  };
}

/** Emits a scripted reply as SSE frames, split mid-token like a real provider. */
function streamFrames(reply: ScriptedReply, model: string): string[] {
  if (reply.kind === 'tool_calls') {
    const frames: string[] = [];
    reply.calls.forEach((call, index) => {
      const args = JSON.stringify(call.arguments);
      const half = Math.ceil(args.length / 2);
      frames.push(
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: `call_${index}`, function: { name: call.name, arguments: args.slice(0, half) } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(half) } }] } }] })}\n\n`,
      );
    });
    frames.push(
      `data: ${JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 8 } })}\n\n`,
    );
    frames.push('data: [DONE]\n\n');
    return frames;
  }

  const text = reply.kind === 'text' ? reply.text : '';
  const frames = text
    .split(' ')
    .map(
      (word, i) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content: i === 0 ? word : ` ${word}` } }] })}\n\n`,
    );
  frames.push(
    `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8 }, model })}\n\n`,
  );
  frames.push('data: [DONE]\n\n');
  return frames;
}

export async function startMockProvider(): Promise<MockProvider> {
  const requests: RecordedRequest[] = [];
  let replies: ScriptedReply[] = [];
  let cursor = 0;
  let models: string[] = ['mock-model'];
  let toolCallingSupported = true;

  const handle = (req: IncomingMessage, res: ServerResponse, body: string): void => {
    const path = req.url ?? '';
    let parsed: unknown = null;
    try {
      parsed = body.length > 0 ? JSON.parse(body) : null;
    } catch {
      parsed = body;
    }
    requests.push({
      path,
      method: req.method ?? 'GET',
      headers: req.headers as Record<string, string>,
      body: parsed,
    });

    // The extension is an opaque origin to this server, so CORS must be open
    // for the service worker's fetch to succeed.
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (path.endsWith('/models')) {
      res.writeHead(models.length === 0 ? 404 : 200, {
        'Content-Type': 'application/json',
        ...cors,
      });
      res.end(
        JSON.stringify(
          models.length === 0 ? { error: 'not found' } : { data: models.map((id) => ({ id })) },
        ),
      );
      return;
    }

    if (!path.endsWith('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: 'unknown route' }));
      return;
    }

    const request = (parsed ?? {}) as WireRequest;

    // Doctor probes are answered directly and never consume the script, so a
    // test's script indexes line up with the agent turns it wrote.
    const probe = doctorProbe(request, toolCallingSupported);
    const scripted = probe ??
      replies[cursor] ?? { kind: 'text' as const, text: 'Mock script exhausted.' };
    if (!probe) cursor += 1;
    const reply = resolvePlaceholders(scripted, request);

    if (reply.kind === 'http_error') {
      res.writeHead(reply.status, { 'Content-Type': 'application/json', ...cors });
      res.end(reply.body ?? JSON.stringify({ error: { message: 'mock failure' } }));
      return;
    }

    if (request.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...cors,
      });
      for (const frame of streamFrames(reply, request.model ?? 'mock-model')) res.write(frame);
      res.end();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify(completion(reply, request.model ?? 'mock-model')));
  };

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => handle(req, res, body));
  });

  // The extension's fetch keeps connections alive, and `server.close()` waits
  // for every open socket. Without forcing them shut, teardown hangs until the
  // test times out.
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    script(next) {
      replies = [...next];
      cursor = 0;
    },
    setModels(ids) {
      models = [...ids];
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
