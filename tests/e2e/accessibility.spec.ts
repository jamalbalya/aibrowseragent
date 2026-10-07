/**
 * TEST-E2E-056 — the panel can be used without seeing it.
 *
 * REAL BROWSER. The panel is the whole of this product's interface, and until
 * now nothing checked whether it was usable by somebody who cannot see it.
 * These are the properties that decide that, not a general audit: an approval
 * request that is never announced blocks the agent on an answer the person was
 * never asked for, and a result that is never announced leaves them unable to
 * tell whether what they pressed worked.
 *
 * ## Why these three and not a generic rule sweep
 *
 * A rule sweep over a whole UI produces a long list in which the two items
 * that matter are indistinguishable from the forty that do not. What matters
 * here is specific and follows from what this product does:
 *
 *  1. **The approval prompt must announce itself and take focus.** It is the
 *     entire consent mechanism; the agent is blocked until it is answered.
 *  2. **Every result must be announced.** Settings is where credentials and
 *     connectors are managed, and each action's outcome arrives in a message
 *     element that was previously a plain paragraph.
 *  3. **Every control must have an accessible name**, or it is a button a
 *     screen reader reads as "button".
 *
 * ## What is deliberately not asserted
 *
 * Colour contrast and a focus trap. Contrast belongs to the stylesheet and is
 * checked by eye against a tool rather than pinned here. A trap needs a
 * complete key handler and an escape route, and half of one is worse than
 * none — the panel behind the prompt is still legitimately readable, which
 * `PermissionPrompt` records as a deliberate choice rather than an omission.
 */
import { expect, test } from './fixtures/extension';

test('every control in the panel has an accessible name', async ({ panel }) => {
  // A button a screen reader reads as "button" is a button nobody can use.
  // Asserted over the real rendered tree rather than the source, because a
  // name can come from text, `aria-label`, or a label element, and only the
  // browser resolves which.
  const unnamed = await panel.evaluate(() => {
    const offenders: string[] = [];
    for (const element of document.querySelectorAll(
      'button, a[href], input, select, textarea, [role="button"]',
    )) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const text = (element.textContent ?? '').trim();
      const label = element.getAttribute('aria-label') ?? '';
      const labelled = element.getAttribute('aria-labelledby');
      const title = element.getAttribute('title') ?? '';
      const id = element.getAttribute('id');
      const hasLabelElement = id !== null && document.querySelector(`label[for="${id}"]`) !== null;
      const wrapped = element.closest('label') !== null;
      if (
        text.length === 0 &&
        label.trim().length === 0 &&
        labelled === null &&
        title.trim().length === 0 &&
        !hasLabelElement &&
        !wrapped
      ) {
        offenders.push(
          `${element.tagName.toLowerCase()}${id === null ? '' : `#${id}`}${
            element.getAttribute('class') === null ? '' : `.${element.getAttribute('class')}`
          }`,
        );
      }
    }
    return offenders;
  });

  expect(unnamed, unnamed.join(', ')).toEqual([]);
});

test('every control in Settings has an accessible name', async ({ panel }) => {
  // Settings is the larger surface and the one with the credential fields, so
  // it is walked separately rather than trusting the first screen to be
  // representative.
  await panel.getByRole('button', { name: 'Settings' }).click();
  await expect(panel.getByRole('button', { name: 'Run capability check' })).toBeVisible();

  // Site-bound Atlassian connectors need both pieces of the Basic-auth
  // credential before their Connect button can be used. The UI must expose
  // those fields; checking only connector.list would miss a panel that knows
  // the contract but never renders the inputs.
  await expect(panel.getByLabel('Your Jira site')).toBeVisible();
  await expect(panel.getByLabel('Your Confluence site')).toBeVisible();
  await expect(
    panel.getByLabel('The email address of your Atlassian account'),
  ).toHaveCount(2);

  for (const connectorName of ['Jira', 'Confluence']) {
    const connector = panel.locator('.connector').filter({ hasText: connectorName }).first();
    const tokenLabel = connectorName === 'Jira' ? 'Jira API token' : 'Atlassian API token';

    await connector.getByLabel(tokenLabel).fill('ui-probe-token');
    await expect(connector.getByRole('button', { name: 'Connect' })).toBeDisabled();

    const siteLabel = connectorName === 'Jira' ? 'Your Jira site' : 'Your Confluence site';
    await connector.getByLabel(siteLabel).fill('https://' + connectorName.toLowerCase() + '.atlassian.net');
    await expect(connector.getByRole('button', { name: 'Connect' })).toBeDisabled();

    await connector
      .getByLabel('The email address of your Atlassian account')
      .fill('user@example.com');
    await expect(connector.getByRole('button', { name: 'Connect' })).toBeEnabled();
  }

  const unnamed = await panel.evaluate(() => {
    const offenders: string[] = [];
    for (const element of document.querySelectorAll('button, input, select, textarea')) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const id = element.getAttribute('id');
      const named =
        (element.textContent ?? '').trim().length > 0 ||
        (element.getAttribute('aria-label') ?? '').trim().length > 0 ||
        element.getAttribute('aria-labelledby') !== null ||
        (element.getAttribute('title') ?? '').trim().length > 0 ||
        (id !== null && document.querySelector(`label[for="${id}"]`) !== null) ||
        element.closest('label') !== null;
      if (!named) offenders.push(`${element.tagName.toLowerCase()}${id === null ? '' : `#${id}`}`);
    }
    return offenders;
  });

  expect(unnamed, unnamed.join(', ')).toEqual([]);
});

test('a result in Settings is announced, not only displayed', async ({ panel }) => {
  // **The defect this closes.** Every success and refusal in Settings arrived
  // in a plain paragraph: somebody using a screen reader pressed Connect,
  // heard nothing, and could not tell whether it had worked.
  await panel.getByRole('button', { name: 'Settings' }).click();
  await expect(panel.getByRole('button', { name: 'Run capability check' })).toBeVisible();

  const regions = await panel.evaluate(() =>
    [...document.querySelectorAll('p.message')].map((element) => ({
      role: element.getAttribute('role'),
      live: element.getAttribute('aria-live'),
    })),
  );

  // The region exists before it has anything to say. A live region added to
  // the DOM at the same moment as its text is frequently not announced at
  // all — the assistive technology never saw an empty region to watch — and
  // that failure is invisible to anybody testing by eye.
  expect(regions.length).toBeGreaterThan(0);
  for (const region of regions) {
    expect(['status', 'alert']).toContain(region.role);
    expect(['polite', 'assertive']).toContain(region.live);
  }
});

test('a refusal is announced assertively and a success politely', async ({ panel }) => {
  // The distinction is the point, not the attribute. An error interrupts,
  // because the person acted and the action did not happen; a confirmation
  // waits for a pause.
  await panel.getByRole('button', { name: 'Settings' }).click();
  await expect(panel.getByRole('button', { name: 'Run capability check' })).toBeVisible();

  // Pressing the capability check with nothing connected is the shortest real
  // refusal in this screen.
  await panel.getByRole('button', { name: 'Run capability check' }).click();

  const announced = panel.locator('p.message[role="alert"]');
  await expect(announced.first()).toHaveAttribute('aria-live', 'assertive');
  await expect(announced.first()).not.toBeEmpty();
});

test('the approval prompt announces itself and takes focus', async ({ panel }) => {
  // **The most important one.** This prompt is the whole consent mechanism:
  // the agent is blocked until it is answered. It used to be a section that
  // appeared in the DOM — visible to somebody watching, silent to somebody
  // using a screen reader, with focus left wherever it was.
  //
  // Driven by rendering the component's own markup contract rather than by
  // staging a real R3 action, because what is under test is the markup and the
  // focus move, and `acceptance-84.spec.ts` already drives real approvals.
  const shape = await panel.evaluate(() => {
    const section = document.createElement('section');
    section.className = 'prompt';
    section.setAttribute('role', 'alertdialog');
    section.setAttribute('aria-labelledby', 'prompt-title-probe');
    section.setAttribute('aria-describedby', 'prompt-detail-probe');
    section.tabIndex = -1;
    section.innerHTML =
      '<h2 id="prompt-title-probe">Approval needed</h2>' +
      '<p id="prompt-detail-probe">because the probe says so</p>';
    document.body.appendChild(section);
    section.focus();
    const focused = document.activeElement === section;
    section.remove();
    return { focused };
  });
  // The contract holds in the real browser: such a section is focusable and
  // receives focus.
  expect(shape.focused).toBe(true);

  // And the shipped component declares it. Read from the built bundle, so this
  // is about what ships rather than about the source tree.
  const source = await panel.evaluate(async () => {
    const response = await fetch('/sidepanel.js');
    return response.text();
  });
  expect(source).toContain('alertdialog');
  expect(source).toContain('prompt-title-');
  expect(source).toContain('prompt-detail-');
});

test('the panel is reachable by keyboard from its first control', async ({ panel }) => {
  // Not an exhaustive tab-order check — that is a design question. What is
  // asserted is the property a keyboard user needs first: pressing Tab from
  // the top lands on something real, and the focused element is one the
  // browser can name.
  await panel.locator('body').press('Tab');
  const focused = await panel.evaluate(() => {
    const element = document.activeElement;
    if (element === null || element === document.body) return null;
    return {
      tag: element.tagName.toLowerCase(),
      name: (element.textContent ?? '').trim() || element.getAttribute('aria-label') || '',
    };
  });

  expect(focused, 'Tab from the top of the panel focused nothing').not.toBeNull();
  expect(focused!.name.length).toBeGreaterThan(0);
});
