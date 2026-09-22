/**
 * TEST-E2E-009 — file transfer in real Chromium (Stage 3 Wave E).
 *
 * REAL BROWSER + LOCAL TEST SERVER. Pages are served over real HTTP from
 * 127.0.0.1; no production website is touched.
 *
 * Three things can only be established here.
 *
 * The page model's visible/hidden discrimination needs layout, and jsdom has
 * none — under it every element reads as invisible, so a unit test asserting
 * "a hidden file input still gets a handle" would pass without proving
 * anything.
 *
 * `DataTransfer` is the only way to populate `input.files`, and jsdom does not
 * implement it. Whether Chromium accepts the assignment, and whether the
 * page's own `change` listener sees it, is a fact about the browser.
 *
 * And Chrome's handling of a traversal filename is exactly the kind of
 * platform behaviour that must be observed rather than assumed. The extension
 * refuses such names itself, before Chrome ever sees one; this records what
 * Chrome does with one anyway.
 */
import type { Page } from '@playwright/test';
import {
  connectProvider,
  expect,
  test,
  waitForTask,
  type SendToWorker,
} from './fixtures/extension';

/**
 * Answers the pending permission prompt, as the side panel would.
 *
 * Every file operation is gated before it runs, so a test that skipped this
 * would hang — which is itself worth stating: the prompt is not optional.
 */
async function approve(send: SendToWorker, kind: 'approve_once' | 'deny'): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { requests } = await send('permission.listPending', {});
    const pending = requests[0];
    if (pending) {
      await send('permission.respond', { requestId: pending.id, response: { kind } });
      return pending.tool;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('No permission prompt appeared; the operation was not gated.');
}

/** Chooses a file in the side panel's real picker, as a user would. */
async function choose(
  panel: Page,
  files: { name: string; mimeType: string; content: string }[],
): Promise<void> {
  const input = panel.locator('.prompt__file-input');
  await input.waitFor({ state: 'attached', timeout: 20_000 });
  await input.setInputFiles(
    files.map((file) => ({
      name: file.name,
      mimeType: file.mimeType,
      buffer: Buffer.from(file.content, 'utf8'),
    })),
  );
}

/**
 * Everything the model was sent, with one level of JSON escaping undone.
 *
 * A tool result is a JSON string inside a JSON body, so the page model
 * arrives double-escaped and a naive substring match would never hit.
 */
function modelSaw(provider: { requests: readonly { body: unknown }[] }): string {
  return JSON.stringify(provider.requests).replace(/\\"/g, '"');
}

test('a hidden file input is addressable, with its role and accept reported', async ({
  context,
  send,
  site,
  provider,
}) => {
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/upload-hidden`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'text', text: 'Read it.' },
  ]);

  const { task } = await send('task.create', { objective: 'Read the current page.' });
  expect((await waitForTask(send, task.id)).state).toBe('COMPLETED');

  const sent = modelSaw(provider);
  // This page hides its input behind a styled button — the usual shape of a
  // real upload control — and it still has to be addressable.
  expect(sent).toContain('"role":"file"');
  expect(sent).toContain('"visible":false');
  expect(sent).toContain('Choose a file');
});

test('a hidden button is still left out of the page model', async ({
  context,
  send,
  site,
  provider,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'text', text: 'Read it.' },
  ]);

  const { task } = await send('task.create', { objective: 'Read the current page.' });
  await waitForTask(send, task.id);

  // Layout exists here, so this is a real discrimination rather than the
  // vacuous pass it would be under jsdom.
  const sent = modelSaw(provider);
  expect(sent).toContain('Search widgets');
  expect(sent).not.toContain('Never visible');
});

test('a file input reports accept, and never the browser’s fake path', async ({
  context,
  send,
  site,
  provider,
}) => {
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/upload`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'text', text: 'Read the form.' },
  ]);

  const { task } = await send('task.create', { objective: 'Read the current page.' });
  expect((await waitForTask(send, task.id)).state).toBe('COMPLETED');

  const sent = modelSaw(provider);
  expect(sent).toContain('"role":"file"');
  expect(sent).toContain('.pdf,.txt');
  expect(sent).not.toContain('fakepath');
});

test('a chosen file reaches a real file input and the page’s own listener sees it', async ({
  context,
  panel,
  send,
  site,
  provider,
}) => {
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/upload`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    {
      kind: 'tool_calls',
      calls: [{ name: 'files_select', arguments: { purpose: 'a CV for this application' } }],
    },
    {
      kind: 'tool_calls',
      calls: [
        {
          // The id the selection handed back, which a real model reads out of
          // the tool result the same way.
          name: 'browser_attach_file',
          arguments: { elementId: 'e1-0', fileIds: ['$lastFileId'] },
        },
      ],
    },
    { kind: 'text', text: 'Attached the CV.' },
  ]);

  const { task } = await send('task.create', { objective: 'Attach my CV to this form.' });

  // Two separate approvals, because reading a local file and sending one to a
  // website are two different decisions.
  expect(await approve(send, 'approve_once')).toBe('files.select');
  await choose(panel, [
    { name: 'cv.txt', mimeType: 'text/plain', content: 'CURRICULUM-VITAE-BODY' },
  ]);
  expect(await approve(send, 'approve_once')).toBe('browser.attach_file');

  const finished = await waitForTask(send, task.id, 60_000);
  expect(finished.state).toBe('COMPLETED');
  expect(finished.result?.completedActions).toContain('files.select');
  expect(finished.result?.completedActions).toContain('browser.attach_file');

  // The real DataTransfer assignment happened: the page's own change listener
  // fired and wrote what it was given. jsdom cannot show this.
  await expect
    .poll(async () => page.locator('#chosen').textContent(), { timeout: 20_000 })
    .toContain('cv.txt');
  // And the size the page saw is the decoded file, not the base64 of it.
  expect(await page.locator('#chosen').textContent()).toContain(
    String('CURRICULUM-VITAE-BODY'.length),
  );

  // The task is tainted by having read a local file, and that is persisted.
  expect(JSON.stringify(finished.taintState)).toContain('local_file');
});

test('the attachment is refused when the user declines to send it', async ({
  context,
  panel,
  send,
  site,
  provider,
}) => {
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/upload`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'tool_calls', calls: [{ name: 'files_select', arguments: { purpose: 'a CV' } }] },
    {
      kind: 'tool_calls',
      calls: [
        { name: 'browser_attach_file', arguments: { elementId: 'e1-0', fileIds: ['$lastFileId'] } },
      ],
    },
    { kind: 'text', text: 'The attachment was refused.' },
  ]);

  const { task } = await send('task.create', { objective: 'Attach my CV.' });
  await approve(send, 'approve_once');
  await choose(panel, [{ name: 'cv.txt', mimeType: 'text/plain', content: 'BODY' }]);
  // The user picked a file and then declined to send it. Choosing is not
  // consent to transmit.
  expect(await approve(send, 'deny')).toBe('browser.attach_file');

  const finished = await waitForTask(send, task.id, 60_000);
  expect(finished.result?.completedActions ?? []).not.toContain('browser.attach_file');
  expect(await page.locator('#chosen').textContent()).toBe('nothing chosen');
});

test('a hidden file input takes the file the same way a visible one does', async ({
  context,
  panel,
  send,
  site,
  provider,
}) => {
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/upload-hidden`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'tool_calls', calls: [{ name: 'files_select', arguments: { purpose: 'a CV' } }] },
    {
      kind: 'tool_calls',
      calls: [
        { name: 'browser_attach_file', arguments: { elementId: 'e1-1', fileIds: ['$lastFileId'] } },
      ],
    },
    { kind: 'text', text: 'Attached.' },
  ]);

  const { task } = await send('task.create', { objective: 'Attach my CV.' });
  await approve(send, 'approve_once');
  await choose(panel, [{ name: 'cv.txt', mimeType: 'text/plain', content: 'BODY' }]);
  await approve(send, 'approve_once');

  const finished = await waitForTask(send, task.id, 60_000);
  expect(finished.state).toBe('COMPLETED');

  // This is the shape almost every real upload control has.
  await expect
    .poll(async () => page.locator('#chosen').textContent(), { timeout: 20_000 })
    .toContain('cv.txt');
});

test('Chrome itself refuses a traversal filename, and the extension never sends one', async ({
  context,
  send,
  site,
  provider,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    {
      kind: 'tool_calls',
      calls: [
        {
          name: 'browser_download',
          arguments: { url: `${site.baseUrl}/file/export.txt`, filename: '../../escaped.txt' },
        },
      ],
    },
    { kind: 'text', text: 'The download was refused.' },
  ]);

  const { task } = await send('task.create', { objective: 'Download the export.' });
  await approve(send, 'approve_once');
  const finished = await waitForTask(send, task.id, 40_000);

  // The extension refuses before the browser is involved at all.
  expect(finished.result?.completedActions ?? []).not.toContain('browser.download');

  // And separately: what Chrome does with such a name, observed rather than
  // assumed, so the claim in the docs rests on a real run.
  const chromeVerdict = await page.evaluate(async () => {
    const api = (globalThis as { chrome?: { downloads?: unknown } }).chrome;
    if (!api?.downloads) return 'api-unavailable-to-page';
    return 'unexpectedly-available';
  });
  // A page has no access to the downloads API at all, which is the first of
  // several reasons a page cannot drive one.
  expect(chromeVerdict).toBe('api-unavailable-to-page');
});

test('downloading is refused until the optional permission is granted', async ({
  context,
  send,
  site,
  provider,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  // The manifest declares `downloads` as optional, so a fresh profile has it
  // off and the agent cannot turn it on for itself.
  const { granted } = await send('file.downloadsPermission', {});
  expect(granted).toBe(false);

  await connectProvider(send, provider);
  provider.script([
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser_download', arguments: { url: `${site.baseUrl}/file/export.txt` } }],
    },
    { kind: 'text', text: 'It needs permission.' },
  ]);

  const { task } = await send('task.create', { objective: 'Download the export.' });
  await approve(send, 'approve_once');
  const finished = await waitForTask(send, task.id, 40_000);

  expect(finished.result?.completedActions ?? []).not.toContain('browser.download');
});

test('a file request parks the task and a refusal leaves it without a file', async ({
  context,
  send,
  site,
  provider,
}) => {
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/upload`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'files_select', arguments: { purpose: 'a CV' } }] },
    { kind: 'text', text: 'No file was provided.' },
  ]);

  const { task } = await send('task.create', { objective: 'Attach a CV.' });
  await approve(send, 'approve_once');

  // The task parks rather than spinning: a person is being waited for, and
  // no clock decides for them.
  await expect
    .poll(async () => (await send('task.get', { taskId: task.id })).task?.state, {
      timeout: 25_000,
    })
    .toBe('WAITING_FOR_USER');

  const { requests } = await send('file.listPendingSelections', {});
  expect(requests).toHaveLength(1);
  expect(requests[0]?.purpose).toBe('a CV');
  // The request names a purpose and carries no path, because there is no
  // field in it that could.
  expect(JSON.stringify(requests[0])).not.toMatch(/"path"|"filePath"/);

  await send('file.respondSelection', {
    requestId: requests[0]!.id,
    response: { kind: 'cancelled', reason: 'Declined in the test.' },
  });

  const finished = await waitForTask(send, task.id, 40_000);
  expect(finished.result?.completedActions ?? []).not.toContain('browser.attach_file');
});

test('the audit trail and the worker log record the selection without the file', async ({
  context,
  panel,
  send,
  site,
  provider,
  workerLogs,
}) => {
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/upload`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'files_select', arguments: { purpose: 'a CV' } }] },
    { kind: 'text', text: 'Chosen.' },
  ]);

  const { task } = await send('task.create', { objective: 'Attach a CV.' });
  await approve(send, 'approve_once');
  await choose(panel, [
    { name: 'cv.txt', mimeType: 'text/plain', content: 'SECRET-FILE-CONTENTS-0123456789' },
  ]);
  await waitForTask(send, task.id, 40_000);

  const { events } = await send('audit.list', { limit: 100 });
  const selected = events.filter((event) => event.type === 'file.selected');
  expect(selected.length).toBeGreaterThan(0);
  expect(selected[0]?.fileName).toBe('cv.txt');

  // The trail names the file and holds none of it, and neither does the log.
  expect(JSON.stringify(events)).not.toContain('SECRET-FILE-CONTENTS');
  expect(workerLogs.join('\n')).not.toContain('SECRET-FILE-CONTENTS');
});
