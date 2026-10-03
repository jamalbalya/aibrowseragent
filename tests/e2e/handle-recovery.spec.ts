/**
 * TEST-E2E-055 — a page that re-renders between the read and the click.
 *
 * REAL BROWSER + LOCAL TEST SERVER. The page replaces its own subtree from its
 * own script, so what the extension sees is a genuine re-render rather than a
 * DOM edit performed by the test.
 *
 * ## Why this cannot be settled in jsdom
 *
 * `tests/security/handle-relocation.test.ts` holds the decision — role and
 * accessible name, unique match or refusal — and drives it over a candidate
 * list. What it cannot establish is that the recovery happens **through the
 * real content script**, across the real message boundary, with the real
 * registry whose generation advanced: the handle has to be dead for the right
 * reason, and the element has to be re-found in the page the browser actually
 * has.
 *
 * ## What is at stake
 *
 * Before this, every stale handle produced the same answer to the model —
 * *"read the page again"* — which costs a turn and only works if the model
 * obliges. A list settling or a spinner resolving between the read and the
 * click is the ordinary case on a modern page, not an edge one.
 *
 * The risk is acting on the wrong element, so the second case matters more
 * than the first: with two controls sharing the label, the click must be
 * **refused**, and the page's own listener is what proves nothing was clicked.
 */
import { expect, test } from './fixtures/extension';

interface Reply {
  readonly ok: boolean;
  readonly value?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly userMessage?: string };
}

/** Reads the page, re-renders it, then clicks the handle from before. */
const SCRIPT = (ambiguous: boolean): string => `
  (async () => {
    const tabs = await chrome.tabs.query({ url: '*://*/rerender' });
    const tabId = tabs[0].id;
    const ask = (type, payload) => chrome.tabs.sendMessage(tabId, {
      id: 'e2e_' + Math.random().toString(36).slice(2),
      type, timestamp: Date.now(), payload,
    });

    const read = await ask('content.readPage', {});
    if (!read.ok) return { step: 'read', error: read.error };
    const target = read.value.page.elements.find((e) => e.name === 'Save');
    if (!target) return { step: 'find', names: read.value.page.elements.map((e) => e.name) };

    // The page replaces its own controls. Every handle above is now dead.
    const count = await chrome.scripting.executeScript({
      target: { tabId },
      func: (flag) => window.rerender(flag),
      args: [${ambiguous}],
      world: 'MAIN',
    });

    const clicked = await ask('content.click', { elementId: target.elementId });
    return { step: 'done', clicked, buttons: count[0]?.result };
  })()
`;

test('a stale handle is recovered when the element is unambiguous', async ({
  context,
  serviceWorker,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/rerender`);
  await page.waitForLoadState('domcontentloaded');
  await page.bringToFront();

  const outcome: { step?: string; clicked?: Reply; buttons?: number; names?: string[] } =
    await serviceWorker.evaluate(SCRIPT(false));

  expect(outcome.step, JSON.stringify(outcome)).toBe('done');
  expect(outcome.buttons).toBe(1);
  expect(outcome.clicked?.ok, JSON.stringify(outcome.clicked)).toBe(true);
  // Reported, so a click on a node the model did not literally name is
  // distinguishable in the result and in the trail.
  expect(outcome.clicked?.value?.relocated).toBe(true);

  // And it landed on the **new** node, which the page's own listener recorded.
  const recorded = await page.evaluate(() => document.getElementById('clicked')?.textContent ?? '');
  expect(recorded).toBe('second:2');

  await page.close();
});

test('a stale handle is refused when the page now has two of them', async ({
  context,
  serviceWorker,
  site,
}) => {
  // **The case that matters.** A row was added, two controls share the label,
  // and choosing between them is how an agent acts on the wrong one.
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/rerender`);
  await page.waitForLoadState('domcontentloaded');
  await page.bringToFront();

  const outcome: { step?: string; clicked?: Reply; buttons?: number } =
    await serviceWorker.evaluate(SCRIPT(true));

  expect(outcome.step, JSON.stringify(outcome)).toBe('done');
  expect(outcome.buttons).toBe(2);
  expect(outcome.clicked?.ok).toBe(false);
  // The message names the count, so the model reads the page and chooses
  // rather than retrying the same dead handle.
  expect(outcome.clicked?.error?.userMessage ?? '').toMatch(/2 elements/);

  // Nothing was clicked: the page's own listener never fired.
  const recorded = await page.evaluate(() => document.getElementById('clicked')?.textContent ?? '');
  expect(recorded).toBe('none');

  await page.close();
});

test('recovery added no permission and no host access', async ({ serviceWorker }) => {
  // The same access any script on the page already has: one more
  // `querySelectorAll` walk, on the path where a handle has already failed.
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
  expect(manifest.optional_permissions ?? []).toEqual(['downloads', 'identity']);
  expect(manifest.host_permissions ?? []).toEqual(['http://*/*', 'https://*/*']);
});
