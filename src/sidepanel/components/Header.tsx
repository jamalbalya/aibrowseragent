import type { ProviderConnection } from '@/providers/registry/provider-registry';
import type { PermissionMode } from '@/policy/policy-engine';
import { PERMISSION_MODES } from '@/policy/policy-engine';

interface HeaderProps {
  readonly connection: ProviderConnection | null;
  readonly permissionMode: PermissionMode;
  readonly onChangeMode: (mode: PermissionMode) => void;
  readonly onOpenSettings: () => void;
  readonly onOpenWorkflows: () => void;
}

/**
 * Header.
 *
 * Which provider and model are active must always be visible
 * (specification section 49), so this is rendered from the stored connection
 * rather than from an assumption about what was configured.
 */
export function Header({
  connection,
  permissionMode,
  onChangeMode,
  onOpenSettings,
  onOpenWorkflows,
}: HeaderProps): React.JSX.Element {
  const status = describeStatus(connection);

  return (
    <header className="header">
      <div className="header__row">
        <h1 className="header__title">AI Browser Agent</h1>
        <span className="header__actions">
          <button type="button" className="button button--ghost" onClick={onOpenWorkflows}>
            Workflows
          </button>
          <button type="button" className="button button--ghost" onClick={onOpenSettings}>
            Settings
          </button>
        </span>
      </div>

      <div className="header__row">
        <span className={`status status--${status.tone}`} title={status.detail}>
          <span className="status__dot" aria-hidden="true" />
          {status.label}
        </span>

        <label className="header__mode">
          <span className="visually-hidden">Permission mode</span>
          <select
            value={permissionMode}
            onChange={(event) => onChangeMode(event.target.value as PermissionMode)}
          >
            {PERMISSION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {modeLabel(mode)}
              </option>
            ))}
          </select>
        </label>
      </div>
    </header>
  );
}

function modeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'manual':
      return 'Manual — ask every time';
    case 'auto':
      return 'Auto — ask for changes';
    case 'skip':
      return 'Skip — no prompts';
  }
}

interface StatusDescription {
  readonly label: string;
  readonly tone: 'ok' | 'warn' | 'error' | 'idle';
  readonly detail: string;
}

function describeStatus(connection: ProviderConnection | null): StatusDescription {
  if (!connection) {
    return {
      label: 'No provider connected',
      tone: 'idle',
      detail: 'Open Settings to connect an AI provider.',
    };
  }

  const model = connection.modelId || 'no model selected';

  switch (connection.status) {
    case 'connected':
      // "Agent ready" is only claimed when tool calling was actually observed.
      return connection.capabilities?.toolCalling
        ? { label: `Agent ready · ${model}`, tone: 'ok', detail: 'Tool calling verified.' }
        : {
            label: `Connected · ${model}`,
            tone: 'warn',
            detail: 'Run the capability check in Settings to confirm tool calling.',
          };
    case 'limited':
      return {
        label: `Limited · ${model}`,
        tone: 'warn',
        detail: 'Some capabilities failed their check. See Settings.',
      };
    case 'failed':
      return {
        label: `Connection failed · ${model}`,
        tone: 'error',
        detail: 'The provider could not be reached. See Settings.',
      };
    case 'disconnected':
      return { label: 'Disconnected', tone: 'idle', detail: 'Reconnect in Settings.' };
  }
}
