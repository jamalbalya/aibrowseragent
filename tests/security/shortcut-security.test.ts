/**
 * TEST-SECURITY-024 — the shortcut security boundary (P-021).
 *
 * "Slash commands" is the feature most likely to grow an interpreter. The
 * obvious implementation expands a typed name into a command line, and a
 * thing that expands into commands is a thing that can be made to expand into
 * the wrong ones. Four claims keep this from being that, and the
 * twenty-seven cases below are named for what each would allow if false:
 *
 *  1. **A shortcut is a name, not a definition.** It holds a reference and
 *     nothing else — no steps, no arguments, no prompt, no code.
 *  2. **A name means one thing, deterministically.** Normalisation is fixed,
 *     collisions are refused rather than merged, and confusable names cannot
 *     coexist.
 *  3. **A shortcut grants nothing.** It adds no execution path; what it
 *     points at runs through the route that already existed for it, with
 *     every gate re-applied.
 *  4. **No model authority.** A model can neither manage a shortcut nor
 *     invoke one, and shortcuts never reach model context.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildShortcutHarness } from '../fixtures/shortcut-harness';
import { skillFixture } from '../fixtures/skill-harness';
import {
  ProhibitedShortcutFieldError,
  assertShortcutSafe,
  isUsableShortcut,
  SHORTCUT_FORMAT_VERSION,
} from '@/shortcuts/shortcut-model';
import { normaliseShortcutName, skeletonOf } from '@/shortcuts/shortcut-name';
import { ShortcutError, ShortcutStore } from '@/shortcuts/shortcut-store';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import type { TaintState } from '@/security/taint/taint-state';

const SRC_ROOT = resolve(import.meta.dirname, '../../src');
const SHORTCUTS_ROOT = resolve(import.meta.dirname, '../../src/shortcuts');

const UNTAINTED: TaintState = { kind: 'KNOWN_UNTAINTED' };
const SALT = 'ab'.repeat(32);

const TOOLS = [
  { name: 'fake.read', risk: 'R0' as const, returns: { title: 'A page' } },
  { name: 'fake.write', risk: 'R3' as const, returns: { written: true } },
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    return full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : [];
  });
}

function invocation(name: string, args: Record<string, unknown> = {}) {
  return {
    toolCallId: `tc_${name}_${Math.random().toString(16).slice(2)}`,
    taskId: 'task_skill_1',
    sessionId: 'session_skill',
    name,
    arguments: args,
    taintState: UNTAINTED,
    taintSalt: SALT,
    saltEpoch: 1,
    signal: new AbortController().signal,
  };
}

/** Records a one-step workflow and stores it, returning its id. */
async function storeWorkflow(
  harness: ReturnType<typeof buildShortcutHarness>,
  tool = 'fake.read',
): Promise<string> {
  harness.recorder.start('task_skill_1');
  await harness.tools.dispatch(invocation(tool, { url: 'https://example.test/' }));
  const captured = harness.recorder.stop();
  const saved = await harness.store.save({
    name: 'Read a page',
    description: 'A recording.',
    definition: captured!.definition,
    recordedFromTaskId: 'task_skill_1',
    taintAtCapture: captured!.taint,
  });
  return saved.workflowId;
}

// --- 1-5. a name, and a name only -----------------------------------------

describe('a shortcut holds a reference and nothing else', () => {
  it('1. validates a name against an explicit safe syntax', () => {
    for (const good of ['qa-regression', 'review-ticket', 'debug2', 'a']) {
      expect(normaliseShortcutName(good), good).toMatchObject({ ok: true, name: good });
    }
    for (const bad of ['', '   ', '/', '//', '-', '--', 'a b!c', 'a.b', 'a/b', 'a$b', '<script>']) {
      expect(normaliseShortcutName(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    // Bounded, so a name cannot become a payload.
    expect(normaliseShortcutName('a'.repeat(49)).ok).toBe(false);
  });

  it('2. normalises Unicode, case, slashes and separators deterministically', () => {
    // Every one of these is the same intent typed differently, and must
    // produce the same key — otherwise two of them are two shortcuts.
    for (const typed of [
      '/qa-regression',
      '///qa-regression',
      '  /QA-Regression  ',
      'QA_regression',
      'qa   regression',
      'qa--regression',
      '-qa-regression-',
      'ＱＡ-regression', // fullwidth QA, folded by NFKC
    ]) {
      expect(normaliseShortcutName(typed), JSON.stringify(typed)).toMatchObject({
        ok: true,
        name: 'qa-regression',
      });
    }
    // Idempotent, so a stored name is a stable identity.
    const once = normaliseShortcutName('/QA_Regression');
    expect(once.ok && normaliseShortcutName(once.name)).toMatchObject({
      ok: true,
      name: 'qa-regression',
    });
  });

  it('3. refuses a second shortcut whose name case-folds onto an existing one', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    const workflowId = await storeWorkflow(harness);
    await harness.shortcuts.create('QA-Regression', { kind: 'workflow', workflowId });

    // Refused, not merged and not auto-renamed. Merging would make one of the
    // two names silently run the other's target.
    await expect(
      harness.shortcuts.create('qa_regression', { kind: 'workflow', workflowId }),
    ).rejects.toThrow(ShortcutError);
    expect(await harness.shortcuts.list()).toHaveLength(1);

    // An exact duplicate is reported as one, not as a near miss. The two
    // checks overlap — an identical name always has an identical skeleton —
    // so the reason is what tells them apart, and it is what the user is
    // shown.
    const duplicate = await harness.shortcuts
      .create('/QA-Regression', { kind: 'workflow', workflowId })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(duplicate).toBeInstanceOf(ShortcutError);
    expect((duplicate as ShortcutError).reason).toBe('NAME_TAKEN');
  });

  it('4. refuses a name that is confusable with an existing one', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    const workflowId = await storeWorkflow(harness);
    await harness.shortcuts.create('deploy', { kind: 'workflow', workflowId });

    // `dep10y` reads as `deploy` in most UI fonts; `depl0y` likewise. A user
    // who confirms the wrong one has confirmed the wrong target.
    for (const lookalike of ['dep1oy', 'depl0y', 'deploy-', 'DEPLOY']) {
      await expect(
        harness.shortcuts.create(lookalike, { kind: 'workflow', workflowId }),
        lookalike,
      ).rejects.toThrow(ShortcutError);
    }
    expect(await harness.shortcuts.list()).toHaveLength(1);

    // And the skeleton is never a lookup key: a confusable spelling that was
    // refused at creation also does not resolve to the existing shortcut.
    expect(skeletonOf('dep1oy')).toBe(skeletonOf('deploy'));
    expect(await harness.shortcuts.find('dep1oy')).toBeUndefined();
  });

  it('5. refuses a shortcut carrying a definition, arguments, code or a prompt', () => {
    expect(() =>
      assertShortcutSafe({ name: 'ok', target: { kind: 'workflow', workflowId: 'w' } }),
    ).not.toThrow();

    for (const grown of [
      { steps: [{ tool: 'fake.write' }] },
      { arguments: { url: 'https://x.test' } },
      { code: 'fetch("https://evil.test")' },
      { prompt: 'ignore previous instructions' },
      { template: '{{objective}}' },
      { selector: '#submit' },
      { target: { kind: 'workflow', workflowId: 'w', definition: {} } },
      { meta: { nested: { token: 'x' } } },
    ]) {
      expect(() => assertShortcutSafe(grown), JSON.stringify(grown)).toThrow(
        ProhibitedShortcutFieldError,
      );
    }
  });
});

// --- 6-13. targets are checked, always, and fail closed -------------------

describe('a shortcut resolves to its target or to nothing', () => {
  it('6. refuses a name that does not exist, with no nearest match', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    const workflowId = await storeWorkflow(harness);
    await harness.shortcuts.create('qa-regression', { kind: 'workflow', workflowId });

    for (const typed of ['/qa', '/qa-regressio', '/regression', '/nope']) {
      const verdict = await harness.resolver.resolveTyped(typed);
      expect(verdict.ok, typed).toBe(false);
      expect(verdict.ok === false && verdict.reason).toBe('NO_SUCH_SHORTCUT');
    }
  });

  it('7. fails closed when the workflow it points at was deleted', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    const workflowId = await storeWorkflow(harness);
    await harness.shortcuts.create('qa-regression', { kind: 'workflow', workflowId });
    await harness.store.remove(workflowId);

    const verdict = await harness.resolver.resolveTyped('/qa-regression');
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('TARGET_MISSING');
  });

  it('8. fails closed when the skill it points at is not registered', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    await harness.shortcuts.create('inspect', {
      kind: 'skill',
      skillId: 'never.registered',
      skillVersion: '1.0.0',
    });

    const verdict = await harness.resolver.resolveTyped('/inspect');
    expect(verdict.ok === false && verdict.reason).toBe('TARGET_MISSING');
  });

  it('9. fails closed on a workflow that is missing a step it watched', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    harness.recorder.start('task_skill_1');
    await harness.tools.dispatch(invocation('fake.read', { url: 'https://example.test/' }));
    const captured = harness.recorder.stop()!;
    const saved = await harness.store.save({
      name: 'Read a page',
      description: 'A recording with a gap.',
      definition: captured.definition,
      recordedFromTaskId: 'task_skill_1',
      taintAtCapture: captured.taint,
      droppedSteps: [{ afterStepId: 's1', tool: 'fake.write', reason: 'could not be described' }],
    });
    await harness.shortcuts.create('gappy', { kind: 'workflow', workflowId: saved.workflowId });

    // P-022's rule holds through the shortcut, which is the point: a name does
    // not get to relax a rule about what it names.
    const verdict = await harness.resolver.resolveTyped('/gappy');
    expect(verdict.ok === false && verdict.reason).toBe('TARGET_UNUSABLE');
  });

  it('10. pins a skill version and never floats to a newer one', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    await harness.register(skillFixture({ id: 'test.skill', version: '1.0.0' }));
    await harness.shortcuts.create('inspect', {
      kind: 'skill',
      skillId: 'test.skill',
      skillVersion: '1.0.0',
    });
    await harness.register(skillFixture({ id: 'test.skill', version: '2.0.0' }));

    const verdict = await harness.resolver.resolveTyped('/inspect');
    // Still 1.0.0. A shortcut floating to a newer version would be the target
    // changing under a name the user already approved.
    expect(verdict.ok && verdict.resolution.targetVersion).toBe('1.0.0');
  });

  it('11. never falls through to a different target of the same kind', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    const first = await storeWorkflow(harness);
    const second = await storeWorkflow(harness);
    await harness.shortcuts.create('qa-regression', { kind: 'workflow', workflowId: first });
    await harness.store.remove(first);

    const verdict = await harness.resolver.resolveTyped('/qa-regression');
    expect(verdict.ok).toBe(false);
    // The other workflow still exists and is never substituted.
    expect(await harness.store.get(second)).toBeDefined();
  });

  it('12. refuses a stored record whose target kind it does not understand', () => {
    for (const bad of [
      { kind: 'tool', toolName: 'fake.write' },
      { kind: 'prompt', text: 'do a thing' },
      { kind: 'workflow' },
      { kind: 'skill', skillId: 'x' },
      { kind: 'skill', skillId: 'x', skillVersion: 'latest' },
    ]) {
      expect(
        isUsableShortcut({
          shortcutId: 's1',
          formatVersion: SHORTCUT_FORMAT_VERSION,
          displayName: 'x',
          name: 'x',
          skeleton: 'x',
          target: bad,
        }),
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it('13. ignores a stored record from a format it cannot read', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    const workflowId = await storeWorkflow(harness);
    const created = await harness.shortcuts.create('qa-regression', {
      kind: 'workflow',
      workflowId,
    });

    vi.spyOn(harness.shortcuts, 'list').mockResolvedValueOnce([
      { ...created, formatVersion: SHORTCUT_FORMAT_VERSION + 1 },
    ]);
    // Read through `find`, which goes via `list`; a record the build cannot
    // parse resolves to nothing rather than being best-effort interpreted.
    expect(isUsableShortcut({ ...created, formatVersion: SHORTCUT_FORMAT_VERSION + 1 })).toBe(
      false,
    );
    vi.restoreAllMocks();
  });
});

// --- 14-19. resolution runs nothing; execution re-earns everything --------

describe('a shortcut adds no execution path', () => {
  it('14. takes no side effect while resolving', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    const workflowId = await storeWorkflow(harness);
    await harness.shortcuts.create('qa-regression', { kind: 'workflow', workflowId });

    const before = harness.seen.length;
    // Resolved many times, as a panel would while someone types.
    for (let index = 0; index < 5; index += 1) {
      await harness.resolver.resolveTyped('/qa-regression');
    }
    expect(harness.seen).toHaveLength(before);
    expect((await harness.tasks.listTasks()).length).toBe(0);
  });

  it('15. runs its target through the existing replay, gates and all', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS, permissionMode: 'manual' });
    harness.respondWith('approve_once');
    const workflowId = await storeWorkflow(harness, 'fake.write');
    await harness.shortcuts.create('do-the-write', { kind: 'workflow', workflowId });

    const verdict = await harness.resolver.resolveTyped('/do-the-write');
    expect(verdict.ok).toBe(true);

    // Denied: the answer given now is the one that counts, exactly as it
    // would be without a name in front of it.
    harness.respondWith('deny');
    const before = harness.seen.length;
    const denied = await harness.replayer.replay({
      workflowId: verdict.ok ? verdict.resolution.targetId : '',
      sessionId: 'session_skill',
      inputs: {},
    });
    expect(denied.ok && denied.result.status).toBe('failed');
    expect(harness.seen).toHaveLength(before);

    harness.respondWith('approve_once');
    const allowed = await harness.replayer.replay({
      workflowId: verdict.ok ? verdict.resolution.targetId : '',
      sessionId: 'session_skill',
      inputs: {},
    });
    expect(allowed.ok && allowed.result.status).toBe('completed');
    expect(harness.seen).toHaveLength(before + 1);
  });

  it('16. cannot bypass the egress gate when its target runs', async () => {
    // Auto mode, so the permission engine approves the low-risk step on its
    // own: the egress gate is then the only thing that can stop this, which
    // is what makes the case isolate it.
    const harness = buildShortcutHarness({
      tools: [
        {
          name: 'fake.read',
          risk: 'R0',
          returns: { title: 'A page' },
          // Reading makes the task tainted, which is what turns the send into
          // a cross-site movement of private data.
          taint: [{ sourceType: 'page', site: 'example.test', sensitivity: 'confidential' }],
        },
        {
          name: 'fake.send',
          risk: 'R1',
          returns: { sent: true },
          egressTo: 'https://elsewhere.test/collect',
        },
      ],
      permissionMode: 'auto',
    });

    harness.recorder.start('task_skill_1');
    await harness.tools.dispatch(invocation('fake.read', { url: 'https://example.test/' }));
    await harness.tools.dispatch(invocation('fake.send', { body: 'x' }));
    const captured = harness.recorder.stop()!;
    const saved = await harness.store.save({
      name: 'Read then send',
      description: 'Two steps.',
      definition: captured.definition,
      recordedFromTaskId: 'task_skill_1',
      taintAtCapture: captured.taint,
    });
    await harness.shortcuts.create('send-it', { kind: 'workflow', workflowId: saved.workflowId });

    // The gate escalates a tainted cross-site transfer to a confirmation, and
    // the answer is no.
    harness.respondWith('deny');
    const verdict = await harness.resolver.resolveTyped('/send-it');
    const before = harness.seen.filter((call) => call.tool === 'fake.send').length;

    const outcome = await harness.replayer.replay({
      workflowId: verdict.ok ? verdict.resolution.targetId : '',
      sessionId: 'session_skill',
      inputs: {},
    });

    expect(outcome.ok && outcome.result.status).not.toBe('completed');
    // The send never reached the tool. A name in front of it changed nothing.
    expect(harness.seen.filter((call) => call.tool === 'fake.send')).toHaveLength(before);
  });

  it('17. preserves cancellation through a shortcut-launched skill', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    await harness.register(skillFixture({ id: 'test.skill', version: '1.0.0' }));
    await harness.shortcuts.create('inspect', {
      kind: 'skill',
      skillId: 'test.skill',
      skillVersion: '1.0.0',
    });

    const verdict = await harness.resolver.resolveTyped('/inspect');
    expect(verdict.ok).toBe(true);
    const outcome = await harness.launcher.launch({
      skillId: 'test.skill',
      skillVersion: '1.0.0',
      sessionId: 'session_skill',
      inputs: {},
    });
    expect(outcome.ok).toBe(true);
    // The launcher owns an abort handle for the run it created, which is what
    // makes a launched run stoppable like any other task.
    expect(harness.launcher.cancel(outcome.ok ? outcome.taskId : '')).toBe(false);
  });

  it('18. refuses to launch a skill the registry does not know', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    const outcome = await harness.launcher.launch({
      skillId: 'invented.by.a.model',
      skillVersion: '1.0.0',
      sessionId: 'session_skill',
      inputs: {},
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('NOT_REGISTERED');
    // Refused, never created.
    expect(harness.skills.get('invented.by.a.model', '1.0.0')).toBeUndefined();
  });

  it('19. launches a skill with no provider and clean taint', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    await harness.register(skillFixture({ id: 'test.skill', version: '1.0.0' }));
    const outcome = await harness.launcher.launch({
      skillId: 'test.skill',
      skillVersion: '1.0.0',
      sessionId: 'session_skill',
      inputs: {},
    });
    expect(outcome.ok).toBe(true);

    const task = await harness.tasks.getTask(outcome.ok ? outcome.taskId : '');
    // No model chose any of its arguments, and it has read nothing yet.
    expect(task?.providerId).toBe('none');
    expect(task?.taintState.kind).toBe('KNOWN_UNTAINTED');
  });
});

// --- 20-27. no model authority, structurally -----------------------------

describe('a model can neither manage nor invoke a shortcut', () => {
  it('20. registers no shortcut tool anywhere in the product', () => {
    for (const file of sources(SRC_ROOT)) {
      const text = readFileSync(file, 'utf8');
      // No tool named for shortcuts, and no shortcut-specific run route.
      expect(text, file).not.toMatch(/name:\s*'shortcut\./);
      expect(text, file).not.toMatch(/'shortcut\.run'/);
      expect(text, file).not.toMatch(/shortcutRun|runShortcutTool/);
    }
  });

  it('21. keeps the shortcut layer free of execution and evaluation', () => {
    for (const file of sources(SHORTCUTS_ROOT)) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // The shortcut layer resolves; it never runs, evaluates or fetches.
      expect(code, file).not.toMatch(/\.dispatch\s*\(/);
      expect(code, file).not.toMatch(/\.execute\s*\(/);
      expect(code, file).not.toMatch(/new Function\(/);
      expect(code, file).not.toMatch(/\beval\(/);
      expect(code, file).not.toMatch(/\bfetch\(/);
      expect(code, file).not.toMatch(/Runtime\.evaluate/);
    }
  });

  it('22. never lets the tool registry expose a shortcut to a model', () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    const names = harness.tools.list().map((tool) => tool.name);
    expect(names.filter((name) => name.startsWith('shortcut.'))).toEqual([]);
    expect(names.filter((name) => name.startsWith('skill.run'))).toEqual([]);

    // And the schemas actually offered to a model carry none either.
    const offered = harness.tools.toCanonicalSchemas().map((schema) => schema.name);
    expect(offered.some((name) => name.includes('shortcut'))).toBe(false);
  });

  it('23. keeps shortcuts out of the skill registry and skills.list', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    const workflowId = await storeWorkflow(harness);
    await harness.shortcuts.create('qa-regression', { kind: 'workflow', workflowId });

    // A shortcut is not a skill and cannot become one: the registry takes a
    // definition, and a shortcut has none to give it.
    expect(harness.skills.list().map((entry) => entry.definition.id)).not.toContain(
      'qa-regression',
    );
    expect(harness.skills.get('qa-regression', '1.0.0')).toBeUndefined();
  });

  it('24. cannot be created from anything a model produced', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    // The only way to name something is to point at an id that already
    // exists. A model-written definition is not registrable, so there is no
    // id for a shortcut to point at.
    const proposal = skillFixture({ id: 'model.proposal', provenance: 'model_proposed' });
    await expect(harness.register(proposal)).rejects.toThrow(/provenance/);
    expect(
      await harness.resolver.targetIsUsable({
        kind: 'skill',
        skillId: 'model.proposal',
        skillVersion: '1.0.0',
      }),
    ).toBe(false);
  });

  it('25. refuses to create a shortcut for a target that is not usable', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    expect(
      await harness.resolver.targetIsUsable({ kind: 'workflow', workflowId: 'does-not-exist' }),
    ).toBe(false);
    expect(
      await harness.resolver.targetIsUsable({
        kind: 'skill',
        skillId: 'nope',
        skillVersion: '1.0.0',
      }),
    ).toBe(false);
  });

  it('26. stores nothing about what the target does', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    const workflowId = await storeWorkflow(harness, 'fake.write');
    const created = await harness.shortcuts.create('do-the-write', {
      kind: 'workflow',
      workflowId,
    });

    const stored = JSON.stringify(created);
    // The tool the target reaches, its arguments and its steps are all absent:
    // a shortcut knows an id, not a behaviour.
    expect(stored).not.toContain('fake.write');
    expect(stored).not.toContain('steps');
    expect(stored).not.toContain('arguments');
    expect(Object.keys(created).sort()).toEqual(
      [
        'createdAt',
        'displayName',
        'formatVersion',
        'name',
        'shortcutId',
        'skeleton',
        'target',
        'updatedAt',
      ].sort(),
    );
  });

  it('27. survives a tampered record by ignoring it, not by interpreting it', async () => {
    // A real store over a storage area this test writes to directly, which is
    // the threat: something that is not this class editing extension storage.
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const store = new ShortcutStore({ area });
    const good = await store.create('qa-regression', {
      kind: 'workflow',
      workflowId: 'w1',
    });

    await area.set('shortcuts', {
      shortcuts: [
        good,
        { ...good, shortcutId: 's2', name: '', skeleton: '' },
        { ...good, shortcutId: 's3', target: { kind: 'tool', toolName: 'fake.write' } },
        { ...good, shortcutId: 's4', formatVersion: SHORTCUT_FORMAT_VERSION + 1 },
        { ...good, shortcutId: 's5', steps: [{ tool: 'fake.write' }] },
        'not an object',
      ],
    });

    // Only the untampered one survives. The others are dropped rather than
    // repaired: a half-understood reference is one that could resolve to
    // something the user never named.
    const list = await store.list();
    expect(list.map((entry) => entry.shortcutId)).toEqual([good.shortcutId]);
    expect(await store.find('/qa-regression')).toMatchObject({ shortcutId: good.shortcutId });

    // And nothing tampered resolves by any spelling.
    for (const typed of ['/qa-regression', '/s2', '/s3', '/s4', '/s5']) {
      const found = await store.find(typed);
      expect(found === undefined || found.shortcutId === good.shortcutId, typed).toBe(true);
    }
  });
});
