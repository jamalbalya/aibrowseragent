import { useState } from 'react';
import { sendToBackground } from '@/messaging/bus';
import { ShortcutConfirm } from './ShortcutConfirm';
import type { PanelResponse } from '@/messaging/protocol';

type Resolution = NonNullable<PanelResponse<'shortcut.resolve'>['resolution']>;

interface TaskComposerProps {
  readonly disabled: boolean;
  readonly disabledReason?: string;
  readonly onSubmit: (objective: string) => void;
  /** Runs what a confirmed shortcut resolved to. */
  readonly onRunShortcut: (resolution: Resolution) => Promise<void>;
}

/**
 * Where a task, or a shortcut, is started.
 *
 * Text starting with `/` is treated as a shortcut name rather than an
 * objective. Resolving one is a read — it runs nothing — so it is safe to do
 * while the user is still typing, and what it finds is shown for confirmation
 * before anything starts. A name that resolves to nothing is reported as
 * such and is never quietly sent to the model as an objective, because
 * "/qa-regression" as a prompt is not what the person asked for.
 */
export function TaskComposer({
  disabled,
  disabledReason,
  onSubmit,
  onRunShortcut,
}: TaskComposerProps): React.JSX.Element {
  const [value, setValue] = useState('');
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const typed = value.trim();
  const isShortcut = typed.startsWith('/');

  const submit = async (): Promise<void> => {
    if (typed.length === 0 || disabled || busy) return;

    if (!isShortcut) {
      onSubmit(typed);
      setValue('');
      return;
    }

    setBusy(true);
    try {
      const verdict = await sendToBackground('shortcut.resolve', { typed });
      if (verdict.ok && verdict.resolution) {
        // Resolved, not run. The user confirms before anything starts.
        setResolution(verdict.resolution);
      } else {
        setProblem(verdict.detail ?? 'There is no shortcut by that name.');
      }
    } catch {
      setProblem('That shortcut could not be looked up.');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (): Promise<void> => {
    if (!resolution) return;
    setBusy(true);
    try {
      await onRunShortcut(resolution);
      setResolution(null);
      setValue('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {resolution ? (
        <ShortcutConfirm
          resolution={resolution}
          busy={busy}
          onConfirm={() => void confirm()}
          onCancel={() => setResolution(null)}
        />
      ) : null}

      {problem ? (
        <div className="banner banner--error" role="alert" data-testid="shortcut-problem">
          {problem}
        </div>
      ) : null}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          className="composer__input"
          value={value}
          placeholder={
            disabled
              ? (disabledReason ?? 'Connect a provider first.')
              : 'What should the agent do? Type / for a shortcut.'
          }
          disabled={disabled}
          rows={3}
          onChange={(event) => {
            // A verdict describes the text it was produced from, so editing
            // the text discards it. Leaving it up would let someone confirm a
            // shortcut they are no longer looking at.
            setValue(event.target.value);
            setResolution(null);
            setProblem(null);
          }}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter inserts a newline.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <button
          type="submit"
          className="button button--primary composer__submit"
          disabled={disabled || typed.length === 0 || busy}
        >
          {isShortcut ? 'Look up' : 'Start'}
        </button>
      </form>
    </>
  );
}
