/**
 * TEST-CONNECTOR-008 — telling the user a skill's connector is not connected.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is display logic, and the cases below hold it to being only that. The
 * authority over whether a connector call may happen is the connector's own
 * preflight, which refuses an operation on a connector that is not `READY`
 * before anything is sent. Nothing here can grant that and nothing here can
 * withhold it.
 *
 * It is tested anyway, for two reasons. It decides what a user is told before
 * approving a run — the alternative was finding out by watching step one fail
 * — and it has exactly the shape that `digestStep` and `doctorVerdict` were
 * both extracted out of: a few branches inside a surface module, reachable
 * only by rendering it, where a wrong branch survives every suite.
 *
 * The wrong branches here are specific. Treating `NEEDS_AUTH` as connected
 * produces the surprise this exists to remove. Skipping a connector the build
 * does not have makes a skill that can never run look ready.
 */
import { describe, expect, it } from 'vitest';
import { missingConnectors, type ConnectorReadiness } from '@/sidepanel/connector-readiness';
import { AUTH_STATES } from '@/security/state/auth-states';

const GITHUB: ConnectorReadiness = { id: 'github', state: 'READY', displayName: 'GitHub' };

describe('only a ready connector counts as connected', () => {
  it('reports nothing when every required connector is ready', () => {
    expect(missingConnectors(['github'], [GITHUB])).toEqual([]);
  });

  it('reports a connector in any state other than READY', () => {
    // Swept over the shared state machine rather than enumerated by hand, so
    // a state added to it later is covered here by construction instead of by
    // somebody remembering. Every one of them is a connector whose next call
    // the preflight will refuse.
    const other = AUTH_STATES.filter((state) => state !== 'READY');
    expect(other.length).toBeGreaterThan(3);
    for (const state of other) {
      expect(missingConnectors(['github'], [{ ...GITHUB, state }]), state).toEqual(['GitHub']);
    }
  });

  it('does not treat an authorization in progress as finished', () => {
    // Named separately because it is the one an optimistic implementation gets
    // wrong: a connector mid-flow looks like it is about to work.
    expect(missingConnectors(['github'], [{ ...GITHUB, state: 'AUTHENTICATING' }])).toEqual([
      'GitHub',
    ]);
  });
});

describe('a connector the build does not have is said out loud', () => {
  it('reports a required connector that is not in the list at all', () => {
    // The case most worth reporting: a skill requiring something that does
    // not exist here can never run, and dropping it would make it look ready.
    expect(missingConnectors(['jira'], [GITHUB])).toEqual(['jira']);
  });

  it('reports it by id, because there is no display name to use', () => {
    expect(missingConnectors(['jira'], [])).toEqual(['jira']);
  });
});

describe('what the user actually reads', () => {
  it('uses the display name rather than the id', () => {
    expect(missingConnectors(['github'], [{ id: 'github', state: 'NEEDS_AUTH' }])).toEqual([
      'github',
    ]);
    expect(
      missingConnectors(['github'], [{ id: 'github', state: 'NEEDS_AUTH', displayName: 'GitHub' }]),
    ).toEqual(['GitHub']);
  });

  it('keeps the order the skill declared, so the sentence is stable', () => {
    // Declared in an order that is not the sorted one, on purpose: a version
    // that sorted would agree with a test whose input happened to be sorted
    // already, and the mutation that sorts is the one this pins.
    const connectors: ConnectorReadiness[] = [
      { id: 'alpha', state: 'NEEDS_AUTH', displayName: 'Alpha' },
      { id: 'zulu', state: 'NEEDS_AUTH', displayName: 'Zulu' },
    ];
    expect(missingConnectors(['zulu', 'alpha'], connectors)).toEqual(['Zulu', 'Alpha']);
  });

  it('reports only the ones that are missing, not the whole requirement', () => {
    const connectors: ConnectorReadiness[] = [
      GITHUB,
      { id: 'other', state: 'NEEDS_AUTH', displayName: 'Other' },
    ];
    expect(missingConnectors(['github', 'other'], connectors)).toEqual(['Other']);
  });

  it('says nothing about a skill that requires no connector', () => {
    expect(missingConnectors([], [GITHUB])).toEqual([]);
    expect(missingConnectors([], [])).toEqual([]);
  });
});
