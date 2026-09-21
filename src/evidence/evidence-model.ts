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
  'EGRESS_DECISION',
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

/**
 * Keyed digest for egress evidence.
 *
 * A bare SHA-256 of an outbound payload is a side channel in its own right.
 * Payloads are often low entropy — a six-digit code, an email address, a
 * short form field — and a bare digest of one is recovered by brute force in
 * seconds. Equal digests across tasks would also reveal that two payloads
 * matched, which is exactly the correlation the evidence is meant to avoid.
 *
 * The key is per task and is never written into evidence, so a digest stays
 * useful for integrity and duplicate detection inside one task while carrying
 * nothing across tasks. There is deliberately no unkeyed fallback: a missing
 * salt is repaired by rotating to a new one and bumping the epoch, never by
 * quietly reverting to a plain hash.
 */
export async function hmacContent(saltHex: string, content: string): Promise<string> {
  if (saltHex.length === 0) {
    throw new Error('Refusing to digest egress evidence without a task salt.');
  }
  const keyBytes = new Uint8Array(
    (saltHex.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)),
  );
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(content));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashContent(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
