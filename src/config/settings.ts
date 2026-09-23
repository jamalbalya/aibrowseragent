/**
 * Settings and credential storage (specification sections 16, 31, 55, 63).
 *
 * Credentials are kept in their own store, separate from settings and task
 * records, and are never included in a task, log, evidence item or model
 * request. `chrome.storage` is not encrypted at rest, and this is documented
 * rather than papered over: see docs/security.md.
 */
import { NamespacedStorageArea, type StorageArea } from '@/storage/storage-area';
import type { PermissionMode } from '@/policy/policy-engine';
import type { LogLevel } from '@/logging/logger';
import type { ProviderConnection } from '@/providers/registry/provider-registry';

export interface AppSettings {
  readonly permissionMode: PermissionMode;
  readonly logLevel: LogLevel;
  readonly debugMode: boolean;
  /**
   * Permit automating `http:` pages. Off by default.
   *
   * It does not unlock `file:`, which is on the unconditional block list —
   * see BLOCKED_SCHEMES. A convenience toggle for a local dev server must not
   * double as filesystem reach.
   */
  readonly allowInsecureOrigins: boolean;
  readonly notificationsEnabled: boolean;
  readonly activeProviderId: string | null;
  readonly activeModelId: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  permissionMode: 'auto',
  logLevel: 'info',
  debugMode: false,
  allowInsecureOrigins: false,
  notificationsEnabled: true,
  activeProviderId: null,
  activeModelId: null,
};

const SETTINGS_KEY = 'app-settings';
const CONNECTION_KEY = 'provider-connection';

export class SettingsStore {
  constructor(private readonly area: StorageArea) {}

  async get(): Promise<AppSettings> {
    const stored = await this.area.get<Partial<AppSettings>>(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = { ...(await this.get()), ...patch };
    await this.area.set(SETTINGS_KEY, next);
    return next;
  }

  getConnection(): Promise<ProviderConnection | undefined> {
    return this.area.get<ProviderConnection>(CONNECTION_KEY);
  }

  async setConnection(connection: ProviderConnection | null): Promise<void> {
    if (connection === null) await this.area.remove(CONNECTION_KEY);
    else await this.area.set(CONNECTION_KEY, connection);
  }
}

/** Non-secret half of a provider configuration. Safe to log and display. */
export interface StoredProviderConfig {
  readonly providerId: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly organization?: string;
  readonly project?: string;
}

/**
 * Credential store.
 *
 * Isolated behind its own namespace and its own type so that a credential
 * cannot be read by code that only holds a `SettingsStore`. Nothing in this
 * class is ever passed to the logger.
 */
export class CredentialStore {
  private readonly area: StorageArea;

  /**
   * @param backing  the raw storage.
   * @param protect  wraps the namespaced area, when K1 is switched on. Taken
   *   as a function rather than a flag so this class never learns whether it
   *   is writing ciphertext — which is what keeps the decision about *what* is
   *   protected in one place rather than spread through every store that
   *   happens to hold something sensitive.
   */
  constructor(backing: StorageArea, protect: (area: StorageArea) => StorageArea = (area) => area) {
    this.area = protect(new NamespacedStorageArea(backing, 'credentials'));
  }

  /** The unwrapped namespace, for the migration that converts it in place. */
  static plainArea(backing: StorageArea): StorageArea {
    return new NamespacedStorageArea(backing, 'credentials');
  }

  getApiKey(providerId: string): Promise<string | undefined> {
    return this.area.get<string>(`apiKey:${providerId}`);
  }

  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    await this.area.set(`apiKey:${providerId}`, apiKey);
  }

  async clear(providerId: string): Promise<void> {
    await this.area.remove(`apiKey:${providerId}`);
    await this.area.remove(`config:${providerId}`);
  }

  /**
   * A connected account's credential, keyed by connection.
   *
   * Separate methods rather than `getApiKey` with a doctored argument,
   * because the stored key is what matters and it must read as what it is.
   * `apiKey:<providerId>` is the legacy single-connection scheme and is
   * keyed by *provider*, so two accounts on one provider collide there —
   * which is the whole defect this replaces. `conn:<connectionId>` cannot
   * collide, and nothing has to remember to keep the two apart because they
   * are different call sites.
   */
  getConnectionKey(connectionId: string): Promise<string | undefined> {
    return this.area.get<string>(`conn:${connectionId}`);
  }

  async setConnectionKey(connectionId: string, apiKey: string): Promise<void> {
    await this.area.set(`conn:${connectionId}`, apiKey);
  }

  async clearConnectionKey(connectionId: string): Promise<void> {
    await this.area.remove(`conn:${connectionId}`);
  }

  getConfig(providerId: string): Promise<StoredProviderConfig | undefined> {
    return this.area.get<StoredProviderConfig>(`config:${providerId}`);
  }

  async setConfig(config: StoredProviderConfig): Promise<void> {
    await this.area.set(`config:${config.providerId}`, config);
  }
}

/** Masks a key for display: never render the full value. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}
