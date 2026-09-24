/**
 * Canonical tab tools (specification sections 10, 15).
 *
 * Tabs the agent opened are tracked separately from the user's own tabs, so a
 * task can clean up after itself without ever closing something the user was
 * working in.
 */
import { z } from 'zod';
import { ToolError } from '@/types/result';
import { checkNavigable } from '@/security/origin/origin-validator';
import type { AgentTool, ToolExecutionResult } from '@/tools/core/tool-types';
import type { BrowserAdapter, TabInfo } from '@/tools/browser/chrome-adapter';

/** Tracks which tabs a task created, per task. */
export class TabOwnership {
  private readonly owned = new Map<string, Set<number>>();

  claim(taskId: string, tabId: number): void {
    const set = this.owned.get(taskId) ?? new Set<number>();
    set.add(tabId);
    this.owned.set(taskId, set);
  }

  owns(taskId: string, tabId: number): boolean {
    return this.owned.get(taskId)?.has(tabId) ?? false;
  }

  release(taskId: string, tabId: number): void {
    this.owned.get(taskId)?.delete(tabId);
  }

  listFor(taskId: string): number[] {
    return [...(this.owned.get(taskId) ?? [])];
  }

  clear(taskId: string): void {
    this.owned.delete(taskId);
  }
}

export interface TabToolDeps {
  readonly adapter: BrowserAdapter;
  readonly ownership: TabOwnership;
}

const emptyInput = z.object({});

/**
 * The tab a workspace-scoped tool should act on when none was named.
 *
 * Prefers the browser's focused tab when it is a workspace member, so the
 * common case — the user looking at the page they are asking about — behaves
 * as expected. Otherwise it falls back to a member, and to nothing at all
 * when the workspace holds none. It never returns a non-member.
 */
export async function activeWorkspaceTab(
  adapter: BrowserAdapter,
  context: { readonly workspaceTabIds?: readonly number[] },
): Promise<TabInfo | null> {
  const active = await adapter.getActiveTab();
  if (context.workspaceTabIds === undefined) return active;
  if (active && context.workspaceTabIds.includes(active.id)) return active;

  const first = context.workspaceTabIds[0];
  if (first === undefined) return null;
  return await adapter.getTab(first);
}

export function createListTabsTool({ adapter }: TabToolDeps): AgentTool<typeof emptyInput> {
  return {
    name: 'tabs.list',
    version: '1.0.0',
    description: 'List the open tabs with their ids, titles and URLs.',
    inputSchema: emptyInput,
    risk: 'R0',
    executionMode: 'immediate',
    siteAuthorization: 'none',
    sideEffects: [],
    timeoutMs: 10_000,
    idempotent: true,
    classify: () => ({ summary: 'List open tabs.' }),

    async execute(_input, context): Promise<ToolExecutionResult> {
      // Narrowed to the workspace. Listing every tab in the browser told the
      // model what the user had open even where acting on those tabs would
      // have been refused, which is an information leak in its own right.
      // `undefined` means no narrowing is configured (unit tests only); an
      // empty array means the workspace is genuinely empty.
      const all = await adapter.listTabs();
      const eligible =
        context.workspaceTabIds === undefined
          ? all
          : all.filter((tab) => context.workspaceTabIds!.includes(tab.id));
      return {
        success: true,
        data: {
          tabs: eligible.map((tab) => ({
            tabId: tab.id,
            title: tab.title,
            url: tab.url,
            active: tab.active,
            windowId: tab.windowId,
            // Tell the model up front which tabs it cannot drive, so it does
            // not waste a turn attempting one.
            automatable: checkNavigable(tab.url).allowed,
          })),
        },
      };
    },
  };
}

export function createGetActiveTabTool({ adapter }: TabToolDeps): AgentTool<typeof emptyInput> {
  return {
    name: 'tabs.get_active',
    version: '1.0.0',
    description: 'Get the tab the user is currently looking at.',
    inputSchema: emptyInput,
    risk: 'R0',
    executionMode: 'immediate',
    siteAuthorization: 'none',
    sideEffects: [],
    timeoutMs: 10_000,
    idempotent: true,
    classify: () => ({ summary: 'Get the active tab.' }),

    async execute(_input, context): Promise<ToolExecutionResult> {
      // The workspace's active tab, not the browser's. The browser's focused
      // tab may belong to another workspace or to no workspace at all, and
      // handing it over would be the cross-workspace targeting this boundary
      // exists to prevent.
      const tab = await activeWorkspaceTab(adapter, context);
      if (!tab) {
        throw new ToolError('TAB_NOT_FOUND', 'This workspace has no tab to work with.');
      }
      return {
        success: true,
        data: {
          tabId: tab.id,
          title: tab.title,
          url: tab.url,
          automatable: checkNavigable(tab.url).allowed,
        },
      };
    },
  };
}

const createTabInput = z.object({
  url: z.string().url().describe('Absolute https URL to open.'),
  active: z.boolean().optional().describe('Switch to the new tab. Defaults to false.'),
});

export function createCreateTabTool({
  adapter,
  ownership,
}: TabToolDeps): AgentTool<typeof createTabInput> {
  return {
    name: 'tabs.create',
    version: '1.0.0',
    description: 'Open a URL in a new tab.',
    inputSchema: createTabInput,
    risk: 'R1',
    executionMode: 'immediate',
    siteAuthorization: 'destination',
    sideEffects: ['Opens a new browser tab.'],
    timeoutMs: 30_000,
    idempotent: false,
    classify: (input) => ({ targetUrl: input.url, summary: `Open ${input.url} in a new tab.` }),

    async execute(input, context): Promise<ToolExecutionResult> {
      const check = checkNavigable(input.url);
      if (!check.allowed) {
        throw new ToolError('POLICY_BLOCKED', check.detail ?? 'That URL cannot be opened.', {
          userMessage: check.detail ?? 'That URL cannot be opened.',
        });
      }

      // Into the task's workspace, so the agent can actually use what it
      // opened — and so the tab never exists outside a workspace holding a
      // real page. See `CreateTabOptions.groupId`.
      const tab = await adapter.createTab({
        url: input.url,
        ...(input.active === undefined ? {} : { active: input.active }),
        ...(context.workspaceGroupId === undefined ? {} : { groupId: context.workspaceGroupId }),
      });
      ownership.claim(context.taskId, tab.id);

      try {
        const loaded = await adapter.waitForLoad(tab.id, 30_000);
        return { success: true, data: { tabId: tab.id, url: loaded.url, title: loaded.title } };
      } catch {
        // The tab exists even if it did not finish loading; report it rather
        // than leaving an orphan the model does not know about.
        return {
          success: true,
          data: { tabId: tab.id, url: input.url, loaded: false, note: 'The tab is still loading.' },
        };
      }
    },
  };
}

const tabIdInput = z.object({
  tabId: z.number().int().describe('Tab id from tabs.list.'),
});

export function createCloseTabTool({
  adapter,
  ownership,
}: TabToolDeps): AgentTool<typeof tabIdInput> {
  return {
    name: 'tabs.close',
    version: '1.0.0',
    description: 'Close a tab. Tabs the agent did not open require approval.',
    inputSchema: tabIdInput,
    // The floor is R1 — a reversible cleanup of a tab this task opened — and
    // `classify` escalates to R3 for anything else. Declaring the floor at the
    // higher level instead would make the agent prompt for every one of its
    // own scratch tabs, which teaches users to approve reflexively and costs
    // more safety than it buys.
    risk: 'R1',
    executionMode: 'immediate',
    siteAuthorization: 'none',
    sideEffects: ['Closes a browser tab, discarding any unsaved page state.'],
    timeoutMs: 10_000,
    idempotent: true,
    classify: (input, context) => ({
      // Closing a tab the user opened can destroy their work.
      risk: ownership.owns(context.taskId, input.tabId) ? ('R1' as const) : ('R3' as const),
      summary: ownership.owns(context.taskId, input.tabId)
        ? `Close tab ${input.tabId}, which this task opened.`
        : `Close tab ${input.tabId}, which the user opened.`,
    }),

    async execute(input, context): Promise<ToolExecutionResult> {
      const tab = await adapter.getTab(input.tabId);
      if (!tab) throw new ToolError('TAB_NOT_FOUND', `Tab ${input.tabId} no longer exists.`);
      await adapter.closeTab(input.tabId);
      ownership.release(context.taskId, input.tabId);
      return { success: true, data: { closed: true, tabId: input.tabId } };
    },
  };
}

export function createActivateTabTool({ adapter }: TabToolDeps): AgentTool<typeof tabIdInput> {
  return {
    name: 'tabs.activate',
    version: '1.0.0',
    description: 'Bring a tab to the foreground and focus its window.',
    inputSchema: tabIdInput,
    risk: 'R1',
    executionMode: 'immediate',
    siteAuthorization: 'none',
    sideEffects: ['Changes which tab the user is looking at.'],
    timeoutMs: 10_000,
    idempotent: true,
    classify: (input) => ({ summary: `Switch to tab ${input.tabId}.` }),

    async execute(input): Promise<ToolExecutionResult> {
      const tab = await adapter.getTab(input.tabId);
      if (!tab) throw new ToolError('TAB_NOT_FOUND', `Tab ${input.tabId} no longer exists.`);
      const activated = await adapter.activateTab(input.tabId);
      return { success: true, data: { tabId: activated.id, url: activated.url } };
    },
  };
}

export function createReloadTabTool({ adapter }: TabToolDeps): AgentTool<typeof tabIdInput> {
  return {
    name: 'tabs.reload',
    version: '1.0.0',
    description: 'Reload a tab by id.',
    inputSchema: tabIdInput,
    risk: 'R1',
    executionMode: 'immediate',
    siteAuthorization: 'none',
    sideEffects: ['Re-runs the page, which may resubmit a form.'],
    timeoutMs: 45_000,
    idempotent: true,
    classify: (input) => ({ summary: `Reload tab ${input.tabId}.` }),

    async execute(input): Promise<ToolExecutionResult> {
      const tab = await adapter.getTab(input.tabId);
      if (!tab) throw new ToolError('TAB_NOT_FOUND', `Tab ${input.tabId} no longer exists.`);
      await adapter.reloadTab(input.tabId);
      return { success: true, data: { reloaded: true, tabId: input.tabId } };
    },
  };
}

const groupInput = z.object({
  tabIds: z.array(z.number().int()).min(1).max(50).describe('Tab ids to group together.'),
  title: z.string().max(100).optional().describe('Optional label for the group.'),
});

export function createGroupTabsTool({ adapter }: TabToolDeps): AgentTool<typeof groupInput> {
  return {
    name: 'tabs.group',
    version: '1.0.0',
    description: 'Group tabs together under an optional title.',
    inputSchema: groupInput,
    risk: 'R1',
    executionMode: 'immediate',
    siteAuthorization: 'none',
    sideEffects: ['Reorganises the user’s tab strip.'],
    timeoutMs: 15_000,
    idempotent: false,
    classify: (input) => ({ summary: `Group ${input.tabIds.length} tabs.` }),

    async execute(input): Promise<ToolExecutionResult> {
      const groupId = await adapter.groupTabs(input.tabIds, input.title);
      return { success: true, data: { groupId, tabIds: input.tabIds } };
    },
  };
}

const ungroupInput = z.object({
  tabIds: z.array(z.number().int()).min(1).max(50).describe('Tab ids to remove from their group.'),
});

export function createUngroupTabsTool({ adapter }: TabToolDeps): AgentTool<typeof ungroupInput> {
  return {
    name: 'tabs.ungroup',
    version: '1.0.0',
    description: 'Remove tabs from their tab group.',
    inputSchema: ungroupInput,
    risk: 'R1',
    executionMode: 'immediate',
    siteAuthorization: 'none',
    sideEffects: ['Reorganises the user’s tab strip.'],
    timeoutMs: 15_000,
    idempotent: true,
    classify: (input) => ({ summary: `Ungroup ${input.tabIds.length} tabs.` }),

    async execute(input): Promise<ToolExecutionResult> {
      await adapter.ungroupTabs(input.tabIds);
      return { success: true, data: { ungrouped: input.tabIds } };
    },
  };
}

const waitNavigationInput = z.object({
  tabId: z.number().int().describe('Tab to watch.'),
  timeoutMs: z.number().int().min(100).max(60_000).optional().describe('Defaults to 30000.'),
});

export function createWaitForNavigationTool({
  adapter,
}: TabToolDeps): AgentTool<typeof waitNavigationInput> {
  return {
    name: 'tabs.wait_for_navigation',
    version: '1.0.0',
    description: 'Wait until a tab finishes loading.',
    inputSchema: waitNavigationInput,
    risk: 'R0',
    executionMode: 'immediate',
    siteAuthorization: 'none',
    sideEffects: [],
    timeoutMs: 65_000,
    idempotent: true,
    classify: (input) => ({ summary: `Wait for tab ${input.tabId} to finish loading.` }),

    async execute(input): Promise<ToolExecutionResult> {
      try {
        const tab = await adapter.waitForLoad(input.tabId, input.timeoutMs ?? 30_000);
        return { success: true, data: { url: tab.url, title: tab.title, loaded: true } };
      } catch (error) {
        throw new ToolError('NAVIGATION_TIMEOUT', 'The tab did not finish loading in time.', {
          retryable: true,
          technicalDetails: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createTabTools(deps: TabToolDeps): AgentTool[] {
  return [
    createListTabsTool(deps),
    createGetActiveTabTool(deps),
    createCreateTabTool(deps),
    createCloseTabTool(deps),
    createActivateTabTool(deps),
    createReloadTabTool(deps),
    createGroupTabsTool(deps),
    createUngroupTabsTool(deps),
    createWaitForNavigationTool(deps),
  ] as AgentTool[];
}
