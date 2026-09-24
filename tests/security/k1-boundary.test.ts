/**
 * TEST-SECURITY-060 — challenging the K1 boundary rather than confirming it.
 *
 * The previous suites establish that K1 works. These try to break it, and one
 * of them documents a break that **succeeds** — rollback — because a
 * limitation nobody has written a failing test for is a limitation that
 * quietly becomes a claim.
 *
 * Each case is an attack with a stated goal, not a round trip.
 */
import { describe, expect, it } from 'vitest';
import { MemoryStorageArea } from '@/storage/storage-area';
import { fromBase64, open, seal, toBase64 } from '@/crypto/envelope';
import { createWrappedKey, DEK_BYTES, importDek, unwrapKey } from '@/crypto/passphrase-key';
import { K1Store } from '@/crypto/k1-store';
import { ProtectedStorageArea } from '@/crypto/protected-storage-area';

const PASSPHRASE = 'correct horse battery staple';
const NEXT_PASSPHRASE = 'a different passphrase entirely';
const KEY_A = 'gateway-key-alpha-1111111111';
const KEY_B = 'gateway-key-bravo-2222222222';
const NOW = 1_800_000_000_000;

function stores(): { durable: MemoryStorageArea; memory: MemoryStorageArea; k1: K1Store } {
  const durable = new MemoryStorageArea();
  const memory = new MemoryStorageArea();
  return { durable, memory, k1: new K1Store(durable, memory, () => NOW) };
}

/** Flips one bit of a base64 field, as an editor with the profile would. */
function flip(value: string, index = 0): string {
  const bytes = fromBase64(value);
  if (bytes === null || bytes.length <= index) throw new Error('not base64');
  bytes[index] = (bytes[index] ?? 0) ^ 0x01;
  return toBase64(bytes);
}

describe('TEST-SECURITY-060 — AAD binding under attack', () => {
  it('01 — every way of moving or relabelling a ciphertext fails closed', async () => {
    const { dek, keyId } = await createWrappedKey(PASSPHRASE, NOW);
    const key = await importDek(dek);

    const envelope = await seal(key, keyId, 'credentials/conn:A', KEY_A);

    // The attack matrix. Each entry is a ciphertext this installation really
    // did write, presented under a binding it was not written for — so every
    // integrity check on the bytes themselves passes, and only the
    // authenticated context refuses.
    const attacks: readonly [string, () => Promise<unknown>][] = [
      ['moved to another connection', () => open(key, 'credentials/conn:B', envelope)],
      ['moved to another label', () => open(key, 'identity-session/conn:A', envelope)],
      ['no label at all', () => open(key, 'conn:A', envelope)],
      [
        'key id edited',
        () => open(key, 'credentials/conn:A', { ...envelope, kid: 'kffffffffffffffff' }),
      ],
      ['version edited', () => open(key, 'credentials/conn:A', { ...envelope, v: 2 })],
      ['algorithm edited', () => open(key, 'credentials/conn:A', { ...envelope, alg: 'AES-CBC' })],
      [
        'ciphertext edited',
        () => open(key, 'credentials/conn:A', { ...envelope, ct: flip(envelope.ct) }),
      ],
      ['iv edited', () => open(key, 'credentials/conn:A', { ...envelope, iv: flip(envelope.iv) })],
      [
        'ciphertext truncated',
        () => open(key, 'credentials/conn:A', { ...envelope, ct: envelope.ct.slice(0, 8) }),
      ],
    ];

    for (const [name, attempt] of attacks) {
      await expect(attempt(), name).rejects.toThrow();
    }
    // And the one binding it *was* written for still opens, so the refusals
    // above are the binding rather than a broken fixture.
    expect(await open(key, 'credentials/conn:A', envelope)).toBe(KEY_A);
  });

  it('02 — one connection’s ciphertext cannot be swapped in for another’s', async () => {
    const { k1 } = stores();
    const backing = new MemoryStorageArea();
    const area = new ProtectedStorageArea(backing, k1, 'credentials');
    await k1.initialize(PASSPHRASE);

    await area.set('conn:A', KEY_A);
    await area.set('conn:B', KEY_B);

    // The most direct cross-account attack available to somebody with write
    // access to the profile: give B the bytes that decrypt to A's key. Both
    // records are authentic, and both were written by this installation under
    // this data key.
    const stolen = await backing.get('conn:A');
    await backing.set('conn:B', stolen);

    await expect(area.get('conn:B')).rejects.toMatchObject({ failure: 'UNREADABLE' });
    // A is untouched, so the refusal is about the binding and not about
    // having corrupted something.
    expect(await area.get('conn:A')).toBe(KEY_A);
  });

  it('03 — two protected namespaces cannot exchange records', async () => {
    const { k1 } = stores();
    const backing = new MemoryStorageArea();
    const credentials = new ProtectedStorageArea(backing, k1, 'credentials');
    const identity = new ProtectedStorageArea(backing, k1, 'identity-session');
    await k1.initialize(PASSPHRASE);

    await credentials.set('same-name', KEY_A);
    const stored = await backing.get('same-name');
    await identity.set('same-name', 'a session record');
    await backing.set('same-name', stored);

    // Same backing store, same record name, same data key — and the label is
    // authenticated, so the identity store cannot read a credential.
    await expect(identity.get('same-name')).rejects.toMatchObject({ failure: 'UNREADABLE' });
  });
});

describe('TEST-SECURITY-060 — key metadata under attack', () => {
  it('04 — every field of the key record fails closed when edited', async () => {
    const { metadata } = await createWrappedKey(PASSPHRASE, NOW);

    const attacks: readonly [string, unknown][] = [
      ['salt edited', { ...metadata, salt: flip(metadata.salt) }],
      ['wrapped key edited', { ...metadata, wrapped: flip(metadata.wrapped) }],
      ['wrap iv edited', { ...metadata, wrapIv: flip(metadata.wrapIv) }],
      ['key id edited', { ...metadata, keyId: 'kffffffffffffffff' }],
      ['iterations lowered', { ...metadata, iterations: 1 }],
      ['kdf swapped', { ...metadata, kdf: 'MD5' }],
      ['version bumped', { ...metadata, v: 99 }],
      ['wrapped key removed', { ...metadata, wrapped: '' }],
    ];

    for (const [name, tampered] of attacks) {
      await expect(unwrapKey(PASSPHRASE, tampered), name).rejects.toThrow();
    }
    // Lowering the iteration count is worth calling out: it is refused
    // because `kdf` and the wrapping are authenticated together, so an
    // attacker cannot make the derivation cheaper and then brute-force it.
    await expect(unwrapKey(PASSPHRASE, { ...metadata, iterations: 1 })).rejects.toMatchObject({
      failure: 'WRONG_PASSPHRASE',
    });
    expect((await unwrapKey(PASSPHRASE, metadata)).dek.length).toBe(DEK_BYTES);
  });

  it('05 — a damaged key record does not take unrelated records with it', async () => {
    const { k1, durable } = stores();
    const backing = new MemoryStorageArea();
    const area = new ProtectedStorageArea(backing, k1, 'credentials');
    await k1.initialize(PASSPHRASE);
    await area.set('conn:A', KEY_A);
    await area.set('conn:B', KEY_B);

    await durable.set('k1-key', { v: 1, wrapped: 'damaged' });

    // Both are unreadable, and both are *still there*. Nothing is deleted on
    // the way to reporting a failure, because the user may yet restore the
    // key record from a backup.
    expect((await k1.status()).state).toBe('NEEDS_RECOVERY');
    expect(await backing.get('conn:A')).toBeDefined();
    expect(await backing.get('conn:B')).toBeDefined();
    expect(await backing.keys()).toEqual(['conn:A', 'conn:B']);
  });
});

describe('TEST-SECURITY-060 — passphrase change', () => {
  it('06 — the new passphrase opens, the old one stops, the data is untouched', async () => {
    const { k1 } = stores();
    const backing = new MemoryStorageArea();
    const area = new ProtectedStorageArea(backing, k1, 'credentials');
    await k1.initialize(PASSPHRASE);
    await area.set('conn:A', KEY_A);
    const ciphertextBefore = JSON.stringify(await backing.get('conn:A'));

    await k1.changePassphrase(PASSPHRASE, NEXT_PASSPHRASE);

    await k1.lock();
    await expect(k1.unlock(PASSPHRASE)).rejects.toMatchObject({ failure: 'WRONG_PASSPHRASE' });
    expect((await k1.unlock(NEXT_PASSPHRASE)).state).toBe('UNLOCKED');
    expect(await area.get('conn:A')).toBe(KEY_A);

    // Nothing was re-encrypted. Only the wrapping of the data key changed, so
    // an interrupted change cannot leave records under a key nobody holds.
    expect(JSON.stringify(await backing.get('conn:A'))).toBe(ciphertextBefore);
  });

  it('07 — the data key never reaches durable storage during a change', async () => {
    const { k1, durable, memory } = stores();
    await k1.initialize(PASSPHRASE);
    expect(await k1.key()).not.toBeNull();

    await k1.changePassphrase(PASSPHRASE, NEXT_PASSPHRASE);

    const dump = JSON.stringify(
      await Promise.all((await durable.keys()).map((key) => durable.get(key))),
    );
    expect(dump).not.toContain(PASSPHRASE);
    expect(dump).not.toContain(NEXT_PASSPHRASE);

    // The assertion that carries this case: the **unwrapped key itself** is
    // not in any durable record. Checking only for the passphrase strings
    // left a control green that wrote the raw key to disk beside the
    // wrapping, which is the exact failure a re-wrap is supposed to avoid.
    const unwrapped = await memory.get<string>('k1-unlocked');
    expect(typeof unwrapped).toBe('string');
    expect(dump).not.toContain(unwrapped as string);
    expect(await durable.keys()).toEqual(['k1-key', 'k1-state']);
    // And the wrapped record changed, so the absence is not because nothing
    // happened.
    const metadata = await durable.get<{ salt: string; wrapped: string }>('k1-key');
    expect(metadata?.wrapped.length).toBeGreaterThan(0);
    // A fresh salt, so two wrappings of one key share nothing comparable.
    const again = await createWrappedKey(NEXT_PASSPHRASE, NOW);
    expect(metadata?.salt).not.toBe(again.metadata.salt);
  });

  it('08 — a wrong current passphrase changes nothing', async () => {
    const { k1, durable } = stores();
    await k1.initialize(PASSPHRASE);
    const before = JSON.stringify(await durable.get('k1-key'));

    await expect(k1.changePassphrase('not the passphrase', NEXT_PASSPHRASE)).rejects.toMatchObject({
      failure: 'WRONG_PASSPHRASE',
    });

    expect(JSON.stringify(await durable.get('k1-key'))).toBe(before);
    await k1.lock();
    expect((await k1.unlock(PASSPHRASE)).state).toBe('UNLOCKED');
  });

  it('09 — a too-short new passphrase is refused before anything is written', async () => {
    const { k1, durable } = stores();
    await k1.initialize(PASSPHRASE);
    const before = JSON.stringify(await durable.get('k1-key'));

    await expect(k1.changePassphrase(PASSPHRASE, 'short')).rejects.toThrow();

    expect(JSON.stringify(await durable.get('k1-key'))).toBe(before);
  });
});

describe('TEST-SECURITY-060 — session key under attack', () => {
  it('10 — a corrupt or truncated session key locks rather than half-working', async () => {
    const { k1, memory } = stores();
    await k1.initialize(PASSPHRASE);

    for (const corrupt of ['not base64!', toBase64(new Uint8Array(16)), '', 'AAAA']) {
      await memory.set('k1-unlocked', corrupt);
      // A key of the wrong length or shape is not a key. Reporting UNLOCKED
      // here would produce an installation that fails at every decryption
      // while claiming to be open.
      expect((await k1.status()).state, corrupt).toBe('LOCKED');
      expect(await k1.key()).toBeNull();
    }

    // A well-formed but wrong key is a different matter: it is the right
    // shape, so the state is UNLOCKED and the *records* refuse. That is the
    // honest split — the lock is about having a key, the envelope is about
    // whether it is the right one.
    await memory.set('k1-unlocked', toBase64(crypto.getRandomValues(new Uint8Array(DEK_BYTES))));
    expect((await k1.status()).state).toBe('UNLOCKED');
    const backing = new MemoryStorageArea();
    const area = new ProtectedStorageArea(backing, k1, 'credentials');
    await k1.unlock(PASSPHRASE);
    await area.set('conn:A', KEY_A);
    await memory.set('k1-unlocked', toBase64(crypto.getRandomValues(new Uint8Array(DEK_BYTES))));
    await expect(area.get('conn:A')).rejects.toMatchObject({ failure: 'UNREADABLE' });
  });

  it('11 — a missing session key is LOCKED, not OFF and not recovery', async () => {
    const { k1, memory } = stores();
    await k1.initialize(PASSPHRASE);

    await memory.clear();

    // What a browser restart is. Three states are wrong here and one is
    // right: OFF would invite re-initialisation, NEEDS_RECOVERY would tell
    // the user their data is gone, UNLOCKED would be a lie.
    const status = await k1.status();
    expect(status.state).toBe('LOCKED');
    expect(status.keyId).toBeDefined();
    expect((await k1.unlock(PASSPHRASE)).state).toBe('UNLOCKED');
  });
});

describe('TEST-SECURITY-060 — limitations, demonstrated rather than described', () => {
  it('12 — an earlier valid ciphertext IS accepted: rollback is not detected', async () => {
    const { k1 } = stores();
    const backing = new MemoryStorageArea();
    const area = new ProtectedStorageArea(backing, k1, 'credentials');
    await k1.initialize(PASSPHRASE);

    // A key the user has since rotated away from — revoked at the provider,
    // say, or belonging to an account they no longer want used.
    await area.set('conn:A', KEY_A);
    const oldCiphertext = await backing.get('conn:A');
    await area.set('conn:A', KEY_B);
    expect(await area.get('conn:A')).toBe(KEY_B);

    // Somebody with write access to the profile puts the old record back.
    await backing.set('conn:A', oldCiphertext);

    // **This succeeds.** The old envelope is authentic, under the same data
    // key, at the same location — every check K1 makes passes, because every
    // check is about whether these bytes were written by this installation
    // for this slot, and they were.
    expect(await area.get('conn:A')).toBe(KEY_A);

    // Asserted as an accepted limitation rather than left as an absence.
    // Detecting it needs a monotonic counter somewhere the attacker cannot
    // also roll back, and an extension has nowhere like that — the counter
    // would live in the same profile directory. If this test ever starts
    // failing, rollback protection has been added and the threat model in
    // K1_LOCAL_ENCRYPTION.md needs updating to say so.
  });

  it('13 — record names are visible by design, and the docs say so', async () => {
    const { k1 } = stores();
    const backing = new MemoryStorageArea();
    const area = new ProtectedStorageArea(backing, k1, 'credentials');
    await k1.initialize(PASSPHRASE);
    await area.set('conn:A', KEY_A);

    // A reader of the profile learns that a connection exists and its id.
    // That is not hidden and is not claimed to be.
    expect(await backing.keys()).toEqual(['conn:A']);
    expect(await area.keys()).toEqual(['conn:A']);

    const { readFileSync } = await import('node:fs');
    const doc = readFileSync(
      new URL('../../docs/architecture/K1_LOCAL_ENCRYPTION.md', import.meta.url),
      'utf8',
    );
    // The claim and the limitation have to stay together: a document that
    // dropped this line would be claiming metadata confidentiality nothing
    // implements.
    // Matched on the words rather than the emphasis markers, because the
    // formatter rewrites `*names*` to `_names_` and a test that pinned the
    // punctuation would fail on a reformat rather than on a lost claim.
    expect(doc).toMatch(/Record .names. are not encrypted/);
    expect(doc.toLowerCase()).toContain('rollback');
  });
});
