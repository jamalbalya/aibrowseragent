/**
 * Connector interfaces (specification sections 33, 34, 88).
 *
 * A connector is a structured integration with an external service. It is
 * **not** an AI provider and not a web provider: those three are separate
 * domains that happen to share an authorization state machine, and conflating
 * them is how a credential for one ends up authorising the other. Nothing in
 * this module references an AI provider.
 *
 * A connector is also not a hole in the egress architecture. A connector call
 * is an external data transfer, and it goes through the same gate a provider
 * request does — a different destination channel, the same one authorization
 * model.
 */
import type { AgentTool } from '@/tools/core/tool-types';
import type { DataSensitivity } from '@/security/exfiltration/exfiltration-guard';
import type { RiskLevel } from '@/policy/risk-classifier';

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

/**
 * One thing a connector can do.
 *
 * Every field is a control rather than documentation. `kind` decides whether
 * duplicate-write protection applies, `risk` feeds the policy engine,
 * `requiresConfirmation` survives into the permission prompt, and
 * `requiredScopes` is checked against what the user actually granted — a
 * connector that was authorised for read cannot run a write by asking nicely.
 */
export interface ConnectorOperation {
  readonly id: string;
  readonly kind: 'read' | 'write';
  readonly description: string;
  readonly sensitivity: DataSensitivity;
  readonly requiredScopes: readonly string[];
  readonly risk: RiskLevel;
  /** Whether the user is asked every time, regardless of permission mode. */
  readonly requiresConfirmation: boolean;
}

/**
 * OAuth configuration for a connector.
 *
 * The client id is not a secret and is declared here. There is deliberately
 * **no client secret**: a secret shipped inside an extension is readable by
 * anyone who unzips it, so this only supports flows that do not need one —
 * authorization code with PKCE, which is what public clients are for.
 */
export interface ConnectorOAuthConfig {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly redirectUri: string;
  /** Scopes requested for read-only use. */
  readonly readScopes: readonly string[];
  /** Additional scopes requested only when write operations are enabled. */
  readonly writeScopes: readonly string[];
  readonly extraAuthorizationParams?: Readonly<Record<string, string>>;
}

export interface ConnectorDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly authKind: ConnectorAuthKind;
  /** Site used by the exfiltration guard to decide if data is leaving home. */
  readonly site: string;
  readonly defaultSensitivity: DataSensitivity;
  /**
   * Every origin this connector may reach.
   *
   * Authorization is bound to scheme, host and port. A response that
   * redirects anywhere outside this list is refused rather than followed:
   * an API that can be made to redirect is an API that can be made to send
   * a bearer token somewhere it does not belong.
   */
  readonly apiOrigins: readonly string[];
  readonly operations: readonly ConnectorOperation[];
  /** Present when `authKind` is `oauth2`. */
  readonly oauth?: ConnectorOAuthConfig;
  /** Why each scope is requested, shown to the user and kept in the docs. */
  readonly scopeRationale: Readonly<Record<string, string>>;
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
    const problems = validateConnectorDescriptor(connector.descriptor);
    if (problems.length > 0) {
      throw new Error(
        `Connector "${connector.descriptor.id}" is not registrable — ${problems.join('; ')}`,
      );
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

/**
 * Checks a descriptor before it can be registered.
 *
 * Registration-time rather than use-time on purpose: a connector whose
 * redirect URI or origins are wrong should never become registrable, so the
 * failure happens when someone writes the entry rather than when a user is
 * halfway through authorising it.
 */
export function validateConnectorDescriptor(descriptor: ConnectorDescriptor): string[] {
  const problems: string[] = [];

  if (descriptor.id.trim().length === 0) problems.push('a connector id is required');
  if (descriptor.apiOrigins.length === 0) problems.push('at least one API origin is required');

  for (const origin of descriptor.apiOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      problems.push(`"${origin}" is not a usable origin`);
      continue;
    }
    // Loopback is allowed so a local mock service can be driven over real
    // sockets; everything else must be https, because a bearer token is
    // attached to every one of these requests.
    if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
      problems.push(`"${origin}" is not https`);
    }
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      problems.push(`"${origin}" must be an origin, with no path, query or fragment`);
    }
  }

  if (descriptor.authKind === 'oauth2') {
    const oauth = descriptor.oauth;
    if (!oauth) {
      problems.push('an oauth2 connector needs an oauth configuration');
    } else {
      // The endpoints this extension *sends* to must be https, because a
      // code, a verifier and a client id travel to them over the network.
      for (const [field, value] of [
        ['authorizationEndpoint', oauth.authorizationEndpoint],
        ['tokenEndpoint', oauth.tokenEndpoint],
      ] as const) {
        try {
          const parsed = new URL(value);
          if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
            problems.push(`${field} must be https`);
          }
        } catch {
          problems.push(`${field} is not a usable URL`);
        }
      }

      // The redirect URI is a destination the *browser* navigates to, and the
      // extension's own origin is the strongest option available: the
      // response never crosses the network at all, which is more than https
      // buys. Requiring https here rejected the one redirect this extension
      // can actually register — and because registration throws, that took
      // the whole service worker down with it.
      try {
        const parsed = new URL(oauth.redirectUri);
        const acceptable =
          parsed.protocol === 'https:' ||
          parsed.protocol === 'chrome-extension:' ||
          isLoopbackHost(parsed.hostname);
        if (!acceptable) {
          problems.push('redirectUri must be https, loopback, or this extension');
        }
      } catch {
        problems.push('redirectUri is not a usable URL');
      }
    }
  }

  const declared = new Set(descriptor.operations.flatMap((operation) => operation.requiredScopes));
  for (const scope of declared) {
    if (!(scope in descriptor.scopeRationale)) {
      problems.push(`scope "${scope}" has no stated rationale`);
    }
  }

  return problems;
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** The operation with this id, or `undefined`. */
export function findOperation(
  descriptor: ConnectorDescriptor,
  operationId: string,
): ConnectorOperation | undefined {
  return descriptor.operations.find((operation) => operation.id === operationId);
}

/** Every scope a descriptor's operations need, deduplicated and sorted. */
export function scopesFor(descriptor: ConnectorDescriptor, include: 'read' | 'all'): string[] {
  const operations = descriptor.operations.filter(
    (operation) => include === 'all' || operation.kind === 'read',
  );
  return [...new Set(operations.flatMap((operation) => operation.requiredScopes))].sort();
}
