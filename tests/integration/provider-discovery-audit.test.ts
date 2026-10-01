/**
 * TEST-DISCAUDIT-001 — every provider's discovery reaches the audit path.
 *
 * This test exists because a census passed while the thing it certified was
 * false. `provider.listModels` and `accounts.listModels` were taken out of the
 * audit-coverage exemption table on the stated grounds that discovery is an
 * event rather than a read — it reaches an external endpoint with the account's
 * credential and decides what the user may then select — and both handlers did
 * contain an `auditLog.record`. But the record sat after an early `return`
 * taken for any provider without a model hierarchy, so a gateway recorded its
 * discovery and the other three providers recorded nothing. The census reads
 * handler *source text*, and an early return is invisible to a regex.
 *
 * So this drives the real `discoverCatalogue` with a real `AuditLog`, once for
 * every factory the build actually registers, and reads the record back. A
 * provider added without reaching the shared path fails here rather than
 * passing a text search.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { discoverCatalogue } from '@/providers/registry/discovery';
import { API_PROVIDER_FACTORIES } from '@/providers/registry/api-providers';
import { ProviderRegistry } from '@/providers/registry/provider-registry';
import { AuditLog } from '@/audit/audit-log';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { API_PROVIDER_PACKS, type ProviderWirePack } from '../fixtures/provider-wire';
import type { AIProviderAdapter } from '@/providers/core/types';
import type { ProviderTransport } from '@/security/egress/provider-transport';

const area = (): SerializedStorageArea => new SerializedStorageArea(new MemoryStorageArea());

/** The key every pack carries, so a leak into a record is detectable. */
function secretOf(pack: ProviderWirePack): string {
  return pack.config.apiKey ?? '';
}

/**
 * A transport that answers from the pack and remembers what it was asked.
 *
 * The adapter is the production one; only the socket is replaced, so the
 * credential really is placed in real headers by real code and the assertion
 * that it does not reach the record means something.
 */
function packTransport(pack: ProviderWirePack): {
  transport: ProviderTransport;
  headers: Record<string, string>[];
} {
  const headers: Record<string, string>[] = [];
  const transport: ProviderTransport = {
    request: (url, init) => {
      headers.push({ ...((init.headers ?? {}) as Record<string, string>) });
      return Promise.resolve(pack.route(url, init, () => pack.text('unused')));
    },
  };
  return { transport, headers };
}

async function connect(
  pack: ProviderWirePack,
  transport: ProviderTransport,
): Promise<AIProviderAdapter> {
  const registry = new ProviderRegistry({ transport });
  registry.register(pack.factory);
  const adapter = registry.get(pack.factory.id);
  const result = await adapter.connect(pack.config);
  expect(result.authenticated, pack.factory.id).toBe(true);
  return adapter;
}

let log: AuditLog;
let recorded: { providerId: string; discovered: number; refused: number }[];

beforeEach(() => {
  log = new AuditLog(area(), { knownTool: () => true });
  recorded = [];
});

/** The worker's recorder, assembled the way `service-worker.ts` assembles it. */
async function record(providerId: string, discovered: number, refused: number): Promise<void> {
  recorded.push({ providerId, discovered, refused });
  await log.record({
    type: 'provider.selected',
    outcome: 'info',
    providerId,
    code: 'catalogue_discovered',
    recordCount: discovered,
    ...(refused === 0 ? {} : { removedCount: refused }),
  } as never);
}

describe('TEST-DISCAUDIT-001 — the shared discovery path records for every provider', () => {
  it('01 — the suite covers exactly what the build registers', () => {
    // Otherwise the cases below could pass by covering a subset.
    expect(API_PROVIDER_PACKS.map((pack) => pack.factory.id).sort()).toEqual(
      API_PROVIDER_FACTORIES.map((factory) => factory.id).sort(),
    );
  });

  for (const pack of API_PROVIDER_PACKS) {
    it(`02 — ${pack.factory.id} discovery writes one record naming itself`, async () => {
      const { transport } = packTransport(pack);
      const adapter = await connect(pack, transport);

      const catalogue = await discoverCatalogue(adapter, pack.factory.id, record);

      // The record exists, exactly once, and names the provider that was
      // actually reached — not the generic entry whose adapter a gateway
      // happens to subclass.
      expect(recorded, pack.factory.id).toHaveLength(1);
      expect(recorded[0]!.providerId).toBe(pack.factory.id);
      expect(recorded[0]!.discovered).toBe(catalogue.models.length);

      const entries = await log.list(10);
      const discovery = entries.filter((entry) => entry.code === 'catalogue_discovered');
      expect(discovery, pack.factory.id).toHaveLength(1);
      expect(discovery[0]!.providerId).toBe(pack.factory.id);
      // The log accepted it: a record the trail refuses is not coverage.
      expect(log.degradedReason()).toBeNull();
    });

    it(`03 — ${pack.factory.id} records again on a refresh`, async () => {
      // Discovery is an event, so two discoveries are two events. A cache that
      // skipped the second would make the trail disagree with what happened.
      const { transport } = packTransport(pack);
      const adapter = await connect(pack, transport);

      await discoverCatalogue(adapter, pack.factory.id, record);
      await discoverCatalogue(adapter, pack.factory.id, record);

      expect(recorded, pack.factory.id).toHaveLength(2);
      expect(recorded.every((entry) => entry.providerId === pack.factory.id)).toBe(true);
    });

    it(`04 — ${pack.factory.id} records even when discovery returns nothing`, async () => {
      // The case the early return hid. An endpoint that answers with an empty
      // list, or does not answer at all, was still *asked* — with the
      // credential — so the attempt is the event, not the result.
      const transport: ProviderTransport = {
        request: () => Promise.resolve(pack.failure(500)),
      };
      const adapter = await connect(pack, transport);

      const catalogue = await discoverCatalogue(adapter, pack.factory.id, record);

      expect(catalogue.models, pack.factory.id).toEqual([]);
      expect(recorded, pack.factory.id).toHaveLength(1);
      expect(recorded[0]!.providerId).toBe(pack.factory.id);
      expect(recorded[0]!.discovered).toBe(0);
    });

    it(`05 — ${pack.factory.id} puts no credential in the record`, async () => {
      const { transport, headers } = packTransport(pack);
      const adapter = await connect(pack, transport);
      await discoverCatalogue(adapter, pack.factory.id, record);

      // First, that the request really did carry it — otherwise the absence
      // below would prove only that nothing happened.
      const sent = JSON.stringify(headers);
      expect(sent, `${pack.factory.id} sent its credential`).toContain(secretOf(pack));

      // And that nothing in the trail did.
      const entries = await log.list(10);
      const trail = JSON.stringify(entries);
      expect(trail).not.toContain(secretOf(pack));
      // Nor the counts carrying it in by another name.
      expect(trail).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/);
    });
  }

  it('06 — a provider that reports no hierarchy still records, and reports no groups', async () => {
    // The two halves of the defect, stated together: the flat providers are the
    // ones that used to return early, and they must now record *and* still be
    // flat. A `groups: []` would put an empty upstream selector in the panel.
    for (const pack of API_PROVIDER_PACKS) {
      recorded = [];
      log = new AuditLog(area(), { knownTool: () => true });
      const { transport } = packTransport(pack);
      const adapter = await connect(pack, transport);
      const catalogue = await discoverCatalogue(adapter, pack.factory.id, record);

      expect(recorded, pack.factory.id).toHaveLength(1);
      if (pack.factory.id === 'nine-router') {
        expect(catalogue.groups, pack.factory.id).toBeDefined();
      } else {
        expect(catalogue.groups, pack.factory.id).toBeUndefined();
      }
    }
  });
});
