/**
 * Wires a ToolRegistry with a real policy engine and a scriptable prompter,
 * so tests exercise the genuine enforcement path rather than a stub.
 */
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import {
  PermissionEngine,
  type PermissionPrompter,
  type PermissionRequest,
  type PermissionResponse,
} from '@/policy/permission-engine';
import { emptySitePolicyState, type SitePolicyState } from '@/policy/site-policy';
import type { PermissionMode, PolicyContext } from '@/policy/policy-engine';
import { ToolRegistry, type ToolRegistryOptions } from '@/tools/registry/tool-registry';
import type { AgentTool } from '@/tools/core/tool-types';

export class ScriptedPrompter implements PermissionPrompter {
  readonly seen: PermissionRequest[] = [];

  constructor(private response: PermissionResponse = { kind: 'approve_once' }) {}

  setResponse(response: PermissionResponse): void {
    this.response = response;
  }

  prompt(request: PermissionRequest): Promise<PermissionResponse> {
    this.seen.push(request);
    return Promise.resolve(this.response);
  }
}

export interface Harness {
  readonly registry: ToolRegistry;
  readonly prompter: ScriptedPrompter;
  readonly permissionEngine: PermissionEngine;
  loadSitePolicy(): Promise<SitePolicyState>;
  setMode(mode: PermissionMode): void;
}

export function createHarness(
  tools: readonly AgentTool[],
  options: {
    mode?: PermissionMode;
    prompter?: ScriptedPrompter;
    /** Supplying this exercises the real egress gate inside the registry. */
    egress?: ToolRegistryOptions['egress'];
    resolveTabUrl?: ToolRegistryOptions['resolveTabUrl'];
    /** The observation hook, for the workflow recorder's tests. */
    onDispatched?: ToolRegistryOptions['onDispatched'];
    /**
     * Puts something in front of the prompter the engine will use.
     *
     * Exists for the scheduled-execution suites, which need the real
     * `UnattendedPrompter` between the engine and the scripted answers — so a
     * test can prove that an unattended run is denied by production code
     * rather than by a stub that was told to deny.
     */
    wrapPrompter?: (inner: PermissionPrompter) => PermissionPrompter;
    /**
     * Whether a task is running with nobody watching.
     *
     * Supplied by the scheduling suites so the real policy engine sees the
     * same `PolicyContext.unattended` the service worker gives it. Absent
     * means attended, which is what every other suite is.
     */
    resolveUnattended?: (taskId: string) => Promise<boolean>;
  } = {},
): Harness {
  const area = new SerializedStorageArea(new MemoryStorageArea());
  const prompter = options.prompter ?? new ScriptedPrompter();
  let mode: PermissionMode = options.mode ?? 'auto';

  const loadSitePolicy = async (): Promise<SitePolicyState> =>
    (await area.get<SitePolicyState>('site-policy')) ?? emptySitePolicyState();
  const saveSitePolicy = async (state: SitePolicyState): Promise<void> => {
    await area.set('site-policy', state);
  };

  const permissionEngine = new PermissionEngine({
    prompter: options.wrapPrompter ? options.wrapPrompter(prompter) : prompter,
    loadSitePolicy,
    saveSitePolicy,
  });

  const loadPolicyContext = async (taskId: string): Promise<PolicyContext> => ({
    mode,
    sitePolicy: await loadSitePolicy(),
    unattended: (await options.resolveUnattended?.(taskId)) ?? false,
  });

  const registry = new ToolRegistry({
    permissionEngine,
    loadPolicyContext,
    ...(options.egress === undefined ? {} : { egress: options.egress }),
    ...(options.resolveTabUrl === undefined ? {} : { resolveTabUrl: options.resolveTabUrl }),
    ...(options.onDispatched === undefined ? {} : { onDispatched: options.onDispatched }),
  });
  registry.registerAll(tools);

  return {
    registry,
    prompter,
    permissionEngine,
    loadSitePolicy,
    setMode: (next) => {
      mode = next;
    },
  };
}
