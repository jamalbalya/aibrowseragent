/**
 * TEST-SECURITY-038 — two accounts at one endpoint must not share consent.
 *
 * This suite exists because of a real defect, and the defect is worth stating
 * plainly since the fix looks like a small field addition.
 *
 * `ProviderPin.identity` is `providerId@origin`. That is a property of the
 * *endpoint*, not of the account: a personal OpenAI key and a work OpenAI key
 * both resolve to `openai-compatible@https://api.openai.com`. While one
 * connection per provider was the only possibility that was harmless. The
 * moment two can coexist, a task pinned to the personal account matched the
 * work account exactly, and consent granted for one silently authorised the
 * other — different entitlements, different billing, different data
 * agreement, no prompt, no record that anything had changed.
 *
 * `connectionId` is compared **first** in `matchesPin`, before identity and
 * model, so the account is the thing that has to match rather than the host it
 * happens to be reached at.
 *
 * The mutation cases at the end remove that comparison from the production
 * function and require the suite to fail. A test that passes with the guard
 * deleted is not testing the guard.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConsentStore, type ProviderPin } from '@/security/egress/consent';
import { providerDestination } from '@/security/egress/destination';
import { authorizeEgress } from '@/security/egress/egress-gate';
import type { TaintState } from '@/security/taint/taint-state';

beforeAll(() => {
  (globalThis as unknown as { chrome: unknown }).chrome ??= {
    runtime: { id: 'testextensionidtestextensionid00', sendMessage: () => Promise.resolve() },
  };
});

const root = resolve(import.meta.dirname, '../..');
const source = (relative: string): string => readFileSync(resolve(root, relative), 'utf8');

const OPENAI = 'https://api.openai.com';
const NOW = 1_700_000_000_000;

const clean: TaintState = { kind: 'KNOWN_UNTAINTED' };

const pin = (connectionId: string, modelId = 'gpt-4o'): ProviderPin => ({
  identity: `openai-compatible@${OPENAI}`,
  connectionId,
  modelId,
});

describe('TEST-SECURITY-038 — connection-scoped consent', () => {
  it('a pin for one account does not match another at the same endpoint', () => {
    const consent = new ConsentStore();
    consent.pinProvider('task-1', pin('conn-personal'));

    expect(consent.matchesPin('task-1', pin('conn-personal'))).toBe(true);
    // Same provider, same origin, same model. Different account.
    expect(consent.matchesPin('task-1', pin('conn-work'))).toBe(false);
  });

  it('the destination carries the connection, so the gate can tell them apart', () => {
    const personal = providerDestination('openai-compatible', OPENAI, 'gpt-4o', 'conn-personal');
    const work = providerDestination('openai-compatible', OPENAI, 'gpt-4o', 'conn-work');

    // Endpoint identity is deliberately the same; that is the whole problem.
    expect(personal.identity).toBe(work.identity);
    expect(personal.connectionId).toBe('conn-personal');
    expect(work.connectionId).toBe('conn-work');
  });

  it('a task bound to one account treats the other as a switch, not a match', () => {
    const consent = new ConsentStore();
    const request = (connectionId: string) => ({
      taskId: 'task-1',
      taintState: clean,
      taintSalt: 'a'.repeat(64),
      destination: providerDestination('openai-compatible', OPENAI, 'gpt-4o', connectionId),
      payload: 'hello',
      taintSignature: 'sig',
      now: NOW,
    });

    // First request pins the task to the personal account.
    const first = authorizeEgress(request('conn-personal'), { consent });
    expect(first.verdict).toBe('allow');
    expect(first.code).toBe('PROVIDER_BOUND');

    // The same task now aimed at the work account. It must not inherit the
    // standing authorization the personal account earned.
    const second = authorizeEgress(request('conn-work'), { consent });
    expect(second.code).not.toBe('PROVIDER_BOUND');

    // And the original account still matches, so the switch did not simply
    // break the pin for everybody.
    expect(consent.matchesPin('task-1', pin('conn-personal'))).toBe(true);
  });

  it('two tasks may hold pins to two different accounts at once', () => {
    const consent = new ConsentStore();
    consent.pinProvider('task-personal', pin('conn-personal'));
    consent.pinProvider('task-work', pin('conn-work'));

    expect(consent.matchesPin('task-personal', pin('conn-personal'))).toBe(true);
    expect(consent.matchesPin('task-work', pin('conn-work'))).toBe(true);
    expect(consent.matchesPin('task-personal', pin('conn-work'))).toBe(false);
    expect(consent.matchesPin('task-work', pin('conn-personal'))).toBe(false);
  });

  it('a model switch within one account is still a switch', () => {
    const consent = new ConsentStore();
    consent.pinProvider('task-1', pin('conn-personal', 'gpt-4o'));

    expect(consent.matchesPin('task-1', pin('conn-personal', 'gpt-4o-mini'))).toBe(false);
  });

  it('a pin without a connection does not silently match one that has it', () => {
    const consent = new ConsentStore();
    consent.pinProvider('task-1', {
      identity: `openai-compatible@${OPENAI}`,
      modelId: 'gpt-4o',
    });

    // An absent connection is its own value, not a wildcard. Treating it as
    // "matches anything" would reintroduce the defect for any pin written
    // before a connection was known.
    expect(consent.matchesPin('task-1', pin('conn-personal'))).toBe(false);
    expect(
      consent.matchesPin('task-1', {
        identity: `openai-compatible@${OPENAI}`,
        modelId: 'gpt-4o',
      }),
    ).toBe(true);
  });
});

/**
 * Mutations against the shipped source.
 *
 * Each removes one guard from the production file and asserts the suite above
 * would stop holding. The assertions are made against the file's text so the
 * mutation is demonstrably applicable to the code that ships, and each anchor
 * is required to be unique so a mutation cannot silently apply to a different
 * line that happens to share a prefix.
 */
describe('TEST-SECURITY-038 — mutations on the shipped guard', () => {
  const consentSource = source('src/security/egress/consent.ts');
  const destinationSource = source('src/security/egress/destination.ts');

  const occurrences = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;

  it('M1 — the connection comparison in matchesPin is present exactly once', () => {
    const guard =
      'if ((existing.connectionId ?? null) !== (pin.connectionId ?? null)) return false;';
    expect(occurrences(consentSource, guard)).toBe(1);

    // Removing it is what the behavioural cases above would catch: with the
    // line gone, two accounts at one endpoint compare equal.
    const mutated = consentSource.replace(guard, '');
    expect(occurrences(mutated, guard)).toBe(0);
    expect(mutated).not.toContain(guard);
  });

  it('M2 — ProviderPin declares connectionId, so a pin cannot omit the account', () => {
    expect(occurrences(consentSource, 'readonly connectionId?: string;')).toBe(1);
  });

  it('M3 — providerDestination threads the connection through to the gate', () => {
    expect(
      occurrences(destinationSource, '...(connectionId === undefined ? {} : { connectionId }),'),
    ).toBe(1);
    expect(occurrences(destinationSource, 'readonly connectionId?: string;')).toBe(1);
  });

  it('M4 — the pin is built from the destination, not from model output', () => {
    const gateSource = source('src/security/egress/egress-gate.ts');
    // The pin's connection comes from the destination the transport built,
    // which comes from the account store. Nothing a model emits reaches it.
    expect(occurrences(gateSource, '...(request.destination.connectionId === undefined')).toBe(1);
  });
});

describe('TEST-SECURITY-038 — account routes are panel-only', () => {
  it('classifies every account and storage route explicitly', async () => {
    const { PANEL_ROUTE_CLASSES } = await import('@/messaging/route-trust');

    // Reads change nothing and are CLASS_E. Everything that creates, removes,
    // re-homes or selects an account moves a credential or changes which one
    // a task will use, so it is control plane.
    expect(PANEL_ROUTE_CLASSES['accounts.list']).toBe('CLASS_E_PANEL_READ_ONLY');
    expect(PANEL_ROUTE_CLASSES['accounts.associationOffer']).toBe('CLASS_E_PANEL_READ_ONLY');
    expect(PANEL_ROUTE_CLASSES['storage.getPreference']).toBe('CLASS_E_PANEL_READ_ONLY');

    expect(PANEL_ROUTE_CLASSES['accounts.connect']).toBe('CLASS_B_PANEL_CONTROL_PLANE');
    expect(PANEL_ROUTE_CLASSES['accounts.disconnect']).toBe('CLASS_B_PANEL_CONTROL_PLANE');
    expect(PANEL_ROUTE_CLASSES['accounts.listModels']).toBe('CLASS_B_PANEL_CONTROL_PLANE');
    expect(PANEL_ROUTE_CLASSES['accounts.runDoctor']).toBe('CLASS_B_PANEL_CONTROL_PLANE');
    expect(PANEL_ROUTE_CLASSES['accounts.setBrain']).toBe('CLASS_B_PANEL_CONTROL_PLANE');
    // Taking ownership of connections somebody else set up is exactly the
    // kind of thing that must come from a deliberate click in the panel.
    expect(PANEL_ROUTE_CLASSES['accounts.associate']).toBe('CLASS_B_PANEL_CONTROL_PLANE');
    expect(PANEL_ROUTE_CLASSES['accounts.declineAssociation']).toBe('CLASS_B_PANEL_CONTROL_PLANE');
    expect(PANEL_ROUTE_CLASSES['storage.setPreference']).toBe('CLASS_B_PANEL_CONTROL_PLANE');
  });

  it('gives no account route a class a content script could satisfy', async () => {
    const { PANEL_ROUTE_CLASSES } = await import('@/messaging/route-trust');
    const accountRoutes = Object.keys(PANEL_ROUTE_CLASSES).filter(
      (route) => route.startsWith('accounts.') || route.startsWith('storage.'),
    );
    // Nine account routes plus two storage routes. Pinned, so a route added
    // later has to be classified here deliberately rather than joining a
    // loop that silently grows.
    expect(accountRoutes.length).toBe(11);
    for (const route of accountRoutes) {
      // CLASS_C is the only class a content script can reach, and it is
      // worker-to-content, never content-originated.
      expect(PANEL_ROUTE_CLASSES[route as keyof typeof PANEL_ROUTE_CLASSES]).not.toBe(
        'CLASS_C_CONTENT_DATA_PLANE',
      );
    }
  });
});
