/**
 * The MCP trust core (specification §35, §5.11).
 *
 * This file holds the decisions, not the transport. Everything here is a pure
 * function over data, because the questions it answers are the ones that must
 * be right *before* a socket exists: what may be added as a server, what risk a
 * tool from it carries, and what of a discovered tool is allowed to reach the
 * model at all.
 *
 * ## Where a tool's risk comes from
 *
 * Not from the server. `PLUGIN_TRUST_MODEL.md` settles that — "a server that
 * could declare its own tool R0 would be a server that could decide it needs no
 * approval" — and it rules out the obvious alternative with it: inferring risk
 * from the tool's name, description or schema is accepting the server's
 * declaration through the back door, because the server authored all three.
 *
 * So risk comes from the user. Adding an MCP server is already a deliberate act
 * — it is a declared egress destination — and that is when they say what it may
 * do. That answer is a per-server **ceiling**, clamped exactly as a site grant
 * is, and every tool from the server runs at it.
 *
 * The cost is stated rather than hidden: a read-only tool costs the same as a
 * write from the same server. Without trusting the server there is no way to
 * tell them apart, and of the two ways to be wrong, being wrong permissively is
 * the one that cannot be walked back.
 */
import { clampToGrantable, type GrantableRiskLevel } from '@/policy/site-policy';
import type { RiskLevel } from '@/policy/risk-classifier';

/** How long a discovered description may be before it is refused. */
const MAX_DESCRIPTION = 400;
/** How many tools one server may contribute. */
const MAX_TOOLS = 64;

/**
 * The separator between a server id and a tool name.
 *
 * Chosen so a namespaced name cannot collide with a built-in: every tool this
 * project ships is `family.verb`, and no built-in family contains `__`.
 */
export const MCP_NAME_SEPARATOR = '__';

/** The prefix every MCP tool carries, so its origin is legible in a trail. */
export const MCP_NAME_PREFIX = 'mcp';

export interface McpServerDescriptor {
  readonly id: string;
  /** User-facing name. Never an identity, never used for matching. */
  readonly displayName: string;
  /** The server's endpoint. https, or loopback for a local mock under test. */
  readonly url: string;
  /**
   * The most any tool from this server may cost, set by the user when they
   * added it. Clamped on the way in, so a stored ceiling can never express an
   * authority the product does not have.
   */
  readonly ceiling: GrantableRiskLevel;
}

/** A tool as the server described it: untrusted input, not yet a tool. */
export interface DiscoveredTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

/**
 * Builds the name an MCP tool is registered under.
 *
 * Namespaced by server, so two servers offering `search` are two tools and the
 * one that arrived second does not silently replace the first — and so no
 * discovered name can shadow a tool this project ships, whatever the server
 * calls it.
 */
export function mcpToolName(serverId: string, toolName: string): string {
  return [MCP_NAME_PREFIX, serverId, toolName].join(MCP_NAME_SEPARATOR);
}

/** Whether a name was minted by `mcpToolName` rather than declared in the build. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(`${MCP_NAME_PREFIX}${MCP_NAME_SEPARATOR}`);
}

/**
 * The risk a tool from this server carries.
 *
 * One line, and deliberately ignoring its only argument's content beyond the
 * server it came from: there is no branch here that a server could influence.
 */
export function mcpToolRisk(server: McpServerDescriptor): RiskLevel {
  return server.ceiling;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Checks a server before it can be added, and clamps its ceiling.
 *
 * Registration-time rather than use-time, for the reason the connector
 * registry gives: a descriptor with the wrong scheme should never become
 * addable, so the failure happens when somebody configures it rather than when
 * a task is halfway through a call.
 */
export function validateServerDescriptor(input: {
  readonly id?: unknown;
  readonly displayName?: unknown;
  readonly url?: unknown;
  readonly ceiling?: unknown;
}):
  | { readonly ok: true; readonly server: McpServerDescriptor }
  | { readonly ok: false; readonly problems: readonly string[] } {
  const problems: string[] = [];

  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (id.length === 0) problems.push('a server id is required');
  // The id becomes part of a tool name, so it has to survive that without
  // introducing a second separator or a character a wire format will mangle.
  else if (!/^[a-z0-9-]+$/.test(id)) {
    problems.push('a server id may hold only lower-case letters, digits and hyphens');
  }

  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (displayName.length === 0) problems.push('a display name is required');

  const rawUrl = typeof input.url === 'string' ? input.url.trim() : '';
  if (rawUrl.length === 0) problems.push('a server URL is required');
  else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(rawUrl);
    } catch {
      problems.push(`"${rawUrl}" is not a usable URL`);
    }
    if (parsed !== null && parsed.protocol !== 'https:' && !isLoopback(parsed.hostname)) {
      // Every call carries whatever credential the server needs, so plaintext
      // is refused. Loopback is allowed so a local mock can be driven over
      // real sockets, which is how the connectors are tested.
      problems.push(`"${rawUrl}" is not https`);
    }
  }

  const ceiling =
    typeof input.ceiling === 'string' ? clampToGrantable(input.ceiling as RiskLevel) : null;
  if (ceiling === null) problems.push('a risk ceiling is required');

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    server: { id, displayName, url: rawUrl, ceiling: ceiling as GrantableRiskLevel },
  };
}

/**
 * Decides whether a discovered tool may become a tool at all.
 *
 * Everything in a `DiscoveredTool` was authored by the server, so this is input
 * validation rather than parsing. A tool that fails here is dropped and named
 * in the result: silently ignoring it would leave the user looking at a server
 * that appears to offer nothing.
 */
export function admitDiscoveredTool(
  server: McpServerDescriptor,
  tool: DiscoveredTool,
): { readonly ok: true; readonly name: string } | { readonly ok: false; readonly reason: string } {
  const name = typeof tool.name === 'string' ? tool.name.trim() : '';
  if (name.length === 0) return { ok: false, reason: 'the tool has no name' };
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    return { ok: false, reason: `"${name}" holds characters a tool name may not` };
  }
  // A name carrying the separator could otherwise construct a namespace of its
  // own — `mcp__other-server__x` — and appear to come from somewhere else.
  if (name.includes(MCP_NAME_SEPARATOR)) {
    return { ok: false, reason: `"${name}" may not contain "${MCP_NAME_SEPARATOR}"` };
  }
  if (tool.description !== undefined && typeof tool.description !== 'string') {
    return { ok: false, reason: `"${name}" has a description that is not text` };
  }
  if ((tool.description ?? '').length > MAX_DESCRIPTION) {
    return { ok: false, reason: `"${name}" has a description longer than ${MAX_DESCRIPTION}` };
  }
  // A tool with no schema is a tool whose arguments cannot be validated, and
  // §22 makes validation the contract rather than a convenience.
  if (typeof tool.inputSchema !== 'object' || tool.inputSchema === null) {
    return { ok: false, reason: `"${name}" declares no input schema` };
  }
  return { ok: true, name: mcpToolName(server.id, name) };
}

/**
 * Admits a whole listing, bounded.
 *
 * Bounded because the count comes from the server too: a listing of ten
 * thousand tools would be a context-exhaustion channel rather than a feature.
 * The tools past the cap are refused rather than truncated silently.
 */
export function admitListing(
  server: McpServerDescriptor,
  tools: readonly DiscoveredTool[],
): {
  readonly admitted: readonly { readonly name: string; readonly source: DiscoveredTool }[];
  readonly refused: readonly { readonly name: string; readonly reason: string }[];
} {
  const admitted: { name: string; source: DiscoveredTool }[] = [];
  const refused: { name: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const [index, tool] of tools.entries()) {
    const label = typeof tool?.name === 'string' ? tool.name : `#${index}`;
    if (index >= MAX_TOOLS) {
      refused.push({ name: label, reason: `more than ${MAX_TOOLS} tools were offered` });
      continue;
    }
    const verdict = admitDiscoveredTool(server, tool ?? { name: '' });
    if (!verdict.ok) {
      refused.push({ name: label, reason: verdict.reason });
      continue;
    }
    // A server repeating a name is a server whose second entry would replace
    // its first. Keep the first and say so.
    if (seen.has(verdict.name)) {
      refused.push({ name: label, reason: `"${label}" was offered more than once` });
      continue;
    }
    seen.add(verdict.name);
    admitted.push({ name: verdict.name, source: tool });
  }

  return { admitted, refused };
}
