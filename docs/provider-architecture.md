# Provider architecture

## The rule

The agent runtime contains no provider-specific code. It calls
`provider.generate(request)` and receives a `CanonicalResponse`. Everything
between that call and an HTTP request lives in an adapter.

If the runtime ever needs to know _which_ provider it is talking to, the
abstraction has leaked and the invariant is broken.

## Canonical format

Defined in `src/providers/core/types.ts`. This is the vocabulary the runtime
speaks; adapters translate it to and from the wire.

```ts
interface CanonicalRequest {
  systemInstruction: string;
  messages: readonly CanonicalMessage[];
  tools?: readonly CanonicalToolSchema[];
  toolChoice?: 'auto' | 'none' | 'required';
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

interface CanonicalResponse {
  text: string;
  toolCalls: readonly CanonicalToolCall[];
  finishReason: 'stop' | 'tool_call' | 'length' | 'content_filter' | 'cancelled' | 'error';
  usage: { promptTokens: number; completionTokens: number };
  providerMetadata?: Record<string, unknown>;
}
```

Content parts are `text`, `image`, `tool_call` and `tool_result`. Anything a
provider offers beyond this belongs in `providerMetadata`, which the runtime
never interprets.

## Tool name translation

Canonical tool names use dots (`browser.read_page`). Most providers require
identifier-safe function names, so the registry emits `browser_read_page` and
converts back on the way in (`toWireName` / `fromWireName`).

`fromWireName` restores only the **first** separator, so
`tabs_wait_for_navigation` correctly becomes `tabs.wait_for_navigation`.

## Writing an adapter

```ts
export class MyAdapter implements AIProviderAdapter {
  readonly id = 'my-provider';
  readonly displayName = 'My Provider';
  readonly authKind = 'api_key' as const;

  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  connect(config: ProviderConfig): Promise<AuthResult> {
    /* validate, store */
  }
  disconnect(): Promise<void> {
    /* clear */
  }
  listModels(): Promise<ModelInfo[]> {
    /* [] is acceptable */
  }
  getCapabilities(model: string): Promise<ModelCapabilities> {
    /* advertised only */
  }
  validateConnection(): Promise<HealthResult> {
    /* cheap reachability probe */
  }
  generate(request: CanonicalRequest): Promise<CanonicalResponse> {
    /* translate */
  }
  stream?(request: CanonicalRequest): AsyncIterable<CanonicalEvent> {
    /* optional */
  }
}
```

`fetch` is injected so the adapter is testable without a network.

### Rules

**Authentication uses only officially supported mechanisms.** Never read
cookies, extract a browser session token, scrape an undocumented endpoint, or
impersonate a first-party client. A consumer subscription is not API
entitlement, and the UI must not imply that it is.

**Do not mislabel an endpoint.** The OpenAI-compatible adapter reports itself
as "OpenAI-compatible endpoint" and identifies the connection by its host,
because the user may have pointed it at any compatible server.

**Refuse to send a key over plain HTTP.** `connect()` rejects a non-`https:`
base URL, with localhost excepted so local model servers work.

**Errors must be structured.** Throw `ProviderRequestError` from
`@/providers/core/provider-error` carrying an `AgentError` with a canonical
code. The runtime detects this structurally, so the code and its retry
classification survive:

| Status    | Code                | Retryable |
| --------- | ------------------- | --------- |
| 401, 403  | `AUTH_EXPIRED`      | no        |
| 404       | `MODEL_UNSUPPORTED` | no        |
| 429       | `RATE_LIMITED`      | yes       |
| 5xx       | `MODEL_ERROR`       | yes       |
| 4xx other | `MODEL_ERROR`       | no        |
| network   | `NETWORK_ERROR`     | yes       |

Keep the raw response body in `technicalDetails`, never in `userMessage` — it
can contain an echoed prompt.

**Advertise conservatively.** `getCapabilities()` reports what the protocol
supports; the capability doctor determines what the endpoint actually does.
Never advertise a capability you have not seen work.

**Malformed tool arguments are reported, not thrown.** Set `parseError` on the
tool call. The runtime turns it into a `TOOL_CALL_INVALID` the model can see
and correct, which is more useful than an exception.

### Streaming

Optional. Yield `text_delta`, `tool_call`, `usage`, then `done` with the
assembled response. Yield an `error` event rather than throwing — a throw
mid-iteration is awkward for callers to handle cleanly.

Tool call fragments arrive keyed by `index`, with the name in the first
fragment and arguments split arbitrarily across later ones.
`StreamAccumulator` in the OpenAI-compatible adapter shows the reassembly.

## Capability doctor

`CapabilityDoctor` exercises a model and reports what it observed:

| Check                         | Method                                                 |
| ----------------------------- | ------------------------------------------------------ |
| Authentication + reachability | `validateConnection()`                                 |
| Model availability            | `listModels()`; an empty list is _skipped_, not failed |
| Text generation               | A one-word prompt                                      |
| **Tool calling**              | A real probe function the model must call              |
| Streaming                     | A short stream, if the adapter implements it           |
| Vision                        | A 1×1 PNG, only if vision is advertised                |
| Structured output             | A JSON-only prompt, parsed                             |

Verdicts:

- **AGENT_READY** — tool calling verified. Only this enables task execution.
- **CONNECTED_LIMITED** — connected, capabilities unverified (quick mode).
- **CHAT_ONLY** — generates text but did not call the probe. Cannot run tasks.
- **FAILED** — unreachable, or produced no text.

Once the connection check fails, nothing downstream is claimed — every
capability is reported false rather than guessed.

## Provider switching

Switching is explicit and visible. There is **no automatic fallback**: if the
configured provider fails, the failure is surfaced.

Silent substitution would change a running task's characteristics without the
user knowing, and the task's tool availability and cost profile with it.

Switching affects the reasoning engine only. Browser tools, tab tools, debugger
tools, task state, security policy, permission model, evidence and connectors
are unchanged by construction — they never referenced the provider.

## Roadmap

`openai-compatible` is implemented. Native adapters for Anthropic, Gemini and
OpenAI's Responses API are not, and are listed as NOT_STARTED in
[PARITY_MATRIX.md](../PARITY_MATRIX.md) rather than claimed.

Any OpenAI-compatible gateway works today, which covers most deployments
without an adapter per vendor.
