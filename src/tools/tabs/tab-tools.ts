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

/**
 * Refuses a tab id the workspace does not hold.
 *
 * The registry has a central workspace check, and it guards the **run's ambient
 * tab** — the one the task is standing on — not a tab id a tool was handed as an
 * argument. So a tool that takes an explicit id has to ask for itself, and
 * `tabs.list` explains why it matters: narrowing the listing to the workspace
 * was done because telling the model every tab the user had open was an
 * information leak. A `tabs.get` that answered for any id would hand back the
 * same thing one tab at a time.
 *
 * `undefined` means no narrowing is configured, which happens only in unit
 * tests; an empty array is a genuinely empty workspace and admits nothing.
 */
async function workspaceTab(
  adapter: BrowserAdapter,
  context: { readonly workspaceTabIds?: readonly number[] },
  tabId: number,
): Promise<TabInfo> {
  if (context.workspaceTabIds !== undefined && !context.workspaceTabIds.includes(tabId)) {
    throw new ToolError('POLICY_BLOCKED', `Tab ${tabId} is not part of this workspace.`, {
      userMessage: 'That tab is not part of this task\u2019s workspace.',
      retryable: false,
    });
  }
  const tab = await adapter.getTab(tabId);
  if (!tab) throw new ToolError('TAB_NOT_FOUND', `Tab ${tabId} no longer exists.`);
  return tab;
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

    async execute(input, context): Promise<ToolExecutionResult> {
      // Members only. Focusing an arbitrary tab moves the user somewhere the
      // task was never scoped to, and the result returns that tab's URL — so
      // this was also the enumeration leak `tabs.list` was narrowed to close,
      // reachable one tab at a time. Measured before the fix: it succeeded on
      // a tab outside the workspace and returned its URL.
      await workspaceTab(adapter, context, input.tabId);
      const activated = await adapter.activateTab(input.tabId);
      return { success: true, data: { tabId: activated.id, url: activated.url } };
    },
  };
}

/**
 * `tabs.get` — one named tab, rather than the active one or all of them.
 *
 * Specification §10 lists `tabs.get` and `tabs.get_active` as separate tools,
 * and until now only the second existed: asking about a specific tab meant
 * listing the workspace and searching the result. That works and is not what
 * §10 asks for.
 *
 * It answers only for a tab the workspace holds, and it returns the same fields
 * `tabs.list` does plus the tab's position, which is what makes `tabs.move`
 * usable. `groupId` is withheld, exactly as `tabs.list` withholds it: the
 * workspace's group is a runtime identifier the model has no business holding.
 */
export function createGetTabTool({ adapter }: TabToolDeps): AgentTool<typeof tabIdInput> {
  return {
    name: 'tabs.get',
    version: '1.0.0',
    description: 'Get one tab by id, with its title, URL and position.',
    inputSchema: tabIdInput,
    risk: 'R0',
    executionMode: 'immediate',
    siteAuthorization: 'none',
    sideEffects: [],
    timeoutMs: 10_000,
    idempotent: true,
    classify: (input) => ({ summary: `Look up tab ${input.tabId}.` }),

    async execute(input, context): Promise<ToolExecutionResult> {
      const tab = await workspaceTab(adapter, context, input.tabId);
      return {
        success: true,
        data: {
          tabId: tab.id,
          title: tab.title,
          url: tab.url,
          active: tab.active,
          windowId: tab.windowId,
          index: tab.index,
          automatable: checkNavigable(tab.url).allowed,
        },
      };
    },
  };
}

const moveTabInput = z.object({
  tabId: z.number().int().describe('Tab id from tabs.list.'),
  index: z
    .number()
    .int()
    .min(0)
    .describe('Position to move the tab to, counting from 0 at the left of its window.'),
});

/**
 * `tabs.move` — reorder a tab within its own window.
 *
 * ## Scope, stated rather than assumed
 *
 * Same window only. `chrome.tabs.move` can take a `windowId` and move a tab
 * between windows; the adapter this project already has does not pass one, and
 * §10 lists `tabs.move` without saying which it means. Moving a tab to another
 * window would also take it out of the window its workspace group lives in,
 * which is a workspace question rather than a tab question. So the narrower
 * reading is implemented and the wider one is left alone rather than invented.
 *
 * ## Why the result is measured rather than echoed
 *
 * `chrome.tabs.move` does not fail on an index past the end of the window — it
 * clamps to the last position. Reporting the requested index would therefore
 * claim a move that did not happen the way it was asked for, which is the fake
 * success §76 forbids. The tab is read back afterwards and the position it
 * actually has is what comes out.
 */
export function createMoveTabTool({ adapter }: TabToolDeps): AgentTool<typeof moveTabInput> {
  return {
    name: 'tabs.move',
    version: '1.0.0',
    description:
      'Move a tab to a different position in its own window. Cannot move a tab between windows.',
    inputSchema: moveTabInput,
    // R1, alongside `tabs.activate` and `tabs.reload`: it changes what the user
    // sees and is trivially reversible, and it destroys nothing. R0 would be
    // wrong — this is not a read — and R3 would put a confirmation in front of
    // rearranging a tab, which teaches people to approve without looking.
    risk: 'R1',
    executionMode: 'immediate',
    siteAuthorization: 'none',
    sideEffects: ['Changes the order of the tabs in a window.'],
    timeoutMs: 10_000,
    idempotent: true,
    classify: (input) => ({ summary: `Move tab ${input.tabId} to position ${input.index}.` }),

    async execute(input, context): Promise<ToolExecutionResult> {
      const before = await workspaceTab(adapter, context, input.tabId);
      await adapter.moveTab(input.tabId, input.index);

      const after = await adapter.getTab(input.tabId);
      if (!after) {
        throw new ToolError('TAB_NOT_FOUND', `Tab ${input.tabId} disappeared during the move.`);
      }
      return {
        success: true,
        data: {
          tabId: after.id,
          fromIndex: before.index,
          // What Chrome did, not what was asked for.
          index: after.index,
          requestedIndex: input.index,
          clamped: after.index !== input.index,
          windowId: after.windowId,
        },
      };
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

    async execute(input, context): Promise<ToolExecutionResult> {
      // Members only. This tool's own declared side effect is that a reload
      // "may resubmit a form", which is not something to do to a page the task
      // was never scoped to. Measured before the fix: it reloaded a tab outside
      // the workspace and reported success.
      await workspaceTab(adapter, context, input.tabId);
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

    async execute(input, context): Promise<ToolExecutionResult> {
      for (const tabId of input.tabIds) await workspaceTab(adapter, context, tabId);

      // Join the workspace's own group rather than creating a new one. §11 of
      // the workspace review already uses this form for agent-created tabs;
      // the create form is what let a model pull its own tabs out of the
      // workspace and destroy the scope it was running in. Joining is a no-op
      // for a tab already in the group and re-seats one that drifted, so the
      // capability stays real while the boundary stops moving.
      const groupId = await adapter.groupTabs(input.tabIds, {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(context.workspaceGroupId === undefined
          ? {}
          : { joinGroupId: context.workspaceGroupId }),
      });
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

    async execute(input, context): Promise<ToolExecutionResult> {
      for (const tabId of input.tabIds) await workspaceTab(adapter, context, tabId);

      // Releasing a tab the task is finished with only ever narrows the
      // agent's own reach, so it is allowed. Releasing the *last* one does not
      // narrow anything — it empties the group, and a group with no tabs left
      // ceases to exist (measured, §3), which unbinds the workspace and leaves
      // the running task with no scope at all. Measured before this guard: one
      // `tabs.ungroup` call on its own tab, and every later call in the same
      // task was refused because the workspace had gone.
      if (context.workspaceTabIds !== undefined) {
        const left = context.workspaceTabIds.filter((id) => !input.tabIds.includes(id));
        if (left.length === 0) {
          throw new ToolError(
            'POLICY_BLOCKED',
            'Ungrouping every tab would leave this task with no workspace.',
            {
              userMessage:
                'That would remove the last tab from this task\u2019s workspace, so it was refused.',
              retryable: false,
            },
          );
        }
      }
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

    async execute(input, context): Promise<ToolExecutionResult> {
      // Members only, and this was the worst of the five: the result carries
      // the tab's URL *and* title, so at R0 and with no prompt it answered
      // "what is in that tab" for any id in any window. Measured before the
      // fix, against a tab the user never put in scope: success, with the
      // page's real URL and title handed to the model.
      await workspaceTab(adapter, context, input.tabId);
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
    createGetTabTool(deps),
    createCreateTabTool(deps),
    createMoveTabTool(deps),
    createCloseTabTool(deps),
    createActivateTabTool(deps),
    createReloadTabTool(deps),
    createGroupTabsTool(deps),
    createUngroupTabsTool(deps),
    createWaitForNavigationTool(deps),
  ] as AgentTool[];
}
