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
export function parseRpcEnvelope(text: string): McpRpcOutcome {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text) as unknown;
  } catch {
    throw new McpTransportError('NOT_MCP', 'The server did not answer with JSON.');
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

export function createMcpTransport(options: McpTransportOptions): McpTransport {
  const { server } = options;
  let nextId = 1;

  return {
    async call(method: string, params: unknown, context: McpEgressContext): Promise<McpRpcOutcome> {
      assertUsable(server.url, server.displayName);

      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: nextId++,
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

      const text = await readBounded(response);

      if (!response.ok) {
        // The body is not surfaced. It came from the server and would reach a
        // failure message, and from there the model's context.
        throw new McpTransportError(
          'TRANSPORT_FAILED',
          `${server.displayName} answered with ${response.status}.`,
        );
      }

      return parseRpcEnvelope(text);
    },
  };
}
