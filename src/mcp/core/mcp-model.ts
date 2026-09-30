/**
 * The MCP trust core (specification §35, §5.11).
 *
 * This file holds the decisions, not the transport. Everything here is a pure
 * function over data, because the questions it answers are the ones that must
 * be right *before* a socket exists: what may be added as a server, what risk a
 * tool from it carries, and what of a discovered tool is allowed to reach the
 * model at all.
 *
 * ## Which direction this is
 *
 * Stated first because the word "server" has meant two opposite things in this
 * project's notes. Here it always means **a server somebody else runs, which
 * this extension calls out to**. §5.11 asks for an `MCP client`; §35's diagram
 * runs `Agent Runtime → MCP Client → Remote/Local MCP → Tools/Resources`, all
 * downstream. Nothing in the specification asks this extension to *be* an MCP
 * server, and it must not become one: that needs an inbound channel, and every
 * inbound channel this manifest could offer is on the locked prohibition list.
 * So every risk discussed in this file is the risk of a third party this build
 * talks to, never the risk of somebody talking to this build.
 *
 * ## Where a tool's risk comes from
 *
 * Not from the server, and not from the user either.
 *
 * Not from the server for the reason `PLUGIN_TRUST_MODEL.md` gives — "a server
 * that could declare its own tool R0 would be a server that could decide it
 * needs no approval" — and that rules out the obvious alternative with it:
 * inferring risk from the tool's name, description or schema is accepting the
 * server's declaration through the back door, because the server authored all
 * three.
 *
 * Not from the user, which is the correction this file carries. An earlier
 * draft asked the user for a per-server *ceiling* and ran every tool from the
 * server at it. That is wrong in a way worth recording, because it looks
 * conservative: a ceiling is a number a user picks, and a user who picks a low
 * one — reasonably, for a server they think only reads — has auto-approved
 * every tool that server offers now and every tool it adds later. `R0` and `R1`
 * are below `AUTO_APPROVE_BELOW`, so those calls would never have been shown to
 * anybody. A mechanism whose safe setting is the one users have the least
 * reason to choose is not a safeguard.
 *
 * So risk is **classified here, at a fixed level, from what an MCP tool call
 * is**. An MCP tool call sends task data to a third-party endpoint and asks it
 * to act. `RISK_DESCRIPTIONS.R3` is "Sensitive external side effect. Writes
 * data outside the browser," which is that sentence exactly — including for a
 * tool that only reads on the far side, because the arguments still left the
 * browser. R3 is a classification, not a preference.
 *
 * What that buys, from code that already exists:
 *
 * - `evaluatePolicy` stage 5 returns `ALLOW_WITH_CONFIRMATION` at or above
 *   `ALWAYS_CONFIRM_AT` (R3) before the mode switch, so every MCP call is
 *   confirmed in `manual`, `auto` **and** `skip`.
 * - `MAX_GRANTABLE_RISK` is R2, so no site grant and no plan approval can
 *   pre-approve one. There is no approval-granularity question left to answer:
 *   it is per call, and it is per call because the range of grantable risk
 *   stops below where MCP begins.
 * - A tool a server adds after the fact inherits the same floor, so a changing
 *   tool set cannot widen authority. Nothing had to be pinned or versioned to
 *   get that.
 * - An unattended run reaches stage 6 only below R3, so a scheduled task cannot
 *   call an MCP tool at all; it fails closed with nobody to ask.
 *
 * The cost is stated rather than hidden: a read-only MCP tool is confirmed like
 * a write. That is the same trade the ceiling made, without the setting that
 * could be turned down.
 */

import type { RiskLevel } from '@/policy/risk-classifier';
import { isLoopbackHostname } from '@/security/origin/origin-validator';
import {
  MAX_ENDPOINT_URL,
  MAX_MCP_DISPLAY_NAME,
  MAX_MCP_SERVER_ID,
  MAX_MCP_TOOL_NAME,
} from '@/audit/boundaries';

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
}

/** How many resources one server may contribute. */
const MAX_RESOURCES = 64;
/** How long a resource URI may be before it is refused. */
const MAX_URI = 512;

/** A resource as the server described it: untrusted input. */
export interface DiscoveredResource {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

/**
 * A resource this build is willing to name.
 *
 * The URI is kept because the model has to be able to ask for one, and it is the
 * server's own identifier for its own content — but it is deliberately never
 * recorded in the audit trail. A resource URI is page-derived text, and putting
 * it in a cross-task trail is the browsing-history problem `taintKind` exists to
 * avoid for taint sources.
 */
export interface AdmittedResource {
  readonly uri: string;
  /** Always present: falls back to the URI when the server named nothing. */
  readonly label: string;
  readonly description?: string;
  readonly mimeType?: string;
}

/**
 * Decides whether a discovered resource may be offered at all.
 *
 * The URI is checked as a *string*, not resolved: nothing in this build fetches
 * it. It travels back to the server as a parameter, and the server decides what
 * it means. So the rules here are about what may reach the model's context and a
 * log line, which is why length and control characters matter and scheme does
 * not — a server is entitled to its own URI space.
 */
export function admitDiscoveredResource(
  resource: DiscoveredResource,
):
  | { readonly ok: true; readonly resource: AdmittedResource }
  | { readonly ok: false; readonly reason: string } {
  const uri = typeof resource.uri === 'string' ? resource.uri.trim() : '';
  if (uri.length === 0) return { ok: false, reason: 'the resource has no URI' };
  if (uri.length > MAX_URI) {
    return { ok: false, reason: `a URI longer than ${MAX_URI} characters` };
  }
  // Control characters would break a log line and a prompt envelope alike.
  // eslint-disable-next-line no-control-regex -- matching them is the point
  if (/[\u0000-\u001f\u007f]/.test(uri)) {
    return { ok: false, reason: 'a URI holding control characters' };
  }
  const name = typeof resource.name === 'string' ? resource.name.trim() : '';
  if (name.length > MAX_DESCRIPTION) {
    return { ok: false, reason: `a name longer than ${MAX_DESCRIPTION} characters` };
  }
  if (resource.description !== undefined && typeof resource.description !== 'string') {
    return { ok: false, reason: 'a description that is not text' };
  }
  if ((resource.description ?? '').length > MAX_DESCRIPTION) {
    return { ok: false, reason: `a description longer than ${MAX_DESCRIPTION} characters` };
  }
  const mimeType = typeof resource.mimeType === 'string' ? resource.mimeType.trim() : '';
  if (mimeType.length > 128 || /[^A-Za-z0-9/+.;= -]/.test(mimeType)) {
    return { ok: false, reason: 'a media type that is not usable' };
  }
  return {
    ok: true,
    resource: {
      uri,
      // The URI is the fallback rather than an invented name: a resource with no
      // label is still something the user can recognise by its own identifier.
      label: name.length > 0 ? name : uri,
      ...(resource.description === undefined || resource.description.length === 0
        ? {}
        : { description: resource.description }),
      ...(mimeType.length === 0 ? {} : { mimeType }),
    },
  };
}

/**
 * Admits a whole resource listing, bounded and deduplicated.
 *
 * Bounded for the reason the tool listing is: the count comes from the server,
 * and a listing of ten thousand resources would be a context-exhaustion channel.
 * A repeated URI keeps the first, because the second would otherwise silently
 * describe the same identifier differently.
 */
export function admitResourceListing(resources: readonly DiscoveredResource[]): {
  readonly admitted: readonly AdmittedResource[];
  readonly refused: readonly { readonly uri: string; readonly reason: string }[];
} {
  const admitted: AdmittedResource[] = [];
  const refused: { uri: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const [index, resource] of resources.entries()) {
    const label = typeof resource?.uri === 'string' ? resource.uri.slice(0, MAX_URI) : `#${index}`;
    if (index >= MAX_RESOURCES) {
      refused.push({ uri: label, reason: `more than ${MAX_RESOURCES} resources were offered` });
      continue;
    }
    const verdict = admitDiscoveredResource(resource ?? { uri: '' });
    if (!verdict.ok) {
      refused.push({ uri: label, reason: verdict.reason });
      continue;
    }
    if (seen.has(verdict.resource.uri)) {
      refused.push({ uri: label, reason: 'that URI was offered more than once' });
      continue;
    }
    seen.add(verdict.resource.uri);
    admitted.push(verdict.resource);
  }

  return { admitted, refused };
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
 * The risk every MCP tool carries.
 *
 * R3 because that is what `RISK_DESCRIPTIONS.R3` describes — a sensitive
 * external side effect, data written outside the browser — and an MCP call is
 * that whatever the far side does with it. See the header for what the existing
 * thresholds then do with an R3 tool, which is the whole of the design.
 */
export const MCP_TOOL_RISK: RiskLevel = 'R3';

/**
 * The risk a discovered tool carries.
 *
 * It takes no argument, and that is the point rather than an economy: there is
 * no value a server, a schema, a tool name or a stored setting could supply
 * that reaches this answer. A test holds `mcpToolRisk.length` at zero, so a
 * later parameter — the shape every "just let the server hint at it" change
 * would arrive in — fails rather than merges.
 */
export function mcpToolRisk(): RiskLevel {
  return MCP_TOOL_RISK;
}

/**
 * Checks a server before it can be added.
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
  // And it has to survive that *within the field the derived name is recorded
  // in*. This bound did not exist, so a long id produced a tool name past the
  // audit log's limit and every invocation of the server lost its record while
  // the calls themselves went through. Registration-time is the only place to
  // refuse it: by the time a name is derived the server is already configured.
  else if (id.length > MAX_MCP_SERVER_ID) {
    problems.push(`a server id may be at most ${MAX_MCP_SERVER_ID} characters`);
  }

  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (displayName.length === 0) problems.push('a display name is required');
  else if (displayName.length > MAX_MCP_DISPLAY_NAME) {
    problems.push(`a display name may be at most ${MAX_MCP_DISPLAY_NAME} characters`);
  }

  const rawUrl = typeof input.url === 'string' ? input.url.trim() : '';
  if (rawUrl.length === 0) problems.push('a server URL is required');
  else if (rawUrl.length > MAX_ENDPOINT_URL) {
    // The URL is recorded verbatim when the server is added, so it has the same
    // problem the id had.
    problems.push(`a server URL may be at most ${MAX_ENDPOINT_URL} characters`);
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(rawUrl);
    } catch {
      problems.push(`"${rawUrl}" is not a usable URL`);
    }
    if (parsed !== null && parsed.protocol !== 'https:' && !isLoopbackHostname(parsed.hostname)) {
      // Every call carries whatever credential the server needs, so plaintext
      // is refused. Loopback is allowed so a local mock can be driven over
      // real sockets, which is how the connectors are tested.
      problems.push(`"${rawUrl}" is not https`);
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, server: { id, displayName, url: rawUrl } };
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
  // The name is server-authored, and it is prefixed with the server id before it
  // reaches the audit log's `tool` field. The count of tools was bounded and the
  // description was bounded, but the name was not — so one long name was enough
  // to make every invocation of that tool unrecordable. Refused rather than
  // truncated: two names sharing a truncated form would become one tool.
  if (name.length > MAX_MCP_TOOL_NAME) {
    return { ok: false, reason: `"${name}" is longer than ${MAX_MCP_TOOL_NAME} characters` };
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
