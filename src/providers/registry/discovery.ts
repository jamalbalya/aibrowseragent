/**
 * Discovering a provider's model catalogue — one path, for every provider.
 *
 * This exists because there were two copies of it, inline in two routes, and
 * the copies disagreed about something that mattered. Both ended with an audit
 * record, but both reached it only after an early `return` taken for any
 * provider without a model hierarchy — so a gateway recorded its discovery and
 * the other three providers recorded nothing, while the audit-coverage census
 * read the handlers' source, found `auditLog.record` in the text, and passed.
 *
 * Discovery is an event rather than a read: it reaches an external endpoint
 * with the account's credential and it decides what the user may then select.
 * That is as true of OpenAI as it is of a gateway, which is why the record is
 * written here — before anything branches on what kind of catalogue came
 * back — and why `tests/integration/provider-discovery-audit.test.ts` drives
 * this function with every registered factory rather than trusting a regex.
 *
 * The credential is not a parameter and cannot become one. It stays in the
 * adapter's request headers; what comes back out is a list of ids and two
 * counts.
 */
import { NineRouterAdapter } from '@/providers/adapters/nine-router';
import type { UpstreamKind } from '@/providers/adapters/nine-router-catalog';
import type { AIProviderAdapter } from '@/providers/core/types';

/** One model, as the panel receives it. */
export interface DiscoveredModel {
  readonly id: string;
  readonly displayName: string;
  /** Present only for a provider whose catalogue has levels. */
  readonly upstreamKey?: string;
}

/** One level of a hierarchical catalogue. */
export interface DiscoveredGroup {
  readonly key: string;
  readonly displayName: string;
  readonly kind: UpstreamKind;
  readonly modelCount: number;
}

/**
 * Mutable arrays, deliberately: this is the panel response shape, and
 * `messaging/protocol.ts` declares it that way.
 */
export interface DiscoveredCatalogue {
  readonly models: DiscoveredModel[];
  /** Omitted entirely for a provider without levels, so the panel shows a flat list. */
  readonly groups?: DiscoveredGroup[];
  /** Omitted when nothing was refused, so the panel says nothing. */
  readonly refused?: number;
}

/**
 * Writes the discovery event.
 *
 * Injected rather than imported so this module does not reach for the worker's
 * audit log, and so a test can supply a real `AuditLog` and read back what was
 * written.
 */
export type RecordDiscovery = (
  providerId: string,
  discovered: number,
  refused: number,
) => Promise<void>;

/**
 * Lists what a provider offers, records that it was asked, and returns it.
 *
 * The model id is passed through untouched. A gateway model id contains `/` in
 * the ordinary case, and this is the first of several stages that must not read
 * it as structured data — see `nine-router-catalog.ts` for what splitting it
 * costs.
 */
export async function discoverCatalogue(
  adapter: AIProviderAdapter,
  providerId: string,
  record: RecordDiscovery,
): Promise<DiscoveredCatalogue> {
  const models = await adapter.listModels();
  const listed: DiscoveredModel[] = models.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    ...(model.upstreamKey === undefined ? {} : { upstreamKey: model.upstreamKey }),
  }));

  // A provider whose catalogue is a hierarchy reports its levels; one without
  // them reports none.
  const hierarchy = adapter instanceof NineRouterAdapter ? adapter : null;
  const refused = hierarchy?.refusedCount() ?? 0;

  // Before the branch, and for every provider. This ordering is the fix.
  await record(providerId, listed.length, refused);

  if (hierarchy === null) {
    return { models: listed, ...(refused === 0 ? {} : { refused }) };
  }
  return {
    models: listed,
    groups: hierarchy.groups().map((group) => ({
      key: group.key,
      displayName: group.displayName,
      kind: group.kind,
      modelCount: group.modelCount,
    })),
    ...(refused === 0 ? {} : { refused }),
  };
}
