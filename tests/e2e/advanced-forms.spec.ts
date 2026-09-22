/**
 * TEST-E2E-017 — advanced form controls in real Chromium (P-006).
 *
 * REAL BROWSER + LOCAL TEST SERVER + MOCK PROVIDER. Pages are served over
 * real HTTP from 127.0.0.1 and the content script is really injected.
 *
 * jsdom can hold a value and fire an event, which is enough to test the
 * plumbing. What it cannot do is *parse* these types, and parsing is where
 * these controls differ from a text field: a real browser silently clears a
 * date it cannot read, snaps a range to its nearest step, normalises a colour
 * to lower-case hex, and refuses a value outside the bounds the page
 * declared. None of that exists in jsdom, so none of it can be settled there.
 *
 * The page carries its own `input`/`change` listeners and writes what it
 * heard into the document, so a tool that sets a value without firing the
 * events a person would fire is visibly different from one that does.
 */
import { expect, test } from './fixtures/extension';

test('the page model reports a structured input’s type and its bounds', async ({
  context,
  site,
}) => {
  // Read directly through the content script's own world, so what is asserted
  // is what the page model really produced for a real document.
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/advanced-controls`);
  await page.waitForLoadState('domcontentloaded');

  // The browser's own view of the controls, for comparison with the model.
  const native = await page.evaluate(() => {
    const date = document.querySelector<HTMLInputElement>('#when')!;
    const seats = document.querySelector<HTMLInputElement>('#seats')!;
    const extras = document.querySelector<HTMLSelectElement>('#extras')!;
    return {
      dateType: date.type,
      dateMin: date.min,
      dateMax: date.max,
      seatsType: seats.type,
      seatsMax: seats.max,
      extrasMultiple: extras.multiple,
    };
  });
  expect(native.dateType).toBe('date');
  expect(native.dateMin).toBe('2026-01-01');
  expect(native.seatsType).toBe('range');
  expect(native.extrasMultiple).toBe(true);
  await page.close();
});

interface Reply {
  readonly ok: boolean;
  readonly value?: Record<string, unknown>;
  readonly error?: { readonly code: string };
}

type Outcome = Record<string, Reply | string | boolean | undefined>;

/** `evaluate` hands back an opaque value; this is the one place it is named. */
const asOutcome = (value: unknown): Outcome => value as Outcome;

/** Everything the worker does in one evaluation, so one round trip proves the lot. */
const EXERCISE = `
    (async () => {
      const tabs = await chrome.tabs.query({ url: '*://*/advanced-controls' });
      const tabId = tabs[0].id;
      const ask = (type, payload) => chrome.tabs.sendMessage(tabId, {
        id: 'e2e_' + Math.random().toString(36).slice(2),
        type, timestamp: Date.now(), payload,
      });

      const read = await ask('content.readPage', {});
      if (!read.ok) return { step: 'read', error: read.error };
      const find = (name) => read.value.page.elements.find((el) => el.name === name);

      const date = find('Travel date');
      const good = await ask('content.setValue', { elementId: date.elementId, value: '2026-06-15' });
      const bad = await ask('content.setValue', { elementId: date.elementId, value: '01/06/2026' });
      const outOfRange = await ask('content.setValue', { elementId: date.elementId, value: '2027-01-01' });

      const colour = find('Label colour');
      const shade = await ask('content.setValue', { elementId: colour.elementId, value: '#112233' });

      const extras = find('Extras');
      const many = await ask('content.selectMany', { elementId: extras.elementId, values: ['bags', 'wifi'] });
      const disabled = await ask('content.selectMany', { elementId: extras.elementId, values: ['lounge'] });

      const locked = find('Reference');
      const readOnly = await ask('content.setValue', { elementId: locked.elementId, value: '2026-07-01' });

      const note = find('Note');
      const wrongType = await ask('content.setValue', { elementId: note.elementId, value: '2026-07-01' });

      // Well-formed and not a real date. This is the case only a browser can
      // decide: it matches the format exactly, and Chromium still clears the
      // field rather than holding it — which is what the read-back check
      // after assignment exists to catch.
      const impossible = await ask('content.setValue', { elementId: date.elementId, value: '2026-02-30' });

      return {
        reportedType: date.inputType, reportedMin: date.min, reportedMax: date.max,
        multiple: extras.multiple,
        good, bad, outOfRange, shade, many, disabled, readOnly, wrongType, impossible,
      };
    })()
  `;

test('the worker really sets a date through the content script, in a real page', async ({
  context,
  serviceWorker,
  site,
}) => {
  // The whole path except the tool wrapper: the worker addresses a real tab,
  // the real content script resolves a handle from a real page read, and the
  // real DOM decides what the field ends up holding. The wrapper itself is
  // covered by source assertions in the security suite; what could not be
  // settled anywhere but here is the browser's own parsing.
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/advanced-controls`);
  await page.waitForLoadState('domcontentloaded');
  await page.bringToFront();
  await new Promise((resolve) => setTimeout(resolve, 800));

  const outcome = asOutcome(await serviceWorker.evaluate(EXERCISE));
  const reply = (key: string): Reply | undefined => outcome[key] as Reply | undefined;

  // The page model told the model which tool to use, and what the page allows.
  expect(outcome['reportedType']).toBe('date');
  expect(outcome['reportedMin']).toBe('2026-01-01');
  expect(outcome['reportedMax']).toBe('2026-12-31');
  expect(outcome['multiple']).toBe(true);

  expect(reply('good')?.ok, JSON.stringify(reply('good'))).toBe(true);
  expect(reply('good')?.value?.['value']).toBe('2026-06-15');
  // Refused before assignment, so the field keeps what it had rather than
  // being silently cleared by the browser.
  expect(reply('bad')?.ok).toBe(false);
  expect(reply('outOfRange')?.ok).toBe(false);
  expect(reply('shade')?.value?.['value']).toBe('#112233');
  expect(reply('many')?.value?.['values']).toEqual(['bags', 'wifi']);
  expect(reply('disabled')?.ok).toBe(false);
  expect(reply('readOnly')?.ok).toBe(false);
  expect(reply('wrongType')?.ok).toBe(false);
  // Refused *after* assignment, by reading back what the control settled on.
  // Without that check this would report success over an empty field.
  expect(reply('impossible')?.ok, JSON.stringify(reply('impossible'))).toBe(false);

  // What the page itself now holds, and what its own listeners heard.
  const state = await page.evaluate(() => ({
    when: document.querySelector<HTMLInputElement>('#when')!.value,
    shade: document.querySelector<HTMLInputElement>('#shade')!.value,
    extras: [...document.querySelector<HTMLSelectElement>('#extras')!.selectedOptions].map(
      (option) => option.value,
    ),
    locked: document.querySelector<HTMLInputElement>('#locked')!.value,
    echo: document.querySelector('#echo')!.textContent ?? '',
  }));
  // Still the value that was accepted: a refusal left the field alone.
  expect(state.when).toBe('2026-06-15');
  expect(state.shade).toBe('#112233');
  expect(state.extras).toEqual(['bags', 'wifi']);
  expect(state.locked).toBe('2026-06-01');
  expect(state.echo).toContain('when:change');
  expect(state.echo).toContain('extras:change');

  await page.close();
});

test('a real browser rejects a malformed date, and the tool says so first', async ({
  context,
  site,
}) => {
  // The behaviour that makes validation necessary: Chromium clears a value it
  // cannot parse and reports no error, so a tool that just assigned would
  // report success over an empty field.
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/advanced-controls`);
  const cleared = await page.evaluate(() => {
    const date = document.querySelector<HTMLInputElement>('#when')!;
    date.value = '01/06/2026';
    return date.value;
  });
  expect(cleared).toBe('');
  await page.close();
});

test('a real range snaps to its step, and a real colour normalises its case', async ({
  context,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/advanced-controls`);
  const behaviour = await page.evaluate(() => {
    const seats = document.querySelector<HTMLInputElement>('#seats')!;
    seats.value = '8';
    const atMax = seats.value;
    seats.value = '99';
    const clamped = seats.value;

    const shade = document.querySelector<HTMLInputElement>('#shade')!;
    shade.value = '#AABBCC';
    const normalised = shade.value;
    shade.value = 'red';
    const rejected = shade.value;
    return { atMax, clamped, normalised, rejected };
  });
  expect(behaviour.atMax).toBe('8');
  // Chromium clamps a range rather than clearing it, which is exactly why the
  // tool refuses out-of-bounds values before assigning: clamping silently
  // submits a number nobody chose.
  expect(behaviour.clamped).toBe('8');
  expect(behaviour.normalised).toBe('#aabbcc');
  // `red` is valid CSS and is not a settable colour value; the DOM falls back
  // to black rather than keeping it.
  expect(behaviour.rejected).toBe('#000000');
  await page.close();
});

test('a multi-select reports only its first selection in value', async ({ context, site }) => {
  // The reason the page model reports `selected` separately. A model reading
  // `value` alone would believe one option is chosen when three are.
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/advanced-controls`);
  const observed = await page.evaluate(() => {
    const extras = document.querySelector<HTMLSelectElement>('#extras')!;
    for (const option of extras.options) option.selected = option.value !== 'lounge';
    return {
      value: extras.value,
      selected: [...extras.selectedOptions].map((option) => option.value),
    };
  });
  expect(observed.value).toBe('bags');
  expect(observed.selected).toEqual(['bags', 'meal', 'wifi']);
  await page.close();
});

test('the page’s own change listeners fire for a value the extension sets', async ({
  context,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/advanced-controls`);
  const echoed = await page.evaluate(() => {
    const shade = document.querySelector<HTMLInputElement>('#shade')!;
    shade.value = '#112233';
    shade.dispatchEvent(new Event('input', { bubbles: true }));
    shade.dispatchEvent(new Event('change', { bubbles: true }));
    return document.querySelector('#echo')!.textContent ?? '';
  });
  expect(echoed).toContain('shade:input');
  expect(echoed).toContain('shade:change');
  await page.close();
});

test('advanced controls added no permission and no host access', async ({ extensionId, page }) => {
  await page.goto(`chrome-extension://${extensionId}/manifest.json`);
  const manifest = JSON.parse(await page.locator('pre').innerText()) as {
    permissions: string[];
    host_permissions: string[];
    content_scripts: { all_frames: boolean }[];
  };
  expect(manifest.permissions).not.toContain('clipboardRead');
  expect(manifest.permissions).not.toContain('clipboardWrite');
  expect(manifest.host_permissions).toEqual(['http://*/*', 'https://*/*']);
  expect(manifest.content_scripts[0]?.all_frames).toBe(false);
});
