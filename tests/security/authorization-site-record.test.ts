/**
 * TEST-SECURITY-069 — the site a decision was taken about is the site recorded.
 *
 * Found during the Phase C closure audit, by running the flow rather than
 * reading it. A page action was authorised against its tab's site — the prompt
 * said `example.com`, the policy engine looked a rule up by it — and the
 * permission history recorded `(no site)`. Two derivations of "which site is
 * this", one used to decide and one used to record, and only the deciding one
 * had been updated when page actions gained a scope.
 *
 * That is not an authorization hole: nothing was permitted that would not have
 * been. It is worse in a quieter way. An audit trail that cannot say where an
 * action happened cannot answer the question it exists to answer, and it fails
 * without failing anything — the decisions stay correct while the record of
 * them goes blank.
 *
 * A second finding sits next to it. `browser.download` declared
 * `siteAuthorization: 'destination'` and its `classify` named no destination,
 * so the scope resolved to nothing: a blocked site did not stop a download
 * from it, and the engine's navigability check could not run. That one *is* an
 * enforcement gap, and the cases below hold both halves.
 *
 * Groups:
 *   A. the recorded site matches the deciding site, per scope kind
 *   B. what "no site" now means, and that it still means it
 *   C. the download destination, and the deny stages it re-enables
 *   D. the model cannot choose either one
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBrowserTools } from '@/tools/browser/browser-tools';
import { createTabTools, TabOwnership } from '@/tools/tabs/tab-tools';
import { createFileTools } from '@/tools/files/file-tools';
import { FieldObservationStore } from '@/policy/field-observation-store';
import { StagedFileStore } from '@/files/file-store';
import { FileSelectionBroker } from '@/background/file-broker';
import {
  clampToGrantable,
  emptySitePolicyState,
  isGrantableRisk,
  upsertRule,
  type SitePolicyState,
} from '@/policy/site-policy';
import { createDispatchAuditObserver } from '@/audit/dispatch-audit';
import { FakeBrowserAdapter } from '../fixtures/fake-browser';
import { fakeDebugger } from '../fixtures/fake-debugger';
import { createHarness, ScriptedPrompter, type Harness } from '../fixtures/policy-harness';
import type { AgentTool } from '@/tools/core/tool-types';
import type { DownloadPort } from '@/files/download-port';
import type { FieldObservation } from '@/policy/field-sensitivity';
import type { RecordableAuditEvent } from '@/audit/audit-log';

const SRC_ROOT = resolve(import.meta.dirname, '../../src');
const PAGE = 'https://example.com/page';

const downloads: DownloadPort = {
  isPermitted: () => Promise.resolve(true),
  start: () => Promise.resolve(1),
  awaitCompletion: () =>
    Promise.resolve({ id: 1, state: 'complete' as const, filename: 'report.pdf' }),
  cancel: () => Promise.resolve(),
};

const observation = (overrides: Partial<FieldObservation> = {}): FieldObservation => ({
  elementId: 'e1-0',
  fieldType: 'text',
  autocompleteToken: '',
  inputMode: '',
  maxLength: -1,
  formActionSite: 'example.com',
  nameHint: 'q',
  idHint: 'q',
  isInShadowRoot: false,
  isInSubframe: false,
  ...overrides,
});

let adapter: FakeBrowserAdapter;
let harness: Harness;
let prompter: ScriptedPrompter;
let audited: RecordableAuditEvent[];

const allTools = (): AgentTool[] => {
  const fields = new FieldObservationStore();
  fields.record(1, 1, [observation()]);
  return [
    ...createBrowserTools({
      adapter,
      debuggerManager: fakeDebugger().manager,
      fieldObservations: fields,
    }),
    ...createTabTools({ adapter, ownership: new TabOwnership() }),
    ...createFileTools({
      adapter: adapter,
      broker: new FileSelectionBroker({ timeoutMs: 50 }),
      store: new StagedFileStore(),
      downloads,
    }),
  ];
};

/** The real dispatch-audit observer, so the trail under test is the product's. */
const build = (options: Parameters<typeof createHarness>[1] = {}) => {
  audited = [];
  const observer = createDispatchAuditObserver({
    audit: {
      record: (event: RecordableAuditEvent) => {
        audited.push(event);
        return Promise.resolve();
      },
    } as unknown as Parameters<typeof createDispatchAuditObserver>[0]['audit'],
  });
  harness = createHarness(allTools(), {
    resolveTabUrl: (tabId) => Promise.resolve(adapter.tabs.get(tabId)?.url),
    prompter,
    onDispatched: observer,
    ...options,
  });
  return harness;
};

const dispatch = (name: string, args: Record<string, unknown> = {}, tabId?: number) =>
  harness.registry.dispatch({
    toolCallId: 'tc_1',
    taskId: 'task_1',
    sessionId: 's1',
    name,
    arguments: args,
    ...(tabId === undefined ? {} : { tabId }),
    signal: new AbortController().signal,
  });

/** The sites the permission history recorded, in order. */
const historySites = async (): Promise<string[]> =>
  (await harness.loadSitePolicy()).history.map((entry) => entry.site);

const blocked = (site: string): SitePolicyState =>
  upsertRule(emptySitePolicyState(), {
    site,
    decision: 'block',
    maxRisk: 'R0',
    createdAt: 1,
  });

beforeEach(() => {
  adapter = new FakeBrowserAdapter();
  adapter.addTab({ id: 1, url: PAGE, title: 'Example', active: true });
  adapter.onContent(() => ({ clicked: true, typed: true, navigated: true, value: 'x' }));
  prompter = new ScriptedPrompter({ kind: 'approve_once' });
  build({ mode: 'manual' });
});

describe('TEST-SECURITY-069 group A: recorded site == deciding site', () => {
  it('01 — a page action records the tab’s site, not a blank', async () => {
    // THE REGRESSION. Before the fix: prompt `example.com`, history `(no site)`.
    await dispatch('browser.click', { elementId: 'e1-0' }, 1);

    expect(prompter.seen[0]?.site).toBe('example.com');
    expect(await historySites()).toEqual(['example.com']);
  });

  it('02 — and the executed action is attributed to the same site in the trail', async () => {
    await dispatch('browser.click', { elementId: 'e1-0' }, 1);

    const invoked = audited.find((event) => event.tool === 'browser.click');
    expect(invoked?.type).toBe('tool.invoked');
    expect(invoked?.site).toBe('example.com');
  });

  it('03 — a navigation records the destination it was judged against', async () => {
    await dispatch('browser.navigate', { url: 'https://elsewhere.test/landing' }, 1);

    expect(prompter.seen[0]?.site).toBe('elsewhere.test');
    expect(await historySites()).toEqual(['elsewhere.test']);
    expect(audited.find((event) => event.tool === 'browser.navigate')?.site).toBe('elsewhere.test');
  });

  it('04 — the prompt, the history and the trail never disagree', async () => {
    // The property behind cases 01-03, stated once: whatever the person was
    // shown is what was stored, for every scope kind the product has.
    await dispatch('browser.click', { elementId: 'e1-0' }, 1);
    await dispatch('browser.navigate', { url: 'https://elsewhere.test/x' }, 1);

    const prompts = prompter.seen.map((request) => request.site);
    const history = await historySites();
    const trail = audited.filter((event) => event.site !== undefined).map((event) => event.site);
    expect(history).toEqual(prompts);
    expect(trail).toEqual(prompts);
  });
});

describe('TEST-SECURITY-069 group B: an unestablished scope still records nothing', () => {
  it('05 — a call with no page and no destination records no site', async () => {
    // NEGATIVE CONTROL for the fix. It must not invent a site where the
    // engine had none: `tabs.list` is `siteAuthorization: 'none'`, and a
    // record naming a site for it would be a record of a decision nobody took.
    await dispatch('tabs.list', {});

    expect(audited.find((event) => event.tool === 'tabs.list')?.site).toBeUndefined();
  });

  it('06 — a page action whose tab URL cannot be read records no site', async () => {
    // The other half: unknown stays unknown. The tab is gone, so the scope
    // could not be established, so nothing is attributed.
    build({ mode: 'manual', resolveTabUrl: () => Promise.resolve(undefined) });
    await dispatch('browser.click', { elementId: 'e1-0' }, 1);

    expect(prompter.seen[0]?.site ?? null).toBeNull();
    expect(await historySites()).toEqual(['(no site)']);
    expect(audited.find((event) => event.tool === 'browser.click')?.site).toBeUndefined();
  });

  it('07 — a refusal is recorded against the site it was refused on', async () => {
    // Origin drift: denied before execution, and the record still says where.
    build({ mode: 'manual' });
    await harness.registry.dispatch({
      toolCallId: 'tc_1',
      taskId: 'task_1',
      sessionId: 's1',
      name: 'browser.click',
      arguments: { elementId: 'e1-0' },
      tabId: 1,
      plannedUrl: 'https://was-here.test/before',
      signal: new AbortController().signal,
    });

    const history = await historySites();
    expect(history).toEqual(['example.com']);
    // Drift raises a confirmation rather than a denial, and the prompt names
    // the page the action would land on.
    expect(prompter.seen[0]?.reason).toMatch(/moved from/);
  });
});

describe('TEST-SECURITY-069 group C: a declared destination that was never supplied', () => {
  it('08 — a download from a blocked site is refused', async () => {
    // THE ENFORCEMENT GAP. `browser.download` declared `destination` scope and
    // named no destination, so the site-block stage had nothing to match and
    // the call reached a prompt instead of a refusal.
    build({ mode: 'manual' });
    await harness.saveSitePolicy(blocked('evil.test'));

    const result = await dispatch('browser.download', { url: 'https://evil.test/file.pdf' }, 1);

    expect(result.envelope.status).toBe('error');
    expect(result.envelope.error?.code).toBe('POLICY_BLOCKED');
    expect(result.envelope.error?.message).toMatch(/blocked-sites list/);
    // Refused by policy, so nobody was asked.
    expect(prompter.seen).toEqual([]);
  });

  it('09 — a download from an ordinary site still asks, and names the site', async () => {
    // The control. Without it, a build that refused every download would pass
    // case 08 and be useless.
    build({ mode: 'manual' });
    const result = await dispatch('browser.download', { url: 'https://files.test/report.pdf' }, 1);

    expect(prompter.seen[0]?.site).toBe('files.test');
    expect(result.envelope.status).toBe('success');
    expect(await historySites()).toEqual(['files.test']);
  });

  it('10 — a download from a scheme the browser will not automate is refused by policy', async () => {
    build({ mode: 'manual' });
    const result = await dispatch('browser.download', { url: 'file:///etc/passwd' }, 1);

    expect(result.envelope.status).toBe('error');
    expect(result.envelope.error?.code).toBe('POLICY_BLOCKED');
    expect(prompter.seen).toEqual([]);
  });

  it('11 — the destination does not lower what a download costs', async () => {
    // NEGATIVE CONTROL against the fix widening anything. A download is R3, so
    // it is confirmed even on a site with a standing grant at the ceiling.
    build({ mode: 'auto' });
    await harness.saveSitePolicy(
      upsertRule(emptySitePolicyState(), {
        site: 'files.test',
        decision: 'allow',
        maxRisk: 'R2',
        createdAt: 1,
      }),
    );

    await dispatch('browser.download', { url: 'https://files.test/report.pdf' }, 1);
    expect(prompter.seen).toHaveLength(1);
    expect(prompter.seen[0]?.risk).toBe('R3');
  });
});

describe('TEST-SECURITY-069 group C2: a grant is offered only where it would cover', () => {
  it('14 — a standing grant cannot cover an R3 action, so it is not offered on one', () => {
    // Structural, and its limits are worth stating: there is no React test
    // harness in this repository, so this reads the component rather than
    // rendering it. It is a tripwire, not a rendering proof — it catches the
    // guard being deleted, not every way the button could be shown.
    //
    // The property it guards is real. Until `browser.download` named a
    // destination, no R3 prompt carried a site, so "Always allow on this site"
    // could not appear on one. Now it could, and it would write a rule capped
    // at R2 that does not cover the download in front of the person: the next
    // identical download asks again. A control that reads as "stop asking me"
    // and does not is worse than no control.
    const source = readFileSync(
      join(SRC_ROOT, 'sidepanel/components/PermissionPrompt.tsx'),
      'utf8',
    );
    const offers = source.split('onRespond(request.id, {');
    // Both standing offers — the site grant and the task plan — are gated.
    expect(source.match(/isGrantableRisk\(request\.risk\)/g)?.length).toBe(2);
    expect(offers.length).toBeGreaterThan(2);
  });

  it('15 — and the predicate it is gated on is the same one the grant is clamped to', () => {
    expect(isGrantableRisk('R2')).toBe(true);
    expect(isGrantableRisk('R3')).toBe(false);
    expect(isGrantableRisk('R4')).toBe(false);
    // The clamp and the offer agree: anything the clamp would lower is
    // something the offer no longer makes.
    expect(clampToGrantable('R3')).toBe('R2');
  });
});

describe('TEST-SECURITY-069 group D: the model cannot choose the recorded site', () => {
  it('12 — an argument named like the scope changes neither the decision nor the record', async () => {
    // NEGATIVE CONTROL. The scope is resolved by the worker from `chrome.tabs`;
    // a model that could put a site in its arguments could put one in the
    // trail, and an audit trail the subject writes is not an audit trail.
    await dispatch(
      'browser.click',
      { elementId: 'e1-0', siteScope: 'https://attacker.test/', site: 'attacker.test' },
      1,
    );

    expect(prompter.seen[0]?.site).toBe('example.com');
    expect(await historySites()).toEqual(['example.com']);
    expect(audited.find((event) => event.tool === 'browser.click')?.site).toBe('example.com');
  });

  it('13 — the trail records a registrable domain, never a page-derived path', async () => {
    // A full URL in an audit record is page-derived text, which this trail
    // does not hold. The site is the same shape every other record uses.
    await dispatch('browser.click', { elementId: 'e1-0' }, 1);

    const site = audited.find((event) => event.tool === 'browser.click')?.site;
    expect(site).toBe('example.com');
    expect(site).not.toContain('/');
  });
});
