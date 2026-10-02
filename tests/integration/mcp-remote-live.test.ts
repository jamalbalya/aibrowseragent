/**
 * TEST-MCPREMOTE-001 — this client against a remote MCP server somebody else runs.
 *
 * ## Why this exists, and what it corrects
 *
 * P-026-C2 asks for remote MCP. It stood `EXTERNAL_REQUIRED` with the blocker
 * *"A real remote MCP server, and any credential it requires. This repository
 * holds neither."* The second half of that sentence was an assumption, and it
 * was wrong: remote MCP servers exist that are public, documented and need no
 * credential at all. One of them answered a conformant `initialize` on the first
 * attempt.
 *
 * This is the second time that mistake has been found in the same clause family.
 * `mcp-interop.test.ts` says it about P-026-C3: *"It was not external.
 * `@modelcontextprotocol/server-everything` is the MCP project's own reference
 * server … so the classification was hiding work that was possible all along."*
 * Driving that server found two client defects immediately. The lesson did not
 * generalise one clause to the left, so it is written down here as well: an
 * `EXTERNAL_REQUIRED` blocker that names a credential should be checked for
 * whether a credential is actually needed.
 *
 * ## What `mcp-interop.test.ts` cannot establish
 *
 * That suite runs the reference server on loopback, and says so: *"running a
 * package on loopback is not that"*. It proves the client against a server it
 * did not write; it cannot prove it against a **network**, a TLS termination, a
 * third party's framing choices, or schemas written by someone with no knowledge
 * of this build's subset. That is what this file is for.
 *
 * ## Opt-in, deliberately
 *
 * `MCP_REMOTE_TEST_URL` has no default and every case skips without it. A suite
 * that reached a third party on every build would make this repository's green
 * depend on somebody else's uptime — which is the reason `mcp-interop` runs a
 * local reference server rather than a hosted one. The evidence is produced by
 * running it on purpose and recording what happened.
 *
 * ```
 * MCP_REMOTE_TEST_URL=https://mcp.deepwiki.com/mcp \
 *   npx vitest run tests/integration/mcp-remote-live.test.ts
 * ```
 *
 * ## What is sent
 *
 * `initialize`, `tools/list` and `resources/list`. No page content, no task
 * data, no credential — the descriptor carries no auth and the context is a
 * fresh taint with nothing in it. Nothing here calls a tool: invoking a stranger's
 * tool is a different act from discovering it, and discovery is what the clause
 * asks for.
 */
import { describe, expect, it } from 'vitest';
import { createMcpTransport } from '@/mcp/transport/mcp-transport';
import { discover } from '@/mcp/core/mcp-discovery';
import { compileToolSchema } from '@/mcp/core/mcp-schema';
import { mcpToolName } from '@/mcp/core/mcp-model';
import { ConsentStore } from '@/security/egress/consent';
import { freshTaint } from '@/security/taint/taint-state';
import type { McpDiscovery } from '@/mcp/core/mcp-discovery';
import type { McpServerDescriptor } from '@/mcp/core/mcp-model';
import type { McpTransport } from '@/mcp/transport/mcp-transport';

const URL_FROM_ENV = process.env.MCP_REMOTE_TEST_URL ?? '';
const CONFIGURED = URL_FROM_ENV.length > 0;

const SERVER: McpServerDescriptor = {
  id: 'remote',
  displayName: 'Remote MCP server',
  url: URL_FROM_ENV,
};

const CONTEXT = {
  taskId: 'task_remote_mcp',
  taintState: freshTaint(),
  taintSalt: 'ab'.repeat(32),
  taintSignature: 'remote-mcp',
};

/** A transport per call, because a session belongs to one conversation. */
function transport(server: McpServerDescriptor = SERVER): McpTransport {
  return createMcpTransport({
    server,
    consent: new ConsentStore(),
    // The real one. The point of this file is the network.
    fetchImpl: globalThis.fetch.bind(globalThis),
  });
}

/**
 * Discovery is run once, at module scope, and shared.
 *
 * Two reasons. `it.skipIf(...)` is evaluated while the file is being collected,
 * so a flag set in `beforeAll` is still false when every guard is read and the
 * whole file skips silently — the failure mode that cost a run in the 9Router
 * live suite. And a stranger's server should be asked once rather than once per
 * case.
 */
const probe = await (async (): Promise<{ found: McpDiscovery | null; error: string }> => {
  if (!CONFIGURED) return { found: null, error: 'not configured' };
  try {
    return { found: await discover(transport(), SERVER, CONTEXT as never), error: '' };
  } catch (error) {
    return { found: null, error: error instanceof Error ? error.message : String(error) };
  }
})();

const found = probe.found;
const LIVE = CONFIGURED && found !== null;

process.stdout.write(
  !CONFIGURED
    ? '[MCPREMOTE] skipped: MCP_REMOTE_TEST_URL not set.\n'
    : found === null
      ? `[MCPREMOTE] skipped: ${URL_FROM_ENV} did not complete discovery — ${probe.error}\n`
      : `[MCPREMOTE] live: ${URL_FROM_ENV} · ${found.admitted.length} tool(s) admitted, ` +
        `${found.refused.length} refused.\n`,
);

describe('TEST-MCPREMOTE-001 — the handshake, over a real network', () => {
  it.skipIf(!CONFIGURED)('01 — the server is reachable and completed discovery', () => {
    expect(found, `discovery failed: ${probe.error}`).not.toBeNull();
  });

  it.skipIf(!LIVE)('02 — agrees on the revision this build declares, or declines', () => {
    // The client does not negotiate down, so agreement here is agreement on the
    // one revision this build implements.
    expect(found!.handshake.protocolVersion).toBe('2025-06-18');
  });

  it.skipIf(!LIVE)('03 — the server is at an origin this repository does not operate', () => {
    // The whole point of the clause, and the thing loopback cannot establish.
    const url = new URL(URL_FROM_ENV);
    expect(url.protocol).toBe('https:');
    expect(['localhost', '127.0.0.1', '::1', '0.0.0.0']).not.toContain(url.hostname);
    // A hostname with a dot that is not loopback: a real name, resolved by DNS.
    expect(url.hostname).toContain('.');
  });

  it.skipIf(!LIVE)('04 — a plain-http remote server is refused, not downgraded to', () => {
    // The transport's own rule, checked against the same host so the only
    // difference is the scheme.
    const insecure: McpServerDescriptor = {
      ...SERVER,
      url: URL_FROM_ENV.replace(/^https:/, 'http:'),
    };
    return expect(discover(transport(insecure), insecure, CONTEXT as never)).rejects.toBeInstanceOf(
      Error,
    );
  });
});

describe('TEST-MCPREMOTE-001 — what the server offered, admitted by this build', () => {
  it.skipIf(!LIVE)('05 — every admitted tool is namespaced by server', () => {
    // Two servers offering `search` must be two tools, and a remote server must
    // not be able to claim a built-in name.
    expect(found!.admitted.length).toBeGreaterThan(0);
    for (const entry of found!.admitted) {
      expect(entry.name, entry.name).toBe(mcpToolName(SERVER.id, entry.source.name));
      expect(entry.name.startsWith(`mcp__${SERVER.id}__`), entry.name).toBe(true);
    }
  });

  it.skipIf(!LIVE)('06 — nothing the server sent disappeared silently', () => {
    // Admitted plus refused accounts for everything, and each refusal carries a
    // reason. A tool that vanished without one would be a list the user cannot
    // reason about.
    for (const refusal of found!.refused) {
      expect(refusal.reason.trim().length, refusal.name).toBeGreaterThan(0);
    }
    for (const refusal of found!.refusedResources) {
      expect(refusal.reason.trim().length, refusal.uri).toBeGreaterThan(0);
    }
  });

  it.skipIf(!LIVE)('07 — the schema subset is enforced against schemas written elsewhere', () => {
    // The documented cost, measured for the first time against a real server.
    //
    // `mcp-schema.ts` compiles a subset and refuses the rest by name, and says
    // what that buys: *"some servers will offer tools this build cannot use —
    // and it is the right direction, because the alternative to refusing a
    // schema is guessing at it."* Every outcome here must be one or the other:
    // a compiled schema, or a refusal that names the keyword. Never a guess.
    let compiled = 0;
    let refused = 0;
    for (const entry of found!.admitted) {
      const outcome = compileToolSchema(entry.source.inputSchema);
      if (outcome.ok) {
        compiled += 1;
        expect(outcome.schema, entry.name).toBeDefined();
      } else {
        refused += 1;
        // Named, not vague. The reason reaches a person deciding what to do.
        expect(outcome.reason.trim().length, entry.name).toBeGreaterThan(0);
      }
    }
    expect(compiled + refused).toBe(found!.admitted.length);
    // At least one usable tool, or this server tells us nothing about the
    // compiler working — only about it refusing.
    expect(compiled, 'no tool on this server compiled').toBeGreaterThan(0);
  });
});

describe('TEST-MCPREMOTE-001 — nothing of ours went to the stranger', () => {
  it.skipIf(!LIVE)('08 — the descriptor carries no credential, so none was sent', () => {
    // The clause's old blocker assumed a credential was required. It was not,
    // and this is the assertion that the discovery above really did happen
    // without one — a server that needed one would have refused.
    expect('auth' in SERVER).toBe(false);
    expect(JSON.stringify(SERVER)).not.toMatch(/token|secret|key|bearer/i);
  });

  it.skipIf(!LIVE)(
    '09 — discovery sends no task data, only the three list calls',
    async () => {
      // Observed rather than argued: the bodies are captured and read.
      const bodies: string[] = [];
      const watched = createMcpTransport({
        server: SERVER,
        consent: new ConsentStore(),
        fetchImpl: ((url: string, init: RequestInit) => {
          bodies.push(typeof init.body === 'string' ? init.body : '');
          return globalThis.fetch(url, init);
        }) as unknown as typeof fetch,
      });
      await discover(watched, SERVER, CONTEXT as never);

      const methods = bodies
        .map((body) => {
          try {
            return (JSON.parse(body) as { method?: string }).method ?? '';
          } catch {
            return '';
          }
        })
        .filter((method) => method.length > 0);
      expect(methods.length).toBeGreaterThan(0);
      for (const method of methods) {
        expect(['initialize', 'tools/list', 'resources/list'], method).toContain(method);
      }
      // No taint salt, no task objective, nothing from a page.
      const sent = bodies.join('\n');
      expect(sent).not.toContain(CONTEXT.taintSalt);
      expect(sent).not.toContain(CONTEXT.taskId);
    },
    60_000,
  );
});
