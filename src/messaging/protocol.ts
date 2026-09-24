/**
 * Typed extension message protocol (specification section 10).
 *
 * Every cross-context call — side panel ↔ service worker, service worker ↔
 * content script — is a member of this union. There are no `any` payloads and
 * no ad-hoc message shapes.
 */
import type { AgentTask, AgentSession, TaskState } from '@/tasks/task-model';
import type { AgentError } from '@/types/result';
import type { CapabilityReport } from '@/providers/capability-doctor/capability-doctor';
import type { AuthKind, ProviderOperation } from '@/providers/core/types';
import type { ProviderKind } from '@/providers/core/provider-kind';
import type { PermissionRequest, PermissionResponse } from '@/policy/permission-engine';
import type { FileSelectionRequest } from '@/background/file-broker';
import type { AuditEvent, AuditExport } from '@/audit/audit-log';
import type { HealthDomain, HealthSnapshot } from '@/storage/persistence-health';
import type { PermissionMode } from '@/policy/policy-engine';
import type { AuthorizationModel } from '@/policy/plan-model';
import type { ActedOnElement, SemanticPage } from '@/content/semantic-tree';
import {
  MAX_HINT_LENGTH,
  type FieldClass,
  type FieldObservation,
} from '@/policy/field-sensitivity';
import type { EvidenceReference } from '@/evidence/evidence-model';
import type { LogRecord } from '@/logging/logger';
import type { SitePolicyState } from '@/policy/site-policy';
import type { K1State } from '@/crypto/k1-store';
import type { ProviderConnection } from '@/providers/registry/provider-registry';
import type { ModelCapabilities } from '@/providers/core/types';
import type { StorageMode } from '@/storage/data-classification';
import type { ImportOutcome, ImportRefusal, LocalExport } from '@/storage/data-export';

export interface ExtensionMessage<TType extends string = string, TPayload = unknown> {
  readonly id: string;
  readonly type: TType;
  readonly timestamp: number;
  readonly payload: TPayload;
  /** Ties a response to its request. */
  readonly correlationId?: string;
}

/**
 * A recorded workflow as the side panel sees it.
 *
 * Carries the steps and their stored arguments, because reviewing a workflow
 * means seeing exactly what it will do. Anything that could not be shown
 * safely was never stored as a literal in the first place — the recorder
 * turns it into an input the user supplies at replay.
 */
export interface WorkflowSummary {
  readonly workflowId: string;
  readonly version: number;
  readonly formatVersion: number;
  readonly name: string;
  readonly description: string;
  readonly definitionHash: string;
  readonly risk: string;
  readonly tools: readonly string[];
  readonly recordedAt: number;
  readonly updatedAt: number;
  readonly taintAtCapture: string;
  /**
   * True when the recorder watched something it could not write down.
   *
   * Derived from `droppedSteps`, and the reason such a workflow cannot be
   * replayed: it would do something different from the task it came from.
   */
  readonly incomplete: boolean;
  /** What was dropped, in the positions it held. Shown in the review UI. */
  readonly droppedSteps: readonly {
    readonly afterStepId: string | null;
    readonly tool: string;
    readonly reason: string;
  }[];
  readonly steps: readonly {
    readonly id: string;
    readonly tool: string;
    readonly description: string;
    readonly arguments: Readonly<Record<string, { kind: string; detail: string }>>;
  }[];
  readonly inputs: readonly {
    readonly name: string;
    readonly type: string;
    readonly required: boolean;
    readonly description: string;
  }[];
}

/** A schedule target, on the wire. Mirrors `ScheduleTarget` exactly. */
export type ScheduleTargetWire =
  | { kind: 'shortcut'; shortcutId: string }
  | { kind: 'workflow'; workflowId: string }
  | { kind: 'skill'; skillId: string; skillVersion: string };

/** A cadence, on the wire. Mirrors `ScheduleCadence` exactly. */
export type ScheduleCadenceWire =
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number }
  | { kind: 'monthly'; day: number; hour: number; minute: number }
  | { kind: 'annual'; month: number; day: number; hour: number; minute: number };

/**
 * A schedule as the side panel sees it.
 *
 * `targetUsable` is resolved now, not stored: a schedule whose workflow was
 * deleted is shown as broken rather than as something that will run. The
 * cadence is described in the extension's own words, so nothing a page or a
 * model produced reaches this summary.
 */
export interface ScheduleSummary {
  scheduleId: string;
  displayName: string;
  target: ScheduleTargetWire;
  cadence: ScheduleCadenceWire;
  cadenceDescription: string;
  enabled: boolean;
  nextRunAt: number;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastRunStatus?: string;
  lastRunReason?: string;
  /** False when the target is missing or cannot run. Such a schedule fires nothing. */
  targetUsable: boolean;
  targetName: string;
}

/** One firing, as the side panel sees it. */
export interface ScheduleRunSummary {
  runId: string;
  scheduleId: string;
  occurrenceAt: number;
  startedAt: number;
  finishedAt?: number;
  status: string;
  reason?: string;
  taskId?: string;
}

/**
 * A shortcut as the side panel sees it.
 *
 * A name and a reference. There is nothing here describing what the target
 * does, because a shortcut does not know: the place to inspect that is the
 * review surface belonging to the workflow or skill it points at.
 */
export interface ShortcutSummary {
  readonly shortcutId: string;
  /** Exactly what the user typed, for display. */
  readonly displayName: string;
  /** The normalised name a typed `/command` is matched against. */
  readonly name: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly targetVersion?: string;
  /** The target's own name, or a note that it is no longer there. */
  readonly targetName: string;
  /** False when the target is missing or cannot run. Such a shortcut fails closed. */
  readonly usable: boolean;
  readonly createdAt: number;
}

/** Request/response pairs handled by the service worker. */
export interface PanelRequestMap {
  'task.create': {
    request: { objective: string; authorizationModel?: AuthorizationModel };
    response: { task: AgentTask };
  };
  /**
   * Approving the plan a Classic task proposed.
   *
   * The only route that produces a `PlanApproval`, and CLASS_B because of it:
   * a control-plane message the side-panel document is the only sender of. A
   * page, a content script, a connector, a skill and the model itself have no
   * way to send one, which is what makes "the user approved this" a fact about
   * where the message came from rather than a field somebody set.
   */
  'plan.approve': {
    request: { taskId: string };
    response: { task: AgentTask };
  };
  /**
   * Sending a proposal back to be rewritten.
   *
   * Creates no authorization. The task returns to planning with the person's
   * note attached, and nothing about its security state changes.
   */
  'plan.revise': {
    request: { taskId: string; note?: string };
    response: { task: AgentTask };
  };
  'task.get': {
    request: { taskId: string };
    response: { task: AgentTask | null };
  };
  'task.list': {
    request: { limit?: number };
    response: { tasks: AgentTask[] };
  };
  'task.pause': { request: { taskId: string }; response: { state: TaskState } };
  'task.resume': { request: { taskId: string }; response: { state: TaskState } };
  'task.cancel': { request: { taskId: string }; response: { state: TaskState } };
  'task.retry': { request: { taskId: string }; response: { task: AgentTask } };

  'session.get': { request: Record<string, never>; response: { session: AgentSession | null } };
  'session.setPermissionMode': {
    request: { mode: PermissionMode };
    response: { session: AgentSession };
  };

  'provider.list': {
    request: Record<string, never>;
    response: {
      providers: {
        id: string;
        displayName: string;
        description: string;
        kind: ProviderKind;
        authKind: AuthKind;
        /** Whether the user must supply an endpoint, and what it defaults to. */
        baseUrlRequired: boolean;
        defaultBaseUrl?: string;
        operations: readonly ProviderOperation[];
      }[];
    };
  };
  'provider.connect': {
    request: {
      providerId: string;
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      organization?: string;
      project?: string;
    };
    response: { connection: ProviderConnection | null; error?: AgentError };
  };
  'provider.disconnect': { request: { providerId: string }; response: { ok: true } };
  'provider.getConnection': {
    request: Record<string, never>;
    response: { connection: ProviderConnection | null };
  };
  'provider.listModels': {
    request: { providerId: string };
    response: { models: { id: string; displayName: string }[] };
  };
  'provider.runDoctor': {
    request: { providerId: string; modelId: string; quick?: boolean };
    response: { report: CapabilityReport };
  };
  'provider.setActive': {
    request: { providerId: string; modelId: string };
    response: { connection: ProviderConnection };
  };

  /**
   * Connected AI accounts.
   *
   * Alongside `provider.*` rather than replacing it. The provider routes
   * describe *provider families* — which adapters exist, what they need — and
   * remain exactly as they were. These describe the user's own connected
   * accounts, of which there may be several per family, each with its own
   * `connectionId`, its own credential and its own capability measurement.
   */
  /**
   * The authentication state the panel renders.
   *
   * Carries an `abaUserId` and an email for display, and **no token of any
   * kind** — the panel never holds one, so there is no route through which
   * one could reach a page.
   */
  'auth.status': {
    request: Record<string, never>;
    response: {
      configured: boolean;
      state: 'signed_out' | 'signed_in';
      abaUserId: string | null;
      email: string | null;
    };
  };
  /** Starts a Google sign-in. Opens a tab; resolves when it completes. */
  'auth.signInWithGoogle': {
    request: Record<string, never>;
    response: {
      ok: boolean;
      abaUserId: string | null;
      email: string | null;
      /** A safe code. Never says whether an account exists. */
      failure: string | null;
    };
  };
  /**
   * Renews the access token from the stored refresh token.
   *
   * Exposed so the panel can recover a session whose access token lapsed
   * without making the user sign in again. Concurrent callers are collapsed
   * into one request inside `SessionClient`, because a refresh token is
   * single-use and two presentations would revoke the family.
   */
  'auth.refresh': {
    request: Record<string, never>;
    response: {
      ok: boolean;
      /** `REVOKED` means sign in again; `UNREACHABLE` means try later. */
      failure: string | null;
    };
  };
  /**
   * Asks the backend to mail a one-time code.
   *
   * **The response cannot carry a code.** The fields are a challenge id and
   * two timestamps, and the panel needs all three: the id to present the
   * code against, `expiresAt` for the countdown, `resendAvailableAt` for the
   * resend button. A code has no field to travel in, here or anywhere on the
   * panel's side of the boundary.
   */
  'auth.startEmailSignIn': {
    request: { email: string };
    response: {
      ok: boolean;
      challengeId: string | null;
      expiresAt: number | null;
      resendAvailableAt: number | null;
      /** A safe code. Never says whether an account exists. */
      failure: string | null;
      retryAfterMs: number | null;
    };
  };
  /**
   * Presents a code and, on a match, establishes a session.
   *
   * The code travels panel → worker → backend and is stored nowhere on the
   * way. `failure` describes **this** sign-in attempt — a wrong code, an
   * expired challenge, spent attempts — and never an account.
   */
  'auth.verifyEmailSignIn': {
    request: { challengeId: string; code: string };
    response: {
      ok: boolean;
      abaUserId: string | null;
      email: string | null;
      failure: string | null;
      remainingAttempts: number | null;
      retryAfterMs: number | null;
    };
  };
  /**
   * The ways this account can be signed in to.
   *
   * **Authentication identities, not AI provider connections.** Those live on
   * `accounts.*` and are a different thing entirely: one decides how a person
   * proves who they are, the other decides which AI brain the agent uses.
   * Carries no token and no Google subject.
   */
  'identities.list': {
    request: Record<string, never>;
    response: {
      ok: boolean;
      identities: readonly {
        id: string;
        kind: 'google' | 'email';
        email: string | null;
        emailVerified: boolean;
        linkedAt: number;
        lastUsedAt: number | null;
        removable: boolean;
      }[];
      failure: string | null;
    };
  };
  /** Links a Google account to the account already signed in. Issues no session. */
  'identities.linkGoogle': {
    request: Record<string, never>;
    response: { ok: boolean; failure: string | null };
  };
  /** Asks the backend to mail a code for an address to be linked. */
  'identities.startEmailLink': {
    request: { email: string };
    response: {
      ok: boolean;
      challengeId: string | null;
      expiresAt: number | null;
      resendAvailableAt: number | null;
      failure: string | null;
    };
  };
  /** Presents that code. Attaches the address; never signs anybody in. */
  'identities.completeEmailLink': {
    request: { challengeId: string; code: string };
    response: { ok: boolean; failure: string | null };
  };
  /** Removes a linked identity, where the server permits it. */
  'identities.detach': {
    request: { identityId: string };
    response: { ok: boolean; revokedSessions: number; failure: string | null };
  };
  /** Ends the session, on the server as well as here. Deletes nothing. */
  'auth.signOut': {
    request: Record<string, never>;
    response: { ok: boolean };
  };

  'accounts.list': {
    request: Record<string, never>;
    response: {
      accounts: readonly ConnectedAccountView[];
      brain: { connectionId: string; modelId: string | null } | null;
    };
  };
  'accounts.connect': {
    request: {
      providerId: string;
      baseUrl?: string;
      apiKey: string;
      model?: string;
      displayName?: string;
    };
    response: { account: ConnectedAccountView | null; error?: AgentError };
  };
  'accounts.disconnect': { request: { connectionId: string }; response: { ok: true } };
  'accounts.listModels': {
    request: { connectionId: string };
    response: { models: { id: string; displayName: string }[] };
  };
  'accounts.runDoctor': {
    request: { connectionId: string; modelId: string; quick?: boolean };
    response: { report: CapabilityReport };
  };
  'accounts.setBrain': {
    request: { connectionId: string; modelId: string };
    response: { account: ConnectedAccountView; error?: AgentError };
  };
  'accounts.associationOffer': {
    request: Record<string, never>;
    response: { accounts: readonly ConnectedAccountView[]; declined: boolean };
  };
  'accounts.associate': {
    request: Record<string, never>;
    response: { associated: number; refused: number };
  };
  'accounts.declineAssociation': { request: Record<string, never>; response: { ok: true } };

  /**
   * Local encryption (K1).
   *
   * Five routes, all `CLASS_B_PANEL_CONTROL_PLANE`: switching protection on,
   * unlocking it and changing the passphrase are decisions a person makes, and
   * a model that could make them could unlock the credentials it is not
   * allowed to read.
   *
   * `k1.status` returns a state and an opaque key id and nothing else — no
   * salt, no iteration count, no wrapped key, no hash. A panel has no use for
   * any of them and a diagnostics view showing them would be an invitation.
   */
  'k1.status': {
    request: Record<string, never>;
    response: { state: K1State; keyId?: string; since?: number };
  };
  'k1.enable': {
    request: { passphrase: string };
    response:
      | { ok: true; state: K1State; encrypted: number }
      | { ok: false; reason: string; detail: string };
  };
  'k1.unlock': {
    request: { passphrase: string };
    response: { ok: true; state: K1State } | { ok: false; reason: string; detail: string };
  };
  'k1.lock': { request: Record<string, never>; response: { state: K1State } };
  /**
   * Changes the passphrase by re-wrapping the same data key.
   *
   * Reachable because a passphrase somebody may have seen is the one problem
   * a protected installation has no other answer to: there is no reset, no
   * recovery service, and disabling protection to re-enable it would decrypt
   * every record to disk in between.
   */
  'k1.changePassphrase': {
    request: { current: string; next: string };
    response: { ok: true } | { ok: false; reason: string; detail: string };
  };
  'k1.disable': {
    request: { passphrase: string };
    response: { ok: true; state: K1State } | { ok: false; reason: string; detail: string };
  };

  'storage.getPreference': {
    request: Record<string, never>;
    response: {
      /** Always `local` or `cloud`. There is no third runtime state. */
      mode: StorageMode;
      /** Whether the user ever chose, as opposed to running on the default. */
      hasChosen: boolean;
    };
  };
  'storage.setPreference': {
    request: { mode: StorageMode };
    response: { mode: StorageMode };
  };

  /**
   * Local export and import.
   *
   * Both cross no security boundary: the document travels over extension
   * messaging between this worker and a page of this extension. Writing it to
   * a file, or reading one, is the panel's doing and the user's choice. There
   * is no scheduled export, no export on sign-in and no upload anywhere.
   *
   * Neither is reachable by a model: both are `CLASS_B_PANEL_CONTROL_PLANE`,
   * the same class as every other destructive or data-moving operation.
   */
  'data.export': {
    request: Record<string, never>;
    response: { export: LocalExport };
  };
  'data.import': {
    request: {
      /** The parsed file, exactly as read. Untrusted; validated in full. */
      document: unknown;
    };
    response:
      { ok: true; outcome: ImportOutcome } | { ok: false; refusal: ImportRefusal; detail: string };
  };

  /**
   * Browser workspaces.
   *
   * Six routes, deliberately. One read answers everything the panel needs —
   * which workspaces exist, which is active, which tabs it holds *right now*,
   * and whether the tab in front of the user is one of them — because
   * splitting that into `list`, `get`, `current` and `tabs` would invite four
   * reads that can disagree with each other about the same moment.
   *
   * The five writers are each a distinct user intention. None is exposed to
   * the model: creating, switching and re-scoping are the user's decisions
   * about what the agent may see, and a model that could make them could
   * widen its own reach.
   */
  'workspace.state': {
    request: Record<string, never>;
    response: {
      workspaces: readonly WorkspaceView[];
      activeWorkspaceId: string | null;
      /** Live from Chrome, never from stored ids. A closed tab is absent. */
      tabs: readonly WorkspaceTabView[];
      /** The tab the user is looking at, and whether it is in scope. */
      currentTab: CurrentTabView | null;
    };
  };
  /** Starts a workspace from the tab the user is on. */
  'workspace.create': {
    request: { title?: string };
    response: { workspaceId: string; attached: boolean; error?: AgentError };
  };
  'workspace.switch': {
    request: { workspaceId: string };
    response: { activeWorkspaceId: string; error?: AgentError };
  };
  'workspace.addCurrentTab': {
    request: Record<string, never>;
    response: { added: boolean; tabId?: number; error?: AgentError };
  };
  'workspace.removeTab': {
    request: { tabId: number };
    response: { removed: boolean; error?: AgentError };
  };
  /** Gives a detached workspace a live Chrome group around the current tab. */
  'workspace.reattach': {
    request: { workspaceId: string };
    response: { attached: boolean; error?: AgentError };
  };

  'permission.respond': {
    request: { requestId: string; response: PermissionResponse };
    response: { ok: true };
  };
  /**
   * The user's answer to a file request.
   *
   * Only the side panel can send this: it is the only surface with a real
   * file picker behind a real user gesture, which is the whole mechanism.
   */
  'file.respondSelection': {
    request: {
      requestId: string;
      response:
        | {
            kind: 'selected';
            files: { name: string; mimeType: string; byteLength: number; dataBase64: string }[];
          }
        | { kind: 'cancelled'; reason?: string };
    };
    response: { accepted: boolean };
  };
  'file.listPendingSelections': {
    request: Record<string, never>;
    response: { requests: FileSelectionRequest[] };
  };
  /** Whether the optional `downloads` permission is currently granted. */
  'file.downloadsPermission': {
    request: Record<string, never>;
    response: { granted: boolean };
  };
  /** Connectors the product ships, and where each one currently stands. */
  'connector.list': {
    request: Record<string, never>;
    response: {
      connectors: {
        id: string;
        displayName: string;
        site: string;
        authKind: string;
        state: string;
        reason: string;
        scopes: readonly string[];
        accountLabel?: string;
        /** Whether a client id has been configured for this deployment. */
        configured: boolean;
        operations: { id: string; kind: 'read' | 'write'; description: string }[];
        scopeRationale: Readonly<Record<string, string>>;
      }[];
    };
  };
  /**
   * Starts an authorization.
   *
   * `includeWrite` is the scope decision, made by the user rather than by the
   * agent: a connector authorised for read cannot later be talked into a
   * write, because the scope was never granted.
   */
  'connector.authorize': {
    request: { connectorId: string; includeWrite?: boolean };
    response: { state: string; reason: string; scopes: readonly string[] };
  };
  'connector.disconnect': {
    request: { connectorId: string };
    response: { state: string };
  };
  /** Writes whose outcome was never confirmed, so a replay must be decided. */
  'connector.pendingWrites': {
    request: { taskId?: string };
    response: {
      writes: {
        key: string;
        connectorId: string;
        operation: string;
        taskId: string;
        outcome: string;
        startedAt: number;
      }[];
    };
  };
  /** Clears an uncertain write so a user-confirmed replay can proceed. */
  'connector.resolveWrite': {
    request: { key: string };
    response: { cleared: boolean };
  };
  'permission.listPending': {
    request: Record<string, never>;
    response: { requests: PermissionRequest[] };
  };

  /**
   * Durable persistence health (D-3).
   *
   * A read, and an acknowledgement that is the only way down the ladder.
   * Acknowledging does not repair anything — it records that a person has
   * seen what was lost and is choosing to continue.
   */
  'health.get': { request: Record<string, never>; response: { snapshot: HealthSnapshot } };
  'health.acknowledge': {
    request: { domain: HealthDomain };
    response: { snapshot: HealthSnapshot };
  };

  'policy.getSitePolicy': { request: Record<string, never>; response: { state: SitePolicyState } };
  'policy.removeSiteRule': { request: { site: string }; response: { state: SitePolicyState } };

  'audit.list': {
    request: { limit?: number; taskId?: string; site?: string; offset?: number };
    response: {
      events: readonly AuditEvent[];
      total: number;
      offset: number;
      limit: number;
      /** Non-null when a write failed, so a reader can see the trail has a gap. */
      degraded: string | null;
    };
  };
  /**
   * What the digest chain says about the stream.
   *
   * Corruption and reordering detection — a partial write, a dropped or
   * duplicated record, a reordered one. Not authenticated integrity: anyone
   * who can rewrite this extension's storage can rewrite the chain with it.
   */
  'audit.integrity': {
    request: Record<string, never>;
    response: { verdict: string; checked: number; atSeq?: number; note: string };
  };
  /**
   * Builds the export document and returns it to the side panel.
   *
   * The result crosses no security boundary: it travels over extension
   * messaging to a page of this extension, which is inside. Saving it
   * elsewhere would be an egress and is not what this does.
   */
  'audit.export': {
    request: {
      /**
       * Required, and never inferred.
       *
       * One task and every task are different things to be handed, and the
       * worker has no way to know which one a caller is looking at. An
       * omitted scope is an incomplete request rather than a default, so it
       * is refused — including here in the type, so a caller has to say.
       */
      scope: { kind: 'task'; taskId: string } | { kind: 'all' };
      limit?: number;
    };
    response: { export: AuditExport };
  };
  'evidence.listForTask': {
    request: { taskId: string };
    response: { evidence: EvidenceReference[] };
  };
  'evidence.getPayload': {
    request: { evidenceId: string };
    response: { content: string | null; mimeType: string; encoding: 'utf8' | 'base64' };
  };

  'debug.getLogs': { request: Record<string, never>; response: { logs: LogRecord[] } };
  'debug.setLogLevel': {
    request: { level: 'debug' | 'info' | 'warn' | 'error' };
    response: { ok: true };
  };

  'tools.list': {
    request: Record<string, never>;
    response: { tools: { name: string; description: string; risk: string }[] };
  };

  /**
   * The workflows this build ships.
   *
   * Read-only. There is deliberately no `skill.register`, `skill.install` or
   * `skill.update` route: a skill is trusted because it shipped in the build,
   * and a message that could add one would make the side panel — and anything
   * that can talk to it — a way to grant that trust.
   */
  'skill.list': {
    request: Record<string, never>;
    response: {
      skills: {
        id: string;
        version: string;
        name: string;
        description: string;
        risk: string;
        hash: string;
        steps: number;
        tools: string[];
        connectors: string[];
        inputs: { name: string; type: string; required: boolean; description: string }[];
      }[];
    };
  };
  /**
   * Shortcuts (P-021).
   *
   * A shortcut is a **name** for something that already exists and has
   * already been reviewed — a stored workflow, or a bundled skill. Every
   * route here creates, reads or deletes a name. None of them runs anything.
   *
   * There is deliberately **no `shortcut.run`** and no shortcut-specific
   * execution route of any kind. Invoking a shortcut means resolving it to a
   * target and then calling the route that already existed for that kind of
   * target — `workflow.replay` or `skill.run` — so a shortcut adds an alias
   * rather than an execution path, and grants no authority.
   *
   * Like every other route in this map, these are reachable only from the
   * side panel. There is no `shortcut.*` tool, so a model can neither manage
   * a shortcut nor invoke one.
   */
  'shortcut.list': {
    request: Record<string, never>;
    response: { shortcuts: ShortcutSummary[] };
  };
  'shortcut.create': {
    request: {
      name: string;
      target:
        | { kind: 'workflow'; workflowId: string }
        | { kind: 'skill'; skillId: string; skillVersion: string };
    };
    response: { shortcut: ShortcutSummary | null; error?: { reason: string; detail: string } };
  };
  /** Points an existing shortcut at a different target. Runs nothing. */
  'shortcut.retarget': {
    request: {
      shortcutId: string;
      target:
        | { kind: 'workflow'; workflowId: string }
        | { kind: 'skill'; skillId: string; skillVersion: string };
    };
    response: { shortcut: ShortcutSummary | null; error?: { reason: string; detail: string } };
  };
  'shortcut.remove': { request: { shortcutId: string }; response: { ok: true } };
  /**
   * Works out what a typed name means, and runs nothing.
   *
   * Safe to call on every keystroke: it is a read. The result is what the
   * user is shown before they commit, and showing it is not an
   * authorization — the target still asks for everything it would have asked
   * for.
   */
  'shortcut.resolve': {
    request: { typed: string };
    response: {
      ok: boolean;
      reason?: string;
      detail?: string;
      resolution?: {
        shortcutId: string;
        name: string;
        targetKind: string;
        targetName: string;
        targetId: string;
        targetVersion?: string;
        risk: string;
        stepCount: number;
      };
    };
  };

  /**
   * Schedules (P-020).
   *
   * A schedule is a **clock** attached to a shortcut, a workflow or a bundled
   * skill. Every route here creates, reads, edits, pauses or deletes one, or
   * runs one because a person pressed a button. None of them describes what
   * to do: a schedule carries a reference and a cadence, and nowhere to put
   * an objective, an argument, a page value or a credential.
   *
   * There is deliberately **no scheduled execution route a model can reach**,
   * and no `schedule.*` tool. Like every route in this map these are
   * panel-only, so a model can neither create a schedule nor cause one to
   * fire.
   *
   * `schedule.runNow` is the one route here that executes, and it is
   * *attended* on purpose: a person pressed it with the panel open, so it
   * runs under an ordinary session and can ask them to confirm an action. A
   * run the clock started cannot, and stops at that boundary instead — see
   * `docs/architecture/SCHEDULED_EXECUTION.md`.
   */
  'schedule.list': {
    request: Record<string, never>;
    response: { schedules: ScheduleSummary[] };
  };
  'schedule.create': {
    request: {
      name: string;
      target: ScheduleTargetWire;
      cadence: ScheduleCadenceWire;
    };
    response: { schedule: ScheduleSummary | null; error?: { reason: string; detail: string } };
  };
  'schedule.edit': {
    request: {
      scheduleId: string;
      name?: string;
      target?: ScheduleTargetWire;
      cadence?: ScheduleCadenceWire;
    };
    response: { schedule: ScheduleSummary | null; error?: { reason: string; detail: string } };
  };
  /** Pauses or resumes. A paused schedule computes occurrences and runs none. */
  'schedule.setEnabled': {
    request: { scheduleId: string; enabled: boolean };
    response: { schedule: ScheduleSummary | null; error?: { reason: string; detail: string } };
  };
  'schedule.remove': { request: { scheduleId: string }; response: { ok: true } };
  /**
   * Runs a schedule now, because a person asked.
   *
   * Does not touch the schedule's clock: no occurrence is claimed, the next
   * firing is unchanged, and a missed occurrence stays missed. This is how
   * somebody acts on a run that stopped at the confirmation boundary.
   */
  'schedule.runNow': {
    request: { scheduleId: string };
    response: { run: ScheduleRunSummary | null; error?: { reason: string; detail: string } };
  };
  /** Stops a run that is in flight. Steps already taken are not undone. */
  'schedule.cancelRun': {
    request: { runId: string };
    response: { cancelled: boolean };
  };
  /** Firing history, newest first. Every schedule's, or one schedule's. */
  'schedule.runs': {
    request: { scheduleId?: string };
    response: { runs: ScheduleRunSummary[] };
  };

  /**
   * Runs a bundled skill because a person asked (P-021).
   *
   * The user-initiated counterpart of the `skills.run` tool, reaching the
   * same `SkillRunner` and therefore the same per-step dispatch. It takes an
   * id and a pinned version, never a definition, so nothing can describe a
   * skill into existence. Being a panel route rather than a tool is what
   * keeps it out of a model's reach.
   */
  'skill.run': {
    request: {
      skillId: string;
      skillVersion: string;
      inputs?: Record<string, string | number | boolean>;
    };
    response: {
      ok: boolean;
      taskId?: string;
      status?: string;
      summary?: string;
      reason?: string;
      detail?: string;
      steps?: { step: string; ran: string; status: string }[];
    };
  };

  /**
   * Recorded workflows (P-022).
   *
   * Read, replay and delete. There is deliberately no `workflow.register`,
   * `workflow.install` or anything that would put a recording into the skill
   * registry: registration is what makes something model-invokable, and a
   * recording has had no review of the *combination* of tools it reaches. A
   * recorded workflow therefore never appears in `skills.list`, is never
   * offered to a model, and runs only through `workflow.replay` below — which
   * is reachable only from this surface, and only when a person asks.
   *
   * Recording and saving are separate from replaying on purpose: nothing in
   * the record/stop/save/review half of this map executes a single step.
   */
  'workflow.recordStart': {
    request: { taskId: string };
    response: { recording: boolean; taskId: string };
  };
  /**
   * Ends a recording and stores what it captured. Runs nothing.
   *
   * The name and description come from the user, at the moment they decide to
   * keep the recording, which is the review step in the lifecycle.
   */
  'workflow.recordStop': {
    request: { name: string; description: string };
    response: {
      workflow: WorkflowSummary | null;
      /** Calls that were seen but not recorded, and why. */
      skipped: { afterStepId: string | null; tool: string; reason: string }[];
    };
  };
  'workflow.recordCancel': { request: Record<string, never>; response: { ok: true } };
  'workflow.recordStatus': {
    request: Record<string, never>;
    response: {
      recording: boolean;
      taskId: string;
      stepCount: number;
      skipped: { afterStepId: string | null; tool: string; reason: string }[];
    };
  };
  'workflow.list': { request: Record<string, never>; response: { workflows: WorkflowSummary[] } };
  'workflow.get': {
    request: { workflowId: string };
    response: { workflow: WorkflowSummary | null };
  };
  'workflow.remove': { request: { workflowId: string }; response: { ok: true } };
  /**
   * Re-checks a stored workflow without running it.
   *
   * So the review surface can say why a workflow will not run — a removed
   * tool, a changed schema, a record that no longer matches its hash — rather
   * than finding out by executing half of it.
   */
  'workflow.revalidate': {
    request: { workflowId: string };
    response: {
      ok: boolean;
      reason?: string;
      detail?: string;
      /** Recomputed now, not read from the stored record. */
      risk?: string;
      tools?: string[];
      riskChanged?: boolean;
    };
  };
  /**
   * Runs a stored workflow, as an explicit user action.
   *
   * Every step still goes through `ToolRegistry.dispatch`, so the permission
   * prompts, policy checks and egress decisions happen again, against the
   * world as it is now. Being stored pre-approves nothing.
   */
  'workflow.replay': {
    request: { workflowId: string; inputs?: Record<string, string | number | boolean> };
    response: {
      ok: boolean;
      taskId?: string;
      status?: string;
      summary?: string;
      reason?: string;
      detail?: string;
      steps?: { step: string; ran: string; status: string }[];
    };
  };
  'workflow.cancelReplay': { request: { taskId: string }; response: { cancelled: boolean } };
  /** Skill runs for a task, so an interrupted one is visible rather than lost. */
  'skill.runs': {
    request: { taskId?: string };
    response: {
      runs: {
        runId: string;
        taskId: string;
        skillId: string;
        skillVersion: string;
        stepIndex: number;
        totalSteps: number;
        state: string;
        startedAt: number;
      }[];
    };
  };
}

/**
 * A connected account as the panel sees it.
 *
 * Deliberately not `ConnectedAccount`: the panel has no business with
 * `abaUserId` or `capabilityScope`, and a view type means a field added to the
 * stored record does not reach the UI — or any event broadcast — merely by
 * existing. No credential field exists here or in the stored record.
 */
export interface ConnectedAccountView {
  readonly connectionId: string;
  readonly providerId: string;
  readonly protocol: string;
  readonly displayName: string;
  /** Endpoint plus the key's last four characters. Never the key. */
  readonly accountLabel: string;
  readonly authKind: string;
  readonly baseUrl?: string;
  readonly modelId: string | null;
  readonly capabilities: ModelCapabilities | null;
  readonly status: string;
  readonly statusReason?: string;
  readonly lastValidated: number | null;
  readonly createdAt: number;
  /** True when this account is the current AI brain. */
  readonly isBrain: boolean;
}

/** A workspace as the panel lists it. */
export interface WorkspaceView {
  readonly workspaceId: string;
  readonly title: string;
  /** `detached` means no live Chrome group — normal, never an implicit close. */
  readonly state: 'attached' | 'detached';
  readonly liveTabCount: number;
  readonly isActive: boolean;
}

/**
 * A tab in the active workspace, read live from Chrome.
 *
 * No stored tab id reaches the panel: a tab id is a recyclable runtime handle,
 * and showing a remembered one would present a closed tab — or someone
 * else's — as live context.
 */
export interface WorkspaceTabView {
  readonly tabId: number;
  readonly title: string;
  readonly url: string;
  readonly active: boolean;
}

/** The tab the user is looking at, whether or not it is in the workspace. */
export interface CurrentTabView {
  readonly tabId: number;
  readonly title: string;
  readonly url: string;
  /** False means the panel says so and offers to add it. Never adds it. */
  readonly inActiveWorkspace: boolean;
}

export type PanelRequestType = keyof PanelRequestMap;
export type PanelRequest<T extends PanelRequestType> = PanelRequestMap[T]['request'];
export type PanelResponse<T extends PanelRequestType> = PanelRequestMap[T]['response'];

/** Requests the service worker sends into a content script. */
export interface ContentRequestMap {
  'content.ping': { request: Record<string, never>; response: { ready: true; url: string } };
  'content.readPage': {
    request: { maxElements?: number; includeText?: boolean };
    response: { page: SemanticPage };
  };
  /**
   * Interaction responses carry `actedOn`: a six-scalar description of the
   * element the action used, computed from the node the content script had
   * already resolved. It exists so a recording can name the element the way
   * §49 asks — a role and an accessible name — instead of a handle that is
   * meaningless after the snapshot that minted it. It is page-derived data
   * and is never returned to the model; the registry routes it to the
   * observation hook and nowhere else.
   */
  'content.click': {
    request: { elementId: string };
    response: { clicked: true; navigated: boolean; actedOn?: ActedOnElement };
  };
  /**
   * `sensitivityCeiling` is the most sensitive class of field the worker
   * authorised this write against. It travels in this direction only. The
   * content script compares the live element against it and may *refuse*; it
   * has no way to express anything else, and nothing in the page can raise it.
   *
   * Required, not optional. An optional ceiling would have an absent case, and
   * the absent case would have to mean something — whichever meaning it were
   * given, a caller that forgot to set it would get that meaning by accident.
   */
  'content.type': {
    request: {
      elementId: string;
      text: string;
      sensitivityCeiling: FieldClass;
      clearFirst?: boolean;
      submit?: boolean;
    };
    response: { typed: true; actedOn?: ActedOnElement };
  };
  'content.select': {
    request: { elementId: string; value: string };
    response: { selected: true; value: string; actedOn?: ActedOnElement };
  };
  /**
   * Sets a structured input (date, time, colour, range, number) to a value.
   *
   * Separate from `content.type` because these controls are not typed into:
   * typing lands in whichever segment has focus, and a range has no segments
   * at all.
   */
  'content.setValue': {
    request: { elementId: string; value: string; sensitivityCeiling: FieldClass };
    response: { value: string; type: string; adjusted?: boolean; actedOn?: ActedOnElement };
  };
  /** Sets the whole selection of a multi-select, rather than adding to it. */
  'content.selectMany': {
    request: { elementId: string; values: readonly string[] };
    response: { values: readonly string[]; actedOn?: ActedOnElement };
  };
  'content.setChecked': {
    request: { elementId: string; checked: boolean };
    response: {
      checked: boolean;
      value: string;
      kind: 'checkbox' | 'radio';
      actedOn?: ActedOnElement;
    };
  };
  'content.scroll': {
    request: { direction: 'up' | 'down' | 'top' | 'bottom'; amount?: number; elementId?: string };
    response: { scrollY: number; atBottom: boolean };
  };
  'content.getState': {
    request: Record<string, never>;
    response: {
      url: string;
      title: string;
      readyState: string;
      scrollY: number;
      documentHeight: number;
    };
  };
  'content.waitForSelector': {
    request: { selector: string; timeoutMs: number };
    response: { found: boolean };
  };
  /**
   * Places already-selected files into a file input.
   *
   * Bytes are base64 because extension messaging is a JSON channel — a `File`
   * or an `ArrayBuffer` does not survive it.
   */
  'content.attachFiles': {
    request: {
      elementId: string;
      files: { name: string; mimeType: string; dataBase64: string }[];
    };
    response: { attached: number; names: string[]; inputWasHidden: boolean };
  };
  'content.clearFiles': {
    request: { elementId: string };
    response: { cleared: true };
  };
}

export type ContentRequestType = keyof ContentRequestMap;
export type ContentRequest<T extends ContentRequestType> = ContentRequestMap[T]['request'];
export type ContentResponse<T extends ContentRequestType> = ContentRequestMap[T]['response'];

/** Events broadcast by the service worker to any listening side panel. */
export type AgentEvent =
  | { readonly type: 'task.updated'; readonly task: AgentTask }
  | { readonly type: 'task.activity'; readonly taskId: string; readonly activity: string }
  | {
      readonly type: 'task.streamDelta';
      readonly taskId: string;
      readonly delta: string;
    }
  | { readonly type: 'permission.requested'; readonly request: PermissionRequest }
  | { readonly type: 'permission.resolved'; readonly requestId: string }
  | { readonly type: 'file.selectionRequested'; readonly request: FileSelectionRequest }
  | { readonly type: 'file.selectionResolved'; readonly requestId: string }
  | { readonly type: 'provider.statusChanged'; readonly connection: ProviderConnection | null }
  | { readonly type: 'workspace.changed' }
  /**
   * A schedule or one of its runs changed (P-020).
   *
   * Carries nothing: it is a hint to re-read, not a payload. A scheduled run
   * finishes while the panel may be closed, and a broadcast that carried the
   * outcome would be a copy of state the panel has to re-read anyway.
   */
  | { readonly type: 'schedules.changed' }
  | {
      readonly type: 'accounts.changed';
      readonly accounts: readonly ConnectedAccountView[];
      readonly brain: { readonly connectionId: string; readonly modelId: string | null } | null;
    }
  | { readonly type: 'log'; readonly record: LogRecord };

export const EVENT_MESSAGE_TYPE = 'agent.event';

/** Envelope for a response, so failures cross the boundary as data. */
export type ResponseEnvelope<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AgentError };

/**
 * Runtime validation for the field observations a page read carries.
 *
 * Everything else crossing this boundary is unwrapped by envelope shape and
 * then asserted into its TypeScript type, which is a promise about a value
 * rather than a check of one. That was tolerable while the payload only ever
 * reached the model, which treats all of it as untrusted text anyway. It stops
 * being tolerable the moment a payload reaches the policy engine: a compile-
 * time type cannot stop a hostile shape, and a hostile shape that reached
 * `classifyField` would be choosing its own class.
 *
 * Scope is deliberately this payload and no other. Validating all thirteen
 * content responses is the right eventual shape and is a larger change than
 * this one should carry.
 *
 * Fails by throwing rather than by substituting a default. A malformed
 * observation set is not a page that lacks fields — the content script is
 * first-party code and cannot emit one — so it means the channel is not
 * carrying what it claims. Answering that with an empty array would let a
 * tampered response present itself as an ordinary page with no inputs.
 */
export function validateFieldObservations(raw: unknown): readonly FieldObservation[] {
  if (!Array.isArray(raw)) {
    throw new Error('Page read returned a malformed field observation set.');
  }

  const validated: FieldObservation[] = [];
  for (const entry of raw) {
    validated.push(validateFieldObservation(entry));
  }
  return validated;
}

/** Keys that are never legitimate on a received record. */
const FORBIDDEN_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

function validateFieldObservation(raw: unknown): FieldObservation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Page read returned a malformed field observation.');
  }

  // `Object.keys` reports own enumerable keys, so an inherited property
  // planted on a prototype is not mistaken for a supplied one — and a literal
  // `__proto__` key, which is what a pollution attempt actually sends, is
  // refused outright rather than silently reassigning a prototype below.
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      throw new Error('Page read returned a field observation with a forbidden key.');
    }
  }

  const record = raw as Record<string, unknown>;

  // Rebuilt field by field into a fresh literal rather than spread. A spread
  // would carry across whatever else the sender put in the object, and an
  // extra key on a value the policy engine reads is exactly the thing worth
  // dropping.
  return {
    elementId: boundedString(record['elementId'], 'elementId'),
    fieldType: boundedString(record['fieldType'], 'fieldType'),
    autocompleteToken: boundedString(record['autocompleteToken'], 'autocompleteToken'),
    inputMode: boundedString(record['inputMode'], 'inputMode'),
    maxLength: finiteInteger(record['maxLength'], 'maxLength'),
    formActionSite: boundedString(record['formActionSite'], 'formActionSite'),
    nameHint: boundedString(record['nameHint'], 'nameHint'),
    idHint: boundedString(record['idHint'], 'idHint'),
    isInShadowRoot: strictBoolean(record['isInShadowRoot'], 'isInShadowRoot'),
    isInSubframe: strictBoolean(record['isInSubframe'], 'isInSubframe'),
  };
}

/**
 * A string, of a sane length, and nothing that merely converts to one.
 *
 * `typeof` rather than a coercion because an object with a `toString` is not a
 * string, and treating it as one is how a value that pattern-matches as
 * harmless at validation time becomes something else when read again.
 */
function boundedString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Page read returned a non-string ${field}.`);
  }
  return value.slice(0, MAX_HINT_LENGTH);
}

function finiteInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Page read returned a non-integer ${field}.`);
  }
  return value;
}

function strictBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Page read returned a non-boolean ${field}.`);
  }
  return value;
}
