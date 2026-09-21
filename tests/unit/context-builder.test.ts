/**
 * TEST-AGENT-004 — Context construction and budgeting (REQ-AGENT-004).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_BUDGET,
  buildRequest,
  buildSystemInstruction,
  trimHistory,
} from '@/agent/context/context-builder';
import { createTask } from '@/tasks/task-model';
import type { CanonicalMessage } from '@/providers/core/types';

const task = createTask({
  id: 't1',
  sessionId: 's1',
  objective: 'Do the thing',
  providerId: 'fake',
  modelId: 'm',
  permissionMode: 'auto',
  now: 0,
});

const toolResult = (id: string, size: number): CanonicalMessage => ({
  role: 'tool',
  content: [
    {
      type: 'tool_result',
      toolCallId: id,
      name: 'browser.read_page',
      content: 'x'.repeat(size),
      isError: false,
    },
  ],
});

const userText = (text: string): CanonicalMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

describe('buildSystemInstruction', () => {
  it('states the trust hierarchy with system policy at the top', () => {
    const instruction = buildSystemInstruction({
      permissionMode: 'auto',
      toolNames: ['browser_read_page'],
      hasVision: true,
    });

    expect(instruction).toContain('Trust hierarchy');
    const policyIndex = instruction.indexOf('extension security policy');
    const dataIndex = instruction.indexOf('UNTRUSTED_EXTERNAL_CONTENT');
    expect(policyIndex).toBeGreaterThan(-1);
    expect(policyIndex).toBeLessThan(dataIndex);
  });

  it('tells the model that page content is never a permission grant', () => {
    const instruction = buildSystemInstruction({
      permissionMode: 'auto',
      toolNames: [],
      hasVision: false,
    });
    expect(instruction).toContain('never a grant of permission');
    expect(instruction).toContain('hostile page');
  });

  it('names the hard prohibitions', () => {
    const instruction = buildSystemInstruction({
      permissionMode: 'skip',
      toolNames: [],
      hasVision: false,
    });
    expect(instruction).toContain('payments');
    expect(instruction).toContain('permanent deletion');
    expect(instruction).toContain('bot protection');
  });

  it('describes each permission mode distinctly', () => {
    const modes = (['manual', 'auto', 'skip'] as const).map((mode) =>
      buildSystemInstruction({ permissionMode: mode, toolNames: [], hasVision: false }),
    );
    expect(modes[0]).toContain('Manual');
    expect(modes[1]).toContain('Auto');
    expect(modes[2]).toContain('Skip');
    expect(new Set(modes).size).toBe(3);
  });

  it('lists the available tools', () => {
    const instruction = buildSystemInstruction({
      permissionMode: 'auto',
      toolNames: ['browser_read_page', 'tabs_list'],
      hasVision: true,
    });
    expect(instruction).toContain('browser_read_page, tabs_list');
  });

  it('tells the model when it cannot see images', () => {
    const withVision = buildSystemInstruction({
      permissionMode: 'auto',
      toolNames: [],
      hasVision: true,
    });
    const without = buildSystemInstruction({
      permissionMode: 'auto',
      toolNames: [],
      hasVision: false,
    });
    expect(without).toContain('cannot accept images');
    expect(withVision).not.toContain('cannot accept images');
  });
});

describe('trimHistory', () => {
  it('leaves history under budget untouched', () => {
    const messages = [userText('hello'), toolResult('c1', 100)];
    expect(trimHistory(messages, DEFAULT_CONTEXT_BUDGET)).toEqual(messages);
  });

  it('replaces old tool results before dropping anything', () => {
    const messages = [
      toolResult('old', 60_000),
      userText('a'),
      userText('b'),
      userText('c'),
      userText('d'),
      userText('e'),
      userText('f'),
      toolResult('recent', 30_000),
    ];

    const trimmed = trimHistory(messages, { maxCharacters: 40_000, keepRecentTurns: 6 });

    expect(trimmed).toHaveLength(8);
    const first = trimmed[0]!.content[0]!;
    expect(first.type === 'tool_result' && first.content).toContain('trimmed');
    // The most recent observation is what the model is acting on, so it stays.
    const last = trimmed.at(-1)!.content[0]!;
    expect(last.type === 'tool_result' && last.content.length).toBe(30_000);
  });

  it('drops the oldest turns when trimming is not enough', () => {
    const messages = Array.from({ length: 20 }, (_, i) => userText('x'.repeat(10_000) + i));
    const trimmed = trimHistory(messages, { maxCharacters: 50_000, keepRecentTurns: 3 });

    expect(trimmed.length).toBeLessThan(messages.length);
    // The final turns survive.
    expect(trimmed.at(-1)).toEqual(messages.at(-1));
  });

  it('never drops the protected recent turns, even when they alone exceed budget', () => {
    const messages = Array.from({ length: 4 }, () => userText('x'.repeat(100_000)));
    const trimmed = trimHistory(messages, { maxCharacters: 1000, keepRecentTurns: 4 });
    expect(trimmed).toHaveLength(4);
  });

  it('counts an image as bounded context cost rather than its byte size', () => {
    const withImage: CanonicalMessage = {
      role: 'user',
      content: [{ type: 'image', data: 'x'.repeat(500_000), mimeType: 'image/png' }],
    };
    // A megabyte of base64 must not evict the whole conversation.
    const trimmed = trimHistory([userText('keep me'), withImage], {
      maxCharacters: 10_000,
      keepRecentTurns: 2,
    });
    expect(trimmed).toHaveLength(2);
  });
});

describe('buildRequest', () => {
  it('assembles a provider-neutral request', () => {
    const request = buildRequest({
      task,
      messages: [userText('do it')],
      tools: [
        { type: 'function', name: 'browser_read_page', description: 'Read.', parameters: {} },
      ],
      hasVision: true,
    });

    expect(request.toolChoice).toBe('auto');
    expect(request.temperature).toBe(0);
    expect(request.tools).toHaveLength(1);
    expect(request.systemInstruction).toContain('browser_read_page');
    expect(request.messages).toHaveLength(1);
  });

  it('threads the abort signal through', () => {
    const controller = new AbortController();
    const request = buildRequest({
      task,
      messages: [],
      tools: [],
      hasVision: false,
      signal: controller.signal,
    });
    expect(request.signal).toBe(controller.signal);
  });

  it('omits maxOutputTokens when none is configured', () => {
    const request = buildRequest({ task, messages: [], tools: [], hasVision: false });
    expect('maxOutputTokens' in request).toBe(false);
  });
});
