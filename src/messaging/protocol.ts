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
import type { PermissionMode } from '@/policy/policy-engine';
import type { ActedOnElement, SemanticPage } from '@/content/semantic-tree';
import type { EvidenceReference } from '@/evidence/evidence-model';
import type { LogRecord } from '@/logging/logger';
import type { SitePolicyState } from '@/policy/site-policy';
import type { ProviderConnection } from '@/providers/registry/provider-registry';

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

/** Request/response pairs handled by the service worker. */
export interface PanelRequestMap {
  'task.create': {
    request: { objective: string };
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

  'policy.getSitePolicy': { request: Record<string, never>; response: { state: SitePolicyState } };
  'policy.removeSiteRule': { request: { site: string }; response: { state: SitePolicyState } };

  'audit.list': {
    request: { limit?: number; taskId?: string; site?: string };
    response: { events: AuditEvent[] };
  };
  /**
   * Builds the export document and returns it to the side panel.
   *
   * The result crosses no security boundary: it travels over extension
   * messaging to a page of this extension, which is inside. Saving it
   * elsewhere would be an egress and is not what this does.
   */
  'audit.export': {
    request: { limit?: number };
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
  'content.type': {
    request: { elementId: string; text: string; clearFirst?: boolean; submit?: boolean };
    response: { typed: true; actedOn?: ActedOnElement };
  };
  'content.select': {
    request: { elementId: string; value: string };
    response: { selected: true; value: string; actedOn?: ActedOnElement };
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
  | { readonly type: 'log'; readonly record: LogRecord };

export const EVENT_MESSAGE_TYPE = 'agent.event';

/** Envelope for a response, so failures cross the boundary as data. */
export type ResponseEnvelope<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AgentError };
