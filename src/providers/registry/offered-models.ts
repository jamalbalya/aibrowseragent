/**
 * What a discovery offered, remembered so a *selection* can be checked.
 *
 * ## The gap this closes
 *
 * `accountAfterSelection` clears a connection's stale marker, on the stated
 * grounds that "the user picked from a list this build had just discovered".
 * That is true of the dropdown and false of the text box beside it:
 * `SettingsView` falls back to a free-text input whenever the filtered model
 * list is empty, so an id can reach the selection routes without ever having
 * appeared in a catalogue. Clearing the marker for one of those asserts a
 * freshness nobody established, and the runtime then has no reason to refuse it.
 *
 * ## Why that matters more for a gateway
 *
 * Verified against a running 9Router 0.5.91, from its source and by observation:
 *
 *  - `prefix/model` — the provider is the prefix, matched against a configured
 *    connection or a built-in provider id. An unknown prefix **fails loudly**:
 *    `404 No active credentials for provider: <prefix>`, quoting the prefix
 *    verbatim. There is no fallback on this path.
 *  - a slash-less id the gateway recognises as a combination — that combination
 *    runs.
 *  - a slash-less id it does **not** recognise — it is matched against a table
 *    of name patterns (`/^claude-/`, `/^gemini-/`, `/^gpt-/`, `/^o[134]/`,
 *    `/^deepseek-/`) and then **defaults to `openai`**. Observed:
 *    `gpt-5.6-terra` and `totally-unknown-xyzzy-model` both resolved to
 *    `openai`, `claude-sonnet-4` to `anthropic`.
 *
 * So an unrecognised slash-less id is the one shape the gateway answers by
 * choosing an upstream itself. On an installation with no such provider
 * connected that surfaces as a 404; on one where it is connected, and happens
 * to offer a model of that name, the request is served by an upstream nobody
 * selected.
 *
 * The extension cannot detect that afterwards. The gateway returns no provider
 * identity in any header or body field, and the `model` it echoes is the bare
 * name with the prefix stripped — which cannot distinguish two upstreams
 * offering the same name. The only available defence is not to send an id that
 * was never offered, and that is all this does.
 *
 * ## What it deliberately does not do
 *
 * It does not reject a selection. Configuring a model before the endpoint is up
 * is legitimate, and for the generic OpenAI-compatible entry a typed id is the
 * ordinary workflow — some endpoints expose no model list at all. It refuses
 * only to *assert* a freshness that was not established, and leaves the
 * existing stale machinery to do the refusing at request time.
 *
 * It also holds no opinion about model ids. Nothing here parses one, splits one,
 * or reads a prefix: the only operation is exact membership, via
 * `modelSelectionState`.
 */
import { modelSelectionState } from './model-selection';

/**
 * Whether a model being selected is one a discovery actually offered.
 *
 * `unknown` is not a failure. It means no discovery has succeeded for this
 * connection in this worker lifetime, so there is nothing to compare against —
 * and an endpoint that has never answered a discovery cannot serve a request
 * either, which is why asserting nothing is safe there.
 */
export type OfferedVerdict = 'offered' | 'not-offered' | 'unknown';

export class OfferedModels {
  /**
   * Keyed per connection, because two accounts of one provider can front
   * different gateways with different catalogues.
   */
  private readonly ids = new Map<string, readonly string[]>();

  private key(providerId: string, connectionId?: string): string {
    return connectionId === undefined ? `prov:${providerId}` : `conn:${connectionId}`;
  }

  /**
   * Remembers what a discovery returned.
   *
   * An empty list is **not** recorded. A failed discovery returns empty through
   * the same path as a provider that genuinely offers nothing, and recording it
   * would turn "could not ask" into "offers nothing" — which would then mark
   * every subsequent selection as never-offered.
   */
  record(providerId: string, connectionId: string | undefined, ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.ids.set(this.key(providerId, connectionId), [...ids]);
  }

  wasOffered(modelId: string, providerId: string, connectionId?: string): OfferedVerdict {
    const known = this.ids.get(this.key(providerId, connectionId));
    const state = modelSelectionState(modelId, known ?? [], known !== undefined);
    if (state.kind === 'valid') return 'offered';
    if (state.kind === 'stale') return 'not-offered';
    return 'unknown';
  }

  /** Dropped when a connection goes away, so its catalogue cannot outlive it. */
  forget(connectionId: string): void {
    this.ids.delete(this.key('', connectionId));
  }
}
