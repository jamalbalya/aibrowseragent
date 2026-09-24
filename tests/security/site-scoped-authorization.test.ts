/**
 * TEST-SECURITY-067 — site authorization reaches page actions (Phase A+B).
 *
 * The defect this closes is a scope defect, not a missing control.
 * `PermissionRequest.site` was derived from `classification.targetUrl`, and
 * only two of thirty-three tools set one — `browser.navigate` and
 * `tabs.create`. So "Always allow on example.com" was offered for navigating
 * to a site and for nothing the agent then did there: not a click, not a
 * keystroke, not a form submission. A site-permission model governed two
 * tools and read as though it governed the product.
 *
 * The fix is a declared scope rather than a reused field. Every tool states
 * whether its authorization scope is the page it acts on, the destination it
 * names, or neither; the worker resolves that declaration against
 * `chrome.tabs`; and `classify` — which sees the model's arguments — never
 * touches it. That placement is the whole security property, so the cases
 * below spend as much effort on where the scope comes *from* as on what it
 * does.
 *
 * Groups:
 *   A. the declaration is total, and the audit behind it is recorded here
 *   B. the scope is derived from trusted context and cannot be supplied
 *   C. it denies — blocked sites now stop page actions
 *   D. it permits, bounded — grants cover page actions up to R2 and no further
 *   E. nothing that was refused before is reachable now
 *   F. origin drift is untouched (G2.1 is locked)
 *   G. provider independence, workspace ordering, eviction
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBrowserTools } from '@/tools/browser/browser-tools';
import { createTabTools, TabOwnership } from '@/tools/tabs/tab-tools';
import { createFileTools } from '@/tools/files/file-tools';
import { createDebuggerTools } from '@/tools/debugger/debugger-tools';
import { FieldObservationStore } from '@/policy/field-observation-store';
import { evaluatePolicy } from '@/policy/policy-engine';
import { emptySitePolicyState, upsertRule } from '@/policy/site-policy';
import { FakeBrowserAdapter } from '../fixtures/fake-browser';
import { fakeDebugger } from '../fixtures/fake-debugger';
import { createHarness, ScriptedPrompter, type Harness } from '../fixtures/policy-harness';
import type { AgentTool, SiteAuthorizationScope } from '@/tools/core/tool-types';
import type { FieldObservation } from '@/policy/field-sensitivity';

const SRC_ROOT = resolve(import.meta.dirname, '../../src');

/**
 * The §19 registry audit, recorded as data.
 *
 * Every tool the product registers, with the scope decided from its execution
 * semantics rather than from its name. A tool missing here fails case 01, and
 * a tool whose declaration drifts from this table fails case 02 — so the audit
 * cannot quietly go stale the way the original targetUrl assumption did.
 */
const AUDIT: Readonly<Record<string, SiteAuthorizationScope>> = {
  // Act on whatever page their tab is showing.
  'browser.read_page': 'page',
  'browser.click': 'page',
  'browser.type': 'page',
  'browser.select': 'page',
  'browser.set_value': 'page',
  'browser.select_many': 'page',
  'browser.set_checked': 'page',
  'browser.scroll': 'page',
  'browser.wait': 'page',
  'browser.screenshot': 'page',
  'browser.attach_file': 'page',
  'browser.go_back': 'page',
  'browser.go_forward': 'page',
  'browser.reload': 'page',
  'debugger.console': 'page',
  'debugger.dom': 'page',
  'debugger.network': 'page',
  'debugger.page_state': 'page',
  // Name where they are going.
  'browser.navigate': 'destination',
  'browser.download': 'destination',
  'tabs.create': 'destination',
  // No page and no destination.
  'debugger.detach': 'none',
  'files.select': 'none',
  'tabs.list': 'none',
  'tabs.get_active': 'none',
  'tabs.activate': 'none',
  'tabs.close': 'none',
  'tabs.reload': 'none',
  'tabs.group': 'none',
  'tabs.ungroup': 'none',
  'tabs.wait_for_navigation': 'none',
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
let fieldObservations: FieldObservationStore;
let harness: Harness;

const allTools = (): AgentTool[] => [
  ...createBrowserTools({
    adapter,
    debuggerManager: fakeDebugger().manager,
    fieldObservations,
  }),
  ...createTabTools({ adapter, ownership: new TabOwnership() }),
  ...createDebuggerTools({ adapter, manager: fakeDebugger().manager }),
];

const build = (options: Parameters<typeof createHarness>[1] = {}) => {
  harness = createHarness(allTools(), {
    resolveTabUrl: (tabId) => Promise.resolve(adapter.tabs.get(tabId)?.url),
    ...options,
  });
  return harness;
};

const dispatch = (
  name: string,
  args: Record<string, unknown> = {},
  tabId: number | undefined = 1,
) =>
  harness.registry.dispatch({
    toolCallId: 'tc_1',
    taskId: 'task_1',
    sessionId: 's1',
    name,
    arguments: args,
    ...(tabId === undefined ? {} : { tabId }),
    signal: new AbortController().signal,
  });

/** An ordinary text box on the current page, so Gate 1 classifies it ORDINARY. */
const recordOrdinaryField = () =>
  fieldObservations.record(1, 1, [observation({ elementId: 'e1-0' })]);

beforeEach(() => {
  adapter = new FakeBrowserAdapter();
  adapter.addTab({ id: 1, url: 'https://example.com/page', title: 'Example', active: true });
  adapter.onContent(() => ({
    typed: true,
    clicked: true,
    navigated: false,
    value: 'x',
    type: 'date',
  }));
  fieldObservations = new FieldObservationStore();
  recordOrdinaryField();
  build();
});

// ---------------------------------------------------------------------------
// A. The declaration is total
// ---------------------------------------------------------------------------

describe('A. every tool states whose authorization covers it', () => {
  it('01 the registry audit covers every registered tool, and nothing extra', () => {
    const registered = [
      ...allTools(),
      ...createFileTools({
        adapter,
        store: { get: () => undefined } as never,
        broker: {} as never,
        downloads: {} as never,
        audit: () => Promise.resolve(),
      } as never),
    ].map((tool) => tool.name);

    // A tool absent from the audit is a tool nobody decided a scope for,
    // which is exactly the state the original defect lived in.
    for (const name of registered) {
      expect(AUDIT[name], `${name} is not in the recorded audit`).toBeDefined();
    }
    for (const name of Object.keys(AUDIT)) {
      expect(registered, `${name} is audited but not registered`).toContain(name);
    }
  });

  it('02 each tool declares the scope the audit assigned it', () => {
    for (const tool of allTools()) {
      expect(tool.siteAuthorization, tool.name).toBe(AUDIT[tool.name]);
    }
  });

  it('03 the declaration is required, so a new tool cannot omit it', () => {
    const types = readFileSync(join(SRC_ROOT, 'tools/core/tool-types.ts'), 'utf8');
    // Not optional. A `?` here would let a tool be added with no scope and
    // inherit whatever the resolver does with `undefined`.
    expect(types).toContain('readonly siteAuthorization: SiteAuthorizationScope;');
    expect(types).not.toContain('siteAuthorization?:');
  });

  it('04 no page-acting tool claims to have no site', () => {
    // The specific regression: a tool that touches a page and answers to no
    // site authorization. `browser.navigate` is page-mode and scoped to its
    // destination, which is correct — it is judged by where it is going, not
    // by the page it is leaving. What must not exist is `none`.
    for (const tool of allTools()) {
      if (tool.executionMode !== 'requires_page') continue;
      expect(tool.siteAuthorization, tool.name).not.toBe('none');
    }
  });
});

// ---------------------------------------------------------------------------
// B. Where the scope comes from
// ---------------------------------------------------------------------------

describe('B. the worker derives the scope; nothing else supplies it', () => {
  it('05 classify cannot set a site scope, because the field is not on it', () => {
    const types = readFileSync(join(SRC_ROOT, 'tools/core/tool-types.ts'), 'utf8');
    const block = types.slice(
      types.indexOf('export interface CallClassification'),
      types.indexOf('export type SiteAuthorizationScope'),
    );
    expect(block.length).toBeGreaterThan(0);
    // `classify` receives the model's arguments. A scope it could return is a
    // scope the model could choose, so it is not representable there.
    expect(block).not.toContain('siteScope');
  });

  it('06 the resolver reads the tab URL, never the tool arguments', () => {
    const registry = readFileSync(join(SRC_ROOT, 'tools/registry/tool-registry.ts'), 'utf8');
    const fn = registry.slice(
      registry.indexOf('function resolveSiteScope'),
      registry.indexOf('function toAgentError'),
    );
    expect(fn).toContain('return currentUrl;');
    expect(fn).not.toMatch(/parsed\.data|invocation\.arguments|input\./);
  });

  it('07 a model-supplied site scope in the arguments has no effect', async () => {
    const prompter = new ScriptedPrompter({ kind: 'approve_once' });
    build({ mode: 'auto', prompter });
    // The model tries to name its own scope. The Zod schema has no such field,
    // and the registry builds the scope from the tab either way.
    await dispatch('browser.click', { elementId: 'e1-0', siteScope: 'https://attacker.test/' });
    const seen = prompter.seen[0];
    expect(seen === undefined || seen.site === 'example.com').toBe(true);
  });

  it('08 an unresolvable scope is absent, and absence inherits no grant', () => {
    // `siteScope` omitted entirely: the engine consults no rule, so a grant on
    // some other site cannot answer for it.
    const granted = upsertRule(emptySitePolicyState(), {
      site: 'example.com',
      decision: 'allow',
      maxRisk: 'R2',
      createdAt: 0,
    });
    const decision = evaluatePolicy(
      { tool: 'browser.click', taskId: 't', risk: 'R2' },
      { mode: 'auto', sitePolicy: granted },
    );
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
    expect(decision.code).not.toBe('SITE_ALLOWED');
  });
});

// ---------------------------------------------------------------------------
// C. The deny side
// ---------------------------------------------------------------------------

describe('C. a blocked site now stops page actions, not only navigation', () => {
  const blocked = upsertRule(emptySitePolicyState(), {
    site: 'blocked.test',
    decision: 'block',
    maxRisk: 'R0',
    createdAt: 0,
  });

  it('09 a page action on a blocked site is denied', () => {
    for (const tool of [
      'browser.click',
      'browser.type',
      'browser.set_value',
      'browser.read_page',
    ]) {
      const decision = evaluatePolicy(
        { tool, taskId: 't', risk: 'R1', siteScope: 'https://blocked.test/page' },
        { mode: 'skip', sitePolicy: blocked },
      );
      expect(decision.verdict, tool).toBe('DENY');
      expect(decision.code, tool).toBe('SITE_BLOCKED');
    }
  });

  it('10 the block reaches even Skip mode, and even a read', () => {
    const decision = evaluatePolicy(
      { tool: 'browser.read_page', taskId: 't', risk: 'R0', siteScope: 'https://blocked.test/' },
      { mode: 'skip', sitePolicy: blocked },
    );
    expect(decision.verdict).toBe('DENY');
  });

  it('11 an unblocked site is untouched — the control discriminates', () => {
    const decision = evaluatePolicy(
      { tool: 'browser.click', taskId: 't', risk: 'R1', siteScope: 'https://example.com/' },
      { mode: 'auto', sitePolicy: blocked },
    );
    expect(decision.verdict).toBe('ALLOW');
  });
});

// ---------------------------------------------------------------------------
// D. The allow side, bounded
// ---------------------------------------------------------------------------

describe('D. a standing grant now covers page actions, up to R2 and no further', () => {
  const grant = (maxRisk: 'R0' | 'R1' | 'R2') =>
    upsertRule(emptySitePolicyState(), {
      site: 'example.com',
      decision: 'allow',
      maxRisk,
      createdAt: 0,
    });

  it('12 an R2 page action is covered by an R2 grant', () => {
    // The substance of the change. Before it, this call had no `targetUrl`,
    // so `findRule` was never consulted and the action always prompted.
    const decision = evaluatePolicy(
      { tool: 'browser.type', taskId: 't', risk: 'R2', siteScope: 'https://example.com/page' },
      { mode: 'auto', sitePolicy: grant('R2') },
    );
    expect(decision.verdict).toBe('ALLOW');
    expect(decision.code).toBe('SITE_ALLOWED');
  });

  it('13 a grant below the action’s risk does not cover it', () => {
    const decision = evaluatePolicy(
      { tool: 'browser.type', taskId: 't', risk: 'R2', siteScope: 'https://example.com/page' },
      { mode: 'auto', sitePolicy: grant('R1') },
    );
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
  });

  it('14 a grant on another site does not cover this one', () => {
    const decision = evaluatePolicy(
      { tool: 'browser.type', taskId: 't', risk: 'R2', siteScope: 'https://other.test/page' },
      { mode: 'auto', sitePolicy: grant('R2') },
    );
    expect(decision.code).not.toBe('SITE_ALLOWED');
  });

  it('15 revoking the grant takes effect immediately', () => {
    const before = evaluatePolicy(
      { tool: 'browser.type', taskId: 't', risk: 'R2', siteScope: 'https://example.com/' },
      { mode: 'auto', sitePolicy: grant('R2') },
    );
    expect(before.code).toBe('SITE_ALLOWED');

    const after = evaluatePolicy(
      { tool: 'browser.type', taskId: 't', risk: 'R2', siteScope: 'https://example.com/' },
      { mode: 'auto', sitePolicy: emptySitePolicyState() },
    );
    expect(after.code).not.toBe('SITE_ALLOWED');
  });

  it('16 no grant reaches Manual mode', () => {
    const decision = evaluatePolicy(
      { tool: 'browser.type', taskId: 't', risk: 'R2', siteScope: 'https://example.com/' },
      { mode: 'manual', sitePolicy: grant('R2') },
    );
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
  });

  it('17 the panel is offered a site for a page action, so a grant can be made', async () => {
    const prompter = new ScriptedPrompter({ kind: 'approve_once' });
    build({ mode: 'manual', prompter });
    await dispatch('browser.click', { elementId: 'e1-0' });
    // Before this phase the prompt carried `site: null` for every page action,
    // so the panel had nothing to offer "always allow" against.
    expect(prompter.seen.length).toBe(1);
    expect(prompter.seen[0]?.site).toBe('example.com');
  });

  it('18 approving for the site writes a rule for the page’s site', async () => {
    build({
      mode: 'manual',
      prompter: new ScriptedPrompter({ kind: 'approve_site', maxRisk: 'R2' }),
    });
    await dispatch('browser.click', { elementId: 'e1-0' });
    const state = await harness.loadSitePolicy();
    expect(state.rules.map((r) => r.site)).toEqual(['example.com']);
    expect(state.rules[0]?.maxRisk).toBe('R2');
  });
});

// ---------------------------------------------------------------------------
// E. Nothing previously refused becomes reachable
// ---------------------------------------------------------------------------

describe('E. the ceiling, the floors and the prohibitions are untouched', () => {
  const wideGrant = upsertRule(emptySitePolicyState(), {
    site: 'example.com',
    decision: 'allow',
    maxRisk: 'R2',
    createdAt: 0,
  });

  it('19 a grant cannot cover R3', () => {
    const decision = evaluatePolicy(
      { tool: 'browser.download', taskId: 't', risk: 'R3', siteScope: 'https://example.com/f' },
      { mode: 'auto', sitePolicy: wideGrant },
    );
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
    expect(decision.code).toBe('RISK_REQUIRES_APPROVAL');
  });

  it('20 a grant cannot cover a password or OTP write (R5 refusal)', () => {
    const decision = evaluatePolicy(
      { tool: 'browser.type', taskId: 't', risk: 'R5', siteScope: 'https://example.com/login' },
      { mode: 'skip', sitePolicy: wideGrant },
    );
    expect(decision.verdict).toBe('DENY');
  });

  it('21 a grant cannot cover a payment instrument', () => {
    const decision = evaluatePolicy(
      {
        tool: 'browser.type',
        taskId: 't',
        risk: 'R1',
        prohibited: ['payment_instrument_entry'],
        siteScope: 'https://example.com/checkout',
      },
      { mode: 'auto', sitePolicy: wideGrant },
    );
    expect(decision.verdict).toBe('DENY');
    expect(decision.code).toBe('PROHIBITED_ACTION');
  });

  it('22 a grant cannot cover any prohibited category, in any mode', () => {
    for (const mode of ['manual', 'auto', 'skip'] as const) {
      const decision = evaluatePolicy(
        {
          tool: 'browser.click',
          taskId: 't',
          risk: 'R1',
          prohibited: ['permanent_deletion'],
          siteScope: 'https://example.com/',
        },
        { mode, sitePolicy: wideGrant },
      );
      expect(decision.verdict, mode).toBe('DENY');
    }
  });

  it('23 a grant does not clear an exfiltration block', () => {
    const decision = evaluatePolicy(
      {
        tool: 'browser.type',
        taskId: 't',
        risk: 'R1',
        siteScope: 'https://example.com/',
        writeDestination: 'https://example.com/',
        writePayload: { password: 'hunter2' },
      },
      { mode: 'auto', sitePolicy: wideGrant },
    );
    expect(decision.verdict).toBe('DENY');
    expect(decision.code).toBe('EXFILTRATION_BLOCKED');
  });

  it('24 a grant does not clear the unattended boundary (P-020)', () => {
    const decision = evaluatePolicy(
      { tool: 'browser.type', taskId: 't', risk: 'R2', siteScope: 'https://example.com/' },
      { mode: 'auto', sitePolicy: wideGrant, unattended: true },
    );
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
    expect(decision.code).toBe('UNATTENDED_REQUIRES_APPROVAL');
  });
});

// ---------------------------------------------------------------------------
// F. Origin drift is locked
// ---------------------------------------------------------------------------

describe('F. a grant never suppresses origin drift (G2.1 is locked)', () => {
  const covering = upsertRule(emptySitePolicyState(), {
    site: 'example.com',
    decision: 'allow',
    maxRisk: 'R2',
    createdAt: 0,
  });

  it('25 a same-origin path change is not drift', () => {
    const decision = evaluatePolicy(
      {
        tool: 'browser.click',
        taskId: 't',
        risk: 'R1',
        plannedUrl: 'https://example.com/a',
        currentUrl: 'https://example.com/b',
        siteScope: 'https://example.com/b',
      },
      { mode: 'auto', sitePolicy: covering },
    );
    expect(decision.code).not.toBe('ORIGIN_CHANGED');
  });

  it('26 a subdomain move still drifts, even under a covering eTLD+1 grant', () => {
    // The asymmetry Gate 2.2 identified, asserted rather than removed. The
    // grant says the site is trusted; drift says the page moved. They answer
    // different questions and the confirmation names the movement.
    const decision = evaluatePolicy(
      {
        tool: 'browser.click',
        taskId: 't',
        risk: 'R1',
        plannedUrl: 'https://example.com/a',
        currentUrl: 'https://app.example.com/a',
        siteScope: 'https://app.example.com/a',
      },
      { mode: 'auto', sitePolicy: covering },
    );
    expect(decision.verdict).toBe('ALLOW_WITH_CONFIRMATION');
    expect(decision.code).toBe('ORIGIN_CHANGED');
  });

  it('27 a cross-origin move still drifts under any grant', () => {
    const decision = evaluatePolicy(
      {
        tool: 'browser.click',
        taskId: 't',
        risk: 'R1',
        plannedUrl: 'https://example.com/a',
        currentUrl: 'https://elsewhere.test/a',
        siteScope: 'https://elsewhere.test/a',
      },
      { mode: 'auto', sitePolicy: covering },
    );
    expect(decision.code).toBe('ORIGIN_CHANGED');
  });

  it('28 drift is evaluated before the grant, so ordering cannot be reversed', () => {
    const engine = readFileSync(join(SRC_ROOT, 'policy/policy-engine.ts'), 'utf8');
    const driftAt = engine.indexOf('evaluateTransition(request.plannedUrl, request.currentUrl)');
    const driftIndex = driftAt > -1 ? driftAt : engine.indexOf('evaluateTransition(');
    // The `allow(...)` call that returns the grant verdict, not the union
    // member that declares the code exists.
    const grantAt = engine.lastIndexOf("'SITE_ALLOWED',");
    expect(driftIndex).toBeGreaterThan(-1);
    expect(grantAt).toBeGreaterThan(-1);
    expect(driftIndex).toBeLessThan(grantAt);
  });
});

// ---------------------------------------------------------------------------
// G. Independence, ordering, uncertainty
// ---------------------------------------------------------------------------

describe('G. the decision does not depend on the brain, the tab, or a cache', () => {
  it('29 no provider identity is an input to the authorization decision', () => {
    // Comments stripped: the engine's prose explains *why* the planned URL is
    // read before the provider request, and a check that prose satisfied would
    // be checking nothing.
    const code = (file: string) =>
      readFileSync(join(SRC_ROOT, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');

    for (const file of ['policy/policy-engine.ts', 'policy/site-policy.ts']) {
      const source = code(file);
      for (const token of ['providerId', 'modelId', 'connectionId', 'adapter']) {
        expect(source, `${file}:${token}`).not.toContain(token);
      }
    }
  });

  it('30 swapping the brain changes no authorization outcome', () => {
    // Identical requests, decided identically. The engine has no field to put
    // a provider in, which is case 29; this is the behavioural half.
    const granted = upsertRule(emptySitePolicyState(), {
      site: 'example.com',
      decision: 'allow',
      maxRisk: 'R2',
      createdAt: 0,
    });
    const request = {
      tool: 'browser.type',
      taskId: 't',
      risk: 'R2' as const,
      siteScope: 'https://example.com/',
    };
    const first = evaluatePolicy(request, { mode: 'auto', sitePolicy: granted });
    const second = evaluatePolicy(request, { mode: 'auto', sitePolicy: granted });
    expect(second).toEqual(first);
  });

  it('31 the workspace boundary is still checked before any authorization', () => {
    // Ordering, asserted from the dispatch path: workspace membership is
    // refused before the scope is resolved and before policy is consulted, so
    // no site grant can answer for a tab the task does not own.
    const registry = readFileSync(join(SRC_ROOT, 'tools/registry/tool-registry.ts'), 'utf8');
    const workspaceAt = registry.indexOf('this.options.checkWorkspaceMember(');
    const scopeAt = registry.indexOf('resolveSiteScope(tool.siteAuthorization');
    const policyAt = registry.indexOf('const decision = evaluatePolicy(');

    expect(workspaceAt).toBeGreaterThan(-1);
    expect(scopeAt).toBeGreaterThan(-1);
    expect(policyAt).toBeGreaterThan(-1);
    expect(workspaceAt).toBeLessThan(scopeAt);
    expect(scopeAt).toBeLessThan(policyAt);
  });

  it('32 nothing caches a grant between dispatches', () => {
    const registry = readFileSync(join(SRC_ROOT, 'tools/registry/tool-registry.ts'), 'utf8');
    // The site policy is loaded per dispatch through `loadPolicyContext`. A
    // module-level cache here would make a revoked grant outlive its
    // revocation, which is the eviction hazard in a different disguise.
    expect(registry).toContain('await this.options.loadPolicyContext(invocation.taskId)');
    expect(registry).not.toMatch(/const\s+\w*[sS]iteRuleCache/);
  });
});
