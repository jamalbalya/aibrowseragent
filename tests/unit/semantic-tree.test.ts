/**
 * @vitest-environment jsdom
 *
 * TEST-BROWSER-001 — Semantic page model (REQ-BROWSER-001).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ElementRegistry,
  accessibleName,
  extractSemanticPage,
  isEnabled,
  isVisible,
  roleOf,
  selectorHints,
  visibleText,
} from '@/content/semantic-tree';

function setBody(html: string): void {
  document.body.innerHTML = html;
}

/**
 * jsdom has no layout engine, so `getBoundingClientRect` returns all zeros and
 * every element would look zero-sized. The shim gives laid-out elements a real
 * box, so these tests exercise the visibility logic rather than jsdom's
 * missing layout. Elements the CSS genuinely hides keep a zero box, matching
 * what a real browser reports.
 */
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const style = getComputedStyle(this);
    const hidden = style.display === 'none';
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
});

describe('roleOf', () => {
  beforeEach(() => setBody(''));

  it('honours an explicit role attribute', () => {
    setBody('<div role="Button">x</div>');
    expect(roleOf(document.querySelector('div')!)).toBe('button');
  });

  it('derives implicit roles from the tag', () => {
    setBody(`
      <a href="/x">link</a><a>no href</a>
      <button>b</button><select></select>
      <select multiple></select><textarea></textarea><summary>s</summary>
    `);
    const [withHref, withoutHref] = [...document.querySelectorAll('a')];
    expect(roleOf(withHref!)).toBe('link');
    expect(roleOf(withoutHref!)).toBe('generic');
    expect(roleOf(document.querySelector('button')!)).toBe('button');
    const selects = [...document.querySelectorAll('select')];
    expect(roleOf(selects[0]!)).toBe('combobox');
    expect(roleOf(selects[1]!)).toBe('listbox');
    expect(roleOf(document.querySelector('textarea')!)).toBe('textbox');
    expect(roleOf(document.querySelector('summary')!)).toBe('button');
  });

  it('derives input roles from the type attribute', () => {
    const types: [string, string][] = [
      ['checkbox', 'checkbox'],
      ['radio', 'radio'],
      ['submit', 'button'],
      ['range', 'slider'],
      ['search', 'searchbox'],
      ['number', 'spinbutton'],
      ['text', 'textbox'],
      ['email', 'textbox'],
    ];
    for (const [type, role] of types) {
      setBody(`<input type="${type}">`);
      expect(roleOf(document.querySelector('input')!), type).toBe(role);
    }
  });
});

describe('accessibleName', () => {
  beforeEach(() => setBody(''));

  it('prefers aria-labelledby over everything else', () => {
    setBody(
      '<span id="lbl">Preferred</span><button aria-labelledby="lbl" aria-label="Other">Text</button>',
    );
    expect(accessibleName(document.querySelector('button')!)).toBe('Preferred');
  });

  it('falls back to aria-label', () => {
    setBody('<button aria-label="Close dialog">×</button>');
    expect(accessibleName(document.querySelector('button')!)).toBe('Close dialog');
  });

  it('uses an associated label for a form control', () => {
    setBody('<label for="email">Email address</label><input id="email">');
    expect(accessibleName(document.querySelector('input')!)).toBe('Email address');
  });

  it('uses the value of a submit button', () => {
    setBody('<input type="submit" value="Send it">');
    expect(accessibleName(document.querySelector('input')!)).toBe('Send it');
  });

  it('falls back to visible text, then placeholder', () => {
    setBody('<button>  Save   changes  </button><input placeholder="Search here">');
    expect(accessibleName(document.querySelector('button')!)).toBe('Save changes');
    expect(accessibleName(document.querySelector('input')!)).toBe('Search here');
  });

  it('returns an empty string when there is nothing to name', () => {
    setBody('<div></div>');
    expect(accessibleName(document.querySelector('div')!)).toBe('');
  });

  describe('name from content is limited to roles that permit it', () => {
    // Found in a real browser: an unlabelled <select> was named "AlphaBeta"
    // after its own options, and a contenteditable textbox was named after
    // whatever had been typed into it. In both cases that text is the
    // control's value, not a label the model can target.
    it('does not name an unlabelled select after its options', () => {
      setBody('<select><option value="a">Alpha</option><option value="b">Beta</option></select>');
      expect(accessibleName(document.querySelector('select')!)).toBe('');
    });

    it('does not name a contenteditable textbox after its own value', () => {
      setBody('<div role="textbox" contenteditable="true">typed text</div>');
      expect(accessibleName(document.querySelector('div')!)).toBe('');
    });

    it('does not name a textarea after its content', () => {
      setBody('<textarea>draft body</textarea>');
      expect(accessibleName(document.querySelector('textarea')!)).toBe('');
    });

    it('still names a labelled select from its label', () => {
      setBody('<label for="s">Choose one</label><select id="s"><option>Alpha</option></select>');
      expect(accessibleName(document.querySelector('select')!)).toBe('Choose one');
    });

    it('still names a select from aria-label', () => {
      setBody('<select aria-label="Sort order"><option>Alpha</option></select>');
      expect(accessibleName(document.querySelector('select')!)).toBe('Sort order');
    });

    it('prefers a placeholder over content for a control', () => {
      setBody('<div role="textbox" contenteditable="true" placeholder="Write here">typed</div>');
      expect(accessibleName(document.querySelector('div')!)).toBe('Write here');
    });

    it('still names buttons, links and headings from their content', () => {
      setBody('<button>Save</button><a href="/x">Help</a><div role="heading">Title</div>');
      expect(accessibleName(document.querySelector('button')!)).toBe('Save');
      expect(accessibleName(document.querySelector('a')!)).toBe('Help');
      expect(accessibleName(document.querySelector('[role="heading"]')!)).toBe('Title');
    });

    it('names a checkbox and a tab from their content', () => {
      setBody('<div role="checkbox">Accept terms</div><div role="tab">Details</div>');
      expect(accessibleName(document.querySelector('[role="checkbox"]')!)).toBe('Accept terms');
      expect(accessibleName(document.querySelector('[role="tab"]')!)).toBe('Details');
    });
  });
});

describe('isEnabled', () => {
  beforeEach(() => setBody(''));

  it('detects the disabled attribute and aria-disabled', () => {
    setBody('<button disabled>a</button><button aria-disabled="true">b</button><button>c</button>');
    const [a, b, c] = [...document.querySelectorAll('button')];
    expect(isEnabled(a!)).toBe(false);
    expect(isEnabled(b!)).toBe(false);
    expect(isEnabled(c!)).toBe(true);
  });

  it('treats a control inside a disabled fieldset as disabled', () => {
    setBody('<fieldset disabled><input></fieldset>');
    expect(isEnabled(document.querySelector('input')!)).toBe(false);
  });
});

describe('isVisible', () => {
  beforeEach(() => setBody(''));

  it('rejects display:none and visibility:hidden', () => {
    setBody('<div style="display:none">a</div><div style="visibility:hidden">b</div>');
    for (const element of document.querySelectorAll('div')) {
      expect(isVisible(element)).toBe(false);
    }
  });

  it('rejects a fully transparent element', () => {
    setBody('<div style="opacity:0">a</div>');
    expect(isVisible(document.querySelector('div')!)).toBe(false);
  });
});

describe('selectorHints', () => {
  beforeEach(() => setBody(''));

  it('prefers id, then test id, then name', () => {
    setBody('<input id="email" data-testid="email-field" name="email">');
    expect(selectorHints(document.querySelector('input')!)).toEqual([
      '#email',
      '[data-testid="email-field"]',
      'input[name="email"]',
    ]);
  });

  it('falls back to classes when nothing stable exists', () => {
    setBody('<button class="btn primary">x</button>');
    expect(selectorHints(document.querySelector('button')!)).toEqual(['button.btn.primary']);
  });

  it('skips a generated id that is not a valid selector', () => {
    setBody('<div id="123-not-valid" class="ok">x</div>');
    expect(selectorHints(document.querySelector('div')!)).not.toContain('#123-not-valid');
  });
});

describe('ElementRegistry', () => {
  beforeEach(() => setBody('<button>a</button>'));

  it('invalidates handles from an earlier snapshot', () => {
    const registry = new ElementRegistry();
    registry.beginSnapshot();
    const handle = registry.register(document.querySelector('button')!, 0);
    expect(registry.resolve(handle).status).toBe('ok');

    registry.beginSnapshot();
    expect(registry.resolve(handle).status).toBe('stale');
  });

  it('reports a detached element separately from a stale handle', () => {
    const registry = new ElementRegistry();
    registry.beginSnapshot();
    const button = document.querySelector('button')!;
    const handle = registry.register(button, 0);
    button.remove();
    expect(registry.resolve(handle).status).toBe('detached');
  });

  it('reports an unrecognised handle as unknown', () => {
    const registry = new ElementRegistry();
    registry.beginSnapshot();
    expect(registry.resolve('garbage').status).toBe('unknown');
    // Right generation, unregistered index.
    expect(registry.resolve('e1-99').status).toBe('unknown');
    // Earlier generation.
    expect(registry.resolve('e0-1').status).toBe('stale');
  });
});

describe('extractSemanticPage', () => {
  it('captures interactive elements with roles and names', () => {
    setBody(`
      <h1>Contact us</h1>
      <label for="name">Your name</label><input id="name" value="Ada">
      <select id="topic"><option value="a">Alpha</option><option value="b">Beta</option></select>
      <button>Send</button>
      <a href="https://example.com/help">Help</a>
    `);
    const page = extractSemanticPage(document, new ElementRegistry());

    const byName = Object.fromEntries(page.elements.map((e) => [e.name, e]));
    expect(byName['Your name']?.role).toBe('textbox');
    expect(byName['Your name']?.value).toBe('Ada');
    expect(byName.Send?.role).toBe('button');
    expect(byName.Help?.role).toBe('link');
    expect(byName.Help?.href).toContain('example.com/help');

    const select = page.elements.find((e) => e.role === 'combobox');
    expect(select?.options).toEqual(['Alpha', 'Beta']);
  });

  it('never includes a password field value in the page model', () => {
    // A password would otherwise travel straight into model context.
    setBody('<label for="pw">Password</label><input id="pw" type="password" value="hunter2">');
    const page = extractSemanticPage(document, new ElementRegistry());

    const field = page.elements.find((e) => e.name === 'Password');
    expect(field).toBeDefined();
    expect(field?.value).toBeUndefined();
    expect(JSON.stringify(page)).not.toContain('hunter2');
  });

  it('skips hidden elements', () => {
    setBody('<button style="display:none">Hidden</button><button>Shown</button>');
    const page = extractSemanticPage(document, new ElementRegistry());
    expect(page.elements.map((e) => e.name)).toEqual(['Shown']);
  });

  it('marks disabled elements as such rather than omitting them', () => {
    setBody('<button disabled>Submit</button>');
    const page = extractSemanticPage(document, new ElementRegistry());
    expect(page.elements[0]?.enabled).toBe(false);
  });

  it('caps the element count and reports truncation', () => {
    setBody(Array.from({ length: 30 }, (_, i) => `<button>B${i}</button>`).join(''));
    const page = extractSemanticPage(document, new ElementRegistry(), { maxElements: 10 });
    expect(page.elements).toHaveLength(10);
    expect(page.elementsTruncated).toBe(true);
  });

  it('reports text truncation honestly', () => {
    setBody(`<p>${'word '.repeat(500)}</p>`);
    const page = extractSemanticPage(document, new ElementRegistry(), { maxTextLength: 100 });
    expect(page.text.length).toBeLessThanOrEqual(100);
    expect(page.textTruncated).toBe(true);
  });

  it('can omit page text entirely', () => {
    setBody('<p>Some content</p><button>Go</button>');
    const page = extractSemanticPage(document, new ElementRegistry(), { includeText: false });
    expect(page.text).toBe('');
    expect(page.elements).toHaveLength(1);
  });

  it('issues a new generation per snapshot', () => {
    setBody('<button>a</button>');
    const registry = new ElementRegistry();
    const first = extractSemanticPage(document, registry);
    const second = extractSemanticPage(document, registry);
    expect(second.generation).toBe(first.generation + 1);
    expect(second.elements[0]?.elementId).not.toBe(first.elements[0]?.elementId);
  });

  it('does not echo a control value back as descriptive text', () => {
    setBody('<label for="s">Choose</label><select id="s"><option>Alpha</option></select>');
    const page = extractSemanticPage(document, new ElementRegistry());
    const select = page.elements[0]!;
    expect(select.name).toBe('Choose');
    // The options are already reported in `options`; repeating them as `text`
    // would just inflate context with the same data under a misleading key.
    expect(select.text).toBeUndefined();
  });

  it('reports checkbox state', () => {
    setBody('<label for="tc">Accept</label><input id="tc" type="checkbox" checked>');
    const page = extractSemanticPage(document, new ElementRegistry());
    expect(page.elements[0]?.checked).toBe(true);
  });
});

describe('visibleText', () => {
  it('excludes script and style content', () => {
    setBody('<script>var secret = 1;</script><style>.a{color:red}</style><p>Real content</p>');
    const text = visibleText(document, 1000);
    expect(text).toContain('Real content');
    expect(text).not.toContain('var secret');
    expect(text).not.toContain('color:red');
  });

  it('excludes text inside hidden containers', () => {
    setBody('<div style="display:none">Hidden text</div><p>Shown text</p>');
    const text = visibleText(document, 1000);
    expect(text).not.toContain('Hidden text');
    expect(text).toContain('Shown text');
  });

  it('respects the length limit', () => {
    setBody(`<p>${'x'.repeat(5000)}</p>`);
    expect(visibleText(document, 200).length).toBeLessThanOrEqual(200);
  });
});
