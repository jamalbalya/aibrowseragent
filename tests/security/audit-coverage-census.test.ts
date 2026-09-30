/**
 * TEST-AUDITCOV-001 — every authority-changing panel route reaches the trail.
 *
 * `audit-log.ts` was already guarded in one direction: every type declared in
 * `AUDIT_EVENT_TYPES` must have a producer, because a declared type nobody
 * writes is a promise the trail makes and does not keep. That guard has been in
 * place since the P-038 gap audit and it works.
 *
 * Nothing asked the question the other way round, and the other way round is
 * the one that matters more: does every action which changes what the agent may
 * later do have a type at all? Six did not, and each of them had an audited
 * counterpart sitting beside it, which is what makes the omission a defect
 * rather than a scope decision:
 *
 *  - `session.setPermissionMode` wrote nothing, while revoking a single site
 *    rule wrote `policy.site_rule`. Moving to `skip` is the broader grant of
 *    the two by a wide margin — it removes the confirmation step from every
 *    subsequent action for as long as it stays there.
 *  - `shortcut.create`, `shortcut.retarget` and `shortcut.remove` wrote
 *    nothing, while `schedule.created`, `schedule.updated` and
 *    `schedule.deleted` all existed. A shortcut recorded its runs and not its
 *    configuration, so the trail could say a shortcut launched and could not
 *    say what it had been pointed at when it did.
 *  - `storage.setPreference` wrote nothing, and it decides where records live.
 *  - `data.export` and `data.import` wrote nothing, and import writes
 *    workflows and shortcuts — standing-authority objects — from a file this
 *    device did not author.
 *  - `workflow.remove` wrote nothing, while `workflow.recorded` existed.
 *  - `audit.export` wrote nothing, and it is the trail leaving the device.
 *
 * The census below is the guard that keeps the reverse direction closed. Every
 * control-plane route either records in its own handler, or is named in
 * `EXEMPT` with the reason — so the next control-plane route added has to
 * choose, in a file review rather than in a later audit.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AUDIT_EVENT_TYPES } from '@/audit/audit-log';
import { PANEL_ROUTE_CLASSES, type RouteClass } from '@/messaging/route-trust';

const SRC = resolve(import.meta.dirname, '../../src');
const read = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf8');
const WORKER = read('background/service-worker.ts');

/**
 * Every `router.on('name', …)` handler, split by brace balance.
 *
 * Deliberately not a regex over the whole file: a handler's body is what has to
 * be inspected, and "the next 40 lines" would let a record belonging to the
 * following route satisfy this one.
 */
function handlers(): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  const lines = WORKER.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    // `[a-zA-Z0-9.]` and not `[a-zA-Z.]`: the manual sweep that preceded this
    // test used the latter, and `k1.enable` never appeared in its results.
    const match = /^router\.on\('([a-zA-Z0-9.]+)'/.exec(lines[i] ?? '');
    if (!match) continue;
    let depth = 0;
    let started = false;
    const body: string[] = [];
    for (let j = i; j < lines.length; j += 1) {
      const line = lines[j] ?? '';
      body.push(line);
      for (const ch of line) {
        if (ch === '(' || ch === '{' || ch === '[') {
          depth += 1;
          started = true;
        } else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
      }
      if (started && depth <= 0) break;
    }
    found.set(match[1] as string, body.join('\n'));
  }
  return found;
}

/** A record written from inside the handler, in either of the two layouts. */
const RECORDS = /auditLog\s*\.\s*record|recordShortcutConfigured\(|recordK1\(/;

/**
 * Control-plane routes that deliberately write nothing themselves.
 *
 * Each reason is either **a downstream producer**, verified below to exist, or
 * **nothing to record**. A route may not be added here for being inconvenient:
 * the two admissible reasons are the only two in the table, and a route whose
 * reason is neither belongs in the handler set instead.
 */
const EXEMPT: Readonly<Record<string, { readonly why: string; readonly producer?: string }>> = {
  // Reads and diagnostics. A control-plane class here is about who may ask,
  // not about a change being made — none of these writes anything.
  //
  // `provider.listModels` and `accounts.listModels` used to be here and are not
  // any more. Discovering a gateway's catalogue reaches an external endpoint with
  // the account's credential and decides what the user may then select, so it is
  // an event rather than a read, and both routes now record one. Case 02 is what
  // noticed the entries had gone stale.
  'session.get': { why: 'read' },
  'debug.getLogs': { why: 'read' },
  'evidence.getPayload': { why: 'read' },
  'file.listPendingSelections': { why: 'read' },
  'permission.listPending': { why: 'read' },
  'accounts.runDoctor': { why: 'read' },
  'provider.runDoctor': { why: 'read' },

  // Recorded downstream, by a producer this test checks for.
  'permission.respond': { why: 'downstream', producer: 'permission.decided' },
  'task.pause': { why: 'downstream', producer: 'task.state' },
  'task.resume': { why: 'downstream', producer: 'task.state' },
  'task.retry': { why: 'downstream', producer: 'task.state' },
  'task.cancel': { why: 'downstream', producer: 'task.state' },
  'skill.run': { why: 'downstream', producer: 'shortcut.launched' },
  'workflow.replay': { why: 'downstream', producer: 'workflow.replay' },
  'schedule.runNow': { why: 'downstream', producer: 'schedule.run_started' },
  'schedule.cancelRun': { why: 'downstream', producer: 'schedule.run_cancelled' },
  'workflow.cancelReplay': { why: 'downstream', producer: 'workflow.replay' },

  // A recording in progress is not yet a capability. `workflow.recordStop` is
  // the one that writes `workflow.recorded`, because it is the one that
  // produces something a shortcut can point at; starting and abandoning a
  // recording changes nothing a later run may do.
  'workflow.recordStart': { why: 'nothing to record' },
  'workflow.recordCancel': { why: 'nothing to record' },

  // Preferences that change presentation and verbosity, not authority.
  'settings.setNotificationsEnabled': { why: 'nothing to record' },
  'debug.setLogLevel': { why: 'nothing to record' },

  // A settled decision, not an omission. `provider.state` was declared and
  // never written, and was deleted in the P-038 gap audit on the stated
  // grounds that `provider.selected` already covers which brain is in use.
  // Connecting a provider without selecting it changes nothing the agent
  // reaches, and `provider.setActive` — the route that does change it —
  // records. Re-adding a configuration event here would reverse that decision
  // rather than close a gap.
  'provider.connect': { why: 'downstream', producer: 'provider.selected' },
  'provider.disconnect': { why: 'downstream', producer: 'provider.selected' },

  // Also settled, and stated in `audit-log.ts`: a tool set is a fresh reading
  // on every registration rather than a state that changes, so a refresh event
  // would fire on every worker start and say nothing about a decision.
  'mcp.refresh': { why: 'nothing to record' },

  // Identity and account lifecycle. The trail's subject is what the agent was
  // allowed to do, and it holds no auth event of any kind — there is no
  // `auth.*` type in `AUDIT_EVENT_TYPES` to be missing from. Whether signing in
  // belongs in this trail or in a separate one is a product question nobody has
  // taken, and answering it by quietly adding types here would be taking it.
  'auth.signInWithGoogle': { why: 'nothing to record' },
  'auth.signOut': { why: 'nothing to record' },
  'auth.refresh': { why: 'nothing to record' },
  'auth.startEmailSignIn': { why: 'nothing to record' },
  'auth.verifyEmailSignIn': { why: 'nothing to record' },
  'identities.linkGoogle': { why: 'nothing to record' },
  'identities.startEmailLink': { why: 'nothing to record' },
  'identities.completeEmailLink': { why: 'nothing to record' },
  'identities.detach': { why: 'nothing to record' },
  'accounts.associate': { why: 'nothing to record' },
  'accounts.declineAssociation': { why: 'nothing to record' },
  'accounts.disconnect': { why: 'nothing to record' },

  // Read-only.
  'k1.status': { why: 'read' },
};

describe('TEST-AUDITCOV-001 — audit coverage census over control-plane routes', () => {
  it('01 — every control-plane route either records in its handler or is exempt with a reason', () => {
    const found = handlers();
    const control = Object.entries(PANEL_ROUTE_CLASSES as Record<string, RouteClass>)
      .filter(([, cls]) => cls === 'CLASS_B_PANEL_CONTROL_PLANE')
      .map(([name]) => name)
      .sort();

    // An empty enumeration agrees with everything, so the population is
    // asserted before it is judged. Both halves have to be real: a handler map
    // that came back empty would make every route look exempt, and a route
    // table that came back empty would make every handler look accounted for.
    expect(control.length).toBeGreaterThan(60);
    expect(found.size).toBeGreaterThan(90);
    expect(control.filter((name) => found.has(name)).length).toBe(control.length);

    const unexplained = control.filter(
      (name) => !RECORDS.test(found.get(name) ?? '') && EXEMPT[name] === undefined,
    );
    expect(unexplained).toEqual([]);
  });

  it('02 — the exemption table holds no stale entry', () => {
    // A route that starts recording, or stops being control-plane, must leave
    // the table. Otherwise the table grows into a list of things that were once
    // true and stops being readable as a claim about this build.
    const found = handlers();
    const classes = PANEL_ROUTE_CLASSES as Record<string, RouteClass>;
    const stale = Object.keys(EXEMPT).filter(
      (name) =>
        classes[name] !== 'CLASS_B_PANEL_CONTROL_PLANE' || RECORDS.test(found.get(name) ?? ''),
    );
    expect(stale).toEqual([]);
  });

  it('03 — every claimed downstream producer is a declared type that something writes', () => {
    const declared = new Set<string>(AUDIT_EVENT_TYPES);
    for (const [route, entry] of Object.entries(EXEMPT)) {
      if (entry.producer === undefined) continue;
      expect(declared, `${route} names ${entry.producer}`).toContain(entry.producer);
    }
  });

  it('04 — the six actions this census was written for now record', () => {
    // Named individually rather than counted, so a regression points at the
    // route it broke.
    const found = handlers();
    for (const route of [
      'session.setPermissionMode',
      'shortcut.create',
      'shortcut.retarget',
      'shortcut.remove',
      'storage.setPreference',
      'data.export',
      'data.import',
      'workflow.remove',
      'audit.export',
      // K1's five. The census found these after the first six, because the
      // manual sweep that found the six used a pattern over route names that
      // excluded a digit — `k1.enable` never appeared in it. The table this
      // test imports is the real one, which is the whole reason it is imported
      // rather than matched.
      'k1.enable',
      'k1.disable',
      'k1.unlock',
      'k1.lock',
      'k1.changePassphrase',
    ]) {
      expect(RECORDS.test(found.get(route) ?? ''), route).toBe(true);
    }
  });

  it('05 — the new types carry no name a user typed and no page-derived text', () => {
    // The fields these six records may use, and only these. A display name is
    // text a user chose and a workflow's steps are what it does; the trail has
    // never held either, and the point of a configuration event is the id it
    // points at, not a copy of the thing.
    const permitted = new Set([
      'type',
      'outcome',
      'code',
      'permissionMode',
      'storageMode',
      'recordCount',
      'shortcutId',
      'workflowId',
    ]);
    const found = handlers();
    // `shortcut.*` are left out here: they record through
    // `recordShortcutConfigured`, whose own field list is asserted in 07.
    for (const route of [
      'session.setPermissionMode',
      'storage.setPreference',
      'data.export',
      'data.import',
      'workflow.remove',
      'audit.export',
    ]) {
      const body = found.get(route) ?? '';
      // Read from the object literal itself rather than by line, because
      // formatting decides whether a short record spans one line or six — a
      // per-line pattern here passes or fails on what prettier chose.
      const call = body.slice(body.search(/auditLog\s*\.\s*record/));
      const literal = call.slice(call.indexOf('({') + 1, call.indexOf('})') + 1);
      const fields = [...literal.matchAll(/(?:^|[{,]|\.\.\.\()\s*(\w+):/g)].map(
        (m) => m[1] as string,
      );
      expect(fields.length, route).toBeGreaterThan(0);
      expect(
        fields.filter((f) => !permitted.has(f)),
        route,
      ).toEqual([]);
    }
  });

  it('07 — the shortcut helper records an id and a floor, never a name', () => {
    const helper = WORKER.slice(
      WORKER.indexOf('async function recordShortcutConfigured'),
      WORKER.indexOf('async function summariseShortcut'),
    );
    expect(helper).toContain("type: 'shortcut.configured'");
    expect(helper).toContain('shortcutId,');
    expect(helper).toContain('SHORTCUT_PROFILE_MODE[profile]');
    // The two fields that would turn a configuration record into a copy of the
    // thing it describes.
    expect(helper).not.toContain('displayName');
    expect(helper).not.toContain('allowedTools');
  });

  it('08 — a refused unlock is recorded, and the record cannot narrow the guessing space', () => {
    // Repeated refusals against a profile are the one observable sign of
    // somebody working through passphrases, which is the scenario K1's threat
    // model names. A trail holding only the successes would be silent exactly
    // when it is most worth reading.
    const unlock = handlers().get('k1.unlock') ?? '';
    // Matched with whitespace collapsed. Asserting the literal text of a call
    // that prettier may reflow is a test that fails on formatting, which has
    // already wasted a cycle in this project more than once.
    const flat = unlock.replace(/\s+/g, ' ');
    expect(flat).toContain(
      "recordK1(error instanceof UnlockError ? error.failure : 'UNLOCK_FAILED', 'failed')",
    );

    // And nothing derived from what was typed reaches the record.
    const helper = WORKER.slice(
      WORKER.indexOf('async function recordK1'),
      WORKER.indexOf("router.on('k1.status'"),
    );
    expect(helper).toContain("type: 'k1.protection'");
    for (const forbidden of ['passphrase', 'length', 'hash', 'digest']) {
      expect(helper, forbidden).not.toContain(forbidden);
    }
  });

  it('06 — the mode change records which way the authority went, not merely that it moved', () => {
    // A record saying only "the mode changed" would leave the one question a
    // reader has — did this become looser? — answerable only by finding the
    // previous record, which retention may already have evicted.
    const handler = handlers().get('session.setPermissionMode') ?? '';
    expect(handler).toContain('strictestMode(before, mode) === mode');
    expect(handler).toContain('FROM_');
  });
});
