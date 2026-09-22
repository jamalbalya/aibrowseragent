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
import { WorkflowStore } from '@/workflows/workflow-store';
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
const settingsStore = new SettingsStore(new NamespacedStorageArea(local, 'settings'));
const credentialStore = new CredentialStore(local);
const taskStore = new TaskStore(new NamespacedStorageArea(local, 'tasks'));
const evidenceStore = new EvidenceStore(new NamespacedStorageArea(local, 'evidence'));
const auditLog = new AuditLog(new NamespacedStorageArea(local, 'audit'), {
  // A tool name reaches the trail from a model proposal, so it is checked
  // against what this build actually registered. An unrecognised name is
  // recorded as unknown and the proposed string is dropped, which stops the
  // trail being a model-writable text field.
  knownTool: (name) => toolRegistry.has(name),
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

const toolRegistry = new ToolRegistry({
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
async function resolveProvider(): Promise<{
  adapter: ReturnType<ProviderRegistry['get']>;
  capabilities: typeof UNKNOWN_CAPABILITIES;
  providerId: string;
  modelId: string;
}> {
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
  resolveProvider,
  getPermissionMode: async () => (await settingsStore.get()).permissionMode,
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

  const existing = await settingsStore.getConnection();
  const connection: ProviderConnection = existing
    ? { ...existing, providerId, modelId }
    : {
        providerId,
        modelId,
        authKind: providerRegistry.get(providerId).authKind,
        createdAt: Date.now(),
        status: 'connected',
      };
  await settingsStore.setConnection(connection);
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

router.on('permission.respond', ({ requestId, response }) => {
  permissionBroker.respond(requestId, response);
  return Promise.resolve({ ok: true as const });
});

router.on('permission.listPending', () =>
  Promise.resolve({ requests: permissionBroker.listPending() }),
);

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

chrome.tabs.onRemoved.addListener((tabId) => {
  lifecycle.handleTabClosed(tabId);
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
