/**
 * TEST-E2E-037 — origin drift, through the real production dispatch path.
 *
 * REAL BROWSER + LOCAL TEST SERVER + MOCK PROVIDER. Pages are served over real
 * HTTP from two distinct origins and the content script is really injected.
 *
 * The defect these cases exist for was not a missing rule. `evaluatePolicy`
 * has had an origin-drift rule for a long time, and it had unit coverage. What
 * it did not have was a caller: nothing in production ever populated
 * `ToolInvocation.plannedUrl`, so in a real browser the rule never ran. The
 * unit suite proves the producer exists; these cases prove the whole path
 * works in the product — a real agent turn, a real navigation between two real
 * origins, the real policy engine, and the real permission prompt.
 *
 * Nothing here constructs a `ToolInvocation`. The task is created through the
 * panel's own route and driven by the mock provider's script, which is the
 * only thing faked.
 *
 * The drift is produced deterministically rather than by racing a timer: one
 * agent turn contains a navigation followed by a click. The planned URL is
 * read once, before the provider is asked; the navigation then moves the page;
 * and the click that follows lands on an origin the agent never saw. That is
 * both a realistic trajectory and a reliable one.
 */
import {
  connectProvider,
  expect,
  test,
  waitForTask,
  type SendToWorker,
} from './fixtures/extension';

type Prompt = { tool: string; reason: string };

/**
 * Approves prompts as they appear, for as long as the caller keeps running.
 *
 * Approving rather than denying, because a denial would stop the trajectory
 * before it reaches the point under test — the navigation this task performs
 * is itself gated (a task that has read a page and then moves to another
 * origin is a transfer), and refusing it would mean the page never moves and
 * there is no drift to detect.
 */
function answerPromptsUntilDone(send: SendToWorker): { prompts: Prompt[]; stop: () => void } {
  const prompts: Prompt[] = [];
  let running = true;
  void (async () => {
    while (running) {
      const listed = await send('permission.listPending', {}).catch(() => ({ requests: [] }));
      const { requests } = listed as { requests: { id: string; tool: string; reason: string }[] };
      for (const pending of requests) {
        prompts.push({ tool: pending.tool, reason: pending.reason });
        await send('permission.respond', {
          requestId: pending.id,
          response: { kind: 'approve_once' },
        }).catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  return {
    prompts,
    stop: () => {
      running = false;
    },
  };
}

test('an action on a page that moved to another origin is stopped', async ({
  context,
  send,
  provider,
  site,
  collector,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    {
      // One turn, two calls, and deliberately no page read before them. The
      // planned URL for both was taken before this reply was requested, so it
      // names the first origin; the navigation then moves the page, and the
      // click lands somewhere the agent never saw.
      //
      // Nothing is read first because a task that has read a page and then
      // crosses origins is also a data transfer, and the egress gate's
      // confirmation would replace the drift reason in the prompt. Keeping the
      // task clean leaves exactly one reason for the prompt to carry, which is
      // what is being asserted.
      kind: 'tool_calls',
      calls: [
        { name: 'browser_navigate', arguments: { url: `${collector.baseUrl}/landing` } },
        { name: 'browser_click', arguments: { elementId: 'e1-0' } },
      ],
    },
    { kind: 'text', text: 'Finished.' },
  ]);

  const { task } = await send('task.create', {
    objective: 'Go to the other site and click the first thing there.',
  });

  const answering = answerPromptsUntilDone(send);
  await waitForTask(send, task.id);
  answering.stop();
  const { prompts } = answering;

  // The rule fired, in a real browser, on a real origin change, through the
  // real dispatch path. Before the producer existed this prompt never
  // appeared at all.
  const drift = prompts.find((prompt) => prompt.reason.includes('moved from'));
  expect(drift, JSON.stringify(prompts)).toBeDefined();
  expect(drift?.reason).toContain('Confirm before continuing');

  await page.close();
});

test('an action on a page that stayed put raises no drift prompt', async ({
  context,
  send,
  provider,
  site,
}) => {
  // The control. Without it, the case above would pass just as well against a
  // build that confirmed every action, which would be no protection at all.
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'text', text: 'Read it twice; nothing moved.' },
  ]);

  const { task } = await send('task.create', {
    objective: 'Read this page, then read it again.',
  });
  const finished = await waitForTask(send, task.id);

  expect(finished.state).toBe('COMPLETED');
  const { requests } = await send('permission.listPending', {});
  expect(requests.length).toBe(0);

  await page.close();
});

test('a same-origin navigation is not reported as the page moving', async ({
  context,
  send,
  provider,
  site,
}) => {
  // Movement within one origin is ordinary browsing. A build that called this
  // drift would confirm its way through every multi-page task.
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    {
      kind: 'tool_calls',
      calls: [
        { name: 'browser_navigate', arguments: { url: `${site.baseUrl}/details` } },
        { name: 'browser_read_page', arguments: {} },
      ],
    },
    { kind: 'text', text: 'Same site throughout.' },
  ]);

  const { task } = await send('task.create', { objective: 'Open the details page and read it.' });
  const finished = await waitForTask(send, task.id);

  expect(finished.state).toBe('COMPLETED');
  const { requests } = await send('permission.listPending', {});
  expect(requests.length).toBe(0);

  await page.close();
});
