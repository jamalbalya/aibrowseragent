/**
 * TEST-SECURITY-036 — nothing leaves the device unless it was classified to.
 *
 * The requirement is that every persistent data type carries a classification
 * and that none is ambiguous. A document cannot enforce that; this suite and
 * the total `Record` it exercises can.
 *
 * The mutation cases matter more than the enumeration ones. `cloudEligible`
 * is the single gate every future sync path will call, so each of its
 * fail-closed branches is asserted independently — an `undecided` user, a
 * `local` user, and a secret under a `cloud` user are three different reasons
 * to refuse, and a change that collapsed any two of them would still pass a
 * test that only checked the aggregate.
 */
import { describe, expect, it } from 'vitest';
import {
  cloudEligible,
  isSecret,
  DATA_CLASSES,
  DATA_CLASSIFICATION,
  DATA_STORAGE_MODES,
  PERSISTED_DATA_KINDS,
  SECURE_CREDENTIAL_RECOVERY_EXISTS,
  type PersistedDataKind,
} from '@/storage/data-classification';

describe('TEST-SECURITY-036 — data classification', () => {
  it('classifies every persisted kind, with no ambiguity', () => {
    for (const kind of PERSISTED_DATA_KINDS) {
      expect(DATA_CLASSES).toContain(DATA_CLASSIFICATION[kind]);
    }
    // The table holds nothing that is not a declared kind, so it cannot drift
    // into carrying entries for things that no longer exist.
    expect(Object.keys(DATA_CLASSIFICATION).sort()).toEqual([...PERSISTED_DATA_KINDS].sort());
  });

  it('uploads nothing at all while the user has not chosen', () => {
    for (const kind of PERSISTED_DATA_KINDS) {
      expect(cloudEligible(kind, 'undecided')).toBe(false);
    }
  });

  it('uploads nothing at all in local mode', () => {
    for (const kind of PERSISTED_DATA_KINDS) {
      expect(cloudEligible(kind, 'local')).toBe(false);
    }
  });

  it('never uploads a secret, even with cloud sync switched on', () => {
    const secrets: readonly PersistedDataKind[] = [
      'provider-credential',
      'connector-token',
      'aba-refresh-token',
    ];
    for (const kind of secrets) {
      expect(isSecret(kind)).toBe(true);
      expect(cloudEligible(kind, 'cloud')).toBe(false);
    }
  });

  it('never uploads page content under any mode', () => {
    for (const mode of DATA_STORAGE_MODES) {
      expect(cloudEligible('page-content', mode)).toBe(false);
    }
  });

  it('never uploads anything classified NEVER_PERSISTED or LOCAL_ONLY', () => {
    for (const kind of PERSISTED_DATA_KINDS) {
      const classification = DATA_CLASSIFICATION[kind];
      if (classification === 'NEVER_PERSISTED' || classification === 'LOCAL_ONLY') {
        expect(cloudEligible(kind, 'cloud')).toBe(false);
      }
    }
  });

  it('uploads user-selectable and cloud-synced kinds only in cloud mode', () => {
    for (const kind of PERSISTED_DATA_KINDS) {
      const classification = DATA_CLASSIFICATION[kind];
      if (classification === 'CLOUD_SYNCED' || classification === 'USER_SELECTABLE') {
        expect(cloudEligible(kind, 'cloud')).toBe(true);
        expect(cloudEligible(kind, 'local')).toBe(false);
        expect(cloudEligible(kind, 'undecided')).toBe(false);
      }
    }
  });

  it('treats recoverable-if-secure as local-only while no secure design exists', () => {
    // The flag is what makes this reviewable in one line when it changes.
    expect(SECURE_CREDENTIAL_RECOVERY_EXISTS).toBe(false);
    const recoverable = PERSISTED_DATA_KINDS.filter(
      (kind) => DATA_CLASSIFICATION[kind] === 'SECRET_RECOVERABLE_ONLY_IF_SECURE_DESIGN_EXISTS',
    );
    for (const kind of recoverable) {
      expect(cloudEligible(kind, 'cloud')).toBe(false);
    }
  });

  it('holds provider credentials as SECRET_LOCAL_ONLY, not merely un-synced', () => {
    // Stated as an equality rather than through `cloudEligible`, so a change
    // that reclassified the key while leaving the gate intact still fails.
    expect(DATA_CLASSIFICATION['provider-credential']).toBe('SECRET_LOCAL_ONLY');
    expect(DATA_CLASSIFICATION['aba-access-token']).toBe('NEVER_PERSISTED');
    expect(DATA_CLASSIFICATION['page-content']).toBe('NEVER_PERSISTED');
  });
});
