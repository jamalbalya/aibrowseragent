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
import { EvidenceStore } from '@/evidence/evidence-store';
import { ProviderRegistry, type ProviderConnection } from '@/providers/registry/provider-registry';
import { ConsentStore } from '@/security/egress/consent';
import { AuditLog, buildAuditExport } from '@/audit/audit-log';
import { createGuardedTransport } from '@/security/egress/provider-transport';
import { installNetworkInterceptor } from '@/security/egress/network-interceptor';
import { buildEgressEvidence } from '@/security/egress/egress-evidence';
import { providerDestination } from '@/security/egress/destination';
import { CapabilityDoctor } from '@/providers/capability-doctor/capability-doctor';
import {
  openAICompatibleFactory,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from '@/providers/adapters/openai-compatible';
import { UNKNOWN_CAPABILITIES } from '@/providers/core/types';
import { ToolRegistry } from '@/tools/registry/tool-registry';
import { ChromeBrowserAdapter } from '@/tools/browser/chrome-adapter';
import { createBrowserTools } from '@/tools/browser/browser-tools';
import { createTabTools, TabOwnership } from '@/tools/tabs/tab-tools';
import { DebuggerManager } from '@/tools/debugger/debugger-manager';
import { createDebuggerTools } from '@/tools/debugger/debugger-tools';
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
const settingsStore = new SettingsStore(new NamespacedStorageArea(local, 'settings'));
const credentialStore = new CredentialStore(local);
const taskStore = new TaskStore(new NamespacedStorageArea(local, 'tasks'));
const evidenceStore = new EvidenceStore(new NamespacedStorageArea(local, 'evidence'));
const auditLog = new AuditLog(new NamespacedStorageArea(local, 'audit'));
const policyArea = new NamespacedStorageArea(local, 'policy');

const SITE_POLICY_KEY = 'site-policy';
const SESSION_KEY = 'active-session';

const loadSitePolicy = async (): Promise<SitePolicyState> =>
  (await policyArea.get<SitePolicyState>(SITE_POLICY_KEY)) ?? emptySitePolicyState();

const saveSitePolicy = async (state: SitePolicyState): Promise<void> => {
  await policyArea.set(SITE_POLICY_KEY, state);
};

const loadPolicyContext = async (): Promise<PolicyContext> => {
  const settings = await settingsStore.get();
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
providerRegistry.register(openAICompatibleFactory);
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
      detail: entry.reason,
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
toolRegistry.registerAll(createBrowserTools({ adapter: browserAdapter, debuggerManager }));
toolRegistry.registerAll(createTabTools({ adapter: browserAdapter, ownership: tabOwnership }));
toolRegistry.registerAll(
  createDebuggerTools({ adapter: browserAdapter, manager: debuggerManager }),
);

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

const router = new MessageRouter();

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

router.on('audit.list', async ({ limit, taskId, site }) => {
  if (taskId !== undefined) return { events: await auditLog.forTask(taskId, limit) };
  if (site !== undefined) return { events: await auditLog.forSite(site, limit) };
  return { events: await auditLog.list(limit) };
});

/**
 * Builds the export and hands it back over extension messaging.
 *
 * This stays inside the extension: the side panel is an extension page, so
 * nothing crosses the boundary and there is no egress to authorise. Writing
 * the same document to a file or a server would cross it, and would have to
 * go through the gate like anything else.
 */
router.on('audit.export', async ({ limit }) => ({
  export: buildAuditExport(await auditLog.list(limit ?? 2000), Date.now()),
}));

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
    recoveredTasks: report.recovered,
  });
}

void startup().catch((error: unknown) => {
  log.error('Service worker startup failed.', {
    error: error instanceof Error ? error.message : String(error),
  });
});

export { OPENAI_COMPATIBLE_PROVIDER_ID };
