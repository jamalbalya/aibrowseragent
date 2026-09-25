import type { PanelResponse } from '@/messaging/protocol';

type Resolution = NonNullable<PanelResponse<'shortcut.resolve'>['resolution']>;

interface ShortcutConfirmProps {
  readonly resolution: Resolution;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * What a shortcut means, before it runs.
 *
 * A shortcut is a name, and a name can be mistaken for another name — so the
 * user is shown what this one resolves to and has to say yes. Nothing runs
 * until they do.
 *
 * This is **not** an authorization. It answers "which reviewed thing is about
 * to start", not "may it do what it does": every permission, policy and egress
 * decision the target would have faced, it still faces, step by step, once it
 * starts. Approving here buys none of them.
 *
 * It deliberately shows identity and risk rather than a step list. A step list
 * here would be a second, abbreviated review surface competing with the real
 * one, and the place to inspect what a workflow does is the review surface
 * that already exists for it.
 */
export function ShortcutConfirm({
  resolution,
  busy,
  onConfirm,
  onCancel,
}: ShortcutConfirmProps): React.JSX.Element {
  const kind =
    resolution.targetKind === 'workflow'
      ? 'recorded workflow'
      : resolution.targetKind === 'prompt'
        ? 'saved prompt'
        : 'built-in workflow';

  return (
    <section className="prompt" role="dialog" aria-label="Confirm shortcut">
      <h3 className="prompt__title">Run /{resolution.name}?</h3>
      <dl className="prompt__facts">
        <dt>Shortcut</dt>
        <dd data-testid="shortcut-name">/{resolution.name}</dd>
        <dt>Type</dt>
        <dd data-testid="shortcut-kind">{kind}</dd>
        <dt>Runs</dt>
        <dd data-testid="shortcut-target">{resolution.targetName}</dd>
        {/* A saved prompt has no step list and no risk until it runs, so it
            shows the objective it would start instead of a number it does not
            have. Printing `R0` here would read as "read-only". */}
        {resolution.targetKind === 'prompt' ? (
          <>
            <dt>Objective</dt>
            <dd data-testid="shortcut-objective">{resolution.objective}</dd>
          </>
        ) : (
          <>
            <dt>Steps</dt>
            <dd>
              {resolution.stepCount ?? 0}{' '}
              {resolution.risk ? (
                <span className={`badge badge--risk-${resolution.risk.toLowerCase()}`}>
                  {resolution.risk}
                </span>
              ) : null}
            </dd>
          </>
        )}
      </dl>
      <p className="field__hint">
        {resolution.targetKind === 'prompt'
          ? 'This starts a new task with the saved objective. Every action it takes is approved ' +
            'as it happens, exactly as if you had typed the objective yourself.'
          : 'Running this asks for permission step by step, exactly as it would without the ' +
            'shortcut. Confirming here approves nothing on its own.'}
      </p>
      <div className="prompt__actions">
        <button
          type="button"
          className="button button--primary"
          data-testid="shortcut-confirm"
          disabled={busy}
          onClick={onConfirm}
        >
          Run it
        </button>
        <button type="button" className="button button--ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
