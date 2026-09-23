import { useCallback, useEffect, useRef, useState } from 'react';
import { sendToBackground } from '@/messaging/bus';
import type { ImportOutcome } from '@/storage/data-export';

/**
 * Where your data lives, and how to take a copy of it.
 *
 * The copy here is doing real work, so it is worth saying what it is for.
 * This extension stores everything on this computer by default — no account,
 * no server, nothing uploaded. That is good for privacy and it has one honest
 * cost: if this Chrome profile is deleted, the data goes with it. The export
 * button is what makes that cost avoidable, and the panel says so plainly
 * instead of implying a safety net that does not exist.
 *
 * No word on this panel is a database word. "Storage", "export" and "import"
 * are things a person does; migrations, schemas and servers are not, and none
 * of them is ever shown to anyone using this extension.
 */

interface Preference {
  readonly mode: 'local' | 'cloud';
  readonly hasChosen: boolean;
}

type Busy = 'idle' | 'exporting' | 'importing';

export function DataPanel(): React.JSX.Element {
  const [preference, setPreference] = useState<Preference | null>(null);
  const [busy, setBusy] = useState<Busy>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setPreference(await sendToBackground('storage.getPreference', {}));
    } catch {
      setPreference(null);
    }
  }, []);

  useEffect(() => {
    // The first read of the storage preference. Same pattern as the
    // neighbouring panels: the load is asynchronous, so the state it produces
    // necessarily lands after the effect runs.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  /**
   * Writes the export to a file the user picks.
   *
   * A download, not an upload. The blob is built in this page from this
   * extension's own data and handed to Chrome's downloader; nothing here
   * reaches the network, and no automatic path calls this.
   */
  const exportData = useCallback(async () => {
    setBusy('exporting');
    setMessage(null);
    try {
      const { export: document_ } = await sendToBackground('data.export', {});
      const blob = new Blob([JSON.stringify(document_, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const stamp = new Date(document_.exportedAt).toISOString().slice(0, 10);
      link.download = `ai-browser-agent-${stamp}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setMessage('Saved. Keep the file somewhere safe — it has no keys or credentials in it.');
    } catch {
      setMessage('The export could not be created.');
    } finally {
      setBusy('idle');
    }
  }, []);

  const importData = useCallback(
    async (file: File) => {
      setBusy('importing');
      setMessage(null);
      try {
        // Parsed here only so the worker receives structured data; every
        // decision about whether it is acceptable is made there, against the
        // same stores and validators a normal save goes through.
        const parsed: unknown = JSON.parse(await file.text());
        const result = await sendToBackground('data.import', { document: parsed });
        setMessage(result.ok ? describeOutcome(result.outcome) : result.detail);
        await refresh();
      } catch {
        setMessage('That file could not be read.');
      } finally {
        setBusy('idle');
      }
    },
    [refresh],
  );

  return (
    <section className="settings__section" aria-label="Your data">
      <h3>Your data</h3>

      <p className="field__hint" data-testid="storage-mode">
        {preference?.mode === 'cloud'
          ? 'Your work is set to sync to your AI Browser Agent account.'
          : 'Your tasks, workflows, shortcuts and settings are stored on this device. No account is needed.'}
      </p>

      {/* The line that is easy to get wrong, so it is drawn where it really
          is. "Nothing leaves this device" would be comfortable and false: an
          AI request has to reach whichever service the user connected. What
          is true is that it goes there directly, and nowhere else. */}
      <p className="field__hint" data-testid="storage-traffic">
        Your AI requests go directly to the AI service you connect, along with whatever that request
        needs from the page. Nothing else is sent anywhere.
      </p>

      <p className="field__hint">
        Because it is stored here, deleting this Chrome profile would delete it. Save a copy if you
        would mind losing your workflows and shortcuts.
      </p>

      <div className="settings__actions">
        <button
          type="button"
          className="button"
          data-testid="data-export"
          onClick={() => void exportData()}
          disabled={busy !== 'idle'}
        >
          {busy === 'exporting' ? 'Saving…' : 'Save a copy'}
        </button>
        <button
          type="button"
          className="button"
          data-testid="data-import"
          onClick={() => fileInput.current?.click()}
          disabled={busy !== 'idle'}
        >
          {busy === 'importing' ? 'Restoring…' : 'Restore from a copy'}
        </button>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        className="visually-hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so choosing the same file twice still fires a change.
          event.target.value = '';
          if (file) void importData(file);
        }}
      />

      <p className="field__hint" data-testid="data-copy-contents">
        A saved copy contains your workflows, shortcuts and the connections you set up. It
        deliberately leaves out your AI account keys and any private connection credentials, so
        after restoring on another device you will enter those again.
      </p>

      {message ? (
        <p className="field__hint" data-testid="data-message">
          {message}
        </p>
      ) : null}
    </section>
  );
}

function describeOutcome(outcome: ImportOutcome): string {
  const parts: string[] = [
    `Restored ${outcome.workflowsImported} workflow${outcome.workflowsImported === 1 ? '' : 's'}`,
    `${outcome.shortcutsImported} shortcut${outcome.shortcutsImported === 1 ? '' : 's'}`,
  ];
  const refused = outcome.workflowsRefused + outcome.shortcutsRefused;
  // Said out loud rather than rounded away. A count that quietly dropped the
  // refusals would read as a complete restore.
  if (refused > 0) parts.push(`${refused} could not be restored from the file`);
  // Kept separate from the line above, because they are different problems
  // with different answers. A refused record is something about the file; a
  // failed write is something about this device, and telling somebody their
  // data was rejected when the disk is full sends them to fix the wrong
  // thing.
  if (outcome.failed > 0) {
    parts.push(
      `${outcome.failed} could not be saved on this device — there may not be enough space`,
    );
  }
  if (outcome.connectionsNeedingKeys > 0) {
    parts.push(
      `${outcome.connectionsNeedingKeys} AI connection${
        outcome.connectionsNeedingKeys === 1 ? '' : 's'
      } need their API key entered again`,
    );
  }
  return `${parts.join(', ')}.`;
}
