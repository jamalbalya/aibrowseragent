/**
 * TEST-SECURITY-072 — the connector framework as a framework (P-023).
 *
 * One connector ships. That is a real limit and the matrix says so, but it
 * hides a different question that no suite was asking: does the framework
 * actually *hold* more than one, or does it only work because there has never
 * been a second one to be confused with the first?
 *
 * Everything below registers two connectors — the shipped GitHub descriptor
 * and a deterministic second one that exists only in this file — and asserts
 * the properties that stop one connector's authorization, tokens, scopes or
 * origins answering for another's. A second connector in the *build* needs an
 * OAuth application this project does not own; a second connector in a *test*
 * needs nothing, and is the only way to know the seams are real.
 *
 * Nothing here invents a client id, a secret or an endpoint that could be
 * reached: the test descriptor points at a loopback origin the validator
 * already permits for exactly this purpose.
 *
 * Groups:
 *   A. the registry holds two, and keeps them apart
 *   B. descriptor validation is per connector, not per build
 *   C. authorization, scopes and tokens do not cross
 *   D. the registration seam is not tied to one adapter
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ConnectorRegistry,
  scopesFor,
  validateConnectorDescriptor,
  type Connector,
  type ConnectorDescriptor,
} from '@/connectors/core/types';
import { TokenVault } from '@/connectors/oauth/token-vault';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { githubDescriptor } from '@/connectors/adapters/github';

/** The shipped descriptor, built the way the worker builds it. */
const github = githubDescriptor({
  redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/oauth',
});
import type { AgentTool } from '@/tools/core/tool-types';

const SRC_ROOT = resolve(import.meta.dirname, '../../src');

/**
 * A second connector, deterministic and test-only.
 *
 * Loopback origins, which `validateConnectorDescriptor` allows precisely so a
 * mock service can be driven over real sockets. It declares one read and one
 * write so scope handling has something to separate.
 */
const secondDescriptor: ConnectorDescriptor = {
  id: 'ledger',
  displayName: 'Ledger',
  authKind: 'oauth2',
  site: 'ledger.test',
  defaultSensitivity: 'confidential',
  apiOrigins: ['http://127.0.0.1:9931'],
  operations: [
    {
      id: 'list_entries',
      kind: 'read',
      description: 'List entries.',
      sensitivity: 'confidential',
      requiredScopes: ['ledger:read'],
      risk: 'R0',
      requiresConfirmation: false,
    },
    {
      id: 'post_entry',
      kind: 'write',
      description: 'Post an entry.',
      sensitivity: 'confidential',
      requiredScopes: ['ledger:write'],
      risk: 'R3',
      requiresConfirmation: true,
    },
  ],
  oauth: {
    authorizationEndpoint: 'http://127.0.0.1:9931/authorize',
    tokenEndpoint: 'http://127.0.0.1:9931/token',
    redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/oauth',
    readScopes: ['ledger:read'],
    writeScopes: ['ledger:write'],
  },
  scopeRationale: {
    'ledger:read': 'Read entries the user asked about.',
    'ledger:write': 'Post an entry the user approved.',
  },
};

const stubConnector = (descriptor: ConnectorDescriptor, tools: AgentTool[] = []): Connector => ({
  descriptor,
  authenticate: () => Promise.resolve({ authenticated: false, scopes: [] }),
  getAuthState: () => Promise.resolve({ authenticated: false, scopes: [] }),
  revoke: () => Promise.resolve(),
  listCapabilities: () => Promise.resolve([]),
  createTools: () => tools,
});

const fakeTool = (name: string): AgentTool =>
  ({
    name,
    version: '1.0.0',
    description: name,
    risk: 'R0',
    executionMode: 'immediate',
    siteAuthorization: 'none',
    sideEffects: [],
    timeoutMs: 1_000,
    idempotent: true,
  }) as unknown as AgentTool;

describe('TEST-SECURITY-072 group A: the registry holds two', () => {
  it('01 — two connectors register, and each is retrievable by its own id', () => {
    const registry = new ConnectorRegistry();
    registry.register(stubConnector(github));
    registry.register(stubConnector(secondDescriptor));

    expect(registry.list()).toHaveLength(2);
    expect(registry.get('github')?.descriptor.site).toBe('github.com');
    expect(registry.get('ledger')?.descriptor.site).toBe('ledger.test');
    expect(registry.get('nothing')).toBeUndefined();
  });

  it('02 — a duplicate id is refused rather than replacing what is there', () => {
    // NEGATIVE CONTROL. Silent replacement would mean a second descriptor
    // could take over an id a user already authorised.
    const registry = new ConnectorRegistry();
    registry.register(stubConnector(secondDescriptor));
    expect(() =>
      registry.register(stubConnector({ ...secondDescriptor, site: 'evil.test' })),
    ).toThrow(/already registered/);
    expect(registry.get('ledger')?.descriptor.site).toBe('ledger.test');
  });

  it('03 — tools from both reach the registry, and keep their own names', () => {
    const registry = new ConnectorRegistry();
    registry.register(stubConnector(github, [fakeTool('github.search')]));
    registry.register(stubConnector(secondDescriptor, [fakeTool('ledger.list')]));

    expect(
      registry
        .allTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(['github.search', 'ledger.list']);
  });
});

describe('TEST-SECURITY-072 group B: validation is per connector', () => {
  it('04 — a valid second descriptor passes on its own merits', () => {
    expect(validateConnectorDescriptor(secondDescriptor)).toEqual([]);
  });

  it('05 — and a bad one is refused without affecting the good one', () => {
    // NEGATIVE CONTROL for each rule the validator owns, on the *second*
    // connector: a check that only ever ran against the shipped descriptor
    // would be a check nobody had tested generalising.
    const registry = new ConnectorRegistry();
    registry.register(stubConnector(github));

    for (const [label, bad] of [
      ['no origins', { ...secondDescriptor, apiOrigins: [] }],
      ['http origin', { ...secondDescriptor, apiOrigins: ['http://ledger.test'] }],
      ['origin with a path', { ...secondDescriptor, apiOrigins: ['http://127.0.0.1:9931/api'] }],
      ['empty id', { ...secondDescriptor, id: '  ' }],
      ['oauth2 with no config', { ...secondDescriptor, oauth: undefined }],
    ] as const) {
      expect(validateConnectorDescriptor(bad as ConnectorDescriptor).length, label).toBeGreaterThan(
        0,
      );
      expect(() => registry.register(stubConnector(bad as ConnectorDescriptor)), label).toThrow();
    }

    // The first connector is untouched by any of it.
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('github')).toBeDefined();
  });
});

describe('TEST-SECURITY-072 group C: nothing crosses between connectors', () => {
  it('06 — scopes are computed from the connector being asked about', () => {
    expect(scopesFor(secondDescriptor, 'read')).toEqual(['ledger:read']);
    expect(scopesFor(secondDescriptor, 'all')).toEqual(['ledger:read', 'ledger:write']);
    // And they share nothing with the other connector's.
    const githubScopes = new Set(scopesFor(github, 'all'));
    expect(scopesFor(secondDescriptor, 'all').some((scope) => githubScopes.has(scope))).toBe(false);
  });

  it('07 — a token stored for one connector is not readable as another’s', async () => {
    // The vault is keyed per connector. Without that, authorising one
    // integration would hand its bearer token to every other one.
    const vault = new TokenVault(new SerializedStorageArea(new MemoryStorageArea()));
    await vault.store('github', {
      accessToken: 'gh-token',
      tokenType: 'Bearer',
      scopes: ['repo'],
    });

    const now = 2;
    expect(await vault.authorizationHeader('github', now)).not.toBeNull();
    // NEGATIVE CONTROL: the same vault, a different connector, no header.
    expect(await vault.authorizationHeader('ledger', now)).toBeNull();

    await vault.clear('github');
    expect(await vault.authorizationHeader('github', now)).toBeNull();
  });

  it('08 — each connector declares its own origins, and they do not pool', () => {
    // NEGATIVE CONTROL against an allowlist that is global rather than
    // per-connector: the transport binds a token to the origins of the
    // connector it belongs to.
    const registry = new ConnectorRegistry();
    registry.register(stubConnector(github));
    registry.register(stubConnector(secondDescriptor));

    const ledgerOrigins = registry.get('ledger')!.descriptor.apiOrigins;
    const githubOrigins = registry.get('github')!.descriptor.apiOrigins;
    expect(ledgerOrigins.some((origin) => githubOrigins.includes(origin))).toBe(false);
  });
});

describe('TEST-SECURITY-072 group D: the registration seam', () => {
  it('09 — the worker registers by interface, not by concrete adapter', () => {
    // This was typed to the one shipped class, so adding a second connector
    // meant editing the registration helper. The framework was extensible
    // everywhere except at the point where a connector is actually added.
    const worker = readFileSync(resolve(SRC_ROOT, 'background/service-worker.ts'), 'utf8');
    expect(worker).toMatch(/function registerConnector\(connector: Connector\)/);
    expect(worker).not.toMatch(/function registerConnector\(connector: GitHubConnector\)/);
  });

  it('10 — a connector that will not register leaves the rest of the build alive', () => {
    // The helper swallows the throw on purpose: at module scope an uncaught
    // one stops every route below it from being registered, which has
    // happened once already. Asserted on the registry's own behaviour, which
    // is what the helper depends on.
    const registry = new ConnectorRegistry();
    expect(() =>
      registry.register(stubConnector({ ...secondDescriptor, apiOrigins: ['not-a-url'] })),
    ).toThrow();
    registry.register(stubConnector(github));
    expect(registry.list()).toHaveLength(1);
  });
});
