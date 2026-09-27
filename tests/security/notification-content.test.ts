/**
 * TEST-SEC-071 — What may reach an operating-system notification, and who
 * may put it there (§53, "Do not place secrets in notifications").
 *
 * A notification is the only thing this extension produces that is rendered
 * outside every boundary it controls. It is drawn by the operating system, it
 * can sit in a notification centre long after the task is gone, and it is
 * visible to anyone who can see the screen — including someone who cannot see
 * the side panel. So its contents are a security question, and the answer has
 * to be enforced by the *signature* rather than by the care of each caller:
 * a function that is handed only a task id and a state has no path by which an
 * objective, a page, a model reply or a secret could reach the screen.
 *
 * These are source scans because that is the only way to prove a negative
 * about every call site at once. A runtime test can show that one call is
 * clean; it cannot show that no other call exists.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

/**
 * Source with comments removed.
 *
 * Earned the hard way in an earlier wave: a census that matched prose in a
 * comment passed while the code it described did not exist.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const NOTIFIER = withoutComments(read('src/notifications/notifier.ts'));
const WORKER = withoutComments(read('src/background/service-worker.ts'));

describe('the notifier cannot be handed anything page-derived', () => {
  it('takes a task id and a state, and nothing that could carry content', () => {
    // If this signature ever grows an objective, a summary or a result, the
    // guarantee below stops being structural and becomes a promise.
    expect(NOTIFIER).toContain('async taskFinished(taskId: string, state: TaskState)');
  });

  it('names no field that would carry a task objective or its result', () => {
    for (const field of ['objective', 'summary', 'result', 'steps', 'evidence', 'pageContent']) {
      expect(NOTIFIER.includes(field)).toBe(false);
    }
  });

  it('imports nothing from a provider, a page model or a connector response', () => {
    const imports = [...NOTIFIER.matchAll(/from '([^']+)'/g)].map((match) => match[1]!);
    for (const specifier of imports) {
      expect(specifier).not.toMatch(/providers|content|page|connectors\/adapters|agent\//);
    }
  });

  it('reaches the operating system through exactly one function', () => {
    // One place that calls `port.create` is what makes every rule above
    // unavoidable rather than merely usual.
    const calls = NOTIFIER.match(/this\.port\.create\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });
});

describe('who may announce a task ending', () => {
  it('is announced from exactly one place in the worker', () => {
    const calls = WORKER.match(/notifier\.taskFinished\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it('is announced from the task lifecycle rather than from any provider', () => {
    // Provider independence, and it is structural: the call sits in the
    // lifecycle observer, which every provider reaches identically because
    // none of them knows it exists.
    const providerSources = [
      'src/providers/adapters/anthropic.ts',
      'src/providers/adapters/gemini.ts',
      'src/providers/adapters/openai-compatible.ts',
    ];
    for (const path of providerSources) {
      expect(withoutComments(read(path))).not.toContain('notif');
    }
  });

  it('is passed the lifecycle event’s own state, not a computed one', () => {
    expect(WORKER).toContain('notifier.taskFinished(event.taskId, event.state)');
  });
});

describe('who may announce a disconnected provider', () => {
  it('names the provider with a build constant, never the account the user named', () => {
    // A display name is whatever the user typed — "OpenAI (work project)" —
    // and a notification is rendered by the operating system, outside every
    // boundary this extension controls, where it can sit in a notification
    // centre on a shared screen. The provider id is `openai`, `anthropic` or
    // `gemini`: a constant this build registered.
    const body = NOTIFIER.slice(NOTIFIER.indexOf('async providerDisconnected'));
    const method = body.slice(0, body.indexOf('providerReconnected'));
    expect(method).not.toContain('displayName');
    expect(method).not.toContain('statusReason');
    expect(method).not.toContain('baseUrl');
    expect(method).not.toMatch(/apiKey|keySuffix|token/);
  });

  it('is announced from the worker and never from a provider adapter', () => {
    // The same structural independence `taskFinished` has: an adapter reports
    // what one HTTP call did, and whether the brain is connected is a fact
    // about the installation.
    for (const path of [
      'src/providers/adapters/anthropic.ts',
      'src/providers/adapters/gemini.ts',
      'src/providers/adapters/openai-compatible.ts',
    ]) {
      expect(withoutComments(read(path))).not.toContain('providerDisconnected');
    }
    expect(WORKER).toContain('notifier.providerDisconnected(');
  });

  it('is dispatched without being awaited, so it cannot delay a failing task', () => {
    const calls = WORKER.match(/notifier\.providerDisconnected\(/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const _ of calls) void _;
    expect(WORKER).not.toMatch(/await notifier\.providerDisconnected\(/);
  });

  it('writes the account status before telling the user, so the panel agrees', () => {
    // A toast saying "disconnected" over a Settings page still showing
    // "connected" is worse than either on its own.
    const producer = WORKER.slice(WORKER.indexOf('async function noteProviderDisconnected'));
    const body = producer.slice(0, producer.indexOf('\n}\n'));
    expect(body.indexOf("status: 'disconnected'")).toBeLessThan(
      body.indexOf('notifier.providerDisconnected('),
    );
  });

  it('treats only a terminal authentication failure as a disconnect', () => {
    // A rate limit or a 503 is the provider being busy, not gone. Announcing
    // those as a disconnect would train the user to ignore the notice.
    expect(WORKER).toContain("event.errorCode === 'AUTH_EXPIRED'");
    expect(WORKER).not.toMatch(/errorCode === 'RATE_LIMITED'/);
    expect(WORKER).not.toMatch(/errorCode === 'NETWORK_ERROR'/);
  });
});

describe('a notification never becomes task authority', () => {
  it('is dispatched without being awaited, so it cannot delay a finished task', () => {
    expect(WORKER).toContain('void notifier.taskFinished(');
  });

  it('swallows a browser refusal inside the notifier rather than at each caller', () => {
    // Chrome refuses notifications outright when the user has blocked them at
    // the OS level. A task that finished has finished.
    expect(NOTIFIER).toMatch(/private async show[\s\S]{0,400}catch/);
  });
});
