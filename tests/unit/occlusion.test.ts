/**
 * @vitest-environment jsdom
 *
 * TEST-FORMS-002 — is something covering this element? (§89 modal)
 *
 * This check exists because executing §89's modal procedure found the
 * extension reporting a successful click on a button underneath a cookie
 * dialog. `isVisible` said yes, correctly: the button was displayed, opaque,
 * had a box, and passed `checkVisibility`. None of those notice what is
 * painted on top, and a synthetic click reaches the node regardless — so the
 * report was truthful about the code and wrong about the page.
 *
 * jsdom has no layout and therefore no `elementFromPoint`, which is why these
 * cases supply one. That is not a fake standing in for the real thing: the
 * geometry is exactly what the real method returns for the arrangement being
 * described, and what is under test is the sampling and the allowances, not
 * the browser's hit-testing. The behaviour in a browser that does have layout
 * is settled in `browser-failures.spec.ts` against a real overlay.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isObscured, scrollIntoViewAndAssertReachable } from '@/content/interaction-engine';

interface Stub {
  readonly element: HTMLElement;
  /** Points the stub was asked about, in the order it was asked. */
  readonly asked: [number, number][];
}

/**
 * An element with a known box, and a document that answers hit tests from a
 * caller-supplied function.
 */
function place(
  box: { x: number; y: number; width: number; height: number },
  topmost: (x: number, y: number) => Element | null,
): Stub {
  const element = document.createElement('button');
  element.textContent = 'Buy now';
  document.body.append(element);
  element.getBoundingClientRect = () => ({
    left: box.x,
    top: box.y,
    right: box.x + box.width,
    bottom: box.y + box.height,
    width: box.width,
    height: box.height,
    x: box.x,
    y: box.y,
    toJSON: () => ({}),
  });

  const asked: [number, number][] = [];
  (document as unknown as { elementFromPoint: unknown }).elementFromPoint = (
    x: number,
    y: number,
  ) => {
    asked.push([x, y]);
    return topmost(x, y);
  };
  return { element, asked };
}

afterEach(() => {
  document.body.innerHTML = '';
  delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
  vi.restoreAllMocks();
});

describe('an element nothing covers is reachable', () => {
  it('reports not obscured when the element is topmost everywhere', () => {
    const { element } = place({ x: 10, y: 10, width: 100, height: 40 }, () => null);
    // The stub returns null until the element exists, so point it at itself.
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = () => element;
    expect(isObscured(element)).toBe(false);
  });

  it('accepts the element’s own child as topmost', () => {
    // A button's label sits in a span, and the span is what a hit test
    // returns. Treating that as "something else is on top" would refuse every
    // ordinary button on the web.
    const { element } = place({ x: 0, y: 0, width: 80, height: 30 }, () => null);
    const span = document.createElement('span');
    span.textContent = 'Buy now';
    element.append(span);
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = () => span;
    expect(isObscured(element)).toBe(false);
  });

  it('accepts an ancestor as topmost', () => {
    // A `<label>` wrapping an input, or a link wrapping its own text: a click
    // landing on the wrapper still reaches the control.
    const label = document.createElement('label');
    document.body.append(label);
    const { element } = place({ x: 0, y: 0, width: 80, height: 30 }, () => null);
    label.append(element);
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = () => label;
    expect(isObscured(element)).toBe(false);
  });
});

describe('an element something covers is refused', () => {
  it('reports obscured when an overlay is topmost at every point', () => {
    const overlay = document.createElement('div');
    document.body.append(overlay);
    const { element } = place({ x: 0, y: 0, width: 100, height: 40 }, () => overlay);
    expect(isObscured(element)).toBe(true);
  });

  it('samples five points, so a corner clipped by a tooltip is still reachable', () => {
    // The case that makes single-point sampling wrong: a tooltip or a sticky
    // header covering the centre while most of a wide control is clickable.
    const tooltip = document.createElement('div');
    document.body.append(tooltip);
    const { element, asked } = place({ x: 0, y: 0, width: 200, height: 60 }, (x, y) =>
      // Covers only the middle of the control.
      x > 80 && x < 120 && y > 20 && y < 40 ? tooltip : null,
    );
    const at = (x: number, y: number): Element | null =>
      x > 80 && x < 120 && y > 20 && y < 40 ? tooltip : element;
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = (
      x: number,
      y: number,
    ) => {
      asked.push([x, y]);
      return at(x, y);
    };
    expect(isObscured(element)).toBe(false);
    expect(asked.length, 'the centre was not the only point tried').toBeGreaterThan(1);
  });

  it('insets the sampled corners, so a border pixel is not the verdict', () => {
    // Every point has to be obstructed, or the check returns at the first
    // reachable one and the corners are never sampled — which is how an
    // earlier version of this case let a mutation setting the inset to zero
    // walk straight through it.
    const overlay = document.createElement('div');
    document.body.append(overlay);
    const { element, asked } = place({ x: 0, y: 0, width: 200, height: 100 }, () => null);
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = (
      x: number,
      y: number,
    ) => {
      asked.push([x, y]);
      return overlay;
    };
    expect(isObscured(element)).toBe(true);
    expect(asked, 'all five points were sampled').toHaveLength(5);
    // No sampled point sits exactly on an edge.
    for (const [x, y] of asked) {
      expect(x, `x=${x} is on an edge`).not.toBe(0);
      expect(x).not.toBe(200);
      expect(y, `y=${y} is on an edge`).not.toBe(0);
      expect(y).not.toBe(100);
    }
  });
});

describe('the guard that interactions actually go through', () => {
  it('throws when the element is covered, naming the cause and the way out', () => {
    const overlay = document.createElement('div');
    document.body.append(overlay);
    const { element } = place({ x: 0, y: 0, width: 100, height: 40 }, () => overlay);
    element.scrollIntoView = function scrollIntoView(): void {};
    // `isObscured` being right is not the same as anything consulting it. The
    // mutation that removed this guard left every occlusion case passing,
    // because they all tested the predicate and none tested its caller.
    expect(() => scrollIntoViewAndAssertReachable(element)).toThrow(TypeError);
    expect(() => scrollIntoViewAndAssertReachable(element)).toThrow(/covering this element/);
    expect(() => scrollIntoViewAndAssertReachable(element)).toThrow(
      /dialog, cookie banner or overlay/,
    );
  });

  it('scrolls before it hit-tests, because an off-screen box is the wrong box', () => {
    const { element } = place({ x: 0, y: 0, width: 100, height: 40 }, () => null);
    const scrolled: string[] = [];
    element.scrollIntoView = function scrollIntoView(): void {
      scrolled.push('scrolled');
    };
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = () => {
      // Asserting order rather than merely that both happened: hit-testing an
      // element still below the fold answers about a position it is leaving.
      expect(scrolled, 'hit test ran before the scroll').toHaveLength(1);
      return element;
    };
    scrollIntoViewAndAssertReachable(element);
    expect(scrolled).toHaveLength(1);
  });

  it('lets a reachable element through untouched', () => {
    const { element } = place({ x: 0, y: 0, width: 100, height: 40 }, () => null);
    element.scrollIntoView = function scrollIntoView(): void {};
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = () => element;
    expect(() => scrollIntoViewAndAssertReachable(element)).not.toThrow();
  });
});

describe('when nothing can be measured, nothing is refused', () => {
  it('reports not obscured where the document has no hit testing at all', () => {
    // A document with no layout. The check exists to stop one specific false
    // success; an unmeasurable page must not become an unusable one.
    const element = document.createElement('button');
    document.body.append(element);
    expect('elementFromPoint' in document).toBe(false);
    expect(isObscured(element)).toBe(false);
  });

  it('reports not obscured when every sampled point is off screen', () => {
    // A real browser returns null outside the viewport. Refusing on that
    // would refuse anything scrolled out of view, which `scrollIntoView` was
    // about to fix anyway.
    const { element } = place({ x: -500, y: -500, width: 100, height: 40 }, () => null);
    expect(isObscured(element)).toBe(false);
  });

  it('reports not obscured for a zero-sized box, which isVisible already judged', () => {
    const { element } = place({ x: 0, y: 0, width: 0, height: 0 }, () => null);
    expect(isObscured(element)).toBe(false);
  });
});
