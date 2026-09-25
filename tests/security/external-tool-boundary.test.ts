/**
 * TEST-SECURITY-073 — the boundaries a future external tool will meet.
 *
 * Plugins (P-025) and MCP (P-026) are not implemented and are not being
 * implemented here. What this suite settles is the question that decides
 * whether they *can* be, later, without redesigning anything: does a tool that
 * did not ship in this build get adjudicated by the same gates as one that
 * did, or do connector and skill tools already enjoy some quieter path?
 *
 * It matters now rather than then because the answer is cheap to establish
 * today and expensive to retrofit. Every claim below is about the tools that
 * already come from outside the browser layer — connector tools and skill
 * tools — because they are the closest thing this build has to an external
 * tool, and whatever holds for them is what will hold for the next kind.
 *
 * The second half is the credential boundary (Part 6): the model must never
 * receive a provider key, an OAuth refresh token, a connector secret, a
 * password or a one-time code. That is asserted against the classification
 * tables and against what a tool can actually reach, not against intent.
 *
 * Groups:
 *   A. every tool declares what the gates need, with no default
 *   B. a plan cannot cover a tool that names no site
 *   C. the credential boundary
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { evaluatePolicy } from '@/policy/policy-engine';
import { emptySitePolicyState } from '@/policy/site-policy';
import { approvePlan, buildProposal } from '@/policy/plan-model';
import {
  DATA_CLASSIFICATION,
  EXPORT_PORTABILITY,
  K1_PROTECTION,
  PERSISTED_DATA_KINDS,
} from '@/storage/data-classification';
import { GitHubConnector, githubDescriptor } from '@/connectors/adapters/github';

const SRC_ROOT = resolve(import.meta.dirname, '../../src');

function walkSource(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walkSource(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    })
    .sort();
}

const plan = approvePlan(
  buildProposal({
    proposalId: 'p1',
    taskId: 'task_1',
    approachText: 'x',
    sites: ['example.com'],
    now: 1,
  }),
  'plan_1',
  2,
);

describe('TEST-SECURITY-073 group A: the declarations the gates need', () => {
  it('01 — `siteAuthorization` is required by the type, so a new tool cannot omit it', () => {
    // The property that makes a future external tool safe by construction: it
    // cannot be registered without answering whose site permission covers it.
    const types = readFileSync(join(SRC_ROOT, 'tools/core/tool-types.ts'), 'utf8');
    expect(types).toMatch(/readonly siteAuthorization: SiteAuthorizationScope;/);
    // Not optional, and with no default anywhere.
    expect(types).not.toMatch(/siteAuthorization\?:/);
  });

  it('02 — the tools that come from outside the browser layer declare it too', () => {
    const connector = new GitHubConnector({
      descriptor: githubDescriptor({
        redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/oauth',
      }),
      transport: { call: () => Promise.reject(new Error('not called')) },
      status: () => ({ state: 'UNCONFIGURED', reason: 'not_configured', scopes: [] }),
    } as never);
    const tools = connector.createTools();

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.siteAuthorization, tool.name).toBe('none');
      expect(typeof tool.risk, tool.name).toBe('string');
      expect(typeof tool.timeoutMs, tool.name).toBe('number');
    }
  });
});

describe('TEST-SECURITY-073 group B: a plan cannot cover a tool with no site', () => {
  it('03 — a `none`-scoped tool is never plan-covered, whatever the plan says', () => {
    // A connector call, a skill run and — later — a plugin or MCP tool have no
    // page and no destination, so they resolve no site scope. The plan clause
    // requires one, which is why an approved plan cannot quietly authorise a
    // class of tool the user was never shown a site for.
    const decision = evaluatePolicy(
      { tool: 'github.create_issue', taskId: 'task_1', risk: 'R2' },
      { mode: 'manual', sitePolicy: emptySitePolicyState(), planApproval: plan },
    );

    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
    expect(decision.code).not.toBe('PLAN_ALLOWED');
  });

  it('04 — and a page action on the approved site still is, so case 03 discriminates', () => {
    const decision = evaluatePolicy(
      {
        tool: 'browser.click',
        taskId: 'task_1',
        risk: 'R2',
        siteScope: 'https://example.com/page',
      },
      { mode: 'manual', sitePolicy: emptySitePolicyState(), planApproval: plan },
    );
    expect(decision.code).toBe('PLAN_ALLOWED');
  });

  it('05 — an R3 external-style tool is confirmed even with a covering plan', () => {
    const decision = evaluatePolicy(
      {
        tool: 'github.create_issue',
        taskId: 'task_1',
        risk: 'R3',
        siteScope: 'https://example.com/x',
      },
      { mode: 'skip', sitePolicy: emptySitePolicyState(), planApproval: plan },
    );
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
    expect(decision.code).toBe('RISK_REQUIRES_APPROVAL');
  });
});

describe('TEST-SECURITY-073 group C: the credential boundary', () => {
  it('06 — every credential kind stays local, and none of them is exportable', () => {
    // Two classes, and the distinction is the point: what is written down is
    // `SECRET_LOCAL_ONLY`, and what is never written down at all is
    // `NEVER_PERSISTED`. Neither travels.
    const stored = ['provider-credential', 'connector-token', 'aba-refresh-token'] as const;
    const transient = ['aba-access-token', 'oauth-transient'] as const;

    for (const kind of [...stored, ...transient]) {
      expect(PERSISTED_DATA_KINDS, kind).toContain(kind);
      expect(EXPORT_PORTABILITY[kind], kind).toBe('NOT_PORTABLE_BY_DESIGN');
    }
    for (const kind of stored) expect(DATA_CLASSIFICATION[kind], kind).toBe('SECRET_LOCAL_ONLY');
    for (const kind of transient) expect(DATA_CLASSIFICATION[kind], kind).toBe('NEVER_PERSISTED');
  });

  it('07 — and each is either encrypted at rest or held only in memory', () => {
    for (const kind of [
      'provider-credential',
      'connector-token',
      'aba-refresh-token',
      'aba-access-token',
      'oauth-transient',
    ] as const) {
      expect(['ENCRYPTED', 'MEMORY_ONLY'], kind).toContain(K1_PROTECTION[kind]);
    }
  });

  it('08 — no tool module can read a credential store', () => {
    // NEGATIVE CONTROL, and the one that matters for a future external tool:
    // a tool reaches a service through the guarded transport, which attaches
    // the header itself. Nothing on a tool path imports the vault or the
    // credential store, so there is no value for a tool to return into model
    // context.
    const reachable = walkSource(SRC_ROOT)
      .filter((file) => /\/tools\//.test(file))
      .filter((file) =>
        /token-vault|CredentialStore|credentialStore|refreshTokenForRefreshOnly/.test(
          readFileSync(file, 'utf8'),
        ),
      );
    expect(reachable.map((file) => file.slice(SRC_ROOT.length + 1))).toEqual([]);
  });

  it('09 — the vault exposes a header and never the token behind it', () => {
    const vault = readFileSync(join(SRC_ROOT, 'connectors/oauth/token-vault.ts'), 'utf8');
    // One accessor returns anything token-shaped, and its name says what it is
    // for. A general `getToken()` would be the shape this deliberately lacks.
    expect(vault).toMatch(/authorizationHeader\(/);
    expect(vault).toMatch(/refreshTokenForRefreshOnly\(/);
    expect(vault).not.toMatch(/\n {2}async getToken\(|\n {2}getAccessToken\(/);
  });

  it('10 — sensitive page fields are refused before a value is ever read', () => {
    // Part 6's other half: passwords and one-time codes are refused at the
    // write, so nothing needs to redact them out of model context afterwards
    // — they never enter it. Gate 1 owns the rule; this asserts it is still
    // the refusing kind rather than a confirmation.
    const sensitivity = readFileSync(join(SRC_ROOT, 'policy/field-sensitivity.ts'), 'utf8');
    expect(sensitivity).toMatch(/PASSWORD[\s\S]{0,400}REFUSE/);
    expect(sensitivity).toMatch(/OTP[\s\S]{0,400}REFUSE/);
  });
});
