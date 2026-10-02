/**
 * TEST-E2E-053 — controls inside shadow roots, in real Chromium.
 *
 * REAL BROWSER + LOCAL TEST SERVER. The page is served over real HTTP from
 * 127.0.0.1, built from actual custom elements with actual shadow roots, and
 * the content script is really injected into it.
 *
 * ## Why this cannot be settled in jsdom
 *
 * jsdom implements the shadow DOM specification. Chromium implements the one
 * that ships, and the differences that matter here are exactly the ones a
 * polyfill-shaped implementation gets approximately right: whether
 * `querySelectorAll` stops at a boundary, what `getRootNode()` returns for a
 * slotted node, whether a closed root really exposes nothing, and what
 * `composedPath()` reports when a click inside a component is dispatched. A
 * page model that worked in jsdom and not here would be a page model that
 * worked nowhere that matters.
 *
 * ## What is at stake
 *
 * Before this, `querySelectorAll` did not cross a shadow boundary, so on a page
 * built from web components the model saw an empty document — no buttons, no
 * fields — and the agent's answer was that the page had no controls. That is a
 * large and growing fraction of real sites.
 *
 * The reason traversing them is safe is the field classifier, which has always
 * returned the conservative class for `isInShadowRoot`. So the cases below
 * check both halves: that the controls are now **found**, and that a field
 * inside one is still **confirmed** rather than written to silently. A
 * traversal that found the field and lost the flag would have quietly widened
 * what runs without a prompt, which is the failure worth testing for.
 */
import { expect, test } from './fixtures/extension';

/** What the click probe resolves to. */
interface ClickOutcome {
  readonly step?: string;
  readonly clicked?: Reply;
  readonly error?: unknown;
  readonly elements?: readonly string[];
}

interface Reply {
  readonly ok: boolean;
  readonly value?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly userMessage?: string };
}

/** Reads the page through the real content script, as the worker does. */
const READ_PAGE = `
  (async () => {
    const tabs = await chrome.tabs.query({ url: '*://*/shadow' });
    const tabId = tabs[0].id;
    const read = await chrome.tabs.sendMessage(tabId, {
      id: 'e2e_' + Math.random().toString(36).slice(2),
      type: 'content.readPage', timestamp: Date.now(), payload: {},
    });
    if (!read.ok) return { error: read.error };
    return {
      elements: read.value.page.elements,
      fields: read.value.page.fields,
    };
  })()
`;

interface PageElement {
  readonly elementId: string;
  readonly role: string;
  readonly name: string;
}

/** What `READ_PAGE` resolves to. Declared so the shapes stay documented. */
interface PageRead {
  readonly elements?: readonly PageElement[];
  readonly fields?: readonly PageField[];
  readonly error?: unknown;
}

interface PageField {
  readonly elementId: string;
  readonly nameHint: string;
  readonly isInShadowRoot: boolean;
  readonly isInSubframe: boolean;
}

test('controls inside open shadow roots are in the page model', async ({
  context,
  serviceWorker,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/shadow`);
  await page.waitForLoadState('domcontentloaded');
  await page.bringToFront();

  const read: PageRead = await serviceWorker.evaluate(READ_PAGE);
  expect(read.error, JSON.stringify(read.error)).toBeUndefined();

  const names = (read.elements ?? []).map((element) => element.name);
  // The light DOM control, which always worked.
  expect(names).toContain('Light Button');
  // The one inside an open shadow root, which did not.
  expect(names).toContain('Shadow Button');
  // And one two boundaries deep, because components nest.
  expect(names).toContain('Deep Button');

  await page.close();
});

test('a control inside a closed shadow root is not reachable', async ({
  context,
  serviceWorker,
  site,
}) => {
  // Not a policy this build implements — a closed root exposes no
  // `shadowRoot` property at all, so there is nothing to reach through. This
  // is the only place that can be observed in the engine that enforces it.
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/shadow`);
  await page.waitForLoadState('domcontentloaded');
  await page.bringToFront();

  const read: PageRead = await serviceWorker.evaluate(READ_PAGE);
  expect((read.elements ?? []).map((element) => element.name)).not.toContain('Sealed Button');

  await page.close();
});

test('a field inside a shadow root is marked, which is what makes this safe', async ({
  context,
  serviceWorker,
  site,
}) => {
  // The hinge the whole change hangs on. `classifyField` returns the
  // conservative class for this flag, so a field the model can now see is one
  // it must confirm before writing to. Measured in the real browser because
  // `getRootNode()` is the browser's answer, not jsdom's.
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/shadow`);
  await page.waitForLoadState('domcontentloaded');
  await page.bringToFront();

  const read: PageRead = await serviceWorker.evaluate(READ_PAGE);
  const field = (read.fields ?? []).find((observation) => observation.nameHint === 'shadow_note');

  expect(field, JSON.stringify(read.fields)).toBeDefined();
  expect(field!.isInShadowRoot).toBe(true);
  // `all_frames` is false, so this stays false and is a different boundary.
  expect(field!.isInSubframe).toBe(false);

  await page.close();
});

test('the agent can click a button inside a shadow root', async ({
  context,
  serviceWorker,
  site,
}) => {
  // Being in the model is not the same as being actionable: the handle has to
  // resolve back to a live node across a message boundary, and the click has
  // to land on the node inside the component rather than on its host. The
  // page records what `composedPath()` saw, which is the browser's own answer
  // to "what was actually clicked".
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/shadow`);
  await page.waitForLoadState('domcontentloaded');
  await page.bringToFront();

  const outcome: ClickOutcome = await serviceWorker.evaluate(`
    (async () => {
      const tabs = await chrome.tabs.query({ url: '*://*/shadow' });
      const tabId = tabs[0].id;
      const ask = (type, payload) => chrome.tabs.sendMessage(tabId, {
        id: 'e2e_' + Math.random().toString(36).slice(2),
        type, timestamp: Date.now(), payload,
      });

      const read = await ask('content.readPage', {});
      if (!read.ok) return { step: 'read', error: read.error };
      const target = read.value.page.elements.find((e) => e.name === 'Shadow Button');
      if (!target) return { step: 'find', elements: read.value.page.elements.map((e) => e.name) };

      const clicked = await ask('content.click', { elementId: target.elementId });
      return { step: 'done', clicked };
    })()
  `);

  expect(outcome.step, JSON.stringify(outcome)).toBe('done');
  expect(outcome.clicked?.ok, JSON.stringify(outcome.clicked)).toBe(true);

  // The click landed on the button inside the component, which is what the
  // page's own `composedPath()` listener recorded.
  const recorded = await page.evaluate(() => document.getElementById('clicked')?.textContent ?? '');
  expect(recorded).toContain('shadow-button');

  await page.close();
});

test('shadow traversal added no permission and no host access', async ({ serviceWorker }) => {
  // The whole point: this is the same access any script on the page already
  // has, and it crosses no origin. A change that needed `all_frames` or a new
  // permission to see a web component would be a different trade entirely.
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());

  expect(manifest.permissions ?? []).toEqual([
    'sidePanel',
    'storage',
    'unlimitedStorage',
    'tabs',
    'tabGroups',
    'scripting',
    'debugger',
    'notifications',
    'activeTab',
    'alarms',
  ]);
  expect(manifest.host_permissions ?? []).toEqual(['http://*/*', 'https://*/*']);
  for (const script of manifest.content_scripts ?? []) {
    expect(script.all_frames ?? false).toBe(false);
  }
});
