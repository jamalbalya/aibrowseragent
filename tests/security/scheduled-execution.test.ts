/**
 * TEST-SCHEDULE-001 — the unattended execution boundary (P-020).
 *
 * Scheduling is the feature that removes the person. Every other control in
 * this extension assumes somebody can be asked; a scheduled run is defined by
 * nobody being there. So the claims below are all about what happens at the
 * point where the answer would have come from a human:
 *
 *  1. **A schedule is a clock, not an instruction.** It holds a reference, a
 *     cadence and bookkeeping — no inputs, no content, no credential.
 *  2. **A schedule grants nothing.** The same policy engine, the same
 *     permission engine, the same risk model, the same modes. No stored
 *     approval exists, and no field could become one.
 *  3. **Confirmation is a hard boundary.** A run that reaches an action
 *     needing approval stops, in a recorded terminal state, and is never
 *     retried into approval.
 *  4. **An occurrence runs at most once, ever.** Duplicate alarms, restarts
 *     and concurrent wake-ups all converge on one run.
 *  5. **A missed occurrence is recorded, not replayed.**
 *
 * The product decision behind (3) is AI Browser Agent's own. It is not a
 * claim about how any other browser agent behaves at that point; see
 * `docs/architecture/SCHEDULED_EXECUTION.md`.
 *
 * The scripted prompter in this harness is told to **approve** everything.
 * Every denial below therefore comes from production code or not at all.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildScheduleHarness, HARNESS_START } from '../fixtures/schedule-harness';
import { skillFixture } from '../fixtures/skill-harness';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { ScheduleStore, ScheduleError } from '@/schedules/schedule-store';
import {
  assertScheduleSafe,
  describeCadence,
  isUnattendedSessionId,
  isUsableSchedule,
  nextOccurrence,
  ProhibitedScheduleFieldError,
  runIdFor,
  SCHEDULE_FORMAT_VERSION,
  unattendedSessionIdFor,
  type ScheduleCadence,
} from '@/schedules/schedule-model';
import { occurrencesDue, nextWakeUp, RUN_GRACE_MS } from '@/schedules/schedule-clock';
import { UnattendedPrompter } from '@/background/unattended-prompter';
import { evaluatePolicy, type PolicyContext } from '@/policy/policy-engine';
import { emptySitePolicyState } from '@/policy/site-policy';
import { AUDIT_EVENT_TYPES } from '@/audit/audit-log';
import { PANEL_ROUTE_CLASSES } from '@/messaging/route-trust';

const SCHEDULES_ROOT = resolve(import.meta.dirname, '../../src/schedules');
const RUNNER_SRC = resolve(import.meta.dirname, '../../src/background/schedule-runner.ts');
const PROMPTER_SRC = resolve(import.meta.dirname, '../../src/background/unattended-prompter.ts');

const TOOLS = [
  { name: 'fake.read', risk: 'R0' as const, returns: { title: 'A page' } },
  { name: 'fake.click', risk: 'R1' as const, returns: { clicked: true } },
  { name: 'fake.upload', risk: 'R2' as const, returns: { staged: true } },
  { name: 'fake.write', risk: 'R3' as const, returns: { written: true } },
  { name: 'fake.destroy', risk: 'R4' as const, returns: { gone: true } },
  { name: 'fake.forbidden', risk: 'R5' as const, returns: { never: true } },
];

const DAILY: ScheduleCadence = { kind: 'daily', hour: 9, minute: 30 };

type Harness = ReturnType<typeof buildScheduleHarness>;

/** Registers a one-tool skill and returns its target. */
async function skillTarget(
  harness: Harness,
  tool: string,
  risk: 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5',
  id = `test.${tool.replace('.', '-')}`,
): Promise<{ kind: 'skill'; skillId: string; skillVersion: string }> {
  await harness.register(
    skillFixture({
      id,
      risk,
      requiredTools: [tool],
      steps: [{ kind: 'tool', id: 'one', tool, description: `Run ${tool}.`, arguments: {} }],
    }),
  );
  return { kind: 'skill', skillId: id, skillVersion: '1.0.0' };
}

/** A schedule whose next occurrence is exactly `at`. */
async function scheduleDueAt(
  harness: Harness,
  target: Parameters<Harness['schedules']['create']>[0]['target'],
  at: number,
  name = 'Nightly',
): Promise<string> {
  const record = await harness.schedules.create({
    displayName: name,
    target,
    cadence: DAILY,
    enabled: true,
  });
  // The cadence keeps its own clock; the tests drive it by claiming from a
  // known point rather than by waiting a day.
  await harness.schedules.edit(record.scheduleId, { cadence: DAILY });
  const area = record;
  void area;
  await forceNextRun(harness, record.scheduleId, at);
  return record.scheduleId;
}

/**
 * Points a schedule's clock at an instant.
 *
 * Goes through the store's own edit path and then rewrites only `nextRunAt`,
 * because a test that waited for a real daily occurrence would take a day.
 * `lastClaimedOccurrenceAt` is left alone: the claim guard is the thing under
 * test and must never be reached around.
 */
async function forceNextRun(harness: Harness, scheduleId: string, at: number): Promise<void> {
  const raw = harness.rawSchedules;
  const key = `schedules:v${SCHEDULE_FORMAT_VERSION}:${scheduleId}`;
  const stored = await raw.get<{ v: number; record: Record<string, unknown> }>(key);
  if (!stored) throw new Error('no such schedule');
  await raw.set(key, { ...stored, record: { ...stored.record, nextRunAt: at } });
}

/**
 * Source with comments *and* string literals removed.
 *
 * Used by the "this module never mentions X" checks, because two of the
 * modules under test legitimately hold X as data: the prohibited-field list
 * in `schedule-model.ts` is a denylist of the very words those checks look
 * for, and a denylist that could not name them would not be one.
 */
function identifiersOnly(text: string): string {
  return codeOnly(text).replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, "''");
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/** Source with comments removed, so documentation cannot satisfy a code check. */
function codeOnly(text: string): string {
  let out = '';
  let inLine = false;
  let inBlock = false;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    out += ch;
  }
  return out;
}

// --- A. schedule CRUD -----------------------------------------------------

describe('a schedule is created, edited and deleted as data', () => {
  it('01 stores a name, a target, a cadence and a future occurrence', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const record = await harness.schedules.create({
      displayName: 'Morning check',
      target,
      cadence: DAILY,
      enabled: true,
    });

    expect(record.displayName).toBe('Morning check');
    expect(record.target).toEqual(target);
    expect(record.cadence).toEqual(DAILY);
    expect(record.enabled).toBe(true);
    expect(record.nextRunAt).toBeGreaterThan(harness.now());
    // The claim floor starts at creation, so no past instant is claimable.
    expect(record.lastClaimedOccurrenceAt).toBe(harness.now());
  });

  it('02 refuses a second schedule with the same name', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    await harness.schedules.create({ displayName: 'Daily', target, cadence: DAILY, enabled: true });
    await expect(
      harness.schedules.create({ displayName: 'daily', target, cadence: DAILY, enabled: true }),
    ).rejects.toThrow(ScheduleError);
  });

  it('03 refuses a cadence it cannot compute occurrences for', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    await expect(
      harness.schedules.create({
        displayName: 'Broken',
        target,
        cadence: { kind: 'daily', hour: 25, minute: 0 },
        enabled: true,
      }),
    ).rejects.toMatchObject({ reason: 'INVALID_CADENCE' });
  });

  it('04 recomputes the next occurrence when the cadence changes', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const created = await harness.schedules.create({
      displayName: 'Daily',
      target,
      cadence: DAILY,
      enabled: true,
    });
    const edited = await harness.schedules.edit(created.scheduleId, {
      cadence: { kind: 'weekly', weekday: 3, hour: 7, minute: 0 },
    });
    expect(new Date(edited.nextRunAt).getDay()).toBe(3);
    expect(new Date(edited.nextRunAt).getHours()).toBe(7);
  });

  it('05 never moves the claim floor backwards on an edit', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const created = await harness.schedules.create({
      displayName: 'Daily',
      target,
      cadence: DAILY,
      enabled: true,
    });
    const claimed = created.nextRunAt;
    await harness.schedules.claimOccurrence(created.scheduleId, claimed);

    const edited = await harness.schedules.edit(created.scheduleId, {
      cadence: { kind: 'daily', hour: 1, minute: 0 },
    });
    expect(edited.lastClaimedOccurrenceAt).toBe(claimed);
    expect(edited.nextRunAt).toBeGreaterThan(claimed);
  });

  it('06 deletes a schedule and its run history together', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const created = await harness.schedules.create({
      displayName: 'Daily',
      target,
      cadence: DAILY,
      enabled: true,
    });
    await harness.schedules.startRun({
      runId: runIdFor(created.scheduleId, 1),
      scheduleId: created.scheduleId,
      occurrenceAt: 1,
      status: 'missed',
    });
    await harness.schedules.remove(created.scheduleId);

    expect(await harness.schedules.get(created.scheduleId)).toBeUndefined();
    expect(await harness.schedules.listRuns()).toHaveLength(0);
  });
});

// --- B-E. the four cadences ----------------------------------------------

describe('cadences come round when they say they will', () => {
  it('07 daily lands on the next matching wall-clock time', () => {
    const from = new Date(2026, 0, 5, 8, 0).getTime();
    const next = nextOccurrence({ kind: 'daily', hour: 9, minute: 30 }, from);
    expect(new Date(next as number).getDate()).toBe(5);
    expect(new Date(next as number).getHours()).toBe(9);
    expect(new Date(next as number).getMinutes()).toBe(30);
  });

  it('08 daily rolls to tomorrow once today has passed', () => {
    const from = new Date(2026, 0, 5, 10, 0).getTime();
    const next = nextOccurrence({ kind: 'daily', hour: 9, minute: 30 }, from);
    expect(new Date(next as number).getDate()).toBe(6);
  });

  it('09 weekly lands on the chosen weekday', () => {
    const from = new Date(2026, 0, 5, 10, 0).getTime();
    const next = nextOccurrence({ kind: 'weekly', weekday: 5, hour: 9, minute: 0 }, from);
    expect(new Date(next as number).getDay()).toBe(5);
    expect(next).toBeGreaterThan(from);
  });

  it('10 monthly lands on the chosen day', () => {
    const from = new Date(2026, 0, 5, 10, 0).getTime();
    const next = nextOccurrence({ kind: 'monthly', day: 20, hour: 9, minute: 0 }, from);
    expect(new Date(next as number).getDate()).toBe(20);
    expect(new Date(next as number).getMonth()).toBe(0);
  });

  it('11 monthly skips a month without that day rather than clamping it', () => {
    // From late January, "the 31st" is February's non-existent day: the next
    // occurrence is March, never 28 February.
    const from = new Date(2026, 0, 31, 12, 0).getTime();
    const next = nextOccurrence({ kind: 'monthly', day: 31, hour: 9, minute: 0 }, from);
    expect(new Date(next as number).getMonth()).toBe(2);
    expect(new Date(next as number).getDate()).toBe(31);
  });

  it('12 annual lands on the chosen month and day', () => {
    const from = new Date(2026, 0, 5, 10, 0).getTime();
    const next = nextOccurrence({ kind: 'annual', month: 6, day: 1, hour: 9, minute: 0 }, from);
    expect(new Date(next as number).getMonth()).toBe(5);
    expect(new Date(next as number).getDate()).toBe(1);
    expect(new Date(next as number).getFullYear()).toBe(2026);
  });

  it('13 annual on 29 February happens in leap years only', () => {
    const from = new Date(2026, 0, 5, 10, 0).getTime();
    const next = nextOccurrence({ kind: 'annual', month: 2, day: 29, hour: 9, minute: 0 }, from);
    expect(new Date(next as number).getFullYear()).toBe(2028);
    expect(new Date(next as number).getMonth()).toBe(1);
    expect(new Date(next as number).getDate()).toBe(29);
  });
});

// --- F. pause and resume --------------------------------------------------

describe('a paused schedule is a schedule that does nothing', () => {
  it('14 produces no due run and no missed records while paused', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const created = await harness.schedules.create({
      displayName: 'Daily',
      target,
      cadence: DAILY,
      enabled: true,
    });
    await harness.schedules.setEnabled(created.scheduleId, false);

    const paused = (await harness.schedules.get(created.scheduleId)) as NonNullable<
      Awaited<ReturnType<Harness['schedules']['get']>>
    >;
    const verdict = occurrencesDue(paused, paused.nextRunAt + 5 * 24 * 60 * 60 * 1000);
    expect(verdict.due).toBeUndefined();
    expect(verdict.missed).toHaveLength(0);
  });

  it('15 refuses to claim an occurrence while paused', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const created = await harness.schedules.create({
      displayName: 'Daily',
      target,
      cadence: DAILY,
      enabled: true,
    });
    await harness.schedules.setEnabled(created.scheduleId, false);
    const claim = await harness.schedules.claimOccurrence(created.scheduleId, created.nextRunAt);
    expect(claim).toEqual({ ok: false, reason: 'PAUSED' });
  });

  it('16 resuming re-anchors the clock to now rather than owing a backlog', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const created = await harness.schedules.create({
      displayName: 'Daily',
      target,
      cadence: DAILY,
      enabled: true,
    });
    await harness.schedules.setEnabled(created.scheduleId, false);

    harness.setNow(HARNESS_START + 30 * 24 * 60 * 60 * 1000);
    const resumed = await harness.schedules.setEnabled(created.scheduleId, true);
    expect(resumed.nextRunAt).toBeGreaterThan(harness.now());
    expect(resumed.nextRunAt).toBeLessThan(harness.now() + 25 * 60 * 60 * 1000);
  });
});

// --- G-I. firing, run now, and what a schedule points at ------------------

describe('a schedule fires what it points at, through the route that owns it', () => {
  it('17 runs a read-only skill unattended and completes', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const id = await scheduleDueAt(harness, target, harness.now() + 60_000);

    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    const runs = await harness.schedules.listRuns(id);
    expect(runs[0]?.status).toBe('completed');
    expect(harness.seen.map((call) => call.tool)).toContain('fake.read');
  });

  it('18 runs it under an unattended session, readable from the task record', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const id = await scheduleDueAt(harness, target, harness.now() + 60_000);

    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    const run = (await harness.schedules.listRuns(id))[0];
    const task = await harness.tasks.getTask(run?.taskId as string);
    expect(isUnattendedSessionId(task?.sessionId as string)).toBe(true);
    expect(task?.sessionId).toBe(unattendedSessionIdFor(run?.runId as string));
  });

  it('19 Run now executes attended, and leaves the clock exactly where it was', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const created = await harness.schedules.create({
      displayName: 'Daily',
      target,
      cadence: DAILY,
      enabled: true,
    });

    const run = await harness.scheduler.runNow(created.scheduleId);
    const after = await harness.schedules.get(created.scheduleId);

    expect(run?.status).toBe('completed');
    expect(after?.nextRunAt).toBe(created.nextRunAt);
    expect(after?.lastClaimedOccurrenceAt).toBe(created.lastClaimedOccurrenceAt);

    const task = await harness.tasks.getTask(run?.taskId as string);
    expect(isUnattendedSessionId(task?.sessionId as string)).toBe(false);
  });

  it('20 fires through a shortcut, resolved at the moment it fires', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const shortcut = await harness.shortcuts.create('morning', target);
    const id = await scheduleDueAt(
      harness,
      { kind: 'shortcut', shortcutId: shortcut.shortcutId },
      harness.now() + 60_000,
    );

    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    expect((await harness.schedules.listRuns(id))[0]?.status).toBe('completed');
    expect(harness.seen.map((call) => call.tool)).toContain('fake.read');
  });

  it('21 follows a shortcut that was retargeted after the schedule was made', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const readTarget = await skillTarget(harness, 'fake.read', 'R0');
    const clickTarget = await skillTarget(harness, 'fake.click', 'R1');
    const shortcut = await harness.shortcuts.create('morning', readTarget);
    const id = await scheduleDueAt(
      harness,
      { kind: 'shortcut', shortcutId: shortcut.shortcutId },
      harness.now() + 60_000,
    );
    await harness.shortcuts.retarget(shortcut.shortcutId, clickTarget);

    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    expect((await harness.schedules.listRuns(id))[0]?.status).toBe('completed');
    expect(harness.seen.map((call) => call.tool)).toEqual(['fake.click']);
  });

  it('22 stops, rather than running, when what it points at is gone', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const shortcut = await harness.shortcuts.create('morning', target);
    const id = await scheduleDueAt(
      harness,
      { kind: 'shortcut', shortcutId: shortcut.shortcutId },
      harness.now() + 60_000,
    );
    await harness.shortcuts.remove(shortcut.shortcutId);

    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    const run = (await harness.schedules.listRuns(id))[0];
    expect(run?.status).toBe('blocked');
    expect(run?.reason).toBe('TARGET_MISSING');
    expect(harness.seen).toHaveLength(0);
  });

  it('23 refuses to run something that asks for values it cannot be given', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    await harness.register(
      skillFixture({
        id: 'test.asks',
        risk: 'R0',
        requiredTools: ['fake.read'],
        inputs: [{ name: 'url', type: 'string', required: true, description: 'Where to look.' }],
        steps: [
          { kind: 'tool', id: 'one', tool: 'fake.read', description: 'Read.', arguments: {} },
        ],
      }),
    );
    const id = await scheduleDueAt(
      harness,
      { kind: 'skill', skillId: 'test.asks', skillVersion: '1.0.0' },
      harness.now() + 60_000,
    );

    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    const run = (await harness.schedules.listRuns(id))[0];
    expect(run?.status).toBe('blocked');
    expect(run?.reason).toBe('INPUTS_REQUIRED');
    expect(harness.seen).toHaveLength(0);
  });
});

// --- J-P. the risk boundary ----------------------------------------------

describe('the confirmation boundary is where an unattended run stops', () => {
  it('24 R0 runs unattended', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS, permissionMode: 'auto' });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const id = await scheduleDueAt(harness, target, harness.now() + 60_000);
    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    expect((await harness.schedules.listRuns(id))[0]?.status).toBe('completed');
    expect(harness.seen.map((call) => call.tool)).toEqual(['fake.read']);
  });

  it('25 R1 runs unattended in a mode that permits it', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS, permissionMode: 'auto' });
    const target = await skillTarget(harness, 'fake.click', 'R1');
    const id = await scheduleDueAt(harness, target, harness.now() + 60_000);
    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    expect((await harness.schedules.listRuns(id))[0]?.status).toBe('completed');
    expect(harness.seen.map((call) => call.tool)).toEqual(['fake.click']);
  });

  it('26 R1 stops in manual mode, because the mode requires a person', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS, permissionMode: 'manual' });
    const target = await skillTarget(harness, 'fake.click', 'R1');
    const id = await scheduleDueAt(harness, target, harness.now() + 60_000);
    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    const run = (await harness.schedules.listRuns(id))[0];
    expect(run?.status).toBe('blocked');
    expect(run?.reason).toBe('CONFIRMATION_REQUIRED');
    expect(harness.seen).toHaveLength(0);
  });

  it('27 R2 stops, and the tool is never reached', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS, permissionMode: 'auto' });
    const target = await skillTarget(harness, 'fake.upload', 'R2');
    const id = await scheduleDueAt(harness, target, harness.now() + 60_000);
    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    const run = (await harness.schedules.listRuns(id))[0];
    expect(run?.status).toBe('blocked');
    expect(run?.reason).toBe('CONFIRMATION_REQUIRED');
    expect(harness.seen).toHaveLength(0);
  });

  it('28 R2 stops even in skip mode, which would otherwise authorise it silently', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS, permissionMode: 'skip' });
    const target = await skillTarget(harness, 'fake.upload', 'R2');
    const id = await scheduleDueAt(harness, target, harness.now() + 60_000);
    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    const run = (await harness.schedules.listRuns(id))[0];
    expect(run?.status).toBe('blocked');
    expect(run?.reason).toBe('CONFIRMATION_REQUIRED');
    expect(harness.seen).toHaveLength(0);
  });

  it('28b control: the same R2 skill in skip mode runs when a person is there', async () => {
    // The discriminating half of 28. Nothing changes but who is watching, and
    // the run completes — so 28 is measuring the boundary, not a broken tool.
    const harness = buildScheduleHarness({ tools: TOOLS, permissionMode: 'skip' });
    const target = await skillTarget(harness, 'fake.upload', 'R2');
    const created = await harness.schedules.create({
      displayName: 'Attended',
      target,
      cadence: DAILY,
      enabled: true,
    });

    const run = await harness.scheduler.runNow(created.scheduleId);
    expect(run?.status).toBe('completed');
    expect(harness.seen.map((call) => call.tool)).toEqual(['fake.upload']);
  });

  it('29 R3 stops in every mode, including skip', async () => {
    for (const mode of ['manual', 'auto', 'skip'] as const) {
      const harness = buildScheduleHarness({ tools: TOOLS, permissionMode: mode });
      const target = await skillTarget(harness, 'fake.write', 'R3');
      const id = await scheduleDueAt(harness, target, harness.now() + 60_000);
      harness.setNow(harness.now() + 61_000);
      await harness.scheduler.tick();

      const run = (await harness.schedules.listRuns(id))[0];
      expect(run?.status, mode).toBe('blocked');
      expect(run?.reason, mode).toBe('CONFIRMATION_REQUIRED');
      expect(harness.seen, mode).toHaveLength(0);
    }
  });

  it('30 R4 stops', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS, permissionMode: 'skip' });
    const target = await skillTarget(harness, 'fake.destroy', 'R4');
    const id = await scheduleDueAt(harness, target, harness.now() + 60_000);
    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    expect((await harness.schedules.listRuns(id))[0]?.status).toBe('blocked');
    expect(harness.seen).toHaveLength(0);
  });

  it('31 R5 is denied outright, and is not recorded as waiting for approval', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS, permissionMode: 'skip' });
    const target = await skillTarget(harness, 'fake.forbidden', 'R5');
    const id = await scheduleDueAt(harness, target, harness.now() + 60_000);
    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    const run = (await harness.schedules.listRuns(id))[0];
    expect(run?.status).toBe('blocked');
    // The distinction matters: a person could not have approved this one, so
    // telling them to run it themselves would be a lie.
    expect(run?.reason).toBe('POLICY_DENIED');
    expect(harness.seen).toHaveLength(0);
  });
});

// --- the unattended clause can only ever subtract -------------------------

describe('being unattended makes policy stricter and never looser', () => {
  const context = (unattended: boolean): PolicyContext => ({
    mode: 'skip',
    sitePolicy: emptySitePolicyState(),
    unattended,
  });

  it('32 leaves a hard prohibition a denial, not a confirmation', () => {
    const decision = evaluatePolicy(
      {
        tool: 'fake.pay',
        taskId: 'task_1',
        risk: 'R1',
        prohibited: ['financial_transaction'],
      },
      context(true),
    );
    expect(decision.verdict).toBe('DENY');
    expect(decision.code).toBe('PROHIBITED_ACTION');
  });

  it('33 leaves R5 a denial', () => {
    const decision = evaluatePolicy({ tool: 'fake.x', taskId: 't', risk: 'R5' }, context(true));
    expect(decision.verdict).toBe('DENY');
  });

  it('34 leaves R0 alone', () => {
    const decision = evaluatePolicy({ tool: 'fake.x', taskId: 't', risk: 'R0' }, context(true));
    expect(decision.verdict).toBe('ALLOW');
  });

  it('35 turns an R2 skip-mode allow into a confirmation', () => {
    const attended = evaluatePolicy({ tool: 'fake.x', taskId: 't', risk: 'R2' }, context(false));
    const unattended = evaluatePolicy({ tool: 'fake.x', taskId: 't', risk: 'R2' }, context(true));
    expect(attended.verdict).toBe('ALLOW');
    expect(unattended.verdict).toBe('ALLOW_WITH_CONFIRMATION');
    expect(unattended.code).toBe('UNATTENDED_REQUIRES_APPROVAL');
  });

  it('36 never turns a blocked origin into a question', () => {
    const decision = evaluatePolicy(
      { tool: 'fake.x', taskId: 't', risk: 'R1', targetUrl: 'chrome://settings' },
      context(true),
    );
    expect(decision.verdict).toBe('DENY');
    expect(decision.code).toBe('ORIGIN_NOT_AUTOMATABLE');
  });
});

// --- Q. the prompter itself ----------------------------------------------

describe('the unattended prompter denies without asking', () => {
  const request = {
    id: 'perm_1',
    taskId: 'task_1',
    tool: 'fake.upload',
    risk: 'R2' as const,
    reason: 'because',
    site: null,
    summary: 'Upload something.',
    createdAt: 0,
    elevated: false,
  };

  it('37 denies an unattended session and never reaches the interactive prompter', async () => {
    const asked: string[] = [];
    const prompter = new UnattendedPrompter({
      interactive: {
        prompt: (r) => {
          asked.push(r.tool);
          return Promise.resolve({ kind: 'approve_once' as const });
        },
      },
      sessionOf: () => Promise.resolve(unattendedSessionIdFor('srun_x_1')),
    });
    expect(await prompter.prompt(request)).toEqual({ kind: 'deny' });
    expect(asked).toEqual([]);
  });

  it('38 passes an ordinary session straight through', async () => {
    const asked: string[] = [];
    const prompter = new UnattendedPrompter({
      interactive: {
        prompt: (r) => {
          asked.push(r.tool);
          return Promise.resolve({ kind: 'approve_once' as const });
        },
      },
      sessionOf: () => Promise.resolve('session_abc'),
    });
    expect(await prompter.prompt(request)).toEqual({ kind: 'approve_once' });
    expect(asked).toEqual(['fake.upload']);
  });

  it('39 denies when the task cannot be found', async () => {
    const prompter = new UnattendedPrompter({
      interactive: { prompt: () => Promise.resolve({ kind: 'approve_once' as const }) },
      sessionOf: () => Promise.resolve(undefined),
    });
    expect(await prompter.prompt(request)).toEqual({ kind: 'deny' });
  });

  it('40 denies when reading the task throws', async () => {
    const prompter = new UnattendedPrompter({
      interactive: { prompt: () => Promise.resolve({ kind: 'approve_once' as const }) },
      sessionOf: () => Promise.reject(new Error('storage is gone')),
    });
    expect(await prompter.prompt(request)).toEqual({ kind: 'deny' });
  });

  it('41 survives an observer that throws, and still denies', async () => {
    const prompter = new UnattendedPrompter({
      interactive: { prompt: () => Promise.resolve({ kind: 'approve_once' as const }) },
      sessionOf: () => Promise.resolve(unattendedSessionIdFor('srun_x_1')),
      onUnattendedRefusal: () => {
        throw new Error('observer exploded');
      },
    });
    expect(await prompter.prompt(request)).toEqual({ kind: 'deny' });
  });
});

// --- R. exfiltration ------------------------------------------------------

describe('a scheduled run cannot move private data outward', () => {
  it('42 stops when a step would carry page-derived data off the page', async () => {
    const harness = buildScheduleHarness({
      permissionMode: 'skip',
      tools: [
        {
          name: 'fake.readPrivate',
          risk: 'R0' as const,
          returns: { body: 'private' },
          taint: [
            { sourceType: 'page_content', site: 'private.test', sensitivity: 'confidential' },
          ],
        },
        {
          name: 'fake.send',
          risk: 'R1' as const,
          egressTo: 'https://exfil.test/collect',
          returns: { sent: true },
        },
      ],
    });
    await harness.register(
      skillFixture({
        id: 'test.leak',
        risk: 'R1',
        requiredTools: ['fake.readPrivate', 'fake.send'],
        steps: [
          {
            kind: 'tool',
            id: 'one',
            tool: 'fake.readPrivate',
            description: 'Read a private page.',
            arguments: {},
          },
          {
            kind: 'tool',
            id: 'two',
            tool: 'fake.send',
            description: 'Send it somewhere else.',
            arguments: {},
          },
        ],
      }),
    );
    const id = await scheduleDueAt(
      harness,
      { kind: 'skill', skillId: 'test.leak', skillVersion: '1.0.0' },
      harness.now() + 60_000,
    );
    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    const run = (await harness.schedules.listRuns(id))[0];
    expect(run?.status).toBe('blocked');
    // The read happened; the send did not.
    expect(harness.seen.map((call) => call.tool)).toEqual(['fake.readPrivate']);
  });

  it('42b control: the same two steps run when nothing private was read', async () => {
    const harness = buildScheduleHarness({
      permissionMode: 'skip',
      tools: [
        { name: 'fake.readPrivate', risk: 'R0' as const, returns: { body: 'public' } },
        {
          name: 'fake.send',
          risk: 'R1' as const,
          egressTo: 'https://exfil.test/collect',
          returns: { sent: true },
        },
      ],
    });
    await harness.register(
      skillFixture({
        id: 'test.leak',
        risk: 'R1',
        requiredTools: ['fake.readPrivate', 'fake.send'],
        steps: [
          {
            kind: 'tool',
            id: 'one',
            tool: 'fake.readPrivate',
            description: 'Read a page.',
            arguments: {},
          },
          {
            kind: 'tool',
            id: 'two',
            tool: 'fake.send',
            description: 'Send something.',
            arguments: {},
          },
        ],
      }),
    );
    const id = await scheduleDueAt(
      harness,
      { kind: 'skill', skillId: 'test.leak', skillVersion: '1.0.0' },
      harness.now() + 60_000,
    );
    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    expect((await harness.schedules.listRuns(id))[0]?.status).toBe('completed');
    expect(harness.seen.map((call) => call.tool)).toEqual(['fake.readPrivate', 'fake.send']);
  });
});

// --- U-V. eviction, duplicates and idempotency ----------------------------

describe('an occurrence runs at most once, ever', () => {
  it('43 refuses a repeated claim for the same occurrence', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const created = await harness.schedules.create({
      displayName: 'Daily',
      target,
      cadence: DAILY,
      enabled: true,
    });

    const first = await harness.schedules.claimOccurrence(created.scheduleId, created.nextRunAt);
    const second = await harness.schedules.claimOccurrence(created.scheduleId, created.nextRunAt);
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: 'ALREADY_CLAIMED' });
  });

  it('44 refuses a claim for an earlier occurrence than the last one taken', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const created = await harness.schedules.create({
      displayName: 'Daily',
      target,
      cadence: DAILY,
      enabled: true,
    });
    await harness.schedules.claimOccurrence(created.scheduleId, created.nextRunAt);
    const earlier = await harness.schedules.claimOccurrence(
      created.scheduleId,
      created.nextRunAt - 1,
    );
    expect(earlier).toEqual({ ok: false, reason: 'ALREADY_CLAIMED' });
  });

  it('45 runs once across two alarm deliveries at the same instant', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const id = await scheduleDueAt(harness, target, harness.now() + 60_000);

    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();
    await harness.scheduler.tick();

    expect(harness.seen.filter((call) => call.tool === 'fake.read')).toHaveLength(1);
    expect(
      (await harness.schedules.listRuns(id)).filter((r) => r.status !== 'missed'),
    ).toHaveLength(1);
  });

  it('46 runs once when two wake-ups overlap', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const id = await scheduleDueAt(harness, target, harness.now() + 60_000);

    harness.setNow(harness.now() + 61_000);
    await Promise.all([harness.scheduler.tick(), harness.scheduler.tick()]);

    expect(harness.seen.filter((call) => call.tool === 'fake.read')).toHaveLength(1);
    expect(
      (await harness.schedules.listRuns(id)).filter((r) => r.status !== 'missed'),
    ).toHaveLength(1);
  });

  it('46b lets exactly one of two concurrent claims for one occurrence win', async () => {
    // Isolates the claim itself. Both callers read before either writes, so
    // only an atomic read-modify-write can refuse the second — the serialised
    // `tick` above cannot help here, and neither can `nextRunAt` having moved.
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const created = await harness.schedules.create({
      displayName: 'Daily',
      target,
      cadence: DAILY,
      enabled: true,
    });

    const claims = await Promise.all([
      harness.schedules.claimOccurrence(created.scheduleId, created.nextRunAt),
      harness.schedules.claimOccurrence(created.scheduleId, created.nextRunAt),
      harness.schedules.claimOccurrence(created.scheduleId, created.nextRunAt),
    ]);
    expect(claims.filter((claim) => claim.ok)).toHaveLength(1);
  });

  it('47 gives an occurrence the same run identity on every wake-up', () => {
    expect(runIdFor('schedule_a', 1750000000000)).toBe(runIdFor('schedule_a', 1750000000000));
    expect(runIdFor('schedule_a', 1750000000000)).not.toBe(runIdFor('schedule_b', 1750000000000));
  });

  it('48 closes a run left running by a dead worker, and never retries it', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const created = await harness.schedules.create({
      displayName: 'Daily',
      target,
      cadence: DAILY,
      enabled: true,
    });
    const occurrence = created.nextRunAt;
    await harness.schedules.claimOccurrence(created.scheduleId, occurrence);
    await harness.schedules.startRun({
      runId: runIdFor(created.scheduleId, occurrence),
      scheduleId: created.scheduleId,
      occurrenceAt: occurrence,
      status: 'running',
    });

    const closed = await harness.scheduler.recover();
    harness.setNow(occurrence + 1000);
    await harness.scheduler.tick();

    expect(closed).toBe(1);
    const run = await harness.schedules.getRun(runIdFor(created.scheduleId, occurrence));
    expect(run?.status).toBe('failed');
    expect(run?.reason).toBe('INTERRUPTED');
    expect(harness.seen).toHaveLength(0);
  });
});

// --- W. missed runs -------------------------------------------------------

describe('a missed occurrence is recorded and never replayed', () => {
  it('49 runs an occurrence that is late but inside the grace window', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const due = harness.now() + 60_000;
    const id = await scheduleDueAt(harness, target, due);

    harness.setNow(due + RUN_GRACE_MS - 1000);
    await harness.scheduler.tick();

    expect((await harness.schedules.listRuns(id))[0]?.status).toBe('completed');
  });

  it('50 records, rather than runs, an occurrence past the grace window', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const due = harness.now() + 60_000;
    const id = await scheduleDueAt(harness, target, due);

    harness.setNow(due + RUN_GRACE_MS + 1000);
    await harness.scheduler.tick();

    const runs = await harness.schedules.listRuns(id);
    expect(runs.some((run) => run.status === 'missed')).toBe(true);
    expect(runs.every((run) => run.status !== 'completed')).toBe(true);
    expect(harness.seen).toHaveLength(0);
  });

  it('51 records every skipped occurrence and runs none of them', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const due = harness.now() + 60_000;
    const id = await scheduleDueAt(harness, target, due);

    // Three days later, and outside the grace window for today as well.
    harness.setNow(due + 3 * 24 * 60 * 60 * 1000 + RUN_GRACE_MS + 1000);
    await harness.scheduler.tick();

    const runs = await harness.schedules.listRuns(id);
    expect(runs.filter((run) => run.status === 'missed').length).toBeGreaterThanOrEqual(3);
    expect(runs.every((run) => run.status !== 'completed')).toBe(true);
    expect(harness.seen).toHaveLength(0);
  });

  it('52 lets the next occurrence proceed normally after a missed one', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const due = harness.now() + 60_000;
    const id = await scheduleDueAt(harness, target, due);

    harness.setNow(due + RUN_GRACE_MS + 1000);
    await harness.scheduler.tick();

    const after = await harness.schedules.get(id);
    harness.setNow((after?.nextRunAt as number) + 1000);
    await harness.scheduler.tick();

    const runs = await harness.schedules.listRuns(id);
    expect(runs.some((run) => run.status === 'completed')).toBe(true);
    expect(harness.seen.filter((call) => call.tool === 'fake.read')).toHaveLength(1);
  });

  it('53 claims a missed occurrence, so a later wake-up cannot run it late', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const due = harness.now() + 60_000;
    const id = await scheduleDueAt(harness, target, due);

    harness.setNow(due + RUN_GRACE_MS + 1000);
    await harness.scheduler.tick();

    const claim = await harness.schedules.claimOccurrence(id, due);
    expect(claim).toEqual({ ok: false, reason: 'ALREADY_CLAIMED' });
  });

  it('54 caps how many past occurrences it will enumerate', () => {
    const schedule = {
      scheduleId: 'schedule_x',
      formatVersion: SCHEDULE_FORMAT_VERSION,
      displayName: 'Ancient',
      target: { kind: 'skill' as const, skillId: 'a.b', skillVersion: '1.0.0' },
      cadence: DAILY,
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
      nextRunAt: new Date(2024, 0, 1, 9, 30).getTime(),
      lastClaimedOccurrenceAt: 0,
    };
    const verdict = occurrencesDue(schedule, new Date(2026, 0, 1, 12, 0).getTime());
    expect(verdict.truncated).toBe(true);
    expect(verdict.missed.length).toBeLessThanOrEqual(32);
  });
});

// --- X. cancellation ------------------------------------------------------

describe('a run in flight can be stopped', () => {
  it('55 cancels a running run and records it as cancelled', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const created = await harness.schedules.create({
      displayName: 'Daily',
      target,
      cadence: DAILY,
      enabled: true,
    });
    const runId = runIdFor(created.scheduleId, created.nextRunAt);
    await harness.schedules.startRun({
      runId,
      scheduleId: created.scheduleId,
      occurrenceAt: created.nextRunAt,
      status: 'running',
    });

    expect(await harness.scheduler.cancelRun(runId)).toBe(true);
    const run = await harness.schedules.getRun(runId);
    expect(run?.status).toBe('cancelled');
    expect(run?.reason).toBe('CANCELLED');
  });

  it('56 does nothing for a run that has already finished', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const created = await harness.schedules.create({
      displayName: 'Daily',
      target,
      cadence: DAILY,
      enabled: true,
    });
    const runId = runIdFor(created.scheduleId, created.nextRunAt);
    await harness.schedules.startRun({
      runId,
      scheduleId: created.scheduleId,
      occurrenceAt: created.nextRunAt,
      status: 'completed',
    });
    expect(await harness.scheduler.cancelRun(runId)).toBe(false);
  });
});

// --- Y-Z. notifications and audit ----------------------------------------

describe('what the user is told, and what the trail records', () => {
  it('57 notifies on start and completion', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    await scheduleDueAt(harness, target, harness.now() + 60_000);
    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    expect(harness.notified.map((n) => n.kind)).toEqual(['started', 'completed']);
  });

  it('58 notifies that a run was blocked, and says approval was what it needed', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS, permissionMode: 'auto' });
    const target = await skillTarget(harness, 'fake.write', 'R3');
    await scheduleDueAt(harness, target, harness.now() + 60_000);
    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    const blocked = harness.notified.find((n) => n.kind === 'blocked');
    expect(blocked).toMatchObject({ kind: 'blocked', reason: 'CONFIRMATION_REQUIRED' });
  });

  it('59 records the whole run lifecycle in the audit trail', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    await scheduleDueAt(harness, target, harness.now() + 60_000);
    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    expect(harness.scheduleAudit.map((event) => event.type)).toEqual([
      'schedule.run_started',
      'schedule.run_completed',
    ]);
  });

  it('60 records a missed occurrence', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const due = harness.now() + 60_000;
    await scheduleDueAt(harness, target, due);
    harness.setNow(due + RUN_GRACE_MS + 1000);
    await harness.scheduler.tick();

    expect(harness.scheduleAudit.map((event) => event.type)).toContain('schedule.run_missed');
  });

  it('61 the log knows every schedule event type the runner emits', async () => {
    const harness = buildScheduleHarness({ tools: TOOLS, permissionMode: 'auto' });
    const target = await skillTarget(harness, 'fake.write', 'R3');
    await scheduleDueAt(harness, target, harness.now() + 60_000);
    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    for (const event of harness.scheduleAudit) {
      expect(AUDIT_EVENT_TYPES as readonly string[]).toContain(event.type);
    }
    // The whole lifecycle vocabulary, not only the ones this run produced.
    for (const type of [
      'schedule.created',
      'schedule.updated',
      'schedule.paused',
      'schedule.resumed',
      'schedule.deleted',
      'schedule.run_started',
      'schedule.run_completed',
      'schedule.run_failed',
      'schedule.run_blocked',
      'schedule.run_cancelled',
      'schedule.run_missed',
    ]) {
      expect(AUDIT_EVENT_TYPES as readonly string[]).toContain(type);
    }
  });

  it('62 never puts anything page-derived into a run record', async () => {
    const harness = buildScheduleHarness({
      tools: [{ name: 'fake.read', risk: 'R0' as const, returns: { secret: 'hunter2-from-page' } }],
    });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const id = await scheduleDueAt(harness, target, harness.now() + 60_000);
    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    const dump = JSON.stringify(await harness.schedules.listRuns(id));
    expect(dump).not.toContain('hunter2-from-page');
    expect(JSON.stringify(harness.scheduleAudit)).not.toContain('hunter2-from-page');
  });
});

// --- AA-AB. persistence ---------------------------------------------------

describe('what is on disk, and what is refused onto it', () => {
  it('63 reads a schedule back through a fresh store over the same area', async () => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const first = new ScheduleStore({ area, now: () => HARNESS_START });
    const created = await first.create({
      displayName: 'Daily',
      target: { kind: 'skill', skillId: 'a.b', skillVersion: '1.0.0' },
      cadence: DAILY,
      enabled: true,
    });

    const second = new ScheduleStore({ area, now: () => HARNESS_START });
    expect(await second.get(created.scheduleId)).toEqual(created);
  });

  it('64 drops a corrupt record rather than repairing it', async () => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const store = new ScheduleStore({ area, now: () => HARNESS_START });
    const created = await store.create({
      displayName: 'Daily',
      target: { kind: 'skill', skillId: 'a.b', skillVersion: '1.0.0' },
      cadence: DAILY,
      enabled: true,
    });

    await area.set(`schedules:v${SCHEDULE_FORMAT_VERSION}:${created.scheduleId}`, {
      v: SCHEDULE_FORMAT_VERSION,
      record: { ...created, cadence: { kind: 'fortnightly', hour: 9, minute: 0 } },
    });

    expect(await store.list()).toHaveLength(0);
    expect(await store.get(created.scheduleId)).toBeUndefined();
  });

  it('65 refuses a record carrying a field a schedule has nowhere to put', () => {
    expect(() => assertScheduleSafe({ scheduleId: 'schedule_1', apiKey: 'sk-live-123' })).toThrow(
      ProhibitedScheduleFieldError,
    );
    expect(() =>
      assertScheduleSafe({ scheduleId: 'schedule_1', target: { kind: 'skill', inputs: {} } }),
    ).toThrow(ProhibitedScheduleFieldError);
    expect(() => assertScheduleSafe({ scheduleId: 'schedule_1', pageContent: 'hello' })).toThrow(
      ProhibitedScheduleFieldError,
    );
  });

  it('66 refuses a stored record whose shape this build cannot use', () => {
    const base = {
      scheduleId: 'schedule_1',
      formatVersion: SCHEDULE_FORMAT_VERSION,
      displayName: 'Daily',
      target: { kind: 'skill', skillId: 'a.b', skillVersion: '1.0.0' },
      cadence: DAILY,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      nextRunAt: 2,
      lastClaimedOccurrenceAt: 1,
    };
    expect(isUsableSchedule(base)).toBe(true);
    expect(isUsableSchedule({ ...base, formatVersion: 99 })).toBe(false);
    expect(isUsableSchedule({ ...base, enabled: 'yes' })).toBe(false);
    expect(isUsableSchedule({ ...base, target: { kind: 'process', command: 'rm' } })).toBe(false);
    expect(isUsableSchedule({ ...base, lastRunStatus: 'exploded' })).toBe(false);
  });

  it('67 leaves no page content in the stored bytes', async () => {
    const harness = buildScheduleHarness({
      tools: [{ name: 'fake.read', risk: 'R0' as const, returns: { body: 'PAGE-SECRET-42' } }],
    });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    await scheduleDueAt(harness, target, harness.now() + 60_000);
    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    expect(await harness.dumpSchedules()).not.toContain('PAGE-SECRET-42');
  });
});

// --- AC-AD. clocks --------------------------------------------------------

describe('clock edges are decided rather than left to chance', () => {
  it('68 treats an occurrence exactly at the grace edge as runnable', () => {
    const schedule = {
      scheduleId: 'schedule_x',
      formatVersion: SCHEDULE_FORMAT_VERSION,
      displayName: 'Edge',
      target: { kind: 'skill' as const, skillId: 'a.b', skillVersion: '1.0.0' },
      cadence: DAILY,
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
      nextRunAt: HARNESS_START,
      lastClaimedOccurrenceAt: 0,
    };
    expect(occurrencesDue(schedule, HARNESS_START + RUN_GRACE_MS).due).toBe(HARNESS_START);
    expect(occurrencesDue(schedule, HARNESS_START + RUN_GRACE_MS + 1).due).toBeUndefined();
  });

  it('69 proposes nothing when the next occurrence is still ahead', () => {
    const schedule = {
      scheduleId: 'schedule_x',
      formatVersion: SCHEDULE_FORMAT_VERSION,
      displayName: 'Ahead',
      target: { kind: 'skill' as const, skillId: 'a.b', skillVersion: '1.0.0' },
      cadence: DAILY,
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
      nextRunAt: HARNESS_START + 60_000,
      lastClaimedOccurrenceAt: 0,
    };
    const verdict = occurrencesDue(schedule, HARNESS_START);
    expect(verdict.due).toBeUndefined();
    expect(verdict.missed).toHaveLength(0);
  });

  it('70 wakes at the earliest enabled schedule and clears when there is none', () => {
    const make = (nextRunAt: number, enabled: boolean) => ({
      scheduleId: `schedule_${nextRunAt}`,
      formatVersion: SCHEDULE_FORMAT_VERSION,
      displayName: 'x',
      target: { kind: 'skill' as const, skillId: 'a.b', skillVersion: '1.0.0' },
      cadence: DAILY,
      enabled,
      createdAt: 0,
      updatedAt: 0,
      nextRunAt,
      lastClaimedOccurrenceAt: 0,
    });
    expect(nextWakeUp([make(500, true), make(100, false), make(300, true)])).toBe(300);
    expect(nextWakeUp([make(100, false)])).toBeUndefined();
    expect(nextWakeUp([])).toBeUndefined();
  });
});

describe('daylight saving moves the instant, not the hour', () => {
  const original = process.env.TZ;
  afterAll(() => {
    process.env.TZ = original;
  });

  it('71 keeps a daily schedule at its local hour across a spring-forward', () => {
    process.env.TZ = 'Europe/London';
    // 2026-03-29 is when London clocks go 01:00 -> 02:00.
    let cursor = new Date(2026, 2, 27, 0, 0).getTime();
    const hours: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      cursor = nextOccurrence({ kind: 'daily', hour: 9, minute: 30 }, cursor) as number;
      hours.push(new Date(cursor).getHours());
    }
    expect(hours).toEqual([9, 9, 9, 9, 9]);
  });

  it('72 keeps a daily schedule at its local hour across a fall-back', () => {
    process.env.TZ = 'Europe/London';
    // 2026-10-25 is when London clocks go 02:00 -> 01:00.
    let cursor = new Date(2026, 9, 23, 0, 0).getTime();
    const hours: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      cursor = nextOccurrence({ kind: 'daily', hour: 9, minute: 30 }, cursor) as number;
      hours.push(new Date(cursor).getHours());
    }
    expect(hours).toEqual([9, 9, 9, 9, 9]);
  });

  it('73 produces exactly one occurrence for an hour that happens twice', () => {
    process.env.TZ = 'Europe/London';
    const start = new Date(2026, 9, 24, 12, 0).getTime();
    const end = new Date(2026, 9, 26, 12, 0).getTime();
    const found: number[] = [];
    let cursor = start;
    for (;;) {
      const next = nextOccurrence({ kind: 'daily', hour: 1, minute: 30 }, cursor);
      if (next === undefined || next > end) break;
      found.push(next);
      cursor = next;
    }
    // One on the 25th and one on the 26th, never two on the 25th.
    expect(found).toHaveLength(2);
    expect(new Set(found.map((at) => new Date(at).getDate())).size).toBe(2);
  });

  it('74 normalises a wall-clock time that does not exist, forwards', () => {
    process.env.TZ = 'Europe/London';
    // 01:30 on 2026-03-29 does not exist; it resolves into BST.
    const at = nextOccurrence(
      { kind: 'daily', hour: 1, minute: 30 },
      new Date(2026, 2, 28, 12, 0).getTime(),
    ) as number;
    expect(new Date(at).getDate()).toBe(29);
    expect(new Date(at).getHours()).toBe(2);
  });
});

// --- AE-AH. what scheduling is not ---------------------------------------

describe('scheduling knows nothing about providers, servers or secrets', () => {
  const files = [...sources(SCHEDULES_ROOT), RUNNER_SRC, PROMPTER_SRC];

  it('75 names no provider, model or account anywhere', () => {
    for (const file of files) {
      const code = identifiersOnly(readFileSync(file, 'utf8'));
      for (const word of ['openai', 'anthropic', 'gemini', 'apiKey', 'modelId', 'providerId']) {
        expect(code.toLowerCase(), file).not.toContain(word.toLowerCase());
      }
    }
  });

  it('76 reaches no network and needs no backend', () => {
    for (const file of files) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const word of ['fetch(', 'XMLHttpRequest', 'https://', 'http://', 'WebSocket']) {
        expect(code, file).not.toContain(word);
      }
    }
  });

  it('77 reads no credential store, token vault or settings', () => {
    for (const file of files) {
      const code = identifiersOnly(readFileSync(file, 'utf8'));
      for (const word of ['CredentialStore', 'TokenVault', 'SettingsStore', 'K1', 'passphrase']) {
        expect(code, file).not.toContain(word);
      }
    }
  });

  it('78 evaluates no policy of its own', () => {
    for (const file of files) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const word of [
        'evaluatePolicy',
        'RISK_RANK',
        'ALWAYS_CONFIRM_AT',
        'AUTO_APPROVE_BELOW',
        'PROHIBITED_CATEGORIES',
        'sitePolicy',
      ]) {
        expect(code, file).not.toContain(word);
      }
    }
  });

  it('79 holds no approval, grant or standing authorization', () => {
    for (const file of files) {
      const code = identifiersOnly(readFileSync(file, 'utf8'));
      for (const word of [
        'alwaysAllow',
        'always_allow',
        'approve_site',
        'grant',
        'authorization',
        'preApproved',
      ]) {
        expect(code.toLowerCase(), file).not.toContain(word.toLowerCase());
      }
    }
  });

  it('80 reaches no tool registry and dispatches nothing', () => {
    for (const file of sources(SCHEDULES_ROOT)) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const word of ['ToolRegistry', 'dispatch', 'SkillRunner', 'WorkflowReplayer']) {
        expect(code, file).not.toContain(word);
      }
    }
  });

  it('81 exposes no schedule route a model could reach', () => {
    const scheduleRoutes = Object.entries(PANEL_ROUTE_CLASSES).filter(([route]) =>
      route.startsWith('schedule.'),
    );
    expect(scheduleRoutes.length).toBeGreaterThanOrEqual(8);
    for (const [route, klass] of scheduleRoutes) {
      expect(['CLASS_B_PANEL_CONTROL_PLANE', 'CLASS_E_PANEL_READ_ONLY'], route).toContain(klass);
    }
  });

  it('82 registers no schedule tool', () => {
    const harness = buildScheduleHarness({ tools: TOOLS });
    expect(
      harness.tools
        .list()
        .map((tool) => tool.name)
        .filter((n) => n.startsWith('schedule')),
    ).toEqual([]);
  });

  it('83 runs with no provider connected at all', async () => {
    // The harness has no provider, no credential and no account. A scheduled
    // workflow run consults no model, so this is not a special case: it is
    // what every scheduled run does.
    const harness = buildScheduleHarness({ tools: TOOLS });
    const target = await skillTarget(harness, 'fake.read', 'R0');
    const id = await scheduleDueAt(harness, target, harness.now() + 60_000);
    harness.setNow(harness.now() + 61_000);
    await harness.scheduler.tick();

    const run = (await harness.schedules.listRuns(id))[0];
    const task = await harness.tasks.getTask(run?.taskId as string);
    expect(run?.status).toBe('completed');
    expect(task?.providerId).toBe('none');
    expect(task?.modelId).toBe('none');
  });

  it('84 describes a cadence in the extension’s own words', () => {
    expect(describeCadence(DAILY)).toBe('Every day at 09:30');
    expect(describeCadence({ kind: 'weekly', weekday: 1, hour: 7, minute: 5 })).toBe(
      'Every Monday at 07:05',
    );
    expect(describeCadence({ kind: 'monthly', day: 3, hour: 0, minute: 0 })).toBe(
      'On day 3 of each month at 00:00',
    );
    expect(describeCadence({ kind: 'annual', month: 2, day: 29, hour: 12, minute: 0 })).toBe(
      'Every February 29 at 12:00',
    );
  });
});
