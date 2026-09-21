import { useState } from 'react';

interface TaskComposerProps {
  readonly disabled: boolean;
  readonly disabledReason?: string;
  readonly onSubmit: (objective: string) => void;
}

export function TaskComposer({
  disabled,
  disabledReason,
  onSubmit,
}: TaskComposerProps): React.JSX.Element {
  const [value, setValue] = useState('');

  const submit = (): void => {
    const objective = value.trim();
    if (objective.length === 0 || disabled) return;
    onSubmit(objective);
    setValue('');
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        className="composer__input"
        value={value}
        placeholder={
          disabled ? (disabledReason ?? 'Connect a provider first.') : 'What should the agent do?'
        }
        disabled={disabled}
        rows={3}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends; Shift+Enter inserts a newline.
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <button
        type="submit"
        className="button button--primary composer__submit"
        disabled={disabled || value.trim().length === 0}
      >
        Start
      </button>
    </form>
  );
}
