/**
 * Provider registry (specification sections 11, 17, 48, 60).
 *
 * Owns which adapters exist, which one is active, and the rule that provider
 * switching is always explicit. There is no fallback path: if the configured
 * provider fails, the failure is surfaced.
 */
import { getLogger } from '@/logging/logger';
import { createError, type AgentError } from '@/types/result';
import type {
  AIProviderAdapter,
  ModelCapabilities,
  ProviderConfig,
  ProviderFactory,
} from '@/providers/core/types';

const log = getLogger('provider');

export interface ProviderConnection {
  readonly providerId: string;
  readonly modelId: string;
  readonly authKind: string;
  readonly accountLabel?: string;
  readonly capabilities?: ModelCapabilities;
  readonly createdAt: number;
  readonly lastValidated?: number;
  readonly status: 'connected' | 'limited' | 'failed' | 'disconnected';
}

export class ProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>();
  private readonly instances = new Map<string, AIProviderAdapter>();
  private activeProviderId: string | null = null;

  register(factory: ProviderFactory): void {
    if (this.factories.has(factory.id)) {
      throw new Error(`Provider "${factory.id}" is already registered.`);
    }
    this.factories.set(factory.id, factory);
    log.debug('Provider registered.', { providerId: factory.id });
  }

  list(): ProviderFactory[] {
    return [...this.factories.values()];
  }

  has(id: string): boolean {
    return this.factories.has(id);
  }

  /** Returns the singleton adapter instance for a provider id. */
  get(id: string): AIProviderAdapter {
    const existing = this.instances.get(id);
    if (existing) return existing;

    const factory = this.factories.get(id);
    if (!factory) {
      throw new Error(`Provider "${id}" is not registered.`);
    }
    const instance = factory.create();
    this.instances.set(id, instance);
    return instance;
  }

  /**
   * Connects a provider and makes it active.
   *
   * Marking the provider active only happens after authentication succeeds, so
   * a failed connection never silently replaces a working one.
   */
  async connect(
    id: string,
    config: ProviderConfig,
  ): Promise<{ adapter: AIProviderAdapter; error?: AgentError }> {
    const adapter = this.get(id);
    const result = await adapter.connect(config);
    if (!result.authenticated) {
      const error =
        result.error ??
        createError('AUTH_REQUIRED', `Authentication with ${adapter.displayName} failed.`);
      log.warn('Provider connection failed.', { providerId: id, code: error.code });
      return { adapter, error };
    }
    this.activeProviderId = id;
    log.info('Provider connected.', { providerId: id });
    return { adapter };
  }

  async disconnect(id: string): Promise<void> {
    const instance = this.instances.get(id);
    if (instance) await instance.disconnect();
    if (this.activeProviderId === id) this.activeProviderId = null;
  }

  getActiveId(): string | null {
    return this.activeProviderId;
  }

  getActive(): AIProviderAdapter | null {
    return this.activeProviderId ? this.get(this.activeProviderId) : null;
  }

  /**
   * Explicit provider switch.
   *
   * Throws when the target is not registered rather than falling back, which
   * is the "no silent provider fallback" rule from specification section 60.
   */
  setActive(id: string): void {
    if (!this.factories.has(id)) {
      throw new Error(`Cannot activate provider "${id}": it is not registered.`);
    }
    const previous = this.activeProviderId;
    this.activeProviderId = id;
    log.info('Active provider changed.', { from: previous, to: id });
  }

  /** Test seam: drops cached adapter instances. */
  resetInstances(): void {
    this.instances.clear();
    this.activeProviderId = null;
  }
}
