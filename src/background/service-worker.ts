/**
 * MV3 service worker: the authoritative orchestration layer.
 *
 * Composition happens here and nowhere else. The dependency graph is wired
 * once, top-down, so every collaborator receives its dependencies explicitly
 * and none of them reaches for a global.
 *
 * The worker is ephemeral. Nothing important lives only in this module's
 * closure: tasks, settings, evidence and permission history are all persisted,
 * and `LifecycleManager` reconciles them on every startup.
 */
import { getLogger, recentLogs, setGlobalLogLevel } from '@/logging/logger';
import { createError } from '@/types/result';
import { newSessionId } from '@/utils/ids';
import {
  ChromeStorageArea,
  NamespacedStorageArea,
  SerializedStorageArea,
} from '@/storage/storage-area';
import { PersistenceHealthStore } from '@/storage/persistence-health';
import { connectionAfterSwitch, isProviderSwitch } from './provider-switch';
import { SettingsStore, CredentialStore } from '@/config/settings';
import { TaskStore } from '@/tasks/task-store';
import { generateTaintSalt } from '@/tasks/task-model';
import { EvidenceStore } from '@/evidence/evidence-store';
import { ProviderRegistry, type ProviderConnection } from '@/providers/registry/provider-registry';
import { ConsentStore } from '@/security/egress/consent';
import {
  AuditLog,
  buildAuditExport,
  describeScopeProblem,
  parseAuditExportScope,
} from '@/audit/audit-log';
import { createDispatchAuditObserver } from '@/audit/dispatch-audit';
import { createGuardedTransport, guardedSend } from '@/security/egress/provider-transport';
import { installNetworkInterceptor } from '@/security/egress/network-interceptor';
import { buildEgressEvidence } from '@/security/egress/egress-evidence';
import { connectorDestination, providerDestination } from '@/security/egress/destination';
import { CapabilityDoctor } from '@/providers/capability-doctor/capability-doctor';
import {
  openAICompatibleFactory,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from '@/providers/adapters/openai-compatible';
import { anthropicFactory, ANTHROPIC_PROVIDER_ID } from '@/providers/adapters/anthropic';
import { geminiFactory, GEMINI_PROVIDER_ID } from '@/providers/adapters/gemini';
import { UNKNOWN_CAPABILITIES } from '@/providers/core/types';
import { ToolRegistry } from '@/tools/registry/tool-registry';
import { ChromeBrowserAdapter } from '@/tools/browser/chrome-adapter';
import { createBrowserTools } from '@/tools/browser/browser-tools';
import { createTabTools, TabOwnership } from '@/tools/tabs/tab-tools';
import { DebuggerManager } from '@/tools/debugger/debugger-manager';
import { createDebuggerTools } from '@/tools/debugger/debugger-tools';
import { createFileTools } from '@/tools/files/file-tools';
import { StagedFileStore } from '@/files/file-store';
import { ChromeDownloadPort } from '@/files/download-port';
import { FileSelectionBroker } from './file-broker';
import { safeDisplayName } from '@/files/file-model';
import { ConnectorRegistry, scopesFor } from '@/connectors/core/types';
import { ConnectorSession } from '@/connectors/core/connector-session';
import { TokenVault } from '@/connectors/oauth/token-vault';
import { WriteGuard } from '@/connectors/core/write-guard';
import { TabAuthFlow, chromeTabs } from '@/connectors/oauth/auth-flow-port';
import { createConnectorTransport } from '@/connectors/transport/connector-transport';
import { DEFAULT_BUDGET } from '@/agent/budget/budget';
import { SkillRegistry } from '@/skills/core/skill-registry';
import { SkillRunner } from '@/skills/runtime/skill-runner';
import { SkillRunStore } from '@/skills/runtime/skill-run-store';
import { BUNDLED_SKILLS } from '@/skills/bundled';
import { createSkillTools } from '@/tools/skills/skill-tools';
import { WorkflowStore, WorkflowValidationError } from '@/workflows/workflow-store';
import { WorkflowRecorder } from '@/workflows/workflow-recorder';
import { WorkflowReplayer } from '@/workflows/workflow-replay';
import { ShortcutStore, ShortcutError } from '@/shortcuts/shortcut-store';
import { ShortcutResolver } from '@/shortcuts/shortcut-resolver';
import { SkillLauncher } from './skill-launcher';
import type { ShortcutRecord } from '@/shortcuts/shortcut-model';
import type { ShortcutSummary } from '@/messaging/protocol';
import { isIncomplete, type RecordedWorkflow } from '@/workflows/workflow-model';
import type { WorkflowSummary } from '@/messaging/protocol';
import {
  GitHubConnector,
  githubDescriptor,
  type ConnectorCallContext,
} from '@/connectors/adapters/github';
import { PermissionEngine } from '@/policy/permission-engine';
import { emptySitePolicyState, removeRule, type SitePolicyState } from '@/policy/site-policy';
import type { PolicyContext } from '@/policy/policy-engine';
import { AgentRuntime } from '@/agent/runtime/agent-runtime';
import { TaskManager } from './task-manager';
import { PermissionBroker } from './permission-broker';
import { LifecycleManager } from './lifecycle-manager';
import { MessageRouter } from './message-router';
import { broadcastEvent } from '@/messaging/bus';
import { Notifier } from '@/notifications/notifier';
import type { AgentSession } from '@/tasks/task-model';

// Installed before anything else can capture a pristine primitive. Defence in
// depth only: the boundary is the guarded transport and the tool-level egress
// declarations, and this cannot see content scripts or the page world at all.
installNetworkInterceptor();

const log = getLogger('agent');

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const local = new SerializedStorageArea(new ChromeStorageArea(chrome.storage.local));

/**
 * In-memory storage, for things that must not reach the disk.
 *
 * `chrome.storage.session` is held in memory and cleared when the browser
 * closes, and its access level is set to trusted contexts so a content script
 * cannot read it. Connector tokens live here: they survive the constant
 * service-worker evictions and do not survive a browser restart, which is the
 * right trade for a bearer credential.
 */
const session = new SerializedStorageArea(new ChromeStorageArea(chrome.storage.session));
void chrome.storage.session
  .setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })
  .catch(() => undefined);
/**
 * Durable persistence health (D-3).
 *
 * Constructed before the stores that report into it, and on the same
 * serialized area, so a report is written under the same mutex as the writes
 * it describes.
 */
import { WorkspaceStore } from '@/workspaces/workspace-store';
import { WorkspaceReconciler } from '@/workspaces/workspace-reconciler';
import {
  checkMembership,
  deriveWorkspaceTitle,
  TAB_GROUP_ID_NONE,
} from '@/workspaces/workspace-model';
import { AccountStore } from '@/providers/accounts/account-store';
import {
  accountAfterSelection,
  credentialKeyFor,
  UNASSIGNED_ABA_USER,
  type ConnectedAccount,
} from '@/providers/accounts/account-model';
import { migrateLegacyConnection } from '@/providers/accounts/migrate-legacy';
import { connectionForBrain } from '@/providers/accounts/brain-projection';
import { protocolForLegacyProvider } from '@/providers/accounts/migrate-legacy';
import { deriveAccountLabel } from '@/providers/accounts/account-model';
import { IdentityProfileStore } from '@/identity/identity-profile';
import { LocalIdentityStore, resolveOwner } from '@/identity/local-identity';
import { SessionStore } from '@/identity/session-store';
import { AuthController } from '@/identity/auth-controller';
import { EmailSignIn } from '@/identity/email-sign-in';
import { GoogleSignIn } from '@/identity/google-sign-in';
import { SessionClient } from '@/identity/session-client';
import { IdentityTransport } from '@/identity/identity-transport';
import { loadIdentityConfig } from '@/identity/identity-config';
import { DataStoragePreferenceStore } from '@/storage/data-storage-preference';
import { applyLocalExport, buildLocalExport, parseLocalExport } from '@/storage/data-export';
import { K1Store } from '@/crypto/k1-store';
import { ProtectedStorageArea } from '@/crypto/protected-storage-area';
import { protectExistingRecords, unprotectExistingRecords } from '@/crypto/protect-existing';
import { K1AwareArea } from '@/crypto/k1-aware-area';
import { UnlockError } from '@/crypto/passphrase-key';
import type { ConnectedAccountView } from '@/messaging/protocol';

const persistenceHealth = new PersistenceHealthStore(new NamespacedStorageArea(local, 'health'));
const settingsStore = new SettingsStore(new NamespacedStorageArea(local, 'settings'));
/**
 * Local encryption (K1), and the one store it protects.
 *
 * Provider API keys and connector credentials are the records whose
 * disclosure costs the user something outside this extension — they are paid
 * for, they reach services the extension has nothing to do with, and they may
 * not be re-issuable. Everything else the extension persists is either
 * already memory-only, or is the user's own work, which a passphrase prompt
 * on every browser start would make worse rather than safer.
 *
 * `k1Durable` deliberately sits on the raw `local` area rather than a
 * namespaced one, so the state flag and the wrapped key are plain records that
 * the protected area never tries to decrypt. The unwrapped key lives in
 * `session`, which Chrome holds in memory and never writes to disk.
 */
const k1 = new K1Store(local, session);
const credentialStore = new CredentialStore(
  local,
  (area) => new K1AwareArea(area, k1, 'credentials'),
);
/** The same namespace without the protection, for switching K1 on and off. */
const credentialPlainArea = CredentialStore.plainArea(local);
const credentialProtectedArea = new ProtectedStorageArea(credentialPlainArea, k1, 'credentials');
/**
 * Connected AI accounts, the identity profile, and where data should live.
 *
 * Three separate namespaces with three separate lifetimes. The account store
 * holds persistent user data and the identity store holds who that user is;
 * neither is reachable from the code that ends an authentication session,
 * which is what keeps a session expiring from ever looking like a reset.
 */
const accountStore = new AccountStore(new NamespacedStorageArea(local, 'accounts'));
const identityProfile = new IdentityProfileStore(
  new NamespacedStorageArea(local, 'identity-profile'),
);
const dataStoragePreference = new DataStoragePreferenceStore(
  new NamespacedStorageArea(local, 'settings'),
);

/**
 * The authentication session.
 *
 * Two areas on purpose: the refresh half on disk so a browser restart does
 * not sign anyone out, the access half in the memory-backed session area so
 * it does not outlive the browser. Measured behaviour, not an assumption.
 */
const sessionStore = new SessionStore(
  // The durable half holds a refresh token, which is a long-lived credential
  // on disk and therefore exactly what K1 is for. The volatile half is already
  // memory-only and has nothing to protect.
  new K1AwareArea(new NamespacedStorageArea(local, 'identity-session'), k1, 'identity-session'),
  new NamespacedStorageArea(session, 'identity-session'),
);
const identitySessionPlainArea = new NamespacedStorageArea(local, 'identity-session');
const identitySessionProtectedArea = new ProtectedStorageArea(
  identitySessionPlainArea,
  k1,
  'identity-session',
);

const localIdentity = new LocalIdentityStore(new NamespacedStorageArea(local, 'identity-local'));

/**
 * Whose data this is.
 *
 * A signed-in profile if there is one, otherwise the installation's own
 * locally minted identity — which every installation has, because the
 * extension is standalone and does not wait for an account to know whose
 * data it is holding.
 *
 * **`unassigned` is now a failure answer rather than the normal one.** It was
 * the value every installation ran under while sign-in was the only source of
 * an owner, and the account model refuses to bind anything to it by name — so
 * returning it means ownership is genuinely unresolved, and the health report
 * beside it stops work rather than letting rows be written under a label
 * nothing agrees on. Callers keep the string they always had; what changed is
 * that they now normally get a real one.
 */
async function currentAbaUserId(): Promise<string> {
  const established = await localIdentity.ensure();
  if (!established.ok) {
    await persistenceHealth.report('storage', 'RECOVERY_REQUIRED', established.failure);
    return UNASSIGNED_ABA_USER;
  }

  const resolved = resolveOwner(
    await identityProfile.abaUserId(),
    established.identity.installationId,
  );
  if (!resolved.ok) {
    await persistenceHealth.report('storage', 'RECOVERY_REQUIRED', resolved.failure);
    return UNASSIGNED_ABA_USER;
  }
  return resolved.abaUserId;
}

/**
 * Established at startup, not on first use.
 *
 * An installation has to know whose data it is holding *before* anything can
 * write a row under an owner, so this runs once as the worker comes up rather
 * than waiting for whichever route happens to ask first. It is memoised, so
 * every later caller is a single read, and a failure reports itself into
 * persistence health on the way through — which is what stops work rather
 * than letting rows be written under a label nothing agrees on.
 */
void currentAbaUserId();

const taskStore = new TaskStore(new NamespacedStorageArea(local, 'tasks'), {
  health: persistenceHealth,
});
const evidenceStore = new EvidenceStore(new NamespacedStorageArea(local, 'evidence'));
const auditLog = new AuditLog(new NamespacedStorageArea(local, 'audit'), {
  // A tool name reaches the trail from a model proposal, so it is checked
  // against what this build actually registered. An unrecognised name is
  // recorded as unknown and the proposed string is dropped, which stops the
  // trail being a model-writable text field.
  knownTool: (name) => toolRegistry.has(name),
  // A lost audit record is recorded where worker eviction cannot erase it.
  // It does not stop anything: a gap in the record is a gap in the record of
  // an execution that already happened.
  health: persistenceHealth,
});
const policyArea = new NamespacedStorageArea(local, 'policy');
const connectorTokens = new TokenVault(new NamespacedStorageArea(session, 'connector-tokens'));
const connectorWrites = new WriteGuard(new NamespacedStorageArea(local, 'connector-writes'));

const SITE_POLICY_KEY = 'site-policy';
const SESSION_KEY = 'active-session';

const loadSitePolicy = async (): Promise<SitePolicyState> =>
  (await policyArea.get<SitePolicyState>(SITE_POLICY_KEY)) ?? emptySitePolicyState();

const saveSitePolicy = async (state: SitePolicyState): Promise<void> => {
  await policyArea.set(SITE_POLICY_KEY, state);
};

const loadPolicyContext = async (): Promise<PolicyContext> => {
  const settings = await settingsStore.get();
  // Kept for the audit observer, which cannot await storage on the dispatch
  // path. It labels a record; it decides nothing.
  currentPermissionMode = settings.permissionMode;
  return {
    mode: settings.permissionMode,
    sitePolicy: await loadSitePolicy(),
    allowInsecureOrigins: settings.allowInsecureOrigins,
  };
};

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * Consent grants for this worker generation.
 *
 * Not persisted on purpose: a grant that outlived a restart would outlive the
 * context the user saw when giving it, and re-asking is the safe direction.
 */
const consentStore = new ConsentStore();

/**
 * The transport every provider adapter is built with.
 *
 * Injected here so that reaching the network through the gate is a property
 * of how an adapter is constructed rather than of what it remembers to call.
 */
const providerTransport = createGuardedTransport({
  consent: consentStore,
  onDecision: async (decision, context, url, payload) => {
    const built = await buildEgressEvidence({
      taskId: context.taskId,
      sourceTool: 'provider.request',
      destination: providerDestination(context.providerId, url, context.modelId),
      decision,
      ...(payload === undefined ? {} : { payload }),
      taintSalt: context.taintSalt,
      saltEpoch: context.saltEpoch,
      now: Date.now(),
    });
    const stored = await evidenceStore.put(built.reference, {
      content: JSON.stringify(built.detail),
      encoding: 'utf8',
      mimeType: 'application/json',
    });
    await auditLog.record({
      type: 'egress.decided',
      taskId: context.taskId,
      tool: 'provider.request',
      ...(decision.destinationIdentity === null
        ? {}
        : { destination: decision.destinationIdentity }),
      providerId: context.providerId,
      modelId: context.modelId,
      outcome:
        decision.verdict === 'allow'
          ? 'allowed'
          : decision.verdict === 'deny'
            ? 'denied'
            : 'confirmed',
      code: decision.code,
      evidenceIds: [stored.id],
    });
  },
});

const providerRegistry = new ProviderRegistry({ transport: providerTransport });
// Every registered provider is an API provider built with the guarded
// transport above. Web providers are foundation only and are not registered
// here: registering one would make it selectable, and inference against an
// authenticated web session remains closed.
providerRegistry.register(openAICompatibleFactory);
providerRegistry.register(anthropicFactory);
providerRegistry.register(geminiFactory);
const capabilityDoctor = new CapabilityDoctor();

// ---------------------------------------------------------------------------
// Browser, tools and the policy control plane
// ---------------------------------------------------------------------------

const browserAdapter = new ChromeBrowserAdapter();
const debuggerManager = new DebuggerManager();
const tabOwnership = new TabOwnership();

const notifier = new Notifier({
  isEnabled: async () => (await settingsStore.get()).notificationsEnabled,
});

const permissionBroker = new PermissionBroker({
  notify: (request) => {
    void notifier.permissionRequested(request.tool);
  },
});

/**
 * Files a user has chosen for the run.
 *
 * Bytes are held here in memory and written nowhere. Losing them when the
 * worker is evicted is the accepted cost of never putting a user's document
 * into extension storage; the task's taint is persisted separately, so the
 * security state survives even though the file does not.
 */
const stagedFiles = new StagedFileStore();
const downloadPort = new ChromeDownloadPort();

/**
 * The only route to a local file.
 *
 * A request carries a purpose and never a path — there is nowhere in it to
 * put one — so a model cannot name a file to read. The person picks.
 */
const fileSelectionBroker = new FileSelectionBroker({
  onWaiting: (request) => {
    void taskManager
      .markWaitingForUser(request.taskId, 'Waiting for you to choose a file.')
      .catch(() => undefined);
  },
  onSettled: (request) => {
    void taskManager.markUserResponded(request.taskId).catch(() => undefined);
  },
});

const permissionEngine = new PermissionEngine({
  onDecision: async (entry) => {
    await auditLog.record({
      type: 'permission.decided',
      taskId: entry.taskId,
      tool: entry.tool,
      site: entry.site,
      risk: entry.risk,
      outcome:
        entry.decision === 'approved' || entry.decision === 'auto_approved' ? 'allowed' : 'denied',
      code: entry.decision,
    });
  },
  prompter: permissionBroker,
  loadSitePolicy,
  saveSitePolicy,
});

/**
 * Browser workspaces: which tabs are in scope for a task.
 *
 * The durable record is in `local`; the Chrome handles are in `session`,
 * because a tab-group id is deleted by Chrome when its last tab leaves and is
 * not stable across a browser restart. Persisting one to disk would mean
 * restoring a handle that now names something else.
 */
const workspaceStore = new WorkspaceStore(
  new NamespacedStorageArea(local, 'workspaces'),
  new NamespacedStorageArea(session, 'workspaces'),
  { health: persistenceHealth },
);

/** Does this Chrome tab group still exist? A deleted group detaches its workspace. */
async function groupExists(chromeTabGroupId: number): Promise<boolean> {
  try {
    await chrome.tabGroups.get(chromeTabGroupId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is this tab live context for this task?
 *
 * Every reading is taken from Chrome **now**. Nothing cached takes part, which
 * is what makes a tab the user has just dragged out stop being context on the
 * very next operation rather than at the next event — and what stops a
 * recycled tab id inheriting the membership of the tab that used to hold it.
 */
async function checkWorkspaceMember(
  taskId: string,
  tabId: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const task = await taskStore.getTask(taskId);
  const workspaceId = task?.workspaceId;
  const binding = workspaceId ? await workspaceStore.binding(workspaceId) : null;
  const verdict = checkMembership({
    taskWorkspaceId: workspaceId,
    binding,
    groupExists: binding === null ? false : await groupExists(binding.chromeTabGroupId),
    tab: await browserAdapter.getTab(tabId),
  });
  return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
}

/**
 * The workspace a new task runs in, creating one if there is none.
 *
 * Requirement one of the feature: activating the agent from a tab makes that
 * tab the initial context. So the first task on a fresh install adopts the
 * tab the user is looking at, groups it, and binds the workspace to that
 * group — the user gets a scope without having to think about scopes.
 *
 * Creating is the *only* thing derived from the active tab. Which workspace
 * is **active** thereafter changes only on an explicit selection: inferring it
 * from whatever tab is in front would mean a stray click on another
 * workspace's tab silently re-pointed a running task, which is precisely the
 * cross-workspace targeting this boundary exists to prevent.
 */
async function ensureActiveWorkspace(): Promise<string | undefined> {
  const existingId = await workspaceStore.getActiveId();
  if (existingId) {
    const binding = await workspaceStore.binding(existingId);
    // Attached and still real: use it.
    if (binding && (await groupExists(binding.chromeTabGroupId))) return existingId;
    // Detached. Re-attach it around the tab the user is on rather than
    // silently starting a second workspace beside it.
    const reattached = await attachWorkspaceToActiveTab(existingId);
    if (reattached) return existingId;
    return existingId;
  }

  const active = await browserAdapter.getActiveTab();
  if (!active) return undefined;

  const workspaceId = workspaceStore.mintWorkspaceId();
  await workspaceStore.put({
    workspaceId,
    abaUserId: await currentAbaUserId(),
    title: deriveWorkspaceTitle(active.url),
    members: [],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  });
  const attached = await attachWorkspaceToActiveTab(workspaceId);
  if (!attached) {
    // Tab groups are a desktop-Chrome feature. Where they are unavailable the
    // workspace cannot bind, and the honest outcome is a workspace with no
    // scope — which refuses browser work — rather than silently falling back
    // to unrestricted targeting.
    log.warn('A workspace could not be attached to a tab group.', { workspaceId });
  }
  await workspaceStore.setActiveId(workspaceId);
  return workspaceId;
}

/** Puts the user's current tab into this workspace's group, creating it. */
async function attachWorkspaceToActiveTab(workspaceId: string): Promise<boolean> {
  const active = await browserAdapter.getActiveTab();
  if (!active) return false;
  try {
    const chromeTabGroupId = await chrome.tabs.group({ tabIds: [active.id] });
    await chrome.tabGroups.update(chromeTabGroupId, {
      title: (await workspaceStore.get(workspaceId))?.title ?? 'Workspace',
    });
    await workspaceStore.bind({
      workspaceId,
      chromeTabGroupId,
      // Recorded for display and focus only. Window identity is never
      // workspace identity: two workspaces may share one window.
      chromeWindowId: active.windowId,
      boundAt: Date.now(),
    });
    await workspaceReconciler.handleGroupChanged(active.id, chromeTabGroupId);
    return true;
  } catch (error) {
    log.warn('Attaching a workspace to a tab group failed.', {
      workspaceId,
      error: error instanceof Error ? error.name : 'unknown',
    });
    return false;
  }
}

/** The tabs this task's workspace holds right now, read live from Chrome. */
async function resolveWorkspaceTabs(taskId: string): Promise<readonly number[]> {
  const task = await taskStore.getTask(taskId);
  if (!task?.workspaceId) return [];
  const binding = await workspaceStore.binding(task.workspaceId);
  if (binding === null) return [];
  if (!(await groupExists(binding.chromeTabGroupId))) return [];
  const tabs = await chrome.tabs.query({ groupId: binding.chromeTabGroupId });
  return tabs.map((tab) => tab.id).filter((id): id is number => id !== undefined);
}

const toolRegistry = new ToolRegistry({
  checkWorkspaceMember,
  resolveWorkspaceTabs,
  resolveWorkspaceGroupId: async (taskId) => {
    const task = await taskStore.getTask(taskId);
    if (!task?.workspaceId) return undefined;
    const bound = await workspaceStore.binding(task.workspaceId);
    if (bound === null) return undefined;
    return (await groupExists(bound.chromeTabGroupId)) ? bound.chromeTabGroupId : undefined;
  },
  // A page write's destination is the page itself, so the tab's URL has to be
  // known before the call is classified rather than found inside the tool.
  resolveTabUrl: async (tabId) => {
    try {
      return (await browserAdapter.getTab(tabId))?.url;
    } catch {
      // Unknown means unknown: the gate denies rather than guessing an origin.
      return undefined;
    }
  },
  publishSecurityContext: (taskId, context) => {
    connectorEgressContexts.set(taskId, context);
  },
  /**
   * The workflow recorder's observation hook (P-022).
   *
   * An observer, and only an observer: it is handed a frozen, deep-cloned
   * record of a dispatch that has already completed, so nothing it does can
   * affect the call it is watching, grant it anything, or start another one.
   * When no recording is running it does nothing at all.
   */
  onDispatched: [
    (observation) => {
      workflowRecorder.observe(observation);
    },
    // The one place a tool execution becomes an audit record. Each observer
    // runs in its own try/catch inside the registry, so a failure in either
    // leaves the other working.
    (observation) => {
      dispatchAuditObserver(observation);
    },
  ],
  egress: {
    consent: consentStore,
    record: async (input) => {
      const built = await buildEgressEvidence(input);
      const stored = await evidenceStore.put(built.reference, {
        content: JSON.stringify(built.detail),
        encoding: 'utf8',
        mimeType: 'application/json',
      });
      await auditLog.record({
        type: 'egress.decided',
        taskId: input.taskId,
        tool: input.sourceTool,
        ...(input.decision.destinationIdentity === null
          ? {}
          : { destination: input.decision.destinationIdentity }),
        ...(input.destination.origin === undefined ? {} : { origin: input.destination.origin }),
        ...(input.destination.providerId === undefined
          ? {}
          : { providerId: input.destination.providerId }),
        ...(input.destination.modelId === undefined ? {} : { modelId: input.destination.modelId }),
        outcome:
          input.decision.verdict === 'allow'
            ? 'allowed'
            : input.decision.verdict === 'deny'
              ? 'denied'
              : 'confirmed',
        code: input.decision.code,
        // The digest lives in evidence; the trail points at it rather than
        // holding a second copy of anything.
        evidenceIds: [stored.id],
      });
    },
  },
  permissionEngine,
  loadPolicyContext,
  evidenceStore,
});
// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

/**
 * The client id for each connector, supplied per deployment.
 *
 * Empty here, because this project owns no OAuth application. A connector
 * without one reports as unconfigured and refuses to start an authorization —
 * it does not invent a flow that cannot complete.
 */
const CONNECTOR_CLIENT_IDS: Readonly<Record<string, string>> = {};

/**
 * The redirect the authorization lands on.
 *
 * A real page inside the extension, declared as a web-accessible resource for
 * the authorization origins and nothing else.
 *
 * Both halves of that were established by running it. A bare extension path
 * that is *not* web-accessible cannot be redirected to at all: Chromium
 * refuses the navigation with `net::ERR_BLOCKED_BY_CLIENT`, so an
 * authorization would end on an error page and no callback would ever be
 * seen. Declaring the page web-accessible makes the redirect arrive intact,
 * with its code and state. The `matches` list is kept to the origins that
 * actually redirect here, because a broad one would let any page on the web
 * confirm this extension is installed.
 *
 * The page itself carries no script. The extension watches the one tab it
 * opened for a navigation whose origin and path match this exactly and takes
 * the code from that URL; a page that parsed its own URL and messaged the
 * code onward would be a second path for a credential to travel.
 */
const CONNECTOR_REDIRECT_URI = chrome.runtime.getURL('oauth/callback.html');

/**
 * A route failure the message router can report as an `AgentError`.
 *
 * The router reads `agentError` off whatever was thrown; wrapping keeps it a
 * real `Error`, so a stack exists and the linter's "throw an Error" rule is
 * satisfied rather than suppressed.
 */
class RouteError extends Error {
  constructor(readonly agentError: ReturnType<typeof createError>) {
    super(agentError.message);
    this.name = 'RouteError';
  }
}

const connectorRegistry = new ConnectorRegistry();

/** Evidence key for authentication traffic, which belongs to no task. */
const connectorAuthSalt = generateTaintSalt();

/**
 * The token exchange.
 *
 * Deliberately not routed through the connector transport. The token endpoint
 * is authentication, not a task data operation: it carries no task taint, must
 * not carry a bearer token, and must not be attributed to a task in the audit
 * trail. It is also the one place an authorization code exists, so it is kept
 * as small as possible and its body is never logged.
 */
async function exchangeConnectorToken(
  endpoint: string,
  body: URLSearchParams,
): Promise<Record<string, unknown>> {
  const response = await guardedSend(
    {
      url: endpoint,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
        // Never followed: a token endpoint that redirects is one that could
        // be made to carry an authorization code somewhere else.
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      },
      destination: connectorDestination('oauth-token-exchange', endpoint, {
        purpose: 'token_exchange',
      }),
      // No task is behind this and none may be attributed to it. The clean
      // state says there is no task, not that one was inspected.
      taskId: 'connector-authentication',
      taintState: { kind: 'KNOWN_UNTAINTED' },
      taintSalt: connectorAuthSalt,
      taintSignature: 'authentication',
      describe: 'connector token exchange',
      // The body is a credential by construction; see the transport.
      payloadPolicy: 'opaque',
    },
    { consent: consentStore },
  );

  if (!response.ok) {
    // The status, never the body: a token endpoint's error response can echo
    // the authorization code back.
    throw new Error(`token_endpoint_status_${response.status}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

const githubDescriptorValue = githubDescriptor({ redirectUri: CONNECTOR_REDIRECT_URI });

const githubSession = new ConnectorSession({
  descriptor: githubDescriptorValue,
  vault: connectorTokens,
  authFlow: new TabAuthFlow(chromeTabs()),
  clientId: CONNECTOR_CLIENT_IDS[githubDescriptorValue.id] ?? '',
  exchange: exchangeConnectorToken,
  onStatusChange: (status) => {
    void auditLog
      .record({
        type: 'connector.auth',
        connectorId: status.connectorId,
        connectorState: status.state,
        outcome: status.state === 'READY' ? 'allowed' : 'info',
        code: status.reason,
        scopes: status.scopes,
      })
      .catch(() => undefined);
  },
});

const githubConnector = new GitHubConnector({
  descriptor: githubDescriptorValue,
  session: githubSession,
  transport: createConnectorTransport({
    descriptor: githubDescriptorValue,
    vault: connectorTokens,
    consent: consentStore,
    onDecision: async (decision, context, url, payload) => {
      const built = await buildEgressEvidence({
        taskId: context.taskId,
        sourceTool: `connector.${context.connectorId}.${context.operationId}`,
        destination: connectorDestination(context.connectorId, url, {
          purpose: context.operationId,
        }),
        decision,
        ...(payload === undefined ? {} : { payload }),
        taintSalt: context.taintSalt,
        saltEpoch: context.saltEpoch,
        now: Date.now(),
      });
      const stored = await evidenceStore.put(built.reference, {
        content: JSON.stringify(built.detail),
        encoding: 'utf8',
        mimeType: 'application/json',
      });
      await auditLog.record({
        type: 'connector.operation',
        taskId: context.taskId,
        connectorId: context.connectorId,
        operation: context.operationId,
        ...(decision.destinationIdentity === null
          ? {}
          : { destination: decision.destinationIdentity }),
        outcome:
          decision.verdict === 'allow'
            ? 'allowed'
            : decision.verdict === 'deny'
              ? 'denied'
              : 'confirmed',
        code: decision.code,
        evidenceIds: [stored.id],
      });
    },
  }),
  writes: connectorWrites,
  // The connector never builds its own security context: it asks the runtime
  // for the one belonging to the task making the call, so a connector request
  // carries exactly the taint that task accumulated.
  egressFor: (taskId) => connectorEgressContexts.get(taskId),
});

/**
 * Registers a connector without letting a bad one take the extension down.
 *
 * `register` throws on an unregistrable descriptor, which is the right
 * behaviour for a programming error — but this is module scope, so an
 * uncaught throw here stops the rest of this file from evaluating and every
 * `router.on` below it from being registered. That is exactly what happened:
 * one descriptor rejected for its redirect URI silently killed *all* side
 * panel messaging, with no error anywhere a user or a test would look.
 *
 * So the throw is caught, the connector is left out, and the reason is
 * logged. A missing connector is a missing feature; a worker that never
 * finishes loading is a dead extension.
 */
function registerConnector(connector: GitHubConnector): void {
  try {
    connectorRegistry.register(connector);
  } catch (error) {
    log.error('A connector could not be registered and has been left out.', {
      connectorId: connector.descriptor.id,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

registerConnector(githubConnector);

/**
 * Security contexts for in-flight tasks.
 *
 * Populated by the task manager on every turn and read by connector tools.
 * Held rather than passed because a tool's execution context carries the task
 * id but not the taint, and a connector call must inherit the task's taint
 * rather than starting from a clean one.
 */
const connectorEgressContexts = new Map<string, ConnectorCallContext>();

/**
 * The audit observer the tool registry calls after every dispatch.
 *
 * Declared here, beside the security contexts it reads, because the record it
 * writes carries the task's permission mode and taint *kind* — never its
 * sources, which name sites the user visited.
 */
const dispatchAuditObserver = createDispatchAuditObserver({
  audit: auditLog,
  contextFor: (taskId) => {
    const security = connectorEgressContexts.get(taskId);
    return {
      ...(security === undefined ? {} : { taintKind: security.taintState.kind }),
      ...(currentPermissionMode === null ? {} : { permissionMode: currentPermissionMode }),
    };
  },
});

/**
 * The permission mode as of the last settings read.
 *
 * Cached rather than awaited, because an audit observer must not make the
 * dispatch path wait on storage. A stale value is a label on a record, not an
 * input to a decision — the policy engine reads settings itself.
 */
let currentPermissionMode: string | null = null;

toolRegistry.registerAll(
  createFileTools({
    adapter: browserAdapter,
    broker: fileSelectionBroker,
    store: stagedFiles,
    downloads: downloadPort,
    // Structured file events, separate from the egress decision the gate
    // already records: one says what was authorised, the other what happened.
    recordFileEvent: async (event) => {
      await auditLog.record(event);
    },
  }),
);
toolRegistry.registerAll(connectorRegistry.allTools());
toolRegistry.registerAll(createBrowserTools({ adapter: browserAdapter, debuggerManager }));
toolRegistry.registerAll(createTabTools({ adapter: browserAdapter, ownership: tabOwnership }));
toolRegistry.registerAll(
  createDebuggerTools({ adapter: browserAdapter, manager: debuggerManager }),
);

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/**
 * The trusted skill registry.
 *
 * Constructed after every tool is registered, and not before: a skill is only
 * registrable if every tool it names already exists, so registering skills
 * first would reject all of them. The dependency runs one way — skills know
 * about tools, tools know nothing about skills.
 */
const skillRegistry = new SkillRegistry({
  riskOfTool: (name) => toolRegistry.get(name)?.risk,
});

const skillRuns = new SkillRunStore(new NamespacedStorageArea(local, 'skill-runs'));

const skillRunner = new SkillRunner({
  tools: toolRegistry,
  skills: skillRegistry,
  /**
   * Per-step progress into the audit trail.
   *
   * `skill.step` was declared from the start and never written. The progress
   * hook already carries the task id, the pinned version and the definition
   * hash, and carries no step result — which is exactly the shape an audit
   * record needs and exactly what a step record must not grow into.
   */
  onProgress: async (progress) => {
    await auditLog.record({
      type: 'skill.step',
      taskId: progress.taskId,
      outcome: 'info',
      skillId: progress.skillId,
      skillVersion: progress.skillVersion,
      skillHash: progress.skillHash,
      stepIndex: progress.stepIndex,
      stepCount: progress.totalSteps,
      code: progress.status,
    });
  },
  // The task's own remaining allowance. A skill gets no budget of its own,
  // because a second budget is a way past the first.
  remainingToolCalls: (taskId) => skillBudgetRemaining.get(taskId) ?? DEFAULT_BUDGET.maxToolCalls,
});

/**
 * Tool calls each running task has left.
 *
 * Maintained from the task manager's usage observer, which fires as a task
 * spends its allowance. A task nobody has reported usage for yet has spent
 * nothing, so it gets the full budget — and every step still passes through
 * the registry, which enforces the real limits regardless of what this says.
 */
const skillBudgetRemaining = new Map<string, number>();

toolRegistry.registerAll(
  createSkillTools({
    registry: skillRegistry,
    runner: skillRunner,
    runs: skillRuns,
    securityFor: (taskId) => connectorEgressContexts.get(taskId),
    audit: async (event) => {
      await auditLog.record({
        type: event.type,
        taskId: event.taskId,
        outcome: event.outcome,
        skillId: event.skillId,
        skillVersion: event.skillVersion,
        skillHash: event.skillHash,
        ...(event.step === undefined ? {} : { step: event.step }),
        ...(event.ran === undefined ? {} : { ran: event.ran }),
        ...(event.code === undefined ? {} : { code: event.code }),
      });
    },
  }),
);

/**
 * Registers the bundled skills.
 *
 * A definition that will not validate is left out and logged, rather than
 * thrown at module scope: an uncaught throw here would stop the rest of this
 * file evaluating and take every message route with it, which is a failure
 * this worker has had once already and will not have again.
 */
async function registerBundledSkills(): Promise<void> {
  for (const definition of BUNDLED_SKILLS) {
    try {
      await skillRegistry.register(definition);
    } catch (error) {
      log.error('A bundled skill could not be registered and has been left out.', {
        skillId: definition.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Recorded workflows (P-022)
// ---------------------------------------------------------------------------

/**
 * Recordings live here, and nowhere near the skill registry.
 *
 * A recording is validated by the same validator and run by the same runner
 * as a bundled skill, but it is deliberately not registered: registration is
 * what puts something in `skills.list` and therefore in front of a model, and
 * nobody has reviewed the *combination* of tools a user's recording reaches.
 * So a recorded workflow is never model-visible, never model-selectable and
 * never replayed automatically. The only way one runs is a person choosing to
 * run it, through the side panel's replay route.
 */
const workflowStore = new WorkflowStore({
  area: new NamespacedStorageArea(local, 'workflows'),
  riskOfTool: (name) => toolRegistry.get(name)?.risk,
  health: persistenceHealth,
});

const workflowRecorder = new WorkflowRecorder({
  // The recording task's own taint, read at the moment each call is observed.
  // A task whose context cannot be found is treated as unknowable rather than
  // clean, and the parameteriser then stores none of its arguments.
  taintFor: (taskId) => connectorEgressContexts.get(taskId)?.taintState,
});

const workflowReplayer = new WorkflowReplayer({
  store: workflowStore,
  runner: skillRunner,
  tools: toolRegistry,
  tasks: taskStore,
  getPermissionMode: async () => (await settingsStore.get()).permissionMode,
  resolveWorkspaceId: ensureActiveWorkspace,
  getActiveTabId: async () => (await browserAdapter.getActiveTab())?.id,
  publishSecurityContext: (taskId, context) => {
    connectorEgressContexts.set(taskId, context);
  },
  audit: async (event) => {
    await auditLog.record({
      type: event.type,
      taskId: event.taskId,
      workflowId: event.workflowId,
      skillVersion: String(event.workflowVersion),
      skillHash: event.definitionHash,
      outcome: event.outcome,
      ...(event.code === undefined ? {} : { code: event.code }),
    });
  },
  onTaskChanged: (task) => {
    broadcastEvent({ type: 'task.updated', task });
  },
});

/**
 * A recording, as the review surface sees it.
 *
 * Bindings are described rather than dumped: a literal shows its value,
 * because reviewing a workflow means seeing what it will actually do, while a
 * slot shows only that something will be asked for. Nothing that could not be
 * shown was stored as a literal in the first place.
 */
function summariseWorkflow(record: RecordedWorkflow): WorkflowSummary {
  return {
    workflowId: record.workflowId,
    version: record.version,
    formatVersion: record.formatVersion,
    name: record.name,
    description: record.description,
    definitionHash: record.definitionHash,
    risk: record.risk,
    tools: [...record.tools],
    recordedAt: record.recordedAt,
    updatedAt: record.updatedAt,
    taintAtCapture: record.taintAtCapture,
    incomplete: isIncomplete(record),
    droppedSteps: record.droppedSteps.map((dropped) => ({
      afterStepId: dropped.afterStepId,
      tool: dropped.tool,
      reason: dropped.reason,
    })),
    steps: record.definition.steps.map((step) => ({
      id: step.id,
      tool: step.kind === 'tool' ? step.tool : step.skill,
      description: step.description,
      arguments: Object.fromEntries(
        Object.entries(step.arguments).map(([name, binding]) => [
          name,
          {
            kind: binding.kind,
            detail:
              binding.kind === 'literal'
                ? JSON.stringify(binding.value)
                : binding.kind === 'input'
                  ? `asked for at replay (${binding.name})`
                  : binding.kind === 'step'
                    ? `from step ${binding.step}`
                    : `the ${binding.role} named "${binding.name}" (read from the page)`,
          },
        ]),
      ),
    })),
    inputs: record.definition.inputs.map((input) => ({
      name: input.name,
      type: input.type,
      required: input.required,
      description: input.description,
    })),
  };
}

// ---------------------------------------------------------------------------
// Shortcuts (P-021)
// ---------------------------------------------------------------------------

/**
 * Names for things that already exist.
 *
 * A shortcut holds a name and a reference, and nothing else. Resolving one is
 * a read; running what it points at goes through the route that already
 * existed for that kind of target. There is no shortcut execution path, and
 * no `shortcut.*` tool — a model can neither manage a shortcut nor invoke one.
 */
const shortcutStore = new ShortcutStore({
  area: new NamespacedStorageArea(local, 'shortcuts'),
  health: persistenceHealth,
});

const shortcutResolver = new ShortcutResolver({
  store: shortcutStore,
  // Read through the stores that own each kind of target, so a deleted or
  // unusable target is discovered at every resolution rather than trusted
  // from whenever the shortcut was created.
  workflow: async (workflowId) => {
    const record = await workflowStore.get(workflowId);
    if (!record) return undefined;
    return {
      workflowId: record.workflowId,
      name: record.name,
      risk: record.risk,
      stepCount: record.definition.steps.length,
      incomplete: isIncomplete(record),
    };
  },
  skill: (skillId, skillVersion) => {
    // The registry, which takes only definitions that shipped in the build.
    const entry = skillRegistry.get(skillId, skillVersion);
    if (!entry) return undefined;
    return {
      skillId: entry.definition.id,
      skillVersion: entry.definition.version,
      name: entry.definition.name,
      risk: entry.risk,
      stepCount: entry.definition.steps.length,
    };
  },
});

/**
 * The user-initiated way to run a bundled skill.
 *
 * The counterpart of the `skills.run` tool, reaching the same runner from the
 * side panel instead of from a model. It exists because a shortcut may name a
 * bundled skill and a shortcut is a user action.
 */
const skillLauncher = new SkillLauncher({
  registry: skillRegistry,
  runner: skillRunner,
  tasks: taskStore,
  getPermissionMode: async () => (await settingsStore.get()).permissionMode,
  resolveWorkspaceId: ensureActiveWorkspace,
  getActiveTabId: async () => (await browserAdapter.getActiveTab())?.id,
  publishSecurityContext: (taskId, context) => {
    connectorEgressContexts.set(taskId, context);
  },
  onTaskChanged: (task) => {
    broadcastEvent({ type: 'task.updated', task });
  },
});

/** A shortcut as the panel sees it, with its target looked up now. */
async function summariseShortcut(record: ShortcutRecord): Promise<ShortcutSummary> {
  const verdict = await shortcutResolver.resolveRecord(record);
  return {
    shortcutId: record.shortcutId,
    displayName: record.displayName,
    name: record.name,
    targetKind: record.target.kind,
    targetId: record.target.kind === 'workflow' ? record.target.workflowId : record.target.skillId,
    ...(record.target.kind === 'skill' ? { targetVersion: record.target.skillVersion } : {}),
    targetName: verdict.ok ? verdict.resolution.targetName : verdict.detail,
    usable: verdict.ok,
    createdAt: record.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Agent runtime and task management
// ---------------------------------------------------------------------------

/**
 * Resolves the provider for a task.
 *
 * Throws rather than substituting a different provider: silent fallback is
 * forbidden (specification section 60).
 */
interface ResolvedProvider {
  adapter: ReturnType<ProviderRegistry['get']>;
  capabilities: typeof UNKNOWN_CAPABILITIES;
  providerId: string;
  connectionId?: string;
  modelId: string;
}

/**
 * Resolves the adapter for one connected account.
 *
 * The credential is read from `credentials:conn:<connectionId>`, so two
 * accounts on the same provider never reach for the same key. The adapter is
 * reconnected on every call because the worker may have restarted, and
 * because the previous call may have connected it as a *different* account —
 * a single adapter instance per provider family is shared, and leaving the
 * last account's credential in it is exactly the cross-account leak this
 * wave exists to prevent.
 */
async function resolveFromAccount(account: ConnectedAccount): Promise<ResolvedProvider> {
  if (!account.modelId) {
    throw new ProviderUnavailable(
      `${account.displayName} has no model selected. Choose one in Settings.`,
    );
  }
  const apiKey = await credentialStore.getConnectionKey(credentialKeyFor(account.connectionId));
  if (apiKey === undefined) {
    throw new ProviderUnavailable(
      account.statusReason ??
        `${account.displayName} needs its API key reconnected on this device.`,
    );
  }

  const adapter = providerRegistry.get(account.providerId);
  const auth = await adapter.connect({
    providerId: account.providerId,
    ...(account.baseUrl === undefined ? {} : { baseUrl: account.baseUrl }),
    apiKey,
    model: account.modelId,
  });
  if (!auth.authenticated) {
    throw new ProviderUnavailable(
      auth.error?.userMessage ?? 'The connected account rejected its stored credentials.',
    );
  }

  return {
    adapter,
    // Only a measurement taken on *this* account and *this* model counts.
    capabilities:
      account.capabilityScope?.connectionId === account.connectionId &&
      account.capabilityScope?.modelId === account.modelId
        ? (account.capabilities ?? UNKNOWN_CAPABILITIES)
        : UNKNOWN_CAPABILITIES,
    providerId: account.providerId,
    connectionId: account.connectionId,
    modelId: account.modelId,
  };
}

async function resolveProvider(): Promise<ResolvedProvider> {
  // The AI brain first: a connected account the user selected, with its own
  // credential. Falling back to the legacy single-provider settings is what
  // keeps an installation that has not migrated — or not chosen a brain —
  // working exactly as it did.
  const brainAccount = await accountStore.getBrainAccount(await currentAbaUserId());
  if (brainAccount) return await resolveFromAccount(brainAccount);

  const settings = await settingsStore.get();
  const connection = await settingsStore.getConnection();

  if (!settings.activeProviderId || !settings.activeModelId || !connection) {
    throw new ProviderUnavailable(
      'No AI provider is connected. Open Settings and connect a provider first.',
    );
  }

  const adapter = providerRegistry.get(settings.activeProviderId);
  const config = await credentialStore.getConfig(settings.activeProviderId);
  const apiKey = await credentialStore.getApiKey(settings.activeProviderId);

  // The worker may have restarted since the provider was connected, so the
  // adapter instance is reconnected from stored configuration each time.
  const auth = await adapter.connect({
    providerId: settings.activeProviderId,
    ...(config?.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(apiKey === undefined ? {} : { apiKey }),
    model: settings.activeModelId,
    ...(config?.organization === undefined ? {} : { organization: config.organization }),
    ...(config?.project === undefined ? {} : { project: config.project }),
  });
  if (!auth.authenticated) {
    throw new ProviderUnavailable(
      auth.error?.userMessage ?? 'The connected provider rejected its stored credentials.',
    );
  }

  return {
    adapter,
    capabilities: connection.capabilities ?? UNKNOWN_CAPABILITIES,
    providerId: settings.activeProviderId,
    modelId: settings.activeModelId,
  };
}

class ProviderUnavailable extends Error {
  readonly agentError = createError('AUTH_REQUIRED', this.message, { userMessage: this.message });
}

// The task manager and the runtime reference each other: the runtime reports
// progress through the manager's callbacks, and the manager drives the
// runtime. The manager is built first and the runtime injected afterwards, so
// neither has to be forward-declared.
const taskManager = new TaskManager({
  store: taskStore,
  health: persistenceHealth,
  resolveProvider,
  getPermissionMode: async () => (await settingsStore.get()).permissionMode,
  // Resolved once, at creation. A task whose workspace could change later
  // would be a task whose scope depends on when you asked.
  resolveWorkspaceId: ensureActiveWorkspace,
  getActiveTabId: async () => (await browserAdapter.getActiveTab())?.id,
  // Keeps the skill runner's view of the remaining allowance current, so a
  // skill stops partway through rather than spending a budget the task has
  // already exhausted.
  onUsageChanged: (taskId, usage) => {
    skillBudgetRemaining.set(taskId, Math.max(0, DEFAULT_BUDGET.maxToolCalls - usage.toolCalls));
  },
  // Task lifecycle into the one trail. These three types were declared from
  // the start and never written, which is why the trail could say what was
  // *decided* but not what was *done*.
  onLifecycle: (event) => {
    // A finished task must not leave the user's file sitting in memory, for
    // exactly the reason a cancelled one must not: the bytes were handed over
    // for one piece of work, and that work is over. Cancellation had this
    // from the start; completing and failing did not, which meant a file
    // outlived its purpose until the worker happened to be evicted.
    //
    // Hooked here rather than at each exit, because "the task reached a
    // terminal state" is one fact and reproducing it at three call sites is
    // how one of them ends up missing.
    if (event.kind === 'completed') {
      fileSelectionBroker.cancelForTask(
        event.taskId,
        'The task finished before a file was chosen.',
      );
      stagedFiles.clearTask(event.taskId);
    }

    void auditLog
      .record({
        type:
          event.kind === 'created'
            ? 'task.created'
            : event.kind === 'completed'
              ? 'task.completed'
              : 'task.state',
        taskId: event.taskId,
        outcome: event.kind === 'completed' ? 'info' : 'info',
        ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
        ...(event.state === undefined ? {} : { taskState: event.state }),
        ...(event.outcome === undefined ? {} : { code: event.outcome }),
        ...(event.providerId === undefined ? {} : { providerId: event.providerId }),
        ...(event.modelId === undefined ? {} : { modelId: event.modelId }),
        ...(event.providerId === undefined ? {} : { providerMode: 'api' }),
        ...(event.permissionMode === undefined ? {} : { permissionMode: event.permissionMode }),
      })
      .catch(() => undefined);
  },
});

taskManager.setRuntime(
  new AgentRuntime({ registry: toolRegistry, callbacks: taskManager.createCallbacks() }),
);

const lifecycle = new LifecycleManager({ store: taskStore, debuggerManager });

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

async function getOrCreateSession(): Promise<AgentSession> {
  const existing = await local.get<AgentSession>(SESSION_KEY);
  if (existing) return existing;

  const settings = await settingsStore.get();
  const session: AgentSession = {
    id: newSessionId(),
    providerId: settings.activeProviderId ?? '',
    modelId: settings.activeModelId ?? '',
    permissionMode: settings.permissionMode,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  await local.set(SESSION_KEY, session);
  await taskStore.saveSession(session);
  return session;
}

async function updateSession(patch: Partial<AgentSession>): Promise<AgentSession> {
  const session = { ...(await getOrCreateSession()), ...patch, lastActiveAt: Date.now() };
  await local.set(SESSION_KEY, session);
  await taskStore.saveSession(session);
  return session;
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

/**
 * The one router, with route trust attached.
 *
 * A refusal is recorded so that a message arriving from somewhere it should
 * not have is visible afterwards rather than only in a log line that an
 * evicted worker takes with it. What is recorded is the route and a closed
 * sender class — never the sender's URL, which is page-derived.
 *
 * The write is fire-and-forget and swallows its own failure: this runs on the
 * refusal path, and a failure to write a record must not turn a denial into
 * anything else. `record()` already returns `null` rather than throwing, and
 * this catch is the second belt.
 */
const router = new MessageRouter({
  onRefused: ({ route, senderClass }) => {
    void auditLog
      .record({ type: 'route.refused', outcome: 'denied', route, senderClass })
      .catch(() => undefined);
  },
});

router.on('task.create', async ({ objective }) => {
  const session = await getOrCreateSession();
  return { task: await taskManager.create(objective, session.id) };
});

router.on('task.get', async ({ taskId }) => ({
  task: (await taskStore.getTask(taskId)) ?? null,
}));

router.on('task.list', async ({ limit }) => ({ tasks: await taskStore.listTasks(limit ?? 25) }));

router.on('task.pause', async ({ taskId }) => ({ state: await taskManager.pause(taskId) }));

router.on('task.resume', async ({ taskId }) => ({ state: await taskManager.resume(taskId) }));

router.on('task.cancel', async ({ taskId }) => {
  permissionBroker.denyForTask(taskId);
  fileSelectionBroker.cancelForTask(taskId, 'The task was cancelled.');
  // A cancelled task must not leave the user's file sitting in memory.
  stagedFiles.clearTask(taskId);
  return { state: await taskManager.cancel(taskId) };
});

router.on('task.retry', async ({ taskId }) => ({ task: await taskManager.retry(taskId) }));

router.on('session.get', async () => ({ session: await getOrCreateSession() }));

router.on('session.setPermissionMode', async ({ mode }) => {
  await settingsStore.update({ permissionMode: mode });
  return { session: await updateSession({ permissionMode: mode }) };
});

router.on('provider.list', () =>
  Promise.resolve({
    providers: providerRegistry.list().map((factory) => ({
      id: factory.id,
      displayName: factory.displayName,
      description: factory.description,
      kind: factory.kind,
      authKind: factory.authKind,
      baseUrlRequired: factory.baseUrl.required,
      ...(factory.baseUrl.defaultUrl === undefined
        ? {}
        : { defaultBaseUrl: factory.baseUrl.defaultUrl }),
      operations: factory.operations,
    })),
  }),
);

router.on('provider.connect', async (request) => {
  if (!providerRegistry.has(request.providerId)) {
    return {
      connection: null,
      error: createError('INVALID_ARGUMENT', `Unknown provider "${request.providerId}".`),
    };
  }

  const { adapter, error } = await providerRegistry.connect(request.providerId, {
    providerId: request.providerId,
    ...(request.baseUrl === undefined ? {} : { baseUrl: request.baseUrl }),
    ...(request.apiKey === undefined ? {} : { apiKey: request.apiKey }),
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.organization === undefined ? {} : { organization: request.organization }),
    ...(request.project === undefined ? {} : { project: request.project }),
  });
  if (error) return { connection: null, error };

  // The key goes to the credential store; the rest is ordinary configuration.
  if (request.apiKey) await credentialStore.setApiKey(request.providerId, request.apiKey);
  await credentialStore.setConfig({
    providerId: request.providerId,
    ...(request.baseUrl === undefined ? {} : { baseUrl: request.baseUrl }),
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.organization === undefined ? {} : { organization: request.organization }),
    ...(request.project === undefined ? {} : { project: request.project }),
  });

  const connection: ProviderConnection = {
    providerId: request.providerId,
    modelId: request.model ?? '',
    authKind: adapter.authKind,
    createdAt: Date.now(),
    status: 'connected',
  };
  await settingsStore.setConnection(connection);
  broadcastEvent({ type: 'provider.statusChanged', connection });
  return { connection };
});

router.on('provider.disconnect', async ({ providerId }) => {
  await providerRegistry.disconnect(providerId);
  await credentialStore.clear(providerId);
  await settingsStore.setConnection(null);
  await settingsStore.update({ activeProviderId: null, activeModelId: null });
  broadcastEvent({ type: 'provider.statusChanged', connection: null });
  return { ok: true as const };
});

router.on('provider.getConnection', async () => ({
  connection: (await settingsStore.getConnection()) ?? null,
}));

router.on('provider.listModels', async ({ providerId }) => {
  const adapter = providerRegistry.get(providerId);
  const models = await adapter.listModels();
  return { models: models.map((model) => ({ id: model.id, displayName: model.displayName })) };
});

router.on('provider.runDoctor', async ({ providerId, modelId, quick }) => {
  const adapter = providerRegistry.get(providerId);
  const report = await capabilityDoctor.run(adapter, modelId, {
    ...(quick === undefined ? {} : { quick }),
  });

  // The report is authoritative: the stored connection records what was
  // actually observed, so the UI cannot claim a capability that failed.
  const existing = await settingsStore.getConnection();
  if (existing?.providerId === providerId) {
    const connection: ProviderConnection = {
      ...existing,
      modelId,
      capabilities: report.capabilities,
      lastValidated: report.generatedAt,
      status:
        report.readiness === 'AGENT_READY'
          ? 'connected'
          : report.readiness === 'FAILED'
            ? 'failed'
            : 'limited',
    };
    await settingsStore.setConnection(connection);
    broadcastEvent({ type: 'provider.statusChanged', connection });
  }
  return { report };
});

router.on('provider.setActive', async ({ providerId, modelId }) => {
  providerRegistry.setActive(providerId);
  await settingsStore.update({ activeProviderId: providerId, activeModelId: modelId });
  await updateSession({ providerId, modelId });

  const existing = (await settingsStore.getConnection()) ?? null;
  const switched = isProviderSwitch(existing, providerId, modelId);

  // A capability measurement belongs to the pair it was measured on. See
  // `provider-switch.ts` for why this is a function rather than a spread.
  const connection = connectionAfterSwitch(existing, providerId, modelId, () => ({
    providerId,
    modelId,
    authKind: providerRegistry.get(providerId).authKind,
    createdAt: Date.now(),
    status: 'connected',
  }));
  await settingsStore.setConnection(connection);
  if (switched) {
    await auditLog.record({
      type: 'provider.selected',
      outcome: 'info',
      providerId,
      modelId,
      code: 'capabilities_invalidated',
    });
  }
  broadcastEvent({ type: 'provider.statusChanged', connection });
  return { connection };
});

/**
 * The user's answer to a file request.
 *
 * Every selection is recorded before the bytes go anywhere: names, types and
 * sizes only, put through the same redaction as every other audit field so a
 * secret pasted into a filename does not survive in the trail.
 */
router.on('connector.list', async () => {
  const connectors = [];
  for (const connector of connectorRegistry.list()) {
    const state = await connector.getAuthState();
    const descriptor = connector.descriptor;
    const status = descriptor.id === githubDescriptorValue.id ? githubSession.current() : undefined;
    connectors.push({
      id: descriptor.id,
      displayName: descriptor.displayName,
      site: descriptor.site,
      authKind: descriptor.authKind,
      state: status?.state ?? (state.authenticated ? 'READY' : 'NEEDS_AUTH'),
      reason: status?.reason ?? 'no_grant',
      scopes: state.scopes,
      ...(state.accountLabel === undefined ? {} : { accountLabel: state.accountLabel }),
      // A deployment without an OAuth application cannot authorise anything,
      // and says so rather than offering a button that cannot work.
      configured: (CONNECTOR_CLIENT_IDS[descriptor.id] ?? '').length > 0,
      operations: descriptor.operations.map((operation) => ({
        id: operation.id,
        kind: operation.kind,
        description: operation.description,
      })),
      scopeRationale: descriptor.scopeRationale,
    });
  }
  return { connectors };
});

router.on('connector.authorize', async ({ connectorId, includeWrite }) => {
  const connector = connectorRegistry.get(connectorId);
  if (!connector) {
    throw new RouteError(createError('INVALID_ARGUMENT', `Unknown connector "${connectorId}".`));
  }
  if ((CONNECTOR_CLIENT_IDS[connectorId] ?? '').length === 0) {
    // No OAuth application is configured for this deployment. Refusing here
    // is the honest outcome: starting a flow that cannot complete would look
    // like a bug rather than like missing configuration.
    throw new RouteError(
      createError(
        'NOT_IMPLEMENTED',
        `No OAuth application is configured for ${connector.descriptor.displayName}.`,
        {
          userMessage:
            `${connector.descriptor.displayName} cannot be connected in this build: it needs an ` +
            'OAuth application registered for this extension.',
        },
      ),
    );
  }

  await auditLog.record({
    type: 'connector.auth',
    connectorId,
    outcome: 'info',
    code: 'authorization_started',
  });

  // Read scopes always; write scopes only when the user asked for them. The
  // agent cannot widen this — it is a choice made in the panel, before any
  // model turn.
  const scopes = scopesFor(connector.descriptor, includeWrite === true ? 'all' : 'read');
  const controller = new AbortController();
  const status = await githubSession.authorize(scopes, controller.signal);
  return { state: status.state, reason: status.reason, scopes: status.scopes };
});

router.on('connector.disconnect', async ({ connectorId }) => {
  const connector = connectorRegistry.get(connectorId);
  if (!connector) {
    throw new RouteError(createError('INVALID_ARGUMENT', `Unknown connector "${connectorId}".`));
  }
  await connector.revoke();
  await auditLog.record({
    type: 'connector.configured',
    connectorId,
    outcome: 'info',
    code: 'disconnected',
  });
  return { state: 'UNCONFIGURED' };
});

router.on('connector.pendingWrites', async ({ taskId }) => {
  const records = await connectorWrites.list(taskId);
  return {
    writes: records
      .filter((record) => record.outcome === 'uncertain')
      .map((record) => ({
        key: record.key,
        connectorId: record.connectorId,
        operation: record.operationId,
        taskId: record.taskId,
        outcome: record.outcome,
        startedAt: record.startedAt,
      })),
  };
});

router.on('connector.resolveWrite', async ({ key }) => {
  // Clearing the record is what lets a replay happen, and only a person can
  // do it — they are the only one who can look and see whether the write
  // already landed.
  await connectorWrites.forget(key);
  await auditLog.record({
    type: 'connector.operation',
    outcome: 'info',
    code: 'uncertain_write_resolved',
  });
  return { cleared: true };
});

router.on('file.respondSelection', async ({ requestId, response }) => {
  const accepted = fileSelectionBroker.respond(requestId, response);

  if (accepted && response.kind === 'selected') {
    for (const file of response.files) {
      await auditLog.record({
        type: 'file.selected',
        outcome: 'allowed',
        origin: 'local',
        fileName: safeDisplayName(file.name),
        mimeType: file.mimeType,
        byteLength: file.byteLength,
      });
    }
  } else if (accepted) {
    await auditLog.record({
      type: 'file.selected',
      outcome: 'denied',
    });
  }

  return { accepted };
});

router.on('file.listPendingSelections', () =>
  Promise.resolve({ requests: fileSelectionBroker.listPending() }),
);

router.on('file.downloadsPermission', async () => ({
  granted: await downloadPort.isPermitted(),
}));

/* ------------------------------------------------------------------ *
 * Connected AI accounts
 *
 * These sit alongside the `provider.*` routes, which are untouched. Those
 * describe provider *families* — which adapters exist and what each needs.
 * These describe the user's own connected accounts, of which there may be
 * several per family, each with its own credential and its own measurement.
 * ------------------------------------------------------------------ */

/**
 * The account store's window onto credentials.
 *
 * Connection-scoped by construction: there is no call here that could be
 * handed a provider id, which is what makes two accounts on one provider
 * incapable of overwriting each other.
 */
const connectionCredentials = {
  read: (connectionId: string) => credentialStore.getConnectionKey(connectionId),
  write: (connectionId: string, apiKey: string) =>
    credentialStore.setConnectionKey(connectionId, apiKey),
  clear: (connectionId: string) => credentialStore.clearConnectionKey(connectionId),
};

/** The panel's view of an account. Never carries a credential. */
function accountView(account: ConnectedAccount, brainId: string | null): ConnectedAccountView {
  return {
    connectionId: account.connectionId,
    providerId: account.providerId,
    protocol: account.protocol,
    displayName: account.displayName,
    accountLabel: account.accountLabel,
    authKind: account.authKind,
    ...(account.baseUrl === undefined ? {} : { baseUrl: account.baseUrl }),
    modelId: account.modelId,
    capabilities: account.capabilities,
    status: account.status,
    ...(account.statusReason === undefined ? {} : { statusReason: account.statusReason }),
    lastValidated: account.lastValidated,
    createdAt: account.createdAt,
    isBrain: account.connectionId === brainId,
  };
}

async function visibleAccounts(): Promise<{
  accounts: readonly ConnectedAccount[];
  brainId: string | null;
  abaUserId: string;
}> {
  const abaUserId = await currentAbaUserId();
  const brain = await accountStore.getBrain(abaUserId);
  const all = await accountStore.list();
  // Another user's accounts are hidden, never deleted, and are still there
  // when that user signs back in.
  const accounts = all.filter(
    (account) => account.abaUserId === abaUserId || account.abaUserId === UNASSIGNED_ABA_USER,
  );
  return { accounts, brainId: brain?.connectionId ?? null, abaUserId };
}

async function broadcastAccounts(): Promise<void> {
  const { accounts, brainId, abaUserId } = await visibleAccounts();
  const brain = await accountStore.getBrain(abaUserId);
  broadcastEvent({
    type: 'accounts.changed',
    accounts: accounts.map((account) => accountView(account, brainId)),
    brain: brain ? { connectionId: brain.connectionId, modelId: brain.modelId } : null,
  });
}

/**
 * Carries a pre-multi-account installation forward, once.
 *
 * Runs at startup and never throws: a user whose migration failed still needs
 * a working side panel to reconnect from, and taking startup down would leave
 * them with neither their old configuration nor a way to rebuild it. A
 * failure is reported and retried on the next start, with the legacy
 * credential still in place.
 */
async function runLegacyMigration(): Promise<void> {
  const outcome = await migrateLegacyConnection({
    store: accountStore,
    credentials: {
      // Keyed by provider: the scheme being migrated away from.
      readLegacy: (providerId) => credentialStore.getApiKey(providerId),
      clearLegacy: (providerId) => credentialStore.clear(providerId),
      // Keyed by connection: the scheme being migrated to.
      readConnection: (connectionId) => credentialStore.getConnectionKey(connectionId),
      writeConnection: (connectionId, apiKey) =>
        credentialStore.setConnectionKey(connectionId, apiKey),
    },
    readLegacyConnection: async () => {
      const connection = await settingsStore.getConnection();
      if (!connection) return undefined;
      return {
        // Passed through rather than filtered here: whether a record is a
        // projection is a fact about the record, and the migration is what
        // owns the rule that a projection is not migrated.
        ...(connection.connectionId === undefined ? {} : { connectionId: connection.connectionId }),
        providerId: connection.providerId,
        modelId: connection.modelId,
        ...(connection.accountLabel === undefined ? {} : { accountLabel: connection.accountLabel }),
        createdAt: connection.createdAt,
        status: connection.status,
      };
    },
    clearLegacyConnection: async () => {
      await settingsStore.setConnection(null);
      await settingsStore.update({ activeProviderId: null, activeModelId: null });
    },
  });
  if (outcome.kind === 'migrated') await broadcastAccounts();
}

void runLegacyMigration();

/* ------------------------------------------------------------------ *
 * Browser workspaces — the user's control surface
 *
 * The panel never touches workspace storage and never drives a browser tool.
 * It asks for state and states intentions; everything else happens here,
 * behind route trust, and every tab the agent later acts on still passes the
 * live membership guard. The UI is not an authorization mechanism.
 * ------------------------------------------------------------------ */

function broadcastWorkspace(): void {
  broadcastEvent({ type: 'workspace.changed' });
}

/** The live tabs of one workspace, straight from Chrome. */
async function liveTabsOf(workspaceId: string): Promise<chrome.tabs.Tab[]> {
  const bound = await workspaceStore.binding(workspaceId);
  if (bound === null) return [];
  if (!(await groupExists(bound.chromeTabGroupId))) {
    // The group went away while we were not looking. Reconcile rather than
    // reporting a binding that names nothing.
    await workspaceStore.unbind(workspaceId);
    return [];
  }
  return await chrome.tabs.query({ groupId: bound.chromeTabGroupId });
}

router.on('workspace.state', async () => {
  const abaUserId = await currentAbaUserId();
  const mine = await workspaceStore.listFor(abaUserId);
  const activeWorkspaceId = await workspaceStore.getActiveId();

  const workspaces = await Promise.all(
    mine.map(async (workspace) => ({
      workspaceId: workspace.workspaceId,
      title: workspace.title,
      state: await workspaceStore.state(workspace.workspaceId),
      // Live count, so a workspace whose tabs were all closed reads as empty
      // rather than as whatever it used to hold.
      liveTabCount: (await liveTabsOf(workspace.workspaceId)).length,
      isActive: workspace.workspaceId === activeWorkspaceId,
    })),
  );

  const live = activeWorkspaceId ? await liveTabsOf(activeWorkspaceId) : [];
  const memberIds = new Set(live.map((tab) => tab.id));
  const current = await browserAdapter.getActiveTab();

  return {
    workspaces,
    activeWorkspaceId,
    tabs: live
      .filter((tab) => tab.id !== undefined)
      .map((tab) => ({
        tabId: tab.id!,
        title: tab.title ?? '',
        url: tab.url ?? '',
        active: tab.active,
      })),
    currentTab:
      current === null
        ? null
        : {
            tabId: current.id,
            title: current.title,
            url: current.url,
            // Stated, never acted on. The panel says the tab is outside and
            // offers to add it; it is not added because the user looked at it.
            inActiveWorkspace: memberIds.has(current.id),
          },
  };
});

router.on('workspace.create', async ({ title }) => {
  const active = await browserAdapter.getActiveTab();
  if (!active) {
    return {
      workspaceId: '',
      attached: false,
      error: createError('INVALID_ARGUMENT', 'There is no tab to start a workspace from.'),
    };
  }

  // "Start working from this tab" is what the action means, so the workspace
  // is created around it rather than created empty and left for the user to
  // populate.
  const workspaceId = workspaceStore.mintWorkspaceId();
  await workspaceStore.put({
    workspaceId,
    abaUserId: await currentAbaUserId(),
    title: title?.trim() || deriveWorkspaceTitle(active.url),
    members: [],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  });
  const attached = await attachWorkspaceToActiveTab(workspaceId);
  await workspaceStore.setActiveId(workspaceId);
  await auditLog.record({ type: 'workspace.membership', outcome: 'info', code: 'created' });
  broadcastWorkspace();
  return { workspaceId, attached };
});

router.on('workspace.switch', async ({ workspaceId }) => {
  const workspace = await workspaceStore.get(workspaceId);
  const abaUserId = await currentAbaUserId();
  // Another user's workspace is not switchable to, and saying so is better
  // than a generic failure: it is a scope that exists and is not theirs.
  if (!workspace || workspace.abaUserId !== abaUserId) {
    return {
      activeWorkspaceId: (await workspaceStore.getActiveId()) ?? '',
      error: createError('INVALID_ARGUMENT', 'That workspace is not available.'),
    };
  }

  // Changes the active workspace and nothing else. The AI brain, the
  // connected account and the identity profile live in different stores that
  // this route has no reference to, so the independence is structural rather
  // than a rule to remember.
  await workspaceStore.setActiveId(workspaceId);
  await auditLog.record({ type: 'workspace.membership', outcome: 'info', code: 'switched' });
  broadcastWorkspace();
  return { activeWorkspaceId: workspaceId };
});

router.on('workspace.addCurrentTab', async () => {
  const activeWorkspaceId = await workspaceStore.getActiveId();
  if (!activeWorkspaceId) {
    return { added: false, error: createError('INVALID_ARGUMENT', 'No workspace is active.') };
  }
  const current = await browserAdapter.getActiveTab();
  if (!current) {
    return { added: false, error: createError('INVALID_ARGUMENT', 'There is no current tab.') };
  }
  const bound = await workspaceStore.binding(activeWorkspaceId);
  if (bound === null || !(await groupExists(bound.chromeTabGroupId))) {
    return {
      added: false,
      error: createError(
        'INVALID_ARGUMENT',
        'This workspace has no live tab group. Re-attach it first.',
      ),
    };
  }

  try {
    await chrome.tabs.group({ tabIds: [current.id], groupId: bound.chromeTabGroupId });
    // Verified against Chrome, not assumed: the membership predicate reads
    // the live group, so a grouping that did not take would leave the user
    // believing a tab is in scope when the guard will refuse it.
    const after = await browserAdapter.getTab(current.id);
    if (after?.groupId !== bound.chromeTabGroupId) {
      return {
        added: false,
        error: createError('INVALID_ARGUMENT', 'That tab could not be added to the workspace.'),
      };
    }
    await workspaceReconciler.handleGroupChanged(current.id, bound.chromeTabGroupId);
    await auditLog.record({ type: 'workspace.membership', outcome: 'info', code: 'tab_added' });
    broadcastWorkspace();
    return { added: true, tabId: current.id };
  } catch {
    return {
      added: false,
      error: createError('INVALID_ARGUMENT', 'That tab could not be added to the workspace.'),
    };
  }
});

router.on('workspace.removeTab', async ({ tabId }) => {
  const activeWorkspaceId = await workspaceStore.getActiveId();
  if (!activeWorkspaceId) {
    return { removed: false, error: createError('INVALID_ARGUMENT', 'No workspace is active.') };
  }
  const bound = await workspaceStore.binding(activeWorkspaceId);
  const tab = await browserAdapter.getTab(tabId);
  // A tab belonging to another workspace — or to none — is refused rather
  // than ungrouped. Otherwise this route would be a way to reach across the
  // boundary and rearrange somebody else's scope.
  if (bound === null || tab === null || tab.groupId !== bound.chromeTabGroupId) {
    return {
      removed: false,
      error: createError('INVALID_ARGUMENT', 'That tab is not part of this workspace.'),
    };
  }

  // Detach, never delete. The tab keeps existing and keeps its page; what it
  // loses is eligibility. The workspace, its tasks and its history are
  // untouched.
  await chrome.tabs.ungroup([tabId]);
  await workspaceReconciler.handleGroupChanged(tabId, TAB_GROUP_ID_NONE);
  await auditLog.record({ type: 'workspace.membership', outcome: 'info', code: 'tab_removed' });
  broadcastWorkspace();
  return { removed: true };
});

router.on('workspace.reattach', async ({ workspaceId }) => {
  const workspace = await workspaceStore.get(workspaceId);
  if (!workspace || workspace.abaUserId !== (await currentAbaUserId())) {
    return {
      attached: false,
      error: createError('INVALID_ARGUMENT', 'That workspace is not available.'),
    };
  }
  const attached = await attachWorkspaceToActiveTab(workspaceId);
  if (attached) {
    await workspaceStore.setActiveId(workspaceId);
    await auditLog.record({ type: 'workspace.membership', outcome: 'info', code: 'reattached' });
    broadcastWorkspace();
  }
  return { attached };
});

/**
 * Authentication, wired only when a backend origin was configured at build
 * time.
 *
 * `null` is the normal state today: the backend is not deployed, so
 * `auth.status` reports `configured: false` and the panel shows sign-in as
 * unavailable rather than offering a button that would reach nowhere.
 */
const identityConfig = loadIdentityConfig();

/**
 * Sign-in, refresh and logout — all three, or none of them.
 *
 * Built together because they share one transport and one precondition: a
 * configured backend origin. Splitting them would let a build end up able to
 * refresh but not sign in, which is a state nothing should be able to reach.
 */
const identityClients =
  identityConfig === null
    ? null
    : (() => {
        // No send port: `guardedSend` performs the fetch, inside the egress
        // module, so no network primitive is created here.
        const transport = new IdentityTransport(identityConfig);
        return {
          // Email sign-in is built whenever the origin is; whether the
          // *deployment* offers it is the backend's answer, not a guess made
          // here. An unconfigured backend answers 404 and the first request
          // surfaces `NOT_CONFIGURED`.
          email: new EmailSignIn({
            transport,
            deviceId: () => dataStoragePreference.deviceId(),
          }),
          google: new GoogleSignIn({
            config: identityConfig,
            transport,
            authFlow: new TabAuthFlow(chromeTabs()),
            // The installation's own random id, minted once and kept locally.
            // Never derived from the Google subject, the email, or any Chrome
            // runtime handle.
            deviceId: () => dataStoragePreference.deviceId(),
          }),
          session: new SessionClient({ transport, sessions: sessionStore }),
        };
      })();

const authController = new AuthController({
  sessions: sessionStore,
  profile: identityProfile,
  google: identityClients?.google ?? null,
  email: identityClients?.email ?? null,
  session: identityClients?.session ?? null,
});

router.on('auth.status', async () => authController.status());

router.on('auth.signInWithGoogle', async () => {
  // Bounded by the flow's own timeout; the controller aborts the tab watch
  // when it elapses rather than leaving a tab open for ever.
  const controller = new AbortController();
  return authController.signInWithGoogle(controller.signal);
});

/**
 * Asks the backend to mail a code.
 *
 * The address is the only thing the panel sends, and the challenge id is the
 * only durable-looking thing that comes back — which is not durable at all:
 * it is held in the panel's own state and lost when the panel closes, exactly
 * as an in-flight sign-in should be.
 */
router.on('auth.startEmailSignIn', async (request) =>
  authController.startEmailSignIn(request.email),
);

/**
 * Presents a code.
 *
 * The code passes through this handler into the transport and is not written
 * anywhere: not to `chrome.storage.local`, not to `chrome.storage.session`,
 * not to the audit trail, and not to a log line.
 */
router.on('auth.verifyEmailSignIn', async (request) =>
  authController.verifyEmailSignIn(request.challengeId, request.code),
);

router.on('auth.refresh', async () => {
  const result = await authController.refresh();
  // The failure code only; nothing about the token, the session or the
  // account reaches the panel.
  return { ok: result.ok, failure: result.ok ? null : result.failure };
});

router.on('auth.signOut', async () => authController.signOut());

/**
 * Re-derives the panel's connection record from the brain.
 *
 * Called after every write that can change which account is in use. The panel
 * reads `settings.provider-connection` for the header status and the
 * composer's readiness gate, and before this the account routes never wrote
 * it — so connecting an account through Settings left the panel insisting
 * nothing was connected while `resolveProvider` had an account it would
 * happily have used.
 *
 * This is a projection, not a second decision: `resolveProvider` still reads
 * the account store, and nothing here can make a task run against something
 * the account store does not name. `activeProviderId` and `activeModelId` are
 * kept in step for the same reason — they are what the export carries and
 * what startup marks active, and a stale pair there describes an account the
 * user may have moved on from.
 */
async function projectBrainToSettings(): Promise<ProviderConnection | null> {
  const account = await accountStore.getBrainAccount(await currentAbaUserId());
  const connection = connectionForBrain(account);
  await settingsStore.setConnection(connection);
  await settingsStore.update({
    activeProviderId: connection?.providerId ?? null,
    activeModelId: connection?.modelId || null,
  });
  broadcastEvent({ type: 'provider.statusChanged', connection });
  return connection;
}

router.on('accounts.list', async () => {
  const { accounts, brainId, abaUserId } = await visibleAccounts();
  const brain = await accountStore.getBrain(abaUserId);
  return {
    accounts: accounts.map((account) => accountView(account, brainId)),
    brain: brain ? { connectionId: brain.connectionId, modelId: brain.modelId } : null,
  };
});

router.on('accounts.connect', async (request) => {
  if (!providerRegistry.has(request.providerId)) {
    return {
      account: null,
      error: createError('INVALID_ARGUMENT', `Unknown provider "${request.providerId}".`),
    };
  }
  if (!request.apiKey) {
    return { account: null, error: createError('INVALID_ARGUMENT', 'An API key is required.') };
  }

  // Proved before anything is stored, so a rejected key never becomes an
  // account the user has to discover is broken.
  const adapter = providerRegistry.get(request.providerId);
  const auth = await adapter.connect({
    providerId: request.providerId,
    ...(request.baseUrl === undefined ? {} : { baseUrl: request.baseUrl }),
    apiKey: request.apiKey,
    ...(request.model === undefined ? {} : { model: request.model }),
  });
  if (!auth.authenticated) {
    return {
      account: null,
      error: auth.error ?? createError('AUTH_REQUIRED', 'The provider rejected that API key.'),
    };
  }

  const connectionId = accountStore.mintConnectionId();
  // The credential first, then the record: a record whose key never landed
  // is an account that fails at its first request, and the user cannot tell
  // why. A key with no record is invisible but harmless, and the next
  // connect overwrites it.
  await credentialStore.setConnectionKey(credentialKeyFor(connectionId), request.apiKey);

  const account: ConnectedAccount = {
    connectionId,
    abaUserId: await currentAbaUserId(),
    providerId: request.providerId,
    protocol: protocolForLegacyProvider(request.providerId),
    displayName: request.displayName?.trim() || adapter.displayName,
    accountLabel: deriveAccountLabel(request.baseUrl, request.apiKey),
    authKind: 'api_key',
    ...(request.baseUrl === undefined ? {} : { baseUrl: request.baseUrl }),
    modelId: request.model ?? null,
    capabilities: null,
    capabilityScope: null,
    status: 'connected',
    lastValidated: null,
    createdAt: Date.now(),
  };
  await accountStore.put(account);
  await auditLog.record({
    type: 'provider.selected',
    outcome: 'info',
    providerId: request.providerId,
    code: 'account_connected',
  });

  // The first account becomes the one in use.
  //
  // Without this, connecting an account through Settings left the brain
  // unset, `resolveProvider` fell through to the pre-account settings slot,
  // and the very next task failed with "Enter the endpoint base URL" — the
  // account was connected, its key was stored, and nothing would use it. The
  // one-time migration already made the account it carried forward the brain
  // for exactly this reason; this restores that rule for the path that
  // replaced it.
  //
  // Only when there is no brain. Connecting a second account must never
  // silently move the user off the one they chose.
  const abaUserId = await currentAbaUserId();
  if ((await accountStore.getBrain(abaUserId)) === null) {
    await accountStore.setBrain(abaUserId, connectionId, account.modelId);
    await updateSession({
      providerId: account.providerId,
      ...(account.modelId === null ? {} : { modelId: account.modelId }),
    });
  }
  await projectBrainToSettings();

  await broadcastAccounts();
  const { brainId } = await visibleAccounts();
  return { account: accountView(account, brainId) };
});

router.on('accounts.disconnect', async ({ connectionId }) => {
  // The credential goes first, then the record, then any brain pointing at
  // it. `AccountStore.remove` owns that ordering.
  await accountStore.remove(connectionId, connectionCredentials);
  // `remove` clears a brain that pointed at it, so the projection has to be
  // re-derived: leaving the old one would show a connection to an account
  // whose credential has just been deleted.
  await projectBrainToSettings();
  await broadcastAccounts();
  return { ok: true as const };
});

router.on('accounts.listModels', async ({ connectionId }) => {
  const account = await accountStore.get(connectionId);
  if (!account) throw new Error('That connection no longer exists.');
  const resolved = await resolveFromAccount({ ...account, modelId: account.modelId ?? 'probe' });
  const models = await resolved.adapter.listModels();
  return { models: models.map((model) => ({ id: model.id, displayName: model.displayName })) };
});

router.on('accounts.runDoctor', async ({ connectionId, modelId, quick }) => {
  const account = await accountStore.get(connectionId);
  if (!account) throw new Error('That connection no longer exists.');

  const resolved = await resolveFromAccount({ ...account, modelId });
  const report = await capabilityDoctor.run(resolved.adapter, modelId, {
    ...(quick === undefined ? {} : { quick }),
  });

  // The measurement is stamped with the account and model it was taken on, so
  // nothing downstream can mistake it for evidence about another.
  await accountStore.put({
    ...account,
    modelId,
    capabilities: report.capabilities,
    capabilityScope: { connectionId, modelId },
    lastValidated: report.generatedAt,
    status:
      report.readiness === 'AGENT_READY'
        ? 'connected'
        : report.readiness === 'FAILED'
          ? 'failed'
          : 'limited',
  });
  // The measurement the panel gates the composer on. Projected here rather
  // than left for the next brain change, because a capability check that
  // passes should light the composer up now.
  await projectBrainToSettings();
  await broadcastAccounts();
  return { report };
});

router.on('accounts.setBrain', async ({ connectionId, modelId }) => {
  const abaUserId = await currentAbaUserId();
  const existing = await accountStore.get(connectionId);
  if (!existing) {
    throw new Error('That connection no longer exists.');
  }

  // A measurement survives only when both the account and the model are the
  // ones it was taken on — the same rule `connectionAfterSwitch` established
  // for the single-slot world, extended to the account dimension.
  const updated = accountAfterSelection(existing, modelId);
  const switched = updated.capabilities === null && existing.capabilities !== null;
  await accountStore.put(updated);
  await accountStore.setBrain(abaUserId, connectionId, modelId);

  if (switched) {
    await auditLog.record({
      type: 'provider.selected',
      outcome: 'info',
      providerId: updated.providerId,
      modelId,
      code: 'capabilities_invalidated',
    });
  }
  await updateSession({ providerId: updated.providerId, modelId });
  await projectBrainToSettings();
  await broadcastAccounts();
  return { account: accountView(updated, connectionId) };
});

router.on('accounts.associationOffer', async () => {
  const offer = await accountStore.associationOffer(await currentAbaUserId());
  return {
    accounts: offer.accounts.map((account) => accountView(account, null)),
    declined: offer.declined,
  };
});

router.on('accounts.associate', async () => {
  // Reached only from a confirmed click in the panel. Signing in does not
  // call this, and nothing calls it on startup: taking ownership of
  // connections somebody else set up on a shared profile has to be a
  // decision, because `bindAccountToUser` permits no second move.
  const outcome = await accountStore.associateUnassigned(await currentAbaUserId());
  await projectBrainToSettings();
  await broadcastAccounts();
  return { associated: outcome.associated, refused: outcome.refused };
});

router.on('accounts.declineAssociation', async () => {
  await accountStore.declineAssociation(await currentAbaUserId());
  return { ok: true as const };
});

/* ------------------------------------------------------------------ *
 * Local encryption (K1)
 *
 * What it protects: the provider API keys and connector credentials stored in
 * this profile, against somebody who can read the profile directory — a
 * stolen laptop, a synced backup, a shared machine.
 *
 * What it does not protect against, said here because the alternative is a
 * false claim: anything running inside the extension while it is unlocked,
 * and anything with the passphrase. There is no recovery. Nobody operates a
 * service that could reset it, and adding one would put the thing the
 * passphrase protects into somebody else's hands.
 * ------------------------------------------------------------------ */

router.on('k1.status', async () => await k1.status());

router.on('k1.enable', async ({ passphrase }) => {
  try {
    const status = await k1.initialize(passphrase);
    // Existing keys are encrypted in place, and each is proved readable in
    // its new form before it counts. A failure here leaves that record as
    // plaintext rather than as something nobody can read.
    const outcome = await protectBoth();
    if (outcome.failed > 0 || outcome.unreadable > 0) {
      await persistenceHealth.report(
        'storage',
        'DEGRADED',
        'some stored keys could not be encrypted',
      );
    }
    return { ok: true as const, state: status.state, encrypted: outcome.encrypted };
  } catch (error) {
    return {
      ok: false as const,
      reason: 'ENABLE_FAILED',
      detail: describeK1(error, 'Protection could not be switched on.'),
    };
  }
});

router.on('k1.unlock', async ({ passphrase }) => {
  try {
    const status = await k1.unlock(passphrase);
    return { ok: true as const, state: status.state };
  } catch (error) {
    return {
      ok: false as const,
      reason: error instanceof UnlockError ? error.failure : 'UNLOCK_FAILED',
      detail: describeK1(error, 'That passphrase did not unlock this installation.'),
    };
  }
});

router.on('k1.lock', async () => {
  await k1.lock();
  await dropConnectedAdapters();
  return await k1.status();
});

/**
 * Drops the provider adapters' in-memory configuration.
 *
 * An adapter keeps the config it was connected with — including the API key —
 * for the lifetime of the registry instance, because it needs it for every
 * request. That is correct while unlocked and wrong the moment the user locks:
 * they have said "stop being able to use my keys", and a plaintext copy of one
 * sitting in an adapter is the opposite of that.
 *
 * It was never an authorization hole. Every execution path re-resolves the
 * provider and re-reads the credential, so a locked installation already
 * refused to run — this is about the copy, not the capability.
 *
 * **This is not zeroization.** JavaScript cannot scrub a string, and nothing
 * here claims to. What it does is drop the last reference the extension holds,
 * so the value becomes collectable instead of being pinned for as long as the
 * worker lives. That is a real reduction in exposure and a smaller one than
 * "the key is gone".
 */
async function dropConnectedAdapters(): Promise<void> {
  for (const factory of providerRegistry.list()) {
    // Never throws outward: failing to drop a reference must not turn locking
    // — a safety action — into an error the user has to work around.
    await providerRegistry.disconnect(factory.id).catch(() => undefined);
  }
}

router.on('k1.changePassphrase', async ({ current, next }) => {
  try {
    // Re-wraps the same data key, so nothing stored is re-encrypted and an
    // interrupted change cannot leave records under a key nobody holds:
    // either the old wrapping is still there or the new one is, and both
    // open the same key.
    await k1.changePassphrase(current, next);
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      reason: error instanceof UnlockError ? error.failure : 'CHANGE_FAILED',
      detail: describeK1(error, 'The passphrase could not be changed.'),
    };
  }
});

router.on('k1.disable', async ({ passphrase }) => {
  try {
    // Unlocked first, so switching off cannot be done by somebody who has the
    // machine but not the passphrase — which would make the protection
    // removable by exactly the person it exists to stop.
    await k1.unlock(passphrase);
    const restored = await unprotectBoth();
    if (!restored.ok) {
      return {
        ok: false as const,
        reason: 'UNREADABLE_RECORDS',
        detail:
          `${restored.unreadable} stored key(s) could not be read, so nothing was changed. ` +
          'Remove those connections and try again.',
      };
    }
    await k1.disable();
    await dropConnectedAdapters();
    return { ok: true as const, state: 'OFF' as const };
  } catch (error) {
    return {
      ok: false as const,
      reason: error instanceof UnlockError ? error.failure : 'DISABLE_FAILED',
      detail: describeK1(error, 'Protection could not be switched off.'),
    };
  }
});

/**
 * Both protected namespaces, converted together.
 *
 * Separate areas rather than one, because they are separate stores with
 * separate lifetimes — but a single decision, because "protection is on" has
 * to mean the same thing for every record it covers. Half-converted is a state
 * neither the user nor the code should have to reason about.
 */
async function protectBoth(): Promise<{
  encrypted: number;
  failed: number;
  unreadable: number;
}> {
  const totals = { encrypted: 0, failed: 0, unreadable: 0 };
  for (const [plain, guarded] of [
    [credentialPlainArea, credentialProtectedArea],
    [identitySessionPlainArea, identitySessionProtectedArea],
  ] as const) {
    const outcome = await protectExistingRecords(plain, guarded);
    totals.encrypted += outcome.encrypted;
    totals.failed += outcome.failed;
    totals.unreadable += outcome.unreadable;
  }
  return totals;
}

async function unprotectBoth(): Promise<
  { ok: true; decrypted: number } | { ok: false; unreadable: number }
> {
  let decrypted = 0;
  for (const [plain, guarded] of [
    [credentialPlainArea, credentialProtectedArea],
    [identitySessionPlainArea, identitySessionProtectedArea],
  ] as const) {
    const outcome = await unprotectExistingRecords(plain, guarded);
    // Refused as a whole: half a store decrypted, with the key about to be
    // deleted, is worse than either end state.
    if (!outcome.ok) return outcome;
    decrypted += outcome.decrypted;
  }
  return { ok: true, decrypted };
}

/** A message a person can act on, and never the passphrase they typed. */
function describeK1(error: unknown, fallback: string): string {
  if (error instanceof UnlockError) {
    switch (error.failure) {
      case 'WRONG_PASSPHRASE':
        return 'That passphrase is not the one this installation was protected with.';
      case 'METADATA_CORRUPT':
        return 'The protection key on this device is damaged and cannot be used.';
      case 'UNSUPPORTED_VERSION':
        return 'This data was protected by a newer version of AI Browser Agent.';
    }
  }
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

router.on('storage.getPreference', async () => {
  const preference = await dataStoragePreference.get();
  return { mode: preference.mode, hasChosen: preference.chosenAt !== null };
});

// Both modes are an explicit choice. Choosing local is not a no-op — it turns
// the default into a decision — and choosing cloud uploads nothing by itself:
// it records consent, and a sync path that does not yet exist would be what
// acts on it.
router.on('storage.setPreference', async ({ mode }) => {
  await dataStoragePreference.choose(mode, Date.now());
  return { mode: await dataStoragePreference.mode() };
});

/**
 * Builds the export document the panel writes to a file the user chose.
 *
 * Reads only stores whose data classification permits it. No credential is
 * read here — not the provider key, not a connector token, not the ABA
 * refresh token — because none of them is reachable from these four calls.
 */
router.on('data.export', async () => ({
  export: await buildLocalExport(
    {
      listWorkflows: () => workflowStore.list(),
      listShortcuts: () => shortcutStore.list(),
      listConnections: async () => {
        const { accounts } = await visibleAccounts();
        // Metadata only. `accountLabel` carries a key suffix and is left out
        // along with the key itself; what survives is what you connected to.
        return accounts.map((account) => ({
          connectionId: account.connectionId,
          providerId: account.providerId,
          displayName: account.displayName,
          modelId: account.modelId,
          baseUrl: account.baseUrl ?? null,
        }));
      },
      // The whole settings record is handed over; `buildLocalExport` keeps
      // only the portable keys. Narrowing there rather than here means one
      // allowlist governs both the file this writes and the file it reads.
      readSettings: async () => ({ ...(await settingsStore.get()) }),
    },
    Date.now(),
  ),
}));

/**
 * Applies a file the user chose. Untrusted input, validated in full.
 *
 * Every record is applied **through the store that owns it**, so an import
 * cannot install a workflow the recorder would have refused, cannot carry a
 * hash it did not earn, and cannot take a shortcut name that collides with
 * one already present. Nothing is written directly to storage from here.
 */
router.on('data.import', async ({ document }) => {
  const parsed = parseLocalExport(document);
  if (!parsed.ok) {
    return { ok: false as const, refusal: parsed.refusal, detail: parsed.detail };
  }

  const outcome = await applyLocalExport(parsed.document, {
    importWorkflow: async (record) => {
      const candidate = record as Partial<RecordedWorkflow>;
      if (candidate.definition === undefined) return 'REFUSED';
      try {
        // `save` re-validates the definition, recomputes the canonical hash
        // and re-derives the risk. A hash or a risk level in the file is
        // ignored.
        await workflowStore.save({
          name: typeof candidate.name === 'string' ? candidate.name : 'Imported workflow',
          description: typeof candidate.description === 'string' ? candidate.description : '',
          definition: candidate.definition,
          recordedFromTaskId: 'imported',
          // An imported recording has no measured taint on this device.
          // UNKNOWN is the truthful answer and is the one the replay path
          // already handles conservatively; claiming KNOWN_UNTAINTED would be
          // asserting something no measurement here supports.
          taintAtCapture: 'UNKNOWN',
        });
        return 'IMPORTED';
      } catch (error) {
        // The store's own refusal type is the only reliable way to tell "this
        // record is unacceptable" from "this device could not write it", and
        // this is the one place that knows it. Anything else is a failure.
        return error instanceof WorkflowValidationError ? 'REFUSED' : 'FAILED';
      }
    },
    importShortcut: async (record) => {
      const candidate = record as Partial<ShortcutRecord>;
      if (typeof candidate.displayName !== 'string' || candidate.target === undefined) {
        return 'REFUSED';
      }
      try {
        // `create` re-runs name normalisation and both collision checks, so an
        // imported shortcut cannot take a name that already means something.
        await shortcutStore.create(candidate.displayName, candidate.target);
        return 'IMPORTED';
      } catch (error) {
        return error instanceof ShortcutError ? 'REFUSED' : 'FAILED';
      }
    },
  });

  // A write that did not complete is this device's problem, not the file's,
  // so it reaches persistence health rather than being reported as a count of
  // rejected records. `storage` gates execution: if the disk failed partway
  // through an import, work stops until somebody has looked at it.
  if (outcome.failed > 0) {
    await persistenceHealth.report('storage', 'DEGRADED', 'import writes did not complete');
  }

  return { ok: true as const, outcome };
});

router.on('permission.respond', ({ requestId, response }) => {
  permissionBroker.respond(requestId, response);
  return Promise.resolve({ ok: true as const });
});

router.on('permission.listPending', () =>
  Promise.resolve({ requests: permissionBroker.listPending() }),
);

/**
 * Persistence health (D-3).
 *
 * A read and an acknowledgement. The acknowledgement is the only way down the
 * ladder and is deliberately a person's action: a later successful write does
 * not mean the earlier loss did not happen, so nothing in the failure paths
 * may clear it.
 */
router.on('health.get', async () => ({ snapshot: await persistenceHealth.snapshot() }));

router.on('health.acknowledge', async ({ domain }) => {
  const snapshot = await persistenceHealth.acknowledge(domain);
  await auditLog.record({
    type: 'persistence.health',
    outcome: 'confirmed',
    code: `acknowledged:${domain}`,
  });
  return { snapshot };
});

router.on('policy.getSitePolicy', async () => ({ state: await loadSitePolicy() }));

router.on('policy.removeSiteRule', async ({ site }) => {
  const next = removeRule(await loadSitePolicy(), site);
  await saveSitePolicy(next);
  return { state: next };
});

router.on(
  'audit.list',
  async ({ limit, taskId, site, offset }) =>
    await auditLog.page({
      ...(taskId === undefined ? {} : { taskId }),
      ...(site === undefined ? {} : { site }),
      ...(offset === undefined ? {} : { offset }),
      ...(limit === undefined ? {} : { limit }),
    }),
);

router.on('audit.integrity', async () => {
  const report = await auditLog.verifyIntegrity();
  return {
    verdict: report.verdict,
    checked: report.checked,
    ...(report.atSeq === undefined ? {} : { atSeq: report.atSeq }),
    note: report.note,
  };
});

/**
 * Builds the export and hands it back over extension messaging.
 *
 * This stays inside the extension: the side panel is an extension page, so
 * nothing crosses the boundary and there is no egress to authorise. Writing
 * the same document to a file or a server would cross it, and would have to
 * go through the gate like anything else.
 */
/**
 * Builds the export and hands it back over extension messaging.
 *
 * It produces a value; it writes no file and reaches no network. Turning that
 * value into a file is the panel's job, with a blob of this extension's own
 * origin — so there is no URL here for anything to supply and no carrier that
 * could reach a destination.
 *
 * The scope is required and is never inferred. A file holding every task's
 * records is a different thing to be handed than one task's, and this worker
 * has no way to know which the caller is looking at — so an omitted scope is
 * refused rather than guessed at in either direction.
 */
router.on('audit.export', async ({ scope, limit }) => {
  // Validated before anything is read. A refused scope must not produce a
  // document at all: building one and then discarding it would run the
  // export sanitiser over records that were never authorised to leave.
  const verdict = parseAuditExportScope(scope);
  if (!verdict.ok) {
    throw new RouteError(
      createError('INVALID_ARGUMENT', `The export scope was refused: ${verdict.problem}.`, {
        userMessage: describeScopeProblem(verdict.problem),
        retryable: false,
      }),
    );
  }
  const chosen = verdict.scope;
  const page = await auditLog.page({
    ...(chosen.kind === 'task' ? { taskId: chosen.taskId } : {}),
    limit: Math.min(limit ?? 2000, 5000),
  });
  return {
    export: buildAuditExport(page.events, Date.now(), chosen, await auditLog.verifyIntegrity()),
  };
});

router.on('evidence.listForTask', async ({ taskId }) => ({
  evidence: await evidenceStore.listForTask(taskId),
}));

router.on('evidence.getPayload', async ({ evidenceId }) => {
  const payload = await evidenceStore.getPayload(evidenceId);
  return payload
    ? { content: payload.content, mimeType: payload.mimeType, encoding: payload.encoding }
    : { content: null, mimeType: 'text/plain', encoding: 'utf8' as const };
});

router.on('debug.getLogs', () => Promise.resolve({ logs: [...recentLogs()] }));

router.on('debug.setLogLevel', async ({ level }) => {
  setGlobalLogLevel(level);
  await settingsStore.update({ logLevel: level, debugMode: level === 'debug' });
  return { ok: true as const };
});

router.on('skill.list', () =>
  Promise.resolve({
    skills: skillRegistry.list().map((entry) => ({
      id: entry.definition.id,
      version: entry.definition.version,
      name: entry.definition.name,
      description: entry.definition.description,
      risk: entry.risk,
      hash: entry.hash,
      steps: entry.definition.steps.length,
      tools: [...entry.tools],
      connectors: [...entry.definition.requiredConnectors],
      inputs: entry.definition.inputs.map((input) => ({
        name: input.name,
        type: input.type,
        required: input.required,
        description: input.description,
      })),
    })),
  }),
);

router.on('skill.runs', async ({ taskId }) => ({
  runs: (await skillRuns.list(taskId)).map((run) => ({
    runId: run.runId,
    taskId: run.taskId,
    skillId: run.skillId,
    skillVersion: run.skillVersion,
    stepIndex: run.stepIndex,
    totalSteps: run.totalSteps,
    state: run.state,
    startedAt: run.startedAt,
  })),
}));

/**
 * The recorded-workflow routes (P-022).
 *
 * Read, record, review, replay and delete. There is no route that registers a
 * recording as a skill, and there is none that accepts a definition: a
 * workflow can only come from the recorder observing calls that actually
 * happened, which is what keeps a model from describing one into existence.
 *
 * Only `workflow.replay` executes anything, and it is reachable only from the
 * side panel — a person, through the UI, choosing to run a workflow they have
 * looked at.
 */
router.on('workflow.recordStart', ({ taskId }) => {
  const summary = workflowRecorder.start(taskId);
  return Promise.resolve({ recording: true, taskId: summary.taskId });
});

router.on('workflow.recordStop', async ({ name, description }) => {
  const captured = workflowRecorder.stop();
  if (!captured) return { workflow: null, skipped: [] };

  // Storing, not running. Nothing between here and the replay route executes
  // a single step of what was captured.
  const record = await workflowStore.save({
    name: name.trim().slice(0, 120) || 'Recorded workflow',
    description: description.trim().slice(0, 500),
    definition: captured.definition,
    recordedFromTaskId: captured.summary.taskId,
    taintAtCapture: captured.taint,
    // Persisted with the record, not merely reported here: a reader opening
    // this workflow tomorrow has to be able to see what is missing from it.
    droppedSteps: captured.summary.skipped,
  });
  await auditLog.record({
    type: 'workflow.recorded',
    taskId: captured.summary.taskId,
    workflowId: record.workflowId,
    skillVersion: String(record.version),
    skillHash: record.definitionHash,
    risk: record.risk,
    outcome: 'info',
  });
  return { workflow: summariseWorkflow(record), skipped: [...captured.summary.skipped] };
});

router.on('workflow.recordCancel', () => {
  workflowRecorder.cancel();
  return Promise.resolve({ ok: true } as const);
});

router.on('workflow.recordStatus', () => {
  const summary = workflowRecorder.summary();
  return Promise.resolve({
    recording: workflowRecorder.isRecording(),
    taskId: summary.taskId,
    stepCount: summary.stepCount,
    skipped: [...summary.skipped],
  });
});

router.on('workflow.list', async () => ({
  workflows: (await workflowStore.list()).map(summariseWorkflow),
}));

router.on('workflow.get', async ({ workflowId }) => {
  const record = await workflowStore.get(workflowId);
  return { workflow: record ? summariseWorkflow(record) : null };
});

router.on('workflow.remove', async ({ workflowId }) => {
  await workflowStore.remove(workflowId);
  return { ok: true } as const;
});

router.on('workflow.revalidate', async ({ workflowId }) => {
  const verdict = await workflowReplayer.revalidate(workflowId);
  return verdict.ok
    ? {
        ok: true,
        risk: verdict.skill.risk,
        tools: [...verdict.skill.tools],
        riskChanged: verdict.riskChanged,
      }
    : { ok: false, reason: verdict.reason, detail: verdict.detail };
});

router.on('workflow.replay', async ({ workflowId, inputs }) => {
  const session = await getOrCreateSession();
  const outcome = await workflowReplayer.replay({
    workflowId,
    sessionId: session.id,
    inputs: inputs ?? {},
  });
  if (!outcome.ok) return { ok: false, reason: outcome.reason, detail: outcome.detail };
  return {
    ok: outcome.result.status === 'completed',
    taskId: outcome.taskId,
    status: outcome.result.status,
    summary: outcome.result.summary,
    steps: outcome.result.steps.map((step) => ({
      step: step.stepId,
      ran: step.ran,
      status: step.status,
    })),
  };
});

router.on('workflow.cancelReplay', ({ taskId }) =>
  Promise.resolve({ cancelled: workflowReplayer.cancel(taskId) }),
);

/**
 * The shortcut routes (P-021).
 *
 * Create, read, retarget and delete a **name**. Nothing here runs anything:
 * there is no `shortcut.run`, and `shortcut.resolve` is a read that a panel
 * can safely call on every keystroke.
 *
 * Invoking a shortcut is two steps the panel takes explicitly — resolve, show
 * the user what it means, and then call `workflow.replay` or `skill.run`. That
 * is what keeps a shortcut an alias rather than an execution path.
 */
router.on('shortcut.list', async () => ({
  shortcuts: await Promise.all((await shortcutStore.list()).map(summariseShortcut)),
}));

router.on('shortcut.create', async ({ name, target }) => {
  // Checked at creation so a user is not allowed to name something that is
  // already broken. It is checked again at every resolution, because a target
  // that exists now can be deleted later.
  if (!(await shortcutResolver.targetIsUsable(target))) {
    return {
      shortcut: null,
      error: { reason: 'INVALID_TARGET', detail: 'That workflow is not available to run.' },
    };
  }
  try {
    return { shortcut: await summariseShortcut(await shortcutStore.create(name, target)) };
  } catch (error) {
    // A collision comes back as data rather than an exception, because the
    // panel has to tell the user which existing name they clashed with.
    if (error instanceof ShortcutError) {
      return { shortcut: null, error: { reason: error.reason, detail: error.message } };
    }
    throw error;
  }
});

router.on('shortcut.retarget', async ({ shortcutId, target }) => {
  if (!(await shortcutResolver.targetIsUsable(target))) {
    return {
      shortcut: null,
      error: { reason: 'INVALID_TARGET', detail: 'That workflow is not available to run.' },
    };
  }
  try {
    return { shortcut: await summariseShortcut(await shortcutStore.retarget(shortcutId, target)) };
  } catch (error) {
    if (error instanceof ShortcutError) {
      return { shortcut: null, error: { reason: error.reason, detail: error.message } };
    }
    throw error;
  }
});

router.on('shortcut.remove', async ({ shortcutId }) => {
  await shortcutStore.remove(shortcutId);
  return { ok: true } as const;
});

router.on('shortcut.resolve', async ({ typed }) => {
  const verdict = await shortcutResolver.resolveTyped(typed);
  if (verdict.ok) {
    // The shortcut's own id and the kind of target it found. Never the name
    // the user typed, which is free text they chose.
    await auditLog.record({
      type: 'shortcut.resolved',
      outcome: 'info',
      shortcutId: verdict.record.shortcutId,
      code: verdict.resolution.targetKind,
      risk: verdict.resolution.risk,
    });
  }
  return verdict.ok
    ? { ok: true, resolution: verdict.resolution }
    : { ok: false, reason: verdict.reason, detail: verdict.detail };
});

/**
 * Runs a bundled skill because a person asked.
 *
 * Takes an id and a pinned version, never a definition. Every step still
 * dispatches through the one `ToolRegistry.dispatch`, so this is the same
 * destination the `skills.run` tool reaches — approached from the side panel
 * rather than from a model.
 */
router.on('skill.run', async ({ skillId, skillVersion, inputs }) => {
  const session = await getOrCreateSession();
  const outcome = await skillLauncher.launch({
    skillId,
    skillVersion,
    sessionId: session.id,
    inputs: inputs ?? {},
  });
  if (!outcome.ok) return { ok: false, reason: outcome.reason, detail: outcome.detail };
  return {
    ok: outcome.result.status === 'completed',
    taskId: outcome.taskId,
    status: outcome.result.status,
    summary: outcome.result.summary,
    steps: outcome.result.steps.map((step) => ({
      step: step.stepId,
      ran: step.ran,
      status: step.status,
    })),
  };
});

router.on('tools.list', () =>
  Promise.resolve({
    tools: toolRegistry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
    })),
  }),
);

router.attach();

// ---------------------------------------------------------------------------
// Chrome event wiring
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error: unknown) => {
      log.warn('Could not configure side panel behaviour.', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
});

/**
 * Keeping the workspace mirror in step with Chrome.
 *
 * Observation only: the mirror feeds the panel and the audit trail, and the
 * guard above reads Chrome live regardless — so a missed event can at worst
 * show something stale and can never authorise anything.
 */
const workspaceReconciler = new WorkspaceReconciler({
  store: workspaceStore,
  getTab: async (tabId) => {
    const tab = await browserAdapter.getTab(tabId);
    return tab === null
      ? null
      : { id: tab.id, url: tab.url, title: tab.title, groupId: tab.groupId };
  },
  onChange: async (change) => {
    await auditLog.record({
      type: 'workspace.membership',
      outcome: 'info',
      origin: change.origin,
      code: change.kind,
    });
  },
});

/** Last known origin per tab, so a closed tab can be found in the mirror. */
const lastKnownOrigin = new Map<number, string>();

/**
 * The drag signal.
 *
 * Measured in real Chromium: there is no `tabs.onGroupChanged`. Grouping a tab
 * emits `tabs.onUpdated` with `changeInfo.groupId` set to the new group, and
 * ungrouping emits the same event with `-1`. That single fact is what makes
 * drag-and-drop membership detectable at all.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.url) {
    try {
      lastKnownOrigin.set(tabId, new URL(tab.url).origin);
    } catch {
      lastKnownOrigin.delete(tabId);
    }
  }
  if (changeInfo.groupId === undefined) return;
  void workspaceReconciler.handleGroupChanged(tabId, changeInfo.groupId).catch(() => undefined);
});

/**
 * Chrome deleted a tab group.
 *
 * Measured: a group ceases to exist when its last tab leaves, so this fires
 * without the user doing anything they would describe as closing it. The
 * workspace **detaches** — nothing is deleted, and re-attaching is a
 * deliberate action.
 */
chrome.tabGroups.onRemoved.addListener((group) => {
  void workspaceReconciler.handleGroupRemoved(group.id).catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lifecycle.handleTabClosed(tabId);
  const origin = lastKnownOrigin.get(tabId);
  lastKnownOrigin.delete(tabId);
  void workspaceReconciler.handleTabRemoved(tabId, origin).catch(() => undefined);
});

chrome.runtime.onSuspend?.addListener(() => {
  taskManager.abortAll();
  permissionBroker.denyAll();
  fileSelectionBroker.cancelAll('The extension was suspended before a file was chosen.');
  // Redundant, since the worker's memory goes with it — stated anyway, so the
  // lifetime of a staged file is written down rather than inferred.
  stagedFiles.clearAll();
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function startup(): Promise<void> {
  const settings = await settingsStore.get();
  setGlobalLogLevel(settings.logLevel);

  if (settings.activeProviderId && providerRegistry.has(settings.activeProviderId)) {
    // Mark the provider active without connecting: the adapter is reconnected
    // lazily in resolveProvider, so a bad stored key surfaces at task start
    // rather than as a silent no-op here.
    providerRegistry.setActive(settings.activeProviderId);
  }

  await registerBundledSkills();

  // A run still marked `running` in a fresh worker generation is one whose
  // worker died. Marking it interrupted stops a later reader concluding that
  // something is still executing it; it is not resumed, because the step
  // results it would need were deliberately never persisted.
  const interruptedRuns = await skillRuns.reconcileAfterRestart();

  const report = await lifecycle.recoverInterruptedTasks();
  if (report.recovered > 0) {
    for (const taskId of report.taskIds) {
      const task = await taskStore.getTask(taskId);
      if (task) broadcastEvent({ type: 'task.updated', task });
    }
  }
  log.info('Service worker ready.', {
    tools: toolRegistry.list().length,
    providers: providerRegistry.list().length,
    skills: skillRegistry.size,
    recoveredTasks: report.recovered,
    interruptedSkillRuns: interruptedRuns.length,
  });
}

void startup().catch((error: unknown) => {
  log.error('Service worker startup failed.', {
    error: error instanceof Error ? error.message : String(error),
  });
});

export { OPENAI_COMPATIBLE_PROVIDER_ID, ANTHROPIC_PROVIDER_ID, GEMINI_PROVIDER_ID };
