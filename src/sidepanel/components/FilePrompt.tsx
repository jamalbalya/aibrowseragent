import { useRef } from 'react';
import type { FileSelectionRequest } from '@/background/file-broker';
import { MAX_FILE_BYTES, formatBytes } from '@/files/file-model';

interface FilePromptProps {
  readonly request: FileSelectionRequest;
  readonly onRespond: (requestId: string, files: readonly File[] | null) => void;
}

/**
 * The file picker prompt.
 *
 * This component is the entire local-file capability. The extension has no
 * filesystem access and asks for none; the only way a file reaches a task is
 * a person pressing this button and choosing one, in the browser's own
 * picker, under their own gesture.
 *
 * The request carries a purpose and no path, so there is nothing here that
 * could pre-fill a filename. The model says why it wants a file; the user
 * decides what that is, or declines.
 *
 * `purpose` is model output and is rendered as text. It is never interpreted,
 * and it is shown next to the destination so a plausible-sounding reason can
 * still be checked against where the file would actually go.
 */
export function FilePrompt({ request, onRespond }: FilePromptProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <section className="prompt prompt--elevated">
      <header className="prompt__header">
        <h2 className="prompt__title">A file is needed</h2>
      </header>

      <p className="prompt__reason">{request.purpose}</p>

      <dl className="prompt__details">
        {request.destinationOrigin ? (
          <div>
            <dt>Will be sent to</dt>
            <dd>{request.destinationOrigin}</dd>
          </div>
        ) : null}
        <div>
          <dt>Limit</dt>
          <dd>{formatBytes(MAX_FILE_BYTES)} per file</dd>
        </div>
      </dl>

      <p className="prompt__note">
        The agent cannot browse your computer and cannot name a file for you. Only what you choose
        here is read.
      </p>

      <input
        ref={inputRef}
        type="file"
        className="prompt__file-input"
        multiple={request.multiple}
        {...(request.accept ? { accept: request.accept } : {})}
        onChange={(event) => {
          const chosen = event.target.files;
          onRespond(request.id, chosen && chosen.length > 0 ? [...chosen] : null);
        }}
      />

      <div className="prompt__actions">
        <button
          type="button"
          className="button button--primary"
          onClick={() => inputRef.current?.click()}
        >
          Choose {request.multiple ? 'files' : 'a file'}…
        </button>
        <button type="button" className="button" onClick={() => onRespond(request.id, null)}>
          Don’t send a file
        </button>
      </div>
    </section>
  );
}
