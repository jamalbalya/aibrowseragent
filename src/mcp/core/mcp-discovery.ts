/**
 * MCP discovery: `initialize` and `tools/list` (specification §5.11).
 *
 * This is the layer that turns what a server says into what this build is
 * willing to believe. It owns no policy of its own — risk comes from
 * `MCP_TOOL_RISK` and admission from `admitListing` — and it adds the two
 * things a listing needs that a single tool does not: a handshake that has to
 * succeed first, and pagination that has to terminate.
 *
 * Everything a server sends here is untrusted input. The protocol version, the
 * server's self-reported name, the cursor, the tool names, the descriptions and
 * the schemas were all authored by the far side, so each one is either checked
 * or dropped. Nothing is passed through because it "should" be well-formed.
 *
 * ## Pagination
 *
 * `tools/list` may return a `nextCursor`, and the cursor is the server's. Three
 * ways that becomes an attack and what stops each:
 *
 * - an endless chain of pages — bounded by `MAX_PAGES`;
 * - a cursor that repeats, looping for ever inside the bound — a repeated
 *   cursor ends the walk;
 * - a page count that stays under the bound while each page is enormous —
 *   `admitListing`'s own cap applies to the accumulated set, not per page, so
 *   the total is what is bounded.
 */

import { getLogger } from '@/logging/logger';
import { admitListing, type DiscoveredTool, type McpServerDescriptor } from '@/mcp/core/mcp-model';
import type { McpEgressContext, McpTransport } from '@/mcp/transport/mcp-transport';

const log = getLogger('security');

/**
 * The protocol revision this build speaks.
 *
 * Sent in `initialize`, and the server's answer is recorded rather than
 * negotiated: this build implements one revision, so a server on another is a
 * server this build declines to use. Guessing compatibility from a version
 * string the server chose is how a client ends up parsing a shape it does not
 * understand.
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** How many pages of a tool listing are walked before the rest is refused. */
export const MAX_PAGES = 8;

/** What this build tells a server about itself. Deliberately not a fingerprint. */
const CLIENT_INFO = { name: 'ai-browser-agent', version: '1' } as const;

export type McpDiscoveryFailure =
  /** The handshake did not produce a usable answer. */
  | 'HANDSHAKE_REFUSED'
  /** The server speaks a revision this build does not. */
  | 'PROTOCOL_MISMATCH'
  /** `tools/list` did not answer with a list. */
  | 'LISTING_MALFORMED'
  /** The server kept offering pages. */
  | 'LISTING_UNBOUNDED';

export class McpDiscoveryError extends Error {
  constructor(
    readonly failure: McpDiscoveryFailure,
    message: string,
  ) {
    super(message);
    this.name = 'McpDiscoveryError';
  }
}

export interface McpHandshake {
  /** The revision the server said it speaks. Recorded, never trusted. */
  readonly protocolVersion: string;
  /**
   * Whether the server declared a `tools` capability.
   *
   * Not used to skip the listing — a server that omits the capability and
   * offers tools anyway is simply inconsistent, and refusing to look would
   * hide tools the user can see in their own client. It is recorded so an
   * inconsistency is legible.
   */
  readonly declaresTools: boolean;
}

export interface McpDiscovery {
  readonly handshake: McpHandshake;
  /** Tools that passed admission, under their namespaced names. */
  readonly admitted: readonly { readonly name: string; readonly source: DiscoveredTool }[];
  /** Everything refused, with the reason, so nothing disappears silently. */
  readonly refused: readonly { readonly name: string; readonly reason: string }[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Performs the handshake.
 *
 * A JSON-RPC error here is a refusal rather than an exception in the transport
 * sense — the server answered, and it said no — so it is reported as its own
 * failure and the listing is not attempted.
 */
export async function initialize(
  transport: McpTransport,
  server: McpServerDescriptor,
  context: McpEgressContext,
): Promise<McpHandshake> {
  const outcome = await transport.call(
    'initialize',
    {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    },
    { ...context, method: 'initialize' },
  );

  if (!outcome.ok) {
    throw new McpDiscoveryError(
      'HANDSHAKE_REFUSED',
      `${server.displayName} refused the connection: ${outcome.message}`,
    );
  }

  const result = asRecord(outcome.result);
  if (result === null) {
    throw new McpDiscoveryError(
      'HANDSHAKE_REFUSED',
      `${server.displayName} answered the handshake with something unreadable.`,
    );
  }

  const protocolVersion = typeof result.protocolVersion === 'string' ? result.protocolVersion : '';
  if (protocolVersion !== MCP_PROTOCOL_VERSION) {
    // Declined rather than attempted. See MCP_PROTOCOL_VERSION.
    throw new McpDiscoveryError(
      'PROTOCOL_MISMATCH',
      `${server.displayName} speaks a version of MCP this extension does not ` +
        `(${protocolVersion.length > 0 ? protocolVersion.slice(0, 40) : 'unstated'}).`,
    );
  }

  const capabilities = asRecord(result.capabilities);
  return {
    protocolVersion,
    declaresTools: capabilities !== null && asRecord(capabilities.tools) !== null,
  };
}

/**
 * Lists a server's tools and admits what may become one.
 *
 * The accumulated listing goes through `admitListing` once, at the end, rather
 * than per page — so the cap bounds the total a server can contribute however
 * it chooses to split it up.
 */
export async function listTools(
  transport: McpTransport,
  server: McpServerDescriptor,
  context: McpEgressContext,
): Promise<Omit<McpDiscovery, 'handshake'>> {
  const collected: DiscoveredTool[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      throw new McpDiscoveryError(
        'LISTING_UNBOUNDED',
        `${server.displayName} kept offering more pages of tools than are read.`,
      );
    }

    const outcome = await transport.call('tools/list', cursor === undefined ? {} : { cursor }, {
      ...context,
      method: 'tools/list',
    });
    if (!outcome.ok) {
      throw new McpDiscoveryError(
        'LISTING_MALFORMED',
        `${server.displayName} refused to list its tools: ${outcome.message}`,
      );
    }

    const result = asRecord(outcome.result);
    const tools = result === null ? null : result.tools;
    if (!Array.isArray(tools)) {
      throw new McpDiscoveryError(
        'LISTING_MALFORMED',
        `${server.displayName} did not answer with a list of tools.`,
      );
    }
    for (const entry of tools) collected.push((entry ?? {}) as DiscoveredTool);

    const next = result === null ? undefined : result.nextCursor;
    if (typeof next !== 'string' || next.length === 0) break;
    if (seenCursors.has(next)) {
      // A repeated cursor would otherwise loop until MAX_PAGES, doing the same
      // request each time. Ending here is both cheaper and more accurate: the
      // server has stopped making progress.
      log.warn('An MCP server repeated a pagination cursor; the listing was ended.', {
        serverId: server.id,
      });
      break;
    }
    seenCursors.add(next);
    cursor = next;
  }

  return admitListing(server, collected);
}

/** The handshake and the listing, in the order they have to happen. */
export async function discover(
  transport: McpTransport,
  server: McpServerDescriptor,
  context: McpEgressContext,
): Promise<McpDiscovery> {
  const handshake = await initialize(transport, server, context);
  const listing = await listTools(transport, server, context);
  return { handshake, admitted: listing.admitted, refused: listing.refused };
}
