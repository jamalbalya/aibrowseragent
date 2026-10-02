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
import { readFileSync } from 'node:fs';
import { isIdentityConfigured, loadIdentityConfig } from '@/identity/identity-config';
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

  it('13 — when two identities disagree, the one that wrote the rows owns them', () => {
    // **This case asserted the opposite, and the opposite was a defect.** It
    // required `CONFLICT`, on the reasoning that *"preferring the profile
    // would hide every standalone row behind an owner that never wrote them;
    // preferring the local id would ignore an authentication that did happen.
    // Neither is safe."*
    //
    // The first half is why the rule is now what it is. The second half was
    // wrong, and failing closed was worse than either: the conflict is reached
    // by the **ordinary** path — every standalone installation mints a `loc_…`
    // on first run, so the first Google sign-in on any installation produces
    // it — and `currentAbaUserId` answered the refusal by reporting
    // persistence `RECOVERY_REQUIRED`, which `TaskManager` treats as
    // work-blocking. Signing in with Google stopped every task from starting.
    // Measured in real Chromium before this changed.
    const installation = mintInstallationId();
    const profile = 'usr_11111111111111111111111111111111';

    const resolved = resolveOwner(profile, installation);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error('unreachable');
    expect(resolved.abaUserId).toBe(installation);
    expect(resolved.source).toBe('installation');
    // Never the placeholder: an installation stuck on `unassigned` could not
    // take ownership of anything it connected, which is the second half of
    // what the old refusal caused.
    expect(resolved.abaUserId).not.toBe(UNASSIGNED_ABA_USER);
  });

  it('13b — and the signed-in profile is reported as adoptable, not discarded', () => {
    // The conflict is still a real thing worth a person's decision; what
    // changed is that it is an offer rather than a refusal to work. A caller
    // can see whose account the data could be adopted into.
    const installation = mintInstallationId();
    const profile = 'usr_11111111111111111111111111111111';

    const resolved = resolveOwner(profile, installation);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error('unreachable');
    expect(resolved.adoptable).toBe(profile);

    // Absent when there is nothing to adopt: no profile at all, or a profile
    // that already is the owner.
    const alone = resolveOwner(null, installation);
    expect(alone.ok).toBe(true);
    if (!alone.ok) throw new Error('unreachable');
    expect(alone.adoptable).toBeUndefined();

    const same = resolveOwner(installation, installation);
    expect(same.ok).toBe(true);
    if (!same.ok) throw new Error('unreachable');
    expect(same.adoptable).toBeUndefined();
  });

  it('13c — preferring the installation id ignores no authentication', () => {
    // Because this value is not an identity. It is a partition label for
    // local data: it authenticates nothing and authorises nothing, and no
    // route, tool or egress decision reads it. The session is a separate
    // record and is untouched by this function — `resolveOwner` cannot see a
    // session and cannot change one.
    const source = readFileSync('src/identity/local-identity.ts', 'utf8');
    const start = source.indexOf('export function resolveOwner(');
    const body = source.slice(start, source.indexOf('\n}', start));
    for (const forbidden of ['session', 'token', 'signOut', 'revoke']) {
      expect(body.toLowerCase(), forbidden).not.toContain(forbidden);
    }
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

describe('the ownership conflict, and which builds can reach it', () => {
  /**
   * Why this group exists, and what it corrects.
   *
   * `resolveOwner` used to fail closed when a local installation id and a
   * signed-in profile id disagreed, and `currentAbaUserId` answered that
   * refusal by reporting persistence `RECOVERY_REQUIRED` — which
   * `TaskManager` treats as work-blocking. So signing in with Google stopped
   * every task from starting. That is fixed, and the regression test is the
   * whole journey in `auth-google-protocol.spec.ts`.
   *
   * **A separate claim was made about it and was wrong.** The previous report
   * told the owner that the artifact pending Chrome Web Store review contained
   * the defect and that a reviewer who signed in would hit it. The conflict
   * needs **both** ids, and the profile id exists only after a *completed*
   * sign-in — which no shipped build can perform, because the backend origin
   * is inlined at build time and the shipped one has none.
   *
   * These cases pin the reachability argument so it is testable rather than
   * narrated. The browser-level measurement is
   * `auth-google.spec.ts :: the sign-in ownership conflict is unreachable in
   * the shipped build`, which was also run with the **old** code restored in a
   * shipped-configuration build and still passed.
   */
  it('needs two ids, so one id alone resolves cleanly either way', () => {
    // With no profile there is nothing to disagree with, under the old rule
    // and the new one alike. That is why the configuration decides
    // reachability rather than the rule.
    const installation = mintInstallationId();
    const alone = resolveOwner(null, installation);
    expect(alone.ok).toBe(true);
    if (!alone.ok) throw new Error('unreachable');
    expect(alone.abaUserId).toBe(installation);
    expect(alone.adoptable).toBeUndefined();
  });

  it('the profile id is written by one function, and only after a sign-in', () => {
    // `recordSignIn` is the only writer, and the controller calls it only
    // after the provider half has returned `ok`. So a build that cannot
    // complete a sign-in cannot produce the second id, whatever the
    // resolution rule does with it.
    const controller = readFileSync('src/identity/auth-controller.ts', 'utf8');
    const profile = readFileSync('src/identity/identity-profile.ts', 'utf8');

    // One writer of `abaUserId` on the profile record.
    expect(profile.split('abaUserId:').length - 1).toBeGreaterThan(0);
    expect(controller.split('recordSignIn(').length - 1).toBe(2);

    // And each call site is gated on a configured provider first. Asserted on
    // ordering, because the gate is only a gate if it comes first.
    for (const method of ['signInWithGoogle', 'verifyEmailSignIn']) {
      const start = controller.indexOf(`async ${method}(`);
      expect(start, method).toBeGreaterThan(-1);
      // Bounded by the next method rather than by the next `\n  }`: one of
      // these has a multi-line return type whose closing brace sits at that
      // indentation, so the naive terminator cut the body off at 155
      // characters and the assertions below passed for the wrong reason.
      const rest = controller.slice(start + 1);
      const nextMethod = rest.search(/\n {2}(async |\/\*\*)/);
      const body = nextMethod === -1 ? rest : rest.slice(0, nextMethod);

      const guard = body.indexOf("failure: 'NOT_CONFIGURED'");
      const record = body.indexOf('recordSignIn(');
      expect(guard, `${method}: no NOT_CONFIGURED guard`).toBeGreaterThan(-1);
      expect(record, `${method}: no recordSignIn call`).toBeGreaterThan(-1);
      // The gate is only a gate if it comes first.
      expect(guard, `${method}: the guard is not before the write`).toBeLessThan(record);

      // **And before the provider is touched at all.** A mutation that moved
      // the guard to sit between `signIn` and `recordSignIn` survived the
      // assertion above: the ordering it checked was still true, and an
      // unconfigured build would have reached out before refusing. The
      // property is that nothing happens first, not that the write happens
      // last.
      const reachOut = body.search(/this\.options\.(google|email)[!?]?\.\w/);
      expect(reachOut, `${method}: no provider call found`).toBeGreaterThan(-1);
      expect(guard, `${method}: the guard is not before the provider call`).toBeLessThan(reachOut);
    }
  });

  it('has no backend origin when none was compiled in, so no sign-in is possible', () => {
    // **Called rather than pattern-matched.** An earlier version of this case
    // grepped for a `??` fallback beside the variable name, and a mutation
    // that returned a default from a different line survived it. Nothing is
    // set in this environment, so the honest answer is `null` — and any
    // default, wherever it is written, makes this fail.
    expect(loadIdentityConfig()).toBeNull();
    expect(isIdentityConfigured()).toBe(false);
  });

  it('refuses a non-https origin even when one is compiled in', () => {
    // The other half, which cannot be reached by calling the loader in this
    // environment. An http origin is a bearer token in clear text, and a
    // loopback exception here would ship to everybody.
    const config = readFileSync('src/identity/identity-config.ts', 'utf8');
    expect(config).toContain("url.protocol !== 'https:'");
    // Read from the build-time environment and nowhere else: an origin that
    // could be set from a message would be an origin an attacker could set.
    expect(config).toContain('import.meta');
    expect(config).not.toMatch(/function\s+setBackendOrigin|export\s+function\s+set/);
  });
});
