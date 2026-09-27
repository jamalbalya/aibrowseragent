/**
 * Connecting stored servers and registering their tools (P-026).
 *
 * This is the caller every layer beneath it was missing. It reads the store,
 * discovers what each server offers, builds an `AgentTool` per admitted tool and
 * registers it — so an MCP tool becomes reachable through the one dispatch path
 * and nowhere else.
 *
 * Three properties belong here rather than further down.
 *
 * **A failing server does not take the others with it.** Each server is
 * attempted independently and its failure is reported by name. One unreachable
 * endpoint must not cost the user the tools from the ones that answered, and it
 * must not stop the extension starting.
 *
 * **Registration is a fresh reading every time.** Nothing caches a tool list
 * across a worker generation. That is the property that makes revocation free:
 * removing a server removes its tools, because the tools only ever existed as a
 * function of the record and the answer the server just gave. There is no
 * residual grant, and nothing to invalidate.
 *
 * **A previously registered server's tools are replaced, never merged.** A
 * server that used to offer `delete_everything` and no longer does must not keep
 * it, so a re-registration unregisters what the server contributed before
 * putting back what it contributes now.
 */

import { getLogger } from '@/logging/logger';
import type { ToolRegistry } from '@/tools/registry/tool-registry';
import { isMcpToolName, mcpToolName, type McpServerDescriptor } from './mcp-model';
import { discover, McpDiscoveryError } from './mcp-discovery';
import type { McpServerStore } from './mcp-server-store';
import { createMcpTool, type McpSecurityContextFor } from '@/mcp/tools/mcp-tool';
import type { McpTransport } from '@/mcp/transport/mcp-transport';

const log = getLogger('security');

/** What happened for one server. Reported, never thrown away. */
export interface McpServerOutcome {
  readonly serverId: string;
  readonly registered: readonly string[];
  /** Tools the server offered that this build will not expose, with reasons. */
  readonly refused: readonly { readonly name: string; readonly reason: string }[];
  /** Why the server contributed nothing at all, when that is the case. */
  readonly failure?: string;
}

export interface McpRegistrarOptions {
  readonly store: McpServerStore;
  readonly registry: ToolRegistry;
  /** Builds the transport for one server. Injected so the socket stays a seam. */
  readonly transportFor: (server: McpServerDescriptor) => McpTransport;
  readonly securityContextFor: McpSecurityContextFor;
}

/**
 * Discovers and registers every stored server's tools.
 *
 * Returns one outcome per server, in store order, whether it succeeded or not:
 * the side panel shows the user what each server contributed and why anything
 * was left out, and a silent refusal would present a server that answered
 * strangely as one offering nothing.
 */
export async function registerMcpServers(
  options: McpRegistrarOptions,
): Promise<readonly McpServerOutcome[]> {
  const servers = await options.store.list();
  const outcomes: McpServerOutcome[] = [];

  for (const server of servers) {
    // Replaced rather than merged: a tool the server has stopped offering must
    // stop existing, and the only way to be sure is to take them all down
    // first.
    unregisterServer(options.registry, server.id);

    const transport = options.transportFor(server);
    try {
      const security = await options.securityContextFor('mcp-registration');
      const found = await discover(transport, server, { ...security, method: 'initialize' });

      const registered: string[] = [];
      const refused = [...found.refused];

      for (const admitted of found.admitted) {
        const built = createMcpTool({
          server,
          transport,
          remoteName: remoteNameOf(server.id, admitted.name),
          ...(admitted.source.description === undefined
            ? {}
            : { description: admitted.source.description }),
          inputSchema: admitted.source.inputSchema,
          securityContextFor: options.securityContextFor,
        });
        if (!built.ok) {
          // A schema outside the compilable subset. Named rather than dropped:
          // the user should be able to see which tool this build will not
          // expose and why, because their own client may show it working.
          refused.push({ name: admitted.name, reason: built.reason });
          continue;
        }
        options.registry.register(built.tool);
        registered.push(built.tool.name);
      }

      outcomes.push({ serverId: server.id, registered, refused });
    } catch (caught) {
      // Independent on purpose: one unreachable endpoint must not cost the user
      // the tools from the servers that answered, and must not stop startup.
      const failure =
        caught instanceof McpDiscoveryError || caught instanceof Error
          ? caught.message
          : 'The server could not be reached.';
      log.warn('An MCP server contributed no tools.', { serverId: server.id });
      outcomes.push({ serverId: server.id, registered: [], refused: [], failure });
    }
  }

  return outcomes;
}

/**
 * Removes every tool a server contributed.
 *
 * Matches on the namespaced prefix, which is why the prefix exists: there is no
 * separate index of which tools came from where to fall out of step with the
 * registry.
 */
export function unregisterServer(registry: ToolRegistry, serverId: string): readonly string[] {
  const prefix = mcpToolName(serverId, '');
  const removed: string[] = [];
  for (const tool of registry.list()) {
    if (!isMcpToolName(tool.name)) continue;
    if (!tool.name.startsWith(prefix)) continue;
    registry.unregister(tool.name);
    removed.push(tool.name);
  }
  return removed;
}

/** `mcp__example__search` → `search`, for the server's own vocabulary. */
function remoteNameOf(serverId: string, namespaced: string): string {
  return namespaced.slice(mcpToolName(serverId, '').length);
}
