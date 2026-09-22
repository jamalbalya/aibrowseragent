# §87 — Provider acceptance tests

> For every provider: connect, validate, list models, text generation,
> streaming, tool calling, multiple tool calls, vision, invalid credentials,
> expired auth, rate limit, unsupported capability.

Twelve items across three providers. Read [README.md](README.md) first.

**The distinction that governs this whole package:** every item is covered
against a local server implementing the provider's documented wire format over
real HTTP — real sockets, real headers, real CORS, real SSE framing — and
none is covered against the vendor's own endpoint, because this repository
holds no credentials and fabricates none. A local server answers exactly what
it was told to, so it proves the adapter reads and writes the format
correctly and proves nothing about the vendor honouring its own
documentation. Each item below states which of the two it has.

The three providers are OpenAI-compatible, Anthropic and Gemini
(`src/providers/adapters/`). There is no web provider; §24B's Web AI
inference is gated and is not in this package.

---

## Connect

**Verdict: `AUTOMATED` against a local endpoint. `MANUAL` against a vendor.**

- EVIDENCE: tests/e2e/provider-integration.spec.ts :: connect performs a real reachability probe against the endpoint
- EVIDENCE: tests/e2e/provider-switching.spec.ts :: the registry offers all three API providers and no web provider
- EVIDENCE: tests/e2e/provider-switching.spec.ts :: a provider with its own endpoint does not demand one, and one without it does
- EVIDENCE: tests/unit/openai-compatible.test.ts :: refuses a non-https base URL so a key is never sent in the clear
- EVIDENCE: tests/unit/openai-compatible.test.ts :: throws when used before connecting rather than guessing a default

Connecting is a real probe rather than a stored flag: the adapter reaches the
endpoint and reports what it observed. A build that accepted any key and
called itself connected would fail the first citation.

---

## Validate

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/e2e/provider-integration.spec.ts :: the capability doctor exercises the endpoint and reports what it observed
- EVIDENCE: tests/unit/capability-doctor.test.ts :: reports AGENT_READY only when tool calling actually worked
- EVIDENCE: tests/unit/capability-doctor.test.ts :: refuses to claim AGENT_READY on unverified capabilities
- EVIDENCE: tests/unit/capability-doctor.test.ts :: separates "could not reach" from "key rejected" from "not authorized"
- EVIDENCE: tests/unit/capability-doctor.test.ts :: never puts credential material in a report

The doctor's discipline is the point: `AGENT_READY` is reported only when a
tool call actually round-tripped, never because a model's name looks capable.
Three failure causes that a lesser implementation would collapse into "failed"
are kept apart, because the user's next action differs in each case.

---

## List models

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/unit/capability-doctor.test.ts :: reports model discovery separately from the model existing
- EVIDENCE: tests/unit/capability-doctor.test.ts :: fails the model check when the id is not in the reported list
- EVIDENCE: tests/unit/capability-doctor.test.ts :: skips the model check when the endpoint exposes no model list

Not every compatible endpoint exposes a model list. Skipping that check is
recorded as skipped rather than passed, which is the difference between "we
looked and it was fine" and "we could not look".

---

## Text generation

**Verdict: `AUTOMATED` against local servers implementing each wire format.**

- EVIDENCE: tests/e2e/provider-switching.spec.ts :: the Anthropic adapter completes a real round trip over sockets
- EVIDENCE: tests/e2e/provider-switching.spec.ts :: the Gemini adapter completes a real round trip and sends no key in a URL
- EVIDENCE: tests/unit/openai-compatible.test.ts :: sends the system instruction and messages in the wire format
- EVIDENCE: tests/unit/anthropic.test.ts :: places the system prompt in the top-level field, not in a message
- EVIDENCE: tests/unit/gemini.test.ts :: sends the key as a header and never in a URL

Each provider's own shape is asserted rather than assumed shared: Anthropic's
top-level system field and Gemini's header-borne key are exactly the places a
translated-from-OpenAI adapter goes wrong, and a key in a URL would end up in
logs and referrers.

---

## Streaming

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/unit/openai-compatible.test.ts :: reassembles text deltas and tool call fragments
- EVIDENCE: tests/unit/openai-compatible.test.ts :: handles a frame split across chunk boundaries
- EVIDENCE: tests/unit/openai-compatible.test.ts :: handles CRLF frame separators
- EVIDENCE: tests/unit/openai-compatible.test.ts :: emits a trailing frame that was not terminated by a blank line
- EVIDENCE: tests/unit/openai-compatible.test.ts :: skips a malformed frame instead of killing the stream
- EVIDENCE: tests/unit/openai-compatible.test.ts :: yields an error event instead of throwing on an HTTP failure
- EVIDENCE: tests/unit/capability-doctor.test.ts :: marks streaming unsupported when the adapter does not implement it

SSE framing is covered at the level where it actually breaks — split chunks,
CRLF separators, an unterminated trailing frame — rather than on a
well-formed stream only. These are covered over real sockets in the E2E
suite as well; the unit citations are here because they name the specific
framing case.

---

## Tool calling

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/e2e/provider-switching.spec.ts :: a tool call from each provider drives the same browser action
- EVIDENCE: tests/e2e/provider-integration.spec.ts :: the canonical tool schemas reach the provider in its native format
- EVIDENCE: tests/unit/openai-compatible.test.ts :: parses a tool call into the canonical form
- EVIDENCE: tests/unit/openai-compatible.test.ts :: translates canonical tools into the function schema
- EVIDENCE: tests/unit/openai-compatible.test.ts :: expands tool results into separate role:tool wire messages

Both directions are covered: canonical tools out in the provider's schema, and
the provider's call back in canonical form. "Drives the same browser action"
is the claim §85 F rests on too.

---

## Multiple tool calls

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/unit/capability-doctor.test.ts :: never claims parallel tool calling without a passing tool check
- EVIDENCE: tests/integration/sustained-task.test.ts :: runs to completion without tripping a budget or the loop detector
- EVIDENCE: tests/integration/agent-runtime.test.ts :: feeds each tool result back and continues

A sustained trajectory of thirty-six tool calls across eighteen turns is the
substantive coverage here, with usage accounting and step ordering asserted
exactly. Parallel tool calling in particular is never claimed as a capability
unless the tool check passed — an unverified capability is `UNKNOWN`, and
`UNKNOWN` does not become yes.

---

## Vision

**Verdict: `AUTOMATED` for the encoding and the capability gate. `MANUAL` for
whether a vendor model actually reads the image.**

- EVIDENCE: tests/unit/openai-compatible.test.ts :: encodes an image part as a data URL
- EVIDENCE: tests/unit/capability-doctor.test.ts :: does not claim vision when the model does not advertise it
- EVIDENCE: tests/e2e/agent-task.spec.ts :: a screenshot is captured, stored and never inlined into model context

The third citation is the one worth reading closely, because it constrains the
other two: a screenshot is stored as evidence and referenced, never pasted
into the model's context as bytes. So "vision" here means an image part sent
deliberately, not a context window quietly filling with screenshots.

Whether a given vendor model genuinely interprets the image is a model-quality
question, and it is not assertable against a local server that returns
whatever it was told to.

---

## Invalid credentials

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/e2e/provider-integration.spec.ts :: an invalid API key surfaces as an auth failure rather than a generic error
- EVIDENCE: tests/unit/capability-doctor.test.ts :: separates "could not reach" from "key rejected" from "not authorized"
- EVIDENCE: tests/unit/openai-compatible.test.ts :: maps a network failure to NETWORK_ERROR without leaking the raw message

A rejected key must not read as "something went wrong", because the user's
remedy is specific. The raw transport message is kept out of the surfaced
error deliberately: it is the most likely place for a URL carrying a key to
resurface.

---

## Expired auth

**Verdict: `AUTOMATED` for the mechanism, which for API providers is the same
path as an invalid credential.**

- EVIDENCE: tests/e2e/provider-integration.spec.ts :: an invalid API key surfaces as an auth failure rather than a generic error
- EVIDENCE: tests/e2e/provider-integration.spec.ts :: disconnecting clears the stored credential
- EVIDENCE: tests/unit/token-vault.test.ts :: refuses a token that has expired
- EVIDENCE: tests/unit/token-vault.test.ts :: treats a token as expired slightly before it is

An API key does not expire on a schedule the way an OAuth grant does: it is
revoked, and the next call is rejected — the invalid-credential path. The
vault citations cover genuine expiry, which is a connector concern; they are
here because §87 asks for it and the honest answer is that it belongs to §88.
The early-expiry margin exists so a token is never used in the window where it
is about to lapse mid-request.

---

## Rate limit

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/e2e/provider-integration.spec.ts :: a rate limit is retried, then the task continues
- EVIDENCE: tests/e2e/provider-integration.spec.ts :: a server error that never clears fails the task cleanly
- EVIDENCE: tests/unit/budget-retry.test.ts :: never retries a decision, an auth failure, or an invalid input
- EVIDENCE: tests/unit/openai-compatible.test.ts :: marks a 5xx as retryable and a 400 as not

Both halves matter and are covered separately: a transient limit is retried
and the task _continues_, and a failure that never clears eventually _stops_
rather than retrying forever. Only transient codes retry — a 400 is a defect
in the request and retrying it is just load.

---

## Unsupported capability

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/e2e/provider-integration.spec.ts :: the doctor reports CHAT_ONLY when the endpoint cannot call tools
- EVIDENCE: tests/e2e/provider-integration.spec.ts :: a task is refused outright when the model cannot call tools
- EVIDENCE: tests/e2e/provider-switching.spec.ts :: the doctor reports CHAT_ONLY when a native provider cannot call tools
- EVIDENCE: tests/unit/capability-doctor.test.ts :: marks streaming unsupported when the adapter does not implement it
- EVIDENCE: tests/unit/capability-doctor.test.ts :: fails structured output when the reply is not valid JSON

The refusal is the load-bearing part. A model that cannot call tools cannot
drive a browser agent, so the task is refused up front rather than started and
failed halfway through, which would leave a half-completed action on somebody's
page.

**One thing this package does not claim.** `ModelCapabilities` in this
repository is boolean. §24B describes a tri-state — SUPPORTED, UNSUPPORTED,
UNKNOWN — and that tri-state belongs to the gated web-provider design, not to
the API providers. Nothing here should be read as implementing it.

---

## Procedure for the manual half

**Verdict: `MANUAL`** — this section is the procedure the items above
refer to, not an item of its own.

Requires an API key for each vendor. **Account owner action.**

For each of the three providers, and for each item above, run the item and
record what the vendor actually did. The three that most often differ from a
local server, and so are worth doing first:

1. **Rate limit.** Drive enough requests to be limited for real, and confirm
   the retry succeeds rather than compounding. Record the vendor's retry-after
   handling.
2. **Vision.** Send a screenshot and ask a question only answerable from the
   image. Confirm the answer is actually derived from it.
3. **Streaming.** Watch a long generation and confirm no frame is dropped at a
   chunk boundary under real network conditions.

Record each under `RESULTS.md` with the provider, the model id and the date.
A vendor behaviour that differs from its own documentation is the finding this
procedure exists to surface, and it is worth recording even when the adapter
handled it correctly.
