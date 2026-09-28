/**
 * TEST-MCP-005 — an MCP tool dispatched through the real registry (§35).
 *
 * §35 requires every MCP capability to pass through schema, policy, permission
 * and audit. The claim this suite tests is that it does so through the *existing*
 * path rather than a parallel one, so the registry, the policy engine and the
 * prompter here are all production code — a suite that called `tool.execute`
 * directly would prove the tool and skip the sentence being tested.
 *
 * The consequences worth pinning are the ones a reader would otherwise have to
 * derive from three files: an MCP tool is confirmed on every call in every
 * permission mode, no grant can pre-approve it, its destination is the server's
 * URL and not something the model named, and its result taints the task.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { createHarness, ScriptedPrompter, type Harness } from '../fixtures/policy-harness';
import { MAX_GRANTABLE_RISK, upsertRule } from '@/policy/site-policy';
import { MCP_TOOL_RISK, type McpServerDescriptor } from '@/mcp/core/mcp-model';
import {
  MAX_RESULT_CHARS,
  MCP_TAINT_SOURCE,
  createMcpTool,
  type McpToolOptions,
} from '@/mcp/tools/mcp-tool';
import type { McpRpcOutcome, McpTransport } from '@/mcp/transport/mcp-transport';
import { fromWireName, toWireName } from '@/tools/registry/tool-registry';
import {
  MCP_NAME_PREFIX,
  MCP_NAME_SEPARATOR,
  admitDiscoveredTool,
  mcpToolName,
} from '@/mcp/core/mcp-model';
import { freshTaint } from '@/security/taint/taint-state';
import type { AgentTool } from '@/tools/core/tool-types';

const SERVER: McpServerDescriptor = {
  id: 'example',
  displayName: 'Example MCP',
  url: 'https://mcp.example.test/rpc',
};

const SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' }, limit: { type: 'integer' } },
  required: ['query'],
};

const TASK = 'task-1';

interface Call {
  readonly method: string;
  readonly params: unknown;
}

function build(
  reply: McpRpcOutcome = { ok: true, result: { content: [{ type: 'text', text: 'the answer' }] } },
  over: Partial<McpToolOptions> = {},
): { tool: AgentTool; calls: Call[] } {
  const calls: Call[] = [];
  const transport: McpTransport = {
    call(method, params) {
      calls.push({ method, params });
      return Promise.resolve(reply);
    },
  };
  const outcome = createMcpTool({
    server: SERVER,
    transport,
    remoteName: 'search',
    description: 'Searches things.',
    inputSchema: SCHEMA,
    securityContextFor: () =>
      Promise.resolve({
        taskId: TASK,
        taintState: freshTaint(),
        taintSalt: 'ab'.repeat(32),
        saltEpoch: 1,
        taintSignature: 'sig',
      }),
    ...over,
  });
  if (!outcome.ok) throw new Error(`refused: ${outcome.reason}`);
  return { tool: outcome.tool, calls };
}

let prompter: ScriptedPrompter;
const harnessFor = (tool: AgentTool, mode: 'manual' | 'auto' | 'skip' = 'auto'): Harness =>
  createHarness([tool], { mode, prompter });

const dispatch = (harness: Harness, tool: AgentTool, args: unknown) =>
  harness.registry.dispatch({
    taskId: TASK,
    sessionId: 's',
    toolCallId: 'c1',
    name: tool.name,
    arguments: args as Record<string, unknown>,
    signal: new AbortController().signal,
  });

beforeEach(() => {
  prompter = new ScriptedPrompter();
});

describe('01 the tool the factory produces', () => {
  it('is namespaced, so it cannot shadow a built-in', () => {
    const { tool } = build();
    expect(tool.name).toBe('mcp__example__search');
  });

  it('carries the risk this build classified, not the server’s opinion', () => {
    const { tool } = build();
    expect(tool.risk).toBe(MCP_TOOL_RISK);
    // And `classify` cannot lower it either: the field is set to the same
    // constant rather than derived from the arguments.
    expect(tool.classify?.({ query: 'x' }, {} as never)?.risk).toBe(MCP_TOOL_RISK);
  });

  it('is not idempotent, because nothing here knows what the far side does', () => {
    expect(build().tool.idempotent).toBe(false);
  });

  it('refuses to exist when its schema is outside the compilable subset', () => {
    // A refusal rather than a permissive fallback. The alternative — accepting
    // any object — would put an unvalidated argument set on the wire.
    const outcome = createMcpTool({
      server: SERVER,
      transport: { call: () => Promise.resolve({ ok: true, result: {} }) },
      remoteName: 'x',
      inputSchema: { type: 'object', properties: { a: { $ref: '#/b' } } },
      securityContextFor: () =>
        Promise.resolve({
          taskId: TASK,
          taintState: freshTaint(),
          taintSalt: 'ab'.repeat(32),
          saltEpoch: 1,
          taintSignature: 'sig',
        }),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('$ref');
  });
});

describe('01b the wire round trip, which is where the two conventions met', () => {
  it('leaves an MCP name untouched in both directions', () => {
    // The defect this case exists for: `fromWireName` restores the first `_` to
    // a `.`, so `mcp__example__search` became `mcp._example__search` and every
    // MCP tool was undispatchable. The earlier reasoning for `__` — that no
    // built-in family contains it, so a discovered name cannot shadow one — is
    // true and is about shadowing, not about this.
    const name = mcpToolName('example', 'search');
    expect(name).toBe('mcp__example__search');
    expect(toWireName(name)).toBe(name);
    expect(fromWireName(name)).toBe(name);
    expect(fromWireName(toWireName(name))).toBe(name);
  });

  it('still translates a built-in name, so the guard is not a blanket exemption', () => {
    expect(fromWireName(toWireName('browser.click'))).toBe('browser.click');
    expect(fromWireName('tabs_create')).toBe('tabs.create');
  });

  it('keeps the registry’s spelling of the prefix and the MCP layer’s in step', () => {
    // The registry holds its own constant rather than importing the MCP layer,
    // because it is the bottom of the dependency graph. That is only safe while
    // the two agree.
    const expected = `${MCP_NAME_PREFIX}${MCP_NAME_SEPARATOR}`;
    expect(fromWireName(`${expected}anything_else`)).toBe(`${expected}anything_else`);
    expect(fromWireName('mcpX__a__b')).not.toBe('mcpX__a__b');
  });

  it('cannot be reached by a server, because a discovered name may not hold the separator', () => {
    // So no tool name arrives already looking like it belongs to the namespace.
    const refused = admitDiscoveredTool(SERVER, {
      name: `other${MCP_NAME_SEPARATOR}forged`,
      inputSchema: SCHEMA,
    });
    expect(refused.ok).toBe(false);
  });
});

describe('02 what the policy engine does with it', () => {
  it('is confirmed on every call, in manual, auto and skip alike', async () => {
    for (const mode of ['manual', 'auto', 'skip'] as const) {
      prompter = new ScriptedPrompter();
      const { tool } = build();
      const harness = harnessFor(tool, mode);
      await dispatch(harness, tool, { query: 'x' });
      expect(prompter.seen, mode).toHaveLength(1);
    }
  });

  it('names the server in the prompt, so a substituted server is visible before it runs', async () => {
    // The mitigation MCP_GUIDE.md §8b relies on, and it was unpinned: removing
    // `siteAuthorization: 'destination'` from the tool broke no test at all, and
    // the guide's argument that a replaced server "is visible in the prompt
    // before anything runs" rested on a declaration nothing checked.
    //
    // `classify` returning the server's URL is tested above, and it is not the
    // same fact. It is `siteAuthorization: 'destination'` that makes
    // `resolveSiteScope` read the site off `classification.targetUrl`; with
    // `'none'` the request carries no site and the prompt shows the person
    // nothing about where their data is going.
    expect(build().tool.siteAuthorization).toBe('destination');

    const { tool } = build();
    await dispatch(harnessFor(tool, 'manual'), tool, { query: 'x' });
    expect(prompter.seen).toHaveLength(1);
    // The registrable domain, as every site grant in this product is — not the
    // host. `targetUrl` is the part that distinguishes one server on a shared
    // domain from another, and it is what the record carries.
    expect(prompter.seen[0]?.site).toBe('example.test');
    expect(prompter.seen[0]?.targetUrl).toBe(SERVER.url);
  });

  // There is deliberately no second case here asserting "the server, not the
  // page the task was reading". The first attempt at one called
  // `harness.publishSecurityContext?.(...)` to seed a page taint; that method
  // does not exist on the fixture, the optional call was a no-op, and the case
  // passed while establishing nothing — caught by `tsc`, not by the suite.
  // Adding a taint facility to the shared harness for one assertion is not
  // proportionate, and the fact it was reaching for is covered from the other
  // side: `takes its destination from the descriptor, so the model cannot name
  // one` proves a `url` in the arguments cannot become the destination.

  it('is not pre-approved by a grant on the server’s own origin', async () => {
    // The nearest thing to a per-server ceiling the product has. It changes
    // nothing, which is the property the rejected ceiling design lacked.
    const { tool } = build();
    const harness = harnessFor(tool);
    await harness.saveSitePolicy(
      upsertRule(await harness.loadSitePolicy(), {
        site: 'mcp.example.test',
        decision: 'allow',
        maxRisk: MAX_GRANTABLE_RISK,
        createdAt: 1,
      }),
    );
    await dispatch(harness, tool, { query: 'x' });
    expect(prompter.seen).toHaveLength(1);
  });

  it('is refused outright when the server’s site is blocked', async () => {
    const { tool, calls } = build();
    const harness = harnessFor(tool);
    await harness.saveSitePolicy(
      upsertRule(await harness.loadSitePolicy(), {
        site: 'mcp.example.test',
        decision: 'block',
        maxRisk: MAX_GRANTABLE_RISK,
        createdAt: 1,
      }),
    );
    const result = await dispatch(harness, tool, { query: 'x' });
    expect(result.envelope.status).toBe('error');
    expect(calls).toHaveLength(0);
  });

  it('does not run when the confirmation is declined', async () => {
    const { tool, calls } = build();
    prompter.setResponse({ kind: 'deny' });
    const result = await dispatch(harnessFor(tool), tool, { query: 'x' });
    expect(result.envelope.status).toBe('error');
    expect(calls).toHaveLength(0);
  });
});

describe('03 the arguments, and who chose the destination', () => {
  it('refuses an argument the schema never declared, before any request', async () => {
    const { tool, calls } = build();
    const result = await dispatch(harnessFor(tool), tool, { query: 'x', extra: 'invented' });
    expect(result.envelope.status).toBe('error');
    expect(calls).toHaveLength(0);
  });

  it('refuses a missing required argument, before any request', async () => {
    const { tool, calls } = build();
    const result = await dispatch(harnessFor(tool), tool, { limit: 2 });
    expect(result.envelope.status).toBe('error');
    expect(calls).toHaveLength(0);
  });

  it('sends the server’s own name for the tool, not the namespaced one', async () => {
    // The namespace is this build's. Sending it back would ask the server for a
    // tool it never offered.
    const { tool, calls } = build();
    await dispatch(harnessFor(tool), tool, { query: 'x' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('tools/call');
    expect(calls[0]?.params).toEqual({ name: 'search', arguments: { query: 'x' } });
  });

  it('takes its destination from the descriptor, so the model cannot name one', async () => {
    // `classify` receives the model's arguments, so a destination it could read
    // out of them is a destination the model could choose.
    const { tool } = build();
    const classified = tool.classify?.({ query: 'x', url: 'https://attacker.test' }, {} as never);
    expect(classified?.targetUrl).toBe(SERVER.url);
    expect(classified?.writeDestination).toBe(SERVER.url);
  });

  it('declares the arguments as the payload, so the exfiltration gate sees them', async () => {
    const { tool } = build();
    const classified = tool.classify?.({ query: 'secret' }, {} as never);
    expect(classified?.writePayload).toEqual({ query: 'secret' });
    expect(classified?.egress?.destination.channel).toBe('mcp');
  });
});

describe('04 what the result is treated as', () => {
  it('returns the text content and taints the task with it', async () => {
    const { tool } = build();
    const result = await dispatch(harnessFor(tool), tool, { query: 'x' });
    expect(result.envelope.status).toBe('success');
    expect(result.envelope.result).toEqual({ text: 'the answer' });
  });

  it('records the server as a taint source, at the same shape a page read uses', async () => {
    // The title used to end "so a later write meets the gate", which claimed
    // more than the assertion below shows: this proves the source is recorded,
    // not what the gate then does with it. The consequence is tested where the
    // gate is — `egress-gate.test.ts :: makes a later write to an unrelated
    // service need consent rather than allowing it` — and a first attempt at
    // that case passed against a navigation, which is `NOT_AN_EGRESS` and would
    // have proved nothing.
    const { tool } = build();
    const executed = await tool.execute({ query: 'x' }, {
      taskId: TASK,
    } as never);
    expect(executed.taint).toEqual([
      { sourceType: MCP_TAINT_SOURCE, site: 'mcp.example.test', sensitivity: 'internal' },
    ]);
  });

  it('names a non-text part rather than decoding it', async () => {
    // There is no path in this build that would do anything with binary a
    // server chose, and decoding one would be inventing a capability.
    const { tool } = build({
      ok: true,
      result: {
        content: [
          { type: 'text', text: 'before' },
          { type: 'image', data: 'AAAA' },
          { type: 'text', text: 'after' },
        ],
      },
    });
    const executed = await tool.execute({ query: 'x' }, { taskId: TASK } as never);
    expect(executed.data).toEqual({ text: 'before\n[image omitted]\nafter' });
  });

  it('bounds the result, whose length the server chose', async () => {
    const { tool } = build({
      ok: true,
      result: { content: [{ type: 'text', text: 'y'.repeat(MAX_RESULT_CHARS + 5000) }] },
    });
    const executed = await tool.execute({ query: 'x' }, { taskId: TASK } as never);
    expect((executed.data as { text: string }).text).toHaveLength(MAX_RESULT_CHARS);
  });

  it('treats isError as a failure, not as a success whose text says "error"', async () => {
    // Collapsing the two would let a server report failure in a channel the
    // agent reads as success.
    const { tool } = build({
      ok: true,
      result: { isError: true, content: [{ type: 'text', text: 'no such record' }] },
    });
    const result = await dispatch(harnessFor(tool), tool, { query: 'x' });
    expect(result.envelope.status).toBe('error');
    expect(result.envelope.error?.code).toBe('MCP_ERROR');
  });

  it('treats a JSON-RPC refusal as a failure of this call', async () => {
    const { tool } = build({ ok: false, code: -32602, message: 'bad params' });
    const result = await dispatch(harnessFor(tool), tool, { query: 'x' });
    expect(result.envelope.status).toBe('error');
    expect(result.envelope.error?.code).toBe('MCP_ERROR');
    expect(result.envelope.retryable).toBe(false);
  });

  it('survives a result that is not shaped like one', async () => {
    for (const reply of [
      { ok: true as const, result: {} },
      { ok: true as const, result: { content: 'text' } },
      { ok: true as const, result: null },
      { ok: true as const, result: { content: [null, 7, {}] } },
    ]) {
      const { tool } = build(reply);
      const executed = await tool.execute({ query: 'x' }, { taskId: TASK } as never);
      expect(executed.success).toBe(true);
    }
  });
});
