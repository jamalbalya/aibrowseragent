/**
 * The guarded transport for MCP requests (specification §5.11, §35).
 *
 * "Server" here always means a server somebody else runs and this build calls
 * out to. This extension is not an MCP server and cannot become one — see
 * `docs/MCP_GUIDE.md` §1 — so there is no inbound path in this file and no
 * caller identity anywhere in it.
 *
 * It does not reimplement the egress gate. It builds an MCP destination and
 * calls `guardedSend`, the same function the provider and connector transports
 * call, so there is one authorization model rather than a third one. What it
 * adds is the handful of rules that are specific to talking JSON-RPC to an
 * endpoint nobody vetted:
 *
 * **Redirects are never followed, and never re-authorised.** The connector
 * transport follows a redirect that stays inside origins its *descriptor
 * declared*. An MCP server has no descriptor: the user supplied one URL, and a
 * redirect to anywhere — including another path on the same host — is a
 * destination they did not name. Both shapes a refused redirect can take are
 * handled, because both occur: in a browser `redirect: 'manual'` yields an
 * opaque redirect with status 0 and no headers, and outside one the 3xx
 * arrives with its `Location`. Either way the answer is the same refusal, so
 * there is no hop counter here at all.
 *
 * **The response is bounded before it is parsed.** The body length comes from
 * the server, so an unbounded `response.json()` is a memory-exhaustion channel
 * in the service worker. The body is read as text under a cap and parsed here.
 *
 * **A JSON-RPC error is a result, not an exception.** A server that answers
 * `{"error": …}` answered; a server that returns HTML answered something that
 * is not MCP. The two are different failures and the caller needs to tell them
 * apart, so the shape of the envelope is checked rather than assumed.
 *
 * **Either framing is read, because servers use both.** Streamable HTTP lets a
 * server answer a POST with `application/json` or with `text/event-stream`, and
 * this file advertised both in `Accept` from its first version while parsing only
 * the first — `JSON.parse` on an SSE body threw `NOT_MCP`. Measured against the
 * reference `@modelcontextprotocol/server-everything`, which answers a successful
 * `initialize` as SSE and a refused request as plain JSON: this client could not
 * complete a handshake with it at all. The framing is detected from the body
 * rather than from the content type, because the content type comes from the
 * server too.
 *
 * **A session id the server issues is echoed back, and validated first.** That
 * same server answers every request after `initialize` with `Bad Request: Server
 * not initialized` unless `mcp-session-id` is returned to it, so discovery failed
 * on its second call. The id is server-authored text on its way into a request
 * header, which is a header-injection shape, so it is held to the
 * specification's own rule — visible ASCII only — and an id that breaks it is
 * refused rather than sanitised.
 */

import { getLogger } from '@/logging/logger';
import { isLoopbackHostname } from '@/security/origin/origin-validator';
import { mcpDestination } from '@/security/egress/destination';
import { guardedSend, type GuardedSendOptions } from '@/security/egress/provider-transport';
import type { EgressDecision } from '@/security/egress/egress-gate';
import type { TaintState } from '@/security/taint/taint-state';
import type { McpServerDescriptor } from '@/mcp/core/mcp-model';

const log = getLogger('security');

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Bounds on a session id the server chose.
 *
 * The value goes into a request header on every later call, so the limit is
 * about what may go in a header rather than about what a session id plausibly
 * looks like.
 */
const MAX_SESSION_ID = 128;

/** Visible ASCII, which is what the specification requires of a session id. */
const SESSION_ID_SHAPE = /^[\x21-\x7e]+$/;

/** How many SSE events are read out of one response before it is refused. */
const MAX_SSE_EVENTS = 64;

/** The header a Streamable HTTP server issues a session under. */
const SESSION_HEADER = 'mcp-session-id';

/**
 * How much of a response body is read before it is refused.
 *
 * 1 MiB, which is generous for a tool listing and a tool result and far below
 * anything that would trouble a worker. A listing that needs more than this is
 * a listing `admitListing` would refuse on count anyway.
 */
export const MAX_RESPONSE_BYTES = 1_048_576;

/** Security context for one MCP request, carried with it. */
export interface McpEgressContext {
  readonly taskId: string;
  readonly taintState: TaintState;
  readonly taintSalt: string;
  readonly saltEpoch: number;
  readonly taintSignature: string;
  /** JSON-RPC method. This build's vocabulary, never a server-supplied name. */
  readonly method: string;
}

export type McpTransportFailure =
  /** The stored URL stopped being usable, or stopped being https. */
  | 'DESTINATION_REFUSED'
  /** The server tried to send the request somewhere the user did not name. */
  | 'REDIRECT_REFUSED'
  /** The server answered, with something that is not a JSON-RPC envelope. */
  | 'NOT_MCP'
  /** The server answered with more bytes than are read. */
  | 'RESPONSE_TOO_LARGE'
  /** HTTP-level failure: a 4xx or 5xx. */
  | 'TRANSPORT_FAILED';

export class McpTransportError extends Error {
  constructor(
    readonly failure: McpTransportFailure,
    message: string,
  ) {
    super(message);
    this.name = 'McpTransportError';
  }
}

/** A JSON-RPC result, or the error the server returned in place of one. */
export type McpRpcOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: number; readonly message: string };

export interface McpTransport {
  call(method: string, params: unknown, context: McpEgressContext): Promise<McpRpcOutcome>;
}

export interface McpTransportOptions {
  readonly server: McpServerDescriptor;
  readonly consent: GuardedSendOptions['consent'];
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly onDecision?: (
    decision: EgressDecision,
    context: McpEgressContext,
    url: string,
    payload: unknown,
  ) => Promise<void>;
}

/**
 * Re-checks the stored URL at use time.
 *
 * `validateServerDescriptor` already refused a non-https, non-loopback URL at
 * registration. This runs the same rule again on the way out, because the
 * record was written to storage in between and a check that only ever ran
 * before persistence is a check an edited record walks past.
 */
function assertUsable(url: string, displayName: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new McpTransportError(
      'DESTINATION_REFUSED',
      `${displayName} has an address that is no longer usable.`,
    );
  }
  if (parsed.protocol !== 'https:' && !isLoopbackHostname(parsed.hostname)) {
    throw new McpTransportError(
      'DESTINATION_REFUSED',
      `${displayName} is not reachable over https, so the request was not sent.`,
    );
  }
}

function isOpaqueRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || (response.status === 0 && !response.ok);
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Reads a body under a cap.
 *
 * `Content-Length` is checked first when the server offers one, and the decoded
 * text is checked afterwards regardless — because the header comes from the
 * server too, and a server that understates it would otherwise get an
 * unbounded read out of a check that trusted it.
 */
async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new McpTransportError(
      'RESPONSE_TOO_LARGE',
      'The server offered more data than is read from one response.',
    );
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new McpTransportError(
      'RESPONSE_TOO_LARGE',
      'The server sent more data than is read from one response.',
    );
  }
  return text;
}

/**
 * Turns a body into an outcome.
 *
 * Exported so the parsing rules can be tested without a socket: every branch
 * here is a shape a hostile or broken server can produce, and they are the
 * branches most likely to be got wrong.
 */
/**
 * The JSON-RPC messages in an SSE-framed body.
 *
 * Detected and parsed from the body rather than from `Content-Type`, because the
 * content type is chosen by the server: one that mislabels an SSE body as JSON,
 * or the reverse, must still be read correctly or refused for the right reason.
 *
 * One response may legitimately carry several messages — a server may interleave
 * notifications with the answer — so every event is collected and the caller
 * picks the one that answers its request. `MAX_SSE_EVENTS` bounds that, for the
 * same reason the body length is bounded: the count is the server's choice.
 *
 * Deliberately not a general SSE implementation. There is no reconnection, no
 * `Last-Event-ID` handling and no stream kept open; this reads one complete
 * response body that has already been bounded and closed.
 */
export function parseSseMessages(text: string): readonly unknown[] {
  const messages: unknown[] = [];
  // Events are separated by a blank line. Normalised first, because a server may
  // use CRLF and splitting on "\n\n" alone would then find no boundary at all.
  const blocks = text.replace(/\r\n/g, '\n').split(/\n\n+/);
  for (const block of blocks) {
    if (block.trim().length === 0) continue;
    if (messages.length >= MAX_SSE_EVENTS) {
      throw new McpTransportError(
        'RESPONSE_TOO_LARGE',
        'The server sent more events in one response than are read from it.',
      );
    }
    // A `data` field may be split across lines, which are joined with a newline.
    // Every other field — `event`, `id`, `retry` — is ignored: this is a
    // request/response exchange, and none of them changes what the answer is.
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).replace(/^ /, ''))
      .join('\n');
    if (data.length === 0) continue;
    try {
      messages.push(JSON.parse(data) as unknown);
    } catch {
      throw new McpTransportError('NOT_MCP', 'The server sent an event that was not JSON.');
    }
  }
  return messages;
}

/** Whether a body is SSE-framed. Judged by shape, never by the declared type. */
function looksSseFramed(text: string): boolean {
  // An SSE body's first non-blank line is a field. A JSON body's is `{` or `[`.
  const first = text.trimStart();
  return /^(event|data|id|retry):/.test(first);
}

export function parseRpcEnvelope(text: string, requestId?: number): McpRpcOutcome {
  let envelope: unknown;
  if (looksSseFramed(text)) {
    const messages = parseSseMessages(text);
    // The message that answers this request, not merely the first one: a server
    // may send a notification ahead of the response, and a notification has no
    // `id` at all. When no id was supplied — the parser is exported for tests
    // that exercise one envelope at a time — the last message stands, because a
    // response follows any notifications that preceded it.
    const answer =
      requestId === undefined
        ? messages[messages.length - 1]
        : messages.find(
            (message) =>
              typeof message === 'object' &&
              message !== null &&
              (message as Record<string, unknown>)['id'] === requestId,
          );
    if (answer === undefined) {
      throw new McpTransportError(
        'NOT_MCP',
        'The server sent events but none of them answered the request.',
      );
    }
    envelope = answer;
  } else {
    try {
      envelope = JSON.parse(text) as unknown;
    } catch {
      throw new McpTransportError('NOT_MCP', 'The server did not answer with JSON.');
    }
  }
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    // A JSON-RPC batch is an array, and this build never sends one, so an
    // array back is a response to a request that was not made.
    throw new McpTransportError('NOT_MCP', 'The server did not answer with a JSON-RPC message.');
  }
  const record = envelope as Record<string, unknown>;
  if ('error' in record) {
    const error = record.error;
    const detail =
      typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
    const code = typeof detail.code === 'number' ? detail.code : 0;
    // The message came from the server, so it is bounded here rather than
    // passed through at whatever length the server chose.
    const message =
      typeof detail.message === 'string' && detail.message.length > 0
        ? detail.message.slice(0, 200)
        : 'The server refused the request without saying why.';
    return { ok: false, code, message };
  }
  if (!('result' in record)) {
    throw new McpTransportError(
      'NOT_MCP',
      'The server answered with neither a result nor an error.',
    );
  }
  return { ok: true, result: record.result };
}

/**
 * A session id this transport is willing to send back.
 *
 * The specification requires visible ASCII, and holding the server to that is
 * what makes echoing the value safe: a header value cannot contain CR, LF or a
 * control character, so there is no header-injection shape left. An id that
 * breaks the rule is refused rather than trimmed — a sanitised id would be a
 * different id, and the session it names is not one this client can hold.
 */
function usableSessionId(value: string | null): string | undefined {
  if (value === null || value.length === 0 || value.length > MAX_SESSION_ID) return undefined;
  return SESSION_ID_SHAPE.test(value) ? value : undefined;
}

export function createMcpTransport(options: McpTransportOptions): McpTransport {
  const { server } = options;
  let nextId = 1;
  /**
   * The session this server issued, for as long as this transport lives.
   *
   * Held in the closure and nowhere else: a session is a property of one
   * conversation with one server, and persisting it would outlive both the
   * worker generation that opened it and the registration that produced the
   * tools.
   */
  let sessionId: string | undefined;

  return {
    async call(method: string, params: unknown, context: McpEgressContext): Promise<McpRpcOutcome> {
      assertUsable(server.url, server.displayName);

      const id = nextId++;
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });

      const response = await guardedSend(
        {
          url: server.url,
          init: {
            method: 'POST',
            headers: {
              // Streamable HTTP allows a server to answer either way. Both are
              // advertised, and what comes back is read as text and parsed
              // here rather than trusted to be what was asked for.
              Accept: 'application/json, text/event-stream',
              'Content-Type': 'application/json',
              // Sent only once the server has issued one. A client that invented
              // a session id would be asserting a conversation that never
              // happened.
              ...(sessionId === undefined ? {} : { [SESSION_HEADER]: sessionId }),
            },
            body,
            // Never followed. See the module comment: there is no declared
            // origin set to re-check a hop against.
            redirect: 'manual',
            signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
          },
          destination: mcpDestination(server.id, server.url, { method }),
          taskId: context.taskId,
          taintState: context.taintState,
          taintSalt: context.taintSalt,
          taintSignature: context.taintSignature,
          describe: `mcp/${server.id}/${method}`,
        },
        {
          consent: options.consent,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.onDecision === undefined
            ? {}
            : {
                onDecision: (decision, payload) =>
                  options.onDecision!(decision, context, server.url, payload),
              }),
        },
      );

      if (isOpaqueRedirect(response) || isRedirect(response.status)) {
        log.warn('An MCP response redirected and was refused.', { serverId: server.id });
        throw new McpTransportError(
          'REDIRECT_REFUSED',
          `${server.displayName} redirected this request. It was not followed, because the ` +
            'address it pointed to is not the one you added.',
        );
      }

      // Captured before the status is judged, because a server may issue the
      // session on the same response that reports a problem, and never reissue
      // it. Only ever set, never cleared here: a server that drops a session
      // answers the next call with an error, which is the caller's to handle.
      const issued = usableSessionId(response.headers.get(SESSION_HEADER));
      if (issued !== undefined && sessionId === undefined) sessionId = issued;

      const text = await readBounded(response);

      if (!response.ok) {
        // The body is not surfaced. It came from the server and would reach a
        // failure message, and from there the model's context.
        throw new McpTransportError(
          'TRANSPORT_FAILED',
          `${server.displayName} answered with ${response.status}.`,
        );
      }

      return parseRpcEnvelope(text, id);
    },
  };
}
