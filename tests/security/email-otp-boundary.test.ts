/**
 * TEST-SECURITY-063 — where the code is structurally prevented from
 * being.
 *
 * The flow suite proves that the code is not in a response, a log or a row
 * *for the paths it exercises*. These cases are about the paths nobody
 * exercised: a future route, a future store, a future log call. They assert
 * properties of the shipped source and of the shipped type surface, so that a
 * change which would make an exposure possible fails here rather than in
 * production.
 *
 * Source scanning is a weak instrument and is used only where the property is
 * genuinely about the code's shape. Everything that can be a behavioural
 * assertion is one, in the neighbouring suites.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DATA_CLASSIFICATION, EXPORT_PORTABILITY } from '../../src/storage/data-classification';
import {
  LOGGABLE_FIELDS,
  SCHEMA,
  FORBIDDEN_COLUMN_FRAGMENTS,
  MIGRATIONS,
} from '../../server/index';
import { PANEL_ROUTE_CLASSES } from '../../src/messaging/route-trust';

const ROOT = resolve(import.meta.dirname, '../..');

/**
 * A file with its comments removed.
 *
 * Every scan below is a claim about what the **code** does, and a prose
 * paragraph explaining why a thing is absent contains the very words that
 * prove it absent. Six of these cases failed on their own documentation the
 * first time they ran — `otp.ts` explains at length why there is no Argon2id,
 * `email-auth-service.ts` names punycode as an open question, and
 * `email-sign-in.ts` lists `chrome.storage` among the places a code is never
 * written. Loosening the terms would have made the cases weaker; stripping
 * the prose makes them mean what they say.
 *
 * String literals are left alone, because a URL or a key name in a literal is
 * code. The scanner therefore tracks quote state rather than deleting
 * everything after a `//`, which would eat the `//` in every `https://`.
 */
function codeOnly(text: string): string {
  let out = '';
  let index = 0;
  let quote: string | null = null;
  while (index < text.length) {
    const character = text[index] ?? '';
    const next = text[index + 1] ?? '';
    if (quote !== null) {
      out += character;
      if (character === '\\') {
        out += next;
        index += 2;
        continue;
      }
      if (character === quote) quote = null;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      out += character;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    if (character === '/' && next === '/') {
      const end = text.indexOf('\n', index);
      index = end < 0 ? text.length : end;
      continue;
    }
    out += character;
    index += 1;
  }
  return out;
}

/** The code of one repository file, comments removed. */
function code(relative: string): string {
  return codeOnly(readFileSync(resolve(ROOT, relative), 'utf8'));
}

/** Every production TypeScript file under a root, recursively. */
function sources(relative: string): { path: string; text: string }[] {
  const found: { path: string; text: string }[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
      found.push({ path: full.slice(ROOT.length + 1), text: readFileSync(full, 'utf8') });
    }
  };
  walk(resolve(ROOT, relative));
  return found;
}

describe('TEST-SECURITY-063 — the code has no durable home', () => {
  it('01 — no table in the schema holds an OTP, under any spelling', () => {
    for (const table of SCHEMA) {
      for (const column of table.columns) {
        const name = column.name.toLowerCase();
        for (const fragment of ['otp', 'one_time', 'onetime', 'passcode', 'verification_code']) {
          expect(name, `${table.name}.${column.name}`).not.toContain(fragment);
        }
      }
    }
  });

  it('02 — no migration creates a table or column for one', () => {
    const rendered = MIGRATIONS.map((migration) =>
      readFileSync(resolve(ROOT, 'server/migrations', migration.file), 'utf8'),
    )
      .join('\n')
      .toLowerCase();
    for (const fragment of ['otp', 'one_time_code', 'passcode', 'verification_code']) {
      expect(rendered, fragment).not.toContain(fragment);
    }
    // The forbidden-fragment list the schema already enforces stays enforced.
    expect(FORBIDDEN_COLUMN_FRAGMENTS.length).toBeGreaterThan(0);
  });

  it('03 — the transient store implements no serialisation of any kind', () => {
    const text = code('server/app/otp-challenge-store.ts');
    // A challenge that can be written out is a challenge that will be.
    for (const term of [
      'JSON.stringify',
      'JSON.parse',
      'toJSON',
      'writeFile',
      'localStorage',
      'chrome.storage',
      'INSERT',
      'MemoryStore',
      "from '../db/",
    ]) {
      expect(text.includes(term), term).toBe(false);
    }
  });

  it('04 — the `Store` port has no challenge-store method for OTP material', () => {
    const text = readFileSync(resolve(ROOT, 'server/db/store.ts'), 'utf8');
    for (const term of ['otp', 'Otp', 'OTP']) {
      expect(text.includes(term), term).toBe(false);
    }
  });

  it('05 — the only shape a caller receives has no code on it', () => {
    // `attempt` is the one operation that reads the code, and it returns a
    // `OtpChallengeView`. This asserts the view is built field by field and
    // that `code` is not one of them — a spread of the whole challenge would
    // have carried it, silently, into every success response.
    const store = code('server/app/otp-challenge-store.ts');
    const view = /function view\(challenge: OtpChallenge\): OtpChallengeView \{([\s\S]*?)\n\}/.exec(
      store,
    );
    expect(view, 'the view builder').not.toBeNull();
    expect(view?.[1]).not.toContain('code');
    expect(view?.[1]).not.toContain('...challenge');

    // And the service, which is the only caller, never reads `.code` off a
    // challenge at all: it takes the address and nothing else.
    const service = code('server/app/email-auth-service.ts');
    expect(service).toContain('attempt.challenge.email');
    expect(service).not.toContain('attempt.challenge.code');
    expect(service).not.toContain('challenge.code');
  });

  it('05b — minting and comparing a code each have exactly one call site', () => {
    // An earlier draft of this case scanned for `code: string`, which matched
    // error codes, status codes and country codes in a dozen unrelated files.
    // The property worth pinning is narrower and sharper: the two primitives
    // that create and check an OTP are each reachable from one place, so a
    // second generator or a second comparison cannot appear unnoticed.
    const callers = (symbol: string): string[] =>
      [...sources('server'), ...sources('src')]
        .filter(
          ({ path, text }) =>
            !path.endsWith('server/app/otp.ts') && codeOnly(text).includes(`${symbol}(`),
        )
        .map(({ path }) => path);

    expect(callers('newOtpCode')).toEqual(['server/app/email-auth-service.ts']);
    expect(callers('otpMatches')).toEqual(['server/app/otp-challenge-store.ts']);
  });

  it('06 — the client never writes the code to storage', () => {
    const text = code('src/identity/email-sign-in.ts');
    for (const term of ['chrome.storage', 'sessions.write', 'area.set', 'localStorage']) {
      expect(text.includes(term), term).toBe(false);
    }
    // And the controller writes a session, never a code.
    const controller = code('src/identity/auth-controller.ts');
    expect(controller).not.toMatch(/write\w*\(\s*\{[^}]*\bcode\b/);
  });

  it('07 — the panel keeps the code in component state and nowhere else', () => {
    const text = code('src/sidepanel/components/AccountPanel.tsx');
    expect(text).toContain("const [code, setCode] = useState('')");
    for (const term of ['localStorage', 'sessionStorage', 'chrome.storage', 'document.cookie']) {
      expect(text.includes(term), term).toBe(false);
    }
  });
});

describe('TEST-SECURITY-063 — the code has no channel out', () => {
  it('08 — no loggable field could carry a code or an address', () => {
    for (const field of LOGGABLE_FIELDS) {
      const name = field.toLowerCase();
      for (const fragment of ['otp', 'code', 'secret', 'token', 'password']) {
        // `errorCode` is the deliberate exception, and it exists precisely so
        // that a bare `code` field never does.
        if (field === 'errorCode') continue;
        expect(name, field).not.toContain(fragment);
      }
    }
    // The address is not loggable; the domain is.
    expect(LOGGABLE_FIELDS).not.toContain('email');
    expect(LOGGABLE_FIELDS).toContain('emailDomain');
  });

  it('09 — the OTP routes are panel control plane, unreachable by a model', () => {
    expect(PANEL_ROUTE_CLASSES['auth.startEmailSignIn']).toBe('CLASS_B_PANEL_CONTROL_PLANE');
    expect(PANEL_ROUTE_CLASSES['auth.verifyEmailSignIn']).toBe('CLASS_B_PANEL_CONTROL_PLANE');
  });

  it('10 — no tool, skill or workflow names an auth route', () => {
    for (const { path, text } of [
      ...sources('src/tools'),
      ...sources('src/skills'),
      ...sources('src/workflows'),
    ]) {
      for (const route of [
        'auth.startEmailSignIn',
        'auth.verifyEmailSignIn',
        'auth.signInWithGoogle',
      ]) {
        expect(text.includes(route), `${path}: ${route}`).toBe(false);
      }
    }
  });

  it('11 — the transport is the only path out, and it takes a pinned origin', () => {
    const text = code('src/identity/email-sign-in.ts');
    // No fetch, no XHR, no URL built from anything the caller supplied.
    for (const term of ['fetch(', 'XMLHttpRequest', 'new URL(', 'https://']) {
      expect(text.includes(term), term).toBe(false);
    }
    expect(text).toContain('IDENTITY_PATHS.emailStart');
    expect(text).toContain('IDENTITY_PATHS.emailVerify');
  });

  it('12 — an OTP has no classification entry, because it is never stored', () => {
    // Both tables are total over the keys they classify. A key for an OTP
    // appearing in either would mean something had decided to store one.
    for (const key of Object.keys(DATA_CLASSIFICATION)) {
      expect(key.toLowerCase(), key).not.toContain('otp');
    }
    for (const key of Object.keys(EXPORT_PORTABILITY)) {
      expect(key.toLowerCase(), key).not.toContain('otp');
    }
  });
});

describe('TEST-SECURITY-063 — one authentication architecture', () => {
  it('13 — email sign-in creates no second session, device or principal path', () => {
    const text = code('server/app/email-auth-service.ts');
    // Sessions come from `SessionService`, principals from session
    // verification, devices from `DeviceService`. Nothing is minted here.
    expect(text).toContain('this.options.sessions.createSession');
    expect(text).toContain('this.options.sessions.verify(sessionId)');
    expect(text).toContain('this.options.devices.registerDevice(principal.value');
    for (const term of [
      'newSessionId',
      'newRefreshToken',
      '__brand',
      'insertSession',
      'insertDevice',
    ]) {
      expect(text.includes(term), term).toBe(false);
    }
  });

  it('14 — identities are attached through IdentityService, never written directly', () => {
    const text = code('server/app/email-auth-service.ts');
    expect(text).toContain('this.options.identities.attachIdentity');
    expect(text.includes('insertIdentity')).toBe(false);
  });

  it('15 — canonicalisation is normaliseEmail and nothing else', () => {
    const text = code('server/app/email-auth-service.ts');
    expect(text).toContain('normaliseEmail');
    // No provider-specific rewriting, and no Unicode normalisation.
    for (const term of [
      'normalize(',
      'NFKC',
      'NFC',
      'replace(/\\./g',
      'gmail.com',
      'punycode',
      'toASCII',
    ]) {
      expect(text.includes(term), term).toBe(false);
    }
    // And the client does not pre-normalise either, which would be a second
    // place the rule lived.
    const client = code('src/identity/email-sign-in.ts');
    for (const term of ['toLowerCase', 'normalize(', 'replace(/\\./g']) {
      expect(client.includes(term), term).toBe(false);
    }
  });

  it('16 — no OTP digest is computed or stored anywhere', () => {
    // A digest of a six-digit code is not a defence — the space falls in a
    // second — so there deliberately is none. Its absence is the design.
    for (const file of [
      'server/app/otp.ts',
      'server/app/otp-challenge-store.ts',
      'server/app/email-auth-service.ts',
    ]) {
      const text = code(file);
      for (const term of ['digest.compute', 'sha256Digest', 'argon', 'pbkdf2', 'subtle.digest']) {
        expect(text.toLowerCase().includes(term.toLowerCase()), `${file}: ${term}`).toBe(false);
      }
    }
  });

  it('17 — production code contains no mail-provider credential', () => {
    for (const { path, text } of sources('server')) {
      for (const pattern of [
        /SG\.[A-Za-z0-9_-]{20,}/,
        /(?:smtp|mail)[_.]?(?:password|secret|api[_-]?key)\s*[:=]\s*['"][^'"]+['"]/i,
        /postmark|sendgrid|mailgun|ses_secret/i,
      ]) {
        const found = pattern.exec(text);
        if (found !== null) expect(found[0], path).toBe('');
      }
    }
  });
});
