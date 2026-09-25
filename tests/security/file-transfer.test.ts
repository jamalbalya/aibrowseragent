/**
 * TEST-SECURITY-020 — file transfer security (Stage 3 Wave E).
 *
 * The claim under test is that a file reaching a website goes through the
 * same authorization every other transfer does, and that nothing about being
 * a file gets it a shorter path.
 *
 * The four operations are kept apart deliberately, so each is checked where
 * it actually happens: selection needs a person, reading adds taint,
 * attaching is the egress, and the page's own submit is a separate action.
 * A test that treated "upload" as one step would prove only that the last of
 * them was gated.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MessagingBus from '@/messaging/bus';

// The broker broadcasts to the side panel, which needs a `chrome` that does
// not exist under Node. The broadcast is not what these tests are about.
vi.mock('@/messaging/bus', async (importOriginal) => {
  const actual = await importOriginal<typeof MessagingBus>();
  return { ...actual, broadcastEvent: vi.fn() };
});

import { authorizeEgress } from '@/security/egress/egress-gate';
import { ConsentStore } from '@/security/egress/consent';
import { urlDestination, providerDestination } from '@/security/egress/destination';
import { addTaint, freshTaint, taintSources, unknownTaint } from '@/security/taint/taint-state';
import { createFileTools, type FileAuditEvent } from '@/tools/files/file-tools';
import { FileSelectionBroker } from '@/background/file-broker';
import { StagedFileStore } from '@/files/file-store';
import { localFileTaint, downloadTaint } from '@/files/file-model';
import { assertAuditSafe, ProhibitedAuditFieldError } from '@/audit/audit-log';
import type { ToolError } from '@/types/result';
import type { DownloadPort, DownloadOutcome } from '@/files/download-port';
import type { AgentTool, ToolExecutionContext } from '@/tools/core/tool-types';
import type { TaintSource } from '@/security/exfiltration/exfiltration-guard';

const SALT = 'ab'.repeat(32);
const PAGE_URL = 'https://forms.example/apply';

const intranet: TaintSource = {
  sourceType: 'web_page',
  site: 'intranet.example',
  sensitivity: 'confidential',
};

/** A download port that records what it was asked to do and never touches Chrome. */
function fakeDownloads(overrides: Partial<DownloadPort> = {}) {
  const started: { url: string; filename: string }[] = [];
  let outcome: DownloadOutcome = { id: 1, state: 'complete', filename: 'report.pdf' };
  const port: DownloadPort & { started: typeof started; setOutcome(o: DownloadOutcome): void } = {
    started,
    setOutcome: (next) => {
      outcome = next;
    },
    isPermitted: () => Promise.resolve(true),
    start: (request) => {
      started.push(request);
      return Promise.resolve(1);
    },
    awaitCompletion: () => Promise.resolve(outcome),
    cancel: () => Promise.resolve(),
    ...overrides,
  };
  return port;
}

function harness(options: { downloads?: DownloadPort } = {}) {
  const store = new StagedFileStore();
  const broker = new FileSelectionBroker({ timeoutMs: 50 });
  const events: FileAuditEvent[] = [];
  const contentCalls: { type: string; payload: unknown }[] = [];

  const adapter = {
    getTab: () => Promise.resolve({ id: 1, url: PAGE_URL, title: 'Apply', active: true }),
    getActiveTab: () => Promise.resolve({ id: 1, url: PAGE_URL, title: 'Apply', active: true }),
    callContent: (_tabId: number, type: string, payload: unknown) => {
      contentCalls.push({ type, payload });
      return Promise.resolve({ attached: 1, names: ['cv.pdf'], inputWasHidden: false });
    },
    ensureContentScript: () => Promise.resolve(),
  } as unknown as Parameters<typeof createFileTools>[0]['adapter'];

  const tools = createFileTools({
    adapter,
    broker,
    store,
    downloads: options.downloads ?? fakeDownloads(),
    recordFileEvent: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  });

  const byName = (name: string): AgentTool => tools.find((tool) => tool.name === name) as AgentTool;

  return { store, broker, events, contentCalls, tools, byName };
}

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    taskId: 'task_1',
    sessionId: 's',
    toolCallId: 'tc_1',
    tabId: 1,
    currentUrl: PAGE_URL,
    signal: new AbortController().signal,
    recordEvidence: () => undefined,
    ...overrides,
  };
}

let consent: ConsentStore;
beforeEach(() => {
  consent = new ConsentStore();
});

// ---------------------------------------------------------------------------
// A. Local file access
// ---------------------------------------------------------------------------

describe('local file access is user-mediated and nothing else', () => {
  it('offers no tool that takes a path', () => {
    // The shape of the refusal: a model cannot ask for a named local file
    // because there is nowhere in any schema to put one.
    const { tools } = harness();
    for (const tool of tools) {
      const serialised = JSON.stringify(tool.inputSchema);
      expect(serialised, tool.name).not.toMatch(/"path"|"filePath"|"absolutePath"|"directory"/);
    }
  });

  it('exposes no tool that reads or lists the filesystem', () => {
    const { tools } = harness();
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(['files.select', 'browser.attach_file', 'browser.download']);
  });

  it.each([
    '/Users/someone/.ssh/id_rsa',
    'C:\\Users\\someone\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data',
    '~/.aws/credentials',
    '/etc/shadow',
  ])('cannot be pointed at %s, because purpose is free text and not a location', async (path) => {
    // A model can put a path in `purpose`, and it changes nothing: the string
    // is shown to the user and never resolved.
    const { byName, broker } = harness();
    const pending: string[] = [];
    const original = broker.request.bind(broker);
    vi.spyOn(broker, 'request').mockImplementation((input) => {
      pending.push(JSON.stringify(input));
      return original(input);
    });

    const promise = byName('files.select').execute({ purpose: path }, context());
    await expect(promise).rejects.toThrow();

    // Whatever the model wrote reached the prompt as text, and the request
    // carries no field that could name a file.
    const request = JSON.parse(pending[0]!) as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(
      ['destinationOrigin', 'multiple', 'purpose', 'taskId'].sort(),
    );
  });

  it('treats a request nobody answered as "no file", never as a selection', async () => {
    const { byName } = harness();
    await expect(
      byName('files.select').execute({ purpose: 'a CV to attach' }, context()),
    ).rejects.toMatchObject({ code: 'USER_CANCELLED' });
  });

  it('treats an explicit refusal as a refusal', async () => {
    const { byName, broker } = harness();
    const promise = byName('files.select').execute({ purpose: 'a CV' }, context());

    await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
    broker.respond(broker.listPending()[0]!.id, { kind: 'cancelled', reason: 'No thanks.' });

    await expect(promise).rejects.toMatchObject({ code: 'USER_CANCELLED' });
  });
});

// ---------------------------------------------------------------------------
// B + C. Selection introduces taint; attachment is the egress
// ---------------------------------------------------------------------------

async function selectFile(h: ReturnType<typeof harness>, name = 'cv.pdf') {
  const promise = h.byName('files.select').execute({ purpose: 'a CV' }, context());
  await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
  h.broker.respond(h.broker.listPending()[0]!.id, {
    kind: 'selected',
    files: [{ name, mimeType: 'application/pdf', byteLength: 3, dataBase64: 'QUJD' }],
  });
  return await promise;
}

describe('reading a file taints the task', () => {
  it('reports a local_file source the runtime folds into task taint', async () => {
    const h = harness();
    const result = await selectFile(h);
    expect(result.taint).toEqual([localFileTaint()]);
  });

  it('returns metadata and never contents', async () => {
    const h = harness();
    const result = await selectFile(h);
    const serialised = JSON.stringify(result.data);

    expect(serialised).toContain('cv.pdf');
    expect(serialised).not.toContain('QUJD');
  });

  it('is monotone: page taint plus file taint keeps both', () => {
    // Specification requirement, checked at the level the runtime works at.
    const withPage = addTaint(freshTaint(), [intranet]);
    const withBoth = addTaint(withPage, [localFileTaint()]);
    const kinds = taintSources(withBoth).map((source) => source.sourceType);

    expect(kinds).toContain('web_page');
    expect(kinds).toContain('local_file');
  });

  it('cannot be downgraded by adding a file to an unknown state', () => {
    const lost = addTaint(unknownTaint('persistence-failed'), [localFileTaint()]);
    expect(lost.kind).toBe('UNKNOWN');
  });
});

describe('attaching a file is an egress and is gated as one', () => {
  it('declares a page_write egress carrying names and sizes, not bytes', async () => {
    const h = harness();
    const selected = await selectFile(h);
    const fileId = (selected.data as { files: { fileId: string }[] }).files[0]!.fileId;

    const declared = h.byName('browser.attach_file').classify!(
      { elementId: 'e1-0', fileIds: [fileId] },
      context(),
    ).egress!;

    expect(declared.destination.channel).toBe('page_write');
    expect(declared.destination.identity).toBe('https://forms.example');
    expect(JSON.stringify(declared.payload)).toContain('cv.pdf');
    expect(JSON.stringify(declared.payload)).not.toContain('QUJD');
  });

  it('requires consent to send a chosen file to a site, because a file has no site', async () => {
    // `localFileTaint` carries no site, so it can never match a destination.
    // Sending it anywhere is a transfer to somewhere the data did not come
    // from, which is a decision for the user rather than a same-origin pass.
    const h = harness();
    const selected = await selectFile(h);
    const fileId = (selected.data as { files: { fileId: string }[] }).files[0]!.fileId;
    const declared = h.byName('browser.attach_file').classify!(
      { elementId: 'e1-0', fileIds: [fileId] },
      context(),
    ).egress!;

    const decision = authorizeEgress(
      {
        taskId: 'task_1',
        taintState: addTaint(freshTaint(), [localFileTaint()]),
        taintSalt: SALT,
        destination: declared.destination,
        ...(declared.carrier === undefined ? {} : { carrierInput: declared.carrier }),
        payload: declared.payload,
        taintSignature: 'sig',
        now: 1,
      },
      { consent: new ConsentStore() },
    );

    expect(decision.verdict).toBe('confirm');
    expect(decision.code).toBe('CONSENT_REQUIRED');
  });

  it('allows the same attachment once consent has been given for that key', async () => {
    const h = harness();
    const selected = await selectFile(h);
    const fileId = (selected.data as { files: { fileId: string }[] }).files[0]!.fileId;
    const declared = h.byName('browser.attach_file').classify!(
      { elementId: 'e1-0', fileIds: [fileId] },
      context(),
    ).egress!;

    const taintState = addTaint(freshTaint(), [localFileTaint()]);
    // An opaque component of the consent key; the gate never interprets it.
    const signature = 'sig-file';
    const request = {
      taskId: 'task_1',
      taintState,
      taintSalt: SALT,
      destination: declared.destination,
      ...(declared.carrier === undefined ? {} : { carrierInput: declared.carrier }),
      payload: declared.payload,
      taintSignature: signature,
      now: 1,
    };

    const first = authorizeEgress(request, { consent });
    expect(first.verdict).toBe('confirm');
    consent.grant(first.consentKey!, 1);

    expect(authorizeEgress(request, { consent }).verdict).toBe('allow');
  });

  it('does not carry that consent to a different site', async () => {
    const h = harness();
    const selected = await selectFile(h);
    const fileId = (selected.data as { files: { fileId: string }[] }).files[0]!.fileId;
    const taintState = addTaint(freshTaint(), [localFileTaint()]);
    const signature = 'sig-file';

    const forHere = h.byName('browser.attach_file').classify!(
      { elementId: 'e1-0', fileIds: [fileId] },
      context(),
    ).egress!;
    const here = authorizeEgress(
      {
        taskId: 'task_1',
        taintState,
        taintSalt: SALT,
        destination: forHere.destination,
        payload: forHere.payload,
        taintSignature: signature,
        now: 1,
      },
      { consent },
    );
    consent.grant(here.consentKey!, 1);

    // The same file, the same task, a different origin.
    const elsewhere = authorizeEgress(
      {
        taskId: 'task_1',
        taintState,
        taintSalt: SALT,
        destination: urlDestination('page_write', 'https://pastebin.example/new', {}),
        payload: forHere.payload,
        taintSignature: signature,
        now: 1,
      },
      { consent },
    );
    expect(elsewhere.verdict).toBe('confirm');
  });

  it('denies when the security context was lost', async () => {
    const h = harness();
    const selected = await selectFile(h);
    const fileId = (selected.data as { files: { fileId: string }[] }).files[0]!.fileId;
    const declared = h.byName('browser.attach_file').classify!(
      { elementId: 'e1-0', fileIds: [fileId] },
      context(),
    ).egress!;

    const decision = authorizeEgress(
      {
        taskId: 'task_1',
        taintState: unknownTaint('persistence-failed'),
        taintSalt: SALT,
        destination: declared.destination,
        payload: declared.payload,
        taintSignature: 'sig',
        now: 1,
      },
      { consent },
    );
    expect(decision.verdict).toBe('deny');
    expect(decision.code).toBe('SECURITY_CONTEXT_UNKNOWN');
  });

  it('denies when the page origin could not be determined', async () => {
    const h = harness();
    const selected = await selectFile(h);
    const fileId = (selected.data as { files: { fileId: string }[] }).files[0]!.fileId;
    // Built without the key at all: an absent URL, not one set to undefined.
    const noUrl = context();
    delete (noUrl as { currentUrl?: string }).currentUrl;
    const declared = h.byName('browser.attach_file').classify!(
      { elementId: 'e1-0', fileIds: [fileId] },
      noUrl,
    ).egress!;

    expect(declared.destination.identity).toBeNull();
    const decision = authorizeEgress(
      {
        taskId: 'task_1',
        taintState: addTaint(freshTaint(), [localFileTaint()]),
        taintSalt: SALT,
        destination: declared.destination,
        taintSignature: 'sig',
        now: 1,
      },
      { consent },
    );
    expect(decision.code).toBe('DESTINATION_UNKNOWN');
  });

  it('keeps a file destination distinct from a provider destination', () => {
    // Changing scheme, host or port has to invalidate authorization, and a
    // website must never share an identity with an API endpoint.
    const identities = [
      urlDestination('page_write', 'https://forms.example/apply', {}).identity,
      urlDestination('page_write', 'https://forms.example:8443/apply', {}).identity,
      urlDestination('page_write', 'http://forms.example/apply', {}).identity,
      providerDestination('anthropic', 'https://forms.example', 'm').identity,
    ];
    expect(new Set(identities).size).toBe(identities.length);
  });
});

describe('the staged file is not reachable from another task', () => {
  it('refuses a file id belonging to a different task', async () => {
    const h = harness();
    const selected = await selectFile(h);
    const fileId = (selected.data as { files: { fileId: string }[] }).files[0]!.fileId;

    await expect(
      h
        .byName('browser.attach_file')
        .execute({ elementId: 'e1-0', fileIds: [fileId] }, context({ taskId: 'task_other' })),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('refuses an id the model invented rather than attaching nothing quietly', async () => {
    const h = harness();
    await expect(
      h
        .byName('browser.attach_file')
        .execute({ elementId: 'e1-0', fileIds: ['file_made_up'] }, context()),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(h.contentCalls).toEqual([]);
  });

  it('reports a file lost to a worker restart instead of reporting success', async () => {
    // The staged bytes live in memory and are gone after an eviction. Saying
    // so is the whole point: the alternative is telling the model a file was
    // attached when nothing was.
    const h = harness();
    const selected = await selectFile(h);
    const fileId = (selected.data as { files: { fileId: string }[] }).files[0]!.fileId;

    h.store.clearAll();

    await expect(
      h.byName('browser.attach_file').execute({ elementId: 'e1-0', fileIds: [fileId] }, context()),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(h.contentCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D. Downloads
// ---------------------------------------------------------------------------

describe('downloads', () => {
  it('declares a download egress, because the browser fetches a URL the model chose', () => {
    const h = harness();
    const declared = h.byName('browser.download').classify!(
      { url: 'https://files.example/report.pdf?note=secret' },
      context(),
    ).egress!;

    expect(declared.destination.channel).toBe('download');
    expect(declared.destination.identity).toBe('https://files.example');
    expect(declared.payload).toContain('note=secret');
  });

  it.each([
    ['../../etc/passwd', 'TRAVERSAL'],
    ['/etc/passwd', 'ABSOLUTE'],
    ['sub/dir/x.pdf', 'PATH_SEPARATOR'],
    ['setup.exe', 'EXECUTABLE'],
    ['addon.crx', 'BROWSER_EXTENSION'],
    ['CON.txt', 'RESERVED_NAME'],
  ])('refuses the filename %s before anything is started', async (filename, code) => {
    const downloads = fakeDownloads();
    const h = harness({ downloads });

    await expect(
      h.byName('browser.download').execute({ url: 'https://files.example/x', filename }, context()),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    // Nothing reached the browser's download machinery.
    expect(downloads.started).toEqual([]);
    expect(h.events.at(-1)).toMatchObject({ outcome: 'denied', code });
  });

  it('refuses when the optional permission has not been granted', async () => {
    const downloads = fakeDownloads({ isPermitted: () => Promise.resolve(false) });
    const h = harness({ downloads });

    await expect(
      h.byName('browser.download').execute({ url: 'https://files.example/a.pdf' }, context()),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(downloads.started).toEqual([]);
  });

  it('refuses a scheme the navigation policy refuses', async () => {
    const downloads = fakeDownloads();
    const h = harness({ downloads });

    await expect(
      h.byName('browser.download').execute({ url: 'file:///etc/passwd' }, context()),
    ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(downloads.started).toEqual([]);
  });

  it('records what actually landed, not what was asked for', async () => {
    // Chrome uniquifies rather than overwriting, so the reported name is the
    // one on disk.
    const downloads = fakeDownloads();
    downloads.setOutcome({
      id: 1,
      state: 'complete',
      filename: 'report (1).pdf',
      byteLength: 42,
      mimeType: 'application/pdf',
    });
    const h = harness({ downloads });

    const result = await h
      .byName('browser.download')
      .execute({ url: 'https://files.example/report.pdf' }, context());

    expect(result.data).toMatchObject({ savedAs: 'report (1).pdf', renamed: true });
    expect(h.events.at(-1)).toMatchObject({
      type: 'file.downloaded',
      outcome: 'allowed',
      fileName: 'report (1).pdf',
      origin: 'files.example',
    });
  });

  it('taints the task with the site the file came from', async () => {
    const h = harness();
    const result = await h
      .byName('browser.download')
      .execute({ url: 'https://files.example/report.pdf' }, context());
    expect(result.taint).toEqual([downloadTaint('files.example')]);
  });

  it('taints the task with both sites when Chrome followed a redirect', async () => {
    // Chrome follows redirects itself and the tool never sees the hops, so the
    // only place the real source appears is the finished item. Taint decides
    // what later egress is allowed to carry, so tainting with the requested
    // site alone would have the rest of the task reason about a site that
    // never served the bytes.
    const downloads = fakeDownloads();
    downloads.setOutcome({
      id: 1,
      state: 'complete',
      filename: 'report.pdf',
      finalUrl: 'https://cdn.elsewhere/blob/9',
    });
    const h = harness({ downloads });

    const result = await h
      .byName('browser.download')
      .execute({ url: 'https://files.example/report.pdf' }, context());

    expect(result.taint).toEqual([downloadTaint('cdn.elsewhere'), downloadTaint('files.example')]);
    expect(result.data).toMatchObject({ servedBy: 'cdn.elsewhere' });
  });

  it('records the site that served a redirected file, and says where it was asked for', async () => {
    const downloads = fakeDownloads();
    downloads.setOutcome({
      id: 1,
      state: 'complete',
      filename: 'report.pdf',
      finalUrl: 'https://cdn.elsewhere/blob/9',
    });
    const h = harness({ downloads });

    await h
      .byName('browser.download')
      .execute({ url: 'https://files.example/report.pdf' }, context());

    expect(h.events.at(-1)).toMatchObject({
      type: 'file.downloaded',
      outcome: 'allowed',
      origin: 'cdn.elsewhere',
      detail: 'Requested from files.example and redirected to cdn.elsewhere.',
    });
  });

  it('says nothing about a redirect when Chrome reports the URL it was given', async () => {
    // Chrome sets `finalUrl` even when nothing redirected, so an implementation
    // that reported a hop whenever the field was present would claim a redirect
    // on every download.
    const downloads = fakeDownloads();
    downloads.setOutcome({
      id: 1,
      state: 'complete',
      filename: 'report.pdf',
      finalUrl: 'https://files.example/report.pdf',
    });
    const h = harness({ downloads });

    const result = await h
      .byName('browser.download')
      .execute({ url: 'https://files.example/report.pdf' }, context());

    expect(result.taint).toEqual([downloadTaint('files.example')]);
    expect(result.data).not.toHaveProperty('servedBy');
    expect(h.events.at(-1)).not.toHaveProperty('detail');
  });

  it('reports an interrupted download as a failure, not as a success', async () => {
    const downloads = fakeDownloads();
    downloads.setOutcome({ id: 1, state: 'interrupted', error: 'NETWORK_FAILED' });
    const h = harness({ downloads });

    await expect(
      h.byName('browser.download').execute({ url: 'https://files.example/a.pdf' }, context()),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(h.events.at(-1)).toMatchObject({ outcome: 'failed', code: 'NETWORK_FAILED' });
  });

  it('reports a cancelled download as cancelled and does not retry it', async () => {
    const downloads = fakeDownloads();
    downloads.setOutcome({ id: 1, state: 'cancelled' });
    const h = harness({ downloads });

    const error = await h
      .byName('browser.download')
      .execute({ url: 'https://files.example/a.pdf' }, context())
      .then(
        () => null,
        (caught: unknown) => (caught as ToolError).toAgentError(),
      );

    expect(error?.code).toBe('USER_CANCELLED');
    // A cancellation is the user's decision, so retrying it is never right.
    expect(error?.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E. Trust
// ---------------------------------------------------------------------------

describe('nothing about a file becomes authorization', () => {
  it('declares attaching as a high-risk action needing approval', () => {
    const h = harness();
    expect(h.byName('browser.attach_file').risk).toBe('R3');
    expect(h.byName('browser.download').risk).toBe('R3');
    // Reading a local file is lower risk than sending one, and still not free.
    expect(h.byName('files.select').risk).toBe('R2');
  });

  it('names the file and the destination in the approval summary', async () => {
    // A prompt that said "attach a file" would give the user nothing to judge.
    const h = harness();
    const selected = await selectFile(h);
    const fileId = (selected.data as { files: { fileId: string }[] }).files[0]!.fileId;

    const summary = h.byName('browser.attach_file').classify!(
      { elementId: 'e1-0', fileIds: [fileId] },
      context(),
    ).summary!;

    expect(summary).toContain('cv.pdf');
    expect(summary).toContain('forms.example');
  });

  it('cannot be talked into attaching a file the user did not choose', async () => {
    // There is no path from "the page said to upload secrets.pdf" to a file:
    // only ids from this task's own selections resolve.
    const h = harness();
    await expect(
      h
        .byName('browser.attach_file')
        .execute({ elementId: 'e1-0', fileIds: ['/etc/passwd'] }, context()),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('never executes or interprets what was downloaded', () => {
    // The download tool returns metadata. There is no field for contents and
    // no code path that reads the file back.
    const h = harness();
    const source = h.byName('browser.download').execute.toString();
    expect(source).not.toMatch(/\beval\b|new Function|import\(/);
  });
});

// ---------------------------------------------------------------------------
// F. Credential safety
// ---------------------------------------------------------------------------

describe('credential safety', () => {
  it('rejects an audit record carrying file contents', () => {
    expect(() => assertAuditSafe({ type: 'file.attached', content: 'the whole file' })).toThrow(
      ProhibitedAuditFieldError,
    );
    expect(() => assertAuditSafe({ type: 'file.attached', payload: 'bytes' })).toThrow(
      ProhibitedAuditFieldError,
    );
  });

  it('keeps bytes out of every file audit event', async () => {
    const h = harness();
    const selected = await selectFile(h);
    const fileId = (selected.data as { files: { fileId: string }[] }).files[0]!.fileId;
    await h
      .byName('browser.attach_file')
      .execute({ elementId: 'e1-0', fileIds: [fileId] }, context());

    expect(h.events).not.toHaveLength(0);
    expect(JSON.stringify(h.events)).not.toContain('QUJD');
  });

  it('reads no credential store, cookie jar or session storage', () => {
    // Asserted against the module text: the capability is absent rather than
    // guarded, so there is nothing to bypass.
    const h = harness();
    const source = h.tools.map((tool) => tool.execute.toString()).join('\n');
    expect(source).not.toMatch(/chrome\.cookies|chrome\.identity|document\.cookie/);
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });

  it('puts no local path into the record, because the picker never exposes one', async () => {
    const h = harness();
    await selectFile(h, 'cv.pdf');
    const [record] = h.store.listForTask('task_1');

    expect(record?.origin).toBe('local');
    expect(record?.name).toBe('cv.pdf');
    expect(JSON.stringify(record)).not.toMatch(/\/Users\/|C:\\\\|\/home\//);
  });

  it('strips a control character a filename used to misrepresent a prompt', async () => {
    const h = harness();
    await selectFile(h, `cv.pdf${String.fromCharCode(10)}and id_rsa`);
    const [record] = h.store.listForTask('task_1');
    expect(record?.name).not.toContain(String.fromCharCode(10));
  });
});
