/**
 * File tools (P-009, P-010, P-011).
 *
 * Three tools rather than one "upload", because a file reaching a website is
 * four distinct events and only two of them belong to the extension:
 *
 *   A  the user selects a local file   `files.select`     — needs a person
 *   B  the extension reads it          `files.select`     — adds taint
 *   C  it is put into a page input     `browser.attach_file` — an egress
 *   D  the site transmits it           the page's own submit — already gated
 *
 * `files.select` is the only route to local bytes and it cannot run without
 * someone choosing a file; it takes no path and there is nowhere in its
 * schema to put one. `browser.attach_file` is where the bytes cross out of
 * the extension, so that is where the egress gate fires — not at form
 * submission, because a page can read `input.files` the instant it is set and
 * waiting for a submit would gate an event that has already happened.
 *
 * `browser.download` is the inbound direction. It is still an egress: the
 * browser fetches a URL the model chose, and a URL can carry task data in its
 * query string.
 */
import { z } from 'zod';
import { ToolError } from '@/types/result';
import { getLogger } from '@/logging/logger';
import { newEvidenceId } from '@/utils/ids';
import { noEgress, urlDestination } from '@/security/egress/destination';
import { canonicalUrlIdentity } from '@/security/egress/destination';
import { checkNavigable } from '@/security/origin/origin-validator';
import { parseOrigin, siteOf } from '@/security/origin/origin-validator';
import {
  checkSelectionSize,
  describeFiles,
  downloadTaint,
  formatBytes,
  localFileTaint,
  safeDisplayName,
  type FileRecord,
} from '@/files/file-model';
import { checkDownloadFilename, filenameFromUrl } from '@/files/download-safety';
import type { StagedFileStore } from '@/files/file-store';
import type { FileSelectionBroker } from '@/background/file-broker';
import type { DownloadPort } from '@/files/download-port';
import type { BrowserAdapter } from '@/tools/browser/chrome-adapter';
import type { AgentTool, ToolExecutionResult } from '@/tools/core/tool-types';
import { MessagingError } from '@/messaging/bus';

const log = getLogger('agent');

/**
 * A file event for the audit trail.
 *
 * Deliberately narrow: what happened, to which named file, from or to where,
 * and how big it was. There is no field for contents, and the audit log
 * rejects one if a caller tries to spread it in.
 */
export interface FileAuditEvent {
  readonly type: 'file.attached' | 'file.downloaded';
  readonly taskId: string;
  readonly outcome: 'allowed' | 'denied' | 'failed';
  readonly tool: string;
  readonly fileName?: string;
  readonly mimeType?: string;
  readonly byteLength?: number;
  readonly origin?: string;
  readonly destination?: string;
  readonly code?: string;
  readonly detail?: string;
}

export interface FileToolDeps {
  readonly adapter: BrowserAdapter;
  readonly broker: FileSelectionBroker;
  readonly store: StagedFileStore;
  readonly downloads: DownloadPort;
  /** Records a file event. A failure here never fails the operation. */
  readonly recordFileEvent?: (event: FileAuditEvent) => Promise<void>;
}

/**
 * The registrable site a URL belongs to.
 *
 * `siteOf` takes a hostname, not a URL. Handing it a whole URL returns the
 * URL unchanged, which would then travel as a taint "site" and as an audit
 * origin — neither of which would match anything, quietly weakening both.
 */
function siteOfUrl(url: string): string {
  const parsed = parseOrigin(url);
  return parsed ? siteOf(parsed.hostname) : 'unknown';
}

/** The canonical destination identity, or nothing when the URL is unusable. */
function destinationField(url: string | undefined): { destination?: string } {
  if (url === undefined) return {};
  const identity = canonicalUrlIdentity(url);
  return identity === null ? {} : { destination: identity };
}

/** Records an audit event without letting the record become a failure path. */
async function audit(deps: FileToolDeps, event: FileAuditEvent): Promise<void> {
  if (!deps.recordFileEvent) return;
  try {
    await deps.recordFileEvent(event);
  } catch (error) {
    log.warn('Could not record a file audit event.', {
      type: event.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// A + B — the user selects a file, and the extension reads it
// ---------------------------------------------------------------------------

const selectInput = z.object({
  purpose: z
    .string()
    .min(3)
    .max(200)
    .describe(
      'Why a file is needed, shown to the user so they can judge the request. ' +
        'For example: "the CV to attach to this application form".',
    ),
  multiple: z.boolean().optional().describe('Whether more than one file may be chosen.'),
  accept: z
    .string()
    .max(200)
    .optional()
    .describe('Optional accept hint copied from the page’s file input, e.g. ".pdf,image/*".'),
});

export function createSelectFileTool({
  broker,
  store,
}: FileToolDeps): AgentTool<typeof selectInput> {
  return {
    name: 'files.select',
    version: '1.0.0',
    description:
      'Ask the user to choose a file from their computer. Returns only the name, type and ' +
      'size — never the contents, and never a path. There is no way to name a file for the ' +
      'user; they choose it themselves in the browser’s file picker.',
    inputSchema: selectInput,
    risk: 'R2',
    executionMode: 'immediate',
    siteAuthorization: 'none',
    sideEffects: [
      'Asks the user to choose a file.',
      'Brings the contents of that file into the task.',
    ],
    timeoutMs: 15 * 60 * 1000,
    idempotent: false,
    classify: (input) => ({
      // Reading a local file introduces data the task did not have. It leaves
      // nothing, so there is no destination — but the declaration is explicit
      // rather than omitted, so "this transfers nothing" is on the record.
      egress: { destination: noEgress() },
      summary: `Ask the user to choose ${input.multiple ? 'one or more files' : 'a file'}: ${input.purpose}`,
    }),

    async execute(input, context): Promise<ToolExecutionResult> {
      const response = await broker.request({
        taskId: context.taskId,
        purpose: input.purpose,
        multiple: input.multiple ?? false,
        ...(input.accept === undefined ? {} : { accept: input.accept }),
        ...(context.currentUrl === undefined
          ? {}
          : { destinationOrigin: canonicalUrlIdentity(context.currentUrl) ?? context.currentUrl }),
      });

      if (response.kind === 'cancelled') {
        // Not an error the model should retry its way around: the user said
        // no, or said nothing. Reported as a refusal it can act on.
        throw new ToolError(
          'USER_CANCELLED',
          response.reason ?? 'The user did not choose a file.',
          {
            userMessage: response.reason ?? 'No file was chosen.',
            retryable: false,
          },
        );
      }

      const sizeCheck = checkSelectionSize(
        response.files.map((file) => ({ name: file.name, byteLength: file.byteLength })),
      );
      if (!sizeCheck.ok) {
        throw new ToolError('INVALID_ARGUMENT', sizeCheck.reason ?? 'The selection was refused.', {
          userMessage: sizeCheck.reason ?? 'The selection was refused.',
        });
      }

      const records: FileRecord[] = [];
      for (const file of response.files) {
        records.push(
          store.stage({
            taskId: context.taskId,
            name: safeDisplayName(file.name),
            mimeType: file.mimeType || 'application/octet-stream',
            dataBase64: file.dataBase64,
            byteLength: file.byteLength,
            // The picker gives a basename and nothing else. There is no
            // directory to record, which is the behaviour this wants anyway.
            origin: 'local',
            source: 'local_selection',
            sensitivity: 'confidential',
          }),
        );
      }

      // Evidence that a file entered the task, with no part of the file in it.
      context.recordEvidence(
        {
          id: newEvidenceId(),
          type: 'FILE',
          taskId: context.taskId,
          toolCallId: context.toolCallId,
          sourceTool: 'files.select',
          createdAt: Date.now(),
          sensitivity: 'confidential',
          trust: 'user_intent',
          origin: 'local',
          label: `User selected ${describeFiles(records)}`,
        },
        {
          content: JSON.stringify({
            files: records.map((record) => ({
              id: record.id,
              name: record.name,
              mimeType: record.mimeType,
              byteLength: record.byteLength,
            })),
          }),
          encoding: 'utf8',
          mimeType: 'application/json',
        },
      );

      return {
        success: true,
        data: {
          files: records.map((record) => ({
            fileId: record.id,
            name: record.name,
            mimeType: record.mimeType,
            byteLength: record.byteLength,
            size: formatBytes(record.byteLength),
          })),
        },
        // The task is now carrying the user's file. Monotone: this never comes
        // off, and it travels with the task to any provider it later talks to.
        taint: [localFileTaint()],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// C — the file crosses into the page
// ---------------------------------------------------------------------------

const attachInput = z.object({
  elementId: z.string().min(1).describe('Handle of a file input from browser.read_page.'),
  fileIds: z
    .array(z.string().min(1))
    .min(1)
    .max(10)
    .describe('File ids returned by files.select. Only files this task selected can be used.'),
});

export function createAttachFileTool(deps: FileToolDeps): AgentTool<typeof attachInput> {
  const { adapter, store } = deps;
  return {
    name: 'browser.attach_file',
    version: '1.0.0',
    description:
      'Put files the user already chose into a file input on the page. Only accepts file ids ' +
      'from files.select in this same task.',
    inputSchema: attachInput,
    risk: 'R3',
    executionMode: 'requires_page',
    siteAuthorization: 'page',
    sideEffects: ['Sends the contents of the chosen files to the current website.'],
    timeoutMs: 60_000,
    idempotent: false,
    classify: (input, context) => {
      const records = input.fileIds
        .map((id) => store.get(context.taskId, id)?.record)
        .filter((record): record is FileRecord => record !== undefined);

      return {
        summary:
          records.length === 0
            ? `Attach ${input.fileIds.length} file(s) to element ${input.elementId}.`
            : `Send ${describeFiles(records)} to ${context.currentUrl ?? 'this page'}.`,
        // This is the boundary. Once the bytes are in `input.files` the page
        // can read them with its own JavaScript, so the transfer has happened
        // whether or not a form is ever submitted.
        egress: {
          destination: urlDestination('page_write', context.currentUrl ?? '', {
            ...(context.tabId === undefined ? {} : { tabId: context.tabId }),
          }),
          // A file is the highest-capacity carrier the agent has.
          carrier: { writesValue: true },
          // Names and sizes, never contents: the payload is digested into
          // evidence, and a digest over megabytes of file would tell nobody
          // anything while putting the file through the redaction scanner.
          payload: records.map((record) => ({
            name: record.name,
            mimeType: record.mimeType,
            byteLength: record.byteLength,
          })),
        },
      };
    },

    async execute(input, context): Promise<ToolExecutionResult> {
      const tabId = context.tabId;
      if (tabId === undefined) {
        throw new ToolError('TAB_NOT_FOUND', 'There is no tab to attach a file to.');
      }
      const tab = await adapter.getTab(tabId);
      if (!tab) {
        throw new ToolError('TAB_NOT_FOUND', 'That tab was closed.');
      }
      const navigable = checkNavigable(tab.url);
      if (!navigable.allowed) {
        throw new ToolError('POLICY_BLOCKED', navigable.detail ?? 'This page cannot be automated.');
      }

      const staged = input.fileIds.map((id) => {
        const file = store.get(context.taskId, id);
        if (!file) {
          // Either the id is wrong, or the worker restarted and the bytes are
          // gone. Both are reported plainly: the alternative is telling the
          // model a file was attached when nothing was.
          throw new ToolError('INVALID_ARGUMENT', `File "${id}" is not available to this task.`, {
            userMessage:
              'That file is no longer held by the extension. Ask the user to choose it again.',
            retryable: false,
          });
        }
        return file;
      });

      try {
        const result = await adapter.callContent(tabId, 'content.attachFiles', {
          elementId: input.elementId,
          files: staged.map((file) => ({
            name: file.record.name,
            mimeType: file.record.mimeType,
            dataBase64: file.dataBase64,
          })),
        });

        log.info('Files attached to a page input.', {
          taskId: context.taskId,
          count: result.attached,
          hiddenInput: result.inputWasHidden,
        });

        for (const file of staged) {
          await audit(deps, {
            type: 'file.attached',
            taskId: context.taskId,
            tool: 'browser.attach_file',
            outcome: 'allowed',
            fileName: file.record.name,
            mimeType: file.record.mimeType,
            byteLength: file.record.byteLength,
            origin: 'local',
            ...destinationField(context.currentUrl),
            detail: result.inputWasHidden
              ? 'Attached to a file input the page keeps hidden behind its own control.'
              : 'Attached to a visible file input.',
          });
        }

        return {
          success: true,
          data: {
            attached: result.attached,
            names: result.names,
            // Surfaced rather than hidden: an input the user cannot see is
            // worth the model and the trail both knowing about.
            inputWasHidden: result.inputWasHidden,
          },
          // The page now has the file. It contributed nothing new to read, but
          // the task's existing file taint already covers what was sent.
          taint: [localFileTaint()],
        };
      } catch (error) {
        if (error instanceof MessagingError) {
          throw new ToolError(error.agentError.code, error.agentError.message, {
            userMessage: error.agentError.userMessage,
            retryable: error.agentError.retryable,
          });
        }
        throw new ToolError('INTERNAL_ERROR', 'The page did not accept the files.');
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

const downloadInput = z.object({
  url: z.string().url().describe('URL of the file to download.'),
  filename: z
    .string()
    .max(200)
    .optional()
    .describe('Plain filename to save as, with no directories. Defaults to the name in the URL.'),
});

export function createDownloadTool(deps: FileToolDeps): AgentTool<typeof downloadInput> {
  const { downloads } = deps;
  return {
    name: 'browser.download',
    version: '1.0.0',
    description:
      'Download a file to the browser’s download folder. The filename is a plain name with no ' +
      'directories; executables, installers, scripts and browser extensions are refused.',
    inputSchema: downloadInput,
    risk: 'R3',
    executionMode: 'immediate',
    siteAuthorization: 'destination',
    sideEffects: ['Writes a file to the browser’s download folder.'],
    timeoutMs: 5 * 60 * 1000,
    idempotent: false,
    classify: (input) => {
      const requested = input.filename ?? filenameFromUrl(input.url);
      return {
        summary: `Download ${safeDisplayName(requested)} from ${siteOfUrl(input.url)}.`,
        // A download is an egress in the outbound direction too: the browser
        // fetches a URL the model chose, and a URL carries whatever the model
        // put in its query string.
        egress: {
          destination: urlDestination('download', input.url, {}),
          carrier: { url: input.url },
          payload: input.url,
        },
      };
    },

    async execute(input, context): Promise<ToolExecutionResult> {
      const navigable = checkNavigable(input.url);
      if (!navigable.allowed) {
        throw new ToolError(
          'POLICY_BLOCKED',
          navigable.detail ?? 'That URL cannot be downloaded from.',
        );
      }

      const verdict = checkDownloadFilename(input.filename ?? filenameFromUrl(input.url));
      if (!verdict.ok) {
        // Recorded as a refusal, because a rejected filename is exactly the
        // kind of attempt a trail should show.
        await audit(deps, {
          type: 'file.downloaded',
          taskId: context.taskId,
          tool: 'browser.download',
          outcome: 'denied',
          code: verdict.code,
          origin: siteOfUrl(input.url),
          detail: 'The requested filename was refused.',
        });
        throw new ToolError('INVALID_ARGUMENT', verdict.reason, {
          userMessage: verdict.reason,
          retryable: false,
        });
      }

      if (!(await downloads.isPermitted())) {
        throw new ToolError('PERMISSION_DENIED', 'The downloads permission has not been granted.', {
          userMessage:
            'Downloading needs the browser’s downloads permission, which is off by default. ' +
            'Turn it on in Settings and try again.',
          retryable: false,
        });
      }

      let id: number;
      try {
        id = await downloads.start({ url: input.url, filename: verdict.filename });
      } catch (error) {
        throw new ToolError('NETWORK_ERROR', 'The download could not be started.', {
          userMessage: 'The browser refused to start that download.',
          technicalDetails: error instanceof Error ? error.message : String(error),
        });
      }

      const outcome = await downloads.awaitCompletion(id, context.signal);

      if (outcome.state !== 'complete') {
        await audit(deps, {
          type: 'file.downloaded',
          taskId: context.taskId,
          tool: 'browser.download',
          outcome: outcome.state === 'cancelled' ? 'denied' : 'failed',
          fileName: verdict.filename,
          origin: siteOfUrl(input.url),
          ...(outcome.error === undefined ? {} : { code: outcome.error }),
          detail:
            outcome.state === 'cancelled'
              ? 'The download was cancelled.'
              : 'The download did not finish.',
        });
        throw new ToolError(
          outcome.state === 'cancelled' ? 'USER_CANCELLED' : 'NETWORK_ERROR',
          `The download did not finish (${outcome.error ?? outcome.state}).`,
          {
            userMessage:
              outcome.state === 'cancelled'
                ? 'The download was cancelled.'
                : 'The download did not finish.',
            retryable: outcome.state !== 'cancelled',
          },
        );
      }

      const site = siteOfUrl(input.url);
      // Chrome may have uniquified the name to avoid overwriting a file, so
      // what is reported is what actually landed on disk, not what was asked
      // for.
      const savedAs = outcome.filename ?? verdict.filename;

      context.recordEvidence(
        {
          id: newEvidenceId(),
          type: 'FILE',
          taskId: context.taskId,
          toolCallId: context.toolCallId,
          sourceTool: 'browser.download',
          createdAt: Date.now(),
          sensitivity: 'internal',
          // A downloaded file is page-controlled content, whatever it is.
          trust: 'untrusted_external_content',
          origin: site,
          label: `Downloaded ${savedAs}`,
        },
        {
          content: JSON.stringify({
            savedAs,
            mimeType: outcome.mimeType,
            byteLength: outcome.byteLength,
            origin: site,
          }),
          encoding: 'utf8',
          mimeType: 'application/json',
        },
      );

      await audit(deps, {
        type: 'file.downloaded',
        taskId: context.taskId,
        tool: 'browser.download',
        outcome: 'allowed',
        fileName: savedAs,
        origin: site,
        ...(outcome.mimeType === undefined ? {} : { mimeType: outcome.mimeType }),
        ...(outcome.byteLength === undefined ? {} : { byteLength: outcome.byteLength }),
        ...(savedAs === verdict.filename
          ? {}
          : {
              detail: 'Saved under a different name because a file of that name already existed.',
            }),
      });

      return {
        success: true,
        data: {
          savedAs,
          ...(outcome.byteLength === undefined ? {} : { byteLength: outcome.byteLength }),
          ...(outcome.mimeType === undefined ? {} : { mimeType: outcome.mimeType }),
          renamed: savedAs !== verdict.filename,
        },
        // The task has now caused content from that site to be written to
        // disk, which is provenance the rest of the task should carry.
        taint: [downloadTaint(site)],
      };
    },
  };
}

export function createFileTools(deps: FileToolDeps): AgentTool[] {
  return [
    createSelectFileTool(deps),
    createAttachFileTool(deps),
    createDownloadTool(deps),
  ] as AgentTool[];
}
