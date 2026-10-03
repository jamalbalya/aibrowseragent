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
import { McpServerStore, McpServerError } from '@/mcp/core/mcp-server-store';
import {
  registerMcpServers,
  unregisterServer,
  type McpServerOutcome,
} from '@/mcp/core/mcp-registrar';
import { createMcpTransport } from '@/mcp/transport/mcp-transport';
import { mcpDestination } from '@/security/egress/destination';
import { EvidenceStore } from '@/evidence/evidence-store';
import { ProviderRegistry, type ProviderConnection } from '@/providers/registry/provider-registry';
import { ConsentStore } from '@/security/egress/consent';
import {
  AuditLog,
  buildAuditExport,
  describeScopeProblem,
  parseAuditExportScope,
  type RecordableAuditEvent,
} from '@/audit/audit-log';
import { createDispatchAuditObserver } from '@/audit/dispatch-audit';
import { recordWithEvidence as writeDecision } from '@/audit/record-with-evidence';
import { createGuardedTransport, guardedSend } from '@/security/egress/provider-transport';
import { installNetworkInterceptor } from '@/security/egress/network-interceptor';
import { buildEgressEvidence, type BuiltEgressEvidence } from '@/security/egress/egress-evidence';
import { connectorDestination, providerDestination } from '@/security/egress/destination';
import { CapabilityDoctor } from '@/providers/capability-doctor/capability-doctor';
import { OPENAI_COMPATIBLE_PROVIDER_ID } from '@/providers/adapters/openai-compatible';
import { ANTHROPIC_PROVIDER_ID } from '@/providers/adapters/anthropic';
import { GEMINI_PROVIDER_ID } from '@/providers/adapters/gemini';
import { API_PROVIDER_FACTORIES } from '@/providers/registry/api-providers';
import { discoverCatalogue } from '@/providers/registry/discovery';
import { OfferedModels } from '@/providers/registry/offered-models';
import { doctorVerdict } from '@/providers/capability-doctor/doctor-verdict';
import { UNKNOWN_CAPABILITIES } from '@/providers/core/types';
import { ToolRegistry } from '@/tools/registry/tool-registry';
import { ChromeBrowserAdapter } from '@/tools/browser/chrome-adapter';
import { createBrowserTools } from '@/tools/browser/browser-tools';
import { createTabTools, TabOwnership } from '@/tools/tabs/tab-tools';
import { DebuggerManager } from '@/tools/debugger/debugger-manager';
import { FieldObservationStore } from '@/policy/field-observation-store';
import { createDebuggerTools } from '@/tools/debugger/debugger-tools';
import { createFileTools } from '@/tools/files/file-tools';
import { StagedFileStore } from '@/files/file-store';
import { ChromeDownloadPort } from '@/files/download-port';
import { FileSelectionBroker } from './file-broker';
import { safeDisplayName, safeMediaType } from '@/files/file-model';
import { ConnectorRegistry, scopesFor, type Connector } from '@/connectors/core/types';
import { ConnectorSession } from '@/connectors/core/connector-session';
import { TokenVault } from '@/connectors/oauth/token-vault';
import { WriteGuard } from '@/connectors/core/write-guard';
import { TabAuthFlow, chromeTabs } from '@/connectors/oauth/auth-flow-port';
import {
  createConnectorTransport,
  type ConnectorEgressContext,
} from '@/connectors/transport/connector-transport';
import type { EgressDecision } from '@/security/egress/egress-gate';
import { DEFAULT_BUDGET } from '@/agent/budget/budget';
import { SkillRegistry } from '@/skills/core/skill-registry';
import { SkillRunner } from '@/skills/runtime/skill-runner';
import { SkillRunStore } from '@/skills/runtime/skill-run-store';
import { SkillEnablementStore, skillEnablementKey } from '@/skills/core/skill-enablement';
import { BUNDLED_SKILLS } from '@/skills/bundled';
import { createSkillTools } from '@/tools/skills/skill-tools';
import { WorkflowStore, WorkflowValidationError } from '@/workflows/workflow-store';
import { WorkflowRecorder } from '@/workflows/workflow-recorder';
import { WorkflowReplayer } from '@/workflows/workflow-replay';
import { ShortcutStore, ShortcutError } from '@/shortcuts/shortcut-store';
import { ShortcutResolver } from '@/shortcuts/shortcut-resolver';
import {
  SHORTCUT_PROFILE_MODE,
  isShortcutPermissionProfile,
  normaliseAllowedTools,
} from '@/shortcuts/shortcut-model';
import { SkillLauncher } from './skill-launcher';
import type { ShortcutRecord } from '@/shortcuts/shortcut-model';
import type { ScheduleRunSummary, ScheduleSummary, ShortcutSummary } from '@/messaging/protocol';
import { ScheduleStore, ScheduleError } from '@/schedules/schedule-store';
import {
  describeCadence,
  isUnattendedSessionId,
  type ScheduleRecord,
  type ScheduleRunRecord,
  type ScheduleTarget,
} from '@/schedules/schedule-model';
import { ScheduleRunner, type ScheduledExecution, type TargetResolution } from './schedule-runner';
import { UnattendedPrompter } from './unattended-prompter';
import { isIncomplete, type RecordedWorkflow } from '@/workflows/workflow-model';
import { digestSteps } from '@/workflows/step-digest';
import type { WorkflowSummary } from '@/messaging/protocol';
import {
  ConfluenceConnector,
  confluenceDescriptor,
  confluenceTokenProbeUrl,
  readConfluenceTokenProbe,
} from '@/connectors/adapters/confluence';
import {
  JiraConnector,
  jiraDescriptor,
  jiraTokenProbeUrl,
  readJiraTokenProbe,
  jiraBasicCredential,
} from '@/connectors/adapters/jira';
import {
  FigmaConnector,
  figmaDescriptor,
  figmaTokenProbeUrl,
  readFigmaTokenProbe,
  FIGMA_CREDENTIAL_HEADER,
} from '@/connectors/adapters/figma';
import {
  GitHubConnector,
  githubDescriptor,
  githubTokenProbeUrl,
  readGitHubTokenProbe,
  type ConnectorCallContext,
} from '@/connectors/adapters/github';
import { PermissionEngine } from '@/policy/permission-engine';
import {
  emptySitePolicyState,
  removeRule,
  sanitiseSitePolicyState,
  type SitePolicyState,
} from '@/policy/site-policy';
import { strictestMode, type PolicyContext } from '@/policy/policy-engine';
import { parsePlanApproval } from '@/policy/plan-model';
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
import { resolveBrainAccount, BrainUnavailable } from '@/providers/accounts/resolve-brain';
import { protocolForLegacyProvider } from '@/providers/accounts/migrate-legacy';
import {
  accountAfterCatalogue,
  accountAfterOfferedSelection,
  deriveAccountLabel,
} from '@/providers/accounts/account-model';
import { modelSelectionState, selectionRefusal } from '@/providers/registry/model-selection';
import { IdentityProfileStore } from '@/identity/identity-profile';
import { LocalIdentityStore, resolveOwner } from '@/identity/local-identity';
import { SessionStore } from '@/identity/session-store';
import { AuthController } from '@/identity/auth-controller';
import { EmailSignIn } from '@/identity/email-sign-in';
import { IdentityClient } from '@/identity/identity-client';
import { GoogleSignIn } from '@/identity/google-sign-in';
import { SessionClient } from '@/identity/session-client';
import { IdentityTransport } from '@/identity/identity-transport';
import { loadIdentityConfig } from '@/identity/identity-config';
import {
  loadGoogleProviderAuthConfig,
  googleRedirectUri,
} from '@/providers/oauth/provider-auth-config';
import {
  GoogleProviderAuth,
  needsRefresh,
  type GoogleProviderToken,
} from '@/providers/oauth/google-provider-auth';
import { credentialForConnection } from '@/providers/accounts/connection-credential';
import {
  WebAuthFlow,
  ensureIdentityPermission,
  hasIdentityPermission,
} from '@/providers/oauth/web-auth-flow';
import {
  GOOGLE_AUTH,
  providerAuthorization,
  isGoogleAuthorizable,
} from '@/providers/accounts/authorization';
import { providerAuthDestination } from '@/security/egress/destination';
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
    // Only reachable with no owner established at all, which is a storage
    // failure and is reported as one. A signed-in profile that is not the
    // owner of the local data is **not** a failure and no longer comes
    // through here: it used to, and the consequence was that signing in with
    // Google reported `RECOVERY_REQUIRED`, which `TaskManager` treats as
    // work-blocking, and every task was refused with "Stored state needs to be
    // reviewed before work can continue." Nothing was wrong with the stored
    // state. See `resolveOwner` for the measurement and the rule.
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
/**
 * The decision/evidence pair, bound once.
 *
 * Bound here rather than passed at each of the four call sites, so none of
 * them can be wired to a different audit log or evidence store than the rest.
 * The ordering rule itself lives in `record-with-evidence.ts`, where it is
 * testable without loading this worker.
 */
const recordWithEvidence = (
  built: BuiltEgressEvidence,
  event: (evidenceId: string) => RecordableAuditEvent,
): Promise<void> => writeDecision({ audit: auditLog, evidence: evidenceStore }, built, event);

const policyArea = new NamespacedStorageArea(local, 'policy');
const connectorTokens = new TokenVault(new NamespacedStorageArea(session, 'connector-tokens'));
const connectorWrites = new WriteGuard(new NamespacedStorageArea(local, 'connector-writes'));

const SITE_POLICY_KEY = 'site-policy';
const SESSION_KEY = 'active-session';

const loadSitePolicy = async (): Promise<SitePolicyState> =>
  // Sanitised on the way out rather than on the way in: a record written by an
  // older build, or restored from an export, never passes through the save
  // path. Repairing at the read is what makes every reader see the same thing.
  sanitiseSitePolicyState(
    (await policyArea.get<SitePolicyState>(SITE_POLICY_KEY)) ?? emptySitePolicyState(),
  );

const saveSitePolicy = async (state: SitePolicyState): Promise<void> => {
  await policyArea.set(SITE_POLICY_KEY, state);
};

const loadPolicyContext = async (taskId: string): Promise<PolicyContext> => {
  const settings = await settingsStore.get();
  // Kept for the audit observer, which cannot await storage on the dispatch
  // path. It labels a record; it decides nothing.
  currentPermissionMode = settings.permissionMode;
  // Read from the durable task record, not from worker memory, so a run that
  // outlives an eviction is still unattended when it wakes. A task that
  // cannot be read is treated as unattended: the strict direction, and the
  // one that cannot silently authorise anything.
  const task = await taskStore.getTask(taskId).catch(() => undefined);
  const unattended = task === undefined || isUnattendedSessionId(task.sessionId);
  // Re-parsed rather than trusted. The record came back from storage, and a
  // stored approval that does not parse is no approval at all — never a weaker
  // one. `parsePlanApproval` is the boundary where that is decided, so the
  // engine only ever sees an approval this build would have produced.
  const planApproval = parsePlanApproval(task?.planApproval, taskId);
  // A task started from a shortcut with a permission profile carries a floor
  // on strictness. Resolved through `strictestMode` against the mode in force
  // right now, so the floor can only tighten this call and can never loosen it
  // — including when the ambient setting has moved since the task started.
  const mode =
    task?.permissionFloor === undefined
      ? settings.permissionMode
      : strictestMode(settings.permissionMode, task.permissionFloor);
  return {
    mode,
    sitePolicy: await loadSitePolicy(),
    allowInsecureOrigins: settings.allowInsecureOrigins,
    unattended,
    ...(planApproval === undefined ? {} : { planApproval }),
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
    await recordWithEvidence(built, (evidenceId) => ({
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
      evidenceIds: [evidenceId],
    }));
  },
});

const providerRegistry = new ProviderRegistry({ transport: providerTransport });
// Every registered provider is an API provider built with the guarded
// transport above. Web providers are foundation only and are not registered
// here: registering one would make it selectable, and inference against an
// authenticated web session remains closed.
// Registered from the shared list rather than named here, so the conformance
// suite can enumerate exactly what this build registers. See
// `api-providers.ts` for why that matters.
for (const factory of API_PROVIDER_FACTORIES) providerRegistry.register(factory);
const capabilityDoctor = new CapabilityDoctor();

// ---------------------------------------------------------------------------
// Browser, tools and the policy control plane
// ---------------------------------------------------------------------------

const browserAdapter = new ChromeBrowserAdapter();
const debuggerManager = new DebuggerManager();
/**
 * Gate 1's field observations, held for this worker generation only.
 *
 * Deliberately not persisted. An observation is a fact about a page a
 * moment ago; surviving an eviction would make a stale fact durable, and
 * `classifyField(undefined)` already answers an empty store correctly.
 */
const fieldObservations = new FieldObservationStore();
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
  /**
   * "Allow for this task" adds the site to that task's plan.
   *
   * Deliberately narrower than the standing grant next to it: nothing is
   * written to the site policy, so the authorization ends when the task does.
   * It amends an approval that already exists and cannot create one, so a task
   * that never planned gets a one-off approval and nothing more.
   */
  amendPlan: async (taskId, site) => {
    await taskManager.addSiteToPlan(taskId, site);
    await auditLog
      .record({ type: 'plan.site_added', taskId, site, outcome: 'allowed', code: 'PLAN_AMENDED' })
      .catch(() => undefined);
  },
  /**
   * A standing grant, recorded where it is written.
   *
   * `onDecision` below says a prompt was approved; it cannot say the approval
   * created a rule that will suppress future prompts, because its code is the
   * decision and `approve_once` and `approve_site` share one. This is the
   * other half, and `policy.removeSiteRule` records the matching removal — so
   * the trail can answer when a site became trusted and when it stopped.
   */
  onSiteRule: async ({ site, maxRisk, tool }) => {
    await auditLog.record({
      type: 'policy.site_rule',
      site,
      tool,
      risk: maxRisk,
      outcome: 'allowed',
      code: 'SITE_RULE_GRANTED',
    });
  },
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
  /**
   * The confirmation boundary, in front of the one prompter (P-020).
   *
   * Not a second permission path: it evaluates nothing and can only turn a
   * question into a denial. A run whose task belongs to an unattended session
   * is denied here, because there is nobody to ask; everything else reaches
   * `permissionBroker` exactly as before.
   *
   * The decision is read from the durable task record rather than from worker
   * memory, so a run that outlives an eviction is still unattended when it
   * wakes.
   */
  prompter: new UnattendedPrompter({
    interactive: permissionBroker,
    sessionOf: async (taskId) => (await taskStore.getTask(taskId))?.sessionId,
    onUnattendedRefusal: (sessionId) => {
      scheduleRunner.noteConfirmationRefusal(sessionId);
    },
  }),
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

/**
 * The one place a tab's URL is read for policy purposes.
 *
 * Shared by the registry, the agent loop and the skill runner rather than
 * written three times, because three readings of "where is this tab" would
 * eventually disagree and the one that disagreed permissively would be the
 * bug. It reads `chrome.tabs` and nothing else: not the page, not the model,
 * not a tool argument.
 */
const resolveTabUrl = async (tabId: number): Promise<string | undefined> => {
  try {
    return (await browserAdapter.getTab(tabId))?.url;
  } catch {
    // Unknown means unknown: the gate denies rather than guessing an origin.
    return undefined;
  }
};

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
  resolveTabUrl,
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
      await recordWithEvidence(built, (evidenceId) => ({
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
        evidenceIds: [evidenceId],
      }));
    },
  },
  permissionEngine,
  loadPolicyContext,
  evidenceStore,
  // P-021's narrowing, read from the durable task record rather than from
  // worker memory, so a run that outlives an eviction is still narrowed when
  // it wakes. A task that cannot be read yields `undefined`, which is no
  // narrowing — and that is safe here only because every other gate still
  // applies: the constraint removes tools, it never admits one.
  resolveAllowedTools: async (taskId) =>
    (await taskStore.getTask(taskId).catch(() => undefined))?.allowedTools,
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
 * Where a user goes to create a token, per connector.
 *
 * Here rather than in the adapter because it is a sentence shown in the panel,
 * and here rather than in the panel because which service a connector talks to
 * is the worker's knowledge. No credential is in this table and none can be:
 * it holds a label, a URL the *user* opens, and a line of help.
 */
const CONNECTOR_TOKEN_HINTS: Readonly<
  Record<string, { label: string; issuePage: string; help: string; accountLabel?: string }>
> = {
  confluence: {
    label: 'Atlassian API token',
    accountLabel: 'The email address of your Atlassian account',
    issuePage: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    help:
      'The same kind of token Jira uses, and the same site — if you connected Jira you will ' +
      'paste the same two values again, because each connector keeps its own credential and ' +
      'its own reachable address. Read-only: it searches pages and reads one as text, and ' +
      'changes nothing. Atlassian Cloud sites only.',
  },
  jira: {
    label: 'Jira API token',
    accountLabel: 'The email address of your Atlassian account',
    issuePage: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    help:
      'Create an API token in your own Atlassian account, and enter it with the email address ' +
      'that account uses. Jira does not report what a token may do — it can see whatever you ' +
      'can — so this connector is read-only: it searches issues and reads one with its ' +
      'comments, and changes nothing. Atlassian Cloud sites only.',
  },
  figma: {
    label: 'Figma personal access token',
    issuePage: 'https://www.figma.com/developers/api#access-tokens',
    help:
      'Create a token in your own Figma account and paste it here. Give it ' +
      'file_content:read, file_comments:read and current_user:read — the last one is what ' +
      'lets this build check the token belongs to you. Figma does not report what a token may ' +
      'do, so this connector is read-only: it reads a file’s structure and its comments, and ' +
      'posts nothing.',
  },
  github: {
    label: 'GitHub personal access token',
    issuePage: 'https://github.com/settings/tokens',
    help:
      'Create a token in your own GitHub account and paste it here. Reading public issues ' +
      'needs no permission at all; opening or commenting on one needs public_repo. A ' +
      'fine-grained token works for reads, but GitHub does not report what it may do, so ' +
      'writes are refused rather than attempted.',
  },
};

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

/**
 * Checks a token the user supplied, before anything is stored.
 *
 * Deliberately alongside the token exchange and not in the connector
 * transport, for the two reasons the exchange gives plus one of its own: the
 * transport reads a credential out of the vault, and this call exists to check
 * one that has not been written there. Writing first and checking second would
 * mean a worker evicted in between leaves an unverified token stored, which
 * `reconcile` then reads back as a grant and never re-checks.
 *
 * It belongs to no task, carries no task taint, and its payload is opaque —
 * the credential is in a header by construction.
 */
async function probeConnectorToken(
  url: string,
  credential: { token: string; tokenType: string | null },
  /**
   * The header the credential goes in for this probe.
   *
   * From the connector's descriptor, like everywhere else a credential header
   * is chosen. Figma reads `X-Figma-Token` and ignores `Authorization`, so a
   * probe that always used `Authorization` would report every Figma token as
   * refused.
   */
  header = 'Authorization',
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const response = await guardedSend(
    {
      url,
      init: {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          [header]:
            credential.tokenType === null
              ? credential.token
              : `${credential.tokenType} ${credential.token}`,
        },
        // Never followed: a probe that redirects is one that could be made to
        // carry a credential somewhere else.
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      },
      destination: connectorDestination('connector-token-probe', url, {
        purpose: 'token_probe',
      }),
      taskId: 'connector-authentication',
      taintState: { kind: 'KNOWN_UNTAINTED' },
      taintSalt: connectorAuthSalt,
      taintSignature: 'authentication',
      describe: 'connector token check',
      payloadPolicy: 'opaque',
    },
    { consent: consentStore },
  );

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON body is not a failure here: the status and the headers are
    // what the verdict is built from, and the account label is optional.
    body = null;
  }
  return { status: response.status, headers: response.headers, body };
}

/**
 * How GitHub is authenticated in the shipped build.
 *
 * `api_token`, not `oauth2`, and the reason is a correction rather than a
 * preference: GitHub's web application flow requires a `client_secret` in the
 * code exchange, PKCE or not, and this extension must not carry one. The
 * authorization-code path is therefore unreachable here whatever client id a
 * deployment supplies — which is a different thing from what
 * `connector.authorize` used to imply. A token the user creates in their own
 * account needs no registered application and no secret anywhere.
 *
 * The OAuth configuration is still on the descriptor and still validated. A
 * deployment that holds a secret outside the extension would pass `oauth2`
 * here and use it.
 */
const githubDescriptorValue = githubDescriptor({
  redirectUri: CONNECTOR_REDIRECT_URI,
  authKind: 'api_token',
});

const githubSession = new ConnectorSession({
  descriptor: githubDescriptorValue,
  vault: connectorTokens,
  authFlow: new TabAuthFlow(chromeTabs()),
  clientId: CONNECTOR_CLIENT_IDS[githubDescriptorValue.id] ?? '',
  exchange: exchangeConnectorToken,
  introspect: async (credential) => {
    const probe = await probeConnectorToken(
      githubTokenProbeUrl(githubDescriptorValue.apiOrigins[0]!),
      credential,
    );
    return readGitHubTokenProbe({
      status: probe.status,
      headers: probe.headers,
      ...(probe.body !== null && typeof probe.body === 'object'
        ? { login: (probe.body as { login?: unknown }).login }
        : {}),
    });
  },
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

    // Specification section 53. A grant expires while nobody is looking, and
    // the next thing that needs it fails for a reason the user cannot guess
    // from the failure. Only this one transition is worth a toast: the others
    // are the user's own doing and they are standing in front of the panel.
    if (status.state === 'NEEDS_AUTH' && status.reason === 'grant_expired') {
      void notifier.connectorAuthExpired(githubDescriptorValue.displayName);
    }
  },
});

/**
 * What every connector's egress decision is recorded as.
 *
 * One function, because two connectors must not produce two different audit
 * shapes for the same kind of event — and because a second copy is where the
 * evidence and the record come to disagree about which decision they describe.
 * Named here rather than inside a transport so each connector's wiring reads
 * as the one line it is.
 */
const connectorEgressObserver = async (
  decision: EgressDecision,
  context: ConnectorEgressContext,
  url: string,
  payload: unknown,
): Promise<void> => {
  const built = await buildEgressEvidence({
    taskId: context.taskId,
    sourceTool: `connector.${context.connectorId}.${context.operationId}`,
    destination: connectorDestination(context.connectorId, url, {
      purpose: context.operationId,
    }),
    decision,
    ...(typeof payload === 'string' ? { payload } : {}),
    taintSalt: context.taintSalt,
    saltEpoch: context.saltEpoch,
    now: Date.now(),
  });
  await recordWithEvidence(built, (evidenceId) => ({
    type: 'connector.operation',
    taskId: context.taskId,
    connectorId: context.connectorId,
    operation: context.operationId,
    ...(decision.destinationIdentity === null ? {} : { destination: decision.destinationIdentity }),
    outcome:
      decision.verdict === 'allow'
        ? 'allowed'
        : decision.verdict === 'deny'
          ? 'denied'
          : 'confirmed',
    code: decision.code,
    evidenceIds: [evidenceId],
  }));
};

const githubConnector = new GitHubConnector({
  descriptor: githubDescriptorValue,
  session: githubSession,
  transport: createConnectorTransport({
    descriptor: githubDescriptorValue,
    vault: connectorTokens,
    consent: consentStore,
    onDecision: connectorEgressObserver,
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
function registerConnector(connector: Connector): void {
  try {
    connectorRegistry.register(connector);
  } catch (error) {
    log.error('A connector could not be registered and has been left out.', {
      connectorId: connector.descriptor.id,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Figma, the second connector, and the second that needs no registration.
 *
 * `api_token` like GitHub, and for a stronger reason: Figma's OAuth requires a
 * `client_secret` in its code exchange even with PKCE, so there is no
 * authorization flow this extension could ever complete for it. A personal
 * access token the user creates needs nothing from anybody.
 *
 * Read-only, because Figma reports nothing about what a token may do and a
 * write would declare a scope that could never be satisfied. See the adapter.
 */
const figmaDescriptorValue = figmaDescriptor();

const figmaSession = new ConnectorSession({
  descriptor: figmaDescriptorValue,
  vault: connectorTokens,
  authFlow: new TabAuthFlow(chromeTabs()),
  // No client id, and none would help: there is no flow to start.
  clientId: '',
  exchange: exchangeConnectorToken,
  introspect: async (credential) => {
    const probe = await probeConnectorToken(
      figmaTokenProbeUrl(figmaDescriptorValue.apiOrigins[0]!),
      credential,
      // Figma ignores `Authorization`. A probe on the wrong header would
      // report every valid token as refused.
      FIGMA_CREDENTIAL_HEADER,
    );
    const body = probe.body !== null && typeof probe.body === 'object' ? probe.body : {};
    return readFigmaTokenProbe({
      status: probe.status,
      handle: (body as { handle?: unknown }).handle,
      email: (body as { email?: unknown }).email,
    });
  },
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
    if (status.state === 'NEEDS_AUTH' && status.reason === 'grant_expired') {
      void notifier.connectorAuthExpired(figmaDescriptorValue.displayName);
    }
  },
});

const figmaConnector = new FigmaConnector({
  descriptor: figmaDescriptorValue,
  session: figmaSession,
  transport: createConnectorTransport({
    descriptor: figmaDescriptorValue,
    vault: connectorTokens,
    consent: consentStore,
    onDecision: connectorEgressObserver,
  }),
  writes: connectorWrites,
  egressFor: (taskId) => connectorEgressContexts.get(taskId),
});

registerConnector(githubConnector);
/**
 * Jira Cloud, the first connector whose API origin belongs to the user.
 *
 * `api_token` because Atlassian OAuth 2.0 (3LO) requires a `client_secret` and
 * supports no PKCE at all — the only one of the six Tier 1 services where both
 * are true — so there is no flow this extension could ever complete. HTTP
 * Basic with an email address and an API token the user creates needs nothing
 * from anybody.
 *
 * The origin is parsed at connect time and stored with the credential; the
 * transport's allowlist is that single origin on every request, read fresh.
 * `site-binding.ts` has the rule and what it refuses.
 */
const jiraDescriptorValue = jiraDescriptor();

const jiraSession = new ConnectorSession({
  descriptor: jiraDescriptorValue,
  vault: connectorTokens,
  authFlow: new TabAuthFlow(chromeTabs()),
  clientId: '',
  exchange: exchangeConnectorToken,
  introspect: async (credential) => {
    // The probe goes to the user's own site, which is why it needs the origin
    // the session has just validated — and why it cannot run before that
    // validation. An unusable site is refused with no request leaving at all.
    if (credential.boundOrigin === undefined) {
      throw new Error('jira_probe_without_bound_origin');
    }
    const probe = await probeConnectorToken(jiraTokenProbeUrl(credential.boundOrigin), credential);
    const body = probe.body !== null && typeof probe.body === 'object' ? probe.body : {};
    return readJiraTokenProbe({
      status: probe.status,
      displayName: (body as { displayName?: unknown }).displayName,
      emailAddress: (body as { emailAddress?: unknown }).emailAddress,
    });
  },
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
    if (status.state === 'NEEDS_AUTH' && status.reason === 'grant_expired') {
      void notifier.connectorAuthExpired(jiraDescriptorValue.displayName);
    }
  },
});

const jiraConnector = new JiraConnector({
  descriptor: jiraDescriptorValue,
  session: jiraSession,
  transport: createConnectorTransport({
    descriptor: jiraDescriptorValue,
    vault: connectorTokens,
    consent: consentStore,
    onDecision: connectorEgressObserver,
  }),
  writes: connectorWrites,
  egressFor: (taskId) => connectorEgressContexts.get(taskId),
  // Read per call, never cached: a site that has been changed or a credential
  // that has been discarded must not leave a previous origin in use. The
  // transport checks the same binding again independently.
  boundOrigin: () => connectorTokens.boundOrigin(jiraDescriptorValue.id),
});

registerConnector(figmaConnector);
/**
 * Confluence Cloud, the fourth connector and the last one that was reachable.
 *
 * The same site as Jira, the same credential kind, and a separate credential
 * record — because one record holds one token and one bound origin, and
 * `connectorId` is what the consent pin, the audit trail and the write guard
 * key on. See the adapter for why sharing one would make "which connector may
 * reach where" a question with two answers.
 */
const confluenceDescriptorValue = confluenceDescriptor();

const confluenceSession = new ConnectorSession({
  descriptor: confluenceDescriptorValue,
  vault: connectorTokens,
  authFlow: new TabAuthFlow(chromeTabs()),
  clientId: '',
  exchange: exchangeConnectorToken,
  introspect: async (credential) => {
    if (credential.boundOrigin === undefined) {
      throw new Error('confluence_probe_without_bound_origin');
    }
    const probe = await probeConnectorToken(
      confluenceTokenProbeUrl(credential.boundOrigin),
      credential,
    );
    const body = probe.body !== null && typeof probe.body === 'object' ? probe.body : {};
    return readConfluenceTokenProbe({
      status: probe.status,
      displayName: (body as { displayName?: unknown }).displayName,
      email: (body as { email?: unknown }).email,
    });
  },
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
    if (status.state === 'NEEDS_AUTH' && status.reason === 'grant_expired') {
      void notifier.connectorAuthExpired(confluenceDescriptorValue.displayName);
    }
  },
});

const confluenceConnector = new ConfluenceConnector({
  descriptor: confluenceDescriptorValue,
  session: confluenceSession,
  transport: createConnectorTransport({
    descriptor: confluenceDescriptorValue,
    vault: connectorTokens,
    consent: consentStore,
    onDecision: connectorEgressObserver,
  }),
  writes: connectorWrites,
  egressFor: (taskId) => connectorEgressContexts.get(taskId),
  boundOrigin: () => connectorTokens.boundOrigin(confluenceDescriptorValue.id),
});

registerConnector(jiraConnector);
registerConnector(confluenceConnector);

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
toolRegistry.registerAll(
  createBrowserTools({ adapter: browserAdapter, debuggerManager, fieldObservations }),
);
toolRegistry.registerAll(createTabTools({ adapter: browserAdapter, ownership: tabOwnership }));
toolRegistry.registerAll(
  createDebuggerTools({ adapter: browserAdapter, manager: debuggerManager }),
);

// ---------------------------------------------------------------------------
// MCP (P-026)
// ---------------------------------------------------------------------------

/**
 * Servers the user added, and what each one last contributed.
 *
 * The outcomes are held in memory rather than stored, which is not an
 * oversight: a server's tools exist only as a function of the answer it last
 * gave, so there is no durable "connected" state to keep. A worker generation
 * that has not registered yet reports nothing rather than a remembered success.
 */
const mcpServers = new McpServerStore({ area: local, health: persistenceHealth });
const mcpOutcomes = new Map<string, McpServerOutcome>();

/**
 * The salt for the registration pass itself.
 *
 * Discovery is not a task: nothing a person asked for is behind it, and
 * attributing it to one would put a registration's egress evidence under a task
 * that never made the request. The taint state is explicitly clean for the same
 * reason the connector token exchange's is — it says there is no task, not that
 * one was inspected.
 */
const mcpRegistrationSalt = generateTaintSalt();

/**
 * The per-call security context an MCP tool needs.
 *
 * Reads the same per-task map the connector tools read, so an MCP call inherits
 * the task's taint rather than starting from a clean one: a task that has read
 * a page and then calls an MCP tool is sending page-derived arguments to a third
 * party, and the exfiltration gate has to see that.
 */
const mcpSecurityContextFor = (taskId: string) => {
  const held = connectorEgressContexts.get(taskId);
  if (held !== undefined) {
    return Promise.resolve({
      taskId,
      taintState: held.taintState,
      taintSalt: held.taintSalt,
      saltEpoch: held.saltEpoch,
      taintSignature: held.taintSignature,
    });
  }
  // The registration pass, and only the registration pass: a task always has a
  // context by the time one of its tools runs.
  return Promise.resolve({
    taskId,
    taintState: { kind: 'KNOWN_UNTAINTED' } as const,
    taintSalt: mcpRegistrationSalt,
    saltEpoch: 1,
    taintSignature: 'mcp-registration',
  });
};

const mcpTransportFor = (server: { id: string; displayName: string; url: string }) =>
  createMcpTransport({
    server,
    consent: consentStore,
    onDecision: async (decision, context, url, payload) => {
      const built = await buildEgressEvidence({
        taskId: context.taskId,
        sourceTool: `mcp.${server.id}.${context.method}`,
        destination: mcpDestination(server.id, url, { method: context.method }),
        decision,
        ...(payload === undefined ? {} : { payload }),
        taintSalt: context.taintSalt,
        saltEpoch: context.saltEpoch,
        now: Date.now(),
      });
      await recordWithEvidence(built, (evidenceId) => ({
        type: 'egress.decided',
        taskId: context.taskId,
        // This build's own vocabulary throughout. `method` is a JSON-RPC method
        // name and the destination is an origin; neither is a tool name, which
        // the server authored and which must not become a field in a trail.
        tool: `mcp.${server.id}.${context.method}`,
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
        evidenceIds: [evidenceId],
      }));
    },
  });

/** Re-discovers every stored server and replaces its tools. */
async function refreshMcpServers(): Promise<readonly McpServerOutcome[]> {
  const outcomes = await registerMcpServers({
    store: mcpServers,
    registry: toolRegistry,
    transportFor: mcpTransportFor,
    securityContextFor: mcpSecurityContextFor,
  });
  mcpOutcomes.clear();
  for (const outcome of outcomes) mcpOutcomes.set(outcome.serverId, outcome);
  return outcomes;
}

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
/**
 * Which skills the user has switched off (P-024).
 *
 * Durable in storage; mirrored here because the registry is read on the
 * dispatch path, where there is nothing to await into. The mirror is refreshed
 * at startup and after every change, and it starts **empty** — every shipped
 * skill enabled — so a storage read that has not happened yet, or that failed,
 * leaves the build's own defaults in force rather than silently disabling
 * working skills.
 */
let disabledSkills: ReadonlySet<string> = new Set();

const skillEnablement = new SkillEnablementStore(new NamespacedStorageArea(local, 'skills'));

const refreshSkillEnablement = async (): Promise<void> => {
  disabledSkills = await skillEnablement.disabledKeys();
};

const skillRegistry = new SkillRegistry({
  riskOfTool: (name) => toolRegistry.get(name)?.risk,
  // The one enforcement point. Every read of the registry honours it, so a
  // disabled skill is absent from the model's listing, from `skills.run`,
  // from the panel's launcher and from a shortcut resolving its target,
  // without any of them having to remember to check.
  isEnabled: (id, version) => !disabledSkills.has(skillEnablementKey(id, version)),
});

const skillRuns = new SkillRunStore(new NamespacedStorageArea(local, 'skill-runs'));

const skillRunner = new SkillRunner({
  tools: toolRegistry,
  skills: skillRegistry,
  // Per step, so a step that follows a navigation is judged against the page
  // it will actually run on. See `SkillRunnerOptions.resolveTabUrl`.
  resolveTabUrl,
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
    // So a scheduled run in flight can be stopped by the person who set it.
    scheduleRunner.observeTask(task.id, task.sessionId);
  },
});

/**
 * A recording, as the review surface sees it.
 *
 * Bindings are described by `digestStep`, which the live recording list uses
 * as well so that one step has one description wherever it is shown. Why that
 * mapping is not inline here any more, and why a literal shows its value, are
 * both in `step-digest.ts`.
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
    steps: digestSteps(record.definition.steps),
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
  // Only ever consulted once the enforcing read above has refused, and only
  // to say why. It cannot produce a resolution.
  disabledSkill: (skillId, skillVersion) => {
    const entry = skillRegistry.getIncludingDisabled(skillId, skillVersion);
    if (!entry || skillRegistry.get(skillId, skillVersion)) return undefined;
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
    scheduleRunner.observeTask(task.id, task.sessionId);
  },
});

/** The id a shortcut's target is looked up by, or an empty string when it has none. */
function targetIdOf(target: ShortcutRecord['target']): string {
  switch (target.kind) {
    case 'workflow':
      return target.workflowId;
    case 'skill':
      return target.skillId;
    case 'prompt':
      return '';
  }
}

/** A shortcut as the panel sees it, with its target looked up now. */
/**
 * Records a shortcut's configuration changing.
 *
 * Three actions share one event because a later reader is asking one question:
 * what was this shortcut pointed at, and when did that change. `outcome` is the
 * direction — a shortcut coming into existence or being re-aimed is `allowed`
 * and one going away is `denied` — the same sense `policy.site_rule` uses.
 *
 * What is deliberately absent: the display name, which is text a user typed;
 * the target's identity, which for a saved prompt *is* the objective; and the
 * narrowed tool list. `permissionMode` carries the floor a permission profile
 * imposes, because that is the only part of the configuration that changes what
 * a later run may do without asking. Everything else is in the shortcut record,
 * which this event points at by id.
 */
async function recordShortcutConfigured(
  shortcutId: string,
  code: 'CREATED' | 'RETARGETED' | 'REMOVED',
  record?: ShortcutRecord,
): Promise<void> {
  const profile = record?.permissionProfile;
  await auditLog
    .record({
      type: 'shortcut.configured',
      shortcutId,
      code,
      outcome: code === 'REMOVED' ? 'denied' : 'allowed',
      ...(profile === undefined ? {} : { permissionMode: SHORTCUT_PROFILE_MODE[profile] }),
    })
    .catch(() => undefined);
}

async function summariseShortcut(record: ShortcutRecord): Promise<ShortcutSummary> {
  const verdict = await shortcutResolver.resolveRecord(record);
  return {
    shortcutId: record.shortcutId,
    displayName: record.displayName,
    name: record.name,
    targetKind: record.target.kind,
    // A saved prompt has no external id to name: its target *is* its
    // objective, and the objective is not an identifier.
    targetId: targetIdOf(record.target),
    ...(record.target.kind === 'skill' ? { targetVersion: record.target.skillVersion } : {}),
    targetName: verdict.ok ? verdict.resolution.targetName : verdict.detail,
    usable: verdict.ok,
    createdAt: record.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Schedules (P-020)
// ---------------------------------------------------------------------------

/**
 * A clock attached to something that already exists.
 *
 * Everything below is scheduling and bookkeeping. Nothing here dispatches a
 * tool, evaluates policy or grants anything: a firing resolves a reference
 * and hands it to `workflowReplayer` or `skillLauncher`, which are the same
 * routes a person reaches from the panel, and every action inside that run
 * goes through the same policy and permission engines as any other.
 */
const scheduleStore = new ScheduleStore({
  area: new NamespacedStorageArea(local, 'schedules'),
  health: persistenceHealth,
});

/**
 * The name Chrome knows the schedule alarm by.
 *
 * One alarm for every schedule, not one each. Chrome delivers alarms
 * independently and caps how many an extension may hold; a single "wake me at
 * the next interesting moment" alarm is inside every quota, and because each
 * wake-up reconciles *every* schedule, a delayed or dropped alarm costs a
 * delay rather than a lost schedule.
 */
const SCHEDULE_ALARM = 'aba.schedules';

/**
 * Resolves what a schedule points at, at the moment it fires.
 *
 * A shortcut is resolved through the shortcut store and resolver, so
 * retargeting or deleting the shortcut changes or stops the schedule. A
 * workflow or a skill is looked up in the store and registry that own it.
 * Nothing is trusted from creation time.
 */
async function resolveScheduleTarget(target: ScheduleTarget): Promise<TargetResolution> {
  if (target.kind === 'shortcut') {
    const record = await shortcutStore.get(target.shortcutId);
    if (!record) {
      return {
        ok: false,
        reason: 'TARGET_MISSING',
        detail: 'The shortcut this schedule points at has been deleted.',
      };
    }
    const verdict = await shortcutResolver.resolveRecord(record);
    if (!verdict.ok) {
      return {
        ok: false,
        reason: verdict.reason === 'TARGET_MISSING' ? 'TARGET_MISSING' : 'TARGET_UNUSABLE',
        detail: verdict.detail,
      };
    }
    return resolveScheduleTarget(
      verdict.resolution.targetKind === 'workflow'
        ? { kind: 'workflow', workflowId: verdict.resolution.targetId }
        : {
            kind: 'skill',
            skillId: verdict.resolution.targetId,
            skillVersion: verdict.resolution.targetVersion ?? '',
          },
    );
  }

  if (target.kind === 'workflow') {
    const record = await workflowStore.get(target.workflowId);
    if (!record) {
      return {
        ok: false,
        reason: 'TARGET_MISSING',
        detail: 'The workflow this schedule points at has been deleted.',
      };
    }
    if (isIncomplete(record)) {
      return {
        ok: false,
        reason: 'TARGET_UNUSABLE',
        detail: 'That recording is incomplete and cannot be replayed.',
      };
    }
    // A run nobody is watching cannot answer a question, so a workflow that
    // asks for a value at replay time is refused before it starts rather than
    // failing partway through. This is also what keeps a schedule from ever
    // needing somewhere to store an answer.
    if (record.definition.inputs.some((input) => input.required)) {
      return {
        ok: false,
        reason: 'INPUTS_REQUIRED',
        detail: 'That workflow asks for values when it runs, so it cannot run unattended.',
      };
    }
    return { ok: true, kind: 'workflow', workflowId: record.workflowId };
  }

  const entry = skillRegistry.get(target.skillId, target.skillVersion);
  if (!entry) {
    return {
      ok: false,
      reason: 'TARGET_MISSING',
      detail: 'That workflow is not available in this version of the extension.',
    };
  }
  if (entry.definition.inputs.some((input) => input.required)) {
    return {
      ok: false,
      reason: 'INPUTS_REQUIRED',
      detail: 'That workflow asks for values when it runs, so it cannot run unattended.',
    };
  }
  return {
    ok: true,
    kind: 'skill',
    skillId: entry.definition.id,
    skillVersion: entry.definition.version,
  };
}

/** Maps a replay or launch outcome onto what the scheduler records. */
function asScheduledExecution(outcome: {
  ok: boolean;
  taskId?: string;
  status?: string;
  reason?: string;
  detail?: string;
  /** The step outcomes, read only for the refusal code the dispatch path set. */
  steps?: readonly { error?: { code: string } }[];
}): ScheduledExecution {
  if (!outcome.ok || outcome.taskId === undefined) {
    return {
      ok: false,
      reason: outcome.reason === 'INPUTS_INVALID' ? 'INPUTS_REQUIRED' : 'TARGET_UNUSABLE',
      detail: outcome.detail ?? 'The run could not start.',
    };
  }
  const status = outcome.status;
  const refusal = firstRefusal(outcome.steps ?? []);
  return {
    ok: true,
    taskId: outcome.taskId,
    status:
      status === 'completed' || status === 'cancelled' || status === 'refused' ? status : 'failed',
    ...(refusal === undefined ? {} : { refusal }),
  };
}

/**
 * The first step refusal, as the dispatch path coded it.
 *
 * `POLICY_BLOCKED` means the action was not permitted at all;
 * `PERMISSION_DENIED` means it needed somebody to approve it. Nothing else is
 * read from a step: not its message, not its result, not its arguments.
 */
function firstRefusal(
  steps: readonly { error?: { code: string } }[],
): 'POLICY_BLOCKED' | 'PERMISSION_DENIED' | undefined {
  for (const step of steps) {
    if (step.error?.code === 'POLICY_BLOCKED') return 'POLICY_BLOCKED';
    if (step.error?.code === 'PERMISSION_DENIED') return 'PERMISSION_DENIED';
  }
  return undefined;
}

const scheduleRunner = new ScheduleRunner({
  store: scheduleStore,
  health: persistenceHealth,
  resolveTarget: resolveScheduleTarget,
  runWorkflow: async ({ workflowId, sessionId }) => {
    const outcome = await workflowReplayer.replay({ workflowId, sessionId, inputs: {} });
    return asScheduledExecution(
      outcome.ok
        ? {
            ok: true,
            taskId: outcome.taskId,
            status: outcome.result.status,
            steps: outcome.result.steps,
          }
        : { ok: false, reason: outcome.reason, detail: outcome.detail },
    );
  },
  runSkill: async ({ skillId, skillVersion, sessionId }) => {
    const outcome = await skillLauncher.launch({ skillId, skillVersion, sessionId, inputs: {} });
    return asScheduledExecution(
      outcome.ok
        ? {
            ok: true,
            taskId: outcome.taskId,
            status: outcome.result.status,
            steps: outcome.result.steps,
          }
        : { ok: false, reason: outcome.reason, detail: outcome.detail },
    );
  },
  cancelTask: (taskId) => workflowReplayer.cancel(taskId) || skillLauncher.cancel(taskId),
  audit: async (event) => {
    await auditLog.record({
      type: event.type,
      scheduleId: event.scheduleId,
      ...(event.runId === undefined ? {} : { runId: event.runId }),
      ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
      outcome: event.outcome,
      ...(event.code === undefined ? {} : { code: event.code }),
    });
  },
  notify: (event) => {
    switch (event.kind) {
      case 'started':
        void notifier.scheduleStarted(event.name);
        return;
      case 'completed':
        void notifier.scheduleCompleted(event.name);
        return;
      case 'failed':
        void notifier.scheduleFailed(event.name);
        return;
      case 'blocked':
        void notifier.scheduleBlocked(event.name, event.reason === 'CONFIRMATION_REQUIRED');
        return;
    }
  },
  setWakeUp: async (at) => {
    if (at === undefined) {
      await chrome.alarms.clear(SCHEDULE_ALARM);
      return;
    }
    // `when` rather than `periodInMinutes`: the cadence lives in the schedule
    // record, which is durable, and a repeating alarm would be a second copy
    // of it in a place that is not.
    await chrome.alarms.clear(SCHEDULE_ALARM);
    await chrome.alarms.create(SCHEDULE_ALARM, { when: Math.max(at, Date.now() + 1000) });
  },
  onChanged: () => {
    broadcastEvent({ type: 'schedules.changed' });
  },
});

/** A schedule as the panel sees it, with its target looked up now. */
async function summariseSchedule(record: ScheduleRecord): Promise<ScheduleSummary> {
  const resolution = await resolveScheduleTarget(record.target);
  return {
    scheduleId: record.scheduleId,
    displayName: record.displayName,
    target: record.target,
    cadence: record.cadence,
    cadenceDescription: describeCadence(record.cadence),
    enabled: record.enabled,
    nextRunAt: record.nextRunAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.lastRunAt === undefined ? {} : { lastRunAt: record.lastRunAt }),
    ...(record.lastRunStatus === undefined ? {} : { lastRunStatus: record.lastRunStatus }),
    ...(record.lastRunReason === undefined ? {} : { lastRunReason: record.lastRunReason }),
    targetUsable: resolution.ok,
    targetName: resolution.ok
      ? resolution.kind === 'workflow'
        ? ((await workflowStore.get(resolution.workflowId))?.name ?? 'Workflow')
        : (skillRegistry.get(resolution.skillId, resolution.skillVersion)?.definition.name ??
          'Workflow')
      : resolution.detail,
  };
}

function summariseScheduleRun(record: ScheduleRunRecord): ScheduleRunSummary {
  return {
    runId: record.runId,
    scheduleId: record.scheduleId,
    occurrenceAt: record.occurrenceAt,
    startedAt: record.startedAt,
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    status: record.status,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
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
/**
 * The one place "this provider is no longer usable" becomes a recorded fact.
 *
 * Specification §53 lists a "provider disconnected" notification, and nothing
 * could raise it: an account only ever became `disconnected` during
 * cloud-metadata restore, which is a backend path, and a credential the
 * provider rejected surfaced as a task error. So the status was unreachable and
 * the notification was an orphan.
 *
 * It lives in the worker rather than in any adapter, for the reason Wave 10
 * settled and this wave has not changed: an adapter reports what one HTTP call
 * did, while whether the brain is connected is a fact about the installation.
 * Every provider reaches this identically because none of them knows it exists.
 *
 * Two things happen together on purpose. The account's stored status is written
 * so the panel agrees with the toast — a notification saying "disconnected"
 * over a Settings page still showing "connected" is worse than neither — and
 * only then is the user told. The status write is what makes this more than a
 * message.
 *
 * `statusReason` carries the provider's own wording because Settings is inside
 * the extension and the user needs to know whether the key was revoked or the
 * endpoint refused them. The *notification* carries neither: see
 * `Notifier.providerDisconnected`.
 */
/**
 * Records that a selection became stale, or stopped being so.
 *
 * A state change worth reading back: the model a task would have used stopped
 * existing, and the build refused rather than substituting. Counts and the
 * verdict only — the model id is already a recordable field, so it is named,
 * but no catalogue contents are.
 */
async function recordSelectionStaleness(
  providerId: string,
  modelId: string | null,
  stale: boolean,
): Promise<void> {
  await auditLog.record({
    type: 'provider.selected',
    // `denied` rather than a warning: the consequence of the verdict is that
    // the runtime will refuse to run on this selection.
    outcome: stale ? 'denied' : 'info',
    providerId,
    code: stale ? 'model_selection_stale' : 'model_selection_restored',
    ...(modelId === null || modelId.length === 0 ? {} : { modelId }),
  });
}

/**
 * Marks or clears an account's stale selection from a fresh catalogue.
 *
 * Only writes when the verdict changed, so an unchanged connection does not
 * churn storage or the trail on every refresh.
 */
async function reconcileSelection(
  account: ConnectedAccount,
  catalogue: { readonly models: readonly { readonly id: string }[] },
): Promise<void> {
  const state = modelSelectionState(
    account.modelId,
    catalogue.models.map((model) => model.id),
    // An empty list is how a failed discovery also returns, so it is treated as
    // "could not ask" rather than "offers nothing". `model-selection.ts` has
    // the reasoning: an endpoint that is down has not withdrawn a model.
    catalogue.models.length > 0,
  );
  const stale = state.kind === 'stale';
  if (stale === (account.modelStale === true)) return;
  await accountStore.put(accountAfterCatalogue(account, stale));
  await recordSelectionStaleness(account.providerId, account.modelId, stale);
}

/**
 * What the last successful discovery offered, per connection.
 *
 * Read by the selection routes so a model that no discovery offered does not
 * get its stale marker cleared. `offered-models.ts` carries the reasoning,
 * including the 9Router resolution rules that make an unrecognised slash-less
 * id the one shape a gateway answers by choosing an upstream itself.
 *
 * In memory: after a restart there is no entry, the verdict is `unknown`, and
 * nothing is asserted — which is correct, because an endpoint that has never
 * answered a discovery in this lifetime cannot serve a request either.
 */
const offeredModels = new OfferedModels();

/**
 * One discovery record, written by every route that discovers a catalogue.
 *
 * A function rather than two copies, and called before either route decides
 * what shape its answer takes. Both properties are the fix for the same
 * defect: the record used to be inline, after an early return that only a
 * gateway got past, so three providers in four discovered a catalogue and left
 * no trace of it.
 *
 * `providerId` is the caller's actual provider, so the trail names what was
 * really reached. Counts only, never model names or upstream aliases: those are
 * provider-authored text, and the trail records decisions rather than
 * catalogues. The credential is not a parameter here and cannot become one —
 * it never leaves the adapter's request headers.
 */
async function recordCatalogueDiscovered(
  providerId: string,
  discovered: number,
  refused: number,
): Promise<void> {
  await auditLog.record({
    type: 'provider.selected',
    outcome: 'info',
    providerId,
    code: 'catalogue_discovered',
    recordCount: discovered,
    ...(refused === 0 ? {} : { removedCount: refused }),
  });
}

async function noteProviderDisconnected(
  providerId: string,
  connectionId: string | undefined,
  reason: string,
): Promise<void> {
  if (connectionId !== undefined) {
    try {
      const account = await accountStore.get(connectionId);
      if (account && account.status !== 'disconnected') {
        await accountStore.put({ ...account, status: 'disconnected', statusReason: reason });
      }
    } catch (error) {
      // A status that could not be written must not stop the user being told.
      log.warn('Could not record the provider as disconnected.', {
        providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  void notifier.providerDisconnected(providerId);
}

async function resolveFromAccount(
  account: ConnectedAccount,
  options: { readonly allowStale?: boolean } = {},
): Promise<ResolvedProvider> {
  // The decision itself is `resolveBrainAccount`, which lives in
  // `@/providers/accounts/resolve-brain` so that the five refusals inside it
  // can be called by a test rather than only reached by driving a browser.
  // What stays here is the wiring that is genuinely the worker's: the
  // credential store, the provider registry, the selection-refusal wording,
  // and the one side effect — recording a rejected credential as a
  // disconnection, which is an audited write and not part of a resolution.
  try {
    return await resolveBrainAccount(
      account,
      {
        adapterFor: (providerId) => providerRegistry.get(providerId),
        // The whole task budget, not the moment: the adapter keeps this
        // credential for the length of the run, and a token that expires
        // partway through fails every turn after it with a 401 the task layer
        // treats as terminal. See `needsRefresh`.
        keyFor: (connectionId) =>
          connectionCredential(credentialKeyFor(connectionId), DEFAULT_BUDGET.maxDurationMs),
        staleMessage: (modelId) =>
          selectionRefusal({ kind: 'stale', modelId }) ??
          'The selected model is no longer available.',
      },
      options,
    );
  } catch (error) {
    if (error instanceof BrainUnavailable) {
      // Only a credential the provider actually refused is recorded as a
      // disconnection. The other refusals are the user's own configuration —
      // no model chosen, a stale selection, a key not on this device — and
      // marking the account disconnected for one of those would overwrite a
      // status nobody established.
      if (error.refusal === 'CREDENTIAL_REJECTED') {
        await noteProviderDisconnected(account.providerId, account.connectionId, error.message);
      }
      throw new ProviderUnavailable(error.message);
    }
    throw error;
  }
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
    // Two different situations, and they used to read as one. An installation
    // with no accounts has nothing to select; an installation with accounts
    // and no brain has a one-click fix. Telling the second user "no AI
    // provider is connected" sends them to connect an account they already
    // have — observed while writing the E2E case for a disconnected brain,
    // where exactly that message came back with another account connected.
    const connected = await accountStore.list();
    throw new ProviderUnavailable(
      connected.length > 0
        ? 'No AI account is selected. Open Settings and choose which connected account the ' +
            'agent should use.'
        : 'No AI provider is connected. Open Settings and connect a provider first.',
    );
  }

  if (connection.modelStale === true) {
    throw new ProviderUnavailable(
      selectionRefusal({ kind: 'stale', modelId: connection.modelId }) ??
        'The selected model is no longer available.',
    );
  }

  const adapter = providerRegistry.get(settings.activeProviderId);
  const config = await credentialStore.getConfig(settings.activeProviderId);
  const apiKey = await credentialStore.getApiKey(settings.activeProviderId);

  // The worker may have restarted since the provider was connected, so the
  // adapter instance is reconnected from stored configuration each time.
  // The pre-account slot holds one provider and one model, and
  // `connectionAfterSwitch` clears `capabilities` whenever either changes — so
  // a measurement present here was taken on this exact pair.
  const slotMeasured =
    connection.providerId === settings.activeProviderId &&
    connection.modelId === settings.activeModelId
      ? (connection.capabilities ?? null)
      : null;
  const auth = await adapter.connect({
    providerId: settings.activeProviderId,
    ...(config?.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(apiKey === undefined ? {} : { apiKey }),
    model: settings.activeModelId,
    ...(slotMeasured === null ? {} : { measuredCapabilities: slotMeasured }),
    ...(config?.organization === undefined ? {} : { organization: config.organization }),
    ...(config?.project === undefined ? {} : { project: config.project }),
  });
  if (!auth.authenticated) {
    const reason =
      auth.error?.userMessage ?? 'The connected provider rejected its stored credentials.';
    // No connectionId on this path: the pre-account settings slot has no
    // account record to mark, so the notification is all there is to give.
    await noteProviderDisconnected(settings.activeProviderId, undefined, reason);
    throw new ProviderUnavailable(reason);
  }

  return {
    adapter,
    capabilities: slotMeasured ?? UNKNOWN_CAPABILITIES,
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

      // And the debugger, for the same reason and in the same place. An
      // attachment made by `debugger.*` used to outlive the task that made it:
      // nothing detached on the way out, and the only two things that ever
      // detached were the tab closing and the worker shutting down. Chrome's
      // banner is the person's one signal that deep inspection is active, and a
      // banner standing over a page with no task behind it says something
      // untrue. Never awaited and never fatal: a task that finished stays
      // finished whether or not a detach succeeded.
      void debuggerManager.releaseTask(event.taskId);

      // Specification section 53, "task completed" and "task failed". Hooked
      // to the same one fact the line above is, and for the same reason:
      // "the task reached a terminal state" happens in one place, and
      // reproducing it at each exit is how one of them ends up missing.
      //
      // This is the browser-agent's task lifecycle, not any provider's. Every
      // provider reaches it identically because none of them knows it exists.
      //
      // Not awaited, and its failure is swallowed inside the notifier: a
      // toast is a supporting signal and never task authority, so a task that
      // finished stays finished whether or not anyone could be told.
      if (event.state !== undefined) void notifier.taskFinished(event.taskId, event.state);

      // §53's "provider disconnected", for the case `resolveProvider` cannot
      // see: a credential that was accepted at the start of the run and
      // revoked during it. `AUTH_EXPIRED` is what the provider layer reports
      // for `authentication_failed`, which it treats as terminal — a rejected
      // key is rejected on every retry — so it is the honest signal that the
      // brain is gone rather than briefly unreachable. A transient failure or
      // a rate limit is neither, and is deliberately not treated as one.
      if (event.errorCode === 'AUTH_EXPIRED' && event.providerId !== undefined) {
        void notifier.providerDisconnected(event.providerId);
      }
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
  new AgentRuntime({
    registry: toolRegistry,
    callbacks: taskManager.createCallbacks(),
    // Read before each provider request, which is where the page has the most
    // time to move without the agent noticing.
    resolveTabUrl,
  }),
);

const lifecycle = new LifecycleManager({ store: taskStore, debuggerManager, fieldObservations });

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

router.on('task.create', async ({ objective, authorizationModel, shortcutId }) => {
  const session = await getOrCreateSession();

  /*
   * Read before the task is made, because a shortcut's `allowedTools` and
   * `permissionProfile` are fixed at creation and cannot be applied afterwards.
   *
   * The **stored record** is the authority for its own constraint, and the
   * panel only names which shortcut it is launching. A route that took the
   * narrowing as a parameter would let any caller invent one — harmless in
   * itself, since a narrowing only removes, but it would no longer be *this
   * shortcut's* constraint, and a restricted shortcut would be one the panel
   * had to remember to restrict.
   */
  const shortcut =
    shortcutId === undefined
      ? undefined
      : await shortcutStore.get(shortcutId).catch(() => undefined);

  const task = await taskManager.create(objective, session.id, {
    ...(authorizationModel === undefined ? {} : { authorizationModel }),
    ...(shortcut?.allowedTools === undefined ? {} : { allowedTools: shortcut.allowedTools }),
    ...(shortcut?.permissionProfile === undefined
      ? {}
      : { permissionFloor: SHORTCUT_PROFILE_MODE[shortcut.permissionProfile] }),
  });

  // Recorded only for a shortcut that really is stored: a record naming a
  // shortcut nobody created would be a trail asserting a provenance it cannot
  // support. A failure to record it never fails the task — it already started.
  if (shortcut) {
    await auditLog
      .record({
        type: 'shortcut.launched',
        taskId: task.id,
        shortcutId: shortcut.shortcutId,
        code: shortcut.target.kind,
        outcome: 'info',
      })
      .catch(() => undefined);
  }

  return { task };
});

/**
 * The single producer of a `PlanApproval`.
 *
 * One route, one call, one class. `MessageRouter` has already established that
 * this message came from the side-panel document before the handler runs, so
 * the approval below is created only for a sender that could not be a page, a
 * content script, a connector, a skill or the model.
 */
router.on('plan.approve', async ({ taskId }) => {
  const task = await taskManager.approvePlanFor(taskId);
  // One record per site, written after the approval landed. A record for an
  // approval that failed to persist would be a trail claiming an authorization
  // the task does not have.
  const sites = task.planApproval?.approvedSites ?? [];
  for (const site of sites.length > 0 ? sites : [null]) {
    await auditLog
      .record({
        type: 'plan.approved',
        taskId,
        ...(site === null ? {} : { site }),
        outcome: 'allowed',
        code: `v${task.planApproval?.version ?? 1}`,
      })
      .catch(() => undefined);
  }
  return { task };
});

router.on('plan.revise', async ({ taskId, note }) => {
  const task = await taskManager.revisePlan(taskId, note);
  // The note itself is not recorded. It is free text a person typed, and this
  // trail holds no free text — that the proposal was sent back is the fact
  // worth keeping.
  await auditLog.record({ type: 'plan.revised', taskId, outcome: 'info' }).catch(() => undefined);
  return { task };
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
  // Nor its debugging banner over a page the person goes on browsing. The
  // lifecycle observer covers completing and failing; cancelling from the panel
  // does not reach it until the manager reports the state, and the banner should
  // go the moment the person said stop.
  void debuggerManager.releaseTask(taskId);
  return { state: await taskManager.cancel(taskId) };
});

router.on('task.retry', async ({ taskId }) => ({ task: await taskManager.retry(taskId) }));

router.on('session.get', async () => ({ session: await getOrCreateSession() }));

router.on('session.setPermissionMode', async ({ mode }) => {
  const before = (await settingsStore.get()).permissionMode;
  await settingsStore.update({ permissionMode: mode });
  const session = await updateSession({ permissionMode: mode });

  // Recorded after the write, so the trail never claims a mode that did not
  // take. `outcome` is the direction rather than a verdict: moving to a
  // stricter mode is `allowed` and moving to a looser one is `denied`, in the
  // same sense `policy.site_rule` uses those words for a grant and a
  // revocation — the record says which way the authority went.
  if (before !== mode) {
    await auditLog
      .record({
        type: 'session.permission_mode',
        permissionMode: mode,
        outcome: strictestMode(before, mode) === mode ? 'allowed' : 'denied',
        code: `FROM_${before.toUpperCase()}`,
      })
      .catch(() => undefined);
  }

  return { session };
});

router.on('settings.getNotificationsEnabled', async () => ({
  enabled: (await settingsStore.get()).notificationsEnabled,
}));

router.on('settings.setNotificationsEnabled', async ({ enabled }) => {
  await settingsStore.update({ notificationsEnabled: enabled });
  return { enabled };
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
  // A disconnect is announced once per worker generation, so reconnecting has
  // to forget it — otherwise a second, genuine disconnect hours later would be
  // silent, and that is news.
  notifier.providerReconnected(request.providerId);
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
  // One shared path for every provider, which is also where the discovery
  // event is recorded. See `discovery.ts` for why it is not inline here.
  const catalogue = await discoverCatalogue(
    providerRegistry.get(providerId),
    providerId,
    recordCatalogueDiscovered,
  );
  // And the pre-account slot gets the same reconciliation the accounts route
  // gives an account: a selection the provider no longer offers is marked, not
  // repaired.
  // Remembered so a later *selection* can be checked against it. Only a
  // non-empty answer counts: an empty list is how a failed discovery returns
  // too, and recording that would read as "this provider offers nothing".
  offeredModels.record(
    providerId,
    undefined,
    catalogue.models.map((model) => model.id),
  );
  const connection = await settingsStore.getConnection();
  if (connection && connection.providerId === providerId) {
    const state = modelSelectionState(
      connection.modelId,
      catalogue.models.map((model) => model.id),
      catalogue.models.length > 0,
    );
    const stale = state.kind === 'stale';
    if (stale !== (connection.modelStale === true)) {
      const { modelStale: _previous, ...rest } = connection;
      await settingsStore.setConnection(stale ? { ...rest, modelStale: true } : rest);
      await recordSelectionStaleness(providerId, connection.modelId, stale);
    }
  }
  return catalogue;
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
      ...doctorVerdict(report),
    };
    await settingsStore.setConnection(connection);
    broadcastEvent({ type: 'provider.statusChanged', connection });
  }
  return { report };
});

router.on('provider.setActive', async ({ providerId, modelId, upstreamKey }) => {
  providerRegistry.setActive(providerId);
  await settingsStore.update({ activeProviderId: providerId, activeModelId: modelId });
  await updateSession({ providerId, modelId });

  const existing = (await settingsStore.getConnection()) ?? null;
  const switched = isProviderSwitch(existing, providerId, modelId);

  // A capability measurement belongs to the pair it was measured on. See
  // `provider-switch.ts` for why this is a function rather than a spread.
  const base = connectionAfterSwitch(existing, providerId, modelId, () => ({
    providerId,
    modelId,
    authKind: providerRegistry.get(providerId).authKind,
    createdAt: Date.now(),
    status: 'connected',
  }));
  // The group is remembered so the three-level selection restores, and dropped
  // when the caller names none — a stale group from a previous provider would
  // point the UI at a level that no longer exists. It never affects which model
  // is sent: that is `modelId`, exactly as the catalogue gave it.
  const grouped =
    upstreamKey === undefined
      ? (Object.fromEntries(
          Object.entries(base).filter(([field]) => field !== 'upstreamKey'),
        ) as typeof base)
      : { ...base, upstreamKey };
  // And the stale marker is dropped, for the same reason
  // `accountAfterSelection` drops it: the user chose this model from a list
  // this build had just discovered, so keeping the flag would refuse a model
  // that is demonstrably on offer. Dropped rather than set to `false` —
  // presence of the field is the state.
  const { modelStale: _chosenAfresh, ...cleared } = grouped;
  // Same rule as `accounts.setBrain`: a model that no discovery offered does
  // not get its marker cleared.
  const connection =
    offeredModels.wasOffered(modelId, providerId) === 'not-offered'
      ? { ...cleared, modelStale: true as const }
      : cleared;
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
router.on('mcp.list', async () => {
  const servers = await mcpServers.list();
  return {
    servers: servers.map((server) => {
      const outcome = mcpOutcomes.get(server.id);
      return {
        id: server.id,
        displayName: server.displayName,
        url: server.url,
        ...(outcome === undefined
          ? {}
          : {
              outcome: {
                registered: outcome.registered,
                refused: outcome.refused.map((entry) => ({
                  name: entry.name,
                  reason: entry.reason,
                })),
                resourceCount: outcome.resourceCount,
                refusedResources: outcome.refusedResources.map((entry) => ({
                  uri: entry.uri,
                  reason: entry.reason,
                })),
                ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
              },
            }),
      };
    }),
  };
});

router.on('mcp.add', async (request) => {
  try {
    const added = await mcpServers.add(request);
    // Registered immediately, so the user sees what the server actually offered
    // rather than a row that claims nothing until the next worker start. The
    // whole set is re-read rather than only the new server, because that is the
    // one code path and a second "just this one" path would drift from it.
    const outcomes = await refreshMcpServers();
    const mine = outcomes.find((outcome) => outcome.serverId === added.id);
    await auditLog.record({
      type: 'mcp.server.added',
      outcome: 'allowed',
      code: 'ADDED',
      destination: added.url,
    });
    return {
      added: true as const,
      registered: mine?.registered ?? [],
      refused: mine?.refused.map((entry) => ({ name: entry.name, reason: entry.reason })) ?? [],
      resourceCount: mine?.resourceCount ?? 0,
    };
  } catch (caught) {
    // The validator's own sentences, so the panel can say which part was wrong.
    // Nothing from a server reaches here: adding one contacts nothing.
    if (caught instanceof McpServerError) {
      return { added: false as const, reason: caught.reason, problems: caught.problems };
    }
    throw caught;
  }
});

router.on('mcp.remove', async (request) => {
  try {
    await mcpServers.remove(request.id);
  } catch (caught) {
    if (caught instanceof McpServerError) return { removed: false, unregistered: [] };
    throw caught;
  }
  // Its tools go with it. There is no grant to revoke, because nothing could
  // have pre-approved an R3 tool — see docs/MCP_GUIDE.md §5.3.
  const unregistered = unregisterServer(toolRegistry, request.id);
  mcpOutcomes.delete(request.id);
  await auditLog.record({
    type: 'mcp.server.removed',
    outcome: 'denied',
    code: 'REMOVED',
  });
  return { removed: true, unregistered };
});

router.on('mcp.refresh', async () => {
  const outcomes = await refreshMcpServers();
  return {
    servers: outcomes.map((outcome) => ({
      id: outcome.serverId,
      registered: outcome.registered,
      refused: outcome.refused.map((entry) => ({ name: entry.name, reason: entry.reason })),
      ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
    })),
  };
});

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
      // An `oauth2` connector needs a client id this deployment does not have.
      // An `api_token` connector needs nothing from the deployment at all —
      // the user creates the token in their own account — so it is always
      // connectable, and the panel offers the field rather than an explanation.
      configured:
        descriptor.authKind === 'api_token' ||
        (CONNECTOR_CLIENT_IDS[descriptor.id] ?? '').length > 0,
      ...(descriptor.authKind === 'api_token' && CONNECTOR_TOKEN_HINTS[descriptor.id]
        ? { tokenHint: CONNECTOR_TOKEN_HINTS[descriptor.id]! }
        : {}),
      // So the panel knows to ask for a site. A label and an example, never a
      // default: nothing here decides where a credential goes.
      ...(descriptor.siteBinding === undefined
        ? {}
        : {
            siteBinding: {
              label: descriptor.siteBinding.label,
              example: descriptor.siteBinding.example,
              hostSuffix: descriptor.siteBinding.hostSuffix,
            },
          }),
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
  if (connector.descriptor.authKind !== 'oauth2') {
    // This connector does not authenticate with a flow. Saying so is better
    // than starting one: an earlier revision implied the only thing missing
    // was a registration, and for GitHub, Atlassian and Figma that is false —
    // every one of them requires a client secret in the code exchange, which
    // this extension must not hold. `docs/connectors.md` has the table.
    throw new RouteError(
      createError(
        'NOT_IMPLEMENTED',
        `${connector.descriptor.displayName} does not use an authorization flow in this build.`,
        {
          userMessage:
            `${connector.descriptor.displayName} is connected with a token you create in your ` +
            'own account, not with a sign-in flow. Paste one in Settings.',
        },
      ),
    );
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

router.on('connector.connectToken', async ({ connectorId, token, site, account }) => {
  const connector = connectorRegistry.get(connectorId);
  if (!connector) {
    throw new RouteError(createError('INVALID_ARGUMENT', `Unknown connector "${connectorId}".`));
  }
  if (connector.descriptor.authKind !== 'api_token') {
    throw new RouteError(
      createError(
        'INVALID_ARGUMENT',
        `${connector.descriptor.displayName} does not accept a supplied token.`,
      ),
    );
  }

  const supplied = token.trim();
  if (supplied.length === 0) {
    throw new RouteError(
      createError('INVALID_ARGUMENT', 'No token was supplied.', {
        userMessage: 'Paste the token before connecting.',
      }),
    );
  }

  // Recorded before the attempt and without the token. The audit trail says a
  // connection was attempted, never what was attempted with.
  await auditLog.record({
    type: 'connector.auth',
    connectorId,
    outcome: 'info',
    code: 'token_supplied',
  });

  // Which session owns this connector, and what scheme its credential header
  // carries. A table rather than a chain of ifs, so adding a connector is one
  // entry and a connector with no entry is refused above rather than silently
  // routed to the wrong session.
  const tokenSessions: Readonly<
    Record<
      string,
      {
        session: ConnectorSession;
        tokenType: string | null;
        /** Composes the credential from the parts the user supplied. */
        compose?: (token: string, account: string) => string;
        /** True when this connector cannot be connected without an account. */
        needsAccount?: boolean;
      }
    >
  > = {
    [githubDescriptorValue.id]: { session: githubSession, tokenType: 'Bearer' },
    // `null`, not `'Bearer'`: Figma reads `X-Figma-Token` and that header's
    // syntax is the token itself. A scheme prefix here would be an
    // unauthenticated request with the user's token attached to it.
    [figmaDescriptorValue.id]: { session: figmaSession, tokenType: null },
    // `Basic`, over base64(email:token). Composed here because this is the one
    // place that already holds both halves — a credential assembled in the
    // panel would exist in one more place than it needs to.
    [jiraDescriptorValue.id]: {
      session: jiraSession,
      tokenType: 'Basic',
      compose: jiraBasicCredential,
      needsAccount: true,
    },
    // The same composition as Jira, because it is the same Atlassian
    // credential — and a separate session, because it is a separate record.
    [confluenceDescriptorValue.id]: {
      session: confluenceSession,
      tokenType: 'Basic',
      compose: jiraBasicCredential,
      needsAccount: true,
    },
  };

  const owner = tokenSessions[connectorId];
  if (!owner) {
    throw new RouteError(
      createError('INVALID_ARGUMENT', `No token session is wired for "${connectorId}".`, {
        userMessage: `${connector.descriptor.displayName} cannot be connected with a token.`,
      }),
    );
  }

  const suppliedAccount = (account ?? '').trim();
  if (owner.needsAccount === true && suppliedAccount.length === 0) {
    throw new RouteError(
      createError('INVALID_ARGUMENT', 'No account was supplied.', {
        userMessage: `${connector.descriptor.displayName} needs the account the token belongs to.`,
      }),
    );
  }
  if (owner.needsAccount !== true && suppliedAccount.length > 0) {
    // A value with nowhere to go. Refused rather than ignored, so a panel
    // sending one learns it is wrong instead of silently losing it.
    throw new RouteError(
      createError('INVALID_ARGUMENT', 'This connector does not take an account.', {
        userMessage: `${connector.descriptor.displayName} needs only a token.`,
      }),
    );
  }

  const outcome = await owner.session.connectWithToken({
    token: owner.compose === undefined ? supplied : owner.compose(supplied, suppliedAccount),
    tokenType: owner.tokenType,
    // Passed through raw. The session parses and validates it, and refuses a
    // site for a connector with no binding — so this route does not need to
    // know which connectors have one.
    ...(site === undefined ? {} : { site }),
  });

  const status = outcome.status;
  return {
    state: status.state,
    reason: status.reason,
    scopes: status.scopes,
    // Reported by the session rather than inferred from an empty list, because
    // "the service said this token has no permissions" and "the service would
    // not say" are both the empty list here and only the second is worth
    // explaining. Both refuse every write.
    scopesKnown: outcome.scopesEstablished,
    ...(status.accountLabel === undefined ? {} : { accountLabel: status.accountLabel }),
    ...(outcome.siteMessage === undefined ? {} : { siteMessage: outcome.siteMessage }),
  };
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
      const mediaType = safeMediaType(file.mimeType);
      await auditLog.record({
        type: 'file.selected',
        outcome: 'allowed',
        origin: 'local',
        fileName: safeDisplayName(file.name),
        ...(mediaType === undefined ? {} : { mimeType: mediaType }),
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
  read: (connectionId: string) => connectionCredential(connectionId),
  write: (connectionId: string, apiKey: string) =>
    credentialStore.setConnectionKey(connectionId, apiKey),
  clear: (connectionId: string) => credentialStore.clearConnectionKey(connectionId),
};

/**
 * Authorizing a Google account for the Gemini API.
 *
 * **Not a sign-in.** Nothing here creates a product account, a session or an
 * `abaUserId`, and nothing here is needed to open the extension or run a local
 * task. It produces one access token, bound to one connected account, exactly
 * as a pasted key is. `authController` is the separate, optional product
 * sign-in and the two share no state — see
 * `providers/oauth/google-provider-auth.ts` for why they must not.
 */
const googleProviderAuthConfig = loadGoogleProviderAuthConfig();

/** Salt for the authorization channel. Not a task, so not a task's salt. */
const providerAuthSalt = 'provider-authentication';

/**
 * One POST to a provider's token endpoint.
 *
 * Through the gate on its own channel, with an opaque payload policy, because
 * the body is a credential by construction: an authorization code, a PKCE
 * verifier, or a refresh token. `redirect: 'error'` for the reason the
 * connector exchange gives — a token endpoint that redirects is one that could
 * be made to carry an authorization code somewhere else.
 */
async function postProviderToken(
  providerId: string,
  endpoint: string,
  body: string,
): Promise<{ status: number; body: unknown }> {
  const response = await guardedSend(
    {
      url: endpoint,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      },
      destination: providerAuthDestination(providerId, endpoint, endpoint),
      taskId: 'provider-authentication',
      taintState: { kind: 'KNOWN_UNTAINTED' },
      taintSalt: providerAuthSalt,
      taintSignature: 'authentication',
      describe: 'AI account authorization',
      payloadPolicy: 'opaque',
    },
    { consent: consentStore },
  );
  // The status, never the body: a token endpoint's error response can echo the
  // authorization code back.
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

/** The Google authorization driver, or one that reports NOT_CONFIGURED. */
function googleProviderAuth(): GoogleProviderAuth {
  return new GoogleProviderAuth({
    clientId: googleProviderAuthConfig?.clientId ?? null,
    redirectUri: googleRedirectUri(chrome.runtime.id),
    // `launchWebAuthFlow`, which is the only thing that intercepts Google's
    // `chromiumapp.org` redirect. The connectors' tab-watching flow cannot,
    // and `web-auth-flow.ts` records why at length.
    authFlow: new WebAuthFlow(chrome.identity),
    post: (body) => postProviderToken(GEMINI_PROVIDER_ID, GOOGLE_AUTH.tokenEndpoint, body),
    // Optional permission, asked for at the moment the user presses the
    // button, and never otherwise.
    requestPermission: () => ensureIdentityPermission(chrome.permissions),
    now: () => Date.now(),
  });
}

/**
 * The credential for one connection, whatever shape it is in.
 *
 * The decision itself is `credentialForConnection`, which lives in
 * `@/providers/accounts/connection-credential` so that the rules inside it —
 * renew before use, never retry a refused renewal, let the caller's horizon
 * cause a renewal but never a refusal, fail to `undefined` rather than throw
 * — can be driven by a test rather than only reached by running a browser.
 * What stays here is the wiring that is genuinely the worker's: the credential
 * store and the Google driver.
 *
 * `mustOutlastMs` is how long the caller needs the credential to keep working.
 * Most callers make one request and leave it at zero. The brain resolution
 * does not: it hands the credential to an adapter that keeps it for the whole
 * run, so it asks for the task budget.
 */
function connectionCredential(
  connectionId: string,
  mustOutlastMs = 0,
): Promise<string | undefined> {
  return credentialForConnection(
    connectionId,
    {
      keyFor: (id) => credentialStore.getConnectionKey(id),
      tokensFor: (id) => credentialStore.getOAuthTokens(id),
      storeTokens: (id, tokens) => credentialStore.setOAuthTokens(id, tokens),
      needsRenewal: (tokens, horizon) => needsRefresh(tokens, Date.now(), horizon),
      /**
       * Records that an authorization can no longer produce a credential.
       *
       * Without this the panel keeps showing the account as `connected` while
       * every request refuses — the worker knew and the panel did not, which is
       * the state inconsistency worth preventing. The reason names the fix, and
       * it is the *account* status rather than a transient error because nothing
       * about it will improve on a retry.
       */
      onUnusable: async (id, why) => {
        const account = await accountStore.get(id);
        if (account === undefined || account.authKind !== 'oauth2') return;
        if (account.status === 'disconnected') return;
        await accountStore.put({ ...account, status: 'disconnected', statusReason: why });
        await broadcastAccounts();
      },
      renew: async (refreshToken) => {
        const renewed = await googleProviderAuth().refresh(refreshToken);
        if (!renewed.ok) return { ok: false };
        return {
          ok: true,
          tokens: {
            accessToken: renewed.token.accessToken,
            expiresAt: renewed.token.expiresAt,
            ...(renewed.token.refreshToken === undefined
              ? {}
              : { refreshToken: renewed.token.refreshToken }),
            scope: renewed.token.scope,
          },
        };
      },
    },
    { mustOutlastMs },
  );
}

async function storeProviderToken(connectionId: string, token: GoogleProviderToken): Promise<void> {
  await credentialStore.setOAuthTokens(connectionId, {
    accessToken: token.accessToken,
    expiresAt: token.expiresAt,
    ...(token.refreshToken === undefined ? {} : { refreshToken: token.refreshToken }),
    scope: token.scope,
  });
}

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
    ...(account.upstreamKey === undefined ? {} : { upstreamKey: account.upstreamKey }),
    // So the panel can explain a selection it will not run, rather than
    // showing it as ordinary and letting the next task fail.
    ...(account.modelStale === undefined ? {} : { modelStale: account.modelStale }),
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
          // Linking runs the same tab flow sign-in does, through the same
          // port, with no new permission.
          identities: new IdentityClient({
            config: identityConfig,
            transport,
            sessions: sessionStore,
            authFlow: new TabAuthFlow(chromeTabs()),
          }),
        };
      })();

const authController = new AuthController({
  sessions: sessionStore,
  profile: identityProfile,
  google: identityClients?.google ?? null,
  email: identityClients?.email ?? null,
  identities: identityClients?.identities ?? null,
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
 * Authentication identities.
 *
 * None of these touches a provider connection, a provider credential, K1
 * material or any browser-agent record. Linking joins a way of signing in to
 * the account that is already signed in; it does not move data and does not
 * replace the session.
 */
router.on('identities.list', async () => authController.listIdentities());

router.on('identities.linkGoogle', async () => {
  const controller = new AbortController();
  return authController.linkGoogle(controller.signal);
});

router.on('identities.startEmailLink', async (request) =>
  authController.startEmailLink(request.email),
);

router.on('identities.completeEmailLink', async (request) =>
  authController.completeEmailLink(request.challengeId, request.code),
);

router.on('identities.detach', async (request) =>
  authController.unlinkIdentity(request.identityId),
);

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
  notifier.providerReconnected(request.providerId);

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

router.on('accounts.authMethods', async () => {
  // Read from one table so the panel, the worker and the documentation cannot
  // come to describe the same provider differently. `configured` for the
  // Google method depends on whether a client id was compiled into this
  // build, which is the only part that is not a constant.
  const providers = providerAuthorization({
    googleClientConfigured: googleProviderAuthConfig !== null,
  })
    // Only providers this build actually registers. A row for an adapter that
    // is not here would be an offer the user could not take.
    .filter((entry) => providerRegistry.has(entry.providerId));

  return {
    providers: providers.map((entry) => ({
      providerId: entry.providerId,
      displayName: entry.displayName,
      googleAuthorizable: entry.googleAuthorizable,
      modelDiscovery: entry.modelDiscovery,
      billing: entry.billing,
      methods: entry.methods.map((method) => ({
        kind: method.kind,
        label: method.label,
        requires: method.requires,
        ...(method.page === undefined ? {} : { page: method.page }),
        configured: method.configured,
        ...(method.unavailableReason === undefined
          ? {}
          : { unavailableReason: method.unavailableReason }),
      })),
      unavailable: entry.unavailable.map((entryUnavailable) => ({ ...entryUnavailable })),
    })),
    // Stated rather than left to inference. No vendor here offers an API that,
    // given a Google identity, returns the accounts that identity holds
    // elsewhere — so the panel says so where a user would expect otherwise.
    accountDiscoveryFromGoogleIdentity: false,
    identityPermissionGranted: await hasIdentityPermission(chrome.permissions),
  };
});

router.on('accounts.connectGoogle', async (request) => {
  if (googleProviderAuthConfig === null) {
    return {
      account: null,
      failure: 'NOT_CONFIGURED',
      error: createError(
        'INVALID_ARGUMENT',
        'No Google OAuth client id is configured in this build.',
        {
          userMessage:
            'This build cannot connect a Google account: it carries no Google OAuth client id. ' +
            'Paste a Gemini API key instead.',
          retryable: false,
        },
      ),
    };
  }
  // Exactly one provider, and the matrix is what says which. A request naming
  // another provider is not possible through this route by construction, and
  // the check is here so that stays true if the matrix ever changes.
  if (!isGoogleAuthorizable(GEMINI_PROVIDER_ID) || !providerRegistry.has(GEMINI_PROVIDER_ID)) {
    return {
      account: null,
      failure: 'NOT_CONFIGURED',
      error: createError('INVALID_ARGUMENT', 'No Google-authorizable provider is registered.'),
    };
  }

  /**
   * The account being re-authorized, when one was named.
   *
   * Checked **before** the authorization runs, so a request naming something
   * this route must not touch is refused without sending the user to Google
   * first. The two conditions are what stop a Google token being attached to
   * an account that was connected another way: it must be a Gemini account,
   * and it must already be an OAuth one.
   */
  let reconnecting: ConnectedAccount | undefined;
  if (request.reconnect !== undefined) {
    const existing = await accountStore.get(request.reconnect);
    if (
      existing === undefined ||
      existing.providerId !== GEMINI_PROVIDER_ID ||
      existing.authKind !== 'oauth2'
    ) {
      return {
        account: null,
        failure: 'NOT_RECONNECTABLE',
        error: createError('INVALID_ARGUMENT', 'That connection cannot be re-authorized.', {
          userMessage:
            'That account was not connected with Google, so it cannot be re-authorized this ' +
            'way. Disconnect it and connect again.',
          retryable: false,
        }),
      };
    }
    reconnecting = existing;
  }

  const controller = new AbortController();
  const authorized = await googleProviderAuth().authorize(controller.signal, request.loginHint);
  if (!authorized.ok) {
    // Recorded as an attempt, with the named refusal and no credential. A
    // declined consent screen is ordinary and is worth seeing in the trail.
    await auditLog.record({
      type: 'provider.selected',
      outcome: 'denied',
      providerId: GEMINI_PROVIDER_ID,
      code: `google_authorization_${authorized.failure.toLowerCase()}`,
    });
    return {
      account: null,
      failure: authorized.failure,
      error: createError(
        authorized.failure === 'NOT_CONFIGURED' ? 'INVALID_ARGUMENT' : 'AUTH_REQUIRED',
        'The Google authorization did not complete.',
        { userMessage: authorized.reason, retryable: authorized.failure !== 'DECLINED' },
      ),
    };
  }

  // The credential first, then the record — the ordering `accounts.connect`
  // establishes and for the same reason: a record whose credential never
  // landed is an account that fails at its first request with nothing to
  // explain why.
  //
  // Re-authorizing writes to the **same** connection id, which is what keeps
  // the user's model choice, their consent pin and their audit history
  // attached to the account they already had rather than stranding them on a
  // dead row beside a new one.
  const connectionId = reconnecting?.connectionId ?? accountStore.mintConnectionId();
  await storeProviderToken(connectionId, authorized.token);

  const account: ConnectedAccount = {
    connectionId,
    // Preserved on a re-authorization: the account's owner, its name and its
    // model are the user's, and an expiry is not a reason to reset them.
    abaUserId: reconnecting?.abaUserId ?? (await currentAbaUserId()),
    providerId: GEMINI_PROVIDER_ID,
    protocol: protocolForLegacyProvider(GEMINI_PROVIDER_ID),
    displayName: request.displayName?.trim() || reconnecting?.displayName || 'Google Gemini',
    // Never derived from the token. An access token's last four characters
    // are opaque and change on every refresh, so they identify nothing; what
    // identifies this account is that it was authorized with Google.
    accountLabel: 'authorized with Google',
    authKind: 'oauth2',
    // The project Google meters this account's calls against, from the build's
    // configuration and never from a message. Per connection, so a second
    // authorized account on another project cannot be billed against this one.
    ...(googleProviderAuthConfig.quotaProject === undefined
      ? {}
      : { quotaProject: googleProviderAuthConfig.quotaProject }),
    // No model yet. Discovery runs against the new credential and the user
    // chooses from what Google actually offers this account — a default here
    // would be this build asserting something about somebody else's catalogue.
    // On a re-authorization the model is kept: the user chose it from a
    // catalogue this build had read, and a new token for the same account does
    // not make that choice wrong.
    modelId: reconnecting?.modelId ?? null,
    // The measurement does **not** survive, even on a re-authorization. It was
    // taken with a credential that no longer exists, and a capability carried
    // across a credential change is evidence about one thing read as a claim
    // about another.
    capabilities: null,
    capabilityScope: null,
    status: 'connected',
    // Said at connect time rather than discovered at the first failure an hour
    // later. Google issues no refresh token when the user has consented to this
    // client before and the screen was skipped, and a connection that cannot
    // renew will stop working without explanation.
    ...(authorized.token.refreshToken === undefined
      ? {
          statusReason:
            'Google did not return a renewal token for this authorization, so it will need ' +
            'authorizing again when it expires.',
        }
      : {}),
    lastValidated: Date.now(),
    createdAt: Date.now(),
  };
  await accountStore.put(account);
  await auditLog.record({
    type: 'provider.selected',
    outcome: 'info',
    providerId: GEMINI_PROVIDER_ID,
    code:
      reconnecting === undefined
        ? 'account_authorized_with_google'
        : 'account_reauthorized_with_google',
  });

  // The first account becomes the one in use, exactly as on the key path.
  // Only when there is no brain: authorizing a second account must never
  // silently move the user off the one they chose.
  const abaUserId = await currentAbaUserId();
  if ((await accountStore.getBrain(abaUserId)) === null) {
    await accountStore.setBrain(abaUserId, connectionId, null);
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
  // `allowStale` because this is the route that *fixes* a stale selection: it
  // has to be able to discover a catalogue for a connection whose stored model
  // is the problem, or the user could never pick a new one.
  const resolved = await resolveFromAccount(
    { ...account, modelId: account.modelId ?? 'probe' },
    { allowStale: true },
  );
  // The same shared path, recording against this account's own provider.
  const catalogue = await discoverCatalogue(
    resolved.adapter,
    account.providerId,
    recordCatalogueDiscovered,
  );
  offeredModels.record(
    account.providerId,
    connectionId,
    catalogue.models.map((model) => model.id),
  );
  await reconcileSelection(account, catalogue);
  return catalogue;
});

router.on('accounts.runDoctor', async ({ connectionId, modelId, quick }) => {
  const account = await accountStore.get(connectionId);
  if (!account) throw new Error('That connection no longer exists.');

  const resolved = await resolveFromAccount({ ...account, modelId });
  const report = await capabilityDoctor.run(resolved.adapter, modelId, {
    ...(quick === undefined ? {} : { quick }),
  });

  // The measurement is stamped with the account and model it was taken on, so
  // nothing downstream can mistake it for evidence about another. The verdict
  // goes with it: `statusReason` is dropped first so a healthy run cannot leave
  // a previous failure's wording attached to a model that works.
  const { statusReason: _previous, ...base } = account;
  await accountStore.put({
    ...base,
    modelId,
    capabilities: report.capabilities,
    capabilityScope: { connectionId, modelId },
    lastValidated: report.generatedAt,
    ...doctorVerdict(report),
  });
  // The measurement the panel gates the composer on. Projected here rather
  // than left for the next brain change, because a capability check that
  // passes should light the composer up now.
  await projectBrainToSettings();
  await broadcastAccounts();
  return { report };
});

router.on('accounts.setBrain', async ({ connectionId, modelId, upstreamKey }) => {
  const abaUserId = await currentAbaUserId();
  const existing = await accountStore.get(connectionId);
  if (!existing) {
    throw new Error('That connection no longer exists.');
  }

  // A measurement survives only when both the account and the model are the
  // ones it was taken on — the same rule `connectionAfterSwitch` established
  // for the single-slot world, extended to the account dimension.
  const selected = accountAfterSelection(existing, modelId);
  // The group is remembered for the selection UI and dropped when none is named,
  // so a stale group cannot outlive the provider it belonged to. It is never an
  // input to which model is sent.
  const grouped: typeof selected =
    upstreamKey === undefined
      ? (Object.fromEntries(
          Object.entries(selected).filter(([field]) => field !== 'upstreamKey'),
        ) as typeof selected)
      : { ...selected, upstreamKey };
  // The stale marker is cleared only when a discovery actually offered this
  // model — see `accountAfterOfferedSelection` for why the text-box path makes
  // that conditional rather than automatic.
  const updated = accountAfterOfferedSelection(
    grouped,
    modelId,
    offeredModels.wasOffered(modelId, existing.providerId, connectionId),
  );
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

/**
 * Records a change to local encryption.
 *
 * One type for all five actions, because a reader is asking one question of
 * them: was the material in this profile protected, and when did that change.
 * `outcome` is the direction — switching on, unlocking and changing the
 * passphrase are `allowed`; switching off and locking are `denied`; a refused
 * unlock is `failed` — and the code says which action it was.
 */
async function recordK1(code: string, outcome: 'allowed' | 'denied' | 'failed'): Promise<void> {
  await auditLog.record({ type: 'k1.protection', code, outcome }).catch(() => undefined);
}

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
    await recordK1('ENABLED', 'allowed');
    return { ok: true as const, state: status.state, encrypted: outcome.encrypted };
  } catch (error) {
    await recordK1('ENABLE_FAILED', 'failed');
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
    await recordK1('UNLOCKED', 'allowed');
    return { ok: true as const, state: status.state };
  } catch (error) {
    // The reason is the closed `UnlockFailure` vocabulary, never anything
    // derived from what was typed.
    await recordK1(error instanceof UnlockError ? error.failure : 'UNLOCK_FAILED', 'failed');
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
  await recordK1('LOCKED', 'denied');
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
    await recordK1('PASSPHRASE_CHANGED', 'allowed');
    return { ok: true as const };
  } catch (error) {
    await recordK1(
      error instanceof UnlockError ? `CHANGE_${error.failure}` : 'CHANGE_FAILED',
      'failed',
    );
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
    // The action this type most exists for. Recorded after the protection is
    // actually off, so the trail never claims a state that did not take.
    await recordK1('DISABLED', 'denied');
    return { ok: true as const, state: 'OFF' as const };
  } catch (error) {
    await recordK1(
      error instanceof UnlockError ? `DISABLE_${error.failure}` : 'DISABLE_FAILED',
      'failed',
    );
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
  // Read back rather than echoed: the preference decides what it accepted, and
  // the trail records where records are actually kept.
  const chosen = await dataStoragePreference.mode();
  await auditLog
    .record({ type: 'storage.preference', storageMode: chosen, outcome: 'info' })
    .catch(() => undefined);
  return { mode: chosen };
});

/**
 * Builds the export document the panel writes to a file the user chose.
 *
 * Reads only stores whose data classification permits it. No credential is
 * read here — not the provider key, not a connector token, not the ABA
 * refresh token — because none of them is reachable from these four calls.
 */
router.on('data.export', async () => {
  const document = await buildLocalExport(
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
  );

  // Counted from the document that was actually built, not from the stores it
  // read: the export's own allowlist decides what survives, and the number a
  // later reader cares about is how much left.
  await auditLog
    .record({
      type: 'data.exported',
      code: 'LOCAL_RECORDS',
      recordCount: document.workflows.length + document.shortcuts.length,
      outcome: 'info',
    })
    .catch(() => undefined);

  return { export: document };
});

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

      // Both narrowings are carried across, and both are re-validated rather
      // than trusted. Dropping them — which is what happened until this was
      // audited — silently widened a shortcut on a round trip: a person exports
      // one restricted to `browser.read_page` under `confirm-each-action`,
      // imports it on another machine, and gets one that may use every tool at
      // whatever mode is in force, under the same name they had learned to
      // trust. A narrowing can only ever make a run stricter, so carrying it
      // from an untrusted file cannot raise privilege; dropping it could, and
      // did.
      //
      // Re-validated because a file can name a tool that does not exist or a
      // profile this build does not implement, and a stored profile nobody
      // implements would leave a shortcut reading as stricter than it is.
      // Either is a refusal of the record, exactly as it is on the create
      // route — never a quiet fall back to no constraint.
      const narrowing = normaliseAllowedTools(candidate.allowedTools);
      if (!narrowing.ok) return 'REFUSED';
      const profile = candidate.permissionProfile;
      if (profile !== undefined && !isShortcutPermissionProfile(profile)) return 'REFUSED';

      try {
        // `create` re-runs name normalisation and both collision checks, so an
        // imported shortcut cannot take a name that already means something.
        await shortcutStore.create(candidate.displayName, candidate.target, {
          allowedTools: narrowing.tools,
          ...(profile === undefined ? {} : { permissionProfile: profile }),
        });
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

  // One record for the whole import rather than one per record: an import is a
  // single decision a person took about a single file, and a per-record trail
  // would be a copy of the file's table of contents. `outcome` is `failed` when
  // any write did not land, so a partially applied import is visible as one
  // even though the route returns `ok` with counts.
  const imported = outcome.workflowsImported + outcome.shortcutsImported;
  await auditLog
    .record({
      type: 'data.imported',
      code: `REFUSED_${outcome.workflowsRefused + outcome.shortcutsRefused}`,
      recordCount: imported,
      outcome: outcome.failed > 0 ? 'failed' : 'allowed',
    })
    .catch(() => undefined);

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
  const before = await loadSitePolicy();
  const next = removeRule(before, site);
  await saveSitePolicy(next);
  // Only when something was actually removed. Recording a revocation for a
  // site that held no rule would put a decision nobody took into the trail,
  // which is the same failure as omitting one that they did.
  if (next.rules.length !== before.rules.length) {
    await auditLog
      .record({ type: 'policy.site_rule', site, outcome: 'denied', code: 'SITE_RULE_REVOKED' })
      .catch(() => undefined);
  }
  return { state: next };
});

router.on(
  'audit.list',
  async (query) =>
    await auditLog.page({
      // Every correlation the record carries, not just the two the route
      // started with. Spread field by field rather than passing the request
      // through, so a field added to the request cannot reach the store
      // without somebody deciding it should.
      ...(query.taskId === undefined ? {} : { taskId: query.taskId }),
      ...(query.site === undefined ? {} : { site: query.site }),
      ...(query.workflowId === undefined ? {} : { workflowId: query.workflowId }),
      ...(query.skillId === undefined ? {} : { skillId: query.skillId }),
      ...(query.shortcutId === undefined ? {} : { shortcutId: query.shortcutId }),
      ...(query.scheduleId === undefined ? {} : { scheduleId: query.scheduleId }),
      ...(query.runId === undefined ? {} : { runId: query.runId }),
      ...(query.connectorId === undefined ? {} : { connectorId: query.connectorId }),
      ...(query.offset === undefined ? {} : { offset: query.offset }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
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
  const document = buildAuditExport(
    page.events,
    Date.now(),
    chosen,
    await auditLog.verifyIntegrity(),
  );

  // The trail records its own export. The record is appended after the document
  // is built, so it is never inside the page it describes — an export that
  // contained the record of itself would be reporting a count that includes a
  // record written by the act of counting.
  await auditLog
    .record({
      type: 'data.exported',
      code: 'AUDIT_TRAIL',
      recordCount: page.events.length,
      outcome: 'info',
    })
    .catch(() => undefined);

  return { export: document };
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
    // The settings surface, so it shows switched-off skills too — there is no
    // other way to offer turning one back on. `skills.list`, the tool the
    // model sees, goes through `skillRegistry.list()` and shows only enabled.
    skills: skillRegistry.listIncludingDisabled().map(({ entry, enabled }) => ({
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
      enabled,
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
    steps: summary.steps.map((step) => ({ ...step })),
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
  // The counterpart to `workflow.recorded`. A schedule already recorded its own
  // deletion and a workflow did not, which left a shortcut that stopped
  // resolving with nothing in the trail to explain why.
  await auditLog
    .record({ type: 'workflow.removed', workflowId, outcome: 'denied', code: 'REMOVED' })
    .catch(() => undefined);
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

router.on('shortcut.create', async ({ name, target, allowedTools, permissionProfile }) => {
  // Checked at creation so a user is not allowed to name something that is
  // already broken. It is checked again at every resolution, because a target
  // that exists now can be deleted later.
  if (!(await shortcutResolver.targetIsUsable(target))) {
    return {
      shortcut: null,
      error: { reason: 'INVALID_TARGET', detail: 'That workflow is not available to run.' },
    };
  }

  // Both narrowings are validated here rather than in the store, because both
  // refusals are things the panel has to be able to tell the user about by
  // name — and neither is a storage concern.
  const narrowing = normaliseAllowedTools(allowedTools);
  if (!narrowing.ok) {
    return { shortcut: null, error: { reason: 'INVALID_ALLOWED_TOOLS', detail: narrowing.detail } };
  }
  if (permissionProfile !== undefined && !isShortcutPermissionProfile(permissionProfile)) {
    // Refused, never ignored. A stored profile nobody implements would leave a
    // shortcut that reads as stricter than it is.
    return {
      shortcut: null,
      error: {
        reason: 'UNKNOWN_PERMISSION_PROFILE',
        detail:
          `"${String(permissionProfile).slice(0, 40)}" is not a permission profile this ` +
          'extension implements. A profile may only make a run stricter.',
      },
    };
  }

  try {
    const created = await shortcutStore.create(name, target, {
      allowedTools: narrowing.tools,
      ...(permissionProfile === undefined ? {} : { permissionProfile }),
    });
    await recordShortcutConfigured(created.shortcutId, 'CREATED', created);
    return { shortcut: await summariseShortcut(created) };
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
    const retargeted = await shortcutStore.retarget(shortcutId, target);
    // The case this event exists for. A person confirms a launch by the name
    // they gave it, and the name does not change when the target does.
    await recordShortcutConfigured(shortcutId, 'RETARGETED', retargeted);
    return { shortcut: await summariseShortcut(retargeted) };
  } catch (error) {
    if (error instanceof ShortcutError) {
      return { shortcut: null, error: { reason: error.reason, detail: error.message } };
    }
    throw error;
  }
});

router.on('shortcut.remove', async ({ shortcutId }) => {
  await shortcutStore.remove(shortcutId);
  await recordShortcutConfigured(shortcutId, 'REMOVED');
  return { ok: true } as const;
});

router.on('shortcut.resolve', async ({ typed }) => {
  const verdict = await shortcutResolver.resolveTyped(typed);

  // A refusal is recorded only when a stored shortcut was found and its
  // target would not run. `NO_SUCH_SHORTCUT` is deliberately not recorded:
  // this route is safe to call on every keystroke, so recording every miss
  // would fill the trail with the letters of a name being typed rather than
  // with decisions.
  if (!verdict.ok && verdict.reason !== 'NO_SUCH_SHORTCUT') {
    await auditLog
      .record({
        type: 'shortcut.resolved',
        outcome: 'denied',
        code: verdict.reason,
      })
      .catch(() => undefined);
  }

  if (verdict.ok) {
    // The shortcut's own id and the kind of target it found. Never the name
    // the user typed, which is free text they chose.
    await auditLog.record({
      type: 'shortcut.resolved',
      outcome: 'info',
      shortcutId: verdict.record.shortcutId,
      code: verdict.resolution.targetKind,
      // Absent for a saved prompt: there is no risk to record before the run
      // that would incur it exists.
      ...(verdict.resolution.risk === undefined ? {} : { risk: verdict.resolution.risk }),
    });
  }
  return verdict.ok
    ? { ok: true, resolution: verdict.resolution }
    : { ok: false, reason: verdict.reason, detail: verdict.detail };
});

/**
 * The schedule routes (P-020).
 *
 * Create, read, edit, pause, delete and run. Every one of them is panel-only
 * and none is a tool, so a model can neither create a schedule nor cause one
 * to fire.
 *
 * `schedule.runNow` is the only route here that executes, and it runs
 * *attended*: a person pressed it with the panel open, so it gets an ordinary
 * session and the ordinary interactive prompter. A run the clock started gets
 * an unattended session and stops at the confirmation boundary instead. That
 * asymmetry is the product decision this phase implements — see
 * `docs/architecture/SCHEDULED_EXECUTION.md` — and it is why "Run now" is how
 * a user acts on a run that stopped.
 */
router.on('schedule.list', async () => ({
  schedules: await Promise.all((await scheduleStore.list()).map(summariseSchedule)),
}));

router.on('schedule.runs', async ({ scheduleId }) => ({
  runs: (await scheduleStore.listRuns(scheduleId)).map(summariseScheduleRun),
}));

router.on('schedule.create', async ({ name, target, cadence }) => {
  // Checked at creation so a user is not allowed to schedule something that
  // is already broken. It is checked again at every firing, because a target
  // that exists now can be deleted later.
  const resolution = await resolveScheduleTarget(target);
  if (!resolution.ok) {
    return { schedule: null, error: { reason: resolution.reason, detail: resolution.detail } };
  }
  try {
    const record = await scheduleStore.create({
      displayName: name,
      target,
      cadence,
      // Stated, not defaulted: the person pressed "Create schedule", which is
      // the decision that this runs on its own from now on.
      enabled: true,
    });
    await auditLog.record({
      type: 'schedule.created',
      scheduleId: record.scheduleId,
      outcome: 'info',
      code: record.cadence.kind,
    });
    await scheduleRunner.rearm();
    return { schedule: await summariseSchedule(record) };
  } catch (error) {
    if (error instanceof ScheduleError) {
      return { schedule: null, error: { reason: error.reason, detail: error.message } };
    }
    throw error;
  }
});

router.on('schedule.edit', async ({ scheduleId, name, target, cadence }) => {
  if (target !== undefined) {
    const resolution = await resolveScheduleTarget(target);
    if (!resolution.ok) {
      return { schedule: null, error: { reason: resolution.reason, detail: resolution.detail } };
    }
  }
  try {
    const record = await scheduleStore.edit(scheduleId, {
      ...(name === undefined ? {} : { displayName: name }),
      ...(target === undefined ? {} : { target }),
      ...(cadence === undefined ? {} : { cadence }),
    });
    await auditLog.record({
      type: 'schedule.updated',
      scheduleId: record.scheduleId,
      outcome: 'info',
      code: record.cadence.kind,
    });
    await scheduleRunner.rearm();
    return { schedule: await summariseSchedule(record) };
  } catch (error) {
    if (error instanceof ScheduleError) {
      return { schedule: null, error: { reason: error.reason, detail: error.message } };
    }
    throw error;
  }
});

router.on('schedule.setEnabled', async ({ scheduleId, enabled }) => {
  try {
    const record = await scheduleStore.setEnabled(scheduleId, enabled);
    await auditLog.record({
      type: enabled ? 'schedule.resumed' : 'schedule.paused',
      scheduleId: record.scheduleId,
      outcome: 'info',
    });
    await scheduleRunner.rearm();
    return { schedule: await summariseSchedule(record) };
  } catch (error) {
    if (error instanceof ScheduleError) {
      return { schedule: null, error: { reason: error.reason, detail: error.message } };
    }
    throw error;
  }
});

router.on('schedule.remove', async ({ scheduleId }) => {
  await scheduleStore.remove(scheduleId);
  await auditLog.record({ type: 'schedule.deleted', scheduleId, outcome: 'info' });
  await scheduleRunner.rearm();
  return { ok: true } as const;
});

router.on('schedule.runNow', async ({ scheduleId }) => {
  try {
    const run = await scheduleRunner.runNow(scheduleId);
    return { run: run ? summariseScheduleRun(run) : null };
  } catch (error) {
    if (error instanceof ScheduleError) {
      return { run: null, error: { reason: error.reason, detail: error.message } };
    }
    throw error;
  }
});

router.on('schedule.cancelRun', async ({ runId }) => ({
  cancelled: await scheduleRunner.cancelRun(runId),
}));

/**
 * Runs a bundled skill because a person asked.
 *
 * Takes an id and a pinned version, never a definition. Every step still
 * dispatches through the one `ToolRegistry.dispatch`, so this is the same
 * destination the `skills.run` tool reaches — approached from the side panel
 * rather than from a model.
 */
/**
 * Switching a skill on or off (P-024).
 *
 * Identity only: a registered id and version, and a boolean. There is no way
 * to reach a definition through here, so this cannot install, change or
 * obtain a skill — it decides whether one the build already ships is
 * available. An unknown identity is refused rather than stored, so the
 * disabled set can never accumulate names of things that do not exist.
 */
router.on('skill.setEnabled', async ({ skillId, skillVersion, enabled }) => {
  if (!skillRegistry.getIncludingDisabled(skillId, skillVersion)) {
    return { ok: false, reason: 'There is no skill by that id and version.' };
  }

  await skillEnablement.setEnabled(skillEnablementKey(skillId, skillVersion), enabled);
  await refreshSkillEnablement();

  await auditLog
    .record({
      type: 'skill.enablement',
      skillId,
      skillVersion,
      outcome: enabled ? 'allowed' : 'denied',
      code: enabled ? 'ENABLED' : 'DISABLED',
    })
    .catch(() => undefined);

  return { ok: true };
});

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

/**
 * Registering stored MCP servers, once per worker generation.
 *
 * Not awaited, and failing loudly is not an option here: a worker that would
 * not start because somebody's MCP server is down is a worker that has made an
 * optional capability load-bearing. `registerMcpServers` already reports each
 * server independently, so what is left to handle is the whole pass failing,
 * which means storage rather than a server.
 *
 * It runs on every worker start because a tool set is a fresh reading rather
 * than stored state — which is the same property that makes revocation free.
 */
void refreshMcpServers().catch((error: unknown) => {
  log.warn('MCP servers could not be registered for this worker generation.', {
    error: error instanceof Error ? error.message : String(error),
  });
});

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

/**
 * The schedule alarm (P-020).
 *
 * The only thing that wakes the worker for a schedule. Every delivery
 * reconciles *every* schedule rather than the one the alarm was set for, so a
 * duplicate delivery, an alarm that arrives late, and an alarm that arrives
 * after an eviction all converge on the same reconciliation — and the
 * occurrence claim in `ScheduleStore` makes running anything twice impossible
 * whichever way they interleave.
 */
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name !== SCHEDULE_ALARM) return;
  void scheduleRunner.tick().catch((error: unknown) => {
    log.error('A schedule wake-up failed.', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
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

  // Before the skills are registered, so the first read of the registry in
  // this worker generation already honours the user's choices. A worker that
  // served one dispatch with every skill enabled and then refreshed would be
  // a switch that does not hold across an eviction.
  await refreshSkillEnablement();
  await registerBundledSkills();

  // A run still marked `running` in a fresh worker generation is one whose
  // worker died. Marking it interrupted stops a later reader concluding that
  // something is still executing it; it is not resumed, because the step
  // results it would need were deliberately never persisted.
  const interruptedRuns = await skillRuns.reconcileAfterRestart();

  // Scheduled runs are reconciled before the alarm is re-armed, so a run left
  // `running` by a dead worker is closed as interrupted rather than being
  // seen as still executing. Its occurrence stays claimed: an interrupted run
  // is never retried, because half a sequence of browser actions repeated
  // from the start is worse than a run that did not happen.
  const interruptedScheduleRuns = await scheduleRunner.recover();

  const report = await lifecycle.recoverInterruptedTasks();
  if (report.recovered > 0) {
    for (const taskId of report.taskIds) {
      const task = await taskStore.getTask(taskId);
      if (task) broadcastEvent({ type: 'task.updated', task });
    }
  }
  // Reconciles every schedule against the clock and re-arms the single alarm.
  // Startup is the only place a missed occurrence is normally discovered: the
  // browser was closed, so no alarm was ever delivered.
  await scheduleRunner.tick();

  log.info('Service worker ready.', {
    tools: toolRegistry.list().length,
    providers: providerRegistry.list().length,
    skills: skillRegistry.size,
    recoveredTasks: report.recovered,
    interruptedSkillRuns: interruptedRuns.length,
    interruptedScheduleRuns,
  });
}

void startup().catch((error: unknown) => {
  log.error('Service worker startup failed.', {
    error: error instanceof Error ? error.message : String(error),
  });
});

export { OPENAI_COMPATIBLE_PROVIDER_ID, ANTHROPIC_PROVIDER_ID, GEMINI_PROVIDER_ID };
