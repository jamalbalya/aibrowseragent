/**
 * TEST-MCP-001 — the MCP trust core (§35, §5.11).
 *
 * §35's one normative sentence is "MCP must never become a security bypass",
 * and everything here is a case against that. The decisions this file pins were
 * taken in `PLUGIN_TRUST_MODEL.md` before any transport existed, deliberately:
 * a risk model written after the socket works is a risk model written around
 * whatever the socket happened to do.
 *
 * Every field of a `DiscoveredTool` was authored by the server, so these are
 * adversarial-input tests, not parser tests.
 */
import { describe, expect, it } from 'vitest';
import {
  MCP_NAME_SEPARATOR,
  admitDiscoveredTool,
  admitListing,
  isMcpToolName,
  mcpToolName,
  mcpToolRisk,
  validateServerDescriptor,
  type McpServerDescriptor,
} from '@/mcp/core/mcp-model';
import { MAX_GRANTABLE_RISK } from '@/policy/site-policy';

const server: McpServerDescriptor = {
  id: 'example',
  displayName: 'Example MCP',
  url: 'https://mcp.example.com/',
  ceiling: 'R1',
};

const schema = { type: 'object', properties: {} };

describe('01 adding a server', () => {
  it('accepts an https server with a ceiling', () => {
    const verdict = validateServerDescriptor({
      id: 'example',
      displayName: 'Example MCP',
      url: 'https://mcp.example.com/',
      ceiling: 'R1',
    });
    expect(verdict.ok).toBe(true);
  });

  it('refuses a plaintext server, because every call carries a credential', () => {
    const verdict = validateServerDescriptor({
      id: 'example',
      displayName: 'Example',
      url: 'http://mcp.example.com/',
      ceiling: 'R1',
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
        ceiling: 'R0',
      }).ok,
    ).toBe(true);
  });

  it('clamps a ceiling above what any grant may express', () => {
    // R3 always confirms and R5 is always denied, so a stored ceiling of either
    // would describe an authority the product does not have — the same reason
    // GrantableRiskLevel exists at all.
    const verdict = validateServerDescriptor({ ...server, ceiling: 'R4' });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.server.ceiling).toBe(MAX_GRANTABLE_RISK);
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

describe('02 where a tool’s risk comes from', () => {
  it('is the server’s ceiling, whatever the server says about the tool', () => {
    expect(mcpToolRisk(server)).toBe('R1');
    expect(mcpToolRisk({ ...server, ceiling: 'R2' })).toBe('R2');
  });

  it('cannot be lowered by anything a server could author', () => {
    // The rule this encodes: a server that could declare its own tool R0 would
    // be a server that could decide it needs no approval. There is deliberately
    // no branch here for a server to influence — mcpToolRisk does not even take
    // the tool.
    const source = mcpToolRisk.toString();
    expect(source).not.toMatch(/description|inputSchema|readOnly|annotations/);
    expect(source).toContain('ceiling');
  });

  it('charges a read the same as a write from the same server', () => {
    // Stated as an intended cost rather than found later: without trusting the
    // server the two are indistinguishable, and being wrong permissively is the
    // mistake that cannot be walked back.
    const read = mcpToolRisk(server);
    const write = mcpToolRisk(server);
    expect(read).toBe(write);
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
