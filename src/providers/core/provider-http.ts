/**
 * HTTP plumbing shared by every API provider adapter.
 *
 * Three adapters speak three wire formats over one transport, and the parts
 * that are genuinely identical — reading an SSE body, classifying a dropped
 * connection, refusing a request that carries no security context — live here
 * so there is one implementation to audit rather than three to keep in step.
 *
 * What does *not* live here is translation. Status-code meaning, error body
 * shape and retry hints differ per provider, so each adapter supplies its own
 * reading of a failure and this module only provides the scaffolding.
 *
 * Nothing in this file performs I/O of its own: there is no `fetch`, and the
 * only way out remains the transport the registry injected.
 */
import { redact, REDACTED } from '@/security/redaction/secret-redactor';
import { MAX_MODEL_ID, serialisedWidth } from '@/audit/boundaries';
import { getLogger } from '@/logging/logger';
import { delayFromRetryAfter } from '@/agent/recovery/retry-policy';
import {
  ProviderRequestError,
  providerFailure,
  type ProviderErrorCategory,
  type ProviderFailure,
} from './provider-error';
import type { CanonicalRequest } from './types';
import { isTransportRefusal, type EgressContext } from '@/security/egress/provider-transport';

const log = getLogger('provider');

/**
 * Pulls the security context off a request, refusing when it is absent.
 *
 * A request with no context cannot be authorised, and guessing one — or
 * treating "no context" as "nothing sensitive" — is the fail-open this whole
 * mechanism exists to remove.
 */
export function requireEgress(request: CanonicalRequest): EgressContext {
  if (!request.egress) {
    throw new Error('This provider request carries no egress context, so it cannot be authorised.');
  }
  return request.egress;
}

export function toThrowable(failure: ProviderFailure): ProviderRequestError {
  return new ProviderRequestError(failure);
}

/**
 * Classifies a failure that happened before any status code existed.
 *
 * The first case is the one that matters most. An adapter wraps its transport
 * call in a try/catch, so a refusal by the egress gate arrives here looking
 * like any other thrown error — and reading it as "could not reach the
 * provider" would report a policy decision as a transient network fault, and
 * mark it **retryable**. The runtime would then send the same refused request
 * again, several times, against a gate that will never say yes. So a refusal
 * is classified as blocked, and blocked is terminal.
 *
 * After that, cancellation is separated from a timeout and both from an
 * unreachable host, because only the last two are worth another attempt and
 * the first is a decision the user already made.
 */
export function toNetworkError(
  providerId: string,
  error: unknown,
  endpoint: string,
): ProviderFailure {
  if (isTransportRefusal(error)) {
    return providerFailure(providerId, 'transport_blocked', error.message, {
      providerCode: error.name,
      userMessage:
        'This request was not permitted to leave the browser. It was refused before anything ' +
        'was sent.',
      technicalDetails: endpoint,
    });
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return {
      category: 'invalid_request',
      providerId,
      error: {
        code: 'USER_CANCELLED',
        message: 'The request was cancelled.',
        userMessage: 'The request was cancelled.',
        recoverable: true,
        retryable: false,
      },
    };
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return providerFailure(
      providerId,
      'provider_unavailable',
      'The request to the provider timed out.',
      {
        userMessage: 'The provider did not respond in time.',
        technicalDetails: endpoint,
      },
    );
  }
  return providerFailure(providerId, 'provider_unavailable', 'Could not reach the provider.', {
    userMessage: 'Could not reach the provider. Check the endpoint and your network connection.',
    technicalDetails: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Reads an error body without letting the read itself become a failure, and
 * without letting the provider hand us back our own credential.
 *
 * Truncated because the body is a provider diagnostic of unbounded length. It
 * ends up in `technicalDetails`, which is written to logs **and persisted on
 * the task record, where the panel reads it** — so what a provider chooses to
 * put in an error body becomes something this extension stores and displays.
 *
 * Providers really do echo the key. OpenAI's 401 reads `Incorrect API key
 * provided: sk-…`, and a self-hosted gateway may echo it in full. Measured:
 * before this, a 401 body containing the key produced a stored task record
 * containing the key.
 *
 * Two lines of defence, and the first is the one that matters:
 *
 *  - **The exact credential in use is removed.** `secret` is the key this
 *    request was actually made with, so the match is exact and works for any
 *    format — including a custom gateway key that no pattern could recognise.
 *  - **Then the shape-based rules run**, for a secret this call does not hold:
 *    another account's key quoted by a shared gateway, a bearer token, a
 *    connection string.
 *
 * Shape rules alone are not enough, which is why the credential is threaded
 * down here rather than left to the redactor: `test-key-abcdefghijklmnop`
 * matches nothing, and is a perfectly ordinary gateway key.
 */
export async function readErrorBody(
  response: Response,
  options: { readonly limit?: number; readonly secret?: string | undefined } = {},
): Promise<string> {
  const limit = options.limit ?? 500;
  try {
    const raw = (await response.text()).slice(0, limit);
    return redact(withoutSecret(raw, options.secret));
  } catch {
    return '';
  }
}

/** Exact removal of a known credential. Nothing clever: split and rejoin. */
function withoutSecret(text: string, secret: string | undefined): string {
  // A very short "secret" would match everywhere and redact the whole message
  // into uselessness, so it is left to the shape rules instead.
  if (secret === undefined || secret.length < 8) return text;
  return text.split(secret).join(REDACTED);
}

/**
 * The default reading of an HTTP status.
 *
 * Providers override individual codes where their documented meaning differs
 * — Anthropic's 529, Gemini's 400 for a bad key — so this is the floor, not
 * the whole mapping.
 */
export function categoryForStatus(status: number): ProviderErrorCategory {
  if (status === 401) return 'authentication_failed';
  if (status === 403) return 'access_denied';
  if (status === 404) return 'unsupported_capability';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'transient_provider_failure';
  return 'invalid_request';
}

/** `Retry-After`, in milliseconds, when the provider sent one. */
export function retryAfterMs(response: Response): number | undefined {
  const parsed = delayFromRetryAfter(response.headers.get('retry-after'));
  return parsed === null ? undefined : parsed;
}

/**
 * Yields the `data:` payload of each SSE frame.
 *
 * Event names are deliberately not surfaced. Every provider this codebase
 * speaks to puts a discriminator inside the JSON payload, so parsing on the
 * payload keeps one reader correct for all of them; a reader that dispatched
 * on the `event:` line would be right for Anthropic and wrong for the others.
 */
export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line; \r\n is tolerated.
      let separator = findFrameEnd(buffer);
      while (separator !== -1) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);
        const payload = extractData(frame);
        if (payload !== null) yield payload;
        separator = findFrameEnd(buffer);
      }
    }
    const trailing = extractData(buffer);
    if (trailing !== null) yield trailing;
  } finally {
    reader.releaseLock();
  }
}

function findFrameEnd(buffer: string): { index: number; length: number } | -1 {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return -1;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function extractData(frame: string): string | null {
  const lines = frame.split(/\r?\n/);
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  return data.length > 0 ? data : null;
}

/**
 * Parses a JSON body, reporting a malformed reply as such.
 *
 * A provider that answers 200 with something that is not the documented shape
 * is a different failure from one that answers 500, and conflating them would
 * make the first look retryable.
 */
export async function parseJsonBody<T>(providerId: string, response: Response): Promise<T> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw toThrowable(
      providerFailure(
        providerId,
        'malformed_response',
        'The provider response could not be read.',
        {
          technicalDetails: error instanceof Error ? error.message : String(error),
        },
      ),
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw toThrowable(
      providerFailure(
        providerId,
        'malformed_response',
        'The provider returned a body that was not JSON.',
        {
          userMessage: 'The provider replied with something this extension could not read.',
          // Same reasoning as `readErrorBody`: this is a provider-authored
          // string that ends up stored on a task record.
          technicalDetails: redact(text.slice(0, 200)),
        },
      ),
    );
  }
}

/**
 * Whether a model identifier can be carried by the records that mention it.
 *
 * A model id is an external string: it comes from whatever the endpoint's model
 * list says, and routed endpoints name models freely. Nothing bounded it, and
 * `egress.decided` carries it in a field bounded at `MAX_MODEL_ID` — so a model
 * id past that limit meant every request made with that model produced a refused
 * record. The request went out, the decision stood, and the trail lost it.
 *
 * Unlike a filename or an origin there is no external standard to derive a
 * larger bound from, so the trail's limit is the authoritative one and a model
 * that cannot fit it is not offered. `admitModelIds` drops such entries from a
 * discovered list and says how many it dropped, which is the same shape
 * `admitListing` uses for MCP tools.
 */
export function isRecordableModelId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length === 0) return false;
  // The *serialised* width, because that is what the record it has to fit is
  // measured in. An id of 256 quote characters is 256 code units and 512
  // characters once written into a record, and an id of 256 control
  // characters is 1536 — so a check on `length` admitted ids that no record
  // could carry, and every request made with one lost its trail. This is the
  // same bound the audit field applies, asked the same way, which is what
  // makes admitting an id a promise that it can be recorded.
  return serialisedWidth(id) <= MAX_MODEL_ID;
}

/**
 * Keeps the models a record can name, and reports the rest.
 *
 * Refused rather than truncated: two model ids sharing a truncated form would
 * become one model, and the pin that decides whether a task's brain changed
 * compares model ids.
 */
export function admitModelIds<T extends { readonly id: string }>(
  providerId: string,
  models: readonly T[],
): T[] {
  const admitted = models.filter((model) => isRecordableModelId(model.id));
  const refused = models.length - admitted.length;
  if (refused > 0) {
    log.warn(
      'Some models this endpoint offers cannot be named in a record, so they were left out.',
      {
        providerId,
        refused,
        limit: MAX_MODEL_ID,
      },
    );
  }
  return admitted;
}
