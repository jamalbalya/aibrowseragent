/**
 * TEST-TOOL-001 — Tool registry enforcement (REQ-TOOL-001).
 *
 * The registry is the only path from model output to a real effect, so these
 * tests assert that each gate actually runs and that nothing skips them.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolError } from '@/types/result';
import type { AgentTool, ToolExecutionResult } from '@/tools/core/tool-types';
import { fromWireName, toWireName } from '@/tools/registry/tool-registry';
import { createHarness, ScriptedPrompter } from '../fixtures/policy-harness';

const echoInput = z.object({
  message: z.string().min(1),
  count: z.number().int().min(1).max(10).optional(),
});

function makeTool(
  overrides: Partial<AgentTool<typeof echoInput>> = {},
): AgentTool<typeof echoInput> {
  return {
    name: 'test.echo',
    version: '1.0.0',
    description: 'Echoes a message back.',
    inputSchema: echoInput,
    risk: 'R0',
    executionMode: 'immediate',
    sideEffects: [],
    timeoutMs: 1000,
    idempotent: true,
    execute: (input): Promise<ToolExecutionResult> =>
      Promise.resolve({ success: true, data: { echoed: input.message } }),
    ...overrides,
  };
}

const invocation = (overrides: Record<string, unknown> = {}) => ({
  toolCallId: 'tc_1',
  taskId: 'task_1',
  sessionId: 'session_1',
  name: 'test.echo',
  arguments: { message: 'hello' },
  signal: new AbortController().signal,
  ...overrides,
});

describe('name translation', () => {
  it('round-trips a canonical name through the provider wire format', () => {
    expect(toWireName('browser.read_page')).toBe('browser_read_page');
    expect(fromWireName('browser_read_page')).toBe('browser.read_page');
    expect(fromWireName('browser.read_page')).toBe('browser.read_page');
  });

  it('restores only the first separator, leaving the rest of the name intact', () => {
    expect(fromWireName('tabs_wait_for_navigation')).toBe('tabs.wait_for_navigation');
  });
});

describe('registration', () => {
  it('rejects a duplicate tool name', () => {
    const harness = createHarness([makeTool()]);
    expect(() => harness.registry.register(makeTool())).toThrow(/already registered/);
  });

  it('exposes JSON Schema derived from the Zod schema', () => {
    const harness = createHarness([makeTool()]);
    const [schema] = harness.registry.toCanonicalSchemas();
    expect(schema?.name).toBe('test_echo');
    expect(schema?.parameters).toMatchObject({
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    });
  });

  it('narrows the exposed surface when an allowlist is supplied', () => {
    const harness = createHarness([makeTool(), makeTool({ name: 'test.other' })]);
    const schemas = harness.registry.toCanonicalSchemas(['test.other']);
    expect(schemas.map((s) => s.name)).toEqual(['test_other']);
  });
});

describe('dispatch gates', () => {
  it('refuses an unknown tool without executing anything', async () => {
    const harness = createHarness([makeTool()]);
    const result = await harness.registry.dispatch(invocation({ name: 'does.not_exist' }));

    expect(result.envelope.status).toBe('error');
    expect(result.envelope.error?.code).toBe('TOOL_NOT_FOUND');
    expect(result.executed).toBe(false);
  });

  it('rejects arguments that fail schema validation', async () => {
    const execute = vi.fn();
    const harness = createHarness([makeTool({ execute })]);

    const result = await harness.registry.dispatch(
      invocation({ arguments: { message: '', count: 99 } }),
    );

    expect(result.envelope.status).toBe('error');
    expect(result.envelope.error?.code).toBe('INVALID_ARGUMENT');
    // The implementation must never see invalid input.
    expect(execute).not.toHaveBeenCalled();
  });

  it('names the offending field in the validation message', async () => {
    const harness = createHarness([makeTool()]);
    const result = await harness.registry.dispatch(invocation({ arguments: {} }));
    expect(result.envelope.error?.message).toContain('message');
  });

  it('does not execute when policy denies the call', async () => {
    const execute = vi.fn();
    const harness = createHarness([
      makeTool({
        execute,
        risk: 'R0',
        classify: () => ({ prohibited: ['financial_transaction'] }),
      }),
    ]);

    const result = await harness.registry.dispatch(invocation());

    expect(result.envelope.error?.code).toBe('POLICY_BLOCKED');
    expect(result.executed).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not execute when the user declines', async () => {
    const execute = vi.fn();
    const prompter = new ScriptedPrompter({ kind: 'deny' });
    const harness = createHarness([makeTool({ execute, risk: 'R2' })], { prompter, mode: 'auto' });

    const result = await harness.registry.dispatch(invocation());

    expect(result.envelope.error?.code).toBe('PERMISSION_DENIED');
    expect(execute).not.toHaveBeenCalled();
    expect(prompter.seen).toHaveLength(1);
  });

  it('executes once the user approves', async () => {
    const prompter = new ScriptedPrompter({ kind: 'approve_once' });
    const harness = createHarness([makeTool({ risk: 'R2' })], { prompter, mode: 'auto' });

    const result = await harness.registry.dispatch(invocation());

    expect(result.envelope.status).toBe('success');
    expect(result.envelope.result).toEqual({ echoed: 'hello' });
    expect(result.executed).toBe(true);
  });
});

describe('risk escalation', () => {
  it('applies the higher of the declared floor and the call classification', async () => {
    const prompter = new ScriptedPrompter({ kind: 'approve_once' });
    const harness = createHarness([makeTool({ risk: 'R1', classify: () => ({ risk: 'R3' }) })], {
      prompter,
      mode: 'skip',
    });

    const result = await harness.registry.dispatch(invocation());

    expect(result.risk).toBe('R3');
    // R3 always confirms, even in skip mode.
    expect(prompter.seen).toHaveLength(1);
  });

  it('never lets a classification lower the declared risk floor', async () => {
    const prompter = new ScriptedPrompter({ kind: 'approve_once' });
    const harness = createHarness([makeTool({ risk: 'R3', classify: () => ({ risk: 'R0' }) })], {
      prompter,
      mode: 'auto',
    });

    const result = await harness.registry.dispatch(invocation());

    expect(result.risk).toBe('R3');
    expect(prompter.seen).toHaveLength(1);
  });
});

describe('failure handling', () => {
  it('converts a ToolError into a structured envelope', async () => {
    const harness = createHarness([
      makeTool({
        execute: () => Promise.reject(new ToolError('ELEMENT_NOT_FOUND', 'No such element.')),
      }),
    ]);

    const result = await harness.registry.dispatch(invocation());

    expect(result.envelope.error?.code).toBe('ELEMENT_NOT_FOUND');
    expect(result.envelope.retryable).toBe(true);
    expect(result.executed).toBe(true);
  });

  it('withholds raw exception text from the model-facing message', async () => {
    const harness = createHarness([
      makeTool({
        execute: () => Promise.reject(new Error('SECRET_INTERNAL_PATH /home/user/.env')),
      }),
    ]);

    const result = await harness.registry.dispatch(invocation());

    expect(result.envelope.error?.code).toBe('INTERNAL_ERROR');
    expect(result.envelope.error?.message).not.toContain('SECRET_INTERNAL_PATH');
  });

  it('times out a tool that hangs', async () => {
    const harness = createHarness([
      makeTool({ timeoutMs: 20, execute: () => new Promise(() => undefined) }),
    ]);

    const result = await harness.registry.dispatch(invocation());

    expect(result.envelope.error?.code).toBe('TASK_TIMEOUT');
  });

  it('refuses to start when the task is already cancelled', async () => {
    const execute = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const harness = createHarness([makeTool({ execute })]);

    const result = await harness.registry.dispatch(invocation({ signal: controller.signal }));

    expect(result.envelope.error?.code).toBe('USER_CANCELLED');
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports a failure result that carries no error as an internal error', async () => {
    const harness = createHarness([
      makeTool({ execute: () => Promise.resolve({ success: false }) }),
    ]);
    const result = await harness.registry.dispatch(invocation());
    expect(result.envelope.error?.code).toBe('INTERNAL_ERROR');
  });
});

describe('result sanitisation', () => {
  it('redacts secrets from a tool result before it reaches the model', async () => {
    const harness = createHarness([
      makeTool({
        execute: () =>
          Promise.resolve({
            success: true,
            data: {
              page: 'Authorization: Bearer abc123def456ghi789jkl',
              config: { apiKey: 'sk-' + 'proj-abcdefghijklmnop1234567890' },
            },
          }),
      }),
    ]);

    const result = await harness.registry.dispatch(invocation());
    const serialised = JSON.stringify(result.envelope.result);

    expect(serialised).not.toContain('abc123def456ghi789jkl');
    expect(serialised).not.toContain('sk-' + 'proj-abcdefghijklmnop');
    expect(serialised).toContain('[REDACTED]');
  });

  it('redacts the summary shown in the permission prompt', async () => {
    const prompter = new ScriptedPrompter({ kind: 'approve_once' });
    const harness = createHarness([makeTool({ risk: 'R2' })], { prompter, mode: 'auto' });

    await harness.registry.dispatch(
      invocation({
        arguments: { message: `my key is ${'sk-' + 'ant-api03-abcdefghijklmnopqrstuvwx'}` },
      }),
    );

    expect(prompter.seen[0]?.summary).not.toContain('sk-' + 'ant-api03-abcdefghijklmnopqrstuvwx');
  });
});

describe('evidence and taint', () => {
  it('collects evidence recorded during execution', async () => {
    const harness = createHarness([
      makeTool({
        execute: (_input, context) => {
          context.recordEvidence(
            {
              id: 'ev_1',
              type: 'TEXT',
              taskId: context.taskId,
              sourceTool: 'test.echo',
              createdAt: 0,
              sensitivity: 'internal',
              trust: 'untrusted_external_content',
              label: 'Sample',
            },
            { content: 'sample', encoding: 'utf8', mimeType: 'text/plain' },
          );
          return Promise.resolve({ success: true, data: { ok: true } });
        },
      }),
    ]);

    const result = await harness.registry.dispatch(invocation());

    expect(result.evidence.map((e) => e.id)).toEqual(['ev_1']);
    expect(result.envelope.evidence).toEqual(['ev_1']);
  });

  it('propagates taint reported by a tool', async () => {
    const harness = createHarness([
      makeTool({
        execute: () =>
          Promise.resolve({
            success: true,
            data: {},
            taint: [{ sourceType: 'jira', site: 'atlassian.net', sensitivity: 'confidential' }],
          }),
      }),
    ]);

    const result = await harness.registry.dispatch(invocation());
    expect(result.taint[0]?.sourceType).toBe('jira');
  });
});
