/**
 * TEST-CONNECTOR-005 — connector reads and writes, end to end.
 *
 * Everything but the socket is the real composition: the real session, the
 * real token vault, the real guarded transport over the real egress gate, the
 * real write guard. Only `fetch` is replaced, by a mock service that answers
 * GitHub's shapes and records what it was sent.
 *
 * That matters for what the failures here mean. A break in this file is a
 * break in the wiring between those pieces, which is the part no unit suite
 * can see.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ToolError } from '@/types/result';
import {
  buildConnectorHarness,
  wireIssue,
  type ConnectorHarness,
} from '../fixtures/connector-harness';

const TASK = 'task_connector_1';

let harness: ConnectorHarness;

beforeEach(async () => {
  harness = buildConnectorHarness();
  await harness.connect(['public_repo']);
});

/** Runs a tool and returns whatever it threw, so a test can assert on it. */
async function failure(run: () => Promise<unknown>): Promise<ToolError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error('The call was expected to fail and did not.');
}

// --- reads ------------------------------------------------------------------

describe('reading', () => {
  it('returns search results, labelled as untrusted', async () => {
    harness.service.on('/search/issues', {
      json: { total_count: 2, items: [wireIssue(), wireIssue({ number: 8, title: 'Another' })] },
    });

    const result = await harness
      .tool('github.search_issues')
      .execute({ query: 'broken login' }, harness.context(TASK));

    expect(result.success).toBe(true);
    const data = result.data as { totalCount: number; returned: number; items: string };
    expect(data.totalCount).toBe(2);
    expect(data.returned).toBe(2);
    // An issue title is written by whoever opened the issue. It reaches the
    // model inside an untrusted wrapper or not at all.
    expect(data.items).toContain('UNTRUSTED');
    expect(data.items).toContain('A title');
  });

  it('carries the query to the service and nothing else', async () => {
    harness.service.on('/search/issues', { json: { total_count: 0, items: [] } });
    await harness
      .tool('github.search_issues')
      .execute({ query: 'broken login', repository: 'acme/widgets' }, harness.context(TASK));

    const [request] = harness.service.seen;
    expect(request!.method).toBe('GET');
    expect(decodeURIComponent(request!.url)).toContain('broken login repo:acme/widgets');
    expect(request!.body).toBeUndefined();
  });

  it('handles an empty result without inventing one', async () => {
    harness.service.on('/search/issues', { json: { total_count: 0, items: [] } });
    const result = await harness
      .tool('github.search_issues')
      .execute({ query: 'nothing matches this' }, harness.context(TASK));

    const data = result.data as { totalCount: number; returned: number };
    expect(data).toMatchObject({ totalCount: 0, returned: 0 });
  });

  it('caps how much a single read can bring into the context', async () => {
    // A search that matched ten thousand issues must not become ten thousand
    // items of model context.
    harness.service.on('/search/issues', {
      json: {
        total_count: 10_000,
        items: Array.from({ length: 200 }, (_, i) => wireIssue({ number: i })),
      },
    });

    const result = await harness
      .tool('github.search_issues')
      .execute({ query: 'everything' }, harness.context(TASK));

    const data = result.data as { totalCount: number; returned: number };
    expect(data.returned).toBe(25);
    // The true count is still reported: truncation is stated, not hidden.
    expect(data.totalCount).toBe(10_000);
  });

  it('truncates a long issue body rather than passing it through', async () => {
    harness.service
      .on('/issues/7', { json: wireIssue({ body: 'x'.repeat(50_000) }) })
      .on('/comments', { json: [] });

    const result = await harness
      .tool('github.read_issue')
      .execute({ repository: 'acme/widgets', issueNumber: 7 }, harness.context(TASK));

    const issue = (result.data as { issue: string }).issue;
    expect(issue).toContain('[truncated]');
    expect(issue.length).toBeLessThan(10_000);
  });

  it('records the issue as evidence, labelled untrusted', async () => {
    harness.service
      .on('/issues/7', { json: wireIssue() })
      .on('/comments', { json: [{ id: 1, body: 'a comment', user: { login: 'other' } }] });

    await harness
      .tool('github.read_issue')
      .execute({ repository: 'acme/widgets', issueNumber: 7 }, harness.context(TASK));

    expect(harness.evidence).toHaveLength(1);
    expect(harness.evidence[0]!.label).toBe('GitHub acme/widgets#7');
    expect(harness.evidence[0]!.content).toContain('a comment');
  });

  it('reports what the read touched, so the task carries the taint', async () => {
    harness.service.on('/search/issues', { json: { total_count: 0, items: [] } });
    const result = await harness
      .tool('github.search_issues')
      .execute({ query: 'anything' }, harness.context(TASK));

    expect(result.taint).toEqual([
      { sourceType: 'connector', site: 'github.com', sensitivity: 'internal' },
    ]);
  });

  it('survives a malformed response without throwing a parse error at the user', async () => {
    harness.service.on('/search/issues', { json: { unexpected: true } });
    const result = await harness
      .tool('github.search_issues')
      .execute({ query: 'anything' }, harness.context(TASK));

    // Absent fields mean an empty list, not a crash.
    expect((result.data as { returned: number }).returned).toBe(0);
  });

  it('still returns the issue when its comments cannot be read', async () => {
    harness.service.on('/issues/7', { json: wireIssue() }).on('/comments', { status: 403 });
    const result = await harness
      .tool('github.read_issue')
      .execute({ repository: 'acme/widgets', issueNumber: 7 }, harness.context(TASK));
    expect(result.success).toBe(true);
  });
});

describe('failures a read surfaces', () => {
  it.each([
    ['401', 401, 'AUTH_EXPIRED', false],
    ['404', 404, 'CONNECTOR_ERROR', false],
    ['422', 422, 'CONNECTOR_ERROR', false],
    ['429', 429, 'RATE_LIMITED', true],
    ['500', 500, 'CONNECTOR_ERROR', true],
  ])('%s → %s, retryable %s', async (_label, status, code, retryable) => {
    harness.service.on('/search/issues', { status, text: '{"message":"no"}' });
    const error = await failure(() =>
      harness.tool('github.search_issues').execute({ query: 'x' }, harness.context(TASK)),
    );
    expect(error.toAgentError().code).toBe(code);
    expect(error.toAgentError().retryable).toBe(retryable);
  });

  it('tells a rate limit apart from a refusal, both of which are 403', async () => {
    harness.service.on('/search/issues', {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0' },
      text: '{}',
    });
    const limited = await failure(() =>
      harness.tool('github.search_issues').execute({ query: 'x' }, harness.context(TASK)),
    );
    expect(limited.toAgentError().code).toBe('RATE_LIMITED');
    expect(limited.toAgentError().retryable).toBe(true);

    harness.service.on('/search/issues', {
      status: 403,
      headers: { 'x-ratelimit-remaining': '4999' },
      text: '{}',
    });
    const refused = await failure(() =>
      harness.tool('github.search_issues').execute({ query: 'x' }, harness.context(TASK)),
    );
    expect(refused.toAgentError().code).toBe('PERMISSION_DENIED');
    expect(refused.toAgentError().retryable).toBe(false);
  });

  it('does not echo the service response into the user-facing message', async () => {
    // A 404 body on a private repository can say more than the user is
    // entitled to know, and any body is attacker-influenced text.
    harness.service.on('/search/issues', {
      status: 404,
      text: 'Not Found: acme/secret-internal-project',
    });
    const error = await failure(() =>
      harness.tool('github.search_issues').execute({ query: 'x' }, harness.context(TASK)),
    );
    expect(error.toAgentError().userMessage).not.toContain('secret-internal-project');
  });
});

// --- writes -----------------------------------------------------------------

describe('writing', () => {
  it('creates an issue and reports where it landed', async () => {
    harness.service.on('/issues', {
      status: 201,
      json: { number: 11, html_url: 'https://github.test/acme/widgets/issues/11' },
    });

    const result = await harness
      .tool('github.create_issue')
      .execute(
        { repository: 'acme/widgets', title: 'A bug', body: 'It broke.' },
        harness.context(TASK),
      );

    expect(result.data).toMatchObject({
      number: 11,
      url: 'https://github.test/acme/widgets/issues/11',
      duplicate: false,
    });
    const [request] = harness.service.seen;
    expect(request!.method).toBe('POST');
    expect(JSON.parse(request!.body!)).toEqual({ title: 'A bug', body: 'It broke.' });
  });

  it('is declared as a confirmed, high-risk, non-idempotent operation', () => {
    // The permission layer reads these. A write that declared itself
    // idempotent would be retried automatically.
    const tool = harness.tool('github.create_issue');
    expect(tool.risk).toBe('R3');
    expect(tool.idempotent).toBe(false);
    const operation = harness.connector.descriptor.operations.find(
      (candidate) => candidate.id === 'create_issue',
    );
    expect(operation).toMatchObject({ kind: 'write', requiresConfirmation: true });
  });

  it('refuses a write the connector was not authorised for', async () => {
    // A read-only authorization cannot be talked into a write, whatever the
    // model asks for.
    const readOnly = buildConnectorHarness();
    await readOnly.connect([]);

    const error = await failure(() =>
      readOnly
        .tool('github.create_issue')
        .execute({ repository: 'acme/widgets', title: 't', body: 'b' }, readOnly.context(TASK)),
    );
    expect(error.toAgentError().code).toBe('PERMISSION_DENIED');
    // Nothing was sent.
    expect(readOnly.service.seen).toEqual([]);
  });

  it('refuses any operation when the connector is not connected', async () => {
    const disconnected = buildConnectorHarness();
    await disconnected.session.reconcile();

    const error = await failure(() =>
      disconnected.tool('github.search_issues').execute({ query: 'x' }, disconnected.context(TASK)),
    );
    expect(error.toAgentError().code).toBe('AUTH_REQUIRED');
    expect(disconnected.service.seen).toEqual([]);
  });

  it('does not send a second write for an identical repeat', async () => {
    harness.service.on('/issues', {
      status: 201,
      json: { number: 11, html_url: 'https://github.test/acme/widgets/issues/11' },
    });
    const input = { repository: 'acme/widgets', title: 'A bug', body: 'It broke.' };

    const first = await harness.tool('github.create_issue').execute(input, harness.context(TASK));
    const second = await harness.tool('github.create_issue').execute(input, harness.context(TASK));

    expect(first.data).toMatchObject({ duplicate: false });
    expect(second.data).toMatchObject({ duplicate: true, alreadyDone: true });
    // One POST, not two. This is the whole point.
    expect(harness.service.seen.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('refuses to replay a write that timed out, because it may have landed', async () => {
    harness.service.on('/issues', { throws: new DOMException('timed out', 'TimeoutError') });
    const input = { repository: 'acme/widgets', title: 'A bug', body: 'It broke.' };

    const timeout = await failure(() =>
      harness.tool('github.create_issue').execute(input, harness.context(TASK)),
    );
    expect(timeout.toAgentError().code).toBe('CONNECTOR_ERROR');

    harness.service.on('/issues', { status: 201, json: { number: 11 } });
    const replay = await failure(() =>
      harness.tool('github.create_issue').execute(input, harness.context(TASK)),
    );
    expect(replay.toAgentError().userMessage).toContain('may already have happened');
    // Even though the service would now answer, nothing was sent.
    expect(harness.service.seen.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('treats a 5xx as an unknown outcome, not a clean failure', async () => {
    // A gateway can time out after the origin committed the write.
    harness.service.on('/issues', { status: 502, text: 'bad gateway' });
    const input = { repository: 'acme/widgets', title: 'A bug', body: 'b' };

    await failure(() => harness.tool('github.create_issue').execute(input, harness.context(TASK)));

    const records = await harness.writes.list(TASK);
    expect(records[0]!.outcome).toBe('uncertain');
  });

  it('allows a retry after the service explicitly rejected the request', async () => {
    // 422 means the service decided not to act, so nothing happened on its
    // side and correcting the request is a legitimate retry.
    harness.service.on('/issues', { status: 422, text: '{"message":"invalid"}' });
    const input = { repository: 'acme/widgets', title: 'A bug', body: 'b' };
    await failure(() => harness.tool('github.create_issue').execute(input, harness.context(TASK)));

    harness.service.on('/issues', { status: 201, json: { number: 12 } });
    const retried = await harness.tool('github.create_issue').execute(input, harness.context(TASK));
    expect(retried.data).toMatchObject({ number: 12, duplicate: false });
  });

  it('records a refused write as failed rather than uncertain', async () => {
    harness.service.on('/issues', { status: 422, text: '{}' });
    await failure(() =>
      harness
        .tool('github.create_issue')
        .execute({ repository: 'acme/widgets', title: 't', body: 'b' }, harness.context(TASK)),
    );
    expect((await harness.writes.list(TASK))[0]!.outcome).toBe('failed');
  });

  it('settles a scope refusal as failed without sending anything', async () => {
    const readOnly = buildConnectorHarness();
    await readOnly.connect([]);
    await failure(() =>
      readOnly
        .tool('github.comment_issue')
        .execute(
          { repository: 'acme/widgets', issueNumber: 7, body: 'hi' },
          readOnly.context(TASK),
        ),
    );

    // A refusal before the request never reached the service, so replaying
    // it must not be blocked as "uncertain".
    const records = await readOnly.writes.list(TASK);
    expect(records[0]!.outcome).toBe('failed');
    expect(readOnly.service.seen).toEqual([]);
  });

  it('keeps two different writes in one task independent', async () => {
    harness.service
      .on('/issues', { status: 201, json: { number: 11 } })
      .on('/issues', { status: 201, json: { number: 12 } });

    const a = await harness
      .tool('github.create_issue')
      .execute({ repository: 'acme/widgets', title: 'A', body: 'b' }, harness.context(TASK));
    const b = await harness
      .tool('github.create_issue')
      .execute({ repository: 'acme/widgets', title: 'B', body: 'b' }, harness.context(TASK));

    expect(a.data).toMatchObject({ duplicate: false });
    expect(b.data).toMatchObject({ duplicate: false });
    expect(harness.service.seen.filter((r) => r.method === 'POST')).toHaveLength(2);
  });

  it('comments on an issue', async () => {
    harness.service.on('/comments', { status: 201, json: { id: 99 } });
    const result = await harness
      .tool('github.comment_issue')
      .execute(
        { repository: 'acme/widgets', issueNumber: 7, body: 'A comment.' },
        harness.context(TASK),
      );
    expect(result.data).toMatchObject({ id: 99, duplicate: false });
  });
});

// --- input validation -------------------------------------------------------

describe('what a tool will accept as input', () => {
  it.each([
    ['a traversal in the repository name', { repository: '../../etc/passwd', issueNumber: 1 }],
    ['a full URL in the repository name', { repository: 'https://evil.test/a/b', issueNumber: 1 }],
    ['a repository with no owner', { repository: 'widgets', issueNumber: 1 }],
    ['a negative issue number', { repository: 'acme/widgets', issueNumber: -1 }],
    ['a fractional issue number', { repository: 'acme/widgets', issueNumber: 1.5 }],
  ])('refuses %s', (_label, input) => {
    // The schema is what stops a model-chosen string becoming a path segment.
    const parsed = harness.tool('github.read_issue').inputSchema.safeParse(input);
    expect(parsed.success).toBe(false);
  });

  it('accepts an ordinary repository reference', () => {
    expect(
      harness
        .tool('github.read_issue')
        .inputSchema.safeParse({ repository: 'acme/widgets.js', issueNumber: 7 }).success,
    ).toBe(true);
  });
});
