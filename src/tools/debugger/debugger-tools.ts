/**
 * Debugger tools (specification sections 11, 16).
 *
 * Each tool exposes one narrow, allowlisted capability. There is deliberately
 * no generic `debugger.command` tool: the model cannot name a CDP method.
 */
import { z } from 'zod';
import { ToolError } from '@/types/result';
import { newEvidenceId } from '@/utils/ids';
import { checkNavigable } from '@/security/origin/origin-validator';
import { wrapUntrusted } from '@/security/prompt-injection/untrusted-content';
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@/tools/core/tool-types';
import type { BrowserAdapter, TabInfo } from '@/tools/browser/chrome-adapter';
import type { DebuggerManager } from './debugger-manager';

export interface DebuggerToolDeps {
  readonly adapter: BrowserAdapter;
  readonly manager: DebuggerManager;
}

async function requireAttachedTab(
  deps: DebuggerToolDeps,
  context: ToolExecutionContext,
): Promise<TabInfo> {
  const tabId = context.tabId ?? (await deps.adapter.getActiveTab())?.id;
  if (tabId === undefined) {
    throw new ToolError('TAB_NOT_FOUND', 'There is no tab to inspect.');
  }
  const tab = await deps.adapter.getTab(tabId);
  if (!tab) throw new ToolError('TAB_NOT_FOUND', `Tab ${tabId} no longer exists.`);

  const check = checkNavigable(tab.url);
  if (!check.allowed) {
    throw new ToolError('POLICY_BLOCKED', check.detail ?? 'This page cannot be inspected.');
  }

  await deps.manager.attach(tabId);
  return tab;
}

const emptyInput = z.object({});

export function createGetConsoleTool(deps: DebuggerToolDeps): AgentTool<typeof consoleInput> {
  return {
    name: 'debugger.console',
    version: '1.0.0',
    description:
      'Read console output and uncaught errors from the current page. Attaches the debugger, ' +
      'which shows a banner in the browser. Secrets are redacted before the output is returned.',
    inputSchema: consoleInput,
    risk: 'R0',
    executionMode: 'requires_debugger',
    siteAuthorization: 'page',
    sideEffects: ['Attaches the Chrome debugger, which displays a notification bar.'],
    timeoutMs: 20_000,
    idempotent: true,
    classify: () => ({ summary: 'Read the page console.' }),

    async execute(input, context): Promise<ToolExecutionResult> {
      const tab = await requireAttachedTab(deps, context);
      const all = deps.manager.getConsole(tab.id);
      const filtered =
        input.level === undefined ? all : all.filter((entry) => entry.level === input.level);
      const limited = filtered.slice(-(input.limit ?? 50));

      const evidence = {
        id: newEvidenceId(),
        type: 'CONSOLE' as const,
        taskId: context.taskId,
        toolCallId: context.toolCallId,
        sourceTool: 'debugger.console',
        createdAt: Date.now(),
        sensitivity: 'internal' as const,
        trust: 'untrusted_external_content' as const,
        origin: tab.url,
        label: `Console: ${limited.length} entries from ${tab.url}`,
      };
      context.recordEvidence(evidence, {
        content: JSON.stringify(limited, null, 2),
        encoding: 'utf8',
        mimeType: 'application/json',
      });

      return {
        success: true,
        data: {
          url: tab.url,
          totalCaptured: all.length,
          returned: limited.length,
          // Console text is page-authored, so it is envelope-wrapped.
          entries: wrapUntrusted(JSON.stringify(limited, null, 2), {
            sourceType: 'browser_console',
            origin: tab.url,
            retrievedAt: Date.now(),
            trust: 'untrusted_external_content',
          }),
        },
        taint: [
          {
            sourceType: 'browser_console',
            site: new URL(tab.url).hostname,
            sensitivity: 'internal',
          },
        ],
      };
    },
  };
}

const consoleInput = z.object({
  level: z
    .enum(['log', 'info', 'warn', 'error', 'debug'])
    .optional()
    .describe('Only return entries at this level.'),
  limit: z.number().int().min(1).max(200).optional().describe('Most recent entries. Default 50.'),
});

const networkInput = z.object({
  limit: z.number().int().min(1).max(200).optional().describe('Most recent requests. Default 50.'),
  failedOnly: z.boolean().optional().describe('Only requests that failed or returned 4xx/5xx.'),
  urlContains: z
    .string()
    .max(200)
    .optional()
    .describe('Only requests whose URL contains this text.'),
});

export function createGetNetworkTool(deps: DebuggerToolDeps): AgentTool<typeof networkInput> {
  return {
    name: 'debugger.network',
    version: '1.0.0',
    description:
      'Read network requests made by the current page, including status codes and redacted ' +
      'headers. Authorization headers, cookies and tokens are removed before the data is returned.',
    inputSchema: networkInput,
    risk: 'R0',
    executionMode: 'requires_debugger',
    siteAuthorization: 'page',
    sideEffects: ['Attaches the Chrome debugger, which displays a notification bar.'],
    timeoutMs: 20_000,
    idempotent: true,
    classify: () => ({ summary: 'Read page network activity.' }),

    async execute(input, context): Promise<ToolExecutionResult> {
      const tab = await requireAttachedTab(deps, context);
      let entries = deps.manager.getNetwork(tab.id);

      if (input.failedOnly) {
        entries = entries.filter(
          (entry) => entry.failed === true || (entry.status !== undefined && entry.status >= 400),
        );
      }
      if (input.urlContains) {
        const needle = input.urlContains.toLowerCase();
        entries = entries.filter((entry) => entry.url.toLowerCase().includes(needle));
      }
      const limited = entries.slice(-(input.limit ?? 50));

      const evidence = {
        id: newEvidenceId(),
        type: 'NETWORK' as const,
        taskId: context.taskId,
        toolCallId: context.toolCallId,
        sourceTool: 'debugger.network',
        createdAt: Date.now(),
        sensitivity: 'internal' as const,
        trust: 'untrusted_external_content' as const,
        origin: tab.url,
        label: `Network: ${limited.length} requests from ${tab.url}`,
      };
      context.recordEvidence(evidence, {
        content: JSON.stringify(limited, null, 2),
        encoding: 'utf8',
        mimeType: 'application/json',
      });

      return {
        success: true,
        data: { url: tab.url, totalCaptured: entries.length, requests: limited },
        taint: [
          {
            sourceType: 'browser_network',
            site: new URL(tab.url).hostname,
            sensitivity: 'internal',
          },
        ],
      };
    },
  };
}

const domInput = z.object({
  maxLength: z
    .number()
    .int()
    .min(1000)
    .max(500_000)
    .optional()
    .describe('Maximum characters of HTML to return. Default 100000.'),
});

export function createGetDomTool(deps: DebuggerToolDeps): AgentTool<typeof domInput> {
  return {
    name: 'debugger.dom',
    version: '1.0.0',
    description:
      'Get the current rendered HTML of the page, after scripts have run. Prefer ' +
      'browser.read_page unless you specifically need raw markup.',
    inputSchema: domInput,
    risk: 'R0',
    executionMode: 'requires_debugger',
    siteAuthorization: 'page',
    sideEffects: ['Attaches the Chrome debugger, which displays a notification bar.'],
    timeoutMs: 30_000,
    idempotent: true,
    classify: () => ({ summary: 'Read the page HTML.' }),

    async execute(input, context): Promise<ToolExecutionResult> {
      const tab = await requireAttachedTab(deps, context);
      const maxLength = input.maxLength ?? 100_000;

      const document = await deps.manager.send<{ root?: { nodeId?: number } }>(
        tab.id,
        'DOM.getDocument',
        { depth: -1 },
      );
      const nodeId = document.root?.nodeId;
      if (nodeId === undefined) {
        throw new ToolError('PAGE_NOT_READY', 'The page has no document yet.', { retryable: true });
      }

      const html = await deps.manager.send<{ outerHTML?: string }>(tab.id, 'DOM.getOuterHTML', {
        nodeId,
      });
      const raw = html.outerHTML ?? '';
      const truncated = raw.length > maxLength;

      const evidence = {
        id: newEvidenceId(),
        type: 'DOM' as const,
        taskId: context.taskId,
        toolCallId: context.toolCallId,
        sourceTool: 'debugger.dom',
        createdAt: Date.now(),
        sensitivity: 'internal' as const,
        trust: 'untrusted_external_content' as const,
        origin: tab.url,
        label: `HTML: ${tab.url}`,
      };
      context.recordEvidence(evidence, {
        content: truncated ? raw.slice(0, maxLength) : raw,
        encoding: 'utf8',
        mimeType: 'text/html',
      });

      return {
        success: true,
        data: {
          url: tab.url,
          truncated,
          html: wrapUntrusted(truncated ? raw.slice(0, maxLength) : raw, {
            sourceType: 'page_html',
            origin: tab.url,
            retrievedAt: Date.now(),
            trust: 'untrusted_external_content',
          }),
        },
        taint: [
          { sourceType: 'page_html', site: new URL(tab.url).hostname, sensitivity: 'internal' },
        ],
      };
    },
  };
}

export function createGetPageStateTool(deps: DebuggerToolDeps): AgentTool<typeof emptyInput> {
  return {
    name: 'debugger.page_state',
    version: '1.0.0',
    description: 'Get the page’s navigation history position and layout metrics.',
    inputSchema: emptyInput,
    risk: 'R0',
    executionMode: 'requires_debugger',
    siteAuthorization: 'page',
    sideEffects: ['Attaches the Chrome debugger, which displays a notification bar.'],
    timeoutMs: 20_000,
    idempotent: true,
    classify: () => ({ summary: 'Read page navigation and layout state.' }),

    async execute(_input, context): Promise<ToolExecutionResult> {
      const tab = await requireAttachedTab(deps, context);

      const history = await deps.manager.send<{
        currentIndex?: number;
        entries?: { url?: string; title?: string }[];
      }>(tab.id, 'Page.getNavigationHistory');
      const metrics = await deps.manager.send<{
        contentSize?: { width?: number; height?: number };
        visualViewport?: { pageX?: number; pageY?: number };
      }>(tab.id, 'Page.getLayoutMetrics');

      return {
        success: true,
        data: {
          url: tab.url,
          title: tab.title,
          canGoBack: (history.currentIndex ?? 0) > 0,
          canGoForward: (history.currentIndex ?? 0) < (history.entries?.length ?? 1) - 1,
          historyLength: history.entries?.length ?? 0,
          contentSize: metrics.contentSize,
          scrollPosition: metrics.visualViewport,
        },
      };
    },
  };
}

export function createDetachDebuggerTool(deps: DebuggerToolDeps): AgentTool<typeof emptyInput> {
  return {
    name: 'debugger.detach',
    version: '1.0.0',
    description:
      'Detach the debugger from the current tab and dismiss its notification bar. ' +
      'Call this when page inspection is finished.',
    inputSchema: emptyInput,
    risk: 'R0',
    executionMode: 'immediate',
    siteAuthorization: 'none',
    sideEffects: ['Stops collecting console and network data.'],
    timeoutMs: 10_000,
    idempotent: true,
    classify: () => ({ summary: 'Detach the debugger.' }),

    async execute(_input, context): Promise<ToolExecutionResult> {
      const tabId = context.tabId ?? (await deps.adapter.getActiveTab())?.id;
      if (tabId === undefined) {
        throw new ToolError('TAB_NOT_FOUND', 'There is no tab to detach from.');
      }
      await deps.manager.detach(tabId);
      return { success: true, data: { detached: true, tabId } };
    },
  };
}

export function createDebuggerTools(deps: DebuggerToolDeps): AgentTool[] {
  return [
    createGetConsoleTool(deps),
    createGetNetworkTool(deps),
    createGetDomTool(deps),
    createGetPageStateTool(deps),
    createDetachDebuggerTool(deps),
  ] as AgentTool[];
}
