/**
 * TEST-AGENT-001 — Loop detection (REQ-AGENT-001).
 */
import { describe, expect, it } from 'vitest';
import { LoopDetector, hashArguments } from '@/agent/loop-detection/loop-detector';

/** Read-only tools (R0) report `mutating: false`, matching the runtime. */
const READ_ONLY = new Set(['browser.read_page', 'browser.scroll', 'tabs.list']);

const record = (tool: string, args: unknown, success = false, errorCode?: string) => ({
  tool,
  argsHash: hashArguments(args),
  success,
  ...(errorCode === undefined ? {} : { errorCode: errorCode as never }),
  timestamp: Date.now(),
  mutating: !READ_ONLY.has(tool),
});

describe('hashArguments', () => {
  it('is stable regardless of key order', () => {
    expect(hashArguments({ a: 1, b: 2 })).toBe(hashArguments({ b: 2, a: 1 }));
  });

  it('distinguishes different values', () => {
    expect(hashArguments({ a: 1 })).not.toBe(hashArguments({ a: 2 }));
  });

  it('distinguishes nested differences', () => {
    expect(hashArguments({ a: { b: 1 } })).not.toBe(hashArguments({ a: { b: 2 } }));
  });

  it('treats an absent key and an undefined value as equivalent', () => {
    expect(hashArguments({ a: 1, b: undefined })).toBe(hashArguments({ a: 1 }));
  });

  it('does not retain the argument content in the hash', () => {
    const hash = hashArguments({ secret: 'sk-ant-api03-abcdefghijklmnop' });
    expect(hash).not.toContain('sk-ant');
    expect(hash.length).toBeLessThan(16);
  });
});

describe('identical repetition', () => {
  it('fires after the same call produces the same outcome three times', () => {
    const detector = new LoopDetector();
    for (let i = 0; i < 2; i += 1) {
      detector.record(record('browser.click', { elementId: 'e1' }, true));
      expect(detector.check().detected).toBe(false);
    }
    detector.record(record('browser.click', { elementId: 'e1' }, true));

    const result = detector.check();
    expect(result.detected).toBe(true);
    expect(result.kind).toBe('identical_repetition');
    expect(result.tool).toBe('browser.click');
  });

  it('does not fire when the arguments differ', () => {
    const detector = new LoopDetector();
    for (const id of ['e1', 'e2', 'e3', 'e4']) {
      detector.record(record('browser.click', { elementId: id }, true));
    }
    expect(detector.check().detected).toBe(false);
  });
});

describe('repeated failure', () => {
  it('fires when the same call fails the same way three times, even interleaved', () => {
    const detector = new LoopDetector();
    detector.record(record('browser.click', { elementId: 'e1' }, false, 'ELEMENT_NOT_FOUND'));
    detector.record(record('browser.read_page', {}, true));
    detector.record(record('browser.click', { elementId: 'e1' }, false, 'ELEMENT_NOT_FOUND'));
    detector.record(record('browser.scroll', { direction: 'down' }, true));
    detector.record(record('browser.click', { elementId: 'e1' }, false, 'ELEMENT_NOT_FOUND'));

    const result = detector.check();
    expect(result.detected).toBe(true);
    expect(result.detail).toContain('ELEMENT_NOT_FOUND');
  });

  it('does not fire when the failure code changes', () => {
    const detector = new LoopDetector();
    detector.record(record('browser.click', { elementId: 'e1' }, false, 'ELEMENT_NOT_FOUND'));
    detector.record(record('browser.click', { elementId: 'e1' }, false, 'NAVIGATION_TIMEOUT'));
    detector.record(record('browser.click', { elementId: 'e1' }, false, 'PAGE_NOT_READY'));
    expect(detector.check().detected).toBe(false);
  });
});

describe('cycles', () => {
  it('detects an A/B alternation that never converges', () => {
    const detector = new LoopDetector({ identicalThreshold: 99, repeatedFailureThreshold: 99 });
    for (let i = 0; i < 3; i += 1) {
      detector.record(record('browser.navigate', { url: 'https://a.test' }, true));
      detector.record(record('browser.navigate', { url: 'https://b.test' }, true));
    }
    const result = detector.check();
    expect(result.detected).toBe(true);
    expect(result.kind).toBe('cycle');
  });

  it('does not classify a single repeated call as a cycle', () => {
    const detector = new LoopDetector({ identicalThreshold: 99, repeatedFailureThreshold: 99 });
    for (let i = 0; i < 6; i += 1) {
      detector.record(record('browser.click', { elementId: 'e1' }, true));
    }
    expect(detector.check().kind).not.toBe('cycle');
  });

  it('does not fire on genuine forward progress with repeated page reads', () => {
    // Re-reading the page after each action is required, because element
    // handles go stale. The detector must not treat that as a loop.
    const detector = new LoopDetector();
    detector.record(record('browser.read_page', {}, true));
    detector.record(record('browser.click', { elementId: 'e1' }, true));
    detector.record(record('browser.read_page', {}, true));
    detector.record(record('browser.type', { elementId: 'e2', text: 'x' }, true));
    detector.record(record('browser.read_page', {}, true));
    detector.record(record('browser.click', { elementId: 'e5' }, true));
    expect(detector.check().detected).toBe(false);
  });
});

describe('state-change reset', () => {
  it('a successful mutating call clears the repetition streak of other calls', () => {
    const detector = new LoopDetector({ identicalThreshold: 3 });
    detector.record(record('browser.read_page', {}, true));
    detector.record(record('browser.read_page', {}, true));
    detector.record(record('browser.click', { elementId: 'e1' }, true));
    detector.record(record('browser.read_page', {}, true));
    expect(detector.check().detected).toBe(false);
  });

  it('still catches a read repeated with nothing happening in between', () => {
    const detector = new LoopDetector({ identicalThreshold: 3 });
    for (let i = 0; i < 3; i += 1) detector.record(record('browser.read_page', {}, true));
    expect(detector.check().detected).toBe(true);
  });

  it('a failed mutating call does not reset the streak', () => {
    // A click that errored changed nothing, so it is no excuse to keep going.
    const detector = new LoopDetector({ identicalThreshold: 3, repeatedFailureThreshold: 99 });
    detector.record(record('browser.read_page', {}, true));
    detector.record(record('browser.click', { elementId: 'e1' }, false, 'ELEMENT_NOT_FOUND'));
    detector.record(record('browser.read_page', {}, true));
    detector.record(record('browser.click', { elementId: 'e1' }, false, 'ELEMENT_NOT_FOUND'));
    detector.record(record('browser.read_page', {}, true));
    expect(detector.check().detected).toBe(true);
  });
});

describe('window and reset', () => {
  it('forgets history beyond the window', () => {
    const detector = new LoopDetector({ windowSize: 3, identicalThreshold: 3 });
    detector.record(record('a', {}, true));
    detector.record(record('a', {}, true));
    detector.record(record('b', {}, true));
    detector.record(record('c', {}, true));
    // The two 'a' entries have aged out of the 3-entry window.
    expect(detector.check().detected).toBe(false);
  });

  it('clears on reset', () => {
    const detector = new LoopDetector();
    for (let i = 0; i < 3; i += 1) detector.record(record('a', {}, true));
    expect(detector.check().detected).toBe(true);
    detector.reset();
    expect(detector.check().detected).toBe(false);
  });
});
