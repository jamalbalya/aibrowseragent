/**
 * TEST-SECURITY-004 — Data exfiltration defence (REQ-SECURITY-004).
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateExfiltration,
  maxSensitivity,
  payloadContainsSecret,
  type TaintSource,
} from '@/security/exfiltration/exfiltration-guard';

const jiraTaint: TaintSource = {
  sourceType: 'jira',
  site: 'atlassian.net',
  sensitivity: 'confidential',
};

describe('payloadContainsSecret', () => {
  it('detects a credential-shaped string', () => {
    expect(
      payloadContainsSecret(`token is ${'sk-' + 'ant-api03-abcdefghijklmnopqrstuvwxyz01'}`),
    ).toBe(true);
  });

  it('detects a populated field under a sensitive key', () => {
    expect(payloadContainsSecret({ form: { password: 'hunter2' } })).toBe(true);
  });

  it('ignores an empty sensitive field', () => {
    expect(payloadContainsSecret({ password: '' })).toBe(false);
    expect(payloadContainsSecret({ token: null })).toBe(false);
  });

  it('finds a secret nested inside an array', () => {
    expect(payloadContainsSecret([{ nested: { apiKey: 'abc' } }])).toBe(true);
  });

  it('returns false for ordinary content', () => {
    expect(payloadContainsSecret({ title: 'Quarterly report', count: 3 })).toBe(false);
  });
});

describe('evaluateExfiltration', () => {
  it('blocks any payload containing a credential, whatever the destination', () => {
    const decision = evaluateExfiltration({
      destination: 'https://atlassian.net/api',
      payload: { comment: 'Bearer abc123def456ghi789jkl' },
      taint: [],
    });
    expect(decision.verdict).toBe('block');
    expect(decision.sensitivity).toBe('secret');
  });

  it('blocks a password heading to the site that owns it', () => {
    // Even a "legitimate" destination does not justify the agent relaying a
    // credential, because the agent has no way to know it is legitimate.
    const decision = evaluateExfiltration({
      destination: 'https://example.com/login',
      payload: { password: 'hunter2' },
      taint: [{ sourceType: 'web_page', site: 'example.com', sensitivity: 'internal' }],
    });
    expect(decision.verdict).toBe('block');
  });

  it('requires confirmation when confidential data crosses to another site', () => {
    const decision = evaluateExfiltration({
      destination: 'https://attacker.test/webhook',
      payload: { body: 'Internal roadmap details from PROJ-123' },
      taint: [jiraTaint],
    });
    expect(decision.verdict).toBe('confirm');
    expect(decision.matchedSources).toContain('jira');
    expect(decision.destinationSite).toBe('attacker.test');
  });

  it('allows confidential data returning to the site it came from', () => {
    const decision = evaluateExfiltration({
      destination: 'https://team.atlassian.net/rest/api/issue',
      payload: { comment: 'Updating the ticket.' },
      taint: [jiraTaint],
    });
    expect(decision.verdict).toBe('allow');
  });

  it('allows a write when nothing private has been read', () => {
    const decision = evaluateExfiltration({
      destination: 'https://example.com/search',
      payload: { query: 'weather' },
      taint: [{ sourceType: 'web_page', site: 'example.com', sensitivity: 'public' }],
    });
    expect(decision.verdict).toBe('allow');
  });

  it('confirms when the destination cannot be resolved to a site', () => {
    const decision = evaluateExfiltration({
      destination: '',
      payload: { body: 'internal notes' },
      taint: [jiraTaint],
    });
    expect(decision.verdict).toBe('confirm');
    expect(decision.destinationSite).toBeNull();
  });

  it('reports the highest sensitivity among all tainted sources', () => {
    const decision = evaluateExfiltration({
      destination: 'https://elsewhere.test',
      payload: { body: 'x' },
      taint: [
        { sourceType: 'web_page', site: 'a.test', sensitivity: 'internal' },
        { sourceType: 'jira', site: 'atlassian.net', sensitivity: 'confidential' },
      ],
    });
    expect(decision.verdict).toBe('confirm');
    expect(decision.sensitivity).toBe('confidential');
  });
});

describe('maxSensitivity', () => {
  it('orders the sensitivity ladder correctly', () => {
    expect(maxSensitivity('public', 'internal')).toBe('internal');
    expect(maxSensitivity('confidential', 'internal')).toBe('confidential');
    expect(maxSensitivity('secret', 'confidential')).toBe('secret');
  });
});
