/**
 * @vitest-environment jsdom
 *
 * TEST-BROWSER-002 — DOM interaction (REQ-BROWSER-002).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElementRegistry } from '@/content/semantic-tree';
import {
  performClick,
  performScroll,
  performSelect,
  performType,
  resolveActionable,
} from '@/content/interaction-engine';

beforeAll(() => {
  // jsdom has no layout; give elements a box so visibility checks are meaningful.
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const hidden = getComputedStyle(this).display === 'none';
    const size = hidden ? 0 : 20;
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
  Element.prototype.scrollIntoView = vi.fn();
});

function register(html: string): { registry: ElementRegistry; handle: string; element: Element } {
  document.body.innerHTML = html;
  const registry = new ElementRegistry();
  registry.beginSnapshot();
  const element = document.body.firstElementChild!;
  return { registry, handle: registry.register(element, 0), element };
}

describe('resolveActionable', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('resolves a visible, enabled element', () => {
    const { registry, handle } = register('<button>Go</button>');
    const result = resolveActionable(registry, handle);
    expect(result.ok).toBe(true);
  });

  it('refuses a handle from an earlier snapshot and says why', () => {
    const { registry, handle } = register('<button>Go</button>');
    registry.beginSnapshot();

    const result = resolveActionable(registry, handle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.failure).toBe('STALE_HANDLE');
      expect(result.error.message).toContain('Read the page again');
    }
  });

  it('refuses a detached element', () => {
    const { registry, handle, element } = register('<button>Go</button>');
    element.remove();
    const result = resolveActionable(registry, handle);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.failure).toBe('DETACHED');
  });

  it('refuses a hidden element', () => {
    const { registry, handle } = register('<button style="display:none">Go</button>');
    const result = resolveActionable(registry, handle);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.failure).toBe('NOT_VISIBLE');
  });

  it('refuses a disabled element', () => {
    const { registry, handle } = register('<button disabled>Go</button>');
    const result = resolveActionable(registry, handle);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.failure).toBe('NOT_ENABLED');
  });
});

describe('performClick', () => {
  it('dispatches the down/up/click sequence a real user produces', () => {
    const { element } = register('<button>Go</button>');
    const seen: string[] = [];
    for (const type of ['mousedown', 'mouseup', 'click']) {
      element.addEventListener(type, () => seen.push(type));
    }

    performClick(element);

    // Pointer events are best-effort; mousedown/mouseup/click are what page
    // handlers actually rely on and must always arrive, in order.
    expect(seen).toEqual(['mousedown', 'mouseup', 'click']);
  });

  it('still clicks when PointerEvent is unavailable', () => {
    const { element } = register('<button>Go</button>');
    const original = globalThis.PointerEvent;
    // @ts-expect-error deliberately removing the constructor for this test
    delete globalThis.PointerEvent;
    try {
      const clicks: string[] = [];
      element.addEventListener('click', () => clicks.push('click'));
      expect(() => performClick(element)).not.toThrow();
      expect(clicks).toEqual(['click']);
    } finally {
      globalThis.PointerEvent = original;
    }
  });

  it('focuses the element before activating it', () => {
    const { element } = register('<button>Go</button>');
    performClick(element);
    expect(document.activeElement).toBe(element);
  });
});

describe('performType', () => {
  it('sets the value and fires input and change', () => {
    const { element } = register('<input type="text">');
    const input = element as HTMLInputElement;
    const events: string[] = [];
    for (const type of ['beforeinput', 'input', 'change']) {
      input.addEventListener(type, () => events.push(type));
    }

    performType(input, 'hello');

    expect(input.value).toBe('hello');
    expect(events).toEqual(['beforeinput', 'input', 'change']);
  });

  it('uses the prototype value setter so framework trackers stay in sync', () => {
    // React shadows `value` with an instance-level setter; assigning directly
    // updates the DOM but leaves React's tracker stale, so the change is
    // dropped. Calling the prototype setter is what keeps the two in step.
    const { element } = register('<input type="text">');
    const input = element as HTMLInputElement;
    const prototypeSetter = vi.fn();
    const original = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;

    Object.defineProperty(HTMLInputElement.prototype, 'value', {
      ...original,
      set(this: HTMLInputElement, next: string) {
        prototypeSetter(next);
        original.set!.call(this, next);
      },
    });

    try {
      performType(input, 'typed');
      expect(prototypeSetter).toHaveBeenCalledWith('typed');
    } finally {
      Object.defineProperty(HTMLInputElement.prototype, 'value', original);
    }
  });

  it('replaces the existing value by default and appends when asked', () => {
    const { element } = register('<input type="text" value="old">');
    const input = element as HTMLInputElement;
    performType(input, 'new');
    expect(input.value).toBe('new');
    performType(input, '-more', { clearFirst: false });
    expect(input.value).toBe('new-more');
  });

  it('submits the containing form via requestSubmit when asked', () => {
    document.body.innerHTML = '<form><input type="text" name="q"></form>';
    const input = document.querySelector('input')!;
    const form = document.querySelector('form')!;
    // jsdom does not implement requestSubmit's activation behaviour.
    const requestSubmit = vi.fn();
    form.requestSubmit = requestSubmit;

    performType(input, 'query', { submit: true });

    expect(requestSubmit).toHaveBeenCalled();
  });

  it('writes into a contenteditable element', () => {
    const { element } = register('<div contenteditable="true"></div>');
    performType(element, 'note');
    expect(element.textContent).toBe('note');
  });

  it('refuses an element that does not accept text', () => {
    const { element } = register('<button>Go</button>');
    expect(() => performType(element, 'x')).toThrow(TypeError);
  });
});

describe('performSelect', () => {
  it('selects by option value', () => {
    const { element } = register(
      '<select><option value="a">Alpha</option><option value="b">Beta</option></select>',
    );
    expect(performSelect(element, 'b').value).toBe('b');
    expect((element as HTMLSelectElement).value).toBe('b');
  });

  it('falls back to the visible label', () => {
    const { element } = register(
      '<select><option value="a">Alpha</option><option value="b">Beta</option></select>',
    );
    expect(performSelect(element, 'Beta').value).toBe('b');
  });

  it('matches a label case-insensitively', () => {
    const { element } = register('<select><option value="a">Alpha</option></select>');
    expect(performSelect(element, 'alpha').value).toBe('a');
  });

  it('lists the available options when nothing matches', () => {
    const { element } = register('<select><option value="a">Alpha</option></select>');
    expect(() => performSelect(element, 'Gamma')).toThrow(/Alpha/);
  });

  it('fires input and change', () => {
    const { element } = register(
      '<select><option value="a">Alpha</option><option value="b">Beta</option></select>',
    );
    const events: string[] = [];
    for (const type of ['input', 'change']) element.addEventListener(type, () => events.push(type));
    performSelect(element, 'b');
    expect(events).toEqual(['input', 'change']);
  });

  it('refuses a non-select element', () => {
    const { element } = register('<input>');
    expect(() => performSelect(element, 'x')).toThrow(TypeError);
  });
});

describe('performScroll', () => {
  function fakeWindow(scrollHeight: number, innerHeight = 600) {
    let scrollY = 0;
    return {
      innerHeight,
      get scrollY() {
        return scrollY;
      },
      scrollBy: ({ top }: { top: number }) => {
        scrollY = Math.max(0, Math.min(scrollY + top, scrollHeight - innerHeight));
      },
      scrollTo: ({ top }: { top: number }) => {
        scrollY = Math.max(0, Math.min(top, scrollHeight - innerHeight));
      },
      document: { documentElement: { scrollHeight } },
    } as unknown as Window;
  }

  it('scrolls down by roughly one viewport by default', () => {
    const win = fakeWindow(5000);
    const result = performScroll(win, 'down');
    expect(result.scrollY).toBe(480);
    expect(result.atBottom).toBe(false);
  });

  it('honours an explicit amount', () => {
    expect(performScroll(fakeWindow(5000), 'down', 100).scrollY).toBe(100);
  });

  it('jumps to the bottom and reports it', () => {
    const result = performScroll(fakeWindow(2000), 'bottom');
    expect(result.scrollY).toBe(1400);
    expect(result.atBottom).toBe(true);
  });

  it('jumps to the top', () => {
    const win = fakeWindow(5000);
    performScroll(win, 'bottom');
    expect(performScroll(win, 'top').scrollY).toBe(0);
  });

  it('does not scroll above the top', () => {
    expect(performScroll(fakeWindow(5000), 'up').scrollY).toBe(0);
  });

  it('reports atBottom for a page shorter than the viewport', () => {
    expect(performScroll(fakeWindow(400), 'down').atBottom).toBe(true);
  });
});
