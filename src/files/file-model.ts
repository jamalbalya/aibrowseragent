/**
 * The file record and its limits (specification section 68).
 *
 * A file the agent handles is described by this record and by nothing else.
 * The record is metadata: origin, name, type, size, sensitivity and the task
 * it belongs to. Contents are deliberately absent, and there is nowhere in
 * this type to put them — the same discipline the evidence and audit models
 * already follow, applied at the point where file bytes enter the system.
 *
 * Four operations are kept apart throughout this module and the tools built
 * on it, because they are four different security events and collapsing them
 * would hide three of them:
 *
 *   A  the user selects a local file            — the only route to local bytes
 *   B  the extension reads it                   — task-derived data appears
 *   C  the extension puts it in a page input    — it crosses into the page
 *   D  the site transmits it                    — an ordinary page action
 *
 * `A` requires a person. `B` adds taint. `C` is an egress. `D` is a separate
 * action the existing tools already gate. Nothing here performs `A` without a
 * human, and nothing performs `C` without the gate.
 */

import type { DataSensitivity, TaintSource } from '@/security/exfiltration/exfiltration-guard';

/**
 * Per-file and per-attachment ceilings.
 *
 * Bytes travel from the side panel to the worker and on to a content script
 * as base64 over extension messaging, which is a JSON channel — so a large
 * file costs roughly 4/3 its size in a single message, twice. The limits keep
 * that bounded, and a file over the cap is refused with its size rather than
 * truncated: half a file uploaded is worse than no file uploaded.
 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024;
export const MAX_FILES_PER_SELECTION = 10;

/** Where a file came from. Not a trust level — both are untrusted content. */
export type FileOrigin = 'local_selection' | 'download';

/**
 * A file, as everything above the byte layer sees it.
 *
 * `name` is a basename. The browser's file picker never exposes a full path
 * to an extension, and that is the behaviour this model wants anyway: a path
 * says where a person keeps their files, which is not needed to attach one to
 * a form.
 */
export interface FileRecord {
  readonly id: string;
  readonly taskId: string;
  /** `local` for a user selection, or the canonical origin of a download. */
  readonly origin: string;
  readonly source: FileOrigin;
  readonly name: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly sensitivity: DataSensitivity;
  readonly createdAt: number;
}

/** Bytes plus the record describing them. Never persisted, never logged. */
export interface StagedFile {
  readonly record: FileRecord;
  /** Base64, because extension messaging is a JSON channel. */
  readonly dataBase64: string;
}

/**
 * The last path segment.
 *
 * Applied even though a browser `File` already carries only a basename: the
 * name can also arrive from a model, a page, or a download's
 * `Content-Disposition`, and any of those can contain separators. Both
 * separators are handled because a name is not necessarily written in the
 * convention of the machine reading it.
 */
export function basename(raw: string): string {
  const afterSlash = raw.slice(raw.lastIndexOf('/') + 1);
  return afterSlash.slice(afterSlash.lastIndexOf('\\') + 1);
}

/**
 * A name that is safe to put in a record, a prompt or the UI.
 *
 * Control characters are removed rather than escaped: a name containing a
 * newline or an ANSI escape can misrepresent what a permission prompt is
 * asking about, and a filename has no legitimate use for either.
 */
export function safeDisplayName(raw: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point.
  const stripped = basename(raw).replace(/[\u0000-\u001f\u007f]/g, '');
  const trimmed = stripped.trim();
  return trimmed.length === 0 ? 'unnamed' : trimmed.slice(0, 255);
}

/**
 * Taint contributed by reading a local file.
 *
 * `confidential` and no `site`, both deliberately. A file a person chose from
 * their own machine is treated as at least as sensitive as an intranet page,
 * and the absent site means it can never match a destination — so sending it
 * anywhere is a transfer to somewhere the data did not come from, and needs
 * consent rather than being waved through as "same origin".
 */
export function localFileTaint(): TaintSource {
  return { sourceType: 'local_file', sensitivity: 'confidential' };
}

/** Taint contributed by a file downloaded from a site. */
export function downloadTaint(site: string): TaintSource {
  return { sourceType: 'download', site, sensitivity: 'internal' };
}

/** Human-readable summary for a permission prompt. Names and sizes only. */
export function describeFiles(records: readonly FileRecord[]): string {
  if (records.length === 0) return 'no files';
  if (records.length === 1) {
    const only = records[0]!;
    return `${only.name} (${formatBytes(only.byteLength)})`;
  }
  const total = records.reduce((sum, record) => sum + record.byteLength, 0);
  return `${records.length} files (${formatBytes(total)})`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface SizeVerdict {
  readonly ok: boolean;
  readonly reason?: string;
}

/** Checks one selection against the per-file, total and count ceilings. */
export function checkSelectionSize(
  sizes: readonly { name: string; byteLength: number }[],
): SizeVerdict {
  if (sizes.length === 0) return { ok: false, reason: 'No file was selected.' };
  if (sizes.length > MAX_FILES_PER_SELECTION) {
    return {
      ok: false,
      reason: `At most ${MAX_FILES_PER_SELECTION} files can be selected at once; ${sizes.length} were chosen.`,
    };
  }
  for (const entry of sizes) {
    if (entry.byteLength > MAX_FILE_BYTES) {
      return {
        ok: false,
        reason: `"${entry.name}" is ${formatBytes(entry.byteLength)}, over the ${formatBytes(MAX_FILE_BYTES)} limit.`,
      };
    }
  }
  const total = sizes.reduce((sum, entry) => sum + entry.byteLength, 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      reason: `The selection totals ${formatBytes(total)}, over the ${formatBytes(MAX_ATTACHMENT_BYTES)} limit.`,
    };
  }
  return { ok: true };
}

/**
 * Whether a file satisfies an `accept` attribute.
 *
 * Advisory, and used to explain a refusal rather than to enforce one — the
 * page enforces its own `accept` and this only avoids attaching something the
 * form will visibly reject. An unparseable or absent `accept` accepts
 * everything, which is what the attribute means.
 */
export function matchesAccept(accept: string | undefined, name: string, mimeType: string): boolean {
  if (!accept || accept.trim().length === 0) return true;

  const lowerName = name.toLowerCase();
  const lowerType = mimeType.toLowerCase();

  return accept
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0)
    .some((token) => {
      if (token.startsWith('.')) return lowerName.endsWith(token);
      if (token.endsWith('/*')) return lowerType.startsWith(token.slice(0, -1));
      return lowerType === token;
    });
}
