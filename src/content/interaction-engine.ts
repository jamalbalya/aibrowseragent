/**
 * DOM interaction (specification sections 9, 58, 89).
 *
 * Interactions dispatch the same event sequence a real user produces, so
 * framework-controlled inputs (React, Vue, Angular) observe the change. A
 * naive `element.value = x` is invisible to React's synthetic event system and
 * silently loses the input — hence the native setter call below.
 */
import { isEnabled, isVisible, type ElementRegistry } from './semantic-tree';
import { matchesAccept } from '@/files/file-model';
import { STRUCTURED_INPUT_TYPES, type StructuredInputType } from './form-controls';

export type InteractionFailure =
  | 'STALE_HANDLE'
  | 'DETACHED'
  | 'UNKNOWN_HANDLE'
  | 'NOT_VISIBLE'
  | 'NOT_ENABLED'
  | 'WRONG_ELEMENT_TYPE'
  | 'TOO_MANY_FILES'
  | 'ACCEPT_MISMATCH'
  | 'ASSIGNMENT_REFUSED';

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

/**
 * The format each type accepts, as the HTML specification defines it.
 *
 * Validated here rather than left to the browser alone for one reason: a
 * browser silently clears a value it cannot parse, so a model that sent
 * `12/03/2026` to a date field would be told the field is now empty and would
 * have no idea why. Checking first turns that into a message naming the
 * format.
 */
const VALUE_FORMATS: Record<StructuredInputType, { pattern: RegExp; shape: string }> = {
  date: { pattern: /^\d{4}-\d{2}-\d{2}$/, shape: 'YYYY-MM-DD' },
  time: { pattern: /^\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/, shape: 'HH:MM or HH:MM:SS' },
  'datetime-local': {
    pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/,
    shape: 'YYYY-MM-DDTHH:MM',
  },
  month: { pattern: /^\d{4}-\d{2}$/, shape: 'YYYY-MM' },
  week: { pattern: /^\d{4}-W\d{2}$/, shape: 'YYYY-Www' },
  // Lower-case six-digit hex is the only form the DOM keeps; `red` and
  // `#ABC` are both valid CSS and neither survives a round trip.
  color: { pattern: /^#[0-9a-f]{6}$/, shape: '#rrggbb in lower case' },
  range: { pattern: /^-?\d+(\.\d+)?$/, shape: 'a number' },
  number: { pattern: /^-?\d+(\.\d+)?$/, shape: 'a number' },
};

export interface ValueResult {
  readonly value: string;
  readonly type: StructuredInputType;
  /** Present when the control clamped or snapped what was asked for. */
  readonly adjusted?: boolean;
}

/**
 * Sets a structured input to a value, in the format that control accepts.
 *
 * Deliberately not `performType`. Typing into a date field types into whatever
 * segment happens to have focus, so the same keystrokes mean different things
 * depending on where the caret was — and on a `range` there is nothing to type
 * into at all. Assigning the value and firing the events the page listens for
 * is what these controls actually respond to.
 *
 * What it will not do is decide what the page meant. A value outside `min` and
 * `max` is refused rather than clamped: a model that asked for a date outside
 * the allowed window has made a mistake, and silently moving it to the nearest
 * legal one submits something nobody chose.
 */
export function performSetValue(element: Element, value: string): ValueResult {
  if (!(element instanceof HTMLInputElement)) {
    throw new TypeError('This element is not an input control.');
  }
  const type = element.type.toLowerCase() as StructuredInputType;
  if (!(STRUCTURED_INPUT_TYPES as readonly string[]).includes(type)) {
    throw new TypeError(
      `This input is a "${element.type}". Use browser.type for text fields, ` +
        'browser.select for dropdowns and browser.set_checked for checkboxes.',
    );
  }
  if (element.readOnly) throw new TypeError('This control is read-only.');
  if (element.disabled) throw new TypeError('This control is disabled.');

  const format = VALUE_FORMATS[type];
  if (!format.pattern.test(value)) {
    throw new RangeError(`"${value}" is not a valid ${type} value. Expected ${format.shape}.`);
  }

  // Bounds are the page's rules about its own field, so they are enforced
  // rather than discovered by watching the value change underneath us.
  if (type === 'range' || type === 'number') {
    const numeric = Number(value);
    const min = element.min === '' ? undefined : Number(element.min);
    const max = element.max === '' ? undefined : Number(element.max);
    if (min !== undefined && numeric < min) {
      throw new RangeError(`${value} is below this control's minimum of ${element.min}.`);
    }
    if (max !== undefined && numeric > max) {
      throw new RangeError(`${value} is above this control's maximum of ${element.max}.`);
    }
  }
  if (element.min !== '' && type !== 'range' && type !== 'number' && value < element.min) {
    throw new RangeError(`${value} is earlier than this control's minimum of ${element.min}.`);
  }
  if (element.max !== '' && type !== 'range' && type !== 'number' && value > element.max) {
    throw new RangeError(`${value} is later than this control's maximum of ${element.max}.`);
  }

  scrollIntoView(element);
  element.focus({ preventScroll: true });
  // Kept so a rejection can be undone. Assigning is how the browser is asked
  // whether it will accept a value, and its way of saying no is to clear the
  // field — so asking destroys what was there unless it is put back.
  const previous = element.value;
  element.value = value;

  // Read back. An empty string here means the browser rejected the value
  // outright; a different string means it snapped to a legal step. Either way
  // the caller is told what the field actually holds rather than what was
  // asked for.
  //
  // `2026-02-30` is the case this exists for: well-formed, matches the
  // pattern, and is not a date. No amount of checking the string first
  // catches it, because the calendar is the browser's business.
  const settled = element.value;
  if (settled === '') {
    element.value = previous;
    throw new RangeError(
      `The control did not accept "${value}". It expects ${format.shape} and may restrict the range further.`,
    );
  }

  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { value: settled, type, ...(settled === value ? {} : { adjusted: true }) };
}

export interface SelectManyResult {
  readonly values: readonly string[];
}

/**
 * Sets every selected option of a multi-select at once.
 *
 * Expressed as the whole selection rather than as "also select this", for the
 * same reason `set_checked` is not a toggle: an additive call has to be right
 * about what is already selected, and a model working from a stale snapshot
 * would leave options set that it believed it had cleared. Passing the
 * complete list makes the call say what the field should end up holding.
 *
 * An empty list is a legitimate request — it clears the selection — so it is
 * accepted rather than treated as a mistake.
 */
export function performSelectMany(element: Element, values: readonly string[]): SelectManyResult {
  if (!(element instanceof HTMLSelectElement)) {
    throw new TypeError('This element is not a select control.');
  }
  if (!element.multiple) {
    throw new TypeError('This dropdown takes one value. Use browser.select instead.');
  }
  if (element.disabled) throw new TypeError('This control is disabled.');

  const options = [...element.options];
  const resolved: HTMLOptionElement[] = [];
  for (const wanted of values) {
    const match =
      options.find((option) => option.value === wanted) ??
      options.find((option) => option.text.trim() === wanted.trim()) ??
      options.find((option) => option.text.trim().toLowerCase() === wanted.trim().toLowerCase());
    if (!match) {
      const available = options
        .slice(0, 20)
        .map((option) => option.text.trim())
        .join(', ');
      throw new RangeError(`No option matches "${wanted}". Available options: ${available}`);
    }
    if (match.disabled) {
      throw new RangeError(`The option "${wanted}" is disabled.`);
    }
    resolved.push(match);
  }

  scrollIntoView(element);
  element.focus({ preventScroll: true });
  const chosen = new Set(resolved);
  for (const option of options) option.selected = chosen.has(option);

  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { values: [...element.selectedOptions].map((option) => option.value) };
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

/**
 * Resolves a file input for attachment.
 *
 * Separate from `resolveActionable` for one reason: it does **not** require
 * the element to be visible. The usual upload control is a styled button next
 * to an `input[type=file]` the page has hidden, and refusing hidden elements
 * here would refuse most real upload forms. Everything else is stricter, not
 * looser — the element must exist, must be a file input, and must be enabled.
 */
export function resolveFileInput(registry: ElementRegistry, handle: string): Resolved {
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
        error: { failure: 'UNKNOWN_HANDLE', message: 'No element matches that handle.' },
      };
    case 'ok':
      break;
  }

  const element = resolution.element;
  if (!(element instanceof HTMLInputElement) || element.type.toLowerCase() !== 'file') {
    return {
      ok: false,
      error: {
        failure: 'WRONG_ELEMENT_TYPE',
        message: 'That element is not a file input.',
      },
    };
  }
  if (!isEnabled(element)) {
    return {
      ok: false,
      error: { failure: 'NOT_ENABLED', message: 'The file input is disabled.' },
    };
  }
  return { ok: true, element };
}

/** One file, as it arrives over extension messaging. */
export interface AttachableFile {
  readonly name: string;
  readonly mimeType: string;
  /** Base64, because extension messaging is a JSON channel. */
  readonly dataBase64: string;
}

export interface AttachResult {
  readonly attached: number;
  readonly names: readonly string[];
  /** True when the input was hidden, which is the usual case on real forms. */
  readonly inputWasHidden: boolean;
}

/**
 * Puts files into a file input.
 *
 * Uses `DataTransfer`, which is the only way to populate `input.files`
 * programmatically — a file input's `value` is not writable to anything but
 * the empty string, by design. This runs in the content script's isolated
 * world and touches only the DOM; no script is injected into the page and
 * nothing is evaluated there.
 *
 * The events dispatched afterwards are **not** trusted events, because
 * nothing an extension synthesises is. A page that requires `isTrusted` will
 * ignore them, and that is a real limitation rather than something this can
 * work around — which is why the assignment is verified and a failure is
 * reported rather than assumed away.
 */
export function performAttachFiles(
  element: HTMLInputElement,
  files: readonly AttachableFile[],
): AttachResult {
  if (files.length === 0) {
    throw Object.assign(new Error('No files were supplied.'), { failure: 'TOO_MANY_FILES' });
  }
  if (files.length > 1 && !element.multiple) {
    throw attachError(
      'TOO_MANY_FILES',
      `This input accepts one file, but ${files.length} were supplied.`,
    );
  }

  const accept = element.getAttribute('accept') ?? undefined;
  for (const file of files) {
    if (!matchesAccept(accept, file.name, file.mimeType)) {
      throw attachError(
        'ACCEPT_MISMATCH',
        `"${file.name}" does not match what this input accepts (${accept ?? 'any'}).`,
      );
    }
  }

  const inputWasHidden = !isVisible(element);
  const transfer = new DataTransfer();
  for (const file of files) {
    transfer.items.add(
      new File([base64ToBytes(file.dataBase64)], file.name, {
        type: file.mimeType,
        lastModified: Date.now(),
      }),
    );
  }

  element.files = transfer.files;

  // The assignment is verified rather than assumed. A page can define its own
  // `files` accessor, and a silent no-op would otherwise be reported to the
  // model as a successful upload.
  if (element.files.length !== files.length) {
    throw attachError(
      'ASSIGNMENT_REFUSED',
      'The page did not accept the files. Nothing was attached.',
    );
  }

  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

  return {
    attached: element.files.length,
    names: [...element.files].map((file) => file.name),
    inputWasHidden,
  };
}

/** Clears a file input, so a wrong attachment can be undone without a reload. */
export function performClearFiles(element: HTMLInputElement): void {
  element.files = new DataTransfer().files;
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

function attachError(failure: InteractionFailure, message: string): Error {
  return Object.assign(new Error(message), { failure });
}

/**
 * Decodes base64 into bytes.
 *
 * `atob` yields a binary string, which has to be widened byte by byte; using
 * it directly as file content would mangle anything non-ASCII.
 */
function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
