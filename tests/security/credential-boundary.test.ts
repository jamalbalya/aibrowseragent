/**
 * TEST-SECURITY-059 — the credential access matrix, as a checkable property.
 *
 * K1 added an encryption layer in front of the credential store, and the
 * question this suite exists to answer is whether it also added a *second way
 * to reach a credential*. The answer has to come from the code rather than
 * from the design note, so these cases read the sources and assert the shape
 * of the data flow.
 *
 * The matrix the audit produced:
 *
 * | Component                    | Reads a credential? | Why | Output boundary |
 * | ---------------------------- | ------------------- | --- | --------------- |
 * | `resolveFromAccount`         | **yes** | the one runtime path that executes a user-selected provider | hands it to `adapter.connect`, returns an adapter and never the key |
 * | `resolveProvider` (fallback) | **yes** | the pre-account path for an unmigrated installation | same |
 * | `accounts.connect`           | **yes** (writes) | stores what the user typed | writes to the credential store only |
 * | `runLegacyMigration`         | **yes** | moves a key between two storage schemes | writes to the credential store only |
 * | K1 protect / unprotect       | **yes** | converts a record between plaintext and ciphertext in place | writes back to the same key |
 * | `AccountStore.remove`        | clears only | disconnection deletes the key | no read |
 * | everything else              | **no**  | — | — |
 *
 * "Everything else" is the claim worth testing, because it is the one that
 * decays: sidepanel, audit, evidence, export, import, tools, workflows,
 * shortcuts, task records, workspaces, diagnostics.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../src/', import.meta.url).pathname;

function sourcesUnder(directory: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push({ file: full, text: readFileSync(full, 'utf8') });
    }
  };
  walk(join(ROOT, directory));
  return out;
}

/** Source with comments stripped, so prose about a name is not a use of it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** The methods that return or accept a plaintext credential. */
const CREDENTIAL_ACCESSORS = [
  'getApiKey',
  'setApiKey',
  'getConnectionKey',
  'setConnectionKey',
] as const;

describe('TEST-SECURITY-059 — credential access matrix', () => {
  it('01 — only the service worker can reach the credential store at all', () => {
    // The strongest form of the matrix: not "these callers behave", but
    // "there is one file that can call it". A credential path added anywhere
    // else fails here before anybody has to reason about what it does with it.
    const offenders: string[] = [];
    for (const directory of [
      'sidepanel',
      'audit',
      'evidence',
      'tools',
      'workflows',
      'shortcuts',
      'tasks',
      'workspaces',
      'skills',
      'agent',
      'messaging',
      'policy',
      'storage',
      'security',
    ]) {
      let sources: { file: string; text: string }[];
      try {
        sources = sourcesUnder(directory);
      } catch {
        continue; // a directory this build does not have
      }
      for (const { file, text } of sources) {
        const body = code(text);
        for (const accessor of CREDENTIAL_ACCESSORS) {
          if (body.includes(`.${accessor}(`)) offenders.push(`${file} → ${accessor}`);
        }
        if (body.includes('CredentialStore')) offenders.push(`${file} → CredentialStore`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('02 — the panel never reads a credential back, only sends one it was typed', () => {
    // Method-call form, not the bare identifier. The panel legitimately has a
    // `setApiKey` — it is the React state setter behind the password field,
    // and the value moves one way: the user types it, `accounts.connect`
    // takes it, and the component clears it. Matching the identifier flagged
    // that as a leak, which it is not; what would be a leak is the panel
    // *calling* a credential accessor on a store.
    for (const { file, text } of sourcesUnder('sidepanel')) {
      const body = code(text);
      for (const accessor of CREDENTIAL_ACCESSORS) {
        expect(body, `${file} calls .${accessor}()`).not.toContain(`.${accessor}(`);
      }
      expect(body, `${file} references the credential store`).not.toContain('credentialStore');
      expect(body, `${file} reads a stored key`).not.toContain('CredentialStore');
    }
    // And the one place it does hold a key, it lets go of it: the field is
    // cleared once the worker has taken it.
    const settings = code(
      readFileSync(join(ROOT, 'sidepanel/components/SettingsView.tsx'), 'utf8'),
    );
    expect(settings).toContain("setApiKey('')");
  });

  it('03 — no route response type carries a credential field', () => {
    // The protocol is the contract for what crosses to the panel. A response
    // shape with an `apiKey` in it would be a leak declared in the type
    // system — the easiest kind to introduce and the easiest to catch.
    //
    // Each response is read by matching braces rather than by a fixed window:
    // a window ran past the end of one declaration into the *request* of the
    // next, where `apiKey` is correct, and reported it as a response field.
    const protocol = code(readFileSync(join(ROOT, 'messaging/protocol.ts'), 'utf8'));
    const declarations: string[] = [];
    for (let index = protocol.indexOf('response:'); index !== -1;) {
      const open = protocol.indexOf('{', index);
      const semicolon = protocol.indexOf(';', index);
      if (open === -1 || (semicolon !== -1 && semicolon < open)) {
        declarations.push(protocol.slice(index, semicolon === -1 ? index + 200 : semicolon));
      } else {
        let depth = 0;
        let end = open;
        for (; end < protocol.length; end += 1) {
          if (protocol[end] === '{') depth += 1;
          else if (protocol[end] === '}' && (depth -= 1) === 0) break;
        }
        declarations.push(protocol.slice(index, end + 1));
      }
      index = protocol.indexOf('response:', index + 1);
    }

    expect(declarations.length).toBeGreaterThan(40);
    for (const declaration of declarations) {
      for (const forbidden of ['apiKey', 'api_key', 'accessToken', 'refreshToken', 'passphrase']) {
        expect(declaration, `a response declares ${forbidden}`).not.toContain(forbidden);
      }
    }
    // `accounts.connect` takes a key as *input*, which is the one direction
    // that is correct — so the sweep above is not vacuous for lack of any
    // `apiKey` in the file at all.
    expect(protocol).toContain('apiKey: string');
  });

  it('04 — the account view the panel receives has no credential field', () => {
    const worker = code(readFileSync(join(ROOT, 'background/service-worker.ts'), 'utf8'));
    const start = worker.indexOf('function accountView(');
    expect(start).toBeGreaterThan(-1);
    const body = worker.slice(start, worker.indexOf('\n}', start));

    for (const forbidden of ['apiKey', 'getConnectionKey', 'credentialStore']) {
      expect(body, `accountView must not touch ${forbidden}`).not.toContain(forbidden);
    }
    // It does carry the label, which is a host plus four characters — the
    // export strips even that, and the panel is allowed to show it.
    expect(body).toContain('accountLabel');
  });

  it('05 — the export builder reads no credential', () => {
    const worker = code(readFileSync(join(ROOT, 'background/service-worker.ts'), 'utf8'));
    const start = worker.indexOf("router.on('data.export'");
    const body = worker.slice(start, start + 1500);

    for (const accessor of CREDENTIAL_ACCESSORS) {
      expect(body, `data.export must not call ${accessor}`).not.toContain(accessor);
    }
  });

  it('06 — the import handler writes no credential and selects no brain', () => {
    const worker = code(readFileSync(join(ROOT, 'background/service-worker.ts'), 'utf8'));
    const start = worker.indexOf("router.on('data.import'");
    const body = worker.slice(start, worker.indexOf('router.on(', start + 10));

    for (const forbidden of [...CREDENTIAL_ACCESSORS, 'setBrain', 'k1.', 'unlock']) {
      expect(body, `data.import must not use ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('07 — a provider error body cannot carry a credential into a stored record', () => {
    // The defect this phase found. A provider's 401 body is provider-authored
    // text that ends up in `technicalDetails`, which is persisted on the task
    // record and read by the panel — and providers echo the key. Measured in
    // a browser before the fix: the stored task carried the key.
    const http = code(readFileSync(join(ROOT, 'providers/core/provider-http.ts'), 'utf8'));
    const start = http.indexOf('export async function readErrorBody');
    const body = http.slice(start, http.indexOf('\n}', start));

    // Exact removal of the credential actually in use, which works for a
    // gateway key no pattern could recognise, then the shape rules for one
    // this call does not hold.
    expect(body).toContain('withoutSecret');
    expect(body).toContain('redact(');
    // And every adapter threads the key down rather than leaving it to shape
    // matching alone.
    for (const adapter of ['openai-compatible', 'gemini', 'anthropic']) {
      const source = code(readFileSync(join(ROOT, `providers/adapters/${adapter}.ts`), 'utf8'));
      expect(source, adapter).toContain('toHttpFailure(response, this.config?.apiKey)');
      expect(source, adapter).not.toMatch(/readErrorBody\(response\)\s*;/);
    }
  });

  it('08 — the JSON-parse failure path is redacted too', () => {
    const http = code(readFileSync(join(ROOT, 'providers/core/provider-http.ts'), 'utf8'));
    // The other place a provider-authored string becomes `technicalDetails`.
    expect(http).toContain('technicalDetails: redact(text.slice(0, 200))');
  });

  it('09 — credentials are keyed by connection, never by provider, on the account path', () => {
    const worker = code(readFileSync(join(ROOT, 'background/service-worker.ts'), 'utf8'));
    const start = worker.indexOf('async function resolveFromAccount');
    const body = worker.slice(start, worker.indexOf('\n}', start));

    // The property that makes two accounts on one provider incapable of
    // reading each other: the lookup is by `connectionId`, and there is no
    // call on this path that could be handed a provider id.
    expect(body).toContain('credentialKeyFor(account.connectionId)');
    expect(body).not.toContain('getApiKey');
  });

  it('10 — the K1 routes never return key material', () => {
    const worker = code(readFileSync(join(ROOT, 'background/service-worker.ts'), 'utf8'));
    const start = worker.indexOf("router.on('k1.status'");
    const body = worker.slice(start, worker.indexOf("router.on('storage.getPreference'", start));

    for (const forbidden of ['dek', 'wrapped', 'salt', 'toBase64', 'passphrase:']) {
      expect(body, `a k1 route emits ${forbidden}`).not.toContain(forbidden);
    }
    // The failure descriptions name a kind, never the value that failed.
    expect(body).toContain('describeK1');
  });
});
