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
import type { AuditEvent, AuditExport } from '@/audit/audit-log';
import type { PermissionMode } from '@/policy/policy-engine';
import type { SemanticPage } from '@/content/semantic-tree';
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
  'content.click': {
    request: { elementId: string };
    response: { clicked: true; navigated: boolean };
  };
  'content.type': {
    request: { elementId: string; text: string; clearFirst?: boolean; submit?: boolean };
    response: { typed: true };
  };
  'content.select': {
    request: { elementId: string; value: string };
    response: { selected: true; value: string };
  };
  'content.setChecked': {
    request: { elementId: string; checked: boolean };
    response: { checked: boolean; value: string; kind: 'checkbox' | 'radio' };
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
  | { readonly type: 'provider.statusChanged'; readonly connection: ProviderConnection | null }
  | { readonly type: 'log'; readonly record: LogRecord };

export const EVENT_MESSAGE_TYPE = 'agent.event';

/** Envelope for a response, so failures cross the boundary as data. */
export type ResponseEnvelope<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AgentError };
