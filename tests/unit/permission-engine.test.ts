/**
 * TEST-POLICY-002 — Permission engine (REQ-POLICY-002).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import {
  DenyAllPrompter,
  PermissionEngine,
  type PermissionRequest,
  type PermissionResponse,
} from '@/policy/permission-engine';
import { emptySitePolicyState, findRule, type SitePolicyState } from '@/policy/site-policy';
import type { PolicyDecision } from '@/policy/policy-engine';

class Prompter {
  readonly seen: PermissionRequest[] = [];
  constructor(private response: PermissionResponse) {}
  set(response: PermissionResponse): void {
    this.response = response;
  }
  prompt(request: PermissionRequest): Promise<PermissionResponse> {
    this.seen.push(request);
    return Promise.resolve(this.response);
  }
}

class ThrowingPrompter {
  prompt(): Promise<PermissionResponse> {
    return Promise.reject(new Error('the side panel went away'));
  }
}

const decision = (overrides: Partial<PolicyDecision> = {}): PolicyDecision => ({
  verdict: 'ALLOW_WITH_CONFIRMATION',
  code: 'MODE_REQUIRES_APPROVAL',
  reason: 'This action changes page state.',
  effectiveRisk: 'R2',
  ...overrides,
});

describe('PermissionEngine', () => {
  let area: SerializedStorageArea;
  let state: SitePolicyState;

  const loadSitePolicy = (): Promise<SitePolicyState> => Promise.resolve(state);
  const saveSitePolicy = (next: SitePolicyState): Promise<void> => {
    state = next;
    return Promise.resolve();
  };

  beforeEach(() => {
    area = new SerializedStorageArea(new MemoryStorageArea());
    state = emptySitePolicyState();
    void area;
  });

  it('grants immediately when policy already returned ALLOW', async () => {
    const prompter = new Prompter({ kind: 'deny' });
    const engine = new PermissionEngine({ prompter, loadSitePolicy, saveSitePolicy });

    const outcome = await engine.requestApproval({
      taskId: 't1',
      tool: 'browser.read_page',
      decision: decision({ verdict: 'ALLOW', code: 'LOW_RISK', effectiveRisk: 'R0' }),
      summary: 'Read the page.',
    });

    expect(outcome.granted).toBe(true);
    // The user is not asked about something policy already cleared.
    expect(prompter.seen).toHaveLength(0);
    expect(state.history[0]?.decision).toBe('auto_approved');
  });

  it('never asks the user to override a DENY', async () => {
    const prompter = new Prompter({ kind: 'approve_once' });
    const engine = new PermissionEngine({ prompter, loadSitePolicy, saveSitePolicy });

    const outcome = await engine.requestApproval({
      taskId: 't1',
      tool: 'browser.navigate',
      decision: decision({ verdict: 'DENY', code: 'PROHIBITED_ACTION' }),
      summary: 'Navigate.',
    });

    expect(outcome.granted).toBe(false);
    expect(prompter.seen).toHaveLength(0);
    expect(state.history[0]?.decision).toBe('blocked');
  });

  it('records a denial when the user declines', async () => {
    const prompter = new Prompter({ kind: 'deny' });
    const engine = new PermissionEngine({ prompter, loadSitePolicy, saveSitePolicy });

    const outcome = await engine.requestApproval({
      taskId: 't1',
      tool: 'browser.click',
      decision: decision(),
      summary: 'Click submit.',
      targetUrl: 'https://example.com/form',
    });

    expect(outcome.granted).toBe(false);
    expect(state.history[0]?.decision).toBe('denied');
    expect(state.history[0]?.site).toBe('example.com');
  });

  it('persists a site rule when the user approves the whole site', async () => {
    const prompter = new Prompter({ kind: 'approve_site', maxRisk: 'R2' });
    const engine = new PermissionEngine({ prompter, loadSitePolicy, saveSitePolicy });

    await engine.requestApproval({
      taskId: 't1',
      tool: 'browser.click',
      decision: decision(),
      summary: 'Click submit.',
      targetUrl: 'https://app.example.com/form',
    });

    const rule = findRule(state, 'https://other.example.com/page');
    expect(rule?.site).toBe('example.com');
    expect(rule?.decision).toBe('allow');
    expect(rule?.maxRisk).toBe('R2');
  });

  it('treats a prompter failure as a denial', async () => {
    const engine = new PermissionEngine({
      prompter: new ThrowingPrompter(),
      loadSitePolicy,
      saveSitePolicy,
    });

    const outcome = await engine.requestApproval({
      taskId: 't1',
      tool: 'browser.click',
      decision: decision(),
      summary: 'Click.',
    });

    // Failing closed is the whole point: a broken prompt must not become an
    // implicit approval.
    expect(outcome.granted).toBe(false);
  });

  it('denies without prompting when the task was already cancelled', async () => {
    const prompter = new Prompter({ kind: 'approve_once' });
    const engine = new PermissionEngine({ prompter, loadSitePolicy, saveSitePolicy });
    const controller = new AbortController();
    controller.abort();

    const outcome = await engine.requestApproval({
      taskId: 't1',
      tool: 'browser.click',
      decision: decision(),
      summary: 'Click.',
      signal: controller.signal,
    });

    expect(outcome.granted).toBe(false);
    expect(prompter.seen).toHaveLength(0);
  });

  it('marks an exfiltration confirmation as elevated', async () => {
    const prompter = new Prompter({ kind: 'approve_once' });
    const engine = new PermissionEngine({ prompter, loadSitePolicy, saveSitePolicy });

    await engine.requestApproval({
      taskId: 't1',
      tool: 'connector.write',
      decision: decision({ code: 'EXFILTRATION_CONFIRM', effectiveRisk: 'R3' }),
      summary: 'Write to webhook.',
      targetUrl: 'https://attacker.test/hook',
    });

    expect(prompter.seen[0]?.elevated).toBe(true);
  });

  it('DenyAllPrompter refuses everything', async () => {
    const engine = new PermissionEngine({
      prompter: new DenyAllPrompter(),
      loadSitePolicy,
      saveSitePolicy,
    });
    const outcome = await engine.requestApproval({
      taskId: 't1',
      tool: 'browser.click',
      decision: decision(),
      summary: 'Click.',
    });
    expect(outcome.granted).toBe(false);
  });
});
