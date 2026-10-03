/**
 * @vitest-environment jsdom
 *
 * TEST-SECURITY-080 — re-finding an element whose handle went stale.
 *
 * ## What this adds, and why it is a security file rather than a unit one
 *
 * `P-032-C6` describes a recovery ladder and this repository had three of its
 * rungs. The missing one is the interesting one: when a handle goes stale,
 * look for the element again instead of asking the model to read the page.
 *
 * That is a reliability feature whose failure mode is **acting on the wrong
 * element**, which is the worst thing a browser agent can do. So the cases
 * below spend far more effort on the refusals than on the success: a page that
 * now has two "Delete" buttons must produce a refusal, not a coin flip, and a
 * relocated element must still pass every gate an ordinary one does.
 *
 * ## The rule, and why it is this rule
 *
 * Role plus accessible name, unique match or nothing. Not because it is the
 * easiest rule but because it is **already this build's rule**: it is what
 * `describeActedOn` produces and what a workflow binding is matched on. The
 * parameteriser settled the ambiguity question in these words — *"Ambiguity at
 * record time is refused rather than pinned by position. A recording that says
 * 'the third Delete button' is a recording that clicks the wrong thing the
 * moment a row is added."* — and this runs **after** the page has demonstrably
 * changed, so it holds with more force here.
 *
 * ## jsdom, deliberately
 *
 * The decision under test is a comparison over a candidate list, not a
 * browser behaviour. `tests/e2e/shadow-dom.spec.ts` and the agent E2E suites
 * cover the real-browser side of resolution.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ElementRegistry,
  MAX_RETAINED_DESCRIPTORS,
  collectInteractive,
} from '@/content/semantic-tree';
import { relocate, relocationMessage } from '@/content/relocate';
import { resolveActionable } from '@/content/interaction-engine';

beforeAll(() => {
  // jsdom has no layout, so every element reads as invisible and
  // `resolveActionable` refuses before it reaches the interesting part. The
  // same stub `tests/unit/interaction-engine.test.ts` uses: a box for anything
  // not `display: none`, so the visibility check still discriminates.
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const size = getComputedStyle(this).display === 'none' ? 0 : 20;
    return {
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
  };
});

/** Rebuilds the page and returns the registry with handles issued for it. */
function snapshot(html: string): { registry: ElementRegistry; handles: string[] } {
  document.body.innerHTML = html;
  const registry = new ElementRegistry();
  registry.beginSnapshot();
  const handles = collectInteractive(document).map((element, index) =>
    registry.register(element, index),
  );
  return { registry, handles };
}

/** Takes a second snapshot on the same registry, as a page read does. */
function reRead(registry: ElementRegistry, html: string): void {
  document.body.innerHTML = html;
  registry.beginSnapshot();
  collectInteractive(document).forEach((element, index) => registry.register(element, index));
}

const candidates = (): readonly Element[] => collectInteractive(document);

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('01 — an unambiguous element is found again', () => {
  it('recovers a handle the page re-rendered under', () => {
    // The ordinary case this exists for: a list settles, a spinner resolves,
    // the DOM is replaced, and the button the model named is still there.
    const { registry, handles } = snapshot('<button id="a">Save</button>');
    const handle = handles[0]!;

    // The page re-renders. The node is new; the handle is dead.
    document.body.innerHTML = '<button id="b">Save</button>';
    expect(registry.resolve(handle).status).not.toBe('ok');

    const resolved = resolveActionable(registry, handle, candidates);
    expect(resolved.ok).toBe(true);
    expect(resolved.ok === true && resolved.relocated).toBe(true);
    // The *new* node, not a detached one.
    expect(resolved.ok === true && (resolved.element as HTMLElement).id).toBe('b');
    expect(resolved.ok === true && resolved.element.isConnected).toBe(true);
  });

  it('recovers across a new snapshot, where the handle is from an old generation', () => {
    const { registry, handles } = snapshot('<button>Continue</button><button>Cancel</button>');
    const continueHandle = handles[0]!;

    reRead(registry, '<button>Cancel</button><button>Continue</button>');
    expect(registry.resolve(continueHandle).status).toBe('stale');

    const resolved = resolveActionable(registry, continueHandle, candidates);
    expect(resolved.ok).toBe(true);
    // Found by name, not by position — the two buttons swapped order.
    expect(resolved.ok === true && resolved.element.textContent).toBe('Continue');
  });

  it('marks an ordinary resolution as not relocated', () => {
    // The flag has to mean something, so the common path must not set it.
    const { registry, handles } = snapshot('<button>Save</button>');
    const resolved = resolveActionable(registry, handles[0]!, candidates);
    expect(resolved.ok).toBe(true);
    expect(resolved.ok === true && resolved.relocated).toBeUndefined();
  });
});

describe('02 — ambiguity is a refusal, never a choice', () => {
  it('refuses when the page now has two of the same thing', () => {
    // **The case that matters most.** A row was added, there are two Delete
    // buttons, and the handle names neither of them any more. Picking one is
    // how an agent deletes the wrong row.
    const { registry, handles } = snapshot('<button>Delete</button>');
    const handle = handles[0]!;

    document.body.innerHTML = '<button>Delete</button><button>Delete</button>';
    const resolved = resolveActionable(registry, handle, candidates);

    expect(resolved.ok).toBe(false);
    // And the message says what it is, so the model reads the page and
    // chooses rather than retrying the same handle.
    expect(resolved.ok === false && resolved.error.message).toMatch(/2 elements/);
    expect(resolved.ok === false && resolved.error.message).toMatch(/choose between them/i);
  });

  it('does not fall back to position when the descriptor has one', () => {
    // The descriptor could carry an index and the parameteriser deliberately
    // refuses to use one. This asserts the same choice here: three identical
    // buttons is a refusal however confidently a position could be computed.
    const { registry, handles } = snapshot(
      '<button>Apply</button><button>Apply</button><button>Apply</button>',
    );
    document.body.innerHTML = '<button>Apply</button><button>Apply</button><button>Apply</button>';
    for (const handle of handles) {
      const resolved = resolveActionable(registry, handle, candidates);
      expect(resolved.ok, handle).toBe(false);
    }
  });

  it('refuses when the element is genuinely gone', () => {
    const { registry, handles } = snapshot('<button>Publish</button>');
    document.body.innerHTML = '<button>Cancel</button>';

    const resolved = resolveActionable(registry, handles[0]!, candidates);
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.error.message).toMatch(/no longer on the page/i);
  });

  it('refuses a nameless element rather than matching on role alone', () => {
    // A page of unlabelled icon buttons would otherwise relocate to whichever
    // one came first. `describeActedOn` refuses to describe a nameless element
    // for the same reason.
    const { registry, handles } = snapshot('<button></button><button></button>');
    document.body.innerHTML = '<button></button><button></button>';

    const resolved = resolveActionable(registry, handles[0]!, candidates);
    expect(resolved.ok).toBe(false);
  });

  it('refuses when the role changed, even if the name did not', () => {
    // A link named "Delete" is not the button named "Delete". Matching on name
    // alone would make a navigation and a destructive action interchangeable.
    const { registry, handles } = snapshot('<button>Remove</button>');
    document.body.innerHTML = '<a href="#x">Remove</a>';

    const resolved = resolveActionable(registry, handles[0]!, candidates);
    expect(resolved.ok).toBe(false);
  });
});

describe('03 — relocation bypasses no gate', () => {
  it('still refuses a relocated element that is invisible', () => {
    // The property that makes this safe rather than a shortcut: relocation
    // produces an element, and every check runs on it afterwards.
    const { registry, handles } = snapshot('<button>Submit</button>');
    document.body.innerHTML = '<button style="display:none">Submit</button>';

    const resolved = resolveActionable(registry, handles[0]!, candidates);
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.error.failure).toBe('NOT_VISIBLE');
  });

  it('still refuses a relocated element that is disabled', () => {
    const { registry, handles } = snapshot('<button>Submit</button>');
    document.body.innerHTML = '<button disabled>Submit</button>';

    const resolved = resolveActionable(registry, handles[0]!, candidates);
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.error.failure).toBe('NOT_ENABLED');
  });

  it('does nothing at all when no candidate supplier is given', () => {
    // Every existing caller that has not opted in behaves exactly as before,
    // which is what makes this additive rather than a change to resolution.
    const { registry, handles } = snapshot('<button>Save</button>');
    document.body.innerHTML = '<button>Save</button>';

    const resolved = resolveActionable(registry, handles[0]!);
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.error.message).toMatch(/Read the page again/i);
  });
});

describe('04 — the descriptor store is bounded and holds no DOM', () => {
  it('evicts oldest-first rather than growing without limit', () => {
    // The descriptors outlive their generation on purpose, so without a
    // ceiling a long-lived tab accumulates one per element per page read.
    const registry = new ElementRegistry();
    registry.beginSnapshot();
    document.body.innerHTML = '<button>One</button>';
    const element = document.querySelector('button')!;

    const first = registry.register(element, 0);
    for (let index = 1; index <= MAX_RETAINED_DESCRIPTORS; index += 1) {
      registry.register(element, index);
    }
    // The first is gone; the most recent is kept.
    expect(registry.describe(first)).toBeUndefined();
    expect(registry.describe(`e1-${MAX_RETAINED_DESCRIPTORS}`)).toBeDefined();
  });

  it('keeps no node, so a detached subtree is not pinned in memory', () => {
    // A retained `Element` would hold a removed subtree alive for the life of
    // the tab. The descriptor is two strings.
    const { registry, handles } = snapshot('<button>Save</button>');
    const descriptor = registry.describe(handles[0]!);
    expect(descriptor).toEqual({ role: 'button', name: 'Save' });
    expect(Object.values(descriptor!).every((value) => typeof value === 'string')).toBe(true);
  });

  it('forgets nothing it still needs for the current snapshot', () => {
    const { registry, handles } = snapshot('<button>A</button><button>B</button>');
    for (const handle of handles) expect(registry.describe(handle)).toBeDefined();
  });
});

describe('04b — the search costs a bounded amount on a large page', () => {
  it('stays linear in the number of controls', () => {
    // This runs on a failure path, and only there, so it is allowed to cost a
    // walk of the page's interactive set. What it must not do is cost
    // something super-linear: a page of a few thousand controls is unusual and
    // not absurd, and an agent that becomes unresponsive on one has traded a
    // saved model turn for a worse failure.
    const many = Array.from(
      { length: 3_000 },
      (_unused, index) => `<button>Button ${index}</button>`,
    ).join('');
    document.body.innerHTML = many;

    const started = Date.now();
    // The worst case for the matcher: every candidate is examined because the
    // match is the last one.
    const found = relocate({ role: 'button', name: 'Button 2999' }, candidates());
    const elapsed = Date.now() - started;

    expect(found.ok).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('is not reached at all when the handle resolves', () => {
    // The ordinary path must not pay for this. A resolution that succeeds
    // never asks for candidates, which is asserted by making the supplier
    // throw if it is called.
    const { registry, handles } = snapshot('<button>Save</button>');
    const resolved = resolveActionable(registry, handles[0]!, () => {
      throw new Error('candidates must not be read when the handle resolves');
    });
    expect(resolved.ok).toBe(true);
  });
});

describe('05 — the decision is a pure function a test can drive', () => {
  it('compares names tolerantly of whitespace and case, and nothing more', () => {
    document.body.innerHTML = '<button>  Save   changes </button>';
    const found = relocate({ role: 'button', name: 'Save changes' }, candidates());
    expect(found.ok).toBe(true);

    // A different label is a different element, not a near miss to be
    // guessed at.
    expect(relocate({ role: 'button', name: 'Save change' }, candidates()).ok).toBe(false);
    expect(relocate({ role: 'button', name: 'Save all changes' }, candidates()).ok).toBe(false);
  });

  it('reports why, with a count where the count is the point', () => {
    document.body.innerHTML = '<button>Go</button><button>Go</button>';
    const found = relocate({ role: 'button', name: 'Go' }, candidates());
    expect(found.ok).toBe(false);
    expect(found.ok === false && found.refusal).toBe('AMBIGUOUS');
    expect(found.ok === false && found.matches).toBe(2);
  });

  it('refuses an unremembered handle without searching', () => {
    const found = relocate(undefined, candidates());
    expect(found.ok === false && found.refusal).toBe('NOT_REMEMBERED');
  });

  it('gives each refusal its own sentence', () => {
    // One message for all three would send the model to do the wrong thing:
    // `AMBIGUOUS` in particular must not read as "try again".
    const messages = new Set([
      relocationMessage('GONE', 0),
      relocationMessage('AMBIGUOUS', 2),
      relocationMessage('NOT_REMEMBERED', 0),
    ]);
    expect(messages.size).toBe(3);
    expect(relocationMessage('AMBIGUOUS', 2)).toContain('2');
  });
});
