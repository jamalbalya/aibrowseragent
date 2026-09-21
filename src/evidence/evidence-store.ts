/**
 * Evidence persistence.
 *
 * References and payloads are stored separately: the side panel lists
 * references without pulling megabytes of screenshots into memory, and the
 * retention cap bounds storage growth (specification section 63).
 */
import { update, type StorageArea } from '@/storage/storage-area';
import { getLogger } from '@/logging/logger';
import { redact } from '@/security/redaction/secret-redactor';
import { hashContent, type EvidencePayload, type EvidenceReference } from './evidence-model';

const log = getLogger('storage');

const INDEX_KEY = 'evidence-index';
const refKey = (id: string): string => `ev:${id}`;
const payloadKey = (id: string): string => `evp:${id}`;

interface EvidenceIndex {
  readonly ids: readonly string[];
}

export interface EvidenceStoreOptions {
  readonly maxItems?: number;
  /** Payloads larger than this are truncated before storage. */
  readonly maxPayloadBytes?: number;
}

export class EvidenceStore {
  private readonly maxItems: number;
  private readonly maxPayloadBytes: number;

  constructor(
    private readonly area: StorageArea,
    options: EvidenceStoreOptions = {},
  ) {
    this.maxItems = options.maxItems ?? 200;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 2 * 1024 * 1024;
  }

  /**
   * Stores evidence.
   *
   * Text payloads are redacted before they are written: evidence is shown in
   * the UI and can be attached to a bug report, so it must never carry a
   * credential (specification section 63).
   */
  async put(
    reference: Omit<EvidenceReference, 'byteLength' | 'hash'>,
    payload: Omit<EvidencePayload, 'id'>,
  ): Promise<EvidenceReference> {
    let content = payload.encoding === 'utf8' ? redact(payload.content) : payload.content;
    let truncated = false;
    if (content.length > this.maxPayloadBytes) {
      content = content.slice(0, this.maxPayloadBytes);
      truncated = true;
    }

    const full: EvidenceReference = {
      ...reference,
      byteLength: content.length,
      hash: await hashContent(content),
    };

    await this.area.set(payloadKey(reference.id), {
      id: reference.id,
      content,
      encoding: payload.encoding,
      mimeType: payload.mimeType,
    } satisfies EvidencePayload);
    await this.area.set(refKey(reference.id), full);
    await update<EvidenceIndex>(this.area, INDEX_KEY, { ids: [] }, (index) => ({
      ids: [reference.id, ...index.ids.filter((id) => id !== reference.id)],
    }));
    await this.evictOverflow();

    if (truncated) {
      log.debug('Evidence payload truncated to the size cap.', { evidenceId: reference.id });
    }
    return full;
  }

  getReference(id: string): Promise<EvidenceReference | undefined> {
    return this.area.get<EvidenceReference>(refKey(id));
  }

  getPayload(id: string): Promise<EvidencePayload | undefined> {
    return this.area.get<EvidencePayload>(payloadKey(id));
  }

  async listForTask(taskId: string): Promise<EvidenceReference[]> {
    const index = (await this.area.get<EvidenceIndex>(INDEX_KEY)) ?? { ids: [] };
    const out: EvidenceReference[] = [];
    for (const id of index.ids) {
      const ref = await this.area.get<EvidenceReference>(refKey(id));
      if (ref?.taskId === taskId) out.push(ref);
    }
    return out;
  }

  private async evictOverflow(): Promise<void> {
    const index = (await this.area.get<EvidenceIndex>(INDEX_KEY)) ?? { ids: [] };
    if (index.ids.length <= this.maxItems) return;
    const overflow = index.ids.slice(this.maxItems);
    for (const id of overflow) {
      await this.area.remove(refKey(id));
      await this.area.remove(payloadKey(id));
    }
    await update<EvidenceIndex>(this.area, INDEX_KEY, { ids: [] }, (current) => ({
      ids: current.ids.filter((id) => !overflow.includes(id)),
    }));
  }
}
