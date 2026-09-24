/**
 * TEST-SECURITY-058 — K1 local encryption, held to properties rather than strings.
 *
 * The failure mode a crypto test suite is most likely to have is passing
 * against something that is not really encrypting. So these read the *stored*
 * bytes and assert the plaintext is absent from them, rather than asserting
 * that a round trip returns what went in — which a store that kept the value
 * in a field called `ct` would also satisfy.
 *
 * Run against Web Crypto, not a stub. The construction is AES-GCM-256 with
 * PBKDF2-SHA-256 key wrapping, both from the platform, and the point of these
 * cases is the wiring around them: what is authenticated, what is refused, and
 * which failures stay distinguishable.
 */
import { describe, expect, it, vi } from 'vitest';
import { MemoryStorageArea } from '@/storage/storage-area';
import {
  decodeEnvelope,
  EnvelopeError,
  ENVELOPE_VERSION,
  fromBase64,
  isEnvelope,
  open,
  seal,
  toBase64,
} from '@/crypto/envelope';
import {
  createWrappedKey,
  DEK_BYTES,
  importDek,
  KDF,
  KDF_ITERATIONS,
  unwrapKey,
  UnlockError,
  wrapExistingKey,
} from '@/crypto/passphrase-key';
import { K1Store } from '@/crypto/k1-store';
import { ProtectedStorageArea } from '@/crypto/protected-storage-area';
import { protectExistingRecords, unprotectExistingRecords } from '@/crypto/protect-existing';

const PASSPHRASE = 'correct horse battery staple';
const SECRET = 'sk-live-k1-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = 1_800_000_000_000;

function stores(): { durable: MemoryStorageArea; memory: MemoryStorageArea; k1: K1Store } {
  const durable = new MemoryStorageArea();
  const memory = new MemoryStorageArea();
  return { durable, memory, k1: new K1Store(durable, memory, () => NOW) };
}

async function unlockedKey(): Promise<{ key: CryptoKey; keyId: string }> {
  const { dek, keyId } = await createWrappedKey(PASSPHRASE, NOW);
  return { key: await importDek(dek), keyId };
}

describe('TEST-SECURITY-058 — K1 envelope', () => {
  it('01 — the plaintext is genuinely absent from what is stored', async () => {
    const { key, keyId } = await unlockedKey();

    const envelope = await seal(key, keyId, 'credentials/conn:abc', { apiKey: SECRET });

    // The assertion that makes the rest of this file worth anything: the
    // serialised record does not contain the secret, at all, in any field.
    const serialised = JSON.stringify(envelope);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain(SECRET.slice(-8));
    // Nor is it sitting there base64-encoded, which a "ciphertext" that was
    // really just an encoding would be.
    expect(serialised).not.toContain(toBase64(new TextEncoder().encode(SECRET)));
    // And it does decrypt, so the absence is not because nothing was stored.
    expect(await open(key, 'credentials/conn:abc', envelope)).toEqual({ apiKey: SECRET });
  });

  it('02 — a different key does not open it', async () => {
    const first = await unlockedKey();
    const second = await unlockedKey();

    const envelope = await seal(first.key, first.keyId, 'loc', SECRET);

    await expect(open(second.key, 'loc', envelope)).rejects.toThrow(EnvelopeError);
    await expect(open(second.key, 'loc', envelope)).rejects.toMatchObject({
      failure: 'AUTHENTICATION_FAILED',
    });
  });

  it('03 — tampering with the ciphertext, the IV or the key id all fail closed', async () => {
    const { key, keyId } = await unlockedKey();
    const envelope = await seal(key, keyId, 'loc', SECRET);

    const flip = (value: string): string => {
      const bytes = fromBase64(value);
      if (bytes === null || bytes.length === 0) throw new Error('not base64');
      bytes[0] = (bytes[0] ?? 0) ^ 0x01;
      return toBase64(bytes);
    };

    for (const tampered of [
      { ...envelope, ct: flip(envelope.ct) },
      { ...envelope, iv: flip(envelope.iv) },
      // The key id is inside the authenticated data, so editing it is caught
      // rather than silently selecting another key.
      { ...envelope, kid: 'kdeadbeefdeadbeef' },
    ]) {
      await expect(open(key, 'loc', tampered)).rejects.toMatchObject({
        failure: 'AUTHENTICATION_FAILED',
      });
    }
  });

  it('04 — an envelope moved to another location does not open there', async () => {
    const { key, keyId } = await unlockedKey();
    // Two connections. Copying one's stored bytes over the other would
    // otherwise pass every integrity check, because the bytes are genuinely
    // ones this installation wrote.
    const envelope = await seal(key, keyId, 'credentials/conn:one', SECRET);

    await expect(open(key, 'credentials/conn:two', envelope)).rejects.toMatchObject({
      failure: 'AUTHENTICATION_FAILED',
    });
    expect(await open(key, 'credentials/conn:one', envelope)).toBe(SECRET);
  });

  it('05 — an unknown version or algorithm is refused, not best-effort read', async () => {
    const { key, keyId } = await unlockedKey();
    const envelope = await seal(key, keyId, 'loc', SECRET);

    expect(() => decodeEnvelope({ ...envelope, v: ENVELOPE_VERSION + 1 })).toThrow(
      expect.objectContaining({ failure: 'UNSUPPORTED_VERSION' }),
    );
    expect(() => decodeEnvelope({ ...envelope, alg: 'ROT13' })).toThrow(
      expect.objectContaining({ failure: 'UNSUPPORTED_ALGORITHM' }),
    );
    // Structurally broken, rather than from another build.
    expect(() => decodeEnvelope({ ...envelope, iv: 'not base64!' })).toThrow(
      expect.objectContaining({ failure: 'MALFORMED' }),
    );
    expect(() => decodeEnvelope({ ...envelope, ct: '' })).toThrow(
      expect.objectContaining({ failure: 'MALFORMED' }),
    );
  });

  it('06 — a plaintext record is not mistaken for a damaged envelope', () => {
    // The distinction migration depends on. A pre-K1 value must read as
    // "not an envelope" so it can be converted, and a truncated envelope must
    // not, so it is never re-encrypted inside a second envelope.
    expect(isEnvelope('sk-plain-value')).toBe(false);
    expect(isEnvelope({ apiKey: SECRET })).toBe(false);
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope({ v: 1, alg: 'AES-GCM-256' })).toBe(true);
    expect(() => decodeEnvelope({ v: 1, alg: 'AES-GCM-256' })).toThrow(
      expect.objectContaining({ failure: 'MALFORMED' }),
    );
  });
});

describe('TEST-SECURITY-058 — K1 key hierarchy', () => {
  it('07 — the data key is random, not derived from the passphrase', async () => {
    const a = await createWrappedKey(PASSPHRASE, NOW);
    const b = await createWrappedKey(PASSPHRASE, NOW);

    // Same passphrase, different data keys. A derived DEK would make changing
    // a passphrase a re-encryption of everything rather than a re-wrap.
    expect(toBase64(a.dek)).not.toBe(toBase64(b.dek));
    expect(a.dek.length).toBe(DEK_BYTES);
    // And different salts, so two installations with one passphrase share no
    // derived material.
    expect(a.metadata.salt).not.toBe(b.metadata.salt);
    expect(a.metadata.kdf).toBe(KDF);
    expect(a.metadata.iterations).toBe(KDF_ITERATIONS);
  });

  it('08 — the passphrase is never stored, in any form', async () => {
    const { metadata } = await createWrappedKey(PASSPHRASE, NOW);

    const serialised = JSON.stringify(metadata);
    expect(serialised).not.toContain(PASSPHRASE);
    // Not a hash of it either. The wrapped key *is* the verifier: unwrapping
    // authenticates or it does not, and a separate verifier would be one more
    // thing an offline attacker could test against.
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(PASSPHRASE)),
    );
    expect(serialised).not.toContain(toBase64(digest));
  });

  it('09 — the wrong passphrase fails, and corrupt metadata says so separately', async () => {
    const { metadata } = await createWrappedKey(PASSPHRASE, NOW);

    await expect(unwrapKey('not the passphrase', metadata)).rejects.toMatchObject({
      failure: 'WRONG_PASSPHRASE',
    });
    // A tampered wrapping is reported as a wrong passphrase on purpose:
    // AES-GCM cannot tell them apart and guessing would be an oracle.
    await expect(
      unwrapKey(PASSPHRASE, { ...metadata, wrapped: toBase64(new Uint8Array(48)) }),
    ).rejects.toMatchObject({ failure: 'WRONG_PASSPHRASE' });
    // Structurally broken metadata is a different problem with a different
    // answer, and must not send the user back to retype a correct passphrase.
    await expect(
      unwrapKey(PASSPHRASE, { v: 1, wrapped: 'x', kdf: 'made up' }),
    ).rejects.toMatchObject({ failure: 'METADATA_CORRUPT' });
    await expect(unwrapKey(PASSPHRASE, { ...metadata, v: 99 })).rejects.toMatchObject({
      failure: 'UNSUPPORTED_VERSION',
    });
  });

  it('10 — changing the passphrase re-wraps the same key, so data still opens', async () => {
    const { metadata, dek, keyId } = await createWrappedKey(PASSPHRASE, NOW);
    const key = await importDek(dek);
    const envelope = await seal(key, keyId, 'loc', SECRET);

    const rewrapped = await wrapExistingKey('a different passphrase', dek, keyId, undefined, NOW);

    expect(rewrapped.salt).not.toBe(metadata.salt);
    const reopened = await unwrapKey('a different passphrase', rewrapped);
    expect(toBase64(reopened.dek)).toBe(toBase64(dek));
    // The point: nothing was re-encrypted, and the old ciphertext still opens.
    expect(await open(await importDek(reopened.dek), 'loc', envelope)).toBe(SECRET);
    // The old passphrase no longer opens the new wrapping.
    await expect(unwrapKey(PASSPHRASE, rewrapped)).rejects.toMatchObject({
      failure: 'WRONG_PASSPHRASE',
    });
  });
});

describe('TEST-SECURITY-058 — K1 lifecycle', () => {
  it('11 — off, unlocked, locked, unlocked again', async () => {
    const { k1, memory } = stores();

    expect((await k1.status()).state).toBe('OFF');
    expect((await k1.initialize(PASSPHRASE)).state).toBe('UNLOCKED');
    expect((await k1.status()).state).toBe('UNLOCKED');

    await k1.lock();
    expect((await k1.status()).state).toBe('LOCKED');
    expect(await k1.key()).toBeNull();

    expect((await k1.unlock(PASSPHRASE)).state).toBe('UNLOCKED');
    expect(await k1.key()).not.toBeNull();

    // A browser restart is exactly this: the memory area goes, the durable
    // one stays.
    await memory.clear();
    expect((await k1.status()).state).toBe('LOCKED');
  });

  it('12 — the unwrapped key never reaches durable storage', async () => {
    const { k1, durable, memory } = stores();
    await k1.initialize(PASSPHRASE);

    const durableDump = JSON.stringify(
      await Promise.all((await durable.keys()).map((key) => durable.get(key))),
    );
    const sessionDump = JSON.stringify(
      await Promise.all((await memory.keys()).map((key) => memory.get(key))),
    );

    // The unwrapped key is in the memory area and in no durable record. That
    // is the whole at-rest argument: what is on disk is the wrapped key, and
    // the wrapping needs a passphrase this code never writes down.
    const material = await k1.key();
    expect(material).not.toBeNull();
    expect(sessionDump.length).toBeGreaterThan(0);
    expect(durableDump).not.toContain(PASSPHRASE);
    const unlocked = await memory.get<string>('k1-unlocked');
    expect(typeof unlocked).toBe('string');
    expect(durableDump).not.toContain(unlocked as string);
  });

  it('13 — missing key metadata is NEEDS_RECOVERY, never first-time setup', async () => {
    const { k1, durable } = stores();
    await k1.initialize(PASSPHRASE);

    // What losing the key record looks like: the flag survives, the key does
    // not. Reporting OFF here would invite a caller to initialise over data
    // it can no longer read.
    await durable.remove('k1-key');

    const status = await k1.status();
    expect(status.state).toBe('NEEDS_RECOVERY');
    expect(status.state).not.toBe('OFF');
    // And initialising again is refused outright, rather than silently
    // minting a key that opens nothing.
    await expect(k1.initialize(PASSPHRASE)).rejects.toThrow(/already switched on/);
  });

  it('14 — corrupt key metadata is also NEEDS_RECOVERY, not a passphrase problem', async () => {
    const { k1, durable } = stores();
    await k1.initialize(PASSPHRASE);
    await k1.lock();

    await durable.set('k1-key', { v: 1, wrapped: 'not really' });

    expect((await k1.status()).state).toBe('NEEDS_RECOVERY');
    await expect(k1.unlock(PASSPHRASE)).rejects.toMatchObject({ failure: 'METADATA_CORRUPT' });
  });

  it('15 — a short passphrase is refused before any key is created', async () => {
    const { k1, durable } = stores();

    await expect(k1.initialize('short')).rejects.toThrow(UnlockError);
    // Nothing was written, so the installation is still genuinely off.
    expect((await k1.status()).state).toBe('OFF');
    expect(await durable.keys()).toEqual([]);
  });
});

describe('TEST-SECURITY-058 — protected storage', () => {
  it('16 — a locked read fails rather than reporting the record as absent', async () => {
    const { k1 } = stores();
    const backing = new MemoryStorageArea();
    const area = new ProtectedStorageArea(backing, k1, 'credentials');
    await k1.initialize(PASSPHRASE);
    await area.set('conn:one', SECRET);

    await k1.lock();

    // The distinction that matters most in this file. "You have no API key"
    // invites the user to reconnect, which overwrites the key they still
    // have; "I cannot read it" invites them to unlock.
    await expect(area.get('conn:one')).rejects.toMatchObject({ failure: 'LOCKED' });
    await expect(area.set('conn:two', SECRET)).rejects.toMatchObject({ failure: 'LOCKED' });
    // The record is still there, untouched.
    expect(await backing.get('conn:one')).toBeDefined();
  });

  it('17 — a tampered stored record fails closed and is reported as unreadable', async () => {
    const { k1 } = stores();
    const backing = new MemoryStorageArea();
    const area = new ProtectedStorageArea(backing, k1, 'credentials');
    await k1.initialize(PASSPHRASE);
    await area.set('conn:one', SECRET);

    const stored = await backing.get<{ ct: string }>('conn:one');
    const bytes = fromBase64(stored?.ct ?? '');
    if (bytes === null) throw new Error('unreachable');
    bytes[2] = (bytes[2] ?? 0) ^ 0xff;
    await backing.set('conn:one', { ...stored, ct: toBase64(bytes) });

    await expect(area.get('conn:one')).rejects.toMatchObject({ failure: 'UNREADABLE' });
  });

  it('18 — removing a record needs no key, so an unreadable one can still be deleted', async () => {
    const { k1 } = stores();
    const backing = new MemoryStorageArea();
    const area = new ProtectedStorageArea(backing, k1, 'credentials');
    await k1.initialize(PASSPHRASE);
    await area.set('conn:one', SECRET);
    await k1.lock();

    await area.remove('conn:one');

    // Refusing would leave a user unable to delete a credential they can no
    // longer read, which is the opposite of safe.
    expect(await backing.get('conn:one')).toBeUndefined();
  });

  it('19 — two protected areas cannot have their records swapped', async () => {
    const { k1 } = stores();
    const backing = new MemoryStorageArea();
    const credentials = new ProtectedStorageArea(backing, k1, 'credentials');
    const other = new ProtectedStorageArea(backing, k1, 'other');
    await k1.initialize(PASSPHRASE);

    await credentials.set('same-key', SECRET);
    const stored = await backing.get('same-key');
    await other.set('same-key', 'something else');
    await backing.set('same-key', stored);

    // Same backing store, same record name, same data key — and the label is
    // in the authenticated data, so the other area still cannot open it.
    await expect(other.get('same-key')).rejects.toMatchObject({ failure: 'UNREADABLE' });
    expect(await credentials.get('same-key')).toBe(SECRET);
  });
});

describe('TEST-SECURITY-058 — switching protection on over existing data', () => {
  it('20 — plaintext is encrypted in place, and proved readable before it counts', async () => {
    const { k1 } = stores();
    const backing = new MemoryStorageArea();
    await backing.set('conn:one', SECRET);
    await backing.set('conn:two', 'sk-second-aaaaaaaaaaaaaaaaaaaa');
    const area = new ProtectedStorageArea(backing, k1, 'credentials');
    await k1.initialize(PASSPHRASE);

    const outcome = await protectExistingRecords(backing, area);

    expect(outcome).toEqual({ encrypted: 2, alreadyProtected: 0, failed: 0, unreadable: 0 });
    // What is on disk no longer contains the keys.
    const dump = JSON.stringify(
      await Promise.all((await backing.keys()).map((key) => backing.get(key))),
    );
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain('sk-second-aaaaaaaaaaaaaaaaaaaa');
    expect(await area.get('conn:one')).toBe(SECRET);
  });

  it('21 — re-running converges instead of double-encrypting', async () => {
    const { k1 } = stores();
    const backing = new MemoryStorageArea();
    await backing.set('conn:one', SECRET);
    const area = new ProtectedStorageArea(backing, k1, 'credentials');
    await k1.initialize(PASSPHRASE);

    await protectExistingRecords(backing, area);
    const second = await protectExistingRecords(backing, area);
    const third = await protectExistingRecords(backing, area);

    // An interrupted run simply finishes next time, and a completed one is a
    // no-op. Sealing an envelope inside an envelope would still "succeed"
    // and would make the record permanently unreadable.
    expect(second).toEqual({ encrypted: 0, alreadyProtected: 1, failed: 0, unreadable: 0 });
    expect(third).toEqual(second);
    expect(await area.get('conn:one')).toBe(SECRET);
  });

  it('22 — an interrupted run leaves every record readable one way or the other', async () => {
    const { k1 } = stores();
    const backing = new MemoryStorageArea();
    await backing.set('conn:one', SECRET);
    await backing.set('conn:two', 'sk-second-aaaaaaaaaaaaaaaaaaaa');
    const area = new ProtectedStorageArea(backing, k1, 'credentials');
    await k1.initialize(PASSPHRASE);

    // Encrypt only the first, as an eviction partway through would.
    await area.set('conn:one', SECRET);

    // The unconverted record is still plaintext and still readable through the
    // protected view, because in-place encryption never has a window where a
    // value is neither.
    expect(await area.get('conn:one')).toBe(SECRET);
    expect(await area.get('conn:two')).toBe('sk-second-aaaaaaaaaaaaaaaaaaaa');
    const finished = await protectExistingRecords(backing, area);
    expect(finished.encrypted).toBe(1);
    expect(finished.alreadyProtected).toBe(1);
  });

  it('23 — switching off refuses as a whole if anything will not decrypt', async () => {
    const { k1 } = stores();
    const backing = new MemoryStorageArea();
    const area = new ProtectedStorageArea(backing, k1, 'credentials');
    await k1.initialize(PASSPHRASE);
    await area.set('conn:one', SECRET);
    await area.set('conn:two', 'sk-second-aaaaaaaaaaaaaaaaaaaa');

    const stored = await backing.get<{ ct: string }>('conn:two');
    await backing.set('conn:two', { ...stored, ct: toBase64(new Uint8Array(32)) });

    const refused = await unprotectExistingRecords(backing, area);

    // Half a store decrypted, with the key about to be deleted, is worse than
    // either end state — so nothing is written back.
    expect(refused).toEqual({ ok: false, unreadable: 1 });
    expect(JSON.stringify(await backing.get('conn:one'))).not.toContain(SECRET);
  });

  it('24 — a clean switch-off returns every record to plaintext', async () => {
    const { k1 } = stores();
    const backing = new MemoryStorageArea();
    const area = new ProtectedStorageArea(backing, k1, 'credentials');
    await k1.initialize(PASSPHRASE);
    await area.set('conn:one', SECRET);

    expect(await unprotectExistingRecords(backing, area)).toEqual({ ok: true, decrypted: 1 });

    expect(await backing.get('conn:one')).toBe(SECRET);
    await k1.disable();
    expect((await k1.status()).state).toBe('OFF');
  });
});

describe('TEST-SECURITY-058 — what K1 must not become', () => {
  it('25 — no key material is derived from the installation identity', async () => {
    // Asserted against the sources, because the property is an absence and
    // the only way it breaks is somebody reaching for a stable local value
    // when they need a salt.
    const { readFileSync } = await import('node:fs');
    for (const file of [
      'src/crypto/passphrase-key.ts',
      'src/crypto/k1-store.ts',
      'src/crypto/envelope.ts',
      'src/crypto/protected-storage-area.ts',
    ]) {
      const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const forbidden of [
        'installationId',
        'LocalIdentityStore',
        'abaUserId',
        'identity-local',
        'navigator',
        'userAgent',
      ]) {
        expect(code, `${file} must not reach for ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('26 — encryption requires no network', async () => {
    const { k1 } = stores();
    const backing = new MemoryStorageArea();
    const area = new ProtectedStorageArea(backing, k1, 'credentials');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await k1.initialize(PASSPHRASE);
    await area.set('conn:one', SECRET);
    await k1.lock();
    await k1.unlock(PASSPHRASE);
    await area.get('conn:one');

    // There is nothing to contact, and the absence is asserted rather than
    // assumed: a recovery service is exactly what this design refuses to have.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('TEST-SECURITY-058 — what K1 covers, as a table', () => {
  it('27 — every persisted kind has a protection class, and it matches reality', async () => {
    const { K1_PROTECTION, K1_PROTECTION_CLASSES, K1_ENCRYPTED_KINDS, PERSISTED_DATA_KINDS } =
      await import('@/storage/data-classification');

    for (const kind of PERSISTED_DATA_KINDS) {
      expect(K1_PROTECTION_CLASSES, kind).toContain(K1_PROTECTION[kind]);
    }
    // The protected set, and nothing else claiming to be. Two of these were
    // wrong in the first draft — `connector-token` and `aba-refresh-token` —
    // and the first was a claim the implementation does not make, because
    // connector tokens are never on disk to begin with.
    expect([...K1_ENCRYPTED_KINDS].sort()).toEqual(['aba-refresh-token', 'provider-credential']);
    expect(K1_PROTECTION['connector-token']).toBe('MEMORY_ONLY');
  });

  it('28 — what must stay readable while locked is classified plaintext', async () => {
    const { K1_PROTECTION } = await import('@/storage/data-classification');

    // The unlock screen cannot depend on the unlock. Each of these is read on
    // a path that runs before, or regardless of, a passphrase being entered.
    for (const kind of ['identity-profile', 'device-id', 'persistence-health', 'policy'] as const) {
      expect(K1_PROTECTION[kind], kind).toBe('PLAINTEXT_BY_DESIGN');
    }
    // And the half of a connection the panel renders while locked, so it can
    // say *which* account needs unlocking.
    expect(K1_PROTECTION['connection-metadata']).toBe('PLAINTEXT_BY_DESIGN');
  });
});

describe('TEST-SECURITY-058 — the routing between protected and plain', () => {
  it('29 — a locked read throws whatever is stored, plaintext included', async () => {
    const { K1AwareArea } = await import('@/crypto/k1-aware-area');
    const { k1 } = stores();
    const backing = new MemoryStorageArea();
    const area = new K1AwareArea(backing, k1, 'credentials');

    // Off: straight through, because most installations never switch K1 on
    // and a key lookup that can only return null would fail every read.
    expect(await area.get('conn:one')).toBeUndefined();
    await area.set('conn:one', SECRET);
    expect(await backing.get('conn:one')).toBe(SECRET);

    await k1.initialize(PASSPHRASE);
    await area.set('conn:one', SECRET);
    expect(JSON.stringify(await backing.get('conn:one'))).not.toContain(SECRET);

    // A plaintext record that the conversion never touched — written after
    // protection was switched on, which is the only way a genuinely
    // unencrypted credential and a locked installation coexist.
    await backing.set('conn:legacy', 'sk-plaintext-left-behind');

    await k1.lock();

    // Both refuse. The routing decision is made on the *state*, not on what
    // happens to be stored, so a plaintext value cannot become a fallback for
    // a protected one that cannot be read. Returning the plaintext here would
    // be a locked installation quietly using an unencrypted credential — and
    // it would look exactly like a working one.
    await expect(area.get('conn:one')).rejects.toMatchObject({ failure: 'LOCKED' });
    await expect(area.get('conn:legacy')).rejects.toMatchObject({ failure: 'LOCKED' });
    await expect(area.set('conn:two', SECRET)).rejects.toMatchObject({ failure: 'LOCKED' });
  });

  it('30 — a recovery state refuses reads rather than reporting them empty', async () => {
    const { K1AwareArea } = await import('@/crypto/k1-aware-area');
    const { k1, durable } = stores();
    const backing = new MemoryStorageArea();
    const area = new K1AwareArea(backing, k1, 'credentials');
    await k1.initialize(PASSPHRASE);
    await area.set('conn:one', SECRET);

    await durable.remove('k1-key');

    // `NEEDS_RECOVERY` is not "locked" — no passphrase will fix it — but it is
    // equally not "there is no credential". Both are refusals.
    expect((await k1.status()).state).toBe('NEEDS_RECOVERY');
    await expect(area.get('conn:one')).rejects.toMatchObject({ failure: 'UNREADABLE' });
  });

  it('31 — removing and listing work in every state, so nothing becomes undeletable', async () => {
    const { K1AwareArea } = await import('@/crypto/k1-aware-area');
    const { k1 } = stores();
    const backing = new MemoryStorageArea();
    const area = new K1AwareArea(backing, k1, 'credentials');
    await k1.initialize(PASSPHRASE);
    await area.set('conn:one', SECRET);
    await k1.lock();

    expect(await area.keys()).toEqual(['conn:one']);
    await area.remove('conn:one');
    expect(await backing.get('conn:one')).toBeUndefined();
  });
});
