/**
 * TEST-SECURITY-023 — the recorded-workflow security boundary (P-022).
 *
 * Recording is the most dangerous-looking feature in the product, because a
 * recording is literally "a list of privileged actions, saved" and the obvious
 * implementation hands a stored list to something that runs it. Four claims
 * keep this from being that, and the sixteen cases below are named for the
 * attack each one would allow if the claim were false:
 *
 *  1. **Observation cannot become participation.** The recorder watches
 *     dispatches through a frozen, cloned record of a call that has already
 *     finished. It cannot alter, block, retry, re-authorise or start one.
 *  2. **A recording is not a capability.** It is never registered, never
 *     listed to a model, never selectable by one, and never replayed by
 *     anything but a person.
 *  3. **A recording stores intent, never data.** Secret detection runs on
 *     every value regardless of taint; provenance decides literal-versus-slot;
 *     neither control substitutes for the other.
 *  4. **Replay re-earns everything.** Integrity, validity and every gate are
 *     re-applied at replay against the world as it is then.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildWorkflowHarness } from '../fixtures/workflow-harness';
import { parameteriseArgument } from '@/workflows/parameteriser';
import {
  MisplacedProvenanceError,
  ProhibitedWorkflowFieldError,
  assertProvenancePlacement,
  assertWorkflowSafe,
  canonicalJson,
  isIncomplete,
  RECORDED_PROVENANCE,
  WORKFLOW_FORMAT_VERSION,
} from '@/workflows/workflow-model';
import { validateSkillDefinition } from '@/skills/core/skill-model';
import { resolveElement } from '@/skills/runtime/skill-runner';
import type { DispatchObservation } from '@/tools/registry/tool-registry';
import type { SkillDefinition } from '@/skills/core/skill-model';
import type { TaintState } from '@/security/taint/taint-state';

const WORKFLOWS_ROOT = resolve(import.meta.dirname, '../../src/workflows');
const SRC_ROOT = resolve(import.meta.dirname, '../../src');

/** Assembled at runtime so no scannable credential literal sits on one line. */
const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

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

/**
 * The provenance every recorded element binding carries.
 *
 * Spelled out in the tests rather than defaulted, because the whole claim is
 * that there is no default: an untagged page-derived binding must not be
 * representable.
 */
const PAGE_DERIVED = { provenance: 'PAGE_DERIVED', purpose: 'ELEMENT_BINDING' } as const;

const UNTAINTED = { kind: 'KNOWN_UNTAINTED' } as const;
const TAINTED: TaintState = {
  kind: 'TAINTED',
  sources: [{ sourceType: 'page', site: 'reader.test', sensitivity: 'internal' }],
};

async function recordOneWorkflow(
  harness: ReturnType<typeof buildWorkflowHarness>,
  args: Record<string, unknown> = { url: 'https://example.test/thing' },
): Promise<SkillDefinition> {
  harness.recorder.start('task_skill_1');
  await harness.tools.dispatch({
    toolCallId: 'tc1',
    taskId: 'task_skill_1',
    sessionId: 'session_skill',
    name: 'fake.read',
    arguments: args,
    taintState: UNTAINTED,
    taintSalt: 'ab'.repeat(32),
    saltEpoch: 1,
    signal: new AbortController().signal,
  });
  const captured = harness.recorder.stop();
  expect(captured).not.toBeNull();
  return captured!.definition;
}

// --- 1-4. observation cannot become participation --------------------------

describe('the dispatch observation hook is an observation and nothing more', () => {
  it('1. hands the observer a deeply frozen record with no live reference to the call', async () => {
    const harness = buildWorkflowHarness({ tools: TOOLS });
    const args = { url: 'https://example.test/', nested: { deep: 'value' } };

    await harness.tools.dispatch({
      toolCallId: 'tc1',
      taskId: 'task_skill_1',
      sessionId: 'session_skill',
      name: 'fake.read',
      arguments: args,
      taintState: UNTAINTED,
      taintSalt: 'ab'.repeat(32),
      saltEpoch: 1,
      signal: new AbortController().signal,
    });

    const observation = harness.observed[0];
    expect(observation).toBeDefined();
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation!.arguments)).toBe(true);
    // A clone, not the caller's object: mutating the original afterwards must
    // not change what the observer was shown, and the observer must not be
    // holding a handle on anything the dispatch path still uses.
    expect(observation!.arguments).not.toBe(args);
    expect(Object.isFrozen((observation!.arguments as { nested: object }).nested)).toBe(true);
  });

  it('2. carries no security, policy, permission or evidence state', async () => {
    const harness = buildWorkflowHarness({ tools: TOOLS });
    await harness.tools.dispatch({
      toolCallId: 'tc1',
      taskId: 'task_skill_1',
      sessionId: 'session_skill',
      name: 'fake.read',
      arguments: {},
      taintState: TAINTED,
      taintSalt: 'ab'.repeat(32),
      saltEpoch: 1,
      signal: new AbortController().signal,
    });

    // The whole surface, enumerated. A field added here without thought is
    // how an observer would acquire something it could act on.
    expect(Object.keys(harness.observed[0]!).sort()).toEqual(
      ['arguments', 'executed', 'risk', 'status', 'taskId', 'tool', 'toolCallId'].sort(),
    );
    for (const forbidden of [
      'taintState',
      'evidence',
      'decision',
      'policy',
      'permission',
      'envelope',
      'result',
      'signal',
      'consent',
    ]) {
      expect(harness.observed[0]).not.toHaveProperty(forbidden);
    }
  });

  it('3. survives an observer that throws, and returns the same result', async () => {
    const harness = buildWorkflowHarness({ tools: TOOLS });
    harness.setObserver(() => {
      throw new Error('an observer misbehaving');
    });

    const result = await harness.tools.dispatch({
      toolCallId: 'tc1',
      taskId: 'task_skill_1',
      sessionId: 'session_skill',
      name: 'fake.read',
      arguments: {},
      taintState: UNTAINTED,
      taintSalt: 'ab'.repeat(32),
      saltEpoch: 1,
      signal: new AbortController().signal,
    });

    expect(result.envelope.status).toBe('success');
    expect(result.executed).toBe(true);
  });

  it('4. runs after execution, so nothing it does can block or retry the call', async () => {
    const order: string[] = [];
    const harness = buildWorkflowHarness({
      tools: [{ ...TOOLS[0]!, onCall: () => order.push('executed') }],
    });
    harness.setObserver(() => {
      order.push('observed');
    });

    await harness.tools.dispatch({
      toolCallId: 'tc1',
      taskId: 'task_skill_1',
      sessionId: 'session_skill',
      name: 'fake.read',
      arguments: {},
      taintState: UNTAINTED,
      taintSalt: 'ab'.repeat(32),
      saltEpoch: 1,
      signal: new AbortController().signal,
    });

    expect(order).toEqual(['executed', 'observed']);
    // And it saw exactly one dispatch: an observer that could re-enter would
    // show up here as a second execution.
    expect(order.filter((entry) => entry === 'executed')).toHaveLength(1);
  });
});

// --- 5-6. element bindings are declarative, and fail closed ----------------

describe('an element binding cannot become a selector language', () => {
  it('5. refuses selector, XPath, scheme and expression shapes in role or name', () => {
    const check = (role: string, name: string): string =>
      validateSkillDefinition(
        {
          ...definitionFixture(),
          steps: [
            {
              kind: 'tool',
              id: 's0',
              tool: 'fake.read',
              description: 'Read the page.',
              arguments: {},
            },
            {
              kind: 'tool',
              id: 's1',
              tool: 'fake.read',
              description: 'Click something.',
              arguments: {
                elementId: { kind: 'element' as const, ...PAGE_DERIVED, step: 's0', role, name },
              },
            },
          ],
        },
        { hasTool: () => true, allowProvenance: [RECORDED_PROVENANCE] },
      ).join(' ');

    // A role is an ARIA token, so every one of these is refused as a role —
    // `button.primary` included, which no shape-based rule would catch.
    for (const shape of [
      'button.primary',
      '#submit',
      '//button[1]',
      'javascript:alert(1)',
      'data:text/html,<b>',
      'button::after',
      '() => 1',
      'button[type=submit]',
      'Runtime.evaluate',
    ]) {
      expect(check(shape, 'Save'), shape).toMatch(/selector or a URL scheme/);
    }

    // An accessible name is free text, so it is held to the shape rule — a
    // name genuinely contains dots and spaces, but never selector syntax.
    for (const shape of [
      '#submit',
      '//button[1]',
      'javascript:alert(1)',
      'data:text/html,<b>',
      'li::after',
      '() => 1',
      'button[type=submit]',
    ]) {
      expect(check('button', shape), shape).toMatch(/selector or a URL scheme/);
    }

    // And an ordinary binding still validates, so the rule is a filter rather
    // than a refusal of everything.
    expect(check('button', 'Save file.txt')).toBe('');
  });

  it('6. fails closed on no match, an ambiguous match and a wrong expected state', () => {
    const page = {
      elements: [
        { elementId: 'e1', role: 'button', name: 'Save', visible: true, enabled: true },
        { elementId: 'e2', role: 'button', name: 'Save', visible: true, enabled: true },
        { elementId: 'e3', role: 'button', name: 'Delete', visible: true, enabled: false },
      ],
    };

    // Nothing named that.
    expect(
      resolveElement(
        { kind: 'element' as const, ...PAGE_DERIVED, step: 's0', role: 'button', name: 'Nope' },
        page,
      ),
    ).toBeUndefined();
    // Two candidates and no nth: refused rather than guessed.
    expect(
      resolveElement(
        { kind: 'element' as const, ...PAGE_DERIVED, step: 's0', role: 'button', name: 'Save' },
        page,
      ),
    ).toBeUndefined();
    // Disambiguated by position, which is the only disambiguation there is.
    expect(
      resolveElement(
        {
          kind: 'element' as const,
          ...PAGE_DERIVED,
          step: 's0',
          role: 'button',
          name: 'Save',
          nth: 1,
        },
        page,
      ),
    ).toBe('e2');
    // Present, but not in the state the binding requires.
    expect(
      resolveElement(
        {
          kind: 'element' as const,
          ...PAGE_DERIVED,
          step: 's0',
          role: 'button',
          name: 'Delete',
          expect: 'enabled',
        },
        page,
      ),
    ).toBeUndefined();
    // A stale or malformed page read resolves to nothing at all.
    expect(
      resolveElement(
        { kind: 'element' as const, ...PAGE_DERIVED, step: 's0', role: 'button', name: 'Save' },
        null,
      ),
    ).toBeUndefined();
    expect(
      resolveElement(
        { kind: 'element' as const, ...PAGE_DERIVED, step: 's0', role: 'button', name: 'Save' },
        { elements: 'no' },
      ),
    ).toBeUndefined();
  });
});

// --- 7-9. three independent controls, in a fixed order ---------------------

describe('taint, sensitivity and secret detection are separate controls', () => {
  it('7. refuses to store anything from a task whose security context is UNKNOWN', () => {
    const decision = parameteriseArgument({
      tool: 'fake.write',
      stepId: 's1',
      argument: 'body',
      value: 'an ordinary sentence',
      taint: { kind: 'UNKNOWN', reason: 'field-absent' },
    });
    expect(decision.kind).toBe('refused');
  });

  it('8. never stores a secret-shaped literal, even when the task is KNOWN_UNTAINTED', () => {
    // This is the case the whole ordering exists for. `KNOWN_UNTAINTED` means
    // provenance is established — it does not mean the value is safe to keep,
    // and a design that treated the two as the same would write this to disk.
    for (const [argument, value] of [
      ['note', TOKEN],
      ['detail', 'sk-' + 'test0123456789abcdefghijklmnopqrstuv'],
      ['password', ''],
      ['apiKey', 'anything at all'],
    ] as const) {
      const decision = parameteriseArgument({
        tool: 'fake.write',
        stepId: 's1',
        argument,
        value,
        taint: UNTAINTED,
      });
      expect(decision.kind).toBe('slot');
      // Not as a default, not truncated, not hashed: the value appears
      // nowhere in what would be persisted. (An empty password is still a
      // password field, and is slotted for its name rather than its shape —
      // there is nothing to look for in what was stored.)
      if (value.length > 0) {
        expect(JSON.stringify(decision)).not.toContain(value.slice(0, 12));
      }
    }
  });

  it('9. turns a tainted task’s page-shaped values into slots rather than literals', () => {
    const long = parameteriseArgument({
      tool: 'fake.write',
      stepId: 's1',
      argument: 'body',
      value: 'a sentence long enough to have come from something this task read',
      taint: TAINTED,
    });
    expect(long.kind).toBe('slot');

    // A URL is content even when it is short, because it names a destination.
    const url = parameteriseArgument({
      tool: 'fake.read',
      stepId: 's1',
      argument: 'url',
      value: 'https://a.test/',
      taint: TAINTED,
    });
    expect(url.kind).toBe('slot');

    // Structure survives, so a recording is not uselessly all slots.
    const flag = parameteriseArgument({
      tool: 'fake.write',
      stepId: 's1',
      argument: 'submit',
      value: true,
      taint: TAINTED,
    });
    expect(flag.kind).toBe('literal');
  });
});

// --- 10-11. the store owns identity, and refuses data ----------------------

describe('a stored workflow’s hash and contents are the store’s to decide', () => {
  it('10. computes the hash itself, and a semantic edit produces a new hash and version', async () => {
    const harness = buildWorkflowHarness({ tools: TOOLS });
    const definition = await recordOneWorkflow(harness);

    const saved = await harness.store.save({
      name: 'First',
      description: 'A recording.',
      definition,
      recordedFromTaskId: 'task_skill_1',
      taintAtCapture: 'KNOWN_UNTAINTED',
    });

    expect(saved.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await harness.store.verifyIntegrity(saved)).toBe(true);

    // Renaming is not a semantic edit, so the hash does not move.
    const renamed = await harness.store.update(saved.workflowId, {
      name: 'Second',
      description: 'The same recording, renamed.',
      definition,
      recordedFromTaskId: 'task_skill_1',
      taintAtCapture: 'KNOWN_UNTAINTED',
    });
    expect(renamed.definitionHash).toBe(saved.definitionHash);
    expect(renamed.version).toBe(saved.version + 1);

    // Changing a step is, so it does.
    const edited = await harness.store.update(saved.workflowId, {
      name: 'Second',
      description: 'An edited recording.',
      definition: {
        ...definition,
        steps: definition.steps.map((step) =>
          step.kind === 'tool'
            ? {
                ...step,
                arguments: { url: { kind: 'literal' as const, value: 'https://other.test/' } },
              }
            : step,
        ),
      },
      recordedFromTaskId: 'task_skill_1',
      taintAtCapture: 'KNOWN_UNTAINTED',
    });
    expect(edited.definitionHash).not.toBe(saved.definitionHash);
    expect(edited.version).toBe(saved.version + 2);

    // A record whose stored definition was altered underneath the store no
    // longer re-derives its hash, and the store says so.
    const tampered = {
      ...saved,
      definition: { ...saved.definition, requiredTools: ['fake.write'] },
    };
    expect(await harness.store.verifyIntegrity(tampered)).toBe(false);
  });

  it('11. refuses a record carrying data at any depth, not just at the top', () => {
    expect(() => assertWorkflowSafe({ name: 'ok', definition: { steps: [] } })).not.toThrow();
    expect(() => assertWorkflowSafe({ accessToken: TOKEN })).toThrow(ProhibitedWorkflowFieldError);
    // One level of nesting is exactly the shape a caller reaches for when a
    // flat field is refused, so the check is recursive.
    expect(() => assertWorkflowSafe({ detail: { nested: { result: 'page text' } } })).toThrow(
      ProhibitedWorkflowFieldError,
    );
    expect(() => assertWorkflowSafe({ steps: [{ meta: { cookie: 'a=b' } }] })).toThrow(
      ProhibitedWorkflowFieldError,
    );
    // Canonical JSON is order-independent, so a reformat never reads as an edit.
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
});

// --- 12-13. a recording is not a capability -------------------------------

describe('a recorded workflow never becomes something a model can reach', () => {
  it('12. is refused by the skill registry, so it cannot appear in skills.list', async () => {
    const harness = buildWorkflowHarness({ tools: TOOLS });
    const definition = await recordOneWorkflow(harness);

    expect(definition.provenance).toBe(RECORDED_PROVENANCE);
    // The registry takes bundled definitions only. A recording reaching it
    // would be a new model-invokable tool combination nobody reviewed.
    await expect(harness.skills.register(definition)).rejects.toThrow(/provenance/);
    expect(harness.skills.list()).toHaveLength(0);
  });

  it('13. is never registered, listed or auto-replayed by any code in the product', () => {
    const workflowSources = sources(WORKFLOWS_ROOT).map((file) => ({
      file,
      text: readFileSync(file, 'utf8'),
    }));

    for (const { file, text } of workflowSources) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      // No path from a recording into the registry.
      expect(code, file).not.toMatch(/\.register\s*\(/);
      expect(code, file).not.toMatch(/SkillRegistry/);
      // And no second execution path: dispatch is reached through the runner.
      expect(code, file).not.toMatch(/\.execute\s*\(/);
    }

    // Nothing anywhere registers a `workflow.*` tool, so no model ever sees
    // one in its schema list.
    for (const file of sources(SRC_ROOT)) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/name:\s*'workflow\./);
      expect(text, file).not.toMatch(/'workflow\.register'/);
    }
  });
});

// --- 14-16. replay re-earns everything ------------------------------------

describe('replaying a stored workflow re-earns every decision', () => {
  it('14. refuses a record that fails integrity, format or validity', async () => {
    const harness = buildWorkflowHarness({ tools: TOOLS });
    const definition = await recordOneWorkflow(harness);
    const saved = await harness.store.save({
      name: 'Read a page',
      description: 'A recording.',
      definition,
      recordedFromTaskId: 'task_skill_1',
      taintAtCapture: 'KNOWN_UNTAINTED',
    });

    expect((await harness.replayer.revalidate('nope')).ok).toBe(false);

    // Altered underneath the store.
    vi.spyOn(harness.store, 'get').mockResolvedValueOnce({
      ...saved,
      definition: { ...saved.definition, requiredTools: ['fake.write'] },
    });
    const tampered = await harness.replayer.revalidate(saved.workflowId);
    expect(tampered.ok).toBe(false);
    expect(tampered.ok === false && tampered.reason).toBe('INTEGRITY_FAILED');

    // Recorded by a build this one cannot read.
    vi.spyOn(harness.store, 'get').mockResolvedValueOnce({
      ...saved,
      formatVersion: WORKFLOW_FORMAT_VERSION + 1,
    });
    const future = await harness.replayer.revalidate(saved.workflowId);
    expect(future.ok === false && future.reason).toBe('FORMAT_UNSUPPORTED');

    // The tool it names has since been removed.
    vi.spyOn(harness.tools, 'get').mockReturnValue(undefined);
    const gone = await harness.replayer.revalidate(saved.workflowId);
    expect(gone.ok === false && gone.reason).toBe('DEFINITION_INVALID');
    vi.restoreAllMocks();

    // And an intact one still runs.
    expect((await harness.replayer.revalidate(saved.workflowId)).ok).toBe(true);
  });

  it('15. refuses when a tool no longer accepts the arguments the recording holds', async () => {
    const harness = buildWorkflowHarness({ tools: TOOLS });
    const definition = await recordOneWorkflow(harness);
    const saved = await harness.store.save({
      name: 'Read a page',
      description: 'A recording.',
      definition,
      recordedFromTaskId: 'task_skill_1',
      taintAtCapture: 'KNOWN_UNTAINTED',
    });

    const tool = harness.tools.get('fake.read')!;
    // The schema tightens under the recording, which is what happens when a
    // tool's arguments change between a recording and its replay.
    vi.spyOn(harness.tools, 'get').mockReturnValue({
      ...tool,
      inputSchema: {
        safeParse: () => ({
          success: false,
          error: { issues: [{ path: ['url'] }] },
        }),
      },
    } as unknown as ReturnType<typeof harness.tools.get>);

    const verdict = await harness.replayer.revalidate(saved.workflowId);
    expect(verdict.ok === false && verdict.reason).toBe('ARGUMENTS_INVALID');
    vi.restoreAllMocks();
  });

  it('16. asks for permission again at replay, and executes only through dispatch', async () => {
    // `manual` so nothing is auto-approved: the point is that the prompts the
    // user answered while recording were not banked.
    const harness = buildWorkflowHarness({ tools: TOOLS, permissionMode: 'manual' });
    harness.respondWith('approve_once');

    harness.recorder.start('task_skill_1');
    await harness.tools.dispatch({
      toolCallId: 'tc1',
      taskId: 'task_skill_1',
      sessionId: 'session_skill',
      name: 'fake.write',
      arguments: { submit: true },
      taintState: UNTAINTED,
      taintSalt: 'ab'.repeat(32),
      saltEpoch: 1,
      signal: new AbortController().signal,
    });
    const captured = harness.recorder.stop()!;

    const saved = await harness.store.save({
      name: 'Write something',
      description: 'A recording of a write.',
      definition: captured.definition,
      recordedFromTaskId: 'task_skill_1',
      taintAtCapture: 'KNOWN_UNTAINTED',
    });
    const promptsAfterRecording = harness.prompts().length;

    // Saving ran nothing: the tool was called once, while recording.
    expect(harness.seen.filter((call) => call.tool === 'fake.write')).toHaveLength(1);

    harness.respondWith('deny');
    const denied = await harness.replayer.replay({
      workflowId: saved.workflowId,
      sessionId: 'session_skill',
      inputs: {},
    });
    expect(denied.ok).toBe(true);
    expect(denied.ok && denied.result.status).toBe('failed');
    // Asked again, and the answer given now is the one that counted.
    expect(harness.prompts().length).toBeGreaterThan(promptsAfterRecording);
    expect(harness.seen.filter((call) => call.tool === 'fake.write')).toHaveLength(1);

    harness.respondWith('approve_once');
    const allowed = await harness.replayer.replay({
      workflowId: saved.workflowId,
      sessionId: 'session_skill',
      inputs: {},
    });
    expect(allowed.ok && allowed.result.status).toBe('completed');
    expect(harness.seen.filter((call) => call.tool === 'fake.write')).toHaveLength(2);

    // Every replay is on the audit trail by workflow id and definition hash,
    // and never by its steps or arguments.
    const replays = harness.audited.filter((event) => event.type === 'workflow.replay');
    expect(replays.length).toBeGreaterThan(0);
    expect(replays.every((event) => event.definitionHash === saved.definitionHash)).toBe(true);
    expect(JSON.stringify(replays)).not.toContain('submit');
  });
});

function definitionFixture(): SkillDefinition {
  return {
    id: 'recorded.workflow',
    version: '1.0.0',
    name: 'Recorded workflow',
    description: 'A recording.',
    provenance: RECORDED_PROVENANCE,
    risk: 'R0',
    requiredTools: ['fake.read'],
    requiredConnectors: [],
    inputs: [],
    outputs: [],
    steps: [],
  };
}

/** Kept honest: the observation type is what the tests above enumerate. */
export type _ObservationShape = DispatchObservation;

// --- 17-24. provenance is a property, not a verdict ------------------------

describe('a page-derived value carries where it came from, permanently', () => {
  it('17. refuses a stored workflow whose element binding lost its tags', async () => {
    const harness = buildWorkflowHarness({ tools: TOOLS });
    const definition = await recordOneWorkflow(harness);

    // The tag stripped off, which is the shape a value takes when something
    // tries to launder page text into an untagged predicate.
    const untagged = {
      ...definition,
      steps: [
        {
          kind: 'tool' as const,
          id: 's1',
          tool: 'fake.read',
          description: 'Read.',
          arguments: {},
        },
        {
          kind: 'tool' as const,
          id: 's2',
          tool: 'fake.write',
          description: 'Click.',
          arguments: {
            elementId: { kind: 'element', step: 's1', role: 'button', name: 'Save' },
          },
        },
      ],
    } as unknown as SkillDefinition;

    await expect(
      harness.store.save({
        name: 'Untagged',
        description: 'A binding with no provenance.',
        definition: untagged,
        recordedFromTaskId: 'task_skill_1',
        taintAtCapture: 'KNOWN_UNTAINTED',
      }),
    ).rejects.toThrow();
  });

  it('18. refuses a page-derived tag anywhere other than an element binding', () => {
    // The structural half of the persistence rule. A tag on a literal is how
    // page text would arrive somewhere that reads it as a value.
    expect(() =>
      assertProvenancePlacement({
        definition: {
          steps: [
            {
              arguments: {
                url: { kind: 'literal', value: 'x', provenance: 'PAGE_DERIVED' },
              },
            },
          ],
        },
      }),
    ).toThrow(MisplacedProvenanceError);

    expect(() =>
      assertProvenancePlacement({ note: { purpose: 'ELEMENT_BINDING', text: 'x' } }),
    ).toThrow(MisplacedProvenanceError);

    // And the legitimate shape passes.
    expect(() =>
      assertProvenancePlacement({
        definition: {
          steps: [
            {
              arguments: {
                elementId: {
                  kind: 'element',
                  provenance: 'PAGE_DERIVED',
                  purpose: 'ELEMENT_BINDING',
                  step: 's1',
                  role: 'button',
                  name: 'Save',
                },
              },
            },
          ],
        },
      }),
    ).not.toThrow();
  });

  it('19. never lets a binding field reach the audit trail or evidence', async () => {
    const harness = buildWorkflowHarness({ tools: TOOLS });
    const definition = await recordOneWorkflow(harness);
    const saved = await harness.store.save({
      name: 'Read a page',
      description: 'A recording.',
      definition,
      recordedFromTaskId: 'task_skill_1',
      taintAtCapture: 'KNOWN_UNTAINTED',
    });

    await harness.replayer.replay({
      workflowId: saved.workflowId,
      sessionId: 'session_skill',
      inputs: {},
    });

    const trail = JSON.stringify(harness.audited);
    for (const field of ['role', 'name', 'nth', 'expect', 'PAGE_DERIVED', 'ELEMENT_BINDING']) {
      expect(trail).not.toContain(field);
    }
  });

  it('20. compares a binding rather than assembling anything from it', () => {
    const files = sources(WORKFLOWS_ROOT).concat(
      sources(resolve(import.meta.dirname, '../../src/skills/runtime')),
    );

    for (const file of files) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // No way to turn a stored string into something that runs or queries.
      expect(code, file).not.toMatch(/new RegExp\(/);
      expect(code, file).not.toMatch(/new Function\(/);
      expect(code, file).not.toMatch(/\bquerySelector\b/);
      expect(code, file).not.toMatch(/Runtime\.evaluate/);
      expect(code, file).not.toMatch(/\beval\(/);
      // And no interpolation of a binding field into a string that could be
      // read as a selector.
      expect(code, file).not.toMatch(/\$\{\s*binding\.(role|name)\s*\}/);
    }
  });

  it('21. does not trust the record-time match count at replay', () => {
    // The count recorded when the click happened is a fact about that page.
    // A replay recounts against the page in front of it, so a binding written
    // as unique still refuses when the current page has two.
    const binding = {
      kind: 'element' as const,
      ...PAGE_DERIVED,
      step: 's0',
      role: 'button',
      name: 'Save',
    };
    const oneMatch = {
      elements: [{ elementId: 'e1-1', role: 'button', name: 'Save', visible: true, enabled: true }],
    };
    const twoMatches = {
      elements: [
        { elementId: 'e1-1', role: 'button', name: 'Save', visible: true, enabled: true },
        { elementId: 'e1-2', role: 'button', name: 'Save', visible: true, enabled: true },
      ],
    };

    expect(resolveElement(binding, oneMatch)).toBe('e1-1');
    expect(resolveElement(binding, twoMatches)).toBeUndefined();
  });

  it('22. will not match an element whose current name looks like a credential', () => {
    // Re-checked against the page as it is now: a page that has since put a
    // token into a label must not have it read back into a comparison.
    const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const binding = {
      kind: 'element' as const,
      ...PAGE_DERIVED,
      step: 's0',
      role: 'button',
      name: token,
    };
    expect(
      resolveElement(binding, {
        elements: [
          { elementId: 'e1-1', role: 'button', name: token, visible: true, enabled: true },
        ],
      }),
    ).toBeUndefined();
  });

  it('23. refuses to replay a workflow that is missing a step it watched', async () => {
    const harness = buildWorkflowHarness({ tools: TOOLS });
    const definition = await recordOneWorkflow(harness);
    const saved = await harness.store.save({
      name: 'Read a page',
      description: 'A recording with a gap.',
      definition,
      recordedFromTaskId: 'task_skill_1',
      taintAtCapture: 'KNOWN_UNTAINTED',
      droppedSteps: [{ afterStepId: 's1', tool: 'fake.write', reason: 'could not be described' }],
    });

    const before = harness.seen.length;
    const outcome = await harness.replayer.replay({
      workflowId: saved.workflowId,
      sessionId: 'session_skill',
      inputs: {},
    });

    // Not a partial success. Running the subset would report having done
    // something the recording does not describe.
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('INCOMPLETE_RECORDING');
    expect(harness.seen).toHaveLength(before);
  });

  it('24. keeps the dropped steps on the record, not only in the save reply', async () => {
    const harness = buildWorkflowHarness({ tools: TOOLS });
    const definition = await recordOneWorkflow(harness);
    const saved = await harness.store.save({
      name: 'Read a page',
      description: 'A recording with a gap.',
      definition,
      recordedFromTaskId: 'task_skill_1',
      taintAtCapture: 'KNOWN_UNTAINTED',
      droppedSteps: [{ afterStepId: null, tool: 'fake.write', reason: 'could not be described' }],
    });

    // Read back out of storage, which is what a reviewer sees tomorrow.
    const reloaded = await harness.store.get(saved.workflowId);
    expect(reloaded?.droppedSteps).toEqual([
      { afterStepId: null, tool: 'fake.write', reason: 'could not be described' },
    ]);
    expect(isIncomplete(reloaded!)).toBe(true);
  });
});
