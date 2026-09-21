/**
 * TEST-SECURITY-001 — Secret redaction (REQ-SECURITY-001).
 *
 * Verifies that credential-shaped values are removed before data reaches a
 * log, evidence store or model request.
 */
import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  isSensitiveFieldName,
  isSensitiveHeaderName,
  redact,
  redactHeaders,
  redactText,
  redactValue,
} from '@/security/redaction/secret-redactor';

/**
 * Credential-shaped fixtures, assembled at runtime.
 *
 * These are synthetic, but they match real token formats closely enough that a
 * literal in source trips secret scanners — including GitHub push protection,
 * which blocked an earlier version of this file. Concatenating the prefix keeps
 * the pattern under test intact while ensuring no scannable literal exists on
 * any single line.
 */
const fake = (prefix: string, body: string): string => prefix + body;

describe('redactText', () => {
  const cases: [string, string][] = [
    [
      'JWT',
      `token=${fake('eyJ', 'hbGciOiJIUzI1NiJ9')}.${fake('eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0')}.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk`,
    ],
    ['OpenAI key', `Use ${fake('sk-', 'proj-abcdefghijklmnop1234567890ABCDEF')} for auth`],
    ['Anthropic key', `key: ${fake('sk-', 'ant-api03-abcdefghijklmnopqrstuvwxyz012345')}`],
    ['Google key (39 chars)', fake('AIza', 'SyA1234567890abcdefghijklmnopqrstuv')],
    [
      'Google key (longer variant)',
      `key=${fake('AIza', 'SyA1234567890abcdefghijklmnopqrstuvwxyz')}`,
    ],
    ['GitHub token', fake('ghp', '_abcdefghijklmnopqrstuvwxyz0123456789')],
    ['Slack token', fake('xox', 'b-1234567890-abcdefghijklmnop')],
    ['AWS key id', fake('AKIA', 'IOSFODNN7EXAMPLE')],
    ['Stripe key', fake('sk', '_live_abcdefghijklmnopqrstuvwx')],
    ['bearer token', 'Authorization: Bearer abc123def456ghi789jkl'],
    ['basic auth', 'Authorization: Basic dXNlcjpwYXNzd29yZA=='],
    ['url userinfo', 'https://admin:hunter2@internal.example.com/api'],
    ['cookie header', 'Cookie: session_id=abc123; theme=dark'],
    ['password assignment', 'password = "correct horse battery staple"'],
    ['api_key assignment', 'api_key: 9f8e7d6c5b4a39281706'],
    ['credit card', 'Card 4111 1111 1111 1111 expires soon'],
  ];

  for (const [label, input] of cases) {
    it(`removes a ${label}`, () => {
      const { text, appliedRules } = redactText(input);
      expect(text).toContain(REDACTED);
      expect(appliedRules.length).toBeGreaterThan(0);
    });
  }

  it('leaves ordinary prose untouched', () => {
    const input = 'The submit button is disabled until the form is valid.';
    expect(redact(input)).toBe(input);
  });

  it('redacts a PEM private key block without leaking its body', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ';
    const input = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
    const output = redact(input);
    expect(output).not.toContain(body);
    expect(output).toContain(REDACTED);
  });

  it('is stable across repeated calls (global regex state is reset)', () => {
    const input = 'Bearer abc123def456ghi789jkl';
    const first = redact(input);
    const second = redact(input);
    const third = redact(input);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('does not reintroduce a secret when redacting already redacted text', () => {
    const once = redact('api_key=abcdef1234567890abcdef');
    expect(redact(once)).toBe(once);
  });
});

describe('redactHeaders', () => {
  it('removes the value of every sensitive header by name', () => {
    const output = redactHeaders({
      Authorization: 'Bearer secret-token-value',
      Cookie: 'sid=abc',
      'X-Api-Key': 'anything at all',
      'Content-Type': 'application/json',
    });
    expect(output.Authorization).toBe(REDACTED);
    expect(output.Cookie).toBe(REDACTED);
    expect(output['X-Api-Key']).toBe(REDACTED);
    expect(output['Content-Type']).toBe('application/json');
  });

  it('matches header names case-insensitively', () => {
    expect(isSensitiveHeaderName('AUTHORIZATION')).toBe(true);
    expect(isSensitiveHeaderName('authorization')).toBe(true);
    expect(isSensitiveHeaderName('  Cookie  ')).toBe(true);
    expect(isSensitiveHeaderName('accept')).toBe(false);
  });
});

describe('isSensitiveFieldName', () => {
  it('normalises separators and casing', () => {
    for (const name of ['api_key', 'apiKey', 'API-KEY', 'Api.Key']) {
      expect(isSensitiveFieldName(name)).toBe(true);
    }
    expect(isSensitiveFieldName('title')).toBe(false);
  });
});

describe('redactValue', () => {
  it('removes values under sensitive keys at any depth', () => {
    const output = redactValue({
      user: { name: 'Ada', password: 'hunter2' },
      config: { nested: { apiKey: 'abc' } },
      items: [{ token: 'xyz' }],
    }) as Record<string, any>;

    expect(output.user.name).toBe('Ada');
    expect(output.user.password).toBe(REDACTED);
    expect(output.config.nested.apiKey).toBe(REDACTED);
    expect(output.items[0].token).toBe(REDACTED);
  });

  it('redacts secret-shaped strings under non-sensitive keys', () => {
    const output = redactValue({ note: 'call with Bearer abc123def456ghi789' }) as Record<
      string,
      string
    >;
    expect(output.note).toContain(REDACTED);
  });

  it('breaks cycles instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    const output = redactValue(cyclic) as Record<string, unknown>;
    expect(output.self).toBe('[CIRCULAR]');
  });

  it('bounds recursion depth on a deeply nested object', () => {
    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 40; i += 1) deep = { child: deep };
    expect(() => redactValue(deep)).not.toThrow();
    expect(JSON.stringify(redactValue(deep))).toContain('[TRUNCATED]');
  });

  it('preserves non-string primitives', () => {
    const output = redactValue({ count: 42, ok: true, missing: null }) as Record<string, unknown>;
    expect(output).toEqual({ count: 42, ok: true, missing: null });
  });
});
