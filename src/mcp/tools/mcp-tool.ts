/**
 * Turning an admitted MCP tool into an ordinary `AgentTool` (§35).
 *
 * §35 requires every MCP capability to pass through schema, policy, permission
 * and audit. This file is how: it produces a tool the existing registry
 * dispatches like any other, so there is no second dispatch path, no second
 * policy call site and no second audit adapter. An MCP tool is an `AgentTool`
 * or it does not exist.
 *
 * Four things are fixed here rather than taken from the server.
 *
 * **The name** is `mcp__<serverId>__<tool>`, minted by `mcpToolName`, so a
 * discovered name cannot shadow a built-in and two servers offering `search`
 * stay two tools.
 *
 * **The risk** is `MCP_TOOL_RISK` — R3, which `evaluatePolicy` confirms in every
 * mode and which sits above everything a grant can express. `docs/MCP_GUIDE.md`
 * §5 is the argument. Nothing on this tool reads the server's opinion of it.
 *
 * **The site scope** is `destination`, and the destination is the server's URL
 * from the descriptor this factory closed over — *not* from the model's
 * arguments. That is the difference that matters: `classify` receives the
 * model's arguments, so a target it could read out of them is a target the
 * model could choose. Because the scope is a real URL, the policy engine's own
 * stages then apply to it: a blocked site refuses the call, and a
 * non-automatable origin refuses it too, which is why a loopback server works
 * only where insecure origins are permitted.
 *
 * **The payload declaration** is the arguments, with the server's origin as the
 * write destination, so the exfiltration gate sees an MCP call as what it is: a
 * transfer of task data to a third party. A tainted task sending page-derived
 * content to a server can therefore be denied rather than merely confirmed.
 *
 * ## What comes back
 *
 * Untrusted content, authored by the far side. It is returned as data and
 * carries taint, so the rest of the task treats it like page content: it cannot
 * silently become an instruction, and a later write that includes it meets the
 * exfiltration gate with the source recorded.
 */

import type { z } from 'zod';
import { ToolError } from '@/types/result';
import type {
  AgentTool,
  CallClassification,
  ToolExecutionContext,
  ToolExecutionResult,
} from '@/tools/core/tool-types';
import { mcpDestination } from '@/security/egress/destination';
import { MCP_TOOL_RISK, mcpToolName, type McpServerDescriptor } from '@/mcp/core/mcp-model';
import { compileToolSchema } from '@/mcp/core/mcp-schema';
import type { McpEgressContext, McpTransport } from '@/mcp/transport/mcp-transport';

/** How much of a tool result is kept. The server chooses the length. */
export const MAX_RESULT_CHARS = 20_000;

/** How long one MCP call may take. */
const TOOL_TIMEOUT_MS = 60_000;

/** The taint an MCP result contributes. */
export const MCP_TAINT_SOURCE = 'mcp_result';

/**
 * Where a tool gets the per-task security context a call needs.
 *
 * Supplied by the caller rather than read here, because the taint state and the
 * salt belong to the run and this file must not be the thing that decides what
 * they are.
 */
export type McpSecurityContextFor = (taskId: string) => Promise<Omit<McpEgressContext, 'method'>>;

export interface McpToolOptions {
  readonly server: McpServerDescriptor;
  readonly transport: McpTransport;
  /** The tool's name as the server gave it, before namespacing. */
  readonly remoteName: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly securityContextFor: McpSecurityContextFor;
}

export type McpToolRefusal = { readonly ok: false; readonly reason: string };

/**
 * Flattens MCP `content` into text.
 *
 * Only text parts are kept. An image or an embedded resource is named rather
 * than decoded: this build has no path that would do anything with binary a
 * server chose, and decoding one would be inventing a capability.
 */
function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry !== 'object' || entry === null) continue;
    const part = entry as Record<string, unknown>;
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
      continue;
    }
    parts.push(`[${typeof part.type === 'string' ? part.type.slice(0, 24) : 'unknown'} omitted]`);
  }
  return parts.join('\n');
}

/**
 * Builds the tool, or refuses with the reason.
 *
 * Refusal is a first-class outcome rather than a thrown error, because the
 * common case — a schema outside the compilable subset — is a tool the user
 * should be told about by name, alongside the ones that were admitted.
 */
export function createMcpTool(
  options: McpToolOptions,
): { readonly ok: true; readonly tool: AgentTool } | McpToolRefusal {
  const compiled = compileToolSchema(options.inputSchema);
  if (!compiled.ok) {
    return { ok: false, reason: `its arguments declare ${compiled.reason}` };
  }
  const schema = compiled.schema;
  const { server, transport, remoteName } = options;
  const name = mcpToolName(server.id, remoteName);

  // Bounded, and never used as an instruction. It reaches the model as part of
  // the tool list, which is why `admitDiscoveredTool` capped it already; this
  // is the fallback for a tool that declared none.
  const description =
    options.description !== undefined && options.description.trim().length > 0
      ? options.description.trim()
      : `A tool offered by ${server.displayName}.`;

  const tool: AgentTool<typeof schema> = {
    name,
    version: '1',
    description,
    inputSchema: schema,
    risk: MCP_TOOL_RISK,
    executionMode: 'requires_connector',
    // See the module comment: the destination is the descriptor's URL, closed
    // over here, never read from the model's arguments.
    siteAuthorization: 'destination',
    sideEffects: [`Sends these arguments to ${server.displayName} and runs its "${remoteName}".`],
    timeoutMs: TOOL_TIMEOUT_MS,
    // Nothing is known about what the far side does. Declaring a call from an
    // unknown server retryable would be asserting that repeating it is free.
    idempotent: false,

    classify(input: z.infer<typeof schema>): CallClassification {
      return {
        risk: MCP_TOOL_RISK,
        targetUrl: server.url,
        writeDestination: server.url,
        writePayload: input,
        egress: {
          destination: mcpDestination(server.id, server.url, { method: 'tools/call' }),
          payload: input,
        },
        summary: `Run "${remoteName}" on ${server.displayName}`,
      };
    },

    async execute(
      input: z.infer<typeof schema>,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      const security = await options.securityContextFor(context.taskId);
      const outcome = await transport.call(
        'tools/call',
        // `name` is the server's own name for it, not the namespaced one. The
        // namespace is this build's, and sending it back would ask the server
        // for a tool it never offered.
        { name: remoteName, arguments: input },
        { ...security, method: 'tools/call' },
      );

      if (!outcome.ok) {
        throw new ToolError('MCP_ERROR', `${name} was refused by ${server.id}.`, {
          userMessage: `${server.displayName} refused that request: ${outcome.message}`,
          retryable: false,
        });
      }

      const result =
        typeof outcome.result === 'object' && outcome.result !== null
          ? (outcome.result as Record<string, unknown>)
          : {};
      const text = flattenContent(result.content).slice(0, MAX_RESULT_CHARS);

      // `isError: true` is how MCP reports a tool-level failure, as distinct
      // from a protocol error. It is a failed call, not a successful one whose
      // content happens to say "error" — collapsing the two would let a server
      // report failure in a channel the agent reads as success.
      if (result.isError === true) {
        throw new ToolError('MCP_ERROR', `${name} reported a failure.`, {
          userMessage:
            text.length > 0
              ? `${server.displayName} could not do that: ${text.slice(0, 300)}`
              : `${server.displayName} could not do that.`,
          retryable: false,
        });
      }

      return {
        success: true,
        data: { text },
        // The result is content from a third party, so the task carries that
        // fact forward. A later write including it meets the exfiltration gate
        // with this source named.
        taint: [
          {
            sourceType: MCP_TAINT_SOURCE,
            site: new URL(server.url).hostname,
            sensitivity: 'internal',
          },
        ],
      };
    },
  };

  return { ok: true, tool };
}
