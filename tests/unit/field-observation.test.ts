/**
 * @vitest-environment jsdom
 *
 * TEST-FIELDOBS-001 … 014 — what the content script reports, and what it
 * refuses.
 *
 * Two halves, and they are separate on purpose.
 *
 * The **observation** half checks that the content script reports raw
 * attributes and no conclusion. There is deliberately no case here asserting
 * that some field "is a password", because this layer is not entitled to that
 * opinion — it reports `type="password"` and stops.
 *
 * The **refusal** half checks the backstop: a live element more sensitive than
 * the ceiling the worker authorised is refused. That is the only place the
 * mutation a page makes *after* it was read is visible at all, so it is the
 * only place that case can be closed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ElementRegistry, extractSemanticPage, observeField } from '@/content/semantic-tree';
import { classifyField, exceedsCeiling, FIELD_CLASSES } from '@/policy/field-sensitivity';

/**
 * jsdom has no layout engine, so every element reports a zero-sized box and
 * would be filtered out as invisible before any of this could be observed.
 * The shim is the same one `semantic-tree.test.ts` uses: laid-out elements get
 * a real box, and elements the CSS genuinely hides keep a zero one.
 */
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const size = getComputedStyle(this).display === 'none' ? 0 : 20;
    const rect: DOMRect = {
      x: 0,
      y: 0,
      width: size,
      height: size,
      top: 0,
      right: size,
      bottom: size,
      left: 0,
      toJSON: () => ({}),
    };
    return rect;
  };
});

function mount(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

/** What the content script would compute for a selector, the way it does. */
function observe(selector: string) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`no element for ${selector}`);
  return observeField(element, 'e1-0', 'main');
}

describe('the content script reports attributes, not conclusions', () => {
  it('01 reports a password input as its literal type and reads no value', () => {
    mount(
      '<input type="password" name="pw" id="pw-1" value="hunter2" autocomplete="current-password">',
    );
    const observation = observe('#pw-1');
    expect(observation.fieldType).toBe('password');
    expect(observation.autocompleteToken).toBe('current-password');
    expect(observation.nameHint).toBe('pw');
    expect(observation.idHint).toBe('pw-1');
    // The value is nowhere in the observation, which carries no value field at
    // all — the type has no room for one.
    expect(JSON.stringify(observation)).not.toContain('hunter2');
  });

  it('02 carries no class, risk, verdict or authorization', () => {
    mount('<input type="password" name="pw">');
    const keys = Object.keys(observe('input')).sort();
    expect(keys).toEqual([
      'autocompleteToken',
      'elementId',
      'fieldType',
      'formActionSite',
      'idHint',
      'inputMode',
      'isInShadowRoot',
      'isInSubframe',
      'maxLength',
      'nameHint',
    ]);
    for (const banned of ['fieldClass', 'risk', 'sensitivity', 'prohibited', 'allow', 'verdict']) {
      expect(keys, banned).not.toContain(banned);
    }
  });

  it('03 lowercases and trims the attributes it pattern-matches on', () => {
    mount('<input type="text" name="  CC-Number  " autocomplete="CC-NUMBER">');
    const observation = observe('input');
    expect(observation.autocompleteToken).toBe('cc-number');
    expect(observation.nameHint).toBe('cc-number');
  });

  it('04 truncates a hint a page made enormous', () => {
    mount(`<input type="text" name="${'a'.repeat(9_000)}">`);
    expect(observe('input').nameHint.length).toBeLessThanOrEqual(120);
  });

  it('05 reports the owning form action as a site', () => {
    mount('<form action="https://payments.example.net/charge"><input type="text" name="q"></form>');
    expect(observe('input').formActionSite).toBe('payments.example.net');
  });

  it('06 a form with no action resolves to the page it is on, not to nothing', () => {
    mount('<form><input type="text" name="q"></form>');
    // Which is the correct answer: a form with no action posts to itself.
    expect(observe('input').formActionSite).toBe('localhost');
  });

  it('07 an input outside any form reports no form site', () => {
    mount('<input type="text" name="q">');
    expect(observe('input').formActionSite).toBe('');
  });

  it('08 reports textarea, select and contenteditable by what they are', () => {
    mount(
      '<textarea name="t"></textarea>' +
        '<select name="s"><option>a</option></select>' +
        '<div contenteditable="true" id="ce"></div>',
    );
    expect(observe('textarea').fieldType).toBe('textarea');
    expect(observe('select').fieldType).toBe('select-one');
    expect(observe('#ce').fieldType).toBe('contenteditable');
  });

  it('09 a page read carries one observation per reported element', () => {
    mount('<input type="text" name="user"><input type="password" name="pw"><button>Go</button>');
    const page = extractSemanticPage(document, new ElementRegistry());
    expect(page.fields.length).toBe(page.elements.length);
    for (const [index, element] of page.elements.entries()) {
      expect(page.fields[index]?.elementId).toBe(element.elementId);
    }
    // And the password field is reported as such to the worker while its value
    // stays out of the model.
    const password = page.fields.find((field) => field.fieldType === 'password');
    expect(password).toBeDefined();
    expect(classifyField(password)).toBe('PASSWORD');
  });

  it('10 a hidden input is not in the page model at all, so nothing can write to it', () => {
    mount('<input type="hidden" name="csrf" value="abc"><input type="text" name="q">');
    const page = extractSemanticPage(document, new ElementRegistry());
    expect(page.elements.some((element) => element.name === 'csrf')).toBe(false);
    expect(page.fields.some((field) => field.fieldType === 'hidden')).toBe(false);
    // The registry never minted a handle for it, so there is no handle a write
    // could name. This is a stronger guarantee than a refusal would be.
    expect(page.fields.length).toBe(page.elements.length);
    expect(JSON.stringify(page.fields)).not.toContain('csrf');
  });
});

describe('the ceiling comparison refuses upward and never downward', () => {
  it('11 every class is comparable, and a class never exceeds itself', () => {
    for (const fieldClass of FIELD_CLASSES) {
      expect(exceedsCeiling(fieldClass, fieldClass), fieldClass).toBe(false);
    }
  });

  it('12 a field that became a password after the read exceeds an ordinary ceiling', () => {
    // The TOCTOU shape, at the unit level. The real-Chromium case in
    // tests/e2e/field-sensitivity.spec.ts does the same thing through the
    // whole stack; this one pins the comparison it rests on.
    mount('<input type="text" name="q" id="f">');
    const before = classifyField(observe('#f'));
    expect(before).toBe('ORDINARY');

    document.querySelector('#f')?.setAttribute('type', 'password');
    const after = classifyField(observe('#f'));
    expect(after).toBe('PASSWORD');
    expect(exceedsCeiling(after, before)).toBe(true);
  });

  it('13 a field that became less sensitive does not exceed its ceiling', () => {
    // The other direction, so case 12 is not passing because everything
    // exceeds everything.
    mount('<input type="password" id="f">');
    const before = classifyField(observe('#f'));
    document.querySelector('#f')?.setAttribute('type', 'text');
    const after = classifyField(observe('#f'));
    expect(before).toBe('PASSWORD');
    expect(after).toBe('ORDINARY');
    expect(exceedsCeiling(after, before)).toBe(false);
  });

  it('14 a control this build does not recognise exceeds an ordinary ceiling', () => {
    // Not an invalid `input type`: the DOM normalises one of those to `text`,
    // so a page cannot reach UNKNOWN that way and this case would be testing a
    // thing that cannot happen. A focusable element that is not a form control
    // is how it is actually reached.
    mount('<input type="text" id="ordinary"><div tabindex="0" id="odd"></div>');
    const ordinary = classifyField(observe('#ordinary'));
    const unknown = classifyField(observe('#odd'));
    expect(ordinary).toBe('ORDINARY');
    expect(unknown).toBe('UNKNOWN');
    expect(exceedsCeiling(unknown, ordinary)).toBe(true);
  });
});
