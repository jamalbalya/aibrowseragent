/**
 * TEST-SECURITY-055 — the installation identity, and the seven things it is not.
 *
 * The extension is standalone, so something has to say whose data this is
 * without asking a server. That value is a **partition label**: it decides
 * which rows a reader is shown and nothing else. These cases hold both halves
 * — that it exists and survives, and that it cannot be used as a credential.
 *
 * The negative half matters more than it looks. An owner id is exactly the
 * shape of thing that quietly becomes an authenticator: it is stable, it is
 * unique, and it is already threaded through the code. So several cases below
 * assert absence — no network, no provider coupling, no authorization input —
 * rather than presence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorageArea, type StorageArea } from '@/storage/storage-area';
import {
  LOCAL_IDENTITY_PATTERN,
  LocalIdentityStore,
  isLocalIdentity,
  mintInstallationId,
  resolveOwner,
} from '@/identity/local-identity';
import { IdentityProfileStore } from '@/identity/identity-profile';
import { UNASSIGNED_ABA_USER, bindAccountToUser } from '@/providers/accounts/account-model';
import { EXPORTABLE_KINDS } from '@/storage/data-export';
import { EXPORT_PORTABILITY } from '@/storage/data-classification';

const NOW = 1_800_000_000_000;

/** A storage area whose writes evaporate. `set` resolves; nothing lands. */
class WriteLosingArea implements StorageArea {
  private readonly inner = new MemoryStorageArea();
  get<T>(key: string): Promise<T | undefined> {
    return this.inner.get<T>(key);
  }
  set<T>(_key: string, _value: T): Promise<void> {
    return Promise.resolve();
  }
  remove(key: string): Promise<void> {
    return this.inner.remove(key);
  }
  keys(): Promise<string[]> {
    return this.inner.keys();
  }
  clear(): Promise<void> {
    return this.inner.clear();
  }
}

describe('installation identity', () => {
  let area: MemoryStorageArea;
  let store: LocalIdentityStore;

  beforeEach(() => {
    area = new MemoryStorageArea();
    store = new LocalIdentityStore(area, { now: () => NOW });
  });

  it('01 — first run creates an identity, and says that it created one', async () => {
    const result = await store.ensure();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.created).toBe(true);
    expect(result.identity.createdAt).toBe(NOW);
    // Nothing was needed to make it: no network, no account, no input.
    expect(await store.peek()).toEqual(result.identity);
  });

  it('02 — the identifier is CSPRNG-derived, opaque, and carries nothing personal', async () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    const id = mintInstallationId();
    expect(spy).toHaveBeenCalled();
    // 16 bytes requested — 128 bits, which is what makes collision a
    // non-question across installations.
    expect((spy.mock.calls[0]?.[0] as Uint8Array).length).toBe(16);
    spy.mockRestore();

    expect(id).toMatch(LOCAL_IDENTITY_PATTERN);
    // Opaque: hex and a prefix, so there is no field in it to carry an
    // address, a subject, a device value or anything else about a person.
    expect(id.slice(4)).toMatch(/^[0-9a-f]{32}$/);
    // And it is a function of nothing: two mints differ.
    expect(mintInstallationId()).not.toBe(id);
  });

  it('03 — the identity is persisted and read back, not held in memory', async () => {
    const first = await store.ensure();
    if (!first.ok) throw new Error('unreachable');

    // A different store instance over the same storage — which is what a
    // restarted worker is.
    const restarted = new LocalIdentityStore(area, { now: () => NOW + 1 });
    const second = await restarted.ensure();

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.identity.installationId).toBe(first.identity.installationId);
    // Not re-minted: the creation time is the original one.
    expect(second.created).toBe(false);
    expect(second.identity.createdAt).toBe(NOW);
  });

  it('04 — a write that does not land fails closed instead of being believed', async () => {
    const losing = new LocalIdentityStore(new WriteLosingArea(), { now: () => NOW });

    const result = await losing.ensure();

    // The caller is told, rather than handed an id that exists nowhere and
    // would label rows the next restart could not find.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure).toBe('NOT_PERSISTED');
  });

  it('05 — a malformed record is refused, never replaced', async () => {
    await area.set('installation', { version: 1, installationId: 'not-an-id', createdAt: NOW });

    const result = await store.ensure();

    // Minting over it would be indistinguishable from discarding a real
    // installation's ownership: the bytes might be a corrupted id whose rows
    // still exist, and replacing it would make them invisible to everybody.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure).toBe('CORRUPT');
    // And it is still there, untouched, for a person to look at.
    expect(await area.get('installation')).toEqual({
      version: 1,
      installationId: 'not-an-id',
      createdAt: NOW,
    });
  });

  it('06 — a record from a future version is not adopted', async () => {
    await area.set('installation', {
      version: 2,
      installationId: mintInstallationId(),
      createdAt: NOW,
    });

    const result = await store.ensure();

    // A downgrade cannot know what a later shape means, so it refuses rather
    // than reading the fields it happens to recognise.
    expect(result.ok === false && result.failure).toBe('CORRUPT');
  });

  it('07 — concurrent first runs mint exactly once', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => store.ensure()));

    const ids = new Set(
      results.map((result) => (result.ok ? result.identity.installationId : 'failed')),
    );
    // Twelve callers, one identity. Without collapsing them, several would
    // mint, the last write would win, and the losers would be labelling rows
    // with an id no longer stored.
    expect(ids.size).toBe(1);
    expect(ids.has('failed')).toBe(false);
    expect((await store.peek())?.installationId).toBe([...ids][0]);
  });

  it('08 — a valid existing identity is preserved, never regenerated', async () => {
    const first = await store.ensure();
    if (!first.ok) throw new Error('unreachable');

    for (let index = 0; index < 5; index += 1) {
      const again = await new LocalIdentityStore(area, { now: () => NOW + index }).ensure();
      expect(again.ok && again.identity.installationId).toBe(first.identity.installationId);
    }
  });

  it('09 — creating an identity performs no network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await store.ensure();
    await store.peek();

    // There is nothing to contact, and the absence is asserted rather than
    // assumed: an identity that registered itself somewhere would be a remote
    // account wearing a local name.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('owner resolution', () => {
  it('10 — a standalone installation owns its data under its own id', () => {
    const installation = mintInstallationId();

    const resolved = resolveOwner(null, installation);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error('unreachable');
    expect(resolved.abaUserId).toBe(installation);
    expect(resolved.source).toBe('installation');
    // And it is a real owner, not the placeholder: the account model refuses
    // to bind anything to `unassigned` by name, so an installation stuck on
    // it could never take ownership of what it connected.
    expect(resolved.abaUserId).not.toBe(UNASSIGNED_ABA_USER);
  });

  it('11 — the installation id is an owner the account model accepts', () => {
    const account = {
      connectionId: 'conn_1',
      abaUserId: UNASSIGNED_ABA_USER,
      providerId: 'openai',
      label: 'Work',
      createdAt: NOW,
    };

    const bound = bindAccountToUser(account as never, mintInstallationId());

    expect(bound.ok).toBe(true);
    // The same call with the placeholder is refused, which is the whole
    // reason this phase exists.
    expect(bindAccountToUser(account as never, UNASSIGNED_ABA_USER).ok).toBe(false);
  });

  it('12 — a signed-in profile owns the data when one exists', () => {
    const resolved = resolveOwner('usr_11111111111111111111111111111111', null);

    expect(resolved.ok && resolved.source).toBe('profile');
  });

  it('13 — two identities that disagree fail closed rather than picking one', () => {
    const resolved = resolveOwner('usr_11111111111111111111111111111111', mintInstallationId());

    // Preferring the profile would hide every standalone row behind an owner
    // that never wrote them; preferring the local id would ignore an
    // authentication that did happen. Neither is safe.
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.failure).toBe('CONFLICT');
  });

  it('14 — no owner at all is a refusal, not an invented one', () => {
    expect(resolveOwner(null, null).ok).toBe(false);
  });
});

describe('what the installation identity is not', () => {
  it('15 — it is not a provider credential, and is coupled to none', async () => {
    const area = new MemoryStorageArea();
    const result = await new LocalIdentityStore(area).ensure();
    if (!result.ok) throw new Error('unreachable');

    // The stored record has three fields and none of them is a secret.
    const stored = (await area.get('installation')) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['createdAt', 'installationId', 'version']);
    const serialised = JSON.stringify(stored).toLowerCase();
    for (const term of ['key', 'secret', 'token', 'password', 'credential', '@']) {
      expect(serialised, term).not.toContain(term);
    }
  });

  it('16 — it is not exportable, and cannot become so by accident', () => {
    // Export carries four kinds, derived from the portability table rather
    // than listed by hand. Sorted, because the set is the contract and the
    // order is an accident of how the table is written — asserting the order
    // would make reordering the table look like a security change.
    expect([...EXPORTABLE_KINDS].sort()).toEqual([
      'connection-metadata',
      'preference',
      'shortcut',
      'workflow',
    ]);
    expect([...EXPORTABLE_KINDS]).not.toContain('identity-profile');
    expect([...EXPORTABLE_KINDS]).not.toContain('device-id');
    // And the reason it cannot become exportable by accident is now checkable
    // rather than narrated: identity is classified, and the classification is
    // what the exporter reads.
    expect(EXPORT_PORTABILITY['identity-profile']).toBe('LOCAL_ONLY');
    expect(EXPORT_PORTABILITY['device-id']).toBe('LOCAL_ONLY');
    // It is installation-specific on purpose: carrying it to a second
    // installation would have two of them claiming to be one owner.
  });

  it('17 — it is not an authentication state, and does not create one', async () => {
    const profiles = new IdentityProfileStore(new MemoryStorageArea());
    const identities = new LocalIdentityStore(new MemoryStorageArea());

    await identities.ensure();

    // Minting a local identity signs nobody in: the profile store, which is
    // the only thing that records an authentication, is untouched.
    expect(await profiles.get()).toBeNull();
    expect(await profiles.abaUserId()).toBeNull();
  });

  it('18 — it is not derived from any device, runtime or hardware value', () => {
    // A derived id would be a fingerprint: stable across reinstalls and
    // correlatable between installations. Independence is testable directly —
    // the mint takes no arguments and two calls in one runtime differ.
    expect(mintInstallationId.length).toBe(0);
    const ids = new Set(Array.from({ length: 50 }, () => mintInstallationId()));
    expect(ids.size).toBe(50);
  });

  it('19 — a value that is not a local identity is never treated as one', () => {
    for (const candidate of [
      null,
      undefined,
      'loc_',
      'usr_11111111111111111111111111111111',
      { version: 1, installationId: 'loc_ABCDEF', createdAt: NOW },
      { version: 1, installationId: `loc_${'0'.repeat(31)}`, createdAt: NOW },
      { version: 1, installationId: `loc_${'0'.repeat(32)}` },
      { version: 1, installationId: `loc_${'0'.repeat(32)}`, createdAt: Number.NaN },
    ]) {
      expect(isLocalIdentity(candidate), JSON.stringify(candidate)).toBe(false);
    }
    expect(
      isLocalIdentity({ version: 1, installationId: mintInstallationId(), createdAt: NOW }),
    ).toBe(true);
  });
});
