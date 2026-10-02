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
  /** Security context for the outbound call. Without it the transport refuses. */
  egress?: EgressContext;
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
  readonly kind = 'api' as const;
  readonly authKind = 'api_key' as const;

  // A transport, not a `fetch`. The registry supplies a guarded one; the
  // default refuses every call, so there is no constructor path that yields
  // direct network access.
  constructor(private readonly transport: ProviderTransport = refusingTransport()) {}

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

The transport is the adapter's **only** route to the network. `globalThis.fetch`
is forbidden by lint in `src/providers/**`, and an adapter built without a
transport gets one that rejects every call. Every request — generation,
streaming, tool calling, vision, capability probes and every retry — therefore
passes the egress gate, because there is no other way out.

Pass `requireEgress(request)` from `@/providers/core/provider-http` as the
transport's third argument on task traffic, and `managementContext(...)` on
probes. A request with no context is refused rather than assumed clean.

### Rules

**Authentication uses only officially supported mechanisms.** Never read
cookies, extract a browser session token, scrape an undocumented endpoint, or
impersonate a first-party client. A consumer subscription is not API
entitlement, and the UI must not imply that it is.

**Do not mislabel an endpoint.** The OpenAI-compatible adapter reports itself
as "OpenAI-compatible endpoint" and identifies the connection by its host,
because the user may have pointed it at any compatible server.

**Refuse to send a key over plain HTTP.** `connect()` rejects a non-`https:`
base URL, with loopback excepted so a local model server or gateway works. The
rule is about a key crossing a network in the clear; loopback crosses none.

**Never put a credential in a URL.** The egress gate derives a destination
identity from the request URL, and that identity reaches consent keys, audit
records and evidence. A key in a query string would land in all three. Where a
provider documents a `key=` parameter as an alternative — Gemini does — the
adapter uses the header form instead and `connect()` refuses a base URL
carrying a query string at all.

**Errors must be normalised.** Three providers report the same failure in
three vocabularies — `invalid_request_error`, `RESOURCE_EXHAUSTED`, a bare HTTP 429. Classify into one of the categories in
`@/providers/core/provider-error` and throw `ProviderRequestError`. The runtime
detects it structurally, so the category, code and retry classification survive.

| Category                     | Code                | Retryable | Typical cause                    |
| ---------------------------- | ------------------- | --------- | -------------------------------- |
| `authentication_failed`      | `AUTH_EXPIRED`      | no        | key rejected                     |
| `access_denied`              | `PERMISSION_DENIED` | no        | key valid, not entitled          |
| `rate_limited`               | `RATE_LIMITED`      | yes       | 429                              |
| `transient_provider_failure` | `MODEL_ERROR`       | yes       | 5xx                              |
| `provider_unavailable`       | `NETWORK_ERROR`     | yes       | unreachable, timeout, overloaded |
| `invalid_request`            | `INVALID_ARGUMENT`  | no        | malformed request                |
| `unsupported_capability`     | `MODEL_UNSUPPORTED` | no        | model or route absent            |
| `capability_unverified`      | `MODEL_UNSUPPORTED` | no        | nothing has established it yet   |
| `malformed_response`         | `MODEL_ERROR`       | no        | 200 that did not parse           |
| `transport_blocked`          | `POLICY_BLOCKED`    | no        | the gate refused it              |

`unsupported_capability` and `capability_unverified` are separate for the same
reason. The first is a measurement — this model was asked and cannot. The second
is the _absence_ of a measurement, which is the honest answer for a model behind
a gateway this build has never heard of, and the user action differs: run the
capability doctor rather than pick another model. Collapsing the second into the
first is what made vision permanently unavailable through a gateway — the
adapter wrote the conservative `false`, the doctor skipped its probe because the
advertisement said `false`, and the one thing that could have corrected the
guess was gated on the guess. `ModelCapabilities.unverified` names the
capabilities whose boolean is a placeholder, and a capability therefore has
three states rather than two.

Two things this buys that a status-code table does not.

`authentication_failed` and `access_denied` are separate, because "your key is
wrong" and "your key is fine but not allowed here" send the user to different
fixes. Where a provider reports a type or status enum, prefer it over the HTTP
code — both Anthropic and Gemini report distinct conditions under one status.

`transient_provider_failure` and `malformed_response` share a code and differ
on retryability, which the code alone cannot express. That is why the runtime
calls `decideRetryFor(agentError, …)` rather than `decideRetry(code, …)`: the
category decides, the existing backoff is unchanged.

`transport_blocked` matters most. An adapter wraps its transport call in a
try/catch, so a refusal by the egress gate arrives looking like any other
thrown error. Reading it as a network fault would mark a policy decision
**retryable** and send the same refused request again. `toNetworkError` checks
for a refusal first, and blocked is terminal.

Keep the raw response body in `technicalDetails`, never in `userMessage` — it
can contain an echoed prompt.

**Advertise conservatively, and never downgrade silently.**
`getCapabilities()` reports what the protocol supports; the capability doctor
determines what the endpoint actually does. Never advertise a capability you
have not seen work — Anthropic reports `structuredOutput: false` because its
Messages API has no response-format field, even though a JSON reply can be
asked for in the prompt.

When a request asks for something the model does not have, refuse it. Call
`checkCapabilities(...)` from `@/providers/core/capability-guard` before
building the body and throw `unsupported_capability`. The failure this prevents
is the quiet one: a request carries a screenshot, the model cannot read images,
the adapter drops the image part, the provider answers, and the agent reasons
about a page it never saw. Nothing errored and the result is wrong in a way
nobody can trace.

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

| Check                | Method                                                 |
| -------------------- | ------------------------------------------------------ |
| Transport authorized | Did the request leave at all, or did the gate stop it? |
| Provider reachable   | Did something answer?                                  |
| Credentials accepted | Did it accept the key?                                 |
| Model availability   | `listModels()`; an empty list is _skipped_, not failed |
| Model discovery      | Whether the endpoint exposes a list at all             |
| Text generation      | A one-word prompt                                      |
| **Tool calling**     | A real probe function the model must call              |
| Streaming            | A short stream, if the adapter implements it           |
| Vision               | A 1×1 PNG, only if vision is advertised                |
| Structured output    | A JSON-only prompt, parsed                             |

The first three come from one probe and are reported separately because their
fixes differ. A single "connection failed" sends a user to check a key that was
fine, or to debug a network when the extension's own policy refused the call.

No credential is read to determine any of this. The doctor learns whether a key
works by using it.

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

## Which account actually runs

Switching is one half of the question. The other is: of the accounts
connected, which one serves the next request? That is the **AI brain**, chosen
by the user, and `resolveBrainAccount` in
`src/providers/accounts/resolve-brain.ts` is where the selection becomes a
request.

It is its own module because it holds five refusals, and each one is a
selection quietly not being honoured if it goes wrong:

| Refusal                   | When                                                        |
| ------------------------- | ----------------------------------------------------------- |
| `NO_MODEL_SELECTED`       | the account has no model chosen                             |
| `MODEL_STALE`             | the last discovery did not offer the selected model         |
| `NO_CREDENTIAL_ON_DEVICE` | no key is stored for this connection here                   |
| `CREDENTIAL_REJECTED`     | the provider refused the stored key                         |
| (no refusal, no claim)    | a measurement scoped to another account or model is dropped |

Two properties are worth knowing:

**The order of the checks is the control.** The two that need no secret come
first, so a selection that cannot be used stops _before_ a key is read. There
is no code path from a refused selection to a provider request, which is what
makes "never substitute" structural rather than intended.

**The adapter is reconnected on every resolution, never cached.** One adapter
instance per protocol is shared, so the previous call may have connected it as
a _different account_. Leaving the last account's credential in it is the
cross-account leak the whole `connectionId` model exists to prevent — and the
failure it produces is the right provider with the wrong account, which no
provider-level test can see.

`tests/integration/brain-routing.test.ts` and
`tests/e2e/multi-account.spec.ts` assert this on **the credential the endpoint
actually received**, with two accounts at one origin differing only in their
key. That is the only observation that tells the two apart.

## Registered providers

Four, all `kind: 'api'` and `authKind: 'api_key'`. Web providers are
foundation only and none is registered, so none is selectable.

| Provider            | Endpoint                           | Auth                              | Base URL |
| ------------------- | ---------------------------------- | --------------------------------- | -------- |
| `openai-compatible` | `POST /chat/completions`           | `Authorization: Bearer`           | required |
| `anthropic`         | `POST /v1/messages`                | `x-api-key` + `anthropic-version` | optional |
| `gemini`            | `POST /models/{m}:generateContent` | `x-goog-api-key`                  | optional |
| `nine-router`       | `POST /chat/completions`           | `Authorization: Bearer`           | required |

`nine-router` extends the Chat Completions adapter rather than duplicating it:
only `listModels`, the identity and the capability floor are overridden, so
there is no second network path.

### One adapter per protocol, and the cost that fell on the user

`openai-compatible` is not "OpenAI". Kimi (Moonshot), DeepSeek, Groq,
OpenRouter, Mistral, xAI, Together and a local Ollama or LM Studio all speak
it. An adapter per vendor is the architecture this project rejected, and that
is still right.

What it meant in practice is that somebody holding a Kimi key had to know
Moonshot speaks the OpenAI protocol, choose a provider called
"OpenAI-compatible", and type `https://api.moonshot.ai/v1` from memory. The
capability existed and the connection was not discoverable, which for the
person holding the key is the same as not having it.

`src/providers/registry/known-endpoints.ts` closes that with **defaults and
nothing else**: ten named endpoints that prefill the editable Base URL field.
No new adapter, no new permission, no credential, no client id, and no model id
— models are discovered from the endpoint, and a default here would be a claim
about somebody else's catalogue that this file could not keep true.

Every entry is held to what the build will accept, by test: the registry must
know its `providerId`, and the adapter's own `connect` must take its URL. So an
entry this build would refuse fails a test rather than a user who has just
pasted a key. The https rule is the adapter's and is asserted in both
directions — _"API keys are only sent over https. Use an https endpoint, or
localhost for a local model server."_

The two Moonshot regions are separate entries on purpose: `.ai` and `.cn` are
different accounts and the keys are not interchangeable, so one entry telling
the user to edit the host would silently fail for half of them.

### They are not three dialects of one protocol

The differences below are why each has its own adapter rather than a shared one
with flags. Flattening any of them loses information silently.

| Concern       | OpenAI-compatible                  | Anthropic                                   | Gemini                                       |
| ------------- | ---------------------------------- | ------------------------------------------- | -------------------------------------------- |
| System prompt | a message with role `system`       | top-level `system` field                    | `systemInstruction`, a `Content` of its own  |
| Assistant     | role `assistant`                   | role `assistant`                            | role **`model`**                             |
| Content       | string, or typed parts             | always typed blocks                         | `parts`                                      |
| Tool call     | `tool_calls[]` beside the message  | a `tool_use` block inside the message       | a `functionCall` part                        |
| Tool result   | a message with role `tool`         | a `tool_result` block in a **user** message | a `functionResponse` part, `response` object |
| Tool call id  | provider-supplied                  | provider-supplied                           | **none — correlated by name**                |
| Tool schema   | `function.parameters`              | `input_schema`                              | `functionDeclarations[].parameters`          |
| Images        | a `data:` URL                      | `source: { type: 'base64', media_type }`    | `inlineData`                                 |
| Streaming     | indexed tool-call deltas, `[DONE]` | typed events, `input_json_delta` fragments  | repeated envelopes, `alt=sse`, no sentinel   |
| Max tokens    | optional                           | **required**, no server default             | optional, under `generationConfig`           |

Two consequences are worth stating outright.

Gemini has no tool call ids, and the canonical model requires one so a result
can be attributed to the call that produced it. The adapter synthesises
`fc_{index}_{name}` on the way out and sends the **name** back in
`functionResponse` — the one place the canonical model carries more than the
provider does.

Anthropic and Gemini both merge consecutive same-role turns, because both APIs
expect an alternating conversation and the runtime can legitimately produce two
user turns in a row.

## Conformance suite

`tests/security/provider-conformance.test.ts` asks 21 questions of **every**
registered API factory: identity, kind, auth kind, request generation, response
parsing, text, streaming, tool calling, repeated calls, vision, invalid
credentials, access denied, rate limiting, unsupported capability, transport
injection, blocked transport, provider/model switch, retry re-entering
authorization, no direct network path, malformed response, and error
normalisation.

The questions are shared; the expectations are not. Each provider's wire pack
in `tests/fixtures/provider-wire.ts` translates, so a provider that quietly
started speaking someone else's dialect fails rather than passing by
resembling the others. The suite also cross-checks the pack list against the
registry, so adding a provider without adding a pack fails the build rather
than leaving it untested.

`tests/e2e/provider-switching.spec.ts` runs all three against local servers
speaking their real protocols, inside real Chromium — **real browser, mocked
provider transport**. No commercial endpoint has been exercised; see
[PARITY_MATRIX.md](../PARITY_MATRIX.md).
