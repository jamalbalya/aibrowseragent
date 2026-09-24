/**
 * TEST-E2E-013 — shortcuts in real Chromium (Stage 3 Wave I, P-021).
 *
 * REAL BROWSER + LOCAL TEST SERVER + MOCK PROVIDER. Pages are served over
 * real HTTP from 127.0.0.1, the content script is really injected, and the
 * model's side of the conversation comes from a local server speaking the
 * Chat Completions protocol. No production service is contacted.
 *
 * What only a real browser can settle:
 *
 * **That the confirmation is really in the way.** The panel is a real page
 * here, so "resolving does not run it" is a statement about the shipped UI
 * rather than about a function.
 *
 * **That the target really runs afterwards.** Confirming drives the real
 * content script through the real dispatch path, with the real permission
 * engine deciding each step.
 *
 * **That a model cannot reach any of it.** The tool list and the skill list
 * are the real ones, so their emptiness of shortcuts is a fact about the
 * product.
 */
import type { Page } from '@playwright/test';
import {
  connectProvider,
  expect,
  openPanel,
  test,
  waitForTask,
  type SendToWorker,
} from './fixtures/extension';
import type { ScriptedReply } from './fixtures/mock-provider';

/** Answers every permission prompt, as the side panel would. */
function autoAnswer(
  send: SendToWorker,
  decide: 'approve_once' | 'deny',
): { asked: string[]; stop: () => void } {
  const asked: string[] = [];
  let running = true;

  void (async () => {
    while (running) {
      try {
        const { requests } = await send('permission.listPending', {});
        for (const pending of requests) {
          asked.push(pending.tool);
          await send('permission.respond', { requestId: pending.id, response: { kind: decide } });
        }
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();

  return {
    asked,
    stop: () => {
      running = false;
    },
  };
}

/** Records a one-step navigation workflow and returns its id. */
async function recordWorkflow(
  send: SendToWorker,
  provider: { script: (replies: readonly ScriptedReply[]) => void },
  url: string,
): Promise<string> {
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser.navigate', arguments: { url } }] },
    { kind: 'text', text: 'Navigated.' },
  ]);
  const answers = autoAnswer(send, 'approve_once');
  const { task } = await send('task.create', { objective: 'Open the test site.' });
  await send('workflow.recordStart', { taskId: task.id });
  await waitForTask(send, task.id, 40_000);
  answers.stop();

  const saved = await send('workflow.recordStop', {
    name: 'Open the test site',
    description: 'Recorded from a real task.',
  });
  expect(saved.workflow).not.toBeNull();
  return saved.workflow!.workflowId;
}

test('a shortcut resolves to its target and runs nothing until confirmed', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const workflowId = await recordWorkflow(send, provider, `${site.baseUrl}/`);
  const created = await send('shortcut.create', {
    name: '/QA-Regression',
    target: { kind: 'workflow', workflowId },
  });
  expect(created.shortcut).not.toBeNull();
  // Normalised on the way in, so what the user types later matches.
  expect(created.shortcut!.name).toBe('qa-regression');

  const tasksBefore = (await send('task.list', { limit: 50 })).tasks.length;

  // Resolving is a read. Several spellings of the same intent all find it,
  // and none of them starts anything.
  for (const typed of ['/qa-regression', 'QA_Regression', '  //qa   regression ']) {
    const verdict = await send('shortcut.resolve', { typed });
    expect(verdict.ok, typed).toBe(true);
    expect(verdict.resolution?.targetId).toBe(workflowId);
  }
  expect((await send('task.list', { limit: 50 })).tasks).toHaveLength(tasksBefore);
});

test('the side panel shows what a shortcut means before it runs', async ({
  context,
  extensionId,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const workflowId = await recordWorkflow(send, provider, `${site.baseUrl}/`);
  await send('shortcut.create', {
    name: 'qa-regression',
    target: { kind: 'workflow', workflowId },
  });

  // The real side panel, not a rendered fragment.
  const panel: Page = await openPanel(context, extensionId);
  const composer = panel.locator('.composer__input');
  await composer.fill('/qa-regression');
  await panel.locator('.composer__submit').click();

  // The confirmation identifies the shortcut, the kind of target and the
  // target's own name — the three facts that separate the shortcut the user
  // meant from one they mistyped.
  await expect(panel.getByTestId('shortcut-name')).toHaveText('/qa-regression');
  await expect(panel.getByTestId('shortcut-kind')).toHaveText('recorded workflow');
  await expect(panel.getByTestId('shortcut-target')).toHaveText('Open the test site');
  await expect(panel.getByTestId('shortcut-confirm')).toBeVisible();

  await panel.close();
});

test('confirming a shortcut runs its target through the normal pipeline', async ({
  context,
  extensionId,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const workflowId = await recordWorkflow(send, provider, `${site.baseUrl}/`);
  await send('shortcut.create', {
    name: 'qa-regression',
    target: { kind: 'workflow', workflowId },
  });
  await send('session.setPermissionMode', { mode: 'manual' });

  await target.goto(`${site.baseUrl}/details`, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();

  const panel: Page = await openPanel(context, extensionId);
  await panel.locator('.composer__input').fill('/qa-regression');
  await panel.locator('.composer__submit').click();
  await expect(panel.getByTestId('shortcut-confirm')).toBeVisible();

  // The workflow navigates the *active* tab, and opening the side panel made
  // the panel active. Brought back first, then the click is dispatched rather
  // than performed, so confirming does not steal focus from the tab the
  // workflow is about to drive.
  await target.bringToFront();
  const answers = autoAnswer(send, 'approve_once');
  await panel.getByTestId('shortcut-confirm').dispatchEvent('click');
  await expect.poll(async () => target.url(), { timeout: 20_000 }).toBe(`${site.baseUrl}/`);
  answers.stop();

  // The browser really moved, and the permission engine was really asked —
  // a name bought nothing.
  expect(answers.asked).toContain('browser.navigate');
  await panel.close();
});

test('a shortcut to a deleted workflow refuses with nothing executed', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const workflowId = await recordWorkflow(send, provider, `${site.baseUrl}/`);
  await send('shortcut.create', {
    name: 'qa-regression',
    target: { kind: 'workflow', workflowId },
  });
  await send('workflow.remove', { workflowId });

  const at = await target.goto(`${site.baseUrl}/details`, { waitUntil: 'domcontentloaded' });
  expect(at).not.toBeNull();

  const verdict = await send('shortcut.resolve', { typed: '/qa-regression' });
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe('TARGET_MISSING');

  // The name is still listed so the user can see and remove it, but it is
  // marked unusable and runs nothing.
  const { shortcuts } = await send('shortcut.list', {});
  expect(shortcuts.find((entry) => entry.name === 'qa-regression')?.usable).toBe(false);
  expect(target.url()).toBe(`${site.baseUrl}/details`);
});

test('a shortcut to an incomplete recording refuses with nothing executed', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  // A click whose element carries a credential-shaped name cannot be
  // recorded, so the recording ends up with a gap — and P-022 refuses to
  // replay it. The shortcut must not be a way around that.
  await target.evaluate(() => {
    const button = document.getElementById('submit');
    if (button) button.textContent = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  });
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser.read_page', arguments: {} }] },
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser.click', arguments: { elementId: '$lastElementId' } }],
    },
    { kind: 'text', text: 'Clicked.' },
  ]);
  const { task } = await send('task.create', { objective: 'Read then click.' });
  await send('workflow.recordStart', { taskId: task.id });
  await waitForTask(send, task.id, 40_000);
  const saved = await send('workflow.recordStop', {
    name: 'An incomplete recording',
    description: 'Has a gap.',
  });
  expect(saved.workflow!.incomplete).toBe(true);

  // Creation itself refuses an unusable target.
  const created = await send('shortcut.create', {
    name: 'gappy',
    target: { kind: 'workflow', workflowId: saved.workflow!.workflowId },
  });
  expect(created.shortcut).toBeNull();
  expect(created.error?.reason).toBe('INVALID_TARGET');
  expect((await send('shortcut.list', {})).shortcuts).toHaveLength(0);
});

test('a second shortcut cannot take a name confusable with an existing one', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const workflowId = await recordWorkflow(send, provider, `${site.baseUrl}/`);
  const first = await send('shortcut.create', {
    name: 'deploy',
    target: { kind: 'workflow', workflowId },
  });
  expect(first.shortcut).not.toBeNull();

  for (const lookalike of ['DEPLOY', 'dep1oy', 'depl0y', 'de_ploy']) {
    const second = await send('shortcut.create', {
      name: lookalike,
      target: { kind: 'workflow', workflowId },
    });
    // Refused, not merged and not auto-renamed — and the user is told what it
    // clashed with.
    expect(second.shortcut, lookalike).toBeNull();
    expect(second.error?.detail ?? '', lookalike).toContain('deploy');
  }
  expect((await send('shortcut.list', {})).shortcuts).toHaveLength(1);
});

test('shortcuts are invisible to the model', async ({ context, send, provider, site }) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const workflowId = await recordWorkflow(send, provider, `${site.baseUrl}/`);
  await send('shortcut.create', {
    name: 'qa-regression',
    target: { kind: 'workflow', workflowId },
  });

  // The real tool registry, after a real shortcut exists.
  const { tools } = await send('tools.list', {});
  const names = tools.map((tool) => tool.name);
  expect(names.filter((name) => name.startsWith('shortcut.'))).toEqual([]);
  expect(names).not.toContain('skill.run');

  // And the skill list, which is what a model is offered.
  const { skills } = await send('skill.list', {});
  expect(skills.map((skill) => skill.id)).not.toContain('qa-regression');
  expect(skills).toHaveLength(3);
});

test('shortcuts added no permission and no host access', async ({ serviceWorker }) => {
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());

  expect(manifest.permissions ?? []).toEqual([
    'sidePanel',
    'storage',
    'unlimitedStorage',
    'tabs',
    'tabGroups',
    'scripting',
    'debugger',
    'notifications',
    'activeTab',
    'alarms',
  ]);
  expect(manifest.host_permissions ?? []).toEqual(['http://*/*', 'https://*/*']);
  expect((manifest.host_permissions ?? []).includes('<all_urls>')).toBe(false);
});
