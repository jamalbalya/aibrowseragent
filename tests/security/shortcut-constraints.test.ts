/**
 * TEST-SHORTCUT-003 — §50's `allowedTools` and `permissionProfile` (P-021).
 *
 * These two fields were recorded for several waves as a deliberate divergence:
 * "a named permission profile attached to a shortcut is a stored permission
 * with a name on it". That is true of exactly one reading of them — the
 * *authority* reading — and it was never checked against the others. This suite
 * pins the reading that was adopted instead, because it is the whole reason the
 * fields are safe to store:
 *
 * - `allowedTools` is a **narrowing**. It can only remove.
 * - `permissionProfile` is a **tightening**. It can only make a run stricter.
 *
 * Neither grants anything, and the cases below are written to fail if either
 * ever could. The dispatch cases go through a real `ToolRegistry` and the real
 * policy engine, because "the model is not offered the tool" is not a
 * constraint — the constraint is that the call is refused.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { createHarness, ScriptedPrompter } from '../fixtures/policy-harness';
import {
  MAX_SHORTCUT_ALLOWED_TOOLS,
  SHORTCUT_PERMISSION_PROFILES,
  SHORTCUT_PROFILE_MODE,
  assertShortcutSafe,
  isShortcutPermissionProfile,
  isUsableShortcut,
  normaliseAllowedTools,
} from '@/shortcuts/shortcut-model';
import { ShortcutStore } from '@/shortcuts/shortcut-store';
import { PERMISSION_MODES, strictestMode, type PermissionMode } from '@/policy/policy-engine';
import { TASK_FIELD_PORTABILITY } from '@/storage/record-portability';
import type { AgentTool } from '@/tools/core/tool-types';

const TASK = 'task-1';

function tool(name: string, risk: 'R0' | 'R2' = 'R2'): AgentTool {
  return {
    name,
    version: '1',
    description: name,
    inputSchema: z.object({}).strict(),
    risk,
    executionMode: 'immediate',
    siteAuthorization: 'none',
    sideEffects: [],
    timeoutMs: 1_000,
    idempotent: true,
    execute: () => Promise.resolve({ success: true, data: { ran: name } }),
  };
}

const ALL = [tool('alpha.one'), tool('beta.two'), tool('gamma.three')];

const dispatch = (harness: ReturnType<typeof createHarness>, name: string) =>
  harness.registry.dispatch({
    taskId: TASK,
    sessionId: 's',
    toolCallId: 'c1',
    name,
    arguments: {},
    signal: new AbortController().signal,
  });

describe('01 the narrowing removes, and can do nothing else', () => {
  it('refuses a dispatch for a tool outside the set', async () => {
    // The half that makes it a constraint. Narrowing what the model is offered
    // does nothing on its own: a model that saw the name in an earlier turn, or
    // guessed it, arrives here anyway.
    const harness = createHarness(ALL, {
      resolveAllowedTools: () => Promise.resolve(['alpha.one']),
    });
    const refused = await dispatch(harness, 'beta.two');
    expect(refused.envelope.status).toBe('error');
    expect(refused.envelope.error?.code).toBe('POLICY_BLOCKED');
    expect(refused.executed).toBe(false);
  });

  it('says the tool exists rather than pretending it does not', async () => {
    // `TOOL_NOT_FOUND` would be a lie the model could waste a turn on, and it
    // would report a restriction as a missing feature.
    const harness = createHarness(ALL, {
      resolveAllowedTools: () => Promise.resolve(['alpha.one']),
    });
    const refused = await dispatch(harness, 'beta.two');
    expect(refused.envelope.error?.message).toContain('restricted set of tools');
    expect(refused.envelope.retryable).toBe(false);
  });

  it('still runs a tool inside the set', async () => {
    const harness = createHarness(ALL, {
      mode: 'skip',
      resolveAllowedTools: () => Promise.resolve(['alpha.one']),
    });
    const ran = await dispatch(harness, 'alpha.one');
    expect(ran.envelope.status).toBe('success');
    expect(ran.executed).toBe(true);
  });

  it('cannot admit a tool the registry does not hold', async () => {
    // A narrowing that could name something into existence would be a grant.
    const harness = createHarness(ALL, {
      resolveAllowedTools: () => Promise.resolve(['alpha.one', 'invented.tool']),
    });
    const refused = await dispatch(harness, 'invented.tool');
    expect(refused.envelope.status).toBe('error');
    expect(refused.envelope.error?.code).toBe('TOOL_NOT_FOUND');
  });

  it('does not pre-approve what it admits', async () => {
    // The narrowed-to tool meets the same confirmation it would have met
    // without any narrowing. Being on the list is not being allowed.
    const prompter = new ScriptedPrompter();
    const harness = createHarness(ALL, {
      mode: 'manual',
      prompter,
      resolveAllowedTools: () => Promise.resolve(['alpha.one']),
    });
    await dispatch(harness, 'alpha.one');
    expect(prompter.seen).toHaveLength(1);
  });

  it('narrows a dispatch made under a composed tool call id, not only a top-level one', async () => {
    // The composition question. A skill step, and a workflow replay step, reach
    // the registry through the same dispatch as a model's own call, carrying the
    // run's `taskId` and a `toolCallId` composed from the parent's. The
    // narrowing is keyed on the task, so it has to hold for a step however deep
    // it is — otherwise a shortcut restricted to one tool could launch a skill
    // that used every tool, which is the restriction being bypassed by the very
    // mechanism it was set on.
    //
    // Asserted through a composed call id rather than by driving the runner,
    // because what would break this is the runner minting an id or a task of its
    // own, and this is the shape that would then arrive here.
    const harness = createHarness(ALL, {
      resolveAllowedTools: () => Promise.resolve(['alpha.one']),
    });

    const nested = await harness.registry.dispatch({
      taskId: TASK,
      sessionId: 's',
      toolCallId: 'c1.step-2.c9',
      name: 'beta.two',
      arguments: {},
      signal: new AbortController().signal,
    });
    expect(nested.envelope.status).toBe('error');
    expect(nested.envelope.error?.code).toBe('POLICY_BLOCKED');
    expect(nested.executed).toBe(false);

    // And the positive half, so this is not passing because every nested
    // dispatch fails.
    const allowed = await harness.registry.dispatch({
      taskId: TASK,
      sessionId: 's',
      toolCallId: 'c1.step-2.c10',
      name: 'alpha.one',
      arguments: {},
      signal: new AbortController().signal,
    });
    expect(allowed.executed).toBe(true);
  });

  it('is keyed on the task, so another task in the same session is unaffected', async () => {
    // A narrowing is one run's constraint. If it leaked across tasks it would be
    // a standing restriction nobody asked for; if the lookup ignored the task it
    // would be no restriction at all.
    const harness = createHarness(ALL, {
      mode: 'skip',
      resolveAllowedTools: (taskId) => Promise.resolve(taskId === TASK ? ['alpha.one'] : undefined),
    });

    const refused = await dispatch(harness, 'beta.two');
    expect(refused.executed).toBe(false);

    const other = await harness.registry.dispatch({
      taskId: 'task-2',
      sessionId: 's',
      toolCallId: 'c2',
      name: 'beta.two',
      arguments: {},
      signal: new AbortController().signal,
    });
    expect(other.executed).toBe(true);
  });

  it('treats an absent or empty list as no narrowing', async () => {
    for (const allowed of [undefined, []] as const) {
      const harness = createHarness(ALL, {
        mode: 'skip',
        resolveAllowedTools: () => Promise.resolve(allowed),
      });
      const ran = await dispatch(harness, 'gamma.three');
      expect(ran.envelope.status, String(allowed)).toBe('success');
    }
  });

  it('narrows what the model is offered as well, so a restricted run wastes no turns', () => {
    const harness = createHarness(ALL);
    expect(harness.registry.toCanonicalSchemas().map((s) => s.name)).toHaveLength(3);
    expect(harness.registry.toCanonicalSchemas(['alpha.one']).map((s) => s.name)).toEqual([
      'alpha_one',
    ]);
  });
});

describe('02 the profile tightens, and can do nothing else', () => {
  it('orders the modes by strictness rather than by declaration', () => {
    // `PERMISSION_MODES` is a declaration order. Relying on it would make a
    // reordering for display purposes silently change what a profile does.
    expect(strictestMode('manual', 'skip')).toBe('manual');
    expect(strictestMode('skip', 'manual')).toBe('manual');
    expect(strictestMode('auto', 'skip')).toBe('auto');
    expect(strictestMode('auto', 'manual')).toBe('manual');
    expect(strictestMode('skip', 'skip')).toBe('skip');
  });

  it('is idempotent and commutative, so the floor cannot depend on argument order', () => {
    for (const a of PERMISSION_MODES) {
      for (const b of PERMISSION_MODES) {
        expect(strictestMode(a, b), `${a}/${b}`).toBe(strictestMode(b, a));
      }
      expect(strictestMode(a, a)).toBe(a);
    }
  });

  it('can never return something looser than either input', () => {
    // The property the whole design rests on, asserted over every pair rather
    // than the pairs somebody thought of.
    const rank: Record<PermissionMode, number> = { manual: 2, auto: 1, skip: 0 };
    for (const a of PERMISSION_MODES) {
      for (const b of PERMISSION_MODES) {
        const result = strictestMode(a, b);
        expect(rank[result], `${a}/${b}`).toBeGreaterThanOrEqual(Math.max(rank[a], rank[b]));
      }
    }
  });

  it('names only profiles that tighten, and every one maps to a real mode', () => {
    expect(SHORTCUT_PERMISSION_PROFILES.length).toBeGreaterThan(0);
    for (const profile of SHORTCUT_PERMISSION_PROFILES) {
      const mode = SHORTCUT_PROFILE_MODE[profile];
      expect(PERMISSION_MODES).toContain(mode);
      // A profile that resolved to anything but the strictest mode would be a
      // profile capable of loosening some session.
      expect(strictestMode(mode, 'skip')).toBe(mode);
      expect(strictestMode(mode, 'auto')).toBe(mode);
      expect(strictestMode(mode, 'manual')).toBe('manual');
    }
  });

  it('refuses a profile name it does not implement', () => {
    // §50's own example value included. Ignoring an unrecognised profile would
    // leave a shortcut that reads as stricter than it is.
    for (const name of ['qa-default', 'permissive', '', 'skip', 42, null]) {
      expect(isShortcutPermissionProfile(name), String(name)).toBe(false);
    }
    expect(isShortcutPermissionProfile('confirm-each-action')).toBe(true);
  });
});

describe('03 what may be stored', () => {
  const store = () =>
    new ShortcutStore({ area: new SerializedStorageArea(new MemoryStorageArea()) });

  it('stores both narrowings on a shortcut', async () => {
    const created = await store().create(
      'qa',
      { kind: 'prompt', objective: 'check the page' },
      {
        allowedTools: ['browser.read_page'],
        permissionProfile: 'confirm-each-action',
      },
    );
    expect(created.allowedTools).toEqual(['browser.read_page']);
    expect(created.permissionProfile).toBe('confirm-each-action');
    expect(isUsableShortcut(created)).toBe(true);
  });

  it('drops an empty list rather than storing it, so "no narrowing" has one shape', async () => {
    const created = await store().create(
      'qa',
      { kind: 'prompt', objective: 'x' },
      {
        allowedTools: [],
      },
    );
    expect('allowedTools' in created).toBe(false);
  });

  it('is still refused a bare `tools` field, which is a definition', () => {
    // `allowedTools` is a reference to already-registered tools. `tools` is the
    // shape a definition arrives in, and it stays prohibited.
    expect(() => assertShortcutSafe({ tools: ['x'] })).toThrow();
    expect(() => assertShortcutSafe({ allowedTools: ['x'] })).not.toThrow();
    expect(() => assertShortcutSafe({ permissionProfile: 'confirm-each-action' })).not.toThrow();
  });

  it('refuses a name that could not be a tool', () => {
    for (const bad of [['a b'], ['a/b'], [''], ['x'.repeat(5) + '\u0000'], [42], 'not-a-list']) {
      expect(normaliseAllowedTools(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('accepts both a built-in and an MCP tool name', () => {
    const verdict = normaliseAllowedTools(['browser.click', 'mcp__docs__search']);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.tools).toEqual(['browser.click', 'mcp__docs__search']);
  });

  it('deduplicates rather than storing a name twice', () => {
    const verdict = normaliseAllowedTools(['a.b', 'a.b', ' a.b ']);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.tools).toEqual(['a.b']);
  });

  it('bounds how many tools a shortcut may name', () => {
    const many = Array.from({ length: MAX_SHORTCUT_ALLOWED_TOOLS + 1 }, (_, i) => `t.${i}`);
    expect(normaliseAllowedTools(many).ok).toBe(false);
  });
});

describe('04 neither field travels in an export', () => {
  it('classifies both as security sensitive', () => {
    // A narrowing can only reduce, so a file *carrying* one is not the danger.
    // A file **dropping** one is: the run would look like the one somebody
    // restricted and would not be, and the widening would be invisible.
    expect(TASK_FIELD_PORTABILITY.allowedTools).toBe('SECURITY_SENSITIVE');
    expect(TASK_FIELD_PORTABILITY.permissionFloor).toBe('SECURITY_SENSITIVE');
  });
});
