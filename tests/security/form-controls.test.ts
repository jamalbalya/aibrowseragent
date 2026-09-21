/**
 * @vitest-environment jsdom
 *
 * TEST-SECURITY-018 — form controls and their egress classification
 * (Stage 3 Wave B).
 *
 * A checkbox looks harmless next to a text field, which is exactly why it is
 * worth gating: "I agree to share my data" is one bit, and it is the bit that
 * matters. These tests hold that every control that writes a model-chosen
 * value into a page declares an egress, and that the declaration reaches the
 * gate rather than sitting on the tool as documentation.
 */
import { describe, expect, it, vi } from 'vitest';
import { performSetChecked } from '@/content/interaction-engine';
import { createBrowserTools } from '@/tools/browser/browser-tools';
import { authorizeEgress } from '@/security/egress/egress-gate';
import { ConsentStore } from '@/security/egress/consent';
import { addTaint, freshTaint } from '@/security/taint/taint-state';
import type { TaintSource } from '@/security/exfiltration/exfiltration-guard';
import type { ToolExecutionContext } from '@/tools/core/tool-types';
import { fakeDebugger } from '../fixtures/fake-debugger';

const privatePage: TaintSource = {
  sourceType: 'web_page',
  site: 'intranet.example',
  sensitivity: 'confidential',
};

// jsdom implements no layout, so the scroll call these helpers make has no
// implementation to reach.
Element.prototype.scrollIntoView = vi.fn();

function element(html: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host.firstElementChild!;
}

describe('checkbox and radio', () => {
  it('checks an unchecked checkbox', () => {
    const input = element('<input type="checkbox">');
    const result = performSetChecked(input, true);
    expect(result).toEqual({ checked: true, value: 'on', kind: 'checkbox' });
  });

  it('unchecks a checked checkbox', () => {
    const input = element('<input type="checkbox" checked>');
    expect(performSetChecked(input, false).checked).toBe(false);
  });

  it('is idempotent, because it sets a state rather than toggling one', () => {
    // A toggle has to be right about the current state to produce the intended
    // one; a model working from a stale snapshot would submit the opposite.
    const input = element('<input type="checkbox">');
    performSetChecked(input, true);
    expect(performSetChecked(input, true).checked).toBe(true);
  });

  it('selects a radio', () => {
    const input = element('<input type="radio" name="g" value="b">');
    expect(performSetChecked(input, true)).toEqual({ checked: true, value: 'b', kind: 'radio' });
  });

  it('refuses to clear a radio instead of pretending to', () => {
    // The group holds the value, so there is nothing to clear. Silently doing
    // nothing would report a state the form does not have.
    const input = element('<input type="radio" name="g" checked>');
    expect(() => performSetChecked(input, false)).toThrow(/cannot be cleared/i);
  });

  it('refuses a read-only control', () => {
    const input = element('<input type="checkbox" readonly>');
    expect(() => performSetChecked(input, true)).toThrow(/read-only/i);
  });

  it('refuses a control that is not a checkbox or radio', () => {
    expect(() => performSetChecked(element('<input type="text">'), true)).toThrow(
      /not a checkbox/i,
    );
    expect(() => performSetChecked(element('<select></select>'), true)).toThrow(/not an input/i);
  });

  it('reports failure when a handler blocks the change', () => {
    // Claiming success here would tell the model the form says something it
    // does not, which is worse than an error.
    const input = element('<input type="checkbox">') as HTMLInputElement;
    input.addEventListener('click', (event) => event.preventDefault());
    expect(() => performSetChecked(input, true)).toThrow(/did not change state/i);
  });

  it('fires input and change so page code sees a real interaction', () => {
    const input = element('<input type="checkbox">') as HTMLInputElement;
    const seen: string[] = [];
    input.addEventListener('input', () => seen.push('input'));
    input.addEventListener('change', () => seen.push('change'));
    performSetChecked(input, true);
    expect(seen).toContain('input');
    expect(seen).toContain('change');
  });

  it('keeps a radio group exclusive', () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<input type="radio" name="x" value="a" checked><input type="radio" name="x" value="b">';
    document.body.append(host);
    const [first, second] = [...host.querySelectorAll('input')] as HTMLInputElement[];

    performSetChecked(second!, true);
    expect(second!.checked).toBe(true);
    expect(first!.checked).toBe(false);
  });
});

describe('the tool declares an egress the gate can see', () => {
  const deps = {
    adapter: {
      getActiveTab: () => Promise.resolve({ id: 1, url: 'https://intranet.example/form' }),
      getTab: () => Promise.resolve({ id: 1, url: 'https://intranet.example/form' }),
      callContent: vi.fn(() => Promise.resolve({ checked: true, value: 'on', kind: 'checkbox' })),
      ensureContentScript: () => Promise.resolve(),
    },
    debuggerManager: fakeDebugger().manager,
  } as unknown as Parameters<typeof createBrowserTools>[0];

  const tools = createBrowserTools(deps);
  const setChecked = tools.find((t) => t.name === 'browser.set_checked')!;
  const select = tools.find((t) => t.name === 'browser.select')!;

  const context = {
    taskId: 'task_1',
    sessionId: 's',
    toolCallId: 'c',
    tabId: 1,
    currentUrl: 'https://intranet.example/form',
    signal: new AbortController().signal,
    recordEvidence: () => undefined,
  } as unknown as ToolExecutionContext;

  it('is registered', () => {
    expect(setChecked).toBeDefined();
  });

  it.each([
    [
      'browser.set_checked',
      () => setChecked.classify!({ elementId: 'e1', checked: true }, context),
    ],
    ['browser.select', () => select.classify!({ elementId: 'e1', value: 'medium' }, context)],
  ])('%s declares a page_write egress', (_name, classify) => {
    const declared = classify().egress;
    expect(declared).toBeDefined();
    expect(declared!.destination.channel).toBe('page_write');
    expect(declared!.destination.identity).toBe('https://intranet.example');
    expect(declared!.carrier?.writesValue).toBe(true);
  });

  it('is allowed when writing back to the site the data came from', () => {
    const declared = setChecked.classify!({ elementId: 'e1', checked: true }, context).egress!;
    const decision = authorizeEgress(
      {
        taskId: 'task_1',
        taintState: addTaint(freshTaint(), [privatePage]),
        taintSalt: 'ab'.repeat(32),
        destination: declared.destination,
        ...(declared.carrier === undefined ? {} : { carrierInput: declared.carrier }),
        payload: declared.payload,
        taintSignature: 'sig',
        now: 1,
      },
      { consent: new ConsentStore() },
    );
    expect(decision.verdict).toBe('allow');
  });

  it('requires consent when the same write goes to a different site', () => {
    const elsewhere = {
      ...context,
      currentUrl: 'https://pastebin.example/new',
    } as unknown as ToolExecutionContext;
    const declared = setChecked.classify!({ elementId: 'e1', checked: true }, elsewhere).egress!;

    const decision = authorizeEgress(
      {
        taskId: 'task_1',
        taintState: addTaint(freshTaint(), [privatePage]),
        taintSalt: 'ab'.repeat(32),
        destination: declared.destination,
        ...(declared.carrier === undefined ? {} : { carrierInput: declared.carrier }),
        payload: declared.payload,
        taintSignature: 'sig',
        now: 1,
      },
      { consent: new ConsentStore() },
    );
    expect(decision.verdict).toBe('confirm');
  });

  it('denies when the page origin cannot be determined', () => {
    // No current URL means no destination, and an undetermined destination is
    // refused rather than defaulted to the current page.
    const noUrl = { ...context, currentUrl: undefined } as unknown as ToolExecutionContext;
    const declared = setChecked.classify!({ elementId: 'e1', checked: true }, noUrl).egress!;
    expect(declared.destination.identity).toBeNull();

    const decision = authorizeEgress(
      {
        taskId: 'task_1',
        taintState: addTaint(freshTaint(), [privatePage]),
        taintSalt: 'ab'.repeat(32),
        destination: declared.destination,
        taintSignature: 'sig',
        now: 1,
      },
      { consent: new ConsentStore() },
    );
    expect(decision.verdict).toBe('deny');
    expect(decision.code).toBe('DESTINATION_UNKNOWN');
  });

  it('does not reach the page when the security context is unknown', () => {
    const declared = setChecked.classify!({ elementId: 'e1', checked: true }, context).egress!;
    const decision = authorizeEgress(
      {
        taskId: 'task_1',
        taintState: { kind: 'UNKNOWN', reason: 'malformed' },
        taintSalt: 'ab'.repeat(32),
        destination: declared.destination,
        taintSignature: 'sig',
        now: 1,
      },
      { consent: new ConsentStore() },
    );
    expect(decision.verdict).toBe('deny');
  });
});
