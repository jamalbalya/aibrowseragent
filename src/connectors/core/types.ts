/**
 * Connector interfaces (specification sections 33, 34, 88).
 *
 * Status: FOUNDATION. The interfaces and registry exist so connector tools can
 * be added without reshaping the runtime; no connector adapter ships yet.
 * Nothing here fakes a response — an unimplemented capability raises
 * NOT_IMPLEMENTED rather than returning a plausible-looking success.
 */
import type { AgentTool } from '@/tools/core/tool-types';
import type { DataSensitivity } from '@/security/exfiltration/exfiltration-guard';

export type ConnectorAuthKind = 'oauth2' | 'api_token' | 'basic' | 'none';

export interface ConnectorAuthState {
  readonly authenticated: boolean;
  readonly expiresAt?: number;
  readonly scopes: readonly string[];
  readonly accountLabel?: string;
}

export interface ConnectorCapability {
  readonly id: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly requiredScopes: readonly string[];
}

export interface ConnectorDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly authKind: ConnectorAuthKind;
  /** Site used by the exfiltration guard to decide if data is leaving home. */
  readonly site: string;
  readonly defaultSensitivity: DataSensitivity;
}

/**
 * A structured service integration.
 *
 * Connector calls are preferred over browser automation when both can do the
 * job safely (specification section 41); that choice lives in the orchestrator,
 * not in any individual tool.
 */
export interface Connector {
  readonly descriptor: ConnectorDescriptor;
  authenticate(): Promise<ConnectorAuthState>;
  getAuthState(): Promise<ConnectorAuthState>;
  revoke(): Promise<void>;
  listCapabilities(): Promise<ConnectorCapability[]>;
  /** Tools this connector contributes to the registry. */
  createTools(): AgentTool[];
}

export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();

  register(connector: Connector): void {
    if (this.connectors.has(connector.descriptor.id)) {
      throw new Error(`Connector "${connector.descriptor.id}" is already registered.`);
    }
    this.connectors.set(connector.descriptor.id, connector);
  }

  get(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  list(): Connector[] {
    return [...this.connectors.values()];
  }

  /** Every tool contributed by every registered connector. */
  allTools(): AgentTool[] {
    return this.list().flatMap((connector) => connector.createTools());
  }
}
