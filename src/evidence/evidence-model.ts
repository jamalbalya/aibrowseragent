/**
 * Evidence model (specification sections 28, 61, 62).
 *
 * Every meaningful action can produce evidence that is traceable back to the
 * task and tool call that created it. Evidence carries provenance and a
 * sensitivity label so the UI and the exfiltration guard can reason about it.
 */
import type { TrustLevel } from '@/security/prompt-injection/untrusted-content';
import type { DataSensitivity } from '@/security/exfiltration/exfiltration-guard';

export const EVIDENCE_TYPES = [
  'SCREENSHOT',
  'DOM',
  'CONSOLE',
  'NETWORK',
  'TEXT',
  'API_RESPONSE',
  'FILE',
  'USER_APPROVAL',
] as const;

export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export interface EvidenceReference {
  readonly id: string;
  readonly type: EvidenceType;
  readonly taskId: string;
  readonly toolCallId?: string;
  readonly sourceTool: string;
  readonly createdAt: number;
  readonly sensitivity: DataSensitivity;
  readonly trust: TrustLevel;
  /** Origin or connector the evidence came from. */
  readonly origin?: string;
  /** Short label shown in the UI. */
  readonly label: string;
  /** Size of the stored payload in bytes. */
  readonly byteLength: number;
  /** SHA-256 of the payload, for integrity checks. */
  readonly hash?: string;
}

/** Stored payload, kept separate so listing evidence does not load blobs. */
export interface EvidencePayload {
  readonly id: string;
  /** Text, or base64 for binary types such as screenshots. */
  readonly content: string;
  readonly encoding: 'utf8' | 'base64';
  readonly mimeType: string;
}

export async function hashContent(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
