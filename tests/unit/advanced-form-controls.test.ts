/**
 * @vitest-environment jsdom
 *
 * TEST-FORMS-001 — structured inputs and multi-select (P-006).
 *
 * These controls are the ones a plain "type into it" cannot reach. A date
 * field has segments and typing lands in whichever one has focus; a range has
 * none at all; a multi-select's `value` reports only its first selection.
 *
 * What the cases below are about is the two ways setting such a value goes
 * wrong quietly. A browser that cannot parse what it was given clears the
 * field rather than complaining, so a caller is told the field is empty and
 * never learns why — every setter here validates the format first and reads
 * back what the control settled on. And a control with bounds is the page
 * stating a rule about its own field, so a value outside them is refused
 * rather than clamped: silently moving a date into the allowed window submits
 * something nobody chose.
 *
 * jsdom implements the value plumbing but not the browsers' own parsing of
 * these types, so what it cannot settle is proved in real Chromium instead —
 * see `advanced-forms.spec.ts`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { performSelectMany, performSetValue } from '@/content/interaction-engine';
import { STRUCTURED_INPUT_TYPES } from '@/content/form-controls';

function input(type: string, attributes: Record<string, string> = {}): HTMLInputElement {
  const element = document.createElement('input');
  element.type = type;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  document.body.append(element);
  return element;
}

function multiSelect(
  values: readonly string[],
  disabled: readonly string[] = [],
): HTMLSelectElement {
  const element = document.createElement('select');
  element.multiple = true;
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.text = value.toUpperCase();
    option.disabled = disabled.includes(value);
    element.append(option);
  }
  document.body.append(element);
  return element;
}

beforeEach(() => {
  document.body.innerHTML = '';
  // jsdom has no layout, so it implements no `scrollIntoView`. The engine
  // calls it before every interaction for a real reason — an element below
  // the fold is not interactable — and that part is proved in real Chromium.
  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    /* no layout to scroll */
  };
});

describe('performSetValue accepts each type in its own format', () => {
  const valid: [string, string][] = [
    ['date', '2026-06-01'],
    ['time', '09:30'],
    ['time', '09:30:15'],
    ['datetime-local', '2026-06-01T09:30'],
    ['month', '2026-06'],
    ['week', '2026-W23'],
    ['color', '#0a1b2c'],
    ['range', '42'],
    ['number', '-3.5'],
  ];

  it.each(valid)('sets a %s to %s', (type, value) => {
    const element = input(type);
    const result = performSetValue(element, value);
    expect(result.type).toBe(type);
    expect(result.value).toBe(value);
  });

  it('covers every type the page model advertises', () => {
    // If a type is reported to the model as settable, something here has to
    // have set one. A type added to the list and nowhere else would otherwise
    // reach a model as an instruction it cannot carry out.
    const covered = new Set(valid.map(([type]) => type));
    for (const type of STRUCTURED_INPUT_TYPES) expect(covered.has(type), type).toBe(true);
  });

  it('fires input and change, in that order', () => {
    const element = input('date');
    const seen: string[] = [];
    element.addEventListener('input', () => seen.push('input'));
    element.addEventListener('change', () => seen.push('change'));
    performSetValue(element, '2026-06-01');
    expect(seen).toEqual(['input', 'change']);
  });

  it('bubbles, so a listener on the form sees it', () => {
    const form = document.createElement('form');
    document.body.append(form);
    const element = input('color');
    form.append(element);
    let heard = 0;
    form.addEventListener('change', () => (heard += 1));
    performSetValue(element, '#ffffff');
    expect(heard).toBe(1);
  });
});

describe('malformed values are refused, with the format named', () => {
  const malformed: [string, string][] = [
    ['date', '01/06/2026'],
    ['date', '2026-6-1'],
    ['date', 'tomorrow'],
    ['time', '9:30'],
    ['time', '25:00:00:00'],
    ['datetime-local', '2026-06-01 09:30'],
    ['month', '2026-06-01'],
    ['week', '2026-23'],
    ['color', 'red'],
    ['color', '#FFF'],
    ['color', '#FFFFFF'],
    ['range', 'seven'],
    ['number', '1,5'],
  ];

  it.each(malformed)('refuses %s value %s', (type, value) => {
    const element = input(type);
    expect(() => performSetValue(element, value)).toThrow(RangeError);
  });

  it('names the expected shape rather than saying "invalid"', () => {
    try {
      performSetValue(input('date'), '01/06/2026');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('YYYY-MM-DD');
    }
  });

  it('leaves the control untouched when it refuses', () => {
    const element = input('color', { value: '#123456' });
    expect(() => performSetValue(element, 'red')).toThrow();
    expect(element.value).toBe('#123456');
  });

  it('fires no events when it refuses', () => {
    const element = input('date');
    let heard = 0;
    element.addEventListener('change', () => (heard += 1));
    expect(() => performSetValue(element, 'nonsense')).toThrow();
    expect(heard).toBe(0);
  });
});

describe('bounds the page declared are enforced, not clamped', () => {
  it('refuses a number below the minimum', () => {
    expect(() => performSetValue(input('range', { min: '1', max: '8' }), '0')).toThrow(
      /minimum of 1/,
    );
  });

  it('refuses a number above the maximum', () => {
    expect(() => performSetValue(input('number', { min: '1', max: '10' }), '11')).toThrow(
      /maximum of 10/,
    );
  });

  it('refuses a date before the minimum', () => {
    expect(() =>
      performSetValue(input('date', { min: '2026-01-01', max: '2026-12-31' }), '2025-12-31'),
    ).toThrow(/earlier than/);
  });

  it('refuses a date after the maximum', () => {
    expect(() =>
      performSetValue(input('date', { min: '2026-01-01', max: '2026-12-31' }), '2027-01-01'),
    ).toThrow(/later than/);
  });

  it('accepts the boundary values themselves', () => {
    const element = input('range', { min: '1', max: '8' });
    expect(performSetValue(element, '1').value).toBe('1');
    expect(performSetValue(element, '8').value).toBe('8');
  });

  it('does not invent bounds a control never declared', () => {
    expect(performSetValue(input('number'), '-999999').value).toBe('-999999');
  });
});

describe('controls that cannot be set say so', () => {
  it('refuses a read-only control', () => {
    expect(() => performSetValue(input('date', { readonly: 'readonly' }), '2026-06-01')).toThrow(
      /read-only/,
    );
  });

  it('refuses a disabled control', () => {
    expect(() => performSetValue(input('date', { disabled: 'disabled' }), '2026-06-01')).toThrow(
      /disabled/,
    );
  });

  it('refuses a text field, and points at the right tool', () => {
    expect(() => performSetValue(input('text'), '2026-06-01')).toThrow(/browser\.type/);
  });

  it('refuses a checkbox, and points at the right tool', () => {
    expect(() => performSetValue(input('checkbox'), '2026-06-01')).toThrow(/set_checked/);
  });

  it('refuses something that is not an input at all', () => {
    const div = document.createElement('div');
    document.body.append(div);
    expect(() => performSetValue(div, '2026-06-01')).toThrow(TypeError);
  });

  it('refuses a password field even though it holds text', () => {
    // Not in the structured set, so it falls to the same refusal as any other
    // wrong type — worth pinning, because a password reaching a value setter
    // is exactly the argument a model should never get to make.
    expect(() => performSetValue(input('password'), 'hunter2')).toThrow(TypeError);
  });
});

describe('performSelectMany sets the whole selection', () => {
  it('selects several options by value', () => {
    const element = multiSelect(['bags', 'meal', 'wifi']);
    expect(performSelectMany(element, ['bags', 'wifi']).values).toEqual(['bags', 'wifi']);
  });

  it('matches by visible label, and case-insensitively', () => {
    const element = multiSelect(['bags', 'meal']);
    expect(performSelectMany(element, ['BAGS', 'meal']).values).toEqual(['bags', 'meal']);
  });

  it('deselects anything not in the list', () => {
    const element = multiSelect(['bags', 'meal', 'wifi']);
    performSelectMany(element, ['bags', 'meal', 'wifi']);
    expect(performSelectMany(element, ['meal']).values).toEqual(['meal']);
  });

  it('clears the selection for an empty list', () => {
    // A legitimate request, not a mistake: "none of these" is an answer.
    const element = multiSelect(['bags', 'meal']);
    performSelectMany(element, ['bags']);
    expect(performSelectMany(element, []).values).toEqual([]);
  });

  it('is idempotent, so a repeat lands on the same state', () => {
    const element = multiSelect(['bags', 'meal', 'wifi']);
    const first = performSelectMany(element, ['bags', 'wifi']).values;
    expect(performSelectMany(element, ['bags', 'wifi']).values).toEqual(first);
  });

  it('refuses an option that does not exist, listing what does', () => {
    const element = multiSelect(['bags', 'meal']);
    expect(() => performSelectMany(element, ['caviar'])).toThrow(/BAGS, MEAL/);
  });

  it('refuses a disabled option rather than silently skipping it', () => {
    const element = multiSelect(['bags', 'lounge'], ['lounge']);
    expect(() => performSelectMany(element, ['lounge'])).toThrow(/disabled/);
  });

  it('changes nothing when one option in the list is unknown', () => {
    // All or nothing. A partial application would leave the field holding
    // something the caller never asked for and was never told about.
    const element = multiSelect(['bags', 'meal']);
    performSelectMany(element, ['bags']);
    expect(() => performSelectMany(element, ['meal', 'caviar'])).toThrow();
    expect([...element.selectedOptions].map((option) => option.value)).toEqual(['bags']);
  });

  it('refuses a single-value dropdown, and points at the right tool', () => {
    const element = multiSelect(['bags']);
    element.multiple = false;
    expect(() => performSelectMany(element, ['bags'])).toThrow(/browser\.select/);
  });

  it('refuses a disabled control', () => {
    const element = multiSelect(['bags']);
    element.disabled = true;
    expect(() => performSelectMany(element, ['bags'])).toThrow(/disabled/);
  });

  it('fires input and change once, in order', () => {
    const element = multiSelect(['bags', 'meal']);
    const seen: string[] = [];
    element.addEventListener('input', () => seen.push('input'));
    element.addEventListener('change', () => seen.push('change'));
    performSelectMany(element, ['bags', 'meal']);
    expect(seen).toEqual(['input', 'change']);
  });
});
