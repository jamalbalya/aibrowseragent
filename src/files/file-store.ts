/**
 * Staging for files a user has selected.
 *
 * **Bytes live in memory and are never written anywhere.** Not to
 * `chrome.storage`, not to evidence, not to the audit trail, not to a log.
 * The consequence is deliberate and is the point: when the MV3 service worker
 * is evicted, the bytes are gone, and a task that resumes afterwards finds its
 * staged file missing and says so.
 *
 * The alternative — persisting the contents so a resumed task could carry on —
 * would put a user's document into extension storage for as long as the task
 * lived, to save them re-picking a file. That trade is not worth making, and
 * the failure it avoids is silent: a file sitting in storage after the task
 * that needed it has finished.
 *
 * What *does* survive eviction is the security state, which is persisted
 * separately: the task stays tainted by having read a file, whether or not
 * the bytes are still here.
 */

import { getLogger } from '@/logging/logger';
import { newId } from '@/utils/ids';
import {
  MAX_ATTACHMENT_BYTES,
  type FileOrigin,
  type FileRecord,
  type StagedFile,
} from './file-model';
import type { DataSensitivity } from '@/security/exfiltration/exfiltration-guard';

const log = getLogger('agent');

export interface StageRequest {
  readonly taskId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly dataBase64: string;
  readonly byteLength: number;
  readonly origin: string;
  readonly source: FileOrigin;
  readonly sensitivity: DataSensitivity;
}

export interface StagedFileStoreOptions {
  /** Ceiling across every task, so staging cannot grow without bound. */
  readonly maxTotalBytes?: number;
  readonly now?: () => number;
}

/**
 * Files staged for the current run, keyed by task.
 *
 * Scoped by task rather than global so one task can never attach a file
 * another task's user selected — the ids are unguessable, but a lookup that
 * ignored the task would make that a matter of not guessing rather than of
 * not being able to.
 */
export class StagedFileStore {
  private readonly byTask = new Map<string, Map<string, StagedFile>>();
  private readonly maxTotalBytes: number;
  private readonly now: () => number;
  private totalBytes = 0;

  constructor(options: StagedFileStoreOptions = {}) {
    this.maxTotalBytes = options.maxTotalBytes ?? MAX_ATTACHMENT_BYTES * 2;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Stages one file and returns its record.
   *
   * Throws when the store is full rather than evicting something: an eviction
   * would make a later attach fail for a reason unrelated to the task that
   * caused it, and the caller can report a full store plainly.
   */
  stage(request: StageRequest): FileRecord {
    if (this.totalBytes + request.byteLength > this.maxTotalBytes) {
      throw new Error(
        'No room to hold another file. Finish or cancel the tasks currently holding files.',
      );
    }

    const record: FileRecord = {
      id: newId('file'),
      taskId: request.taskId,
      origin: request.origin,
      source: request.source,
      name: request.name,
      mimeType: request.mimeType,
      byteLength: request.byteLength,
      sensitivity: request.sensitivity,
      createdAt: this.now(),
    };

    const forTask = this.byTask.get(request.taskId) ?? new Map<string, StagedFile>();
    forTask.set(record.id, { record, dataBase64: request.dataBase64 });
    this.byTask.set(request.taskId, forTask);
    this.totalBytes += request.byteLength;

    // The name is metadata the user chose; the contents are not logged.
    log.debug('File staged for a task.', {
      taskId: request.taskId,
      fileId: record.id,
      byteLength: record.byteLength,
    });
    return record;
  }

  /** The staged file, or `undefined` when it belongs to another task or is gone. */
  get(taskId: string, fileId: string): StagedFile | undefined {
    return this.byTask.get(taskId)?.get(fileId);
  }

  /** Records only — callers that list files never get the bytes. */
  listForTask(taskId: string): FileRecord[] {
    return [...(this.byTask.get(taskId)?.values() ?? [])].map((staged) => staged.record);
  }

  has(taskId: string, fileId: string): boolean {
    return this.byTask.get(taskId)?.has(fileId) === true;
  }

  /** Drops everything a task staged. Called when the task reaches a terminal state. */
  clearTask(taskId: string): void {
    const forTask = this.byTask.get(taskId);
    if (!forTask) return;
    for (const staged of forTask.values()) this.totalBytes -= staged.record.byteLength;
    this.byTask.delete(taskId);
  }

  clearAll(): void {
    this.byTask.clear();
    this.totalBytes = 0;
  }

  get bytesHeld(): number {
    return this.totalBytes;
  }
}
