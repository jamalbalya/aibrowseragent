/**
 * Semantic page model (specification section 8).
 *
 * The agent reasons over roles and accessible names, not raw DOM. A model that
 * is told to click `#submit` breaks the moment the markup changes; one told to
 * click the button named "Submit" survives it.
 *
 * Element ids (`e17`) are valid only for the snapshot that produced them —
 * every read issues a fresh generation, and a stale id is rejected rather than
 * silently resolving to a different element.
 */

export interface SemanticElement {
  /** Snapshot-scoped handle the model uses to target this element. */
  readonly elementId: string;
  readonly role: string;
  /** Accessible name, computed from label/aria/text. */
  readonly name: string;
  readonly text?: string;
  readonly value?: string;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly focused?: boolean;
  readonly checked?: boolean;
  readonly required?: boolean;
  readonly placeholder?: string;
  /** Best-effort CSS selectors, used only as a recovery hint. */
  readonly selectorHints: readonly string[];
  readonly frameId: string;
  /** Options for a select element. */
  readonly options?: readonly string[];
  readonly href?: string;
  /** `accept` attribute of a file input, when it sets one. */
  readonly accept?: string;
  /** Whether a file input takes more than one file. */
  readonly multiple?: boolean;
}

export interface SemanticPage {
  readonly url: string;
  readonly title: string;
  /** Monotonic per-document counter; a handle from an older generation is stale. */
  readonly generation: number;
  readonly capturedAt: number;
  readonly readyState: string;
  /** Visible text content, truncated to the extraction cap. */
  readonly text: string;
  readonly textTruncated: boolean;
  readonly elements: readonly SemanticElement[];
  readonly elementsTruncated: boolean;
  readonly scrollY: number;
  readonly documentHeight: number;
  readonly viewportHeight: number;
}

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="combobox"]',
  '[role="switch"]',
  '[role="searchbox"]',
  '[role="textbox"]',
  '[contenteditable="true"]',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Elements whose text is chrome, not content. */
const TEXT_EXCLUDED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD']);

export const DEFAULT_MAX_ELEMENTS = 300;
export const DEFAULT_MAX_TEXT_LENGTH = 40_000;

/**
 * Element registry for one document.
 *
 * Holds the mapping from handle to live node so a later `click` can resolve
 * the same element without re-querying, and invalidates the whole mapping when
 * a new snapshot is taken.
 */
export class ElementRegistry {
  private generation = 0;
  private elements = new Map<string, Element>();

  /** Starts a new generation, invalidating every previously issued handle. */
  beginSnapshot(): number {
    this.generation += 1;
    this.elements = new Map();
    return this.generation;
  }

  currentGeneration(): number {
    return this.generation;
  }

  register(element: Element, index: number): string {
    const handle = `e${this.generation}-${index}`;
    this.elements.set(handle, element);
    return handle;
  }

  /**
   * Resolves a handle.
   *
   * Returns `stale` when the handle came from an earlier snapshot, and
   * `detached` when the element has since left the document — two distinct
   * conditions the caller reports differently.
   */
  resolve(
    handle: string,
  ): { status: 'ok'; element: Element } | { status: 'stale' | 'detached' | 'unknown' } {
    const generation = Number(handle.split('-')[0]?.slice(1));
    if (!Number.isFinite(generation)) return { status: 'unknown' };
    if (generation !== this.generation) return { status: 'stale' };

    const element = this.elements.get(handle);
    if (!element) return { status: 'unknown' };
    if (!element.isConnected) return { status: 'detached' };
    return { status: 'ok', element };
  }
}

export function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) return false;
  const style = getComputedStyle(element);
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse'
  ) {
    return false;
  }
  // `Number('')` is 0, so an unset or unreadable opacity would make every
  // element look invisible. Parse defensively and only reject a value that
  // genuinely resolves to zero.
  const opacity = Number.parseFloat(style.opacity);
  if (Number.isFinite(opacity) && opacity === 0) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  // `checkVisibility` accounts for content-visibility and inert subtrees.
  if (typeof element.checkVisibility === 'function') {
    return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }
  return true;
}

export function isEnabled(element: Element): boolean {
  if (element.hasAttribute('disabled')) return false;
  if (element.getAttribute('aria-disabled') === 'true') return false;
  const fieldset = element.closest('fieldset[disabled]');
  return fieldset === null;
}

/** Implicit ARIA role for an element, falling back to the tag name. */
export function roleOf(element: Element): string {
  const explicit = element.getAttribute('role');
  if (explicit) return explicit.trim().toLowerCase();

  const tag = element.tagName.toLowerCase();
  switch (tag) {
    case 'a':
      return element.hasAttribute('href') ? 'link' : 'generic';
    case 'button':
      return 'button';
    case 'select':
      return element.hasAttribute('multiple') ? 'listbox' : 'combobox';
    case 'textarea':
      return 'textbox';
    case 'summary':
      return 'button';
    case 'input': {
      const type = (element.getAttribute('type') ?? 'text').toLowerCase();
      switch (type) {
        case 'checkbox':
          return 'checkbox';
        case 'radio':
          return 'radio';
        case 'button':
        case 'submit':
        case 'reset':
        case 'image':
          return 'button';
        case 'range':
          return 'slider';
        case 'search':
          return 'searchbox';
        case 'number':
          return 'spinbutton';
        // Reported as its own role rather than falling through to `textbox`.
        // A model told a file input is a textbox will try to type a path into
        // it, which cannot work and produces a confusing failure instead of a
        // usable one.
        case 'file':
          return 'file';
        default:
          return 'textbox';
      }
    }
    default:
      return tag;
  }
}

/**
 * Roles whose accessible name may be derived from their own text content
 * (the accname "name from content" set).
 *
 * Form controls are deliberately absent. A `<select>` that falls through to
 * `textContent` is named after its own options — an unlabelled dropdown came
 * back as "AlphaBeta" in a real browser — and a contenteditable textbox is
 * named after whatever the user typed into it. In both cases the text is the
 * control's *value*, which is reported separately, not a label the model can
 * usefully target.
 */
const NAME_FROM_CONTENT_ROLES: ReadonlySet<string> = new Set([
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'gridcell',
  'heading',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'row',
  'rowheader',
  'switch',
  'tab',
  'tooltip',
  'treeitem',
]);

/**
 * Accessible name.
 *
 * Follows the practical precedence of the accname spec: aria-labelledby,
 * aria-label, associated <label>, then — only for roles that permit it —
 * visible text, then placeholder and title.
 */
export function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
    if (text) return normaliseWhitespace(text);
  }

  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel?.trim()) return normaliseWhitespace(ariaLabel);

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  ) {
    const labels = element.labels;
    if (labels && labels.length > 0) {
      const text = [...labels]
        .map((l) => l.textContent ?? '')
        .join(' ')
        .trim();
      if (text) return normaliseWhitespace(text);
    }
    if (element instanceof HTMLInputElement) {
      const type = element.type.toLowerCase();
      if ((type === 'submit' || type === 'button' || type === 'reset') && element.value) {
        return normaliseWhitespace(element.value);
      }
      if (type === 'image' && element.alt) return normaliseWhitespace(element.alt);
    }
  }

  if (element instanceof HTMLImageElement && element.alt) {
    return normaliseWhitespace(element.alt);
  }

  // Only roles in the name-from-content set may be named by their own text.
  if (NAME_FROM_CONTENT_ROLES.has(roleOf(element))) {
    const text = element.textContent?.trim();
    if (text) return normaliseWhitespace(text).slice(0, 200);
  }

  const placeholder = element.getAttribute('placeholder');
  if (placeholder?.trim()) return normaliseWhitespace(placeholder);

  const title = element.getAttribute('title');
  if (title?.trim()) return normaliseWhitespace(title);

  return '';
}

function normaliseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Up to three selectors, most stable first, used only for recovery. */
export function selectorHints(element: Element): string[] {
  const hints: string[] = [];
  if (element.id && /^[A-Za-z][\w-]*$/.test(element.id)) hints.push(`#${element.id}`);

  const testId =
    element.getAttribute('data-testid') ??
    element.getAttribute('data-test-id') ??
    element.getAttribute('data-test');
  if (testId) hints.push(`[data-testid="${cssEscape(testId)}"]`);

  const name = element.getAttribute('name');
  if (name) hints.push(`${element.tagName.toLowerCase()}[name="${cssEscape(name)}"]`);

  if (hints.length === 0) {
    const classes = [...element.classList]
      .filter((c) => /^[A-Za-z][\w-]*$/.test(c) && c.length < 40)
      .slice(0, 2);
    if (classes.length > 0) {
      hints.push(`${element.tagName.toLowerCase()}.${classes.join('.')}`);
    }
  }
  return hints.slice(0, 3);
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

export interface ExtractOptions {
  readonly maxElements?: number;
  readonly maxTextLength?: number;
  readonly includeText?: boolean;
  readonly frameId?: string;
}

/** Builds a semantic snapshot of a document. */
export function extractSemanticPage(
  doc: Document,
  registry: ElementRegistry,
  options: ExtractOptions = {},
): SemanticPage {
  const maxElements = options.maxElements ?? DEFAULT_MAX_ELEMENTS;
  const maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const frameId = options.frameId ?? 'main';

  const generation = registry.beginSnapshot();
  const candidates = [...doc.querySelectorAll(INTERACTIVE_SELECTOR)];
  const elements: SemanticElement[] = [];

  let index = 0;
  for (const candidate of candidates) {
    if (elements.length >= maxElements) break;

    const visible = isVisible(candidate);
    // Hidden elements are normally left out: a model should not act on
    // something the user cannot see. File inputs are the one exception, and
    // only because the common way to build an upload control is a styled
    // button beside an `input[type=file]` that is deliberately hidden. Leaving
    // those out would mean uploads work on almost no real site.
    //
    // Attaching to one is not the same as clicking something invisible: the
    // file was chosen by the user in a picker, the attach passes the egress
    // gate, and the permission prompt names both the file and the origin. The
    // element is reported as not visible rather than described as if it were.
    if (!visible && !isHiddenFileInput(candidate)) continue;

    const handle = registry.register(candidate, index);
    index += 1;
    elements.push(describeElement(candidate, handle, frameId, visible));
  }

  const view = doc.defaultView;
  const rawText = options.includeText === false ? '' : visibleText(doc, maxTextLength + 1);
  const textTruncated = rawText.length > maxTextLength;

  return {
    url: doc.location?.href ?? '',
    title: doc.title,
    generation,
    capturedAt: Date.now(),
    readyState: doc.readyState,
    text: textTruncated ? rawText.slice(0, maxTextLength) : rawText,
    textTruncated,
    elements,
    elementsTruncated: candidates.length > elements.length && elements.length >= maxElements,
    scrollY: view?.scrollY ?? 0,
    documentHeight: doc.documentElement?.scrollHeight ?? 0,
    viewportHeight: view?.innerHeight ?? 0,
  };
}

/** A file input the page has hidden behind its own styled control. */
export function isHiddenFileInput(element: Element): boolean {
  return element instanceof HTMLInputElement && element.type.toLowerCase() === 'file';
}

function describeElement(
  element: Element,
  handle: string,
  frameId: string,
  visible: boolean,
): SemanticElement {
  const role = roleOf(element);
  const base = {
    elementId: handle,
    role,
    name: accessibleName(element),
    visible,
    enabled: isEnabled(element),
    selectorHints: selectorHints(element),
    frameId,
  };

  const extras: Record<string, unknown> = {};

  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    // Never read a password field's value into the page model. A file input's
    // `value` is a fake path the browser synthesises ("C:\\fakepath\\x.pdf")
    // and says nothing useful, so it is left out too; the names of any files
    // already attached are reported instead.
    if (type !== 'password' && type !== 'hidden' && type !== 'file') {
      extras.value = element.value.slice(0, 500);
    }
    if (type === 'file') {
      if (element.accept) extras.accept = element.accept.slice(0, 200);
      if (element.multiple) extras.multiple = true;
      const attached = [...(element.files ?? [])].map((file) => file.name);
      if (attached.length > 0) extras.text = attached.join(', ').slice(0, 300);
    }
    if (type === 'checkbox' || type === 'radio') extras.checked = element.checked;
    if (element.placeholder) extras.placeholder = element.placeholder;
    if (element.required) extras.required = true;
  } else if (element instanceof HTMLTextAreaElement) {
    extras.value = element.value.slice(0, 500);
    if (element.placeholder) extras.placeholder = element.placeholder;
    if (element.required) extras.required = true;
  } else if (element instanceof HTMLSelectElement) {
    extras.value = element.value;
    extras.options = [...element.options].slice(0, 100).map((o) => o.text.trim());
  } else if (element instanceof HTMLAnchorElement && element.href) {
    extras.href = element.href.slice(0, 500);
  }

  if (element.ownerDocument.activeElement === element) extras.focused = true;

  // Descriptive text, for roles where it is genuinely descriptive. A form
  // control's text content is its value, already reported above.
  if (NAME_FROM_CONTENT_ROLES.has(role)) {
    const text = element.textContent?.trim();
    if (text && text !== base.name) {
      extras.text = normaliseWhitespace(text).slice(0, 300);
    }
  }

  return { ...base, ...extras };
}

/** Concatenates visible text, skipping script/style and hidden subtrees. */
export function visibleText(doc: Document, limit: number): string {
  const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (TEXT_EXCLUDED_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (!node.textContent || node.textContent.trim().length === 0) {
        return NodeFilter.FILTER_REJECT;
      }
      return isVisible(parent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const parts: string[] = [];
  let total = 0;
  let node = walker.nextNode();
  while (node && total < limit) {
    const text = normaliseWhitespace(node.textContent ?? '');
    if (text.length > 0) {
      parts.push(text);
      total += text.length + 1;
    }
    node = walker.nextNode();
  }
  return parts.join('\n').slice(0, limit);
}
