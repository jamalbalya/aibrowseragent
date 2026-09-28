/**
 * TEST-E2E-049 — the authority-changing actions the audit census found.
 *
 * `tests/security/audit-coverage-census.test.ts` is a source census: it proves
 * every control-plane route either records or is exempt with a stated reason.
 * What a census cannot show is that the record actually lands, carries the
 * fields a reader needs, and carries nothing it should not. That is what these
 * cases do, in real Chromium against the shipped `dist/`.
 *
 * The twelve actions here wrote nothing at all before this wave, and each had an
 * audited counterpart beside it — which is what makes the omission a defect
 * rather than a scope decision. The K1 five are the ones worth reading: local
 * encryption is what protects the provider keys and connector credentials in
 * this profile, and switching it off left no trace, so a profile found later
 * with plaintext keys could not be distinguished from one where protection had
 * never been switched on.
 */
import { expect, openPanel, test, type SendToWorker } from './fixtures/extension';

const PASSPHRASE = 'a passphrase for the audit coverage suite';
const OTHER = 'a different passphrase entirely';

/**
 * The matching records, oldest first.
 *
 * `audit.list` pages newest first, which is right for the Activity view and
 * wrong for reading a sequence of decisions. Sorted on `seq` rather than
 * reversed, because `seq` is what the trail says order is — `at` is a clock and
 * two records in the same millisecond tie.
 */
/** The failure detail, on a result shape that only carries one when it failed. */
function why(result: { readonly ok: boolean; readonly detail?: string }): string {
  return result.ok ? '' : (result.detail ?? 'no detail');
}

async function records(send: SendToWorker, type: string): Promise<readonly any[]> {
  const page = await send('audit.list', { limit: 400 });
  return page.events
    .filter((event: any) => event.type === type)
    .sort((a: any, b: any) => a.seq - b.seq);
}

test('switching the permission mode is recorded, and says which way it went', async ({ send }) => {
  await send('session.setPermissionMode', { mode: 'manual' });
  const base = (await records(send, 'session.permission_mode')).length;

  // Loosening. The record a reader most needs, because it removes the
  // confirmation step from every later action for as long as it stands.
  await send('session.setPermissionMode', { mode: 'skip' });
  const loosened = await records(send, 'session.permission_mode');
  expect(loosened.length).toBe(base + 1);
  const loose = loosened[loosened.length - 1];
  expect(loose.permissionMode).toBe('skip');
  expect(loose.code).toBe('FROM_MANUAL');
  // `denied` is the direction, not a verdict on the request: the authority went
  // the loose way. It is the same sense `policy.site_rule` uses for a
  // revocation.
  expect(loose.outcome).toBe('denied');

  // Tightening again is the other direction.
  await send('session.setPermissionMode', { mode: 'manual' });
  const tightened = await records(send, 'session.permission_mode');
  expect(tightened[tightened.length - 1].outcome).toBe('allowed');
  expect(tightened[tightened.length - 1].code).toBe('FROM_SKIP');

  // The control: setting the mode it already has records nothing, so the trail
  // never carries a change nobody made.
  const settled = tightened.length;
  await send('session.setPermissionMode', { mode: 'manual' });
  expect((await records(send, 'session.permission_mode')).length).toBe(settled);
});

test('a shortcut records its configuration, and the record holds no name a user typed', async ({
  send,
}) => {
  const name = 'Audit census shortcut';
  const created = await send('shortcut.create', {
    name,
    target: { kind: 'prompt', objective: 'Summarise this page.' },
  });
  expect(created.shortcut, created.error?.detail).toBeTruthy();
  const id = created.shortcut!.shortcutId;

  const afterCreate = await records(send, 'shortcut.configured');
  const create = afterCreate.find((event) => event.code === 'CREATED' && event.shortcutId === id);
  expect(create).toBeTruthy();
  expect(create.outcome).toBe('allowed');

  // Retargeting is the case this event most exists for: a person confirms a
  // launch by the name they gave it, and the name does not change when the
  // target does.
  await send('shortcut.retarget', {
    shortcutId: id,
    target: { kind: 'prompt', objective: 'Something else entirely.' },
  });
  expect(
    (await records(send, 'shortcut.configured')).some(
      (event) => event.code === 'RETARGETED' && event.shortcutId === id,
    ),
  ).toBe(true);

  await send('shortcut.remove', { shortcutId: id });
  const removal = (await records(send, 'shortcut.configured')).find(
    (event) => event.code === 'REMOVED' && event.shortcutId === id,
  );
  expect(removal).toBeTruthy();
  expect(removal.outcome).toBe('denied');

  // What the records must not hold: the display name, which is text a user
  // typed, and the objective, which is what the shortcut does.
  const all = JSON.stringify(await records(send, 'shortcut.configured'));
  expect(all).not.toContain(name);
  expect(all).not.toContain('Summarise this page');
  expect(all).not.toContain('Something else entirely');
});

test('an export and an import are recorded with counts, never with contents', async ({ send }) => {
  const created = await send('shortcut.create', {
    name: 'Export census shortcut',
    target: { kind: 'prompt', objective: 'A distinctive objective string.' },
  });
  expect(created.shortcut, created.error?.detail).toBeTruthy();

  const { export: document } = await send('data.export', {});
  const exported = await records(send, 'data.exported');
  const local = exported.filter((event) => event.code === 'LOCAL_RECORDS');
  expect(local.length).toBeGreaterThan(0);
  expect(local[local.length - 1].recordCount).toBe(
    document.workflows.length + document.shortcuts.length,
  );

  // The document itself carries the objective. The record of it must not.
  expect(JSON.stringify(document)).toContain('A distinctive objective string');
  expect(JSON.stringify(exported)).not.toContain('A distinctive objective string');

  // An import of the same document collides on every shortcut name, which is
  // the interesting shape: nothing lands, and the record says so rather than
  // reporting a silent success.
  const before = (await records(send, 'data.imported')).length;
  await send('data.import', { document });
  const imported = await records(send, 'data.imported');
  expect(imported.length).toBe(before + 1);
  const last = imported[imported.length - 1];
  expect(last.outcome).toBe('allowed');
  expect(typeof last.recordCount).toBe('number');
  expect(String(last.code)).toMatch(/^REFUSED_\d+$/);

  await send('shortcut.remove', { shortcutId: created.shortcut!.shortcutId });
});

test('exporting the trail is itself in the trail, and not inside the page it describes', async ({
  send,
}) => {
  const before = (await records(send, 'data.exported')).length;
  const { export: document } = await send('audit.export', { scope: { kind: 'all' }, limit: 100 });

  const trail = (await records(send, 'data.exported')).filter(
    (event) => event.code === 'AUDIT_TRAIL',
  );
  expect(trail.length).toBeGreaterThan(0);
  expect((await records(send, 'data.exported')).length).toBe(before + 1);

  // The record is appended after the document is built, so the document cannot
  // contain it — an export reporting a count that includes the record written
  // by the act of counting would be describing itself.
  const last = trail[trail.length - 1];
  expect(JSON.stringify(document)).not.toContain(last.id);
  expect(last.recordCount).toBe(document.events.length);
});

test('local encryption records being switched on, locked, unlocked and switched off', async ({
  send,
}) => {
  expect((await send('k1.status', {})).state).toBe('OFF');

  const enabled = await send('k1.enable', { passphrase: PASSPHRASE });
  expect(enabled.ok, why(enabled)).toBe(true);
  let all = await records(send, 'k1.protection');
  expect(all.map((event) => event.code)).toContain('ENABLED');
  expect(all.find((event) => event.code === 'ENABLED').outcome).toBe('allowed');

  await send('k1.lock', {});
  all = await records(send, 'k1.protection');
  const locked = all.find((event) => event.code === 'LOCKED');
  expect(locked).toBeTruthy();
  expect(locked.outcome).toBe('denied');

  // A refused unlock. The one observable sign of somebody working through
  // passphrases against a profile, which is the scenario K1's own threat model
  // names — a stolen laptop, a synced backup, a shared machine.
  const refused = await send('k1.unlock', { passphrase: OTHER });
  expect(refused.ok).toBe(false);
  all = await records(send, 'k1.protection');
  const wrong = all.find((event) => event.code === 'WRONG_PASSPHRASE');
  expect(wrong).toBeTruthy();
  expect(wrong.outcome).toBe('failed');

  const unlocked = await send('k1.unlock', { passphrase: PASSPHRASE });
  expect(unlocked.ok, why(unlocked)).toBe(true);
  expect((await records(send, 'k1.protection')).map((event) => event.code)).toContain('UNLOCKED');

  await send('k1.changePassphrase', { current: PASSPHRASE, next: OTHER });
  expect((await records(send, 'k1.protection')).map((event) => event.code)).toContain(
    'PASSPHRASE_CHANGED',
  );

  // The record this type most exists for: protection coming off the only
  // SECRET_LOCAL_ONLY material this extension holds.
  const off = await send('k1.disable', { passphrase: OTHER });
  expect(off.ok, why(off)).toBe(true);
  all = await records(send, 'k1.protection');
  const disabled = all.find((event) => event.code === 'DISABLED');
  expect(disabled).toBeTruthy();
  expect(disabled.outcome).toBe('denied');
  // And it is distinguishable from locking, which was the defect in the panel
  // before the code was rendered: both are `k1.protection` with `denied`.
  expect(disabled.code).not.toBe(locked.code);

  // Nothing derived from either passphrase reaches the trail.
  const dump = JSON.stringify(all);
  expect(dump).not.toContain(PASSPHRASE);
  expect(dump).not.toContain(OTHER);
  for (const word of PASSPHRASE.split(' ')) {
    if (word.length > 5) expect(dump).not.toContain(word);
  }
});

test('the Activity view shows the code, so two records with one outcome read apart', async ({
  context,
  extensionId,
  send,
}) => {
  await send('k1.enable', { passphrase: PASSPHRASE });
  await send('k1.lock', {});
  await send('k1.unlock', { passphrase: PASSPHRASE });
  await send('k1.disable', { passphrase: PASSPHRASE });

  const panel = await openPanel(context, extensionId);
  await panel.getByRole('button', { name: /activity/i }).click();
  const list = panel.getByTestId('audit-list');
  await expect(list).toBeVisible();

  // Both of these are `k1.protection` with a `denied` outcome. Without the code
  // on the row a reader cannot tell locking from switching protection off,
  // which is the difference between a safety action and removing the safety.
  await expect(list.getByText('LOCKED', { exact: true })).toBeVisible();
  await expect(list.getByText('DISABLED', { exact: true })).toBeVisible();

  await panel.close();
});
