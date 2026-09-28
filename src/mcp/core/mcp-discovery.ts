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
import {
  admitListing,
  admitResourceListing,
  type AdmittedResource,
  type DiscoveredResource,
  type DiscoveredTool,
  type McpServerDescriptor,
} from '@/mcp/core/mcp-model';
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
   * Whether the server declared a `resources` capability.
   *
   * Unlike `declaresTools`, this one is **acted on**: `resources/list` is only
   * attempted when the server says it has resources. The asymmetry is
   * deliberate. A server that omits the `tools` capability and offers tools
   * anyway is inconsistent in a way that would cost the user tools they can see
   * in their own client, so the listing runs regardless. Resources are the other
   * way round: asking a server with no resources produces a `-32601` that has to
   * be told apart from a real refusal, and there is nothing to lose by not
   * asking.
   */
  readonly declaresResources: boolean;
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
  /** Resources the server offered that passed admission. */
  readonly resources: readonly AdmittedResource[];
  /** Resources refused, by URI. */
  readonly refusedResources: readonly { readonly uri: string; readonly reason: string }[];
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
    declaresResources: capabilities !== null && asRecord(capabilities.resources) !== null,
  };
}

/**
 * Lists a server's resources.
 *
 * Same pagination rules as the tool listing, and the same reason for each: a
 * page cap, an end on a repeated cursor, and admission applied to the
 * accumulated set so splitting a listing does not evade the resource cap.
 *
 * A refusal to list is **not** an error here, unlike `tools/list`. A server may
 * declare the capability and then decline, and a resource listing is
 * supplementary — losing it should not cost the user the server's tools. So it
 * comes back as an empty listing with the refusal named.
 */
export async function listResources(
  transport: McpTransport,
  server: McpServerDescriptor,
  context: McpEgressContext,
): Promise<{
  readonly admitted: readonly AdmittedResource[];
  readonly refused: readonly { readonly uri: string; readonly reason: string }[];
}> {
  const collected: DiscoveredResource[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      return {
        admitted: admitResourceListing(collected).admitted,
        refused: [
          { uri: '(listing)', reason: `more than ${MAX_PAGES} pages of resources were offered` },
        ],
      };
    }

    const outcome = await transport.call('resources/list', cursor === undefined ? {} : { cursor }, {
      ...context,
      method: 'resources/list',
    });
    if (!outcome.ok) {
      return { admitted: [], refused: [{ uri: '(listing)', reason: outcome.message }] };
    }

    const result = asRecord(outcome.result);
    const resources = result === null ? null : result.resources;
    if (!Array.isArray(resources)) {
      return {
        admitted: [],
        refused: [{ uri: '(listing)', reason: 'the server did not answer with a list' }],
      };
    }
    for (const entry of resources) collected.push((entry ?? {}) as DiscoveredResource);

    const next = result === null ? undefined : result.nextCursor;
    if (typeof next !== 'string' || next.length === 0) break;
    if (seenCursors.has(next)) {
      log.warn('An MCP server repeated a resource cursor; the listing was ended.', {
        serverId: server.id,
      });
      break;
    }
    seenCursors.add(next);
    cursor = next;
  }

  return admitResourceListing(collected);
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
): Promise<Pick<McpDiscovery, 'admitted' | 'refused'>> {
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

/** The handshake and the listings, in the order they have to happen. */
export async function discover(
  transport: McpTransport,
  server: McpServerDescriptor,
  context: McpEgressContext,
): Promise<McpDiscovery> {
  const handshake = await initialize(transport, server, context);
  const listing = await listTools(transport, server, context);
  // Only when the server said it has resources; see `declaresResources`.
  const resources = handshake.declaresResources
    ? await listResources(transport, server, context)
    : { admitted: [], refused: [] };
  return {
    handshake,
    admitted: listing.admitted,
    refused: listing.refused,
    resources: resources.admitted,
    refusedResources: resources.refused,
  };
}
