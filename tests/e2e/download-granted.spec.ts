/**
 * TEST-E2E-043 — the granted download path, in real Chromium.
 *
 * ## Why this runs against a different bundle
 *
 * `downloads` is optional, and the only code that ever asks for it is a
 * button in the side panel whose click handler calls
 * `chrome.permissions.request`. That request is not the obstacle: a real
 * `page.click()` supplies a real user activation and Chrome accepts it. What
 * Chrome does next is show its own confirmation dialog, which is browser
 * chrome rather than page content — Playwright has nothing to click on it,
 * the promise never settles, and the run hangs. The dialog is the limit, not
 * the gesture.
 *
 * That limit belongs to the *granting* step alone. Everything after it — the
 * policy decision, the R3 confirmation, the filename gate, the real
 * `chrome.downloads` call, the bytes on disk, the audit record — needs only a
 * permission that is already present. So this spec runs against
 * `dist-downloads/`, the shipped bundle with `downloads` declared required
 * instead of optional, which Chrome grants at install.
 *
 * Nothing here mocks an API, and nothing mutates Chrome's permission state at
 * runtime. `ChromeDownloadPort.isPermitted()` still asks
 * `chrome.permissions.contains` and still gets a real answer; it is the
 * manifest that differs, and the first test proves that is the *only* thing
 * that differs.
 *
 * `dist/` keeps `downloads` optional, and `file-transfer.spec.ts` keeps
 * proving that a download is refused there.
 */
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BROWSER, connectProvider, killServiceWorker, waitForTask } from './fixtures/extension';
import { startCollector, type Collector } from './fixtures/collector';
import { startMockProvider, type MockProvider } from './fixtures/mock-provider';
import { DOWNLOAD_BODY, startTestSite, type TestSite } from './fixtures/test-site';
import type { PanelRequestType, PanelResponse } from '../../src/messaging/protocol';

const EXTENSION_PATH = resolve(import.meta.dirname, '../../dist-downloads');
const SHIPPED_PATH = resolve(import.meta.dirname, '../../dist');

let context: BrowserContext;
let worker: Worker;
let panel: Page;
let page: Page;
let provider: MockProvider;
let site: TestSite;
let collector: Collector;
let profile: string;
let downloadsDir: string;

/** Sends a panel message from the real panel page, as the shared fixture does. */
async function send<T extends PanelRequestType>(
  type: T,
  payload: unknown,
): Promise<PanelResponse<T>> {
  const envelope: { ok?: boolean; value?: unknown; error?: { code?: string } } | undefined =
    await panel.evaluate(
      ([messageType, body]) =>
        chrome.runtime.sendMessage({
          id: `e2e_${Math.random().toString(36).slice(2)}`,
          type: messageType,
          timestamp: Date.now(),
          payload: body,
        }),
      [type, payload] as const,
    );

  if (envelope?.ok !== true) {
    throw new Error(`${type} failed: ${envelope?.error?.code ?? 'no response'}`);
  }
  return envelope.value as PanelResponse<T>;
}

/**
 * Answers the confirmation the download is gated behind.
 *
 * A download is R3, which is the level at which the engine always confirms.
 * A test that skipped this would hang, and that is worth stating rather than
 * hiding: the prompt is not optional and no grant removes it.
 */
async function respond(
  response: { kind: 'approve_once' } | { kind: 'deny' } | { kind: 'approve_site'; maxRisk: 'R2' },
): Promise<string> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const { requests } = await send('permission.listPending', {});
    const pending = requests[0];
    if (pending) {
      await send('permission.respond', { requestId: pending.id, response });
      return pending.tool;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('No confirmation appeared; the download was not gated.');
}

/** Files currently in the browser's download directory. */
function onDisk(): string[] {
  return readdirSync(downloadsDir).filter((name) => !name.endsWith('.crdownload'));
}

/** Waits for exactly one new file, then returns its contents. */
async function newFileBody(before: readonly string[]): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const added = onDisk().filter((name) => !before.includes(name));
    if (added.length === 1) return readFileSync(join(downloadsDir, added[0]!), 'utf8');
    if (added.length > 1) throw new Error(`Expected one new file, found ${added.length}.`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('No file reached the download directory.');
}

/** Scripts one `browser.download` call followed by a closing message. */
function scriptDownload(url: string, filename?: string): void {
  provider.script([
    {
      kind: 'tool_calls',
      calls: [
        {
          name: 'browser_download',
          arguments: filename === undefined ? { url } : { url, filename },
        },
      ],
    },
    { kind: 'text', text: 'Done.' },
  ]);
}

test.beforeAll(async () => {
  collector = await startCollector();
  site = await startTestSite({ collectorUrl: collector.baseUrl });
  provider = await startMockProvider();

  profile = mkdtempSync(join(tmpdir(), 'aba-dl-profile-'));
  downloadsDir = mkdtempSync(join(tmpdir(), 'aba-dl-files-'));

  context = await chromium.launchPersistentContext(profile, {
    // The shared fixture's options, reused rather than restated: `headless:
    // true` on its own resolves to `chrome-headless-shell`, which cannot load
    // extensions at all.
    ...BROWSER,
    headless: true,
    downloadsPath: downloadsDir,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const existing = context.serviceWorkers()[0];
  worker = existing ?? (await context.waitForEvent('serviceworker', { timeout: 20_000 }));
  await new Promise((r) => setTimeout(r, 800));

  const extensionId = new URL(worker.url()).host;
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await panel.waitForSelector('.app', { timeout: 15_000 });

  page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
});

test.afterAll(async () => {
  await context?.close();
  await provider?.close();
  await site?.close();
  await collector?.close();
  rmSync(profile, { recursive: true, force: true });
  rmSync(downloadsDir, { recursive: true, force: true });
});

test('the fixture bundle differs from the shipped one only in where “downloads” is declared', () => {
  const shipped = JSON.parse(readFileSync(join(SHIPPED_PATH, 'manifest.json'), 'utf8'));
  const fixture = JSON.parse(readFileSync(join(EXTENSION_PATH, 'manifest.json'), 'utf8'));

  // The claim this whole spec rests on. The build script proves it too, but a
  // reader of the spec should not have to take that on trust: if the fixture
  // ever acquired a second difference, every result below would be about a
  // bundle nobody described.
  expect(shipped.optional_permissions).toContain('downloads');
  expect(shipped.permissions).not.toContain('downloads');
  expect(fixture.permissions).toContain('downloads');
  expect(fixture.optional_permissions ?? []).not.toContain('downloads');

  const differing = [...new Set([...Object.keys(shipped), ...Object.keys(fixture)])].filter(
    (key) => JSON.stringify(shipped[key]) !== JSON.stringify(fixture[key]),
  );
  expect(differing.sort()).toEqual(['optional_permissions', 'permissions']);

  // Host permissions especially: a fixture that quietly widened them would
  // make every downstream result meaningless.
  expect(fixture.host_permissions).toEqual(shipped.host_permissions);
});

test('the downloads permission reads as granted through the extension’s own port', async () => {
  // `ChromeDownloadPort.isPermitted()` asking `chrome.permissions.contains`,
  // reached over the real route, in the real worker. Nothing was mocked and
  // nothing was granted at runtime — the manifest asked for it at install.
  const { granted } = await send('file.downloadsPermission', {});
  expect(granted).toBe(true);
});

test('an approved download writes the real bytes to disk and records one allowed event', async () => {
  const before = onDisk();
  scriptDownload(`${site.baseUrl}/file/export.txt`);

  const { task } = await send('task.create', { objective: 'Download the export.' });
  // One confirmation, and it is the download's own: R3 is the level at which
  // the engine always confirms, so the tool named in the prompt is the tool
  // about to touch the filesystem.
  expect(await respond({ kind: 'approve_once' })).toBe('browser.download');

  const finished = await waitForTask(send, task.id, 60_000);
  expect(finished.state).toBe('COMPLETED');
  expect(finished.result?.completedActions ?? []).toContain('browser.download');

  // The point of the whole exercise: a real file, with the exact bytes the
  // test server served, written by Chrome rather than by the test.
  expect(await newFileBody(before)).toBe(DOWNLOAD_BODY);

  const { events } = await send('audit.list', { taskId: task.id, limit: 100 });
  const downloaded = events.filter((event) => event.type === 'file.downloaded');
  expect(downloaded).toHaveLength(1);
  expect(downloaded[0]?.outcome).toBe('allowed');
  // The site the bytes came from, recorded so the trail says where a file on
  // this machine originated.
  expect(JSON.stringify(downloaded[0])).toContain('127.0.0.1');
});

test('a refused filename is still refused once the permission is granted', async () => {
  const before = onDisk();
  // The filename gate sits before the permission check, so without a granted
  // permission a passing test here would prove only that the permission was
  // missing. With it granted, the refusal can only be the filename.
  scriptDownload(`${site.baseUrl}/file/export.txt`, 'payload.exe');

  const { task } = await send('task.create', { objective: 'Download the installer.' });
  await respond({ kind: 'approve_once' });

  const finished = await waitForTask(send, task.id, 60_000);
  expect(finished.result?.completedActions ?? []).not.toContain('browser.download');
  expect(onDisk().filter((name) => !before.includes(name))).toEqual([]);

  const { events } = await send('audit.list', { taskId: task.id, limit: 100 });
  const downloaded = events.filter((event) => event.type === 'file.downloaded');
  expect(downloaded).toHaveLength(1);
  expect(downloaded[0]?.outcome).toBe('denied');
});

test('denying the confirmation leaves nothing on disk', async () => {
  const before = onDisk();
  scriptDownload(`${site.baseUrl}/file/denied.txt`);

  const { task } = await send('task.create', { objective: 'Download the report.' });
  await respond({ kind: 'deny' });

  const finished = await waitForTask(send, task.id, 60_000);
  expect(finished.result?.completedActions ?? []).not.toContain('browser.download');

  // Given a moment to be wrong in. An assertion made immediately would pass
  // even if the download had started.
  await new Promise((r) => setTimeout(r, 1500));
  expect(onDisk().filter((name) => !before.includes(name))).toEqual([]);
});

test('a standing site grant at the highest grantable risk still does not cover a download', async () => {
  // `MAX_GRANTABLE_RISK` is R2 and a download is R3, so this is the strongest
  // standing authorization the product can express — and it must not reach
  // this tool. Only a granted permission makes the assertion meaningful: with
  // the permission off, the second attempt would fail for the wrong reason.
  scriptDownload(`${site.baseUrl}/file/first.txt`);
  const first = await send('task.create', { objective: 'Download the first export.' });
  await respond({ kind: 'approve_site', maxRisk: 'R2' });
  expect((await waitForTask(send, first.task.id, 60_000)).state).toBe('COMPLETED');

  const { state } = await send('policy.getSitePolicy', {});
  const rule = state.rules.find((candidate) => candidate.site.includes('127.0.0.1'));
  expect(rule?.decision).toBe('allow');
  expect(rule?.maxRisk).toBe('R2');

  const before = onDisk();
  scriptDownload(`${site.baseUrl}/file/second.txt`);
  const second = await send('task.create', { objective: 'Download the second export.' });

  // The grant is on record and it changes nothing: the download prompts
  // again, and denying it is enough to stop it.
  expect(await respond({ kind: 'deny' })).toBe('browser.download');
  await waitForTask(send, second.task.id, 60_000);
  await new Promise((r) => setTimeout(r, 1500));
  expect(onDisk().filter((name) => !before.includes(name))).toEqual([]);

  await send('policy.removeSiteRule', { site: rule!.site });
});

test('the granted permission and the download path both survive worker eviction', async () => {
  await killServiceWorker(context, worker);

  const extensionId = new URL(worker.url()).host;
  await panel.close();
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await panel.waitForSelector('.app', { timeout: 15_000 });
  await new Promise((r) => setTimeout(r, 1200));
  worker = context.serviceWorkers()[0]!;

  // Opening the replacement panel brought it to the front, and a task binds
  // to the workspace of the tab that is. Without this the download is blocked
  // as "not part of this workspace" — correct behaviour, and not what this
  // test is about.
  await page.bringToFront();

  // A permission granted by the manifest is a property of the installation,
  // not of the worker that happened to be running — but "obviously" is not
  // evidence, and MV3 eviction is the failure mode this product lives with.
  const { granted } = await send('file.downloadsPermission', {});
  expect(granted).toBe(true);

  await connectProvider(send, provider);
  const before = onDisk();
  scriptDownload(`${site.baseUrl}/file/after-restart.txt`);

  const { task } = await send('task.create', { objective: 'Download after the restart.' });
  await respond({ kind: 'approve_once' });

  expect((await waitForTask(send, task.id, 60_000)).state).toBe('COMPLETED');
  expect(await newFileBody(before)).toBe(DOWNLOAD_BODY);
});
