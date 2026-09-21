/**
 * TEST-PROVIDER-003 — Provider registry and explicit switching (§11, §17, §60).
 *
 * The registry's central rule is that switching providers is always a
 * deliberate act: there is no fallback path, so a failing provider surfaces
 * its failure instead of being quietly replaced by another. Until now that
 * rule was asserted in a comment and nowhere else — only one adapter ships,
 * so nothing exercised the multi-provider paths at all.
 *
 * Two stub factories are registered here to exercise those paths. They stand
 * in for a second provider; they are not one, and shipping a second real
 * adapter remains out of scope.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { ProviderRegistry } from '@/providers/registry/provider-registry';
import type {
  AIProviderAdapter,
  AuthResult,
  CanonicalResponse,
  ModelCapabilities,
  ModelInfo,
  ProviderConfig,
  ProviderFactory,
  HealthResult,
} from '@/providers/core/types';

class StubAdapter implements AIProviderAdapter {
  readonly kind = 'api' as const;
  readonly authKind = 'api_key' as const;
  connects = 0;
  disconnects = 0;
  authenticated = true;

  constructor(
    readonly id: string,
    readonly displayName: string,
  ) {}

  connect(): Promise<AuthResult> {
    this.connects += 1;
    return Promise.resolve(
      this.authenticated
        ? { authenticated: true }
        : {
            authenticated: false,
            error: {
              code: 'AUTH_REQUIRED' as const,
              message: 'bad key',
              userMessage: 'bad key',
              retryable: false,
              recoverable: true,
            },
          },
    );
  }

  disconnect(): Promise<void> {
    this.disconnects += 1;
    return Promise.resolve();
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([]);
  }

  getCapabilities(): Promise<ModelCapabilities> {
    return Promise.resolve({} as ModelCapabilities);
  }

  validateConnection(): Promise<HealthResult> {
    return Promise.resolve({ reachable: true });
  }

  generate(): Promise<CanonicalResponse> {
    return Promise.resolve({} as CanonicalResponse);
  }
}

function factoryFor(id: string): ProviderFactory & { adapter: StubAdapter } {
  const adapter = new StubAdapter(id, `Stub ${id}`);
  return {
    id,
    displayName: `Stub ${id}`,
    kind: 'api' as const,
    authKind: 'api_key',
    description: `Stub provider ${id}`,
    create: () => adapter,
    adapter,
  };
}

let registry: ProviderRegistry;
let alpha: ReturnType<typeof factoryFor>;
let beta: ReturnType<typeof factoryFor>;

const configFor = (providerId: string): ProviderConfig => ({
  providerId,
  apiKey: 'k',
  baseUrl: 'https://example.invalid',
  model: 'm',
});

beforeEach(() => {
  registry = new ProviderRegistry();
  alpha = factoryFor('alpha');
  beta = factoryFor('beta');
  registry.register(alpha);
  registry.register(beta);
});

describe('registration', () => {
  it('lists every registered provider', () => {
    expect(
      registry
        .list()
        .map((f) => f.id)
        .sort(),
    ).toEqual(['alpha', 'beta']);
    expect(registry.has('alpha')).toBe(true);
    expect(registry.has('gamma')).toBe(false);
  });

  it('refuses to register the same id twice', () => {
    // Silently replacing an adapter would change which provider a configured
    // task talks to without anything saying so.
    expect(() => registry.register(factoryFor('alpha'))).toThrow(/already registered/i);
  });

  it('returns the same adapter instance for an id', () => {
    expect(registry.get('alpha')).toBe(registry.get('alpha'));
    expect(registry.get('alpha')).not.toBe(registry.get('beta'));
  });

  it('throws rather than inventing an adapter for an unknown id', () => {
    expect(() => registry.get('gamma')).toThrow(/not registered/i);
  });
});

describe('switching between two providers', () => {
  it('starts with nothing active', () => {
    expect(registry.getActiveId()).toBeNull();
    expect(registry.getActive()).toBeNull();
  });

  it('activates on a successful connection and switches on the next one', async () => {
    await registry.connect('alpha', configFor('alpha'));
    expect(registry.getActiveId()).toBe('alpha');

    await registry.connect('beta', configFor('beta'));
    expect(registry.getActiveId()).toBe('beta');
    expect(registry.getActive()).toBe(beta.adapter);
  });

  it('switches explicitly without reconnecting', () => {
    registry.setActive('alpha');
    registry.setActive('beta');

    expect(registry.getActiveId()).toBe('beta');
    expect(alpha.adapter.connects).toBe(0);
    expect(beta.adapter.connects).toBe(0);
  });

  it('refuses to activate a provider that is not registered', () => {
    // The no-silent-fallback rule: an unknown target is an error, never a
    // quiet redirection to whichever provider happens to work.
    registry.setActive('alpha');

    expect(() => registry.setActive('gamma')).toThrow(/not registered/i);
    expect(registry.getActiveId()).toBe('alpha');
  });
});

describe('when a connection fails', () => {
  it('leaves the working provider active instead of replacing it', async () => {
    await registry.connect('alpha', configFor('alpha'));
    beta.adapter.authenticated = false;

    const result = await registry.connect('beta', configFor('beta'));

    expect(result.error?.code).toBe('AUTH_REQUIRED');
    expect(registry.getActiveId()).toBe('alpha');
    expect(registry.getActive()).toBe(alpha.adapter);
  });

  it('surfaces the failure rather than falling back to another provider', async () => {
    alpha.adapter.authenticated = false;

    const result = await registry.connect('alpha', configFor('alpha'));

    expect(result.error).toBeDefined();
    expect(registry.getActiveId()).toBeNull();
  });
});

describe('disconnecting', () => {
  it('clears the active provider only when it was the active one', async () => {
    await registry.connect('alpha', configFor('alpha'));

    await registry.disconnect('beta');
    expect(registry.getActiveId()).toBe('alpha');

    await registry.disconnect('alpha');
    expect(registry.getActiveId()).toBeNull();
    expect(alpha.adapter.disconnects).toBe(1);
  });
});
