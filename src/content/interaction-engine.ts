/**
 * DOM interaction (specification sections 9, 58, 89).
 *
 * Interactions dispatch the same event sequence a real user produces, so
 * framework-controlled inputs (React, Vue, Angular) observe the change. A
 * naive `element.value = x` is invisible to React's synthetic event system and
 * silently loses the input — hence the native setter call below.
 */
import { isEnabled, isVisible, type ElementRegistry } from './semantic-tree';

export type InteractionFailure =
  | 'STALE_HANDLE'
  | 'DETACHED'
  | 'UNKNOWN_HANDLE'
  | 'NOT_VISIBLE'
  | 'NOT_ENABLED'
  | 'WRONG_ELEMENT_TYPE';

export interface InteractionError {
  readonly failure: InteractionFailure;
  readonly message: string;
}

export type Resolved =
  | { readonly ok: true; readonly element: Element }
  | { readonly ok: false; readonly error: InteractionError };

/** Resolves a handle and asserts the element is actually actionable. */
export function resolveActionable(registry: ElementRegistry, handle: string): Resolved {
  const resolution = registry.resolve(handle);

  switch (resolution.status) {
    case 'stale':
      return {
        ok: false,
        error: {
          failure: 'STALE_HANDLE',
          message:
            'This element handle is from an earlier snapshot of the page. Read the page again to get current handles.',
        },
      };
    case 'detached':
      return {
        ok: false,
        error: {
          failure: 'DETACHED',
          message: 'The element was removed from the page. Read the page again.',
        },
      };
    case 'unknown':
      return {
        ok: false,
        error: {
          failure: 'UNKNOWN_HANDLE',
          message: 'No element matches that handle. Read the page again.',
        },
      };
    case 'ok':
      break;
  }

  const element = resolution.element;
  if (!isVisible(element)) {
    return {
      ok: false,
      error: { failure: 'NOT_VISIBLE', message: 'The element is not visible on screen.' },
    };
  }
  if (!isEnabled(element)) {
    return {
      ok: false,
      error: { failure: 'NOT_ENABLED', message: 'The element is disabled.' },
    };
  }
  return { ok: true, element };
}

export function scrollIntoView(element: Element): void {
  element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
}

/**
 * Dispatches one event of a click sequence.
 *
 * Two fallbacks, both of which matter outside a plain browser tab:
 *  - `PointerEvent` is absent in some embedded contexts, so the equivalent
 *    mouse event is sent instead.
 *  - Some environments reject a `view` member that is not their own `Window`
 *    brand. The event is retried without it rather than aborting the click,
 *    since `view` is rarely read by page handlers.
 */
function dispatchClickEvent(element: Element, type: string, init: MouseEventInit): void {
  const isPointer = type.startsWith('pointer');
  const { view: _view, ...withoutView } = init;

  const attempts: (() => Event)[] = [];
  if (isPointer && typeof PointerEvent === 'function') {
    attempts.push(() => new PointerEvent(type, { ...init, pointerId: 1 }));
    attempts.push(() => new PointerEvent(type, { ...withoutView, pointerId: 1 }));
  }
  const mouseType = isPointer ? (type === 'pointerdown' ? 'mousedown' : 'mouseup') : type;
  attempts.push(() => new MouseEvent(mouseType, init));
  attempts.push(() => new MouseEvent(mouseType, withoutView));

  for (const attempt of attempts) {
    let event: Event;
    try {
      event = attempt();
    } catch {
      continue;
    }
    element.dispatchEvent(event);
    return;
  }
}

/** Clicks an element the way a user would. */
export function performClick(element: Element): void {
  scrollIntoView(element);

  if (element instanceof HTMLElement) {
    const rect = element.getBoundingClientRect();
    const view = element.ownerDocument.defaultView;
    const init: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      // A detached document has no defaultView, and passing null throws.
      ...(view === null ? {} : { view }),
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2),
      button: 0,
    };

    dispatchClickEvent(element, 'pointerdown', init);
    dispatchClickEvent(element, 'mousedown', init);
    element.focus({ preventScroll: true });
    dispatchClickEvent(element, 'pointerup', init);
    dispatchClickEvent(element, 'mouseup', init);
    // `click()` fires the activation behaviour (form submit, link follow) that
    // a synthesised MouseEvent alone does not always trigger.
    element.click();
    return;
  }
  dispatchClickEvent(element, 'click', { bubbles: true, cancelable: true });
}

/**
 * Sets a form control's value through its native setter.
 *
 * React installs a value setter on the element instance that shadows the
 * prototype's; assigning directly updates the DOM but leaves React's internal
 * tracker stale, so the change event is discarded. Calling the prototype
 * setter bypasses the instance property and keeps the tracker in sync.
 */
function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = Object.getPrototypeOf(element) as object;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor?.set) {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }
}

export interface TypeOptions {
  readonly clearFirst?: boolean;
  readonly submit?: boolean;
}

export function performType(element: Element, text: string, options: TypeOptions = {}): void {
  scrollIntoView(element);

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.focus({ preventScroll: true });
    const next = options.clearFirst === false ? element.value + text : text;

    element.dispatchEvent(
      new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: text }),
    );
    setNativeValue(element, next);
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    element.dispatchEvent(new Event('change', { bubbles: true }));

    if (options.submit) {
      const enterInit: KeyboardEventInit = {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
      };
      element.dispatchEvent(new KeyboardEvent('keydown', enterInit));
      element.dispatchEvent(new KeyboardEvent('keyup', enterInit));
      // `requestSubmit` runs validation and fires `submit`, unlike `.submit()`.
      element.form?.requestSubmit();
    }
    return;
  }

  // `isContentEditable` is the correct check but is not implemented
  // everywhere, so the attribute is accepted as a fallback.
  if (element instanceof HTMLElement && isEditableHost(element)) {
    element.focus({ preventScroll: true });
    if (options.clearFirst !== false) element.textContent = '';
    element.textContent = (element.textContent ?? '') + text;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    return;
  }

  throw new TypeError('This element does not accept text input.');
}

function isEditableHost(element: HTMLElement): boolean {
  if (element.isContentEditable) return true;
  const attribute = element.getAttribute('contenteditable');
  return attribute === '' || attribute?.toLowerCase() === 'true';
}

export interface SelectResult {
  readonly value: string;
}

/** Selects an option by value, then by visible label. */
export function performSelect(element: Element, value: string): SelectResult {
  if (!(element instanceof HTMLSelectElement)) {
    throw new TypeError('This element is not a select control.');
  }
  scrollIntoView(element);
  element.focus({ preventScroll: true });

  const options = [...element.options];
  const match =
    options.find((option) => option.value === value) ??
    options.find((option) => option.text.trim() === value.trim()) ??
    options.find((option) => option.text.trim().toLowerCase() === value.trim().toLowerCase());

  if (!match) {
    const available = options
      .slice(0, 20)
      .map((o) => o.text.trim())
      .join(', ');
    throw new RangeError(`No option matches "${value}". Available options: ${available}`);
  }

  element.value = match.value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { value: match.value };
}

export interface CheckedResult {
  readonly checked: boolean;
  readonly value: string;
  readonly kind: 'checkbox' | 'radio';
}

/**
 * Sets a checkbox or radio to a specific state.
 *
 * Expressed as "make it this" rather than "toggle it" on purpose. A toggle has
 * to be right about the current state to produce the intended one, and a model
 * working from a stale snapshot would silently invert the answer — the sort of
 * error that submits the opposite of what was asked without failing.
 *
 * A radio cannot be unset by clearing it: the group is what holds the value,
 * so asking for `false` on a radio is a request the DOM has no way to satisfy
 * and is refused rather than quietly ignored.
 */
export function performSetChecked(element: Element, checked: boolean): CheckedResult {
  if (!(element instanceof HTMLInputElement)) {
    throw new TypeError('This element is not an input control.');
  }
  const kind = element.type === 'checkbox' ? 'checkbox' : element.type === 'radio' ? 'radio' : null;
  if (kind === null) {
    throw new TypeError(`This input is a "${element.type}", not a checkbox or radio.`);
  }
  if (element.readOnly) {
    throw new TypeError('This control is read-only.');
  }
  if (kind === 'radio' && !checked) {
    throw new RangeError(
      'A radio button cannot be cleared on its own. Select a different option in the group.',
    );
  }

  scrollIntoView(element);
  element.focus({ preventScroll: true });

  if (element.checked !== checked) {
    // `click()` rather than assigning `.checked`, so the activation behaviour
    // runs: label association, radio-group exclusivity and any framework
    // listener all depend on the real event sequence.
    element.click();
  }

  // The click may have been intercepted — a label overlay, a handler calling
  // preventDefault. Reporting success without looking would tell the model the
  // form says something it does not.
  if (element.checked !== checked) {
    throw new Error(
      `The control did not change state; it is still ${element.checked ? 'checked' : 'unchecked'}.`,
    );
  }

  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { checked: element.checked, value: element.value, kind };
}

export type ScrollDirection = 'up' | 'down' | 'top' | 'bottom';

export interface ScrollResult {
  readonly scrollY: number;
  readonly atBottom: boolean;
}

export function performScroll(
  win: Window,
  direction: ScrollDirection,
  amount?: number,
): ScrollResult {
  const step = amount ?? Math.round(win.innerHeight * 0.8);
  const doc = win.document.documentElement;

  switch (direction) {
    case 'up':
      win.scrollBy({ top: -step, behavior: 'instant' });
      break;
    case 'down':
      win.scrollBy({ top: step, behavior: 'instant' });
      break;
    case 'top':
      win.scrollTo({ top: 0, behavior: 'instant' });
      break;
    case 'bottom':
      win.scrollTo({ top: doc.scrollHeight, behavior: 'instant' });
      break;
  }

  const scrollY = win.scrollY;
  // 2px tolerance absorbs fractional device-pixel rounding.
  const atBottom = scrollY + win.innerHeight >= doc.scrollHeight - 2;
  return { scrollY, atBottom };
}
