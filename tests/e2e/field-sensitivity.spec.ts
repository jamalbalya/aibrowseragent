/**
 * TEST-E2E-036 — Gate 1 field sensitivity in real Chromium (INV-FS-12).
 *
 * REAL BROWSER + LOCAL TEST SERVER. Pages are served over real HTTP from
 * 127.0.0.1 and the content script is really injected.
 *
 * One claim cannot be settled anywhere but here: that a field which changes
 * *after* the page was read is caught before anything is written into it.
 * Every layer of that is browser behaviour — the content script's registry
 * holds a live node across the mutation, `input.type` reflects an attribute
 * the page rewrote under it, and the two messages are genuinely separated in
 * time by a real message channel. A unit test can mutate a jsdom attribute and
 * compare two classifications, which is worth having and is a different claim;
 * it cannot show that the refusal happens on the path a write actually takes.
 *
 * The complementary case matters as much as the refusal: the same field, not
 * mutated, is written successfully. Without it, a refusal proves only that
 * something in the path is broken.
 */
import { expect, test } from './fixtures/extension';

interface Reply {
  readonly ok: boolean;
  readonly value?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly userMessage?: string };
}

type Outcome = Record<string, Reply | string | boolean | undefined>;

const asOutcome = (value: unknown): Outcome => value as Outcome;

/**
 * Reads the page, then writes twice: once into a field nobody touched, and
 * once into a field the page turned into a password box in between.
 *
 * Both writes carry the ceiling the worker would have derived at read time —
 * `ORDINARY`, because at read time both fields were ordinary text boxes. That
 * is the whole point: the authorisation was correct when it was made, and the
 * page changed the facts underneath it.
 */
const EXERCISE = `
    (async () => {
      const tabs = await chrome.tabs.query({ url: '*://*/shifty-form' });
      const tabId = tabs[0].id;
      const ask = (type, payload) => chrome.tabs.sendMessage(tabId, {
        id: 'e2e_' + Math.random().toString(36).slice(2),
        type, timestamp: Date.now(), payload,
      });

      const read = await ask('content.readPage', {});
      if (!read.ok) return { step: 'read', error: read.error };

      const byName = (name) => read.value.page.elements.find((el) => el.name === name);
      const fieldFor = (id) => read.value.page.fields.find((f) => f.elementId === id);

      const nickname = byName('Nickname');
      const memorable = byName('Memorable word');

      // What the page told the worker at read time, before it changed its mind.
      const observedBefore = fieldFor(memorable.elementId);

      // The page rewrites the field into a credential field. Same node, same
      // handle, different thing.
      const mutatedTo = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => window.mutate(),
      });

      // The control: an untouched ordinary field still accepts a write.
      const untouched = await ask('content.type', {
        elementId: nickname.elementId,
        text: 'ordinary-value',
        sensitivityCeiling: 'ORDINARY',
      });

      // The case: the same authorisation, against a field that is now a
      // password box.
      const refused = await ask('content.type', {
        elementId: memorable.elementId,
        text: 'should-never-be-typed',
        sensitivityCeiling: 'ORDINARY',
      });

      const values = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => ({
          nickname: document.getElementById('ordinary').value,
          memorable: document.getElementById('later').value,
          memorableType: document.getElementById('later').type,
        }),
      });

      return {
        observedBeforeType: observedBefore ? observedBefore.fieldType : null,
        mutatedTo: mutatedTo[0].result,
        untouched,
        refused,
        finalValues: values[0].result,
      };
    })()
  `;

test('a field that becomes a password after the page was read is refused', async ({
  context,
  serviceWorker,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/shifty-form`);
  await page.waitForLoadState('domcontentloaded');
  await page.bringToFront();
  await new Promise((resolve) => setTimeout(resolve, 800));

  const outcome = asOutcome(await serviceWorker.evaluate(EXERCISE));
  const reply = (key: string): Reply | undefined => outcome[key] as Reply | undefined;

  // The read saw an ordinary text box, which is why the ceiling was ORDINARY.
  expect(outcome['observedBeforeType']).toBe('text');
  // And the page really did change it, in the real DOM.
  expect(outcome['mutatedTo']).toBe('password');

  // The control. If this fails, the refusal below proves nothing.
  expect(reply('untouched')?.ok, JSON.stringify(reply('untouched'))).toBe(true);

  // The case.
  expect(reply('refused')?.ok, JSON.stringify(reply('refused'))).toBe(false);
  expect(reply('refused')?.error?.code).toBe('POLICY_BLOCKED');

  const values = outcome['finalValues'] as unknown as Record<string, string>;
  expect(values['nickname']).toBe('ordinary-value');
  // Nothing was written into the field that changed. Asserted on the page
  // itself rather than on the reply, because the reply is what the extension
  // says happened and this is what actually did.
  expect(values['memorable']).toBe('');
  expect(values['memorableType']).toBe('password');

  await page.close();
});

/**
 * The same page, read *after* the mutation.
 *
 * Separate from the case above because it is a different property: there, the
 * worker was right and the page changed; here, the worker knows from the start
 * and never authorises the write at all. Both have to hold — one closes the
 * window, the other closes the ordinary path.
 */
const AFTER_MUTATION = `
    (async () => {
      const tabs = await chrome.tabs.query({ url: '*://*/shifty-form' });
      const tabId = tabs[0].id;
      const ask = (type, payload) => chrome.tabs.sendMessage(tabId, {
        id: 'e2e_' + Math.random().toString(36).slice(2),
        type, timestamp: Date.now(), payload,
      });

      await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN', func: () => window.mutate(),
      });

      const read = await ask('content.readPage', {});
      if (!read.ok) return { step: 'read', error: read.error };

      const memorable = read.value.page.elements.find((el) => el.name === 'Memorable word');
      const observed = read.value.page.fields.find((f) => f.elementId === memorable.elementId);

      // Whatever the worker would have derived, the content script refuses a
      // write that claims an ordinary ceiling for this field.
      const attempt = await ask('content.type', {
        elementId: memorable.elementId,
        text: 'should-never-be-typed',
        sensitivityCeiling: 'ORDINARY',
      });

      return {
        observedType: observed ? observed.fieldType : null,
        observedToken: observed ? observed.autocompleteToken : null,
        elementsMentionValue: JSON.stringify(read.value.page.elements),
        attempt,
      };
    })()
  `;

test('a password field is reported as one and never has its value read', async ({
  context,
  serviceWorker,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/shifty-form`);
  await page.waitForLoadState('domcontentloaded');
  // Put something in the field first, so "no value was reported" is a real
  // observation rather than the field simply being empty.
  await page.fill('#who', 'someone');
  await page.evaluate(() => {
    (document.getElementById('later') as HTMLInputElement).value = 'pre-existing-secret';
  });
  await page.bringToFront();
  await new Promise((resolve) => setTimeout(resolve, 800));

  const outcome = asOutcome(await serviceWorker.evaluate(AFTER_MUTATION));

  expect(outcome['observedType']).toBe('password');
  expect(outcome['observedToken']).toBe('current-password');

  // The raw observation went to the worker; the password's value did not go
  // anywhere. The model-facing element list is what would have carried it.
  expect(outcome['elementsMentionValue'] as string).not.toContain('pre-existing-secret');
  // And the ordinary field's value is still reported, so the assertion above
  // is about passwords rather than about values never being reported at all.
  expect(outcome['elementsMentionValue'] as string).toContain('someone');

  const attempt = outcome['attempt'] as Reply | undefined;
  expect(attempt?.ok, JSON.stringify(attempt)).toBe(false);
  expect(attempt?.error?.code).toBe('POLICY_BLOCKED');

  await page.close();
});
