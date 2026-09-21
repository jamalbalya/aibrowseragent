/**
 * TEST-SECURITY-013 — adversarial egress authorization (B2 steps 5, 7, 8).
 *
 * Every unsafe case expects `deny` or `confirm`. A test that only asserts a
 * field exists proves nothing, so each case drives the gate and asserts the
 * verdict it produces.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { authorizeEgress } from '@/security/egress/egress-gate';
import { ConsentStore, taintSignature } from '@/security/egress/consent';
import { providerDestination, urlDestination, noEgress } from '@/security/egress/destination';
import { addTaint, freshTaint, unknownTaint, type TaintState } from '@/security/taint/taint-state';
import type { TaintSource } from '@/security/exfiltration/exfiltration-guard';

const SALT = 'cd'.repeat(32);
const NOW = 1_700_000_000_000;

const privatePage: TaintSource = {
  sourceType: 'web_page',
  site: 'intranet.example',
  sensitivity: 'confidential',
};
const otherPage: TaintSource = {
  sourceType: 'web_page',
  site: 'docs.example',
  sensitivity: 'confidential',
};

let consent: ConsentStore;
const gate = () => ({ consent });

function request(overrides: Record<string, unknown> = {}) {
  return {
    taskId: 'task_1',
    taintState: freshTaint(),
    taintSalt: SALT,
    destination: providerDestination('openai-compatible', 'https://api.example.com/v1', 'm'),
    taintSignature: 'sig',
    now: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  consent = new ConsentStore();
});

describe('fail-closed security context', () => {
  it('denies when provenance was never established', () => {
    const decision = authorizeEgress(
      request({ taintState: unknownTaint('legacy-record') }),
      gate(),
    );
    expect(decision.verdict).toBe('deny');
    expect(decision.code).toBe('SECURITY_CONTEXT_UNKNOWN');
  });

  it.each(['field-absent', 'malformed', 'persistence-failed', 'legacy-record'] as const)(
    'denies on UNKNOWN(%s) whatever the reason',
    (reason) => {
      expect(authorizeEgress(request({ taintState: unknownTaint(reason) }), gate()).verdict).toBe(
        'deny',
      );
    },
  );

  it('denies even when the destination is the task’s own provider', () => {
    // A recognisable destination must not rescue an unknowable payload.
    consent.pinProvider('task_1', 'openai-compatible@https://api.example.com');
    expect(
      authorizeEgress(request({ taintState: unknownTaint('malformed') }), gate()).verdict,
    ).toBe('deny');
  });

  it('denies when the evidence key is missing', () => {
    const decision = authorizeEgress(request({ taintSalt: '' }), gate());
    expect(decision.verdict).toBe('deny');
    expect(decision.code).toBe('SECURITY_CONTEXT_UNKNOWN');
  });

  it('denies an unidentifiable destination rather than falling back to the raw string', () => {
    const decision = authorizeEgress(
      request({ destination: urlDestination('navigation', 'not a url') }),
      gate(),
    );
    expect(decision.verdict).toBe('deny');
    expect(decision.code).toBe('DESTINATION_UNKNOWN');
  });

  it('denies when the taint signature could not be computed', () => {
    const tainted = addTaint(freshTaint(), [privatePage]);
    const decision = authorizeEgress(
      request({
        taintState: tainted,
        taintSignature: undefined,
        destination: urlDestination('navigation', 'https://elsewhere.example/?q=x'),
        carrierInput: { url: 'https://elsewhere.example/?q=x' },
      }),
      gate(),
    );
    expect(decision.verdict).toBe('deny');
  });
});

describe('credentials never leave', () => {
  it.each([
    ['an API key', 'sk-abcdefghijklmnopqrstuvwxyz012345678901234567'],
    ['a bearer token', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'],
    ['a named secret', '{"session_token":"abcdefghijklmnop"}'],
    ['a private key', '-----BEGIN RSA PRIVATE KEY-----\nabcd\n-----END RSA PRIVATE KEY-----'],
  ])('denies %s to the task’s own provider', (_label, payload) => {
    consent.pinProvider('task_1', 'openai-compatible@https://api.example.com');
    const decision = authorizeEgress(request({ payload }), gate());
    expect(decision.verdict).toBe('deny');
    expect(decision.code).toBe('SECRET_PAYLOAD');
  });

  it('names the rule so a false positive is distinguishable from a leak', () => {
    const decision = authorizeEgress(request({ payload: 'sk-' + 'a'.repeat(44) }), gate());
    expect(decision.reason).toMatch(/openai-key|named-secret|bearer/);
  });

  it('does not block an ordinary payload that merely contains digits', () => {
    // The card rule confirms with an issuer prefix and Luhn; shape alone used
    // to be enough here and blocked every request carrying a timestamp.
    const decision = authorizeEgress(
      request({ payload: JSON.stringify({ at: 1789992722527, id: 4483927465019283 }) }),
      gate(),
    );
    expect(decision.verdict).not.toBe('deny');
  });
});

describe('provider binding and switching', () => {
  it('allows the provider the task is bound to', () => {
    const decision = authorizeEgress(request(), gate());
    expect(decision.verdict).toBe('allow');
    expect(decision.code).toBe('PROVIDER_BOUND');
  });

  it('requires consent when the provider changes mid-task', () => {
    authorizeEgress(request(), gate());
    const decision = authorizeEgress(
      request({ destination: providerDestination('other-provider', 'https://api.other.com/v1') }),
      gate(),
    );
    expect(decision.verdict).toBe('confirm');
  });

  it('requires consent when the endpoint origin changes mid-task', () => {
    authorizeEgress(request(), gate());
    const decision = authorizeEgress(
      request({
        destination: providerDestination('openai-compatible', 'https://evil.example/v1', 'm'),
        taintState: addTaint(freshTaint(), [privatePage]),
      }),
      gate(),
    );
    expect(decision.verdict).toBe('confirm');
  });

  it('binds each task independently rather than sharing one binding', () => {
    // A second task starting on a different provider binds to its own; what
    // must not happen is one task's binding standing in for another's, so
    // that a later switch in either is measured against the wrong provider.
    authorizeEgress(request(), gate());
    authorizeEgress(
      request({
        taskId: 'task_2',
        destination: providerDestination('other', 'https://api.other.com/v1'),
      }),
      gate(),
    );

    expect(consent.pinnedProvider('task_1')).toBe('openai-compatible@https://api.example.com');
    expect(consent.pinnedProvider('task_2')).toBe('other@https://api.other.com');

    // And task_2 switching to task_1's provider is still a switch for task_2.
    const decision = authorizeEgress(
      request({ taskId: 'task_2', taintState: addTaint(freshTaint(), [privatePage]) }),
      gate(),
    );
    expect(decision.verdict).toBe('confirm');
  });

  it('treats a port change as a different destination', () => {
    authorizeEgress(request(), gate());
    const decision = authorizeEgress(
      request({
        destination: providerDestination('openai-compatible', 'https://api.example.com:8443/v1'),
        taintState: addTaint(freshTaint(), [privatePage]),
      }),
      gate(),
    );
    expect(decision.verdict).toBe('confirm');
  });
});

describe('browser action egress', () => {
  const tainted = addTaint(freshTaint(), [privatePage]);

  it('allows a navigation that carries nothing for a clean task', () => {
    const url = 'https://elsewhere.example/page';
    expect(
      authorizeEgress(
        request({
          destination: urlDestination('navigation', url),
          carrierInput: { url },
        }),
        gate(),
      ).verdict,
    ).toBe('allow');
  });

  it('requires consent for a tainted query parameter', () => {
    const url = 'https://elsewhere.example/search?q=secret-content';
    const decision = authorizeEgress(
      request({
        taintState: tainted,
        destination: urlDestination('navigation', url),
        carrierInput: { url },
      }),
      gate(),
    );
    expect(decision.verdict).toBe('confirm');
    expect(decision.carrier).toBe('high');
  });

  it('requires consent for a tainted fragment', () => {
    const url = 'https://elsewhere.example/page#leaked';
    expect(
      authorizeEgress(
        request({
          taintState: tainted,
          destination: urlDestination('navigation', url),
          carrierInput: { url },
        }),
        gate(),
      ).verdict,
    ).toBe('confirm');
  });

  it('requires consent for a cross-origin path that the page never showed', () => {
    const url = 'https://elsewhere.example/exfil/secret-content';
    expect(
      authorizeEgress(
        request({
          taintState: tainted,
          destination: urlDestination('navigation', url),
          carrierInput: { url, currentUrl: 'https://intranet.example/home' },
        }),
        gate(),
      ).verdict,
    ).toBe('confirm');
  });

  it('allows writing back to the site the data came from', () => {
    // Same-site: the origin already has this content, so the write conveys
    // nothing it does not hold.
    const decision = authorizeEgress(
      request({
        taintState: tainted,
        destination: urlDestination('page_write', 'https://intranet.example/form'),
        carrierInput: { writesValue: true },
      }),
      gate(),
    );
    expect(decision.verdict).toBe('allow');
  });

  it('requires consent for a page write to a different site', () => {
    expect(
      authorizeEgress(
        request({
          taintState: tainted,
          destination: urlDestination('page_write', 'https://pastebin.example/new'),
          carrierInput: { writesValue: true },
        }),
        gate(),
      ).verdict,
    ).toBe('confirm');
  });

  it('is not fooled by percent-encoding the tainted value', () => {
    // Task-level taint means no value is inspected, so encoding changes
    // nothing about the decision.
    const url = 'https://elsewhere.example/?q=%73%65%63%72%65%74';
    expect(
      authorizeEgress(
        request({
          taintState: tainted,
          destination: urlDestination('navigation', url),
          carrierInput: { url },
        }),
        gate(),
      ).verdict,
    ).toBe('confirm');
  });

  it('is not fooled by base64 or JSON wrapping', () => {
    const url = `https://elsewhere.example/?d=${btoa('secret')}`;
    expect(
      authorizeEgress(
        request({
          taintState: tainted,
          destination: urlDestination('navigation', url),
          carrierInput: { url },
        }),
        gate(),
      ).verdict,
    ).toBe('confirm');
  });

  it('grades an unparseable carrier as the strictest class', () => {
    const decision = authorizeEgress(
      request({
        taintState: tainted,
        destination: urlDestination('navigation', 'https://elsewhere.example/x'),
        carrierInput: { url: 'not a url' },
      }),
      gate(),
    );
    expect(decision.carrier).toBe('high');
  });

  it('grades a URL-bearing channel with no carrier input as the strictest class', () => {
    const decision = authorizeEgress(
      request({
        taintState: tainted,
        destination: urlDestination('navigation', 'https://elsewhere.example/x'),
      }),
      gate(),
    );
    expect(decision.carrier).toBe('high');
  });

  it('skips only the consent check for a link the page already showed', () => {
    const url = 'https://elsewhere.example/article';
    const decision = authorizeEgress(
      request({
        taintState: tainted,
        destination: urlDestination('navigation', url),
        carrierInput: { url, observedUrls: [url] },
      }),
      gate(),
    );
    expect(decision.carrier).toBe('none');
    expect(decision.verdict).toBe('allow');
    // The gate still resolved the destination and evaluated it.
    expect(decision.destinationIdentity).toBe('https://elsewhere.example');
  });
});

describe('carrier never authorises on its own', () => {
  const tainted = addTaint(freshTaint(), [privatePage]);

  it('denies an UNKNOWN context even for the safest carrier', () => {
    const url = 'https://elsewhere.example/article';
    expect(
      authorizeEgress(
        request({
          taintState: unknownTaint('malformed'),
          destination: urlDestination('navigation', url),
          carrierInput: { url, observedUrls: [url] },
        }),
        gate(),
      ).verdict,
    ).toBe('deny');
  });

  it('denies a credential payload even for the safest carrier', () => {
    const url = 'https://elsewhere.example/article';
    expect(
      authorizeEgress(
        request({
          taintState: tainted,
          destination: urlDestination('navigation', url),
          carrierInput: { url, observedUrls: [url] },
          payload: 'sk-' + 'b'.repeat(44),
        }),
        gate(),
      ).verdict,
    ).toBe('deny');
  });

  it('denies an unidentifiable destination even for the safest carrier', () => {
    expect(
      authorizeEgress(
        request({
          taintState: tainted,
          destination: urlDestination('navigation', 'javascript:void 0'),
          carrierInput: { url: 'x', observedUrls: ['x'] },
        }),
        gate(),
      ).verdict,
    ).toBe('deny');
  });
});

describe('declared non-egress', () => {
  it('records the assertion rather than skipping the gate', () => {
    const decision = authorizeEgress(request({ destination: noEgress() }), gate());
    expect(decision.verdict).toBe('allow');
    expect(decision.code).toBe('NOT_AN_EGRESS');
  });
});

describe('consent scope', () => {
  const tainted = addTaint(freshTaint(), [privatePage]);

  async function grantFor(state: TaintState, url: string) {
    const signature = await taintSignature(state);
    const decision = authorizeEgress(
      request({
        taintState: state,
        taintSignature: signature,
        destination: urlDestination('navigation', url),
        carrierInput: { url },
      }),
      gate(),
    );
    consent.grant(decision.consentKey!, NOW);
    return signature;
  }

  it('honours a grant for the same data and destination', async () => {
    const url = 'https://elsewhere.example/?q=1';
    const signature = await grantFor(tainted, url);
    const decision = authorizeEgress(
      request({
        taintState: tainted,
        taintSignature: signature,
        destination: urlDestination('navigation', url),
        carrierInput: { url },
      }),
      gate(),
    );
    expect(decision.verdict).toBe('allow');
    expect(decision.code).toBe('CONSENT_PRESENT');
  });

  it('voids the grant once the task reads something new', async () => {
    // The failure the taint signature exists to prevent: approve one page,
    // read a second, and reuse the approval.
    const url = 'https://elsewhere.example/?q=1';
    await grantFor(tainted, url);
    const grown = addTaint(tainted, [otherPage]);
    const decision = authorizeEgress(
      request({
        taintState: grown,
        taintSignature: await taintSignature(grown),
        destination: urlDestination('navigation', url),
        carrierInput: { url },
      }),
      gate(),
    );
    expect(decision.verdict).toBe('confirm');
  });

  it('does not carry a grant to another destination', async () => {
    const signature = await grantFor(tainted, 'https://elsewhere.example/?q=1');
    const other = 'https://other.example/?q=1';
    expect(
      authorizeEgress(
        request({
          taintState: tainted,
          taintSignature: signature,
          destination: urlDestination('navigation', other),
          carrierInput: { url: other },
        }),
        gate(),
      ).verdict,
    ).toBe('confirm');
  });

  it('does not carry a grant to another task', async () => {
    const url = 'https://elsewhere.example/?q=1';
    const signature = await grantFor(tainted, url);
    expect(
      authorizeEgress(
        request({
          taskId: 'task_2',
          taintState: tainted,
          taintSignature: signature,
          destination: urlDestination('navigation', url),
          carrierInput: { url },
        }),
        gate(),
      ).verdict,
    ).toBe('confirm');
  });

  it('does not carry a grant to another channel', async () => {
    const url = 'https://elsewhere.example/?q=1';
    const signature = await grantFor(tainted, url);
    expect(
      authorizeEgress(
        request({
          taintState: tainted,
          taintSignature: signature,
          destination: urlDestination('page_write', url),
          carrierInput: { writesValue: true },
        }),
        gate(),
      ).verdict,
    ).toBe('confirm');
  });

  it('stops honouring a grant after it expires', async () => {
    const url = 'https://elsewhere.example/?q=1';
    const signature = await grantFor(tainted, url);
    expect(
      authorizeEgress(
        request({
          taintState: tainted,
          taintSignature: signature,
          destination: urlDestination('navigation', url),
          carrierInput: { url },
          now: NOW + 60 * 60_000,
        }),
        gate(),
      ).verdict,
    ).toBe('confirm');
  });

  it('stops honouring a grant once revoked', async () => {
    const url = 'https://elsewhere.example/?q=1';
    const signature = await grantFor(tainted, url);
    consent.revokeTask('task_1');
    expect(
      authorizeEgress(
        request({
          taintState: tainted,
          taintSignature: signature,
          destination: urlDestination('navigation', url),
          carrierInput: { url },
        }),
        gate(),
      ).verdict,
    ).toBe('confirm');
  });

  it('drops a task’s provider binding when its grants are revoked', () => {
    authorizeEgress(request(), gate());
    expect(consent.pinnedProvider('task_1')).toBeDefined();
    consent.revokeTask('task_1');
    expect(consent.pinnedProvider('task_1')).toBeUndefined();
  });

  it('is unchanged by re-reading the same source', async () => {
    const url = 'https://elsewhere.example/?q=1';
    const signature = await grantFor(tainted, url);
    const again = addTaint(tainted, [privatePage]);
    expect(await taintSignature(again)).toBe(signature);
  });
});
