/**
 * TEST-SECURITY-056 — what may travel in a file, decided once.
 *
 * The export used to carry a hand-written list of four kinds that happened to
 * agree with what anybody would have chosen. Nothing connected that list to a
 * decision, so a fifth kind could be added to it by somebody who had not
 * thought about what a portable file is — and, in the other direction, the
 * classification table claimed to cover "every kind of thing this extension
 * persists" while two stores it had never heard of were writing to disk.
 *
 * These cases hold the table to both halves: that it is total over what is
 * really persisted, and that the exporter reads it rather than paraphrasing
 * it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DATA_CLASSIFICATION,
  EXPORT_PORTABILITY,
  isSecret,
  PERSISTED_DATA_KINDS,
  PORTABILITY_CLASSES,
  PORTABLE_DATA_KINDS,
  type PersistedDataKind,
} from '@/storage/data-classification';
import { EXPORTABLE_KINDS } from '@/storage/data-export';

describe('TEST-SECURITY-056 — export portability', () => {
  it('01 — every persisted kind has a portability class, and a real one', () => {
    for (const kind of PERSISTED_DATA_KINDS) {
      expect(EXPORT_PORTABILITY[kind], kind).toBeDefined();
      expect(PORTABILITY_CLASSES, kind).toContain(EXPORT_PORTABILITY[kind]);
    }
    // Total in the other direction too: a class here that names nothing is a
    // classification somebody wrote and never applied.
    expect(Object.keys(EXPORT_PORTABILITY).sort()).toEqual([...PERSISTED_DATA_KINDS].sort());
  });

  it('02 — the two stores the portability audit found are classified', () => {
    // `workspace` and `skill-run` were persisted and absent from the table,
    // which is the exact failure a total table is supposed to make impossible
    // — and did not, because nothing forces a new *store* to declare a kind.
    // Their presence here is the fix; this case is what keeps them.
    expect(PERSISTED_DATA_KINDS).toContain('workspace');
    expect(PERSISTED_DATA_KINDS).toContain('skill-run');
    expect(EXPORT_PORTABILITY.workspace).toBe('REQUIRES_FURTHER_SECURITY_DESIGN');
    expect(EXPORT_PORTABILITY['skill-run']).toBe('LOCAL_ONLY');
  });

  it('03 — no secret is portable, under any class', () => {
    for (const kind of PERSISTED_DATA_KINDS) {
      if (!isSecret(kind)) continue;
      expect(EXPORT_PORTABILITY[kind], kind).toBe('NOT_PORTABLE_BY_DESIGN');
      expect(PORTABLE_DATA_KINDS, kind).not.toContain(kind);
    }
  });

  it('04 — the exporter reads the table rather than keeping its own list', () => {
    // Identity, not merely agreement. A copy that agrees today is a copy that
    // can stop agreeing.
    expect(EXPORTABLE_KINDS).toBe(PORTABLE_DATA_KINDS);
    expect([...EXPORTABLE_KINDS].sort()).toEqual([
      'connection-metadata',
      'preference',
      'shortcut',
      'workflow',
    ]);
  });

  it('05 — the three things a portable file must never carry are classified out', () => {
    // Authorization: a site rule is consent, and an imported one would be an
    // archive granting itself permission to automate a site.
    expect(EXPORT_PORTABILITY.policy).toBe('NOT_PORTABLE_BY_DESIGN');
    // A safety interlock: `persistence-health` gates execution, so a HEALTHY
    // record from elsewhere would be an archive clearing this device's gate.
    expect(EXPORT_PORTABILITY['persistence-health']).toBe('NOT_PORTABLE_BY_DESIGN');
    // Identity: two installations claiming one owner.
    expect(EXPORT_PORTABILITY['identity-profile']).toBe('LOCAL_ONLY');
    expect(EXPORT_PORTABILITY['device-id']).toBe('LOCAL_ONLY');
  });

  it('06 — tasks and workspaces are deferred with a reason, not merely omitted', () => {
    // A task carries page-derived tab context, a monotone taint state, a
    // per-task HMAC salt and evidence ids. Omission and deferral look the
    // same from outside the file; the classification is what distinguishes
    // "nobody got round to it" from "this needs a design first".
    expect(EXPORT_PORTABILITY.task).toBe('REQUIRES_FURTHER_SECURITY_DESIGN');
    expect(EXPORT_PORTABILITY.workspace).toBe('REQUIRES_FURTHER_SECURITY_DESIGN');
    expect(PORTABLE_DATA_KINDS).not.toContain('task');
    expect(PORTABLE_DATA_KINDS).not.toContain('workspace');
  });

  it('07 — portability and cloud eligibility are separate questions', () => {
    // `audit` is USER_SELECTABLE for cloud and LOCAL_ONLY for export: a hash
    // chain re-anchored on another device would verify while describing
    // decisions that device never made. Collapsing the two tables into one
    // would have to get one of them wrong.
    expect(DATA_CLASSIFICATION.audit).toBe('USER_SELECTABLE');
    expect(EXPORT_PORTABILITY.audit).toBe('LOCAL_ONLY');
    // Same shape for the brain: syncable in principle, not portable, because
    // it names a connection whose credential deliberately does not travel.
    expect(DATA_CLASSIFICATION['ai-brain']).toBe('USER_SELECTABLE');
    expect(EXPORT_PORTABILITY['ai-brain']).toBe('LOCAL_ONLY');
  });

  it('08 — reclassifying a kind portable fails the build until it has a section', () => {
    // Where the enforcement actually is, said accurately because the first
    // attempt at it was not.
    //
    // `data-export` asserts at module load that every portable kind has a
    // section of the document to be written into. That map is the review
    // gate: marking `task` portable does not quietly start exporting tasks,
    // it throws — and the person doing it has to decide what a task looks
    // like in a file somebody may mail before anything can ship.
    //
    // An earlier version of this check compared the class against
    // `REQUIRES_FURTHER_SECURITY_DESIGN`, which could never fire: a kind
    // reclassified `PORTABLE` is by definition no longer in that state. The
    // negative control caught it passing, which is the whole reason to run
    // one.
    const source = readFileSync(
      new URL('../../src/storage/data-export.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('SECTION_FOR_KIND');
    expect(source).toContain('the export format has no section for it');

    const portableWithoutSection = PERSISTED_DATA_KINDS.filter(
      (kind: PersistedDataKind) =>
        PORTABLE_DATA_KINDS.includes(kind) &&
        !['workflow', 'shortcut', 'connection-metadata', 'preference'].includes(kind),
    );
    expect(portableWithoutSection).toEqual([]);
  });
});
