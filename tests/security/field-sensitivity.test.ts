/**
 * TEST-FIELDSENS-001 … 041 — Gate 1: where field sensitivity enters policy.
 *
 * The property under test is not "a classifier exists". It is that the whole
 * path holds: a page reports raw attributes, an untrusted transport carries
 * them, the worker classifies, `evaluatePolicy` decides, and dispatch enforces
 * — with the page able to make the answer stricter and never looser.
 *
 * So the cases are grouped by which link they hold down:
 *
 *  A. the classifier is total, and uncertainty is more restricted than
 *     ordinary rather than less;
 *  B. the observation store cannot answer for a stale or foreign handle;
 *  C. a real dispatch through the real policy engine refuses what it should,
 *     in every permission mode;
 *  D. a standing site grant cannot reach any of it;
 *  E. the transport rejects a malformed or hostile observation set;
 *  F. the trusted module stays trusted, and none of this reaches a provider;
 *  G. no class is persisted anywhere a replay could trust it later.
 *
 * Several cases assert an absence. Each of those was run with the protection
 * removed first, and the negative-control record is in
 * `docs/testing/gate-1-negative-controls.md`; a case that passed either way
 * would be worse than no case at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  FIELD_CLASSES,
  classifyField,
  exceedsCeiling,
  writeDisposition,
  type FieldObservation,
} from '@/policy/field-sensitivity';
import { FieldObservationStore, generationOfHandle } from '@/policy/field-observation-store';
import { validateFieldObservations } from '@/messaging/protocol';
import { createBrowserTools } from '@/tools/browser/browser-tools';
import { FakeBrowserAdapter } from '../fixtures/fake-browser';
import { fakeDebugger } from '../fixtures/fake-debugger';
import { createHarness, ScriptedPrompter, type Harness } from '../fixtures/policy-harness';
import {
  clampToGrantable,
  emptySitePolicyState,
  sanitiseSitePolicyState,
  upsertRule,
  type GrantableRiskLevel,
} from '@/policy/site-policy';
import { evaluatePolicy, type PermissionMode } from '@/policy/policy-engine';

const SRC_ROOT = resolve(import.meta.dirname, '../../src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    return full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : [];
  });
}

/** Source with comments and string literals removed, so prose cannot satisfy a code check. */
function identifiersOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/** A neutral observation. Individual cases override only what they are about. */
const observation = (overrides: Partial<FieldObservation> = {}): FieldObservation => ({
  elementId: 'e1-0',
  fieldType: 'text',
  autocompleteToken: '',
  inputMode: '',
  maxLength: -1,
  formActionSite: 'example.com',
  nameHint: '',
  idHint: '',
  isInShadowRoot: false,
  isInSubframe: false,
  ...overrides,
});

// ---------------------------------------------------------------------------
// A. The classifier
// ---------------------------------------------------------------------------

describe('A. classification is total, and uncertainty is restriction', () => {
  it('01 every class has a disposition, and only ORDINARY leaves risk alone', () => {
    for (const fieldClass of FIELD_CLASSES) {
      const disposition = writeDisposition(fieldClass);
      expect(disposition, fieldClass).toBeTruthy();
      if (fieldClass === 'ORDINARY') {
        expect(disposition.kind).toBe('ALLOW_AT_BASELINE');
      } else {
        // The whole of INV-FS-1 in one assertion: there is no class other than
        // ORDINARY whose disposition leaves the tool's declared risk where it
        // was, and none at all that lowers it — `ALLOW_AT_BASELINE` carries no
        // risk value, so it cannot express a reduction even by mistake.
        expect(disposition.kind, fieldClass).not.toBe('ALLOW_AT_BASELINE');
      }
      expect(Object.keys(writeDisposition('ORDINARY'))).toEqual(['kind']);
    }
  });

  it('02 no observation is UNKNOWN, not ORDINARY', () => {
    expect(classifyField(undefined)).toBe('UNKNOWN');
    // And UNKNOWN is strictly more restricted than ORDINARY, which is what
    // makes an evicted worker fail closed rather than open.
    expect(exceedsCeiling('UNKNOWN', 'ORDINARY')).toBe(true);
    expect(exceedsCeiling('ORDINARY', 'UNKNOWN')).toBe(false);
  });

  it('03 a shadow root or a subframe is UNKNOWN whatever else it says', () => {
    expect(classifyField(observation({ isInShadowRoot: true }))).toBe('UNKNOWN');
    expect(classifyField(observation({ isInSubframe: true }))).toBe('UNKNOWN');
    // Even when every other signal says it is an unremarkable text box.
    expect(classifyField(observation({ fieldType: 'text', isInShadowRoot: true }))).toBe('UNKNOWN');
  });

  it('04 a password is a password by type, by token and by name', () => {
    expect(classifyField(observation({ fieldType: 'password' }))).toBe('PASSWORD');
    expect(classifyField(observation({ autocompleteToken: 'current-password' }))).toBe('PASSWORD');
    expect(classifyField(observation({ autocompleteToken: 'new-password' }))).toBe('PASSWORD');
    expect(classifyField(observation({ nameHint: 'user_password' }))).toBe('PASSWORD');
    expect(classifyField(observation({ idHint: 'login-passwd' }))).toBe('PASSWORD');
  });

  it('05 a one-time code is recognised by its token and by the usual names', () => {
    expect(classifyField(observation({ autocompleteToken: 'one-time-code' }))).toBe('OTP');
    for (const name of ['otp', 'totp_input', 'mfa-code', 'verification_code', 'sms code']) {
      expect(classifyField(observation({ nameHint: name })), name).toBe('OTP');
    }
  });

  it('06 payment fields are recognised by their standard tokens and by name', () => {
    for (const token of ['cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-name']) {
      expect(classifyField(observation({ autocompleteToken: token })), token).toBe(
        'PAYMENT_INSTRUMENT',
      );
    }
    for (const name of ['cardnumber', 'cvv', 'card-number', 'iban', 'routing_number']) {
      expect(classifyField(observation({ nameHint: name })), name).toBe('PAYMENT_INSTRUMENT');
    }
  });

  it('07 national identifiers are recognised, weakly and on purpose', () => {
    for (const name of ['ssn', 'social_security', 'passport_number', 'national-id', 'tax_id']) {
      expect(classifyField(observation({ nameHint: name })), name).toBe('NATIONAL_ID');
    }
  });

  it('08 API secrets are recognised by name', () => {
    for (const name of ['api_key', 'access-token', 'client_secret', 'refresh_token']) {
      expect(classifyField(observation({ nameHint: name })), name).toBe('API_SECRET');
    }
  });

  it('09 an ordinary text box is ordinary', () => {
    expect(classifyField(observation({ fieldType: 'text', nameHint: 'q' }))).toBe('ORDINARY');
    expect(classifyField(observation({ fieldType: 'email', nameHint: 'email' }))).toBe('ORDINARY');
    expect(classifyField(observation({ fieldType: 'textarea', nameHint: 'message' }))).toBe(
      'ORDINARY',
    );
  });

  it('10 a control this build does not recognise is UNKNOWN, never ORDINARY', () => {
    // The direction that matters. A type nobody has heard of is not evidence
    // that a field is safe, and answering ORDINARY here would make "omit the
    // attribute" a working evasion.
    for (const type of ['', 'passwordx', 'novel-control', 'PASSWORD ']) {
      expect(classifyField(observation({ fieldType: type })), type).toBe('UNKNOWN');
    }
  });

  it('10b a ceiling that names no class authorises the least, not the most', () => {
    // The shape an omitted or tampered `sensitivityCeiling` arrives in. Read
    // as ORDINARY — the lowest — so every sensitive class is still refused
    // against it. Typing this parameter and trusting the value was the
    // fail-open version: every comparison against `undefined` is false.
    for (const bogus of [undefined, null, '', 'ANYTHING', 42, {}, ['PASSWORD']]) {
      const label = JSON.stringify(bogus) ?? 'undefined';
      expect(exceedsCeiling('PASSWORD', bogus), label).toBe(true);
      expect(exceedsCeiling('PAYMENT_INSTRUMENT', bogus), label).toBe(true);
      expect(exceedsCeiling('UNKNOWN', bogus), label).toBe(true);
      expect(exceedsCeiling('ORDINARY', bogus), label).toBe(false);
    }
  });

  it('11 no single page-controlled attribute can reach ORDINARY from a sensitive field', () => {
    // Blanking one attribute at a time on a field that is sensitive for more
    // than one reason. Each variant must stay at least as restricted as
    // UNKNOWN — dropping to ORDINARY would mean a page could shed one signal
    // and be treated as unremarkable.
    const sensitive = observation({
      fieldType: 'password',
      autocompleteToken: 'current-password',
      nameHint: 'password',
      idHint: 'password',
    });
    const keys: (keyof FieldObservation)[] = [
      'fieldType',
      'autocompleteToken',
      'nameHint',
      'idHint',
    ];
    for (const key of keys) {
      const stripped = classifyField({ ...sensitive, [key]: '' });
      expect(stripped, key).not.toBe('ORDINARY');
    }
  });
});

// ---------------------------------------------------------------------------
// B. The observation store
// ---------------------------------------------------------------------------

describe('B. the store cannot answer for a handle it does not hold', () => {
  let store: FieldObservationStore;

  beforeEach(() => {
    store = new FieldObservationStore();
    store.record(1, 4, [observation({ elementId: 'e4-0', fieldType: 'password' })]);
  });

  it('12 a handle from another generation is not answered', () => {
    expect(store.lookup(1, 'e4-0')?.fieldType).toBe('password');
    // Same index, earlier snapshot. The page has been re-read since, so this
    // handle describes an element that no longer has that identity.
    expect(store.lookup(1, 'e3-0')).toBeUndefined();
    expect(store.lookup(1, 'e5-0')).toBeUndefined();
    expect(classifyField(store.lookup(1, 'e3-0'))).toBe('UNKNOWN');
  });

  it('12b a snapshot whose generation disagrees with its handles answers nothing', () => {
    // The case the generation check actually defends, and the reason the
    // previous case does not cover it: handles embed their own generation, so
    // a handle from another snapshot usually misses the map by its key alone.
    // What that does not catch is a page read whose declared generation and
    // whose minted handles disagree — a content script that is confused, or
    // one that is not ours. Then the key would hit and the answer would be for
    // an element identity that never existed.
    const disagreeing = new FieldObservationStore();
    disagreeing.record(1, 9, [
      observation({ elementId: 'e4-0', fieldType: 'text', nameHint: 'q' }),
    ]);
    expect(disagreeing.lookup(1, 'e4-0')).toBeUndefined();
    expect(classifyField(disagreeing.lookup(1, 'e4-0'))).toBe('UNKNOWN');

    // And the same store answers normally once the two agree, so this is not
    // passing because the store answers nothing at all.
    disagreeing.record(1, 4, [
      observation({ elementId: 'e4-0', fieldType: 'text', nameHint: 'q' }),
    ]);
    expect(classifyField(disagreeing.lookup(1, 'e4-0'))).toBe('ORDINARY');
  });

  it('13 another tab is not answered, and neither is no tab', () => {
    expect(store.lookup(2, 'e4-0')).toBeUndefined();
    expect(store.lookup(undefined, 'e4-0')).toBeUndefined();
  });

  it('14 an emptied store answers nothing — the evicted-worker case', () => {
    store.clear();
    expect(store.lookup(1, 'e4-0')).toBeUndefined();
    expect(classifyField(store.lookup(1, 'e4-0'))).toBe('UNKNOWN');
  });

  it('15 a malformed handle is not answered', () => {
    for (const handle of ['', 'e', 'ex-0', 'e-1', '4-0', 'e0-0', 'e-4-0', 'eNaN-0']) {
      expect(generationOfHandle(handle) === null || store.lookup(1, handle) === undefined).toBe(
        true,
      );
    }
  });

  it('16 a new snapshot replaces the old one rather than merging into it', () => {
    store.record(1, 5, [observation({ elementId: 'e5-0', fieldType: 'text', nameHint: 'q' })]);
    expect(store.lookup(1, 'e4-0')).toBeUndefined();
    expect(classifyField(store.lookup(1, 'e5-0'))).toBe('ORDINARY');
  });

  it('17 forgetting a tab drops it', () => {
    store.forget(1);
    expect(store.lookup(1, 'e4-0')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// C. Dispatch, through the real policy engine
// ---------------------------------------------------------------------------

describe('C. what a real dispatch does with a sensitive field', () => {
  let adapter: FakeBrowserAdapter;
  let fieldObservations: FieldObservationStore;
  let harness: Harness;

  const build = (mode: PermissionMode = 'auto', prompter = new ScriptedPrompter()) => {
    harness = createHarness(
      createBrowserTools({
        adapter,
        debuggerManager: fakeDebugger().manager,
        fieldObservations,
      }),
      { mode, prompter },
    );
    return harness;
  };

  const dispatch = (name: string, args: Record<string, unknown>) =>
    harness.registry.dispatch({
      toolCallId: 'tc_1',
      taskId: 'task_1',
      sessionId: 's1',
      name,
      arguments: args,
      tabId: 1,
      signal: new AbortController().signal,
    });

  beforeEach(() => {
    adapter = new FakeBrowserAdapter();
    adapter.addTab({ id: 1, url: 'https://example.com/', title: 'Example', active: true });
    adapter.onContent(() => ({ typed: true, value: 'x', type: 'date' }));
    fieldObservations = new FieldObservationStore();
    build();
  });

  const record = (field: Partial<FieldObservation>) =>
    fieldObservations.record(1, 1, [observation({ elementId: 'e1-0', ...field })]);

  it('18 a password field is refused in Manual, Auto and Skip alike', async () => {
    for (const mode of ['manual', 'auto', 'skip'] as const) {
      // A prompter that approves everything, so a mode that reached the prompt
      // would succeed. None does.
      build(mode, new ScriptedPrompter({ kind: 'approve_once' }));
      record({ fieldType: 'password' });
      const result = await dispatch('browser.type', { elementId: 'e1-0', text: 'hunter2' });
      expect(result.envelope.error?.code, mode).toBe('POLICY_BLOCKED');
      expect(result.executed, mode).toBe(false);
      expect(harness.prompter.seen.length, mode).toBe(0);
    }
  });

  it('19 a one-time-code field is refused in every mode too', async () => {
    for (const mode of ['manual', 'auto', 'skip'] as const) {
      build(mode, new ScriptedPrompter({ kind: 'approve_once' }));
      record({ autocompleteToken: 'one-time-code' });
      const result = await dispatch('browser.type', { elementId: 'e1-0', text: '123456' });
      expect(result.envelope.error?.code, mode).toBe('POLICY_BLOCKED');
      expect(result.executed, mode).toBe(false);
      expect(harness.prompter.seen.length, mode).toBe(0);
    }
  });

  it('20 a card field produces the payment prohibition and is denied', async () => {
    for (const mode of ['manual', 'auto', 'skip'] as const) {
      build(mode, new ScriptedPrompter({ kind: 'approve_once' }));
      record({ autocompleteToken: 'cc-number' });
      const result = await dispatch('browser.type', { elementId: 'e1-0', text: '1111' });
      expect(result.envelope.error?.code, mode).toBe('POLICY_BLOCKED');
      expect(result.executed, mode).toBe(false);
      expect(result.envelope.error?.message, mode).toContain('hard safety rule');
    }
  });

  it('21 a card number is refused even on a field the page calls ordinary', async () => {
    // The page-independent half. The observation says "plain text box"; the
    // value is issuer-prefixed and Luhn-valid, and that is not something a
    // page gets a say in.
    record({ fieldType: 'text', nameHint: 'nickname' });
    const result = await dispatch('browser.type', {
      elementId: 'e1-0',
      text: '4111111111111111',
    });
    expect(result.envelope.error?.code).toBe('POLICY_BLOCKED');
    expect(result.executed).toBe(false);
    expect(result.envelope.error?.message).toContain('hard safety rule');
  });

  it('22 a national-ID field confirms rather than refuses', async () => {
    const prompter = new ScriptedPrompter({ kind: 'approve_once' });
    build('auto', prompter);
    record({ nameHint: 'ssn' });
    const result = await dispatch('browser.type', { elementId: 'e1-0', text: '000-00-0000' });
    expect(result.envelope.status).toBe('success');
    expect(prompter.seen.length).toBe(1);
    expect(prompter.seen[0]?.risk).toBe('R3');
  });

  it('23 a declined confirmation on a national-ID field blocks the write', async () => {
    build('auto', new ScriptedPrompter({ kind: 'deny' }));
    record({ nameHint: 'passport_number' });
    const result = await dispatch('browser.type', { elementId: 'e1-0', text: 'X1234567' });
    // `PERMISSION_DENIED`, not `POLICY_BLOCKED`: this was a confirmation the
    // person declined, which is a different outcome from the engine refusing
    // outright, and the distinction is worth keeping visible.
    expect(result.envelope.error?.code).toBe('PERMISSION_DENIED');
    expect(result.executed).toBe(false);
  });

  it('24 an API-secret field confirms at R3', async () => {
    const prompter = new ScriptedPrompter({ kind: 'approve_once' });
    build('auto', prompter);
    record({ nameHint: 'api_key' });
    await dispatch('browser.type', { elementId: 'e1-0', text: 'abc' });
    expect(prompter.seen[0]?.risk).toBe('R3');
  });

  it('25 an ordinary field keeps its baseline and is not prompted for in Auto', async () => {
    // The usability half of D-3. If this case ever starts prompting, the
    // fallback has leaked into the positively classified path.
    record({ fieldType: 'text', nameHint: 'search' });
    const result = await dispatch('browser.type', { elementId: 'e1-0', text: 'hello' });
    expect(result.envelope.status).toBe('success');
    expect(result.risk).toBe('R1');
    expect(harness.prompter.seen.length).toBe(0);
  });

  it('26 an unobserved field confirms instead of running silently', async () => {
    const prompter = new ScriptedPrompter({ kind: 'approve_once' });
    build('auto', prompter);
    // Nothing recorded: the worker restarted between the page read and here.
    const result = await dispatch('browser.type', { elementId: 'e1-0', text: 'hello' });
    expect(result.risk).toBe('R2');
    expect(prompter.seen.length).toBe(1);
    expect(result.envelope.status).toBe('success');
  });

  it('27 browser.set_value is held to the same rules as browser.type', async () => {
    build('skip', new ScriptedPrompter({ kind: 'approve_once' }));
    record({ fieldType: 'password' });
    const password = await dispatch('browser.set_value', { elementId: 'e1-0', value: 'x' });
    expect(password.envelope.error?.code).toBe('POLICY_BLOCKED');

    record({ autocompleteToken: 'cc-number' });
    const card = await dispatch('browser.set_value', { elementId: 'e1-0', value: '1' });
    expect(card.envelope.error?.code).toBe('POLICY_BLOCKED');
  });

  it('28 the sensitivity ceiling travels to the content script on every write', async () => {
    const ceilings = () =>
      adapter.calls
        .filter((call) => call.type === 'content.type')
        .map((call) => (call.payload as { sensitivityCeiling?: string }).sensitivityCeiling);

    record({ fieldType: 'text', nameHint: 'q' });
    await dispatch('browser.type', { elementId: 'e1-0', text: 'hello' });
    expect(ceilings()).toEqual(['ORDINARY']);

    // And the fallback travels too, rather than the field being omitted when
    // the worker has nothing to say.
    fieldObservations.clear();
    await dispatch('browser.type', { elementId: 'e1-0', text: 'hello' });
    expect(ceilings()).toEqual(['ORDINARY', 'UNKNOWN']);
  });
});

// ---------------------------------------------------------------------------
// D. Site grants
// ---------------------------------------------------------------------------

describe('D. a standing site grant reaches none of this', () => {
  const grantedAt = (maxRisk: GrantableRiskLevel) =>
    upsertRule(emptySitePolicyState(), {
      site: 'example.com',
      decision: 'allow',
      maxRisk,
      createdAt: 0,
    });

  const evaluate = (
    request: Parameters<typeof evaluatePolicy>[0],
    maxRisk: GrantableRiskLevel = 'R2',
  ) => evaluatePolicy(request, { mode: 'auto', sitePolicy: grantedAt(maxRisk) });

  const base = {
    tool: 'browser.type',
    taskId: 't',
    targetUrl: 'https://example.com/checkout',
  } as const;

  it('29 the widest grant does not reach the payment prohibition', () => {
    const decision = evaluate({
      ...base,
      risk: 'R1',
      prohibited: ['payment_instrument_entry'],
    });
    expect(decision.verdict).toBe('DENY');
    expect(decision.code).toBe('PROHIBITED_ACTION');
  });

  it('30 the widest grant does not reach a refused password or OTP write', () => {
    // Password and OTP refusals arrive as R5, which the engine denies at its
    // second rule — before site policy is read at all.
    const decision = evaluate({ ...base, risk: 'R5' });
    expect(decision.verdict).toBe('DENY');
    expect(decision.code).toBe('PROHIBITED_ACTION');
  });

  it('31 the grant does not cover the R3 a national-ID or API-secret field raises', () => {
    const decision = evaluate({ ...base, risk: 'R3' });
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
    // Specifically not SITE_ALLOWED: the R3 floor returns before the branch
    // that consults a rule, so the grant never gets a say.
    expect(decision.code).toBe('RISK_REQUIRES_APPROVAL');
  });

  it('32 the grant still does what it is for, so the case above means something', () => {
    // A negative control in the ordinary sense: if a grant covered nothing at
    // all, cases 29 to 31 would pass for the wrong reason.
    const decision = evaluate({ ...base, risk: 'R2' });
    expect(decision.verdict).toBe('ALLOW');
    expect(decision.code).toBe('SITE_ALLOWED');
  });

  it('33 a grant cannot express more than R2, and a stored one is clamped', () => {
    expect(clampToGrantable('R5')).toBe('R2');
    expect(clampToGrantable('R3')).toBe('R2');
    expect(clampToGrantable('R1')).toBe('R1');

    // A record from an older build, where the field was a plain RiskLevel.
    const legacy = upsertRule(emptySitePolicyState(), {
      site: 'example.com',
      decision: 'allow',
      maxRisk: 'R4' as GrantableRiskLevel,
      createdAt: 0,
    });
    const repaired = sanitiseSitePolicyState(legacy);
    expect(repaired.rules[0]?.maxRisk).toBe('R2');
    // Clamped, not discarded: the user approved that site and still has.
    expect(repaired.rules.length).toBe(1);
  });

  it('33b a page write names no target site, so no grant applies to it anyway', () => {
    // Recorded because it is the actual reason a grant cannot widen a write,
    // and it is easy to assume the opposite from reading the engine alone.
    // `browser.type` and `browser.set_value` set no `targetUrl` in their
    // classification, so `findRule` is never consulted for them. This is
    // pre-existing behaviour and is asserted rather than changed: making page
    // writes grantable would widen what a standing approval covers, which is
    // the wrong direction.
    const tools = readFileSync(join(SRC_ROOT, 'tools/browser/browser-tools.ts'), 'utf8');
    const typeTool = tools.slice(
      tools.indexOf('export function createTypeTool'),
      tools.indexOf('const selectInput'),
    );
    expect(typeTool.length).toBeGreaterThan(0);
    expect(identifiersOnly(typeTool)).not.toContain('targetUrl');
  });
});

// ---------------------------------------------------------------------------
// E. The transport
// ---------------------------------------------------------------------------

describe('E. the transport refuses an observation set it cannot trust', () => {
  const valid = {
    elementId: 'e1-0',
    fieldType: 'text',
    autocompleteToken: '',
    inputMode: '',
    maxLength: -1,
    formActionSite: 'example.com',
    nameHint: 'q',
    idHint: 'q',
    isInShadowRoot: false,
    isInSubframe: false,
  };

  it('34 a well-formed set passes', () => {
    expect(validateFieldObservations([valid])).toEqual([valid]);
    expect(validateFieldObservations([])).toEqual([]);
  });

  it('35 anything that is not an array is refused', () => {
    for (const bad of [undefined, null, 'fields', 42, {}, { 0: valid }]) {
      expect(() => validateFieldObservations(bad)).toThrow();
    }
  });

  it('36 a prototype-polluting key is refused rather than assigned', () => {
    const hostile = JSON.parse(`[{"__proto__":{"polluted":true},"elementId":"e1-0"}]`) as unknown[];
    expect(() => validateFieldObservations(hostile)).toThrow();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

    expect(() => validateFieldObservations([{ ...valid, constructor: 'x' }])).toThrow();
    expect(() => validateFieldObservations([{ ...valid, prototype: 'x' }])).toThrow();
  });

  it('37 a value that merely converts to a string is not a string', () => {
    // The shape that would otherwise pattern-match as harmless at validation
    // time and read as something else when the classifier touches it.
    const sneaky = { ...valid, fieldType: { toString: () => 'text' } };
    expect(() => validateFieldObservations([sneaky])).toThrow();
    expect(() => validateFieldObservations([{ ...valid, isInShadowRoot: 'false' }])).toThrow();
    expect(() => validateFieldObservations([{ ...valid, maxLength: '12' }])).toThrow();
    expect(() => validateFieldObservations([{ ...valid, maxLength: 1.5 }])).toThrow();
  });

  it('38 extra keys are dropped rather than carried through', () => {
    const [result] = validateFieldObservations([{ ...valid, fieldClass: 'ORDINARY', risk: 'R0' }]);
    expect(result).toEqual(valid);
    expect(Object.keys(result as object)).not.toContain('fieldClass');
    expect(Object.keys(result as object)).not.toContain('risk');
  });

  it('39 a hint longer than the bound is truncated rather than refused', () => {
    const [result] = validateFieldObservations([{ ...valid, nameHint: 'a'.repeat(5_000) }]);
    expect((result as FieldObservation).nameHint.length).toBeLessThanOrEqual(120);
  });
});

// ---------------------------------------------------------------------------
// F. The trusted module, and the provider boundary
// ---------------------------------------------------------------------------

describe('F. the classifier stays trusted and none of this reaches a provider', () => {
  it('40 field-sensitivity.ts has no privileged dependency', () => {
    const file = join(SRC_ROOT, 'policy/field-sensitivity.ts');
    const code = identifiersOnly(readFileSync(file, 'utf8'));
    for (const forbidden of ['chrome.', 'fetch(', 'Date.now', 'localStorage', 'indexedDB']) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    // One import, and it is a type. A value import would make the purity claim
    // depend on what that module happens to do today.
    const imports = readFileSync(file, 'utf8').match(/^import .*$/gm) ?? [];
    expect(imports).toEqual([
      "import type { ProhibitedCategory, RiskLevel } from './risk-classifier';",
    ]);
  });

  it('41 there is still exactly one evaluatePolicy call site', () => {
    const callers = sources(SRC_ROOT).filter((file) => {
      if (file.endsWith('policy-engine.ts')) return false;
      return /evaluatePolicy\s*\(/.test(identifiersOnly(readFileSync(file, 'utf8')));
    });
    expect(callers.map((f) => f.replace(`${SRC_ROOT}/`, ''))).toEqual([
      'tools/registry/tool-registry.ts',
    ]);
  });

  it('42 the content script can refuse on the ceiling and cannot raise it', () => {
    const code = readFileSync(join(SRC_ROOT, 'content/content-script.ts'), 'utf8');
    // It reads the ceiling the worker sent and throws. It never assigns one,
    // never widens one, and never returns one.
    expect(code).toContain('payload.sensitivityCeiling');
    expect(identifiersOnly(code)).not.toMatch(/sensitivityCeiling\s*=/);
    expect(identifiersOnly(code)).toMatch(/throw new InteractionRejection\(/);

    // And the protocol carries it in one direction only: it is a request
    // field, never a response field. Read from the declarations with comments
    // stripped, so the docblock explaining the direction does not satisfy the
    // check that enforces it.
    const protocol = identifiersOnly(readFileSync(join(SRC_ROOT, 'messaging/protocol.ts'), 'utf8'));
    for (const line of protocol.split('\n')) {
      if (!line.trimStart().startsWith('response:')) continue;
      expect(line).not.toContain('sensitivityCeiling');
    }
    expect(protocol).toContain('sensitivityCeiling');
  });

  it('43 raw observations are not in what browser.read_page returns or records', async () => {
    const adapter = new FakeBrowserAdapter();
    adapter.addTab({ id: 1, url: 'https://example.com/', title: 'Example', active: true });
    const fieldObservations = new FieldObservationStore();
    const page = {
      url: 'https://example.com/',
      title: 'Example',
      generation: 1,
      capturedAt: 1,
      readyState: 'complete',
      text: 'hello',
      textTruncated: false,
      elements: [],
      elementsTruncated: false,
      fields: [observation({ elementId: 'e1-0', fieldType: 'password', nameHint: 'secretname' })],
      scrollY: 0,
      documentHeight: 1,
      viewportHeight: 1,
    };
    adapter.onContent(() => ({ page }));
    const harness = createHarness(
      createBrowserTools({
        adapter,
        debuggerManager: fakeDebugger().manager,
        fieldObservations,
      }),
      { mode: 'auto' },
    );
    const result = await harness.registry.dispatch({
      toolCallId: 'tc_1',
      taskId: 'task_1',
      sessionId: 's1',
      name: 'browser.read_page',
      arguments: {},
      tabId: 1,
      signal: new AbortController().signal,
    });

    // The worker kept them. The model was not told.
    expect(fieldObservations.lookup(1, 'e1-0')?.fieldType).toBe('password');
    const serialised = JSON.stringify(result.envelope.result);
    expect(serialised).not.toContain('secretname');
    expect(serialised).not.toContain('autocompleteToken');
    expect(serialised).not.toContain('isInShadowRoot');
    expect(JSON.stringify(result.evidence ?? [])).not.toContain('autocompleteToken');
  });

  it('44 nothing in the provider layer mentions the observation fields', () => {
    const providerCode = sources(join(SRC_ROOT, 'providers'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    for (const key of [
      'autocompleteToken',
      'isInShadowRoot',
      'isInSubframe',
      'formActionSite',
      'FieldObservation',
      'FieldClass',
    ]) {
      expect(providerCode, key).not.toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// G. Nothing is persisted that a replay could trust
// ---------------------------------------------------------------------------

describe('G. no class is written anywhere a later run would believe it', () => {
  it('45 FieldClass and FieldObservation appear in no persisted model', () => {
    const persisted = [
      'workflows/workflow-model.ts',
      'workflows/workflow-store.ts',
      'workflows/parameteriser.ts',
      'workflows/workflow-recorder.ts',
      'skills/core/skill-model.ts',
      'skills/runtime/skill-run-store.ts',
      'shortcuts/shortcut-model.ts',
      'schedules/schedule-model.ts',
      'schedules/schedule-store.ts',
      'tasks/task-model.ts',
      'providers/registry/provider-registry.ts',
    ];
    for (const relative of persisted) {
      const file = join(SRC_ROOT, relative);
      const code = readFileSync(file, 'utf8');
      for (const token of ['FieldClass', 'FieldObservation', 'sensitivityCeiling']) {
        expect(code, `${relative}:${token}`).not.toContain(token);
      }
    }
  });

  it('46 a replayed write is classified against the live page, not a record', () => {
    // Structural rather than behavioural, and deliberately so: the guarantee
    // is that there is no recorded class to trust. A workflow replays by
    // re-reading the page and re-resolving the element, so the classification
    // is whatever the store holds for the snapshot that resolution came from.
    const runner = readFileSync(join(SRC_ROOT, 'skills/runtime/skill-runner.ts'), 'utf8');
    expect(runner).not.toContain('FieldClass');
    expect(runner).not.toContain('sensitivityCeiling');
    // Every page write still goes through the registry, which is where the
    // classification happens.
    expect(identifiersOnly(runner)).toMatch(/registry\.dispatch|dispatch\(/);
  });

  it('47 plugins and MCP supply no classification, because neither exists yet', () => {
    // Recorded as a fact about this build rather than as an intention. If a
    // plugin or MCP surface lands, this case fails and the trust question has
    // to be answered rather than inherited.
    const all = sources(SRC_ROOT)
      .map((file) => identifiersOnly(readFileSync(file, 'utf8')))
      .join('\n');
    expect(all).not.toMatch(/registerFieldClassifier|fieldClassifiers|classifierPlugin/);
  });
});

// A guard against the suite silently shrinking.
describe('the matrix is the size it claims to be', () => {
  it('48 every case in this file has a unique numeric prefix', () => {
    const text = readFileSync(
      join(resolve(import.meta.dirname), 'field-sensitivity.test.ts'),
      'utf8',
    );
    const numbers = [...text.matchAll(/it\('(\d+[a-z]?) /g)].map((m) => m[1]);
    expect(numbers.length).toBeGreaterThanOrEqual(40);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(vi.isMockFunction(vi.fn())).toBe(true);
  });
});
