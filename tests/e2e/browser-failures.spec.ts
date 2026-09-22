/**
 * TEST-E2E-018 — the browser-failure cases §89 names that nothing covered.
 *
 * REAL BROWSER + LOCAL TEST SERVER. These four were recorded as gaps in
 * `docs/testing/acceptance/89-browser-failures.md`: popup handling, SPA
 * navigation, modal dialogs and iframes. The acceptance package said plainly
 * that nobody had looked. This is looking.
 *
 * They belong together because they share one failure mode, and it is the
 * dangerous one for an agent: not an error, but a tool that quietly does
 * something adjacent to what was asked and reports success. Clicking an
 * element a person could not have clicked. Acting on a route that no longer
 * exists. Reading a page and silently omitting half of it.
 *
 * Every assertion here is about what the extension really did in a real
 * Chromium against a real HTTP server. Where the answer is "the extension
 * cannot see this", that is asserted as the observable consequence rather
 * than as a claim about the manifest.
 */
import { expect, test } from './fixtures/extension';

/** Ask the content script something, through the worker, as the tools do. */
const ASK = (path: string, type: string, payload: string) => `
  (async () => {
    const tabs = await chrome.tabs.query({ url: '*://*${path}' });
    if (tabs.length === 0) return { error: 'no tab matching ${path}' };
    const reply = await chrome.tabs.sendMessage(tabs[0].id, {
      id: 'e2e_' + Math.random().toString(36).slice(2),
      type: '${type}', timestamp: Date.now(), payload: ${payload},
    });
    return reply;
  })()
`;

interface Reply {
  readonly ok: boolean;
  readonly value?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly message?: string };
}

/** What the frame probe hands back: which frames answered a content message. */
interface FrameProbe {
  readonly frameCount: number | null;
  readonly replies: { readonly frameId: number; readonly answered: boolean }[];
}

interface Element {
  readonly elementId: string;
  readonly role: string;
  readonly name: string;
}

const elements = (reply: Reply): Element[] =>
  (reply.value?.['page'] as { elements?: Element[] } | undefined)?.elements ?? [];

// ---------------------------------------------------------------------------
// §89 Popup
// ---------------------------------------------------------------------------

test.describe('§89 popup — a second tab the page opened', () => {
  test('a target=_blank link really opens a second tab, and the agent sees both', async ({
    context,
    serviceWorker,
    site,
  }) => {
    const page = await context.newPage();
    await page.goto(`${site.baseUrl}/popup`);
    await page.waitForLoadState('domcontentloaded');
    await new Promise((resolve) => setTimeout(resolve, 600));

    const before: number = await serviceWorker.evaluate(
      `chrome.tabs.query({}).then((t) => t.length)`,
    );

    // Clicked by the person, not by the agent: this establishes what the
    // browser does, which is the precondition for asking what the agent does
    // about it.
    const opened = context.waitForEvent('page');
    await page.click('#blank');
    const popup = await opened;
    await popup.waitForLoadState('domcontentloaded');

    const after: number = await serviceWorker.evaluate(
      `chrome.tabs.query({}).then((t) => t.length)`,
    );
    expect(after, 'a new tab really opened').toBe(before + 1);

    // The agent's view of the browser includes it. `tabs.list` is how a task
    // discovers tabs, so a popup that were invisible here would be a tab the
    // agent could never reason about.
    const listed: string[] = await serviceWorker.evaluate(
      `chrome.tabs.query({}).then((tabs) => tabs.map((t) => t.url))`,
    );
    expect(listed.filter((url) => url.includes('/details'))).toHaveLength(1);

    await popup.close();
    await page.close();
  });

  test('the content script is injected into the popup, so it is automatable', async ({
    context,
    serviceWorker,
    site,
  }) => {
    const page = await context.newPage();
    await page.goto(`${site.baseUrl}/popup`);
    await new Promise((resolve) => setTimeout(resolve, 600));

    const opened = context.waitForEvent('page');
    await page.click('#opener');
    const popup = await opened;
    await popup.waitForLoadState('domcontentloaded');
    await new Promise((resolve) => setTimeout(resolve, 800));

    // A popup that no content script reached would be a tab the agent can see
    // and cannot act on — which is a worse state than not seeing it, because
    // the failure arrives later and further from its cause.
    const read: Reply = await serviceWorker.evaluate(ASK('/details', 'content.readPage', '{}'));
    expect(read.error, JSON.stringify(read.error)).toBeUndefined();
    expect(read.ok).toBe(true);
    expect(read.value?.['page']).toBeTruthy();

    await popup.close();
    await page.close();
  });
});

// ---------------------------------------------------------------------------
// §89 SPA navigation
// ---------------------------------------------------------------------------

test.describe('§89 SPA navigation — the URL changed and the document did not', () => {
  test('a handle from before a client-side route change is refused, not resolved', async ({
    context,
    serviceWorker,
    site,
  }) => {
    const page = await context.newPage();
    await page.goto(`${site.baseUrl}/spa`);
    await page.waitForLoadState('domcontentloaded');
    await new Promise((resolve) => setTimeout(resolve, 600));

    const read: Reply = await serviceWorker.evaluate(ASK('/spa', 'content.readPage', '{}'));
    expect(read.ok, JSON.stringify(read.error)).toBe(true);
    const home = elements(read).find((element) => element.name === 'Home action');
    expect(home, 'the home-route button is in the page model').toBeTruthy();

    // The route changes with no document load. `history.pushState` leaves the
    // element registry intact — the generation does not advance — so the only
    // thing standing between the agent and a click on a detached node is the
    // engine's own `isConnected` check.
    await page.click('#go');
    await page.waitForFunction(() => window.location.pathname === '/spa/settings');
    expect(await page.evaluate(() => document.getElementById('home-action'))).toBeNull();

    const clicked: Reply = await serviceWorker.evaluate(
      ASK('/spa/settings', 'content.click', `{ elementId: '${home?.elementId}' }`),
    );

    // The assertion that matters: it must not report success. A click on a
    // node that is no longer in the document does nothing visible and would
    // otherwise be reported as done.
    expect(clicked.ok, JSON.stringify(clicked)).toBe(false);
    // The real refusal, quoted rather than approximated: an earlier version of
    // this matched `/not found/` and the code is `ELEMENT_NOT_FOUND`, so the
    // assertion failed while the product was correct.
    expect(clicked.error?.code).toBe('ELEMENT_NOT_FOUND');
    expect(clicked.error?.message).toContain('removed from the page');
    // And it tells the caller what to do about it, which is what makes this a
    // recoverable failure rather than a dead end.
    expect(clicked.error?.message).toContain('Read the page again');

    await page.close();
  });

  test('a fresh read after the route change sees the new route and not the old', async ({
    context,
    serviceWorker,
    site,
  }) => {
    const page = await context.newPage();
    await page.goto(`${site.baseUrl}/spa`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await page.click('#go');
    await page.waitForFunction(() => window.location.pathname === '/spa/settings');

    const read: Reply = await serviceWorker.evaluate(
      ASK('/spa/settings', 'content.readPage', '{}'),
    );
    expect(read.ok, JSON.stringify(read.error)).toBe(true);
    const names = elements(read).map((element) => element.name);
    expect(names).toContain('Settings action');
    expect(names, 'the old route is gone from the model').not.toContain('Home action');

    await page.close();
  });
});

// ---------------------------------------------------------------------------
// §89 Modal
// ---------------------------------------------------------------------------

test.describe('§89 modal — an element a person could not click', () => {
  test('the modal and the element behind it are both in the page model', async ({
    context,
    serviceWorker,
    site,
  }) => {
    // Establishing the starting point rather than the conclusion: the page
    // model is built from the DOM, and a button behind an overlay is still a
    // visible, enabled button in the DOM.
    const page = await context.newPage();
    await page.goto(`${site.baseUrl}/modal`);
    await new Promise((resolve) => setTimeout(resolve, 600));

    const read: Reply = await serviceWorker.evaluate(ASK('/modal', 'content.readPage', '{}'));
    expect(read.ok, JSON.stringify(read.error)).toBe(true);
    const names = elements(read).map((element) => element.name);
    expect(names).toContain('Accept');
    expect(names).toContain('Buy now');

    await page.close();
  });

  test('what the browser itself says about the obscured element', async ({ context, site }) => {
    // The ground truth the next test is measured against. A real person
    // clicking at the centre of "Buy now" hits the overlay.
    const page = await context.newPage();
    await page.goto(`${site.baseUrl}/modal`);
    const topmost = await page.evaluate(() => {
      const target = document.getElementById('behind')!;
      const box = target.getBoundingClientRect();
      const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return at?.id ?? null;
    });
    expect(topmost, 'the overlay covers the button').toBe('overlay');
    await page.close();
  });

  test('clicking the obscured element: what the extension actually does', async ({
    context,
    serviceWorker,
    site,
  }) => {
    const page = await context.newPage();
    await page.goto(`${site.baseUrl}/modal`);
    await new Promise((resolve) => setTimeout(resolve, 600));

    const read: Reply = await serviceWorker.evaluate(ASK('/modal', 'content.readPage', '{}'));
    const behind = elements(read).find((element) => element.name === 'Buy now');
    expect(behind).toBeTruthy();

    const clicked: Reply = await serviceWorker.evaluate(
      ASK('/modal', 'content.click', `{ elementId: '${behind?.elementId}' }`),
    );

    // The acceptance criterion, unchanged from the one written before this
    // ran: not met if it reports a successful click on an element a person
    // could not have clicked. The first execution failed it — a synthetic
    // click reaches the node whatever is painted over it, so the extension
    // reported success on a control the overlay made unreachable. The engine
    // now hit-tests after scrolling, and the refusal is what that fixed.
    expect(clicked.ok, JSON.stringify(clicked)).toBe(false);
    expect(clicked.error?.code).toBe('ELEMENT_NOT_INTERACTABLE');
    expect(clicked.error?.message).toContain('covering this element');
    // It names the likely cause and the way out, because "not interactable"
    // alone leaves a model with nothing to try.
    expect(clicked.error?.message).toMatch(/dialog, cookie banner or overlay/i);

    // And the page really was left alone. Asserting the refusal without this
    // would pass against a build that refused *and* clicked anyway.
    const echo = await page.evaluate(
      () => document.getElementById('echo')?.textContent ?? 'missing',
    );
    expect(echo, 'the obscured button was never activated').toBe('nothing clicked');

    await page.close();
  });

  test('dismissing the modal first makes the element reachable', async ({
    context,
    serviceWorker,
    site,
  }) => {
    // The positive control, and the path a correct agent takes: deal with the
    // dialog, then act. If this fails, the case above proves nothing.
    const page = await context.newPage();
    await page.goto(`${site.baseUrl}/modal`);
    await new Promise((resolve) => setTimeout(resolve, 600));

    const first: Reply = await serviceWorker.evaluate(ASK('/modal', 'content.readPage', '{}'));
    const accept = elements(first).find((element) => element.name === 'Accept');
    const dismissed: Reply = await serviceWorker.evaluate(
      ASK('/modal', 'content.click', `{ elementId: '${accept?.elementId}' }`),
    );
    expect(dismissed.ok, JSON.stringify(dismissed)).toBe(true);
    await page.waitForFunction(() => document.getElementById('overlay') === null);

    const second: Reply = await serviceWorker.evaluate(ASK('/modal', 'content.readPage', '{}'));
    const behind = elements(second).find((element) => element.name === 'Buy now');
    const clicked: Reply = await serviceWorker.evaluate(
      ASK('/modal', 'content.click', `{ elementId: '${behind?.elementId}' }`),
    );
    expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
    await expect(page.locator('#echo')).toHaveText('behind clicked');

    await page.close();
  });
});

// ---------------------------------------------------------------------------
// §89 Iframe
// ---------------------------------------------------------------------------

test.describe('§89 iframe — out of reach, and observably so', () => {
  test('the frame really loaded, so the exclusion is not an empty page', async ({
    context,
    site,
  }) => {
    const page = await context.newPage();
    await page.goto(`${site.baseUrl}/iframe-host`);
    await page.waitForLoadState('load');
    const frame = page.frames().find((candidate) => candidate.url().includes('/iframe-child'));
    expect(frame, 'the child document is really there').toBeTruthy();
    expect(await frame!.locator('#inner-button').textContent()).toBe('Inner button');
    await page.close();
  });

  test('the page model holds the outer document and nothing from the frame', async ({
    context,
    serviceWorker,
    site,
  }) => {
    const page = await context.newPage();
    await page.goto(`${site.baseUrl}/iframe-host`);
    await page.waitForLoadState('load');
    await new Promise((resolve) => setTimeout(resolve, 800));

    const read: Reply = await serviceWorker.evaluate(ASK('/iframe-host', 'content.readPage', '{}'));
    expect(read.ok, JSON.stringify(read.error)).toBe(true);
    const names = elements(read).map((element) => element.name);

    expect(names, 'the outer document is readable').toContain('Outer button');
    // The architectural limit, as its observable consequence. `all_frames` is
    // false, so no content script runs in the child and nothing in it can
    // reach the model — including a field a task might badly want.
    expect(names).not.toContain('Inner button');
    expect(names).not.toContain('inner');

    await page.close();
  });

  test('the agent cannot act inside the frame, because it has no handle to', async ({
    context,
    serviceWorker,
    site,
  }) => {
    const page = await context.newPage();
    await page.goto(`${site.baseUrl}/iframe-host`);
    await page.waitForLoadState('load');
    await new Promise((resolve) => setTimeout(resolve, 800));

    // There is no element id for the inner button, so the only way to try is
    // to invent one — and an invented handle is refused rather than resolved.
    const invented: Reply = await serviceWorker.evaluate(
      ASK('/iframe-host', 'content.click', `{ elementId: 'e1-9999' }`),
    );
    expect(invented.ok).toBe(false);

    // And the frame's own state is untouched by any of it.
    const frame = page.frames().find((candidate) => candidate.url().includes('/iframe-child'));
    expect(await frame!.locator('#inner-field').inputValue()).toBe('');

    await page.close();
  });

  test('Chrome injected the content script into exactly one frame', async ({
    context,
    serviceWorker,
    site,
  }) => {
    const page = await context.newPage();
    await page.goto(`${site.baseUrl}/iframe-host`);
    await page.waitForLoadState('load');
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Asked of Chrome rather than of the manifest: `frameId: 0` is the main
    // frame, and a reply from any other frame id would mean the content
    // script had been injected where the manifest says it is not.
    const frames: FrameProbe = await serviceWorker.evaluate(`
      (async () => {
        const tabs = await chrome.tabs.query({ url: '*://*/iframe-host' });
        const all = await chrome.webNavigation?.getAllFrames?.({ tabId: tabs[0].id });
        const replies = [];
        for (const frameId of [0, 1]) {
          try {
            const reply = await chrome.tabs.sendMessage(
              tabs[0].id,
              { id: 'f' + frameId, type: 'content.readPage', timestamp: Date.now(), payload: {} },
              { frameId },
            );
            replies.push({ frameId, answered: Boolean(reply) });
          } catch (error) {
            replies.push({ frameId, answered: false, error: String(error).slice(0, 80) });
          }
        }
        return { frameCount: all?.length ?? null, replies };
      })()
    `);

    expect(frames.replies.find((reply) => reply.frameId === 0)?.answered).toBe(true);
    expect(frames.replies.find((reply) => reply.frameId === 1)?.answered).toBe(false);

    await page.close();
  });
});
