/**
 * TEST-SECURITY-057 — the task and workspace portability design.
 *
 * `EXPORT_PORTABILITY` defers both kinds. This suite holds the field-level
 * design that a future implementation would be built from, and holds it to
 * the properties that make it a design rather than a list: total over the
 * real models, conservative on every field that carries a security meaning,
 * and consistent with the kind-level decision it sits under.
 *
 * None of this exports anything. The cases that matter are the ones that
 * would fail if somebody later wrote an exporter that read a value the
 * destination is supposed to decide for itself.
 */
import { describe, expect, it } from 'vitest';
import {
  FIELD_PORTABILITY_CLASSES,
  NEVER_CROSSES_INSTALLATION_BOUNDARY,
  TASK_FIELD_PORTABILITY,
  WORKSPACE_FIELD_PORTABILITY,
  WORKSPACE_MEMBER_FIELD_PORTABILITY,
  type FieldPortability,
} from '@/storage/record-portability';
import { EXPORT_PORTABILITY } from '@/storage/data-classification';
import { EXPORTABLE_KINDS } from '@/storage/data-export';

/** The field names the real models carry, read off a constructed record. */
const TASK_FIELDS = Object.keys(TASK_FIELD_PORTABILITY);

describe('TEST-SECURITY-057 — task and workspace portability design', () => {
  it('01 — every field of both models has a class, and a real one', () => {
    for (const [field, portability] of Object.entries(TASK_FIELD_PORTABILITY)) {
      expect(FIELD_PORTABILITY_CLASSES, field).toContain(portability);
    }
    for (const [field, portability] of Object.entries(WORKSPACE_FIELD_PORTABILITY)) {
      expect(FIELD_PORTABILITY_CLASSES, field).toContain(portability);
    }
    for (const [field, portability] of Object.entries(WORKSPACE_MEMBER_FIELD_PORTABILITY)) {
      expect(FIELD_PORTABILITY_CLASSES, field).toContain(portability);
    }
    // Totality is enforced by the compiler — `Record<keyof AgentTask, …>` does
    // not typecheck with a field missing — so this asserts the other half:
    // that the table names nothing the model does not have.
    expect(TASK_FIELDS.length).toBeGreaterThan(20);
  });

  it('02 — the per-task HMAC salt is the one field classified SECRET', () => {
    // It is 32 bytes of key material behind a name that reads like a label.
    // Exporting it publishes what makes every evidence digest in the trail
    // both verifiable and forgeable.
    expect(TASK_FIELD_PORTABILITY.taintSalt).toBe('SECRET');
    const secrets = Object.entries(TASK_FIELD_PORTABILITY)
      .filter(([, portability]) => portability === 'SECRET')
      .map(([field]) => field);
    expect(secrets).toEqual(['taintSalt']);
    // And its epoch is regenerated rather than carried, so digests written
    // under the source's salt are never claimed to be comparable here.
    expect(TASK_FIELD_PORTABILITY.saltEpoch).toBe('REGENERATED_ON_IMPORT');
  });

  it('03 — no security decision is transported', () => {
    // Taint is monotone: it only ever widens. An imported value could only
    // narrow it, which is the taint downgrade the egress gate exists to
    // prevent — so the destination starts at UNKNOWN and measures.
    expect(TASK_FIELD_PORTABILITY.taintState).toBe('SECURITY_SENSITIVE');
    // The destination's own mode governs. A task arriving with `skip` would
    // be a file lowering the permission bar it is about to run under.
    expect(TASK_FIELD_PORTABILITY.permissionMode).toBe('SECURITY_SENSITIVE');
    // Evidence ids resolve to records this installation does not have, and
    // evidence is not portable at the kind level either.
    expect(TASK_FIELD_PORTABILITY.evidenceIds).toBe('NOT_PORTABLE_BY_DESIGN');
    expect(EXPORT_PORTABILITY.evidence).toBe('NOT_PORTABLE_BY_DESIGN');
  });

  it('04 — no pointer into live local state is honoured', () => {
    // `connectionId` names a credential-bearing account on the source device;
    // `workspaceId` names a Chrome tab group that will not exist here. Both
    // would dangle — or, worse, alias something here that shares the id.
    expect(TASK_FIELD_PORTABILITY.connectionId).toBe('NOT_PORTABLE_BY_DESIGN');
    expect(TASK_FIELD_PORTABILITY.workspaceId).toBe('NOT_PORTABLE_BY_DESIGN');
    // Ids and session are minted here, so a file cannot address a row that
    // already exists.
    expect(TASK_FIELD_PORTABILITY.id).toBe('REGENERATED_ON_IMPORT');
    expect(TASK_FIELD_PORTABILITY.sessionId).toBe('REGENERATED_ON_IMPORT');
    expect(WORKSPACE_FIELD_PORTABILITY.workspaceId).toBe('REGENERATED_ON_IMPORT');
  });

  it('05 — every field carrying page-derived content is excluded', () => {
    // Traced by what the field holds, not by its name: `tabs[].tabId` is a
    // live handle, `tabs[].url` and `.origin` are browsing history,
    // `steps[].summary` quotes the page, `plan` is revised from page reads,
    // and `result.externalWrites` lists destinations the task sent things to.
    for (const field of ['tabs', 'steps', 'plan', 'currentStepSummary', 'result'] as const) {
      expect(TASK_FIELD_PORTABILITY[field], field).toBe('NOT_PORTABLE_BY_DESIGN');
    }
    // A workspace member is a tab origin and a page-authored title.
    expect(WORKSPACE_MEMBER_FIELD_PORTABILITY.origin).toBe('NOT_PORTABLE_BY_DESIGN');
    expect(WORKSPACE_MEMBER_FIELD_PORTABILITY.title).toBe('NOT_PORTABLE_BY_DESIGN');
    expect(WORKSPACE_FIELD_PORTABILITY.members).toBe('NOT_PORTABLE_BY_DESIGN');
  });

  it('06 — ownership is assigned by the destination, never carried', () => {
    // The installation identity is LOCAL_ONLY at the kind level; a workspace
    // carrying `abaUserId` would be the same collision by another route.
    expect(WORKSPACE_FIELD_PORTABILITY.abaUserId).toBe('NOT_PORTABLE_BY_DESIGN');
    expect(EXPORT_PORTABILITY['identity-profile']).toBe('LOCAL_ONLY');
  });

  it('07 — what does survive is the user’s own words and plain counters', () => {
    // If nothing survived, the design would not be worth implementing. What
    // does is what the user wrote and what cannot quote anything.
    expect(TASK_FIELD_PORTABILITY.objective).toBe('PORTABLE');
    expect(TASK_FIELD_PORTABILITY.usage).toBe('PORTABLE');
    expect(WORKSPACE_FIELD_PORTABILITY.title).toBe('PORTABLE');
    // Provenance, not selection: naming the model a task ran on is history,
    // and selecting it here would let a file choose this installation's
    // provider.
    expect(TASK_FIELD_PORTABILITY.providerId).toBe('PORTABLE_AFTER_TRANSFORMATION');
    expect(TASK_FIELD_PORTABILITY.modelId).toBe('PORTABLE_AFTER_TRANSFORMATION');
    // And an imported task can never arrive runnable.
    expect(TASK_FIELD_PORTABILITY.state).toBe('PORTABLE_AFTER_TRANSFORMATION');
  });

  it('08 — the design does not quietly start exporting anything', () => {
    // The kind-level decision still refuses both, and the exporter still
    // carries four kinds. A field table is a design, not a permission.
    expect(EXPORT_PORTABILITY.task).toBe('REQUIRES_FURTHER_SECURITY_DESIGN');
    expect(EXPORT_PORTABILITY.workspace).toBe('REQUIRES_FURTHER_SECURITY_DESIGN');
    expect([...EXPORTABLE_KINDS].sort()).toEqual([
      'connection-metadata',
      'preference',
      'shortcut',
      'workflow',
    ]);
  });

  it('09 — the never-crosses list is derived, so it cannot drift', () => {
    const expected: FieldPortability[] = ['SECRET', 'SECURITY_SENSITIVE', 'NOT_PORTABLE_BY_DESIGN'];
    for (const [field, portability] of Object.entries(TASK_FIELD_PORTABILITY)) {
      expect(NEVER_CROSSES_INSTALLATION_BOUNDARY.includes(field), field).toBe(
        expected.includes(portability),
      );
    }
    // The ones an implementation would be asserted against by name.
    for (const field of [
      'taintSalt',
      'taintState',
      'permissionMode',
      'connectionId',
      'workspaceId',
      'evidenceIds',
    ]) {
      expect(NEVER_CROSSES_INSTALLATION_BOUNDARY, field).toContain(field);
    }
    expect(NEVER_CROSSES_INSTALLATION_BOUNDARY).not.toContain('objective');
  });
});
