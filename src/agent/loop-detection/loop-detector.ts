/**
 * Loop detection (specification sections 26, 59).
 *
 * Catches three distinct failure shapes:
 *  1. Identical repetition — same tool, same arguments, same outcome.
 *  2. Repeated failure — same tool + arguments failing with the same code,
 *     even if interleaved with other calls.
 *  3. Cyclic alternation — an A→B→A→B pattern that never converges.
 *
 * Arguments are hashed rather than stored so the detector never retains page
 * content or credentials.
 */
import type { ErrorCode } from '@/types/result';

export interface ExecutionRecord {
  readonly tool: string;
  /** Stable hash of the validated arguments. */
  readonly argsHash: string;
  readonly success: boolean;
  readonly errorCode?: ErrorCode;
  readonly timestamp: number;
  /**
   * True when the call changed page or external state (risk above R0).
   *
   * This is what separates a stuck agent from a working one. Re-reading a
   * page after every click is correct behaviour — element handles go stale —
   * so an identical read only counts as repetition when nothing happened in
   * between to justify it.
   */
  readonly mutating: boolean;
}

export interface LoopDetectorOptions {
  /** Identical (tool, args, outcome) occurrences tolerated. */
  readonly identicalThreshold?: number;
  /** Repeated (tool, args, errorCode) failures tolerated. */
  readonly repeatedFailureThreshold?: number;
  /** Times an alternating cycle may repeat. */
  readonly cycleThreshold?: number;
  /** How many recent records participate in detection. */
  readonly windowSize?: number;
}

export interface LoopDetection {
  readonly detected: boolean;
  readonly kind?: 'identical_repetition' | 'repeated_failure' | 'cycle';
  readonly detail?: string;
  readonly tool?: string;
}

/** Order-independent, stable hash of a tool's arguments. */
export function hashArguments(args: unknown): string {
  const canonical = canonicalise(args);
  let hash = 2166136261;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function signatureOf(record: ExecutionRecord): string {
  const outcome = record.success ? 'ok' : (record.errorCode ?? 'err');
  return `${record.tool}|${record.argsHash}|${outcome}`;
}

function canonicalise(value: unknown, depth = 0): string {
  if (depth > 10) return '"…"';
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalise(item, depth + 1)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v, depth + 1)}`);
  return `{${entries.join(',')}}`;
}

export class LoopDetector {
  private readonly history: ExecutionRecord[] = [];
  private readonly identicalThreshold: number;
  private readonly repeatedFailureThreshold: number;
  private readonly cycleThreshold: number;
  private readonly windowSize: number;

  constructor(options: LoopDetectorOptions = {}) {
    this.identicalThreshold = options.identicalThreshold ?? 3;
    this.repeatedFailureThreshold = options.repeatedFailureThreshold ?? 3;
    this.cycleThreshold = options.cycleThreshold ?? 3;
    this.windowSize = options.windowSize ?? 20;
  }

  record(entry: ExecutionRecord): void {
    this.history.push(entry);
    if (this.history.length > this.windowSize) {
      this.history.splice(0, this.history.length - this.windowSize);
    }
  }

  reset(): void {
    this.history.length = 0;
  }

  /**
   * Re-examines the window. Call after each `record`.
   *
   * Repeated failure is checked first: it is the more specific diagnosis and
   * names the error code the agent keeps hitting, which is what both the user
   * and the model need in order to change approach.
   */
  check(): LoopDetection {
    return (
      this.checkRepeatedFailure() ??
      this.checkIdentical() ??
      this.checkCycle() ?? { detected: false }
    );
  }

  /**
   * Identical repetition: the same call producing the same outcome with
   * nothing happening in between that could have changed the answer.
   *
   * A successful state-changing call resets the streaks of *other* calls,
   * because after a click the page genuinely may differ and re-reading it is
   * required — element handles go stale. Without this, the normal
   * read → act → read → act rhythm would be flagged as a loop and every
   * multi-step task would be killed at its third page read.
   *
   * The mutating call keeps its own streak, so a click that repeats with no
   * effect is still caught.
   */
  private checkIdentical(): LoopDetection | null {
    const counts = new Map<string, { count: number; tool: string }>();

    for (const record of this.history) {
      const key = signatureOf(record);

      if (record.mutating && record.success) {
        for (const other of [...counts.keys()]) {
          if (other !== key) counts.delete(other);
        }
      }

      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { count: 1, tool: record.tool });
    }

    for (const [, value] of counts) {
      if (value.count >= this.identicalThreshold) {
        return {
          detected: true,
          kind: 'identical_repetition',
          tool: value.tool,
          detail:
            `${value.tool} was called ${value.count} times with identical arguments and the ` +
            'same outcome, with nothing changing in between. Repeating it will not help.',
        };
      }
    }
    return null;
  }

  private checkRepeatedFailure(): LoopDetection | null {
    const counts = new Map<string, { count: number; tool: string; code: string }>();
    for (const record of this.history) {
      if (record.success) continue;
      const code = record.errorCode ?? 'UNKNOWN';
      const key = `${record.tool}|${record.argsHash}|${code}`;
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { count: 1, tool: record.tool, code });
    }
    for (const [, value] of counts) {
      if (value.count >= this.repeatedFailureThreshold) {
        return {
          detected: true,
          kind: 'repeated_failure',
          tool: value.tool,
          detail:
            `${value.tool} failed ${value.count} times with ${value.code} for the same target. ` +
            'A different approach is required.',
        };
      }
    }
    return null;
  }

  /** Detects an A,B,A,B,… alternation of distinct calls. */
  private checkCycle(): LoopDetection | null {
    const keys = this.history.map((r) => `${r.tool}|${r.argsHash}`);
    for (let period = 2; period <= 4; period += 1) {
      const needed = period * this.cycleThreshold;
      if (keys.length < needed) continue;
      const tail = keys.slice(-needed);
      const pattern = tail.slice(0, period);
      // A single repeated call is `identical_repetition`, not a cycle.
      if (new Set(pattern).size < 2) continue;

      let matches = true;
      for (let i = 0; i < tail.length; i += 1) {
        if (tail[i] !== pattern[i % period]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        const tools = [...new Set(this.history.slice(-needed).map((r) => r.tool))];
        return {
          detected: true,
          kind: 'cycle',
          ...(tools[0] === undefined ? {} : { tool: tools[0] }),
          detail:
            `A repeating cycle of ${tools.join(' → ')} ran ${this.cycleThreshold} times ` +
            'without making progress.',
        };
      }
    }
    return null;
  }
}
