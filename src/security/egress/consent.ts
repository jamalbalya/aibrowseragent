/**
 * Egress consent (Stage 3 B2, roadmap section 4K).
 *
 * The key is `(task, destination identity, taint signature, sensitivity
 * ceiling, channel)`.
 *
 * `(task, destination)` alone was the original design and is insufficient: it
 * permits exactly the failure consent exists to prevent. The user approves
 * sending one page to a provider, the task then reads a second and more
 * sensitive page, and the grant still matches because neither task nor
 * destination changed. Including a signature over the taint set means any new
 * source invalidates the grant.
 *
 * Tab and frame are deliberately absent. They are properties of the *source*
 * and already reach the key through the signature — reading a new tab adds a
 * source, which changes it. Adding them as key fields as well would void
 * grants for ordinary navigation inside one origin without preventing
 * anything.
 *
 * Connecting a provider authorises a *channel*. It authorises no payload.
 */

import { hashContent } from '@/evidence/evidence-model';
import { canonicalTaintPayload, type TaintState } from '@/security/taint/taint-state';
import type { DataSensitivity } from '@/security/exfiltration/exfiltration-guard';
import type { EgressChannel } from './destination';

const SENSITIVITY_RANK: Record<DataSensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  secret: 3,
};

export interface ConsentKey {
  readonly taskId: string;
  readonly destinationIdentity: string;
  readonly taintSignature: string;
  readonly sensitivityCeiling: DataSensitivity;
  readonly channel: EgressChannel;
}

/** The provider destination, including model, a task is bound to. */
export interface ProviderPin {
  readonly identity: string;
  readonly modelId: string;
}

export interface ConsentGrant extends ConsentKey {
  readonly grantedAt: number;
  readonly expiresAt: number;
  readonly providerId?: string;
  readonly modelId?: string;
}

export async function taintSignature(state: TaintState): Promise<string> {
  return hashContent(canonicalTaintPayload(state));
}

/** Serialised key, used as the store's lookup. */
function keyString(key: ConsentKey): string {
  return [
    key.taskId,
    key.channel,
    key.destinationIdentity,
    key.taintSignature,
    key.sensitivityCeiling,
  ].join('\u0000');
}

export interface ConsentLookup {
  readonly key: ConsentKey;
  readonly now: number;
  readonly providerId?: string;
  readonly modelId?: string;
}

/**
 * In-memory grants for the current worker generation.
 *
 * Deliberately not persisted. A grant that survived a restart would outlive
 * the context the user saw when giving it, and re-asking after a restart is
 * the conservative direction.
 */
export class ConsentStore {
  private readonly grants = new Map<string, ConsentGrant>();
  private readonly providerPins = new Map<string, ProviderPin>();

  /** Default lifetime. A backstop — the key, not the clock, is the control. */
  constructor(private readonly ttlMs: number = 15 * 60_000) {}

  grant(
    key: ConsentKey,
    now: number,
    context: { providerId?: string; modelId?: string } = {},
  ): ConsentGrant {
    const record: ConsentGrant = {
      ...key,
      grantedAt: now,
      expiresAt: now + this.ttlMs,
      ...(context.providerId === undefined ? {} : { providerId: context.providerId }),
      ...(context.modelId === undefined ? {} : { modelId: context.modelId }),
    };
    this.grants.set(keyString(key), record);
    return record;
  }

  /**
   * Looks a grant up.
   *
   * Every field of the key participates, so a changed destination, a grown
   * taint set, a different channel or a raised sensitivity simply fails to
   * match — there is no separate invalidation pass to forget to run. Provider
   * and model are checked too: a grant given for one model does not carry to
   * another, because the user was told which one they were sending to.
   */
  find(lookup: ConsentLookup): ConsentGrant | undefined {
    const record = this.grants.get(keyString(lookup.key));
    if (!record) return undefined;
    if (record.expiresAt <= lookup.now) {
      this.grants.delete(keyString(lookup.key));
      return undefined;
    }
    if (lookup.providerId !== undefined && record.providerId !== lookup.providerId)
      return undefined;
    if (lookup.modelId !== undefined && record.modelId !== lookup.modelId) return undefined;
    return record;
  }

  /**
   * The provider destination a task is bound to.
   *
   * Pinned on the task's first provider request and compared on every one
   * after it. The user picked a provider, connected it, and started the task
   * against it, so sending that task's data there is the thing they asked
   * for — prompting per model turn would be a prompt nobody can act on,
   * fired dozens of times a task, which is how confirmation dialogs stop
   * being read.
   *
   * What the pin does buy is the case that matters: if the destination
   * changes mid-task — a different provider, a different endpoint origin —
   * the pin no longer matches and the transfer needs consent. Provider
   * switching re-evaluates rather than inheriting.
   *
   * The pinned value comes from user configuration and never from model
   * output, so the model cannot steer a task onto a destination of its own.
   */
  pinProvider(taskId: string, pin: ProviderPin): void {
    if (!this.providerPins.has(taskId)) this.providerPins.set(taskId, pin);
  }

  pinnedProvider(taskId: string): ProviderPin | undefined {
    return this.providerPins.get(taskId);
  }

  /**
   * Whether a destination is the one this task is bound to.
   *
   * The model is part of the comparison, not just the endpoint. Two models at
   * one endpoint are two different recipients of the data, and the user was
   * told which one they were sending to when the task started. A switch
   * between them is a switch, and falls through to consent like any other.
   */
  matchesPin(taskId: string, pin: ProviderPin): boolean {
    const existing = this.providerPins.get(taskId);
    if (existing === undefined) return false;
    return existing.identity === pin.identity && existing.modelId === pin.modelId;
  }

  /** Explicit revocation, and the sweep used when policy or a session changes. */
  revoke(key: ConsentKey): void {
    this.grants.delete(keyString(key));
  }

  revokeTask(taskId: string): void {
    for (const [stored, grant] of this.grants) {
      if (grant.taskId === taskId) this.grants.delete(stored);
    }
    this.providerPins.delete(taskId);
  }

  revokeAll(): void {
    this.grants.clear();
    this.providerPins.clear();
  }

  get size(): number {
    return this.grants.size;
  }
}

export function exceedsCeiling(ceiling: DataSensitivity, actual: DataSensitivity): boolean {
  return SENSITIVITY_RANK[actual] > SENSITIVITY_RANK[ceiling];
}
