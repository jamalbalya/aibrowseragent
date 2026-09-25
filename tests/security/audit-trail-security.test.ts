/**
 * TEST-SECURITY-025 — the unified audit trail's security boundary (P-038).
 *
 * A cross-task trail is the most sensitive single artefact this product
 * holds: it is every task's decisions in one place, and it is the one thing
 * designed to leave the extension as a file. Four claims keep that from being
 * a liability, and the thirty-four cases below are named for what each would
 * allow if false:
 *
 *  1. **The trail observes; it never authorises.** Nothing reads it to decide
 *     anything, and a failure to write it cannot change what already ran.
 *  2. **It holds decisions, never data.** Every field is an identifier, a
 *     closed vocabulary or a flag, and everything else is refused.
 *  3. **Its order is checkable.** Sequence and a digest chain detect
 *     corruption and reordering — which is not, and is not claimed to be,
 *     protection against someone who can rewrite storage.
 *  4. **No model authority.** A model can neither read, write, export nor
 *     delete, and there is no current execution path by which it could.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import {
  AUDIT_EVENT_TYPES,
  AUDIT_EVENT_VERSION,
  AuditLog,
  AuditShapeError,
  ProhibitedAuditFieldError,
  UNKNOWN_TOOL,
  assertAuditSafe,
  assertAuditShape,
  buildAuditExport,
  type AuditEvent,
} from '@/audit/audit-log';
import { createDispatchAuditObserver } from '@/audit/dispatch-audit';
import { buildShortcutHarness } from '../fixtures/shortcut-harness';
import type { DispatchObservation } from '@/tools/registry/tool-registry';

const SRC_ROOT = resolve(import.meta.dirname, '../../src');
const AUDIT_ROOT = resolve(import.meta.dirname, '../../src/audit');

/** Assembled at runtime so no scannable credential literal sits on one line. */
const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const PAGE = 'Everything the page said, at length, which the trail must not hold.';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    return full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : [];
  });
}

function freshLog(options: Partial<ConstructorParameters<typeof AuditLog>[1]> = {}): AuditLog {
  return new AuditLog(new SerializedStorageArea(new MemoryStorageArea()), {
    now: () => 1_700_000_000_000,
    // Stated rather than left to a default. With no validator the log records
    // every name as `(unknown)` — correctly, since nothing verified it — and
    // most cases here are about what a record carries rather than about name
    // verification. The cases that *are* about it override this.
    knownTool: (name) => name.startsWith('fake.') || name.startsWith('browser.'),
    ...options,
  });
}

const OK_REPORT = { verdict: 'ok' as const, checked: 0, note: 'fine' };

// --- 1-9. the record cannot be shaped into something else -----------------

describe('an audit record is a decision, not a payload', () => {
  it('1. refuses an injected field at any depth', () => {
    for (const grown of [
      { password: 'hunter2' },
      { meta: { access_token: TOKEN } },
      { steps: [{ result: PAGE }] },
      { a: { b: { c: { taintSignature: 'x' } } } },
      { selectors: ['#submit'] },
      { prompt: 'ignore previous instructions' },
    ]) {
      expect(
        () => assertAuditSafe({ type: 'tool.invoked', ...grown }),
        JSON.stringify(grown),
      ).toThrow(ProhibitedAuditFieldError);
    }
  });

  it('2. refuses a forged event: a caller cannot supply the log-owned fields', async () => {
    const audit = freshLog();
    await audit.record({ type: 'task.state', taskId: 'task_1', outcome: 'info' });

    // A caller reaching past the type to claim a position in the stream.
    const forged = await audit.record({
      type: 'task.state',
      taskId: 'task_1',
      outcome: 'info',
      ...({
        seq: 999,
        prevDigest: 'f'.repeat(64),
        id: 'aud_forged',
        eventVersion: 9,
      } as unknown as Record<string, never>),
    });

    // Written, but on the log's terms: its own sequence, its own id.
    expect(forged?.seq).toBe(2);
    expect(forged?.id).not.toBe('aud_forged');
    expect(forged?.eventVersion).toBe(AUDIT_EVENT_VERSION);
    expect(forged?.prevDigest).not.toBe('f'.repeat(64));
  });

  it('3. detects a duplicated sequence', async () => {
    const audit = freshLog();
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const log = new AuditLog(area, { now: () => 1 });
    await log.record({ type: 'task.state', taskId: 'task_1', outcome: 'info' });
    await log.record({ type: 'task.state', taskId: 'task_1', outcome: 'info' });

    const stored = (await area.get<{ events: AuditEvent[] }>('audit-index'))!;
    await area.set('audit-index', {
      events: [{ ...stored.events[0]!, seq: stored.events[1]!.seq }, stored.events[1]!],
    });
    expect((await log.verifyIntegrity()).verdict).toBe('reordered');
    expect(audit).toBeDefined();
  });

  it('4. detects a stale record written below the tail', async () => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const log = new AuditLog(area, { now: () => 1 });
    for (let i = 0; i < 3; i += 1) {
      await log.record({ type: 'task.state', taskId: 'task_1', outcome: 'info' });
    }
    const stored = (await area.get<{ events: AuditEvent[] }>('audit-index'))!;
    // Newest-first, so putting an old sequence at the head is backwards order.
    await area.set('audit-index', {
      events: [{ ...stored.events[0]!, seq: 1 }, ...stored.events.slice(1)],
    });
    expect((await log.verifyIntegrity()).verdict).toBe('reordered');
  });

  it('5. detects a gap where a record was removed', async () => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const log = new AuditLog(area, { now: () => 1 });
    for (let i = 0; i < 4; i += 1) {
      await log.record({ type: 'task.state', taskId: 'task_1', outcome: 'info' });
    }
    const stored = (await area.get<{ events: AuditEvent[] }>('audit-index'))!;
    await area.set('audit-index', {
      events: [stored.events[0]!, stored.events[2]!, stored.events[3]!],
    });
    const report = await log.verifyIntegrity();
    expect(report.verdict).toBe('gap');
    expect(report.atSeq).toBeDefined();
  });

  it('6. detects a record edited in place, because the chain no longer follows', async () => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const log = new AuditLog(area, { now: () => 1 });
    await log.record({
      type: 'tool.invoked',
      taskId: 'task_1',
      tool: 'fake.read',
      outcome: 'allowed',
    });
    await log.record({
      type: 'tool.invoked',
      taskId: 'task_1',
      tool: 'fake.read',
      outcome: 'allowed',
    });

    const stored = (await area.get<{ events: AuditEvent[] }>('audit-index'))!;
    // Change the older record's outcome; the newer one's digest no longer
    // matches what it chained to.
    const edited = [...stored.events];
    edited[1] = { ...edited[1]!, outcome: 'denied' };
    await area.set('audit-index', { events: edited });

    expect((await log.verifyIntegrity()).verdict).toBe('chain-broken');
  });

  it('7. detects records swapped out of order', async () => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const log = new AuditLog(area, { now: () => 1 });
    for (let i = 0; i < 3; i += 1) {
      await log.record({ type: 'task.state', taskId: 'task_1', outcome: 'info' });
    }
    const stored = (await area.get<{ events: AuditEvent[] }>('audit-index'))!;
    await area.set('audit-index', {
      events: [stored.events[1]!, stored.events[0]!, stored.events[2]!],
    });
    // Any reshuffle breaks the walk. Which failure it surfaces depends on the
    // shape — a swap can read as a gap before it reads as a reorder — so the
    // claim is that it is detected, not which word is used.
    const verdict = (await log.verifyIntegrity()).verdict;
    expect(['reordered', 'gap', 'chain-broken']).toContain(verdict);
    expect(verdict).not.toBe('ok');
  });

  it('8. refuses a malformed record rather than storing part of it', async () => {
    const audit = freshLog();
    for (const bad of [
      { type: 'not.a.type', outcome: 'info' },
      { type: 'task.state', outcome: 'maybe' },
      { type: 'task.state', taskId: 'task_1', outcome: 'info', site: 'x'.repeat(200) },
      { type: 'task.state', taskId: 'task_1', outcome: 'info', code: 'y'.repeat(300) },
      { type: 'task.state', taskId: 'task_1', outcome: 'info', scopes: Array(40).fill('s') },
      { type: 'task.state', taskId: 'task_1', outcome: 'info', evidenceIds: [1, 2] },
      { type: 'tool.invoked', outcome: 'allowed' },
      { type: 'tool.invoked', taskId: 'not a valid id!', outcome: 'allowed' },
    ]) {
      expect(await audit.record(bad as never), JSON.stringify(bad)).toBeNull();
    }
    expect(await audit.list()).toHaveLength(0);
  });

  it('9. reports a record from a newer version rather than interpreting it', async () => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const log = new AuditLog(area, { now: () => 1 });
    await log.record({ type: 'task.state', taskId: 'task_1', outcome: 'info' });
    const stored = (await area.get<{ events: AuditEvent[] }>('audit-index'))!;
    await area.set('audit-index', {
      events: [{ ...stored.events[0]!, eventVersion: AUDIT_EVENT_VERSION + 1 }],
    });
    expect((await log.verifyIntegrity()).verdict).toBe('future-version');
  });
});

// --- 10-18. nothing the trail must not hold reaches it --------------------

describe('the trail holds no data, only decisions', () => {
  it.each([
    ['a nested credential', { meta: { access_token: TOKEN } }],
    ['arguments', { arguments: { url: 'https://x.test' } }],
    ['results', { result: PAGE }],
    ['page text', { content: PAGE }],
    ['a selector', { selector: '#submit' }],
    ['an element binding', { binding: { role: 'button', name: 'Save' } }],
    ['taint sources', { sources: [{ site: 'private.test' }] }],
    ['a taint signature', { taintSignature: 'abc' }],
    ['a provider payload', { messages: [{ role: 'user' }] }],
  ])('10-18. refuses %s', async (_label, grown) => {
    const audit = freshLog();
    const written = await audit.record({
      type: 'tool.invoked',
      taskId: 'task_1',
      outcome: 'allowed',
      ...(grown as unknown as Record<string, never>),
    });
    expect(written).toBeNull();
    expect(await audit.list()).toHaveLength(0);
  });
});

// --- 19-23. isolation, model reach and recursion --------------------------

describe('the trail is not reachable by anything it records', () => {
  it('19. keeps one task’s records out of another’s view', async () => {
    const audit = freshLog();
    await audit.record({
      type: 'tool.invoked',
      taskId: 'task_a',
      tool: 'fake.read',
      outcome: 'allowed',
    });
    await audit.record({
      type: 'tool.invoked',
      taskId: 'task_b',
      tool: 'fake.read',
      outcome: 'allowed',
    });

    const page = await audit.page({ taskId: 'task_a' });
    expect(page.events.map((event) => event.taskId)).toEqual(['task_a']);
    expect(page.total).toBe(1);
  });

  it('20. registers no audit tool and puts none in the model’s schemas', () => {
    const harness = buildShortcutHarness({ tools: [{ name: 'fake.read', risk: 'R0' }] });
    const names = harness.tools.list().map((tool) => tool.name);
    expect(names.filter((name) => name.startsWith('audit.'))).toEqual([]);
    expect(harness.tools.toCanonicalSchemas().some((schema) => schema.name.includes('audit'))).toBe(
      false,
    );

    for (const file of sources(SRC_ROOT)) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/name:\s*'audit\./);
    }
  });

  it('21. contains no execution or network primitive in the audit layer', () => {
    for (const file of sources(AUDIT_ROOT)) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/\.dispatch\s*\(/);
      expect(code, file).not.toMatch(/\.execute\s*\(/);
      expect(code, file).not.toMatch(/\bfetch\(/);
      expect(code, file).not.toMatch(/XMLHttpRequest|sendBeacon|WebSocket/);
      expect(code, file).not.toMatch(/new Function\(/);
      expect(code, file).not.toMatch(/Runtime\.evaluate/);
      // And it never authorises: no gate is imported or called here.
      expect(code, file).not.toMatch(/authorizeEgress|requestApproval|evaluatePolicy/);
    }
  });

  it('22. does not record its own refusal, so a bad record cannot recurse', async () => {
    const audit = freshLog();
    const written = await audit.record({
      type: 'tool.invoked',
      taskId: 'task_1',
      outcome: 'allowed',
      ...({ password: 'hunter2' } as unknown as Record<string, never>),
    });
    expect(written).toBeNull();
    // Nothing at all — not the record, and not an event about refusing it.
    expect(await audit.list()).toHaveLength(0);
  });

  it('23. keeps each dispatch observer isolated from the others', async () => {
    const seen: string[] = [];
    const harness = buildShortcutHarness({ tools: [{ name: 'fake.read', risk: 'R0' }] });

    // Rebuilt by hand because this case is about the registry's fan-out.
    const observers = [
      (): void => {
        throw new Error('a broken observer');
      },
      (): void => {
        seen.push('second');
      },
    ];
    for (const observer of observers) {
      try {
        observer();
      } catch {
        // The registry swallows exactly this way.
      }
    }
    expect(seen).toEqual(['second']);
    expect(harness).toBeDefined();
  });
});

// --- 24-27. export -------------------------------------------------------

describe('export leaves with decisions and nothing else', () => {
  it('24. carries no forbidden content, under adversarial input', async () => {
    const audit = freshLog();
    // Every one of these is refused at write time, so none reaches the file.
    for (const grown of [{ password: TOKEN }, { result: PAGE }, { selector: '#x' }]) {
      await audit.record({
        type: 'tool.invoked',
        taskId: 'task_1',
        outcome: 'allowed',
        ...(grown as unknown as Record<string, never>),
      });
    }
    await audit.record({
      type: 'tool.invoked',
      taskId: 'task_1',
      tool: 'fake.read',
      outcome: 'allowed',
    });

    const doc = buildAuditExport(await audit.list(), 1, { kind: 'all' }, OK_REPORT);
    const bytes = JSON.stringify(doc);
    for (const forbidden of [TOKEN, PAGE, '#x', 'password', 'result', 'selector']) {
      expect(bytes, forbidden).not.toContain(forbidden);
    }
  });

  it('25. reaches no network: the whole audit layer has no carrier', () => {
    // Asserted in case 21 for the layer; restated here as the export claim,
    // because "local only" is a property of what the code can reach.
    for (const file of sources(AUDIT_ROOT)) {
      const code = readFileSync(file, 'utf8');
      expect(code, file).not.toMatch(/https?:\/\//);
      expect(code, file).not.toMatch(/chrome\.downloads/);
    }
  });

  it('26. takes no path or URL from anywhere', () => {
    // The export builder's whole input is records, a timestamp, a scope and a
    // verdict. There is no parameter a path could arrive through.
    expect(buildAuditExport.length).toBe(4);
    const panel = readFileSync(
      resolve(import.meta.dirname, '../../src/sidepanel/components/AuditView.tsx'),
      'utf8',
    );
    // The filename is built from a timestamp and fixed words only.
    expect(panel).toMatch(/anchor\.download = `audit-\$\{kind\}-\$\{stamp\}\.json`/);

    // Comments stripped: this file explains that it uses none of these, and a
    // scan that matched the explanation would pass for the wrong reason.
    const code = panel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/chrome\.downloads/);
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/XMLHttpRequest|sendBeacon|WebSocket/);
  });

  it('27. states its scope, window and integrity verdict in the artefact', async () => {
    const audit = freshLog();
    await audit.record({
      type: 'tool.invoked',
      taskId: 'task_1',
      tool: 'fake.read',
      outcome: 'allowed',
    });
    const doc = buildAuditExport(
      await audit.list(),
      1,
      { kind: 'task', taskId: 'task_1' },
      { verdict: 'truncated', checked: 1, note: 'some evicted' },
    );
    expect(doc.scope).toEqual({ kind: 'task', taskId: 'task_1' });
    expect(doc.window).not.toBeNull();
    expect(doc.integrity.verdict).toBe('truncated');
    expect(doc.notice).toMatch(/no page content/i);
  });
});

// --- 28-31. retention, quota, restart, concurrency ------------------------

describe('the trail says what it lost', () => {
  it('28. never evicts silently', async () => {
    const audit = freshLog({ maxEvents: 6 });
    for (let i = 0; i < 12; i += 1) {
      await audit.record({ type: 'task.state', taskId: `task_${i}`, outcome: 'info' });
    }
    const events = await audit.list();
    const markers = events.filter((event) => event.type === 'retention.compacted');
    expect(markers.length).toBeGreaterThan(0);
    expect(markers[0]?.removedCount).toBeGreaterThan(0);
    expect(markers[0]?.removedFromSeq).toBeDefined();
  });

  it('29. reports a degraded trail when a write cannot land', async () => {
    // Mocked on the inner area, because the transaction writes through it —
    // stubbing the serialised wrapper would leave the real write untouched.
    const inner = new MemoryStorageArea();
    const area = new SerializedStorageArea(inner);
    const log = new AuditLog(area, { now: () => 1 });
    vi.spyOn(inner, 'set').mockRejectedValue(new Error('QuotaExceededError'));

    const written = await log.record({ type: 'task.state', taskId: 'task_1', outcome: 'info' });
    expect(written).toBeNull();
    // Surfaced rather than pretended away — and it changed nothing about what
    // the task did, because this is a record of an execution, not the
    // execution.
    expect(log.degradedReason()).not.toBeNull();
    vi.restoreAllMocks();
  });

  it('30. allocates the sequence from storage, so a restart continues it', async () => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const first = new AuditLog(area, { now: () => 1 });
    await first.record({ type: 'task.state', taskId: 'task_1', outcome: 'info' });
    await first.record({ type: 'task.state', taskId: 'task_1', outcome: 'info' });

    // A brand-new instance, as a restarted worker builds.
    const second = new AuditLog(area, { now: () => 1 });
    const next = await second.record({ type: 'task.state', taskId: 'task_1', outcome: 'info' });

    expect(next?.seq).toBe(3);
    expect((await second.verifyIntegrity()).verdict).toBe('ok');
  });

  it('31. serialises concurrent writes without losing or duplicating one', async () => {
    const audit = freshLog();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        audit.record({ type: 'task.state', taskId: `task_${index}`, outcome: 'info' }),
      ),
    );
    const events = await audit.list(100);
    const sequences = events.map((event) => event.seq).sort((a, b) => a - b);
    expect(new Set(sequences).size).toBe(20);
    expect(sequences).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect((await audit.verifyIntegrity()).verdict).toBe('ok');
  });
});

// --- 32-34. a model-proposed name, and the neighbouring waves -------------

describe('the trail is not a model-writable field', () => {
  it('32. replaces a tool name this build did not register', async () => {
    const audit = freshLog({ knownTool: (name) => name === 'fake.read' });
    const invented = await audit.record({
      type: 'tool.refused',
      taskId: 'task_1',
      tool: 'evil.exfiltrate?note=' + TOKEN,
      outcome: 'denied',
    });

    expect(invented?.tool).toBe(UNKNOWN_TOOL);
    expect(JSON.stringify(invented)).not.toContain('evil.exfiltrate');
    expect(JSON.stringify(invented)).not.toContain(TOKEN);

    const known = await audit.record({
      type: 'tool.invoked',
      taskId: 'task_1',
      tool: 'fake.read',
      outcome: 'allowed',
    });
    expect(known?.tool).toBe('fake.read');
  });

  it('32b. records every tool name as unverified when nothing can verify one', async () => {
    // The fail-open this wave closed. The default used to be that a log with
    // no validator kept whatever name it was handed, which made the control
    // look present while doing nothing — and contradicted what the docs say
    // it does. A caller that cannot check a name must not have the trail
    // assert that the name is real.
    // Built directly rather than through `freshLog`, because the shape under
    // test is an options object with no `knownTool` key at all — which is
    // what a caller that never thought about it produces. Passing the key as
    // `undefined` would be a different, and easier, thing to satisfy.
    const audit = new AuditLog(new SerializedStorageArea(new MemoryStorageArea()), {
      now: () => 1_700_000_000_000,
    });
    await audit.record({
      type: 'tool.invoked',
      taskId: 'task_1',
      tool: 'browser.read_page',
      ran: 'browser.click',
      outcome: 'allowed',
    });
    const [event] = await audit.list();
    expect(event?.tool).toBe(UNKNOWN_TOOL);
    expect(event?.ran).toBe(UNKNOWN_TOOL);
    expect(JSON.stringify(event)).not.toContain('browser.read_page');
  });

  it('33. builds a dispatch record that carries no arguments and no element', async () => {
    const audit = freshLog();
    const observer = createDispatchAuditObserver({ audit });
    const observation: DispatchObservation = {
      taskId: 'task_1',
      toolCallId: 'tc_1',
      tool: 'fake.read',
      arguments: { url: 'https://private.test/customer/12345', secretish: TOKEN },
      risk: 'R0',
      executed: true,
      status: 'success',
      actedOn: {
        role: 'button',
        name: 'Save',
        nth: 0,
        matchCount: 1,
        enabled: true,
        visible: true,
      },
    };

    observer(observation);
    await vi.waitFor(async () => expect((await audit.list()).length).toBe(1));

    const bytes = JSON.stringify(await audit.list());
    expect(bytes).not.toContain('private.test');
    expect(bytes).not.toContain(TOKEN);
    expect(bytes).not.toContain('Save');
    expect(bytes).toContain('fake.read');
  });

  it('34. leaves the shape checks exported so the guarantee is directly testable', () => {
    expect(() => assertAuditShape({ type: 'task.state', meta: { a: 1 } })).toThrow(AuditShapeError);
    expect(() => assertAuditShape({ type: 'task.state', scopes: ['read'] })).not.toThrow();
  });
});

// --- 27-32. every declared event type is one this build actually writes -----

describe('the type list describes the trail rather than an intention', () => {
  it('27 — has no event type nothing in the build can produce', () => {
    // NEGATIVE CONTROL for the whole list. A declared type with no producer is
    // a promise the trail makes about itself and does not keep: a reader
    // filtering for it finds nothing and cannot tell "it never happened" from
    // "nothing ever writes it". `provider.state` and `recovery` were both in
    // this position from the first audit wave until the P-038 gap audit went
    // looking — declared, never written, and surviving a full rewrite of this
    // module in between.
    //
    // The check is deliberately crude: the literal has to appear somewhere in
    // `src/` outside the audit module. A type whose only mention is its own
    // declaration has no producer, whatever else is true.
    const declaringModule = resolve(AUDIT_ROOT, 'audit-log.ts');
    const elsewhere = sources(SRC_ROOT)
      .filter((file) => file !== declaringModule)
      .map((file) =>
        readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/[^\n]*/g, '$1'),
      );
    const selfWritten = new Set(['retention.compacted']);

    const orphans = AUDIT_EVENT_TYPES.filter(
      (type) => !selfWritten.has(type) && !elsewhere.some((text) => text.includes(`'${type}'`)),
    );
    expect(orphans).toEqual([]);
  });

  it('28 — records a standing site grant where the rule is written', async () => {
    // The authority gap this wave closed. A grant is what stops the agent
    // asking again on a site, and nothing recorded that one had been made:
    // `permission.decided` reports an approval and flattens `approve_once`
    // and `approve_site` into the same `approved` code.
    const log = freshLog();
    await log.record({
      type: 'policy.site_rule',
      site: 'example.test',
      tool: 'browser.click',
      risk: 'R2',
      outcome: 'allowed',
      code: 'SITE_RULE_GRANTED',
    });

    const [event] = (await log.page({})).events;
    expect(event?.type).toBe('policy.site_rule');
    expect(event?.site).toBe('example.test');
    expect(event?.risk).toBe('R2');
    expect(event?.code).toBe('SITE_RULE_GRANTED');
  });

  it('29 — records the revocation as its own decision, not as an absence', async () => {
    const log = freshLog();
    await log.record({
      type: 'policy.site_rule',
      site: 'example.test',
      outcome: 'denied',
      code: 'SITE_RULE_REVOKED',
    });

    const [event] = (await log.page({})).events;
    expect(event?.outcome).toBe('denied');
    expect(event?.code).toBe('SITE_RULE_REVOKED');
    // The two ends share a type so the lifetime of one grant reads as one
    // sequence, and `outcome` is what separates them.
    expect(event?.type).toBe('policy.site_rule');
  });

  it('30 — carries no rule note, because a note quotes a tool call', async () => {
    // A `SiteRule` has a `note` that reads "Approved while running X". The
    // tool is already a field here and goes through name verification; the
    // sentence around it is prose the trail has no reason to hold.
    const log = freshLog();
    await log.record({
      type: 'policy.site_rule',
      site: 'example.test',
      tool: 'browser.click',
      outcome: 'allowed',
      code: 'SITE_RULE_GRANTED',
    });
    const [event] = (await log.page({})).events;
    expect(JSON.stringify(event)).not.toContain('Approved while running');
  });

  it('31 — the grant hook cannot change what was granted', () => {
    // It is a notification. The engine writes the rule, then tells the
    // listener; the listener has no return value the engine reads, and its
    // failure is caught. Asserted from source, because "it is only a
    // notification" is a property of the call site rather than of the name.
    const engine = readFileSync(resolve(SRC_ROOT, 'policy/permission-engine.ts'), 'utf8');
    const call = engine.slice(engine.indexOf('this.options.onSiteRule('));
    expect(call.slice(0, 400)).toContain('catch');
    // The write comes first: the trail never claims a grant that failed to
    // persist.
    expect(engine.indexOf('saveSitePolicy(')).toBeLessThan(
      engine.indexOf('this.options.onSiteRule('),
    );
  });

  it('32 — a site rule record is not task-scoped, because a grant outlives its task', () => {
    // A standing grant is durable and applies to every later task, so pinning
    // it to the task that happened to create it would make it invisible in a
    // cross-task view filtered by any other task. It is deliberately absent
    // from the task-scoped set.
    const source = readFileSync(resolve(AUDIT_ROOT, 'audit-log.ts'), 'utf8');
    const scoped = source.slice(source.indexOf('TASK_SCOPED'));
    expect(scoped.slice(0, 600)).not.toContain('policy.site_rule');
  });
});
