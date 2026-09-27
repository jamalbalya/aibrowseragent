/**
 * TEST-MCP-001 — the MCP trust core (§35, §5.11).
 *
 * §35's one normative sentence is "MCP must never become a security bypass",
 * and everything here is a case against that. The decisions this file pins were
 * taken in `docs/MCP_GUIDE.md` before any transport existed, deliberately: a
 * risk model written after the socket works is a risk model written around
 * whatever the socket happened to do.
 *
 * "Server" throughout means a server somebody else runs and this build calls
 * out to. This extension is not an MCP server and §5.11 does not ask it to be
 * one, so no case here concerns an inbound caller.
 *
 * Every field of a `DiscoveredTool` was authored by the server, so these are
 * adversarial-input tests, not parser tests. Group 02 is the exception: it runs
 * the real `evaluatePolicy` rather than the MCP model, because the claim being
 * tested is about what the shipped policy engine does with an R3 tool, and
 * asserting that against a fixture would prove the fixture.
 */
import { describe, expect, it } from 'vitest';
import {
  MCP_NAME_SEPARATOR,
  MCP_TOOL_RISK,
  admitDiscoveredTool,
  admitListing,
  isMcpToolName,
  mcpToolName,
  mcpToolRisk,
  validateServerDescriptor,
  type McpServerDescriptor,
} from '@/mcp/core/mcp-model';
import { MAX_GRANTABLE_RISK } from '@/policy/site-policy';
import { RISK_DESCRIPTIONS, RISK_RANK } from '@/policy/risk-classifier';
import {
  ALWAYS_CONFIRM_AT,
  AUTO_APPROVE_BELOW,
  evaluatePolicy,
  type PermissionMode,
  type PolicyContext,
} from '@/policy/policy-engine';
import { emptySitePolicyState, upsertRule } from '@/policy/site-policy';
import { APPROVAL_PROVENANCE } from '@/policy/plan-model';

const server: McpServerDescriptor = {
  id: 'example',
  displayName: 'Example MCP',
  url: 'https://mcp.example.com/',
};

/** A call on an admitted MCP tool, shaped the way the registry would build it. */
const mcpCall = {
  tool: mcpToolName(server.id, 'search'),
  taskId: 'task-mcp',
  risk: MCP_TOOL_RISK,
  targetUrl: server.url,
} as const;

const contextFor = (mode: PermissionMode, over: Partial<PolicyContext> = {}): PolicyContext => ({
  mode,
  sitePolicy: emptySitePolicyState(),
  unattended: false,
  ...over,
});

const schema = { type: 'object', properties: {} };

describe('01 adding a server', () => {
  it('accepts an https server', () => {
    const verdict = validateServerDescriptor({
      id: 'example',
      displayName: 'Example MCP',
      url: 'https://mcp.example.com/',
    });
    expect(verdict.ok).toBe(true);
  });

  it('refuses a plaintext server, because every call carries a credential', () => {
    const verdict = validateServerDescriptor({
      id: 'example',
      displayName: 'Example',
      url: 'http://mcp.example.com/',
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problems.join(' ')).toContain('not https');
  });

  it('allows loopback, so a local mock can be driven over real sockets', () => {
    // The pattern the connectors already use: a mock service over real HTTP
    // rather than a stubbed transport.
    expect(
      validateServerDescriptor({
        id: 'mock',
        displayName: 'Mock',
        url: 'http://127.0.0.1:8931/',
      }).ok,
    ).toBe(true);
  });

  it('takes no risk setting at all, so a stored descriptor cannot lower one', () => {
    // The earlier draft asked for a ceiling here. It is gone rather than
    // clamped: a field a user sets low is a field that auto-approves a server's
    // whole tool set, including the tools it adds later.
    const verdict = validateServerDescriptor({ ...server, ceiling: 'R0' } as {
      readonly id?: unknown;
      readonly displayName?: unknown;
      readonly url?: unknown;
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok)
      expect(Object.keys(verdict.server).sort()).toEqual(['displayName', 'id', 'url']);
  });

  it('refuses a server id that could not survive becoming part of a tool name', () => {
    for (const id of ['Example', 'ex ample', 'ex__ample', 'ex/ample', '']) {
      expect(validateServerDescriptor({ ...server, id }).ok).toBe(false);
    }
  });

  it('requires a display name and a URL', () => {
    expect(validateServerDescriptor({ ...server, displayName: '  ' }).ok).toBe(false);
    expect(validateServerDescriptor({ ...server, url: '' }).ok).toBe(false);
    expect(validateServerDescriptor({ ...server, url: 'not a url' }).ok).toBe(false);
  });
});

describe('02 where a tool’s risk comes from, and what the engine does with it', () => {
  it('is fixed at R3, because that is what an MCP call is', () => {
    // Not a preference. R3's own description is the sentence, so a tool that
    // only reads on the far side still qualifies: the arguments left the
    // browser either way.
    expect(MCP_TOOL_RISK).toBe('R3');
    expect(RISK_DESCRIPTIONS.R3).toBe(
      'Sensitive external side effect. Writes data outside the browser.',
    );
  });

  it('cannot be lowered by anything a server, a schema or a setting could supply', () => {
    // The rule: a server that could declare its own tool R0 would be a server
    // that could decide it needs no approval. `mcpToolRisk` takes no argument
    // at all, so there is no input to carry such a declaration — and this
    // pins the arity, because a later parameter is the shape every "let the
    // server hint at it" change would arrive in.
    expect(mcpToolRisk.length).toBe(0);
    expect(mcpToolRisk()).toBe(MCP_TOOL_RISK);
    expect(mcpToolRisk.toString()).not.toMatch(
      /description|inputSchema|readOnly|annotations|ceiling/,
    );
  });

  it('sits above everything a grant can express, so approval is per call by construction', () => {
    // This is the whole approval-granularity answer, and it is arithmetic
    // rather than a product decision: a rule may allow up to R2, MCP starts at
    // R3, so no rule reaches it. If either constant ever moves toward the
    // other, this fails instead of quietly creating a grantable MCP tool.
    expect(RISK_RANK[MCP_TOOL_RISK]).toBeGreaterThan(RISK_RANK[MAX_GRANTABLE_RISK]);
    expect(RISK_RANK[MCP_TOOL_RISK]).toBeGreaterThanOrEqual(RISK_RANK[ALWAYS_CONFIRM_AT]);
    expect(RISK_RANK[MCP_TOOL_RISK]).toBeGreaterThanOrEqual(RISK_RANK[AUTO_APPROVE_BELOW]);
  });

  it('is confirmed in every permission mode, skip included', () => {
    for (const mode of ['manual', 'auto', 'skip'] as const) {
      const decision = evaluatePolicy(mcpCall, contextFor(mode));
      expect(decision.verdict, mode).toBe('ALLOW_WITH_CONFIRMATION');
      expect(decision.code, mode).toBe('RISK_REQUIRES_APPROVAL');
    }
  });

  it('is not cleared by a site grant on the server’s own origin', () => {
    // The nearest thing to a per-server ceiling the product actually has. A
    // user may trust `mcp.example.com` up to R2 and it changes nothing here,
    // which is the property the rejected ceiling design lacked.
    const sitePolicy = upsertRule(emptySitePolicyState(), {
      site: 'mcp.example.com',
      decision: 'allow',
      maxRisk: MAX_GRANTABLE_RISK,
      createdAt: 1,
    });
    const decision = evaluatePolicy(mcpCall, contextFor('auto', { sitePolicy }));
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
    expect(decision.code).not.toBe('SITE_ALLOWED');
  });

  it('is not cleared by a plan the user approved for the task', () => {
    const decision = evaluatePolicy(
      { ...mcpCall, siteScope: 'mcp.example.com' },
      contextFor('auto', {
        planApproval: {
          planId: 'plan-1',
          taskId: 'task-mcp',
          version: 1,
          approvedSites: ['mcp.example.com'],
          approvedAt: 1,
          approvalProvenance: APPROVAL_PROVENANCE,
        },
      }),
    );
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
    expect(decision.code).not.toBe('PLAN_ALLOWED');
  });

  it('fails closed in an unattended run, so a scheduled task cannot call one', () => {
    // Stated as a consequence rather than discovered later: stage 5 returns
    // before the unattended clause, so the call becomes a confirmation and a
    // confirmation with nobody present is refused downstream.
    const decision = evaluatePolicy(mcpCall, contextFor('skip', { unattended: true }));
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
  });

  it('charges a read the same as a write, which is the accepted cost', () => {
    // Without trusting the server the two are indistinguishable, and being
    // wrong permissively is the mistake that cannot be walked back.
    expect(mcpToolRisk()).toBe(mcpToolRisk());
  });
});

describe('03 a discovered name cannot shadow or impersonate', () => {
  it('namespaces a tool by its server', () => {
    expect(mcpToolName('example', 'search')).toBe('mcp__example__search');
    expect(isMcpToolName(mcpToolName('example', 'search'))).toBe(true);
  });

  it('keeps two servers offering the same tool name apart', () => {
    expect(mcpToolName('a', 'search')).not.toBe(mcpToolName('b', 'search'));
  });

  it('cannot produce the name of a tool this project ships', () => {
    // Every built-in is `family.verb` and no built-in family contains the
    // separator, so a namespaced name is in a space of its own.
    for (const builtin of ['browser.click', 'tabs.close', 'files.select', 'skills.run']) {
      expect(mcpToolName('example', builtin)).not.toBe(builtin);
      expect(isMcpToolName(builtin)).toBe(false);
    }
  });

  it('refuses a name carrying the separator, which could forge a namespace', () => {
    // Without this, a server called `a` could offer `_other__x` and arrive
    // looking as though it came from `other`.
    const verdict = admitDiscoveredTool(server, {
      name: `other${MCP_NAME_SEPARATOR}x`,
      inputSchema: schema,
    });
    expect(verdict.ok).toBe(false);
  });

  it('refuses a name holding characters a tool name may not', () => {
    for (const name of ['', '  ', 'a b', 'a/b', 'a:b', '../x']) {
      expect(admitDiscoveredTool(server, { name, inputSchema: schema }).ok).toBe(false);
    }
  });
});

describe('04 what a discovered tool must supply', () => {
  it('admits an ordinary tool', () => {
    const verdict = admitDiscoveredTool(server, {
      name: 'search',
      description: 'Search the corpus.',
      inputSchema: schema,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.name).toBe('mcp__example__search');
  });

  it('refuses a tool with no input schema', () => {
    // §22 makes argument validation the contract. A tool whose arguments
    // cannot be validated is a tool the registry cannot gate.
    expect(admitDiscoveredTool(server, { name: 'search' }).ok).toBe(false);
    expect(admitDiscoveredTool(server, { name: 'search', inputSchema: 'object' }).ok).toBe(false);
    expect(admitDiscoveredTool(server, { name: 'search', inputSchema: null }).ok).toBe(false);
  });

  it('refuses a description that is not text, or is longer than the cap', () => {
    expect(
      admitDiscoveredTool(server, { name: 'a', description: 1 as never, inputSchema: schema }).ok,
    ).toBe(false);
    expect(
      admitDiscoveredTool(server, { name: 'a', description: 'x'.repeat(401), inputSchema: schema })
        .ok,
    ).toBe(false);
  });
});

describe('05 a whole listing, bounded', () => {
  it('admits the good ones and names every refusal', () => {
    const result = admitListing(server, [
      { name: 'search', inputSchema: schema },
      { name: 'bad name', inputSchema: schema },
      { name: 'noschema' },
    ]);
    expect(result.admitted.map((t) => t.name)).toEqual(['mcp__example__search']);
    expect(result.refused).toHaveLength(2);
    // Named rather than dropped silently, or the user sees a server that looks
    // as though it offers nothing.
    expect(result.refused.map((r) => r.name)).toEqual(['bad name', 'noschema']);
  });

  it('keeps the first of a repeated name and says the second was refused', () => {
    const result = admitListing(server, [
      { name: 'search', inputSchema: schema },
      { name: 'search', inputSchema: { type: 'object', properties: { evil: {} } } },
    ]);
    expect(result.admitted).toHaveLength(1);
    expect(result.refused[0]?.reason).toContain('more than once');
  });

  it('bounds the listing, because the count comes from the server too', () => {
    // Ten thousand tools is a context-exhaustion channel rather than a feature.
    const many = Array.from({ length: 100 }, (_, i) => ({
      name: `t${i}`,
      inputSchema: schema,
    }));
    const result = admitListing(server, many);
    expect(result.admitted).toHaveLength(64);
    expect(result.refused).toHaveLength(36);
    expect(result.refused[0]?.reason).toContain('more than 64');
  });

  it('survives a listing that is not shaped like one', () => {
    const result = admitListing(server, [null as never, undefined as never, 7 as never]);
    expect(result.admitted).toHaveLength(0);
    expect(result.refused).toHaveLength(3);
  });
});
