/**
 * TEST-MCP-007 — MCP resources (§5.11 `resource discovery where applicable`).
 *
 * A resource is data a server offers, which makes it the injection channel
 * `PLUGIN_TRUST_MODEL.md` names when it says "MCP introduces an injection
 * channel". So the cases here are about three things: what may be offered at
 * all, what the model may then ask for, and what the content is treated as when
 * it comes back.
 *
 * The listing and the read are both R3. There is deliberately no read-only
 * exception, because a read-only exception is exactly the shape the withdrawn
 * per-server ceiling had.
 */
import { describe, expect, it } from 'vitest';
import { createHarness, ScriptedPrompter } from '../fixtures/policy-harness';
import { ToolError } from '@/types/result';
import { freshTaint } from '@/security/taint/taint-state';
import {
  MCP_TOOL_RISK,
  admitDiscoveredResource,
  admitResourceListing,
  type McpServerDescriptor,
} from '@/mcp/core/mcp-model';
import {
  MAX_RESOURCE_CHARS,
  RESOURCE_LIST_TOOL,
  RESOURCE_READ_TOOL,
  createMcpResourceTools,
} from '@/mcp/tools/mcp-resource-tools';
import { MCP_PROTOCOL_VERSION, discover } from '@/mcp/core/mcp-discovery';
import { MCP_TAINT_SOURCE } from '@/mcp/tools/mcp-tool';
import type { McpRpcOutcome, McpTransport } from '@/mcp/transport/mcp-transport';
import type { AgentTool } from '@/tools/core/tool-types';

const SERVER: McpServerDescriptor = {
  id: 'docs',
  displayName: 'Docs',
  url: 'https://mcp.docs.test/rpc',
};

const TASK = 'task-1';

const security = () =>
  Promise.resolve({
    taskId: TASK,
    taintState: freshTaint(),
    taintSalt: 'ab'.repeat(32),
    saltEpoch: 1,
    taintSignature: 'sig',
  });

/** The egress context discovery takes, with the method it starts on. */
const discoveryContext = async () => ({ ...(await security()), method: 'initialize' as const });

/** A transport whose resource answers are scripted. */
function scripted(replies: {
  resources?: readonly unknown[];
  listOutcome?: McpRpcOutcome;
  read?: McpRpcOutcome;
  declaresResources?: boolean;
}): { transport: McpTransport; calls: string[] } {
  const calls: string[] = [];
  const transport: McpTransport = {
    call(method): Promise<McpRpcOutcome> {
      calls.push(method);
      if (method === 'initialize') {
        return Promise.resolve({
          ok: true,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
              tools: {},
              ...(replies.declaresResources === false ? {} : { resources: {} }),
            },
          },
        });
      }
      if (method === 'tools/list') return Promise.resolve({ ok: true, result: { tools: [] } });
      if (method === 'resources/list') {
        return Promise.resolve(
          replies.listOutcome ?? { ok: true, result: { resources: replies.resources ?? [] } },
        );
      }
      if (method === 'resources/read') {
        return Promise.resolve(
          replies.read ?? { ok: true, result: { contents: [{ text: 'the contents' }] } },
        );
      }
      return Promise.resolve({ ok: false, code: -32601, message: 'no' });
    },
  };
  return { transport, calls };
}

const RESOURCE = { uri: 'docs://guide', name: 'Guide', mimeType: 'text/markdown' };

function tools(
  over: Parameters<typeof createMcpResourceTools>[0]['resources'] = [RESOURCE_ADMITTED],
) {
  const { transport } = scripted({});
  return createMcpResourceTools({
    server: SERVER,
    transport,
    resources: over,
    securityContextFor: security,
  });
}

const RESOURCE_ADMITTED = { uri: 'docs://guide', label: 'Guide', mimeType: 'text/markdown' };

describe('01 what a server may offer', () => {
  it('admits an ordinary resource and keeps its own identifier', () => {
    const verdict = admitDiscoveredResource(RESOURCE);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.resource).toEqual(RESOURCE_ADMITTED);
  });

  it('falls back to the URI as the label rather than inventing a name', () => {
    // A resource with no name is still something a person can recognise by its
    // own identifier.
    const verdict = admitDiscoveredResource({ uri: 'docs://raw' });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.resource.label).toBe('docs://raw');
  });

  it('refuses a URI holding control characters, which would break a log line', () => {
    const verdict = admitDiscoveredResource({ uri: 'docs://a\u0000b' });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('control characters');
  });

  it('refuses a URI, name, description or media type the server made too long', () => {
    expect(admitDiscoveredResource({ uri: 'x'.repeat(600) }).ok).toBe(false);
    expect(admitDiscoveredResource({ uri: 'docs://a', name: 'n'.repeat(500) }).ok).toBe(false);
    expect(admitDiscoveredResource({ uri: 'docs://a', description: 'd'.repeat(500) }).ok).toBe(
      false,
    );
    expect(admitDiscoveredResource({ uri: 'docs://a', mimeType: 'text/<script>' }).ok).toBe(false);
  });

  it('does not resolve the URI, because nothing here fetches one', () => {
    // A server is entitled to its own URI space, so scheme is not checked. What
    // is checked is what may reach the model's context and a log line.
    expect(admitDiscoveredResource({ uri: 'weird-scheme:opaque' }).ok).toBe(true);
    expect(admitDiscoveredResource({ uri: 'file:///etc/passwd' }).ok).toBe(true);
  });

  it('bounds a listing and names every refusal', () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ uri: `docs://r${i}` }));
    const listing = admitResourceListing(many);
    expect(listing.admitted).toHaveLength(64);
    expect(listing.refused.some((entry) => entry.reason.includes('more than 64'))).toBe(true);
  });

  it('keeps the first of a repeated URI and says the second was refused', () => {
    const listing = admitResourceListing([
      { uri: 'docs://a', name: 'First' },
      { uri: 'docs://a', name: 'Second' },
    ]);
    expect(listing.admitted).toHaveLength(1);
    expect(listing.admitted[0]?.label).toBe('First');
    expect(listing.refused[0]?.reason).toContain('more than once');
  });

  it('survives a listing that is not shaped like one', () => {
    const listing = admitResourceListing([null, 3, 'x', { uri: 'docs://ok' }] as never);
    expect(listing.admitted.map((r) => r.uri)).toEqual(['docs://ok']);
    expect(listing.refused).toHaveLength(3);
  });
});

describe('02 when discovery asks for resources at all', () => {
  it('asks when the server declared the capability', async () => {
    const { transport, calls } = scripted({ resources: [RESOURCE] });
    const found = await discover(transport, SERVER, await discoveryContext());
    expect(calls).toContain('resources/list');
    expect(found.resources).toEqual([RESOURCE_ADMITTED]);
  });

  it('does not ask when the server declared none', async () => {
    // Asking a server with no resources produces a -32601 that has to be told
    // apart from a real refusal, and there is nothing to lose by not asking.
    const { transport, calls } = scripted({ declaresResources: false });
    const found = await discover(transport, SERVER, await discoveryContext());
    expect(calls).not.toContain('resources/list');
    expect(found.resources).toEqual([]);
  });

  it('keeps the server’s tools when the resource listing fails', async () => {
    // A resource listing is supplementary. Losing it must not cost the user the
    // server's tools, which is why this is not an error like `tools/list`.
    const { transport } = scripted({
      listOutcome: { ok: false, code: -32603, message: 'broken' },
    });
    const found = await discover(transport, SERVER, await discoveryContext());
    expect(found.resources).toEqual([]);
    expect(found.refusedResources[0]?.reason).toBe('broken');
    expect(found.handshake.declaresResources).toBe(true);
  });
});

describe('03 the two tools, and the risk they carry', () => {
  it('exist only when the server offered something', () => {
    expect(tools([])).toEqual([]);
    expect(tools([RESOURCE_ADMITTED]).map((tool) => tool.name)).toEqual([
      `mcp__docs__${RESOURCE_LIST_TOOL}`,
      `mcp__docs__${RESOURCE_READ_TOOL}`,
    ]);
  });

  it('are both R3, with no read-only exception for the listing', () => {
    // A read-only exception is exactly the shape the withdrawn per-server
    // ceiling had. The call itself tells the server this browser is asking.
    for (const tool of tools()) {
      expect(tool.risk, tool.name).toBe(MCP_TOOL_RISK);
      expect(tool.classify?.({ uri: 'docs://guide' }, {} as never)?.risk).toBe(MCP_TOOL_RISK);
    }
  });

  it('are confirmed on every call, in every permission mode', async () => {
    for (const mode of ['manual', 'auto', 'skip'] as const) {
      const prompter = new ScriptedPrompter();
      const all = tools();
      const harness = createHarness(all, { mode, prompter });
      await harness.registry.dispatch({
        taskId: TASK,
        sessionId: 's',
        toolCallId: 'c',
        name: `mcp__docs__${RESOURCE_LIST_TOOL}`,
        arguments: {},
        signal: new AbortController().signal,
      });
      expect(prompter.seen, mode).toHaveLength(1);
    }
  });

  it('both name the server in the prompt, so neither asks about nothing', async () => {
    // The same gap the tool-dispatch suite had: `siteAuthorization:
    // 'destination'` was declared on both resource tools and pinned by nothing,
    // so removing it broke no test while leaving the confirmation with no site
    // at all. Taking the destination from the descriptor, tested below, is a
    // different fact — it is this declaration that carries it into the prompt.
    for (const name of [RESOURCE_LIST_TOOL, RESOURCE_READ_TOOL]) {
      const tool = tools().find((candidate) => candidate.name.endsWith(name)) as AgentTool;
      expect(tool.siteAuthorization, name).toBe('destination');

      const prompter = new ScriptedPrompter();
      const harness = createHarness(tools(), { mode: 'manual', prompter });
      await harness.registry.dispatch({
        taskId: TASK,
        sessionId: 's',
        toolCallId: 'c',
        name: `mcp__docs__${name}`,
        arguments: name === RESOURCE_READ_TOOL ? { uri: 'docs://guide' } : {},
        signal: new AbortController().signal,
      });

      expect(prompter.seen, name).toHaveLength(1);
      // The registrable domain, as every site grant in this product is.
      expect(prompter.seen[0]?.site, name).toBe('docs.test');
      expect(prompter.seen[0]?.targetUrl, name).toBe(SERVER.url);
    }
  });

  it('takes the destination from the descriptor, not from the arguments', () => {
    const read = tools().find((tool) => tool.name.endsWith(RESOURCE_READ_TOOL)) as AgentTool;
    const classified = read.classify?.(
      { uri: 'docs://guide', url: 'https://attacker.test' },
      {} as never,
    );
    expect(classified?.targetUrl).toBe(SERVER.url);
    expect(classified?.writeDestination).toBe(SERVER.url);
  });

  it('summarises a read by the label, never by the URI', () => {
    // A URI is page-derived text, and the summary is shown in a prompt and
    // recorded with the decision.
    const read = tools().find((tool) => tool.name.endsWith(RESOURCE_READ_TOOL)) as AgentTool;
    const summary = read.classify?.({ uri: 'docs://guide' }, {} as never)?.summary ?? '';
    expect(summary).toContain('Guide');
    expect(summary).not.toContain('docs://guide');
  });
});

describe('04 what the model may ask for', () => {
  it('answers the listing from the reading already taken', async () => {
    // So the listing the user saw in the panel and the listing the model is
    // given are the same one: a server cannot offer the model something it did
    // not offer the person.
    const list = tools().find((tool) => tool.name.endsWith(RESOURCE_LIST_TOOL)) as AgentTool;
    const result = await list.execute({}, { taskId: TASK } as never);
    expect(result.data).toEqual({
      resources: [{ uri: 'docs://guide', label: 'Guide', mimeType: 'text/markdown' }],
    });
  });

  it('refuses a URI the server never offered, before any request', async () => {
    // Nothing here would fetch it — but the *server* would be asked to, which
    // is a request the user never saw offered and this build would have
    // originated.
    const { transport, calls } = scripted({});
    const [, read] = createMcpResourceTools({
      server: SERVER,
      transport,
      resources: [RESOURCE_ADMITTED],
      securityContextFor: security,
    });
    await expect(
      read!.execute({ uri: 'docs://something-else' }, { taskId: TASK } as never),
    ).rejects.toThrow(/did not offer/);
    expect(calls).toEqual([]);
  });

  it('refuses an argument the schema never declared', async () => {
    const prompter = new ScriptedPrompter();
    const harness = createHarness(tools(), { mode: 'auto', prompter });
    const result = await harness.registry.dispatch({
      taskId: TASK,
      sessionId: 's',
      toolCallId: 'c',
      name: `mcp__docs__${RESOURCE_READ_TOOL}`,
      arguments: { uri: 'docs://guide', follow: true },
      signal: new AbortController().signal,
    });
    expect(result.envelope.status).toBe('error');
  });

  it('sends only the URI, and asks by the protocol method', async () => {
    const { transport, calls } = scripted({});
    const [, read] = createMcpResourceTools({
      server: SERVER,
      transport,
      resources: [RESOURCE_ADMITTED],
      securityContextFor: security,
    });
    await read!.execute({ uri: 'docs://guide' }, { taskId: TASK } as never);
    expect(calls).toEqual(['resources/read']);
  });
});

describe('05 what the content is treated as', () => {
  const read = () => tools().find((tool) => tool.name.endsWith(RESOURCE_READ_TOOL)) as AgentTool;

  it('taints the task, so a later write meets the exfiltration gate', async () => {
    const result = await read().execute({ uri: 'docs://guide' }, {
      taskId: TASK,
    } as never);
    expect(result.taint).toEqual([
      { sourceType: MCP_TAINT_SOURCE, site: 'mcp.docs.test', sensitivity: 'internal' },
    ]);
  });

  it('taints the task on a listing too, though no request was made', async () => {
    // The labels and descriptions were authored by the server, so reading them
    // is reading third-party content.
    const list = tools().find((tool) => tool.name.endsWith(RESOURCE_LIST_TOOL)) as AgentTool;
    const result = await list.execute({}, { taskId: TASK } as never);
    expect(result.taint).toHaveLength(1);
  });

  it('bounds the content, whose length the server chose', async () => {
    const { transport } = scripted({
      read: { ok: true, result: { contents: [{ text: 'y'.repeat(MAX_RESOURCE_CHARS + 5000) }] } },
    });
    const [, readTool] = createMcpResourceTools({
      server: SERVER,
      transport,
      resources: [RESOURCE_ADMITTED],
      securityContextFor: security,
    });
    const result = await readTool!.execute({ uri: 'docs://guide' }, {
      taskId: TASK,
    } as never);
    expect((result.data as { text: string }).text).toHaveLength(MAX_RESOURCE_CHARS);
  });

  it('names binary content rather than decoding it', async () => {
    const { transport } = scripted({
      read: { ok: true, result: { contents: [{ text: 'before' }, { blob: 'AAAA' }] } },
    });
    const [, readTool] = createMcpResourceTools({
      server: SERVER,
      transport,
      resources: [RESOURCE_ADMITTED],
      securityContextFor: security,
    });
    const result = await readTool!.execute({ uri: 'docs://guide' }, {
      taskId: TASK,
    } as never);
    expect((result.data as { text: string }).text).toBe('before\n[binary resource omitted]');
  });

  it('reports a refusal as a failure of this call', async () => {
    const { transport } = scripted({ read: { ok: false, code: -32002, message: 'gone' } });
    const [, readTool] = createMcpResourceTools({
      server: SERVER,
      transport,
      resources: [RESOURCE_ADMITTED],
      securityContextFor: security,
    });
    // The `userMessage` is what reaches the model and the UI; the technical
    // message deliberately does not carry the server's own words.
    const thrown = (await readTool!
      .execute({ uri: 'docs://guide' }, { taskId: TASK } as never)
      .then(() => null)
      .catch((caught: unknown) => caught)) as ToolError;
    expect(thrown).toBeInstanceOf(ToolError);
    expect(thrown.code).toBe('MCP_ERROR');
    expect(thrown.toAgentError().userMessage).toContain('could not provide');
  });

  it('survives contents that are not shaped like contents', async () => {
    for (const result of [{}, { contents: 'text' }, { contents: [null, 7] }]) {
      const { transport } = scripted({ read: { ok: true, result } });
      const [, readTool] = createMcpResourceTools({
        server: SERVER,
        transport,
        resources: [RESOURCE_ADMITTED],
        securityContextFor: security,
      });
      const executed = await readTool!.execute({ uri: 'docs://guide' }, {
        taskId: TASK,
      } as never);
      expect(executed.success).toBe(true);
    }
  });
});
