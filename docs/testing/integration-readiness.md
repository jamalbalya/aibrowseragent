# Integration readiness

What has actually been exercised, and against what.

Every other document in this repository answers "is it implemented". This one
answers a different and narrower question: **when this extension talks to
something it did not write, has that conversation ever happened?**

The distinction matters because the two are easy to confuse and the confusion
is always in the same direction. A suite of 4,500 passing tests and 500 real-
Chromium cases reads like proof that the product works against the world. It is
not. Almost all of it is proof that the product works against _this
repository's idea_ of the world.

## The five categories

Each row below is one of exactly these, and nothing is promoted without
evidence:

| Category             | What it means                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **UNIT**             | Implemented, covered by tests against a stub or a fixture.                                                                                                             |
| **MOCK-INTEGRATION** | Implemented, covered by several real components wired together — or by the real extension in real Chromium — talking to a local stand-in rather than the real service. |
| **LIVE-VERIFIED**    | A real authorization or a real request against the real external service has been executed successfully.                                                               |
| **BLOCKED**          | Cannot be verified here: needs a credential, an account, a paid service, or an owner-only decision.                                                                    |
| **MISSING**          | Not implemented, or implemented and known defective.                                                                                                                   |

**Three of the four provider rows are now LIVE-VERIFIED, and that changed on 3 October 2026.**
It is stated here rather than left to be inferred, and so is the shape of it:
Gemini, a commercial OpenAI-compatible gateway and a 9Router gateway have all
been exercised with real credentials against real services, including a
complete agentic trajectory — a model calling tools, their results going back,
and answers that could only have come from reading them. Anthropic has not,
because no key for it exists in this repository or on the development machine;
its path through the harness has been verified against a protocol stand-in so
that the owner's first run with a key tests the provider rather than the test.

Going live cost eight defects' worth of embarrassment and was worth every
penny. Each of the eight had passed every mocked test in this repository,
because a fixture accepts whatever you send it — and two of them, taken
together, meant the agent could not run on Gemini at all:

1. **Gemini tool calling never worked at all.** Canonical tool schemas carry
   `additionalProperties: false` — ordinary JSON Schema, accepted by every
   other provider here, declared by the capability doctor's own probe tool.
   Gemini's `parameters` is Google's `Schema` message parsed by protobuf JSON,
   which _rejects_ an unknown field: `400 Unknown name "additionalProperties"
… Cannot find field.` So the tool probe failed every time, Gemini reported
   `CHAT_ONLY`, and the browser agent could not run on the one provider this
   build supports a Google authorization for.
2. **Gemini streaming was off everywhere.** `supportedGenerationMethods` no
   longer lists `streamGenerateContent` for any current model, while
   `POST …:streamGenerateContent?alt=sse` answers 200 with SSE frames. Reading
   that absence as a denial made the adapter advertise `streaming: false`, the
   capability guard refuse the request, and the doctor's streaming probe never
   run — the one mechanism that would have caught it was the mechanism it
   disabled.
3. **A retired model was sent to the list that offered it.** Google's
   `/v1beta/models` leads with `gemini-2.5-flash`, `gemini-2.5-pro` and
   `gemini-2.5-flash-lite`, and a `generateContent` call on each answers
   `404 … no longer available to new users`. Every `NOT_FOUND` got _"The model
   id was not found. Check it against the model list"_ — advice that, in this
   case, confirms the user was right and leaves them believing the extension is
   broken.
4. **A Gemini conversation could make exactly one tool call.** A `functionCall`
   part comes back with an opaque `thoughtSignature`, and Google refuses any
   later turn that replays the call without it:
   `400 Function call is missing a thought_signature in functionCall parts.`
   The adapter parsed the part and dropped the field, so the turn that sends
   the **tool result** back — the first thing an agent does after a tool runs —
   failed every time.

   This one took two fixes, and the second is the more interesting. Teaching
   the adapter to keep and re-emit the token was not enough: the agent runtime
   rebuilds the assistant turn field by field, so it dropped the new field
   again. A value reconstructed field by field silently loses anything added to
   it later.

   The capability doctor could not see it: its tool probe is a **single** turn,
   and a single turn was the only thing that worked.

5. **Google's retry guidance was never read.** Found by doing what §87's manual
   procedure asks — _"drive enough requests to be limited for real"_. The
   sixteenth small request in a minute is refused, and Google sends **no
   `Retry-After` header**: the wait is in the error body as
   `google.rpc.RetryInfo` with `retryDelay: "11s"`, beside a `QuotaFailure`
   naming the free-tier limit of 15.

   Every adapter read the header only. So the retry guidance honoured since
   `5e7270d` never engaged for the provider most likely to rate-limit, on the
   free tier this product is built around — the agent retried on its own
   8-second backoff, arrived three seconds early, and collected another 429.
   The second defect running whose fix was already written and simply out of
   reach.

6. **An empty account was told to wait.** `api.openai.com` answers an account
   with no credit with **429** — the same status a throttled account gets —
   carrying `type: insufficient_quota`, `code: credit_balance_exhausted`, and
   **no `Retry-After` header**, because there is no time at which trying again
   would work.

   Every 429 was reported as rate limiting, so the user was told to _"try again
   shortly"_ — advice that can never come true — and `rate_limited` is
   **retryable**, so the agent spent its retry budget re-asking a question
   whose answer cannot change until somebody adds money to an account. It now
   reports as `access_denied`, which is terminal, with a sentence that says
   waiting will not help.

7. **A disconnect did not disconnect.** `authorization.ts` had declared
   `revokeEndpoint: 'https://oauth2.googleapis.com/revoke'` since the Google
   flow was built, and **nothing read it** — the constant appeared exactly once
   in the repository, in its own declaration. So pressing _Disconnect_ deleted
   the stored tokens and told Google nothing: this build could no longer use
   the grant, while the user's Google account went on listing the extension as
   authorized indefinitely.

   Revocation now happens before the local removal, because the removal
   destroys the token it needs, and a disconnect still always disconnects —
   every failure is reported and none of them blocks. The third instance in
   three sessions of a value parsed or declared and never read.

8. **A reply nobody could read looked like a reply with nothing in it.** Both
   native adapters parse the content blocks they know and drop the rest, which
   is correct — the live Gemini endpoint returns `thought` parts beside the
   text it means you to see, and a reply carrying
   `['text', 'thought', 'functionCall', 'thoughtSignature']` is an ordinary
   reply.

   What was wrong was the case where _nothing_ survived the filter. An
   Anthropic `thinking` block, or any block type added after this build
   shipped, produced `text: ''`, no tool calls and `finishReason: 'stop'` — an
   empty answer claiming a normal finish, with the output tokens billed. The
   agent takes that as the model's final word, so a task completes with
   nothing in it and the person cannot tell whether the model said nothing or
   the extension could not read what it said. Those have different fixes, so
   they now read differently: `malformed_response`, not retryable, naming the
   block types it could not use.

   Found by auditing the Anthropic adapter for the Gemini `thoughtSignature`
   defect's analogue rather than by running anything — and then confirmed to
   be present in the Gemini adapter too.

## AI providers

| Surface                      | Status                                                       | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | What is unproven                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openai-compatible` protocol | LIVE-VERIFIED (gateway); DIRECT: credential + discovery only | `tests/unit/openai-compatible.test.ts` (33); `tests/e2e/provider-integration.spec.ts` against a local server; **live against `openrouter.ai`** — 466 models, doctor **AGENT_READY**; and **live against `api.openai.com` directly on 2026-10-03** — the credential validated and **127 models discovered**, both at zero cost                                                                                                                                                         | Generation, tools and streaming on `api.openai.com`: the account has **no credit**, which is a billing state and not a code problem. That blockage found defect 6 — every 429 was reported as rate limiting, including an unfunded account |
| `anthropic` protocol         | UNIT                                                         | `tests/unit/anthropic.test.ts` (41); and the live harness's **anthropic path** verified on 2026-10-03 against a loopback stand-in speaking the Messages protocol — AGENT_READY with the full two-turn round trip, and a mutation that made the stand-in ignore the tool result caught by the case meant to catch it                                                                                                                                                                   | `api.anthropic.com` itself. No Anthropic key exists in this repository or on the development machine. The harness is verified ready, so a failure will be the provider or this build rather than the test — see OWNER-CHECKLIST.md         |
| `gemini` protocol            | LIVE-VERIFIED                                                | `tests/unit/gemini.test.ts` (41); `tests/integration/google-account-journey.test.ts` (27); **and live against `generativelanguage.googleapis.com` on 2026-10-03** — `gemini-flash-lite-latest` reached **AGENT_READY** with all twelve doctor checks passing, and the full two-turn tool round trip completed: the model called the tool, the result was sent back, and the answer carried a value that appears only in that result. All five defects above were found and fixed here | Nothing on this adapter. The remaining Gemini gap is the **OAuth** credential path, which needs a client id and is a separate row below                                                                                                    |
| `nine-router` protocol       | LIVE-VERIFIED (gateway)                                      | `tests/unit/nine-router-catalog.test.ts` (15), `tests/integration/nine-router-pipeline.test.ts` (19), `tests/e2e/nine-router.spec.ts`; **and live on 2026-10-03** — all 25 cases of `tests/integration/nine-router-live.test.ts` passed in 30.6s against a running gateway: 35 models across 4 upstream groups, discovery, selection, the provider pin, a completion that returned, and a capability measurement                                                                      | Nothing on this adapter                                                                                                                                                                                                                    |
| Capability doctor            | LIVE-VERIFIED                                                | `tests/unit/capability-doctor.test.ts` (23); and its full probe sequence run against two real endpoints, reaching `AGENT_READY` on one and measuring eight capabilities on the other                                                                                                                                                                                                                                                                                                  | Anthropic's refusal shapes                                                                                                                                                                                                                 |
| Any provider, end to end     | LIVE-VERIFIED for three of four                              | `tests/integration/provider-live.test.ts` against Gemini (all eleven cases) and OpenRouter; `nine-router-live.test.ts` against a running gateway                                                                                                                                                                                                                                                                                                                                      | Anthropic, for want of a key anywhere; and `api.openai.com` directly, where a key exists and the run would be paid                                                                                                                         |

### The question behind this table

> Can a provider be connected successfully and still fail when the agent
> attempts to execute a real task?

Yes, and the ways it can are worth naming, because each one is a place where a
green connection screen is not a working product.

1. **No model selected.** Refused before a credential is read, by
   `resolveBrainAccount`'s `NO_MODEL_SELECTED`.
2. **A model that is no longer offered.** `MODEL_STALE`.
3. **No credential on this device.** `NO_CREDENTIAL_ON_DEVICE`, with different
   wording for a pasted key and an authorization.
4. **A credential the provider now refuses.** `CREDENTIAL_REJECTED`, which also
   records the account as disconnected.
5. **Capabilities never measured for this exact pair.** The request is refused
   as `unverified` rather than attempted.
6. **A credential that expires mid-run.** This one was real, and it is the
   defect this document was written alongside. The credential is resolved
   **once**, at task start, and the adapter holds it for the whole run. The
   freshness check asked only whether the token worked _now_, with a two-minute
   skew — while a task is allowed to run for ten minutes. A token with five
   minutes left passed every check, connected, and then failed every turn after
   minute five with a 401 that the task layer treats as terminal, on an account
   whose next run would have worked. Fixed by making the horizon the caller's
   question: `needsRefresh(token, now, mustOutlastMs)`, with the brain
   resolution passing the task budget. Pinned by
   `tests/security/google-provider-auth.test.ts` and three cases in
   `tests/integration/google-account-journey.test.ts`.
7. **A tool the provider rejects outright.** This was listed here as "the most
   plausible remaining candidate", suspecting the _second_ turn, where the
   three protocols diverge most. The live run found **both**, which is worse
   than the guess and vindicates it twice over. The first turn was refused
   because the canonical schema carried `additionalProperties` (defect 1); once
   that was fixed the second turn was refused for want of a `thoughtSignature`
   (defect 4). An earlier draft of this paragraph said "the second turn was
   fine on the protocol that got far enough to try it" — written before any
   protocol had got far enough, and wrong.
8. **A model that is listed and cannot be run.** Also not on this list before,
   and the first three entries Google offers are all of them. Defect 3 above.
9. **A provider that says how long to wait and is ignored.** Found by being
   rate-limited repeatedly on real free tiers. `delayFromRetryAfter` parsed
   `Retry-After`, `providerFailure` recorded it, and the comment on the parser
   claimed it _"overrides our backoff"_ — while the only thing reaching
   `decideRetryFor` was a code and a boolean. A provider asking for 47 seconds
   got an 8-second exponential backoff, another 429, and a task that spent its
   three attempts in about fifteen seconds. Now honoured up to a ceiling, and
   past the ceiling the task stops and says how long was asked for, because
   sleeping five minutes of a ten-minute budget to make one more attempt spends
   the person's time to arrive at the same place.

Numbers 1 to 6 are structural: there is no path from a refused selection to a
provider request. Numbers 7 to 9 were not, and all three were found in the
first hour of having real credentials. That ratio is the argument for the live
harness, and it is worth stating plainly: a 4,500-case suite and 525
real-Chromium cases did not find any of them, and could not have.

### Where the live runs happen, which turned out to matter

Every live run described above happens in **Node**: the production registry,
transport, gate and adapters, assembled in a process with no extension around
them. That proves the adapter. It does not prove the _extension_, and those are
different questions — the manifest's host permissions, an extension page's CSP,
a service worker's `fetch` under MV3, and the egress gate running where it
actually runs.

Until 3 October 2026 every provider request ever made from inside this
extension went to a local server on **loopback**. The first time one went to a
commercial endpoint, two things came out of it:

- **It works.** The capability doctor ran from inside the service worker and
  reported `AGENT_READY` on all twelve checks against
  `generativelanguage.googleapis.com`, and a real task read a real page and
  answered from it.
- **The exfiltration guard's credential check had never run.** Loopback is
  treated differently, so the check in front of a commercial destination was
  dead code in every test. Pointed at a page carrying
  `<input type="password" value="…">`, it fired — `POLICY_BLOCKED`, _"this
  transfer contains credential-shaped data … refused before anything was
  sent"_ — after the page had been read and before anything left. Correctly,
  and for the first time.

`tests/e2e/live-provider-in-browser.spec.ts` is that run, opt-in on
`ABA_E2E_GEMINI_KEY` and skipped without it.

### Per provider: what is verified, and by what

The five categories asked for, kept apart on purpose. "Account authorization"
means an OAuth-style grant; "API-key connection" means a credential the user
pastes; "model discovery" means the vendor was asked what the credential can
reach.

| Provider            | Account authorization                                                                                                                   | API-key connection                                                         | Model discovery                                                        | Static model list |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------- |
| `gemini`            | **Not verified.** Implemented, unit- and Chromium-tested against stand-ins; needs a client id that needs a published extension id (G-6) | **LIVE-VERIFIED**                                                          | **LIVE-VERIFIED** — 44 models from the vendor                          | None              |
| `openai-compatible` | Not applicable — the protocol has none                                                                                                  | **LIVE-VERIFIED** against a gateway, and against `api.openai.com` directly | **LIVE-VERIFIED** — 466 from the gateway, **127 from OpenAI directly** | None              |
| `anthropic`         | Not applicable                                                                                                                          | **Not verified** — no key anywhere                                         | **Not verified**                                                       | None              |
| `nine-router`       | Not applicable                                                                                                                          | **LIVE-VERIFIED**                                                          | **LIVE-VERIFIED** — 35 models, 4 upstream groups                       | None              |

**No provider has a static or manually configured model list**, and that is a
design position rather than an accident: all four adapters report
`modelListing: true`, and `known-endpoints.ts` says of itself that it is not
_"a model list — models are discovered from the endpoint, never declared
here"_. So there is no provider for which this build could show a model the
user's credential cannot reach because somebody typed it into the source.

What that leaves genuinely untested, and why each:

- **Anthropic, end to end.** No key exists in this repository or on the
  development machine. 42 unit cases cover connection, discovery, request
  formatting, response parsing, authentication, errors and redaction; what is
  missing is one command with one key, written down in `OWNER-CHECKLIST.md`.
- **Generation on `api.openai.com`.** The credential and discovery are
  live-verified; the account has **no credit**, so no completion can be made.
  A billing state, not a code problem — and it cost nothing to find out,
  because `GET /v1/models` is free.
- **Any OAuth grant, for any provider.** The flow is implemented and tested
  against stand-ins in real Chromium, and no real authorization has ever been
  performed, because none can be until a client id exists — which needs a
  published extension id.

## Google provider authorization

| Surface                                                   | Status           | Evidence                                                                                                                                                                                | What is unproven                                                                                                                                    |
| --------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| PKCE authorization URL, callback, token exchange, refresh | UNIT             | `tests/security/google-provider-auth.test.ts` (56)                                                                                                                                      | —                                                                                                                                                   |
| `chrome.identity.launchWebAuthFlow` in a real browser     | MOCK-INTEGRATION | `tests/e2e/auth-google-protocol.spec.ts`, `tests/e2e/google-provider-auth.spec.ts`, `tests/e2e/auth-google.spec.ts` — real Chromium, real optional-permission grant, real route answers | That Google's consent screen returns what these cases supply                                                                                        |
| A real Google authorization                               | BLOCKED          | —                                                                                                                                                                                       | Needs an OAuth client registered to a published extension id. No shipped build has one: `validate-package.mjs` reports `google oauth: no client id` |

The order of that blockage is worth stating because it is often got backwards:
the extension id is assigned at publication, the OAuth client is registered
against that id, and the client id is a build input. So a live Google
authorization cannot be executed before the first submission. The build refuses
a client id that is set and unusable rather than shipping one that will fail
(`scripts/check-extension-env.mjs`), and `CLIENT_MISMATCH` is the error for a
client registered to the wrong id.

### Anthropic, pre-flighted a second time

Before the owner spends a key, the three things that would make the first run
fail on the _test_ rather than on the provider were checked against the real
API's documented shapes. All three are sound, so this is recorded as a negative
result rather than a change:

| Risk                                                    | Finding                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listModels` brittle to the vendor's real envelope      | Sound. `body.data ?? []`, filtered on `typeof id === 'string'`, `display_name` falling back to `id`, extra fields ignored. Pagination fields are simply unused, and with ~15 models the `?limit=100` request never needs a second page.                                               |
| An id the build refuses to record                       | Sound. `admitModelIds` filters on length and charset; `claude-sonnet-4-5-20250929` and its siblings are plain hyphenated alphanumerics well inside the limit.                                                                                                                         |
| Vision withheld from a model the build has not heard of | Sound, and deliberately so. `NO_VISION_HINTS` is a **deny** list of `claude-1`, `claude-2`, `claude-instant` matched by prefix, so an unknown model is claimed to have vision and the doctor verifies it. Checked against six current and historical ids: no current name is matched. |

The direction of each is what matters. A brittle parser, a strict id filter or
an allow-list for vision would each have failed _closed_ — an empty catalogue,
a missing model, a refused image — and each would have looked like a provider
problem in the owner's first run.

### Anthropic, audited rather than run

No Anthropic key exists, so nothing below is a live result. What it is instead:
the adapter audited against the **five defect classes the other providers' live
runs produced**, on the reasoning that a defect found on one wire format is a
question worth asking of the others. One of the five was present.

| Class, as found elsewhere                                            | Anthropic                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A tool-schema field the vendor rejects by name (Gemini)              | **Sound.** `input_schema` is JSON Schema and `additionalProperties` is part of it. The conformance suite pins that this adapter passes the schema through untouched.                                                                                                                                |
| An opaque token the vendor requires back (Gemini `thoughtSignature`) | **Not reachable today, and worth knowing.** Anthropic's equivalent is a `thinking` block with a `signature`, returned only when extended thinking is _requested_ — and this build never sends the `thinking` parameter, so none arrives. If anyone enables it, this is the first thing that breaks. |
| A capability denied on an absent list entry (Gemini streaming)       | **Sound.** Capabilities come from the model family, not from a methods list.                                                                                                                                                                                                                        |
| Retry guidance the build never reads (`Retry-After`, `RetryInfo`)    | **Sound.** Anthropic documents the `retry-after` **header**, which `retryAfterMs(response)` reads. No body-only variant to miss.                                                                                                                                                                    |
| An unreadable reply returned as an empty one                         | **Present.** Defect 8 above. Found here first and then in the Gemini adapter.                                                                                                                                                                                                                       |

Two further things the live run should check first, written down so it is not
re-derived:

- **An exhausted balance is a 400 here, not a 429.** OpenAI answers an unfunded
  account with 429 `insufficient_quota`, which this build now reports as
  terminal. Anthropic's documented shape is a **400** `invalid_request_error`
  whose message names the credit balance — a different status, so the
  openai-compatible fix does not cover it, and a generic `INVALID_ARGUMENT`
  would be the result. No speculative matcher has been added, because guessing
  at an error shape is how the over-match in the OpenAI fix would have slipped
  through. **Check this first and record the exact body.**
- **Which model the key can actually reach.** The harness discovers rather than
  naming one, deliberately: naming a model is guessing at a catalogue you have
  not seen, which is exactly what Google's list punishes.

What is already covered without a key: 45 unit cases over connection
(including connecting before a model is chosen), the model-list envelope,
request formatting, response parsing, authentication, the error taxonomy,
credential redaction and now unreadable content — plus the harness's
`anthropic` path driven against a loopback stand-in speaking the Messages
protocol, reaching `AGENT_READY` with the full two-turn round trip, and a
mutation that ignored the tool result caught by the case meant to catch it.

### OAuth, mechanism by mechanism

**No OAuth grant has ever been performed, for any provider or connector.** That
is the headline, and everything below is implementation and stand-in testing.
It is worth setting out per mechanism anyway, because "untested" and
"unimplemented" are not the same thing and the owner's action differs.

| Mechanism                                | Implemented                                                            | Tested against                                                   | A real grant |
| ---------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------ |
| PKCE authorization URL (S256, no secret) | `google-provider-auth.ts`                                              | 56 unit cases; 28 Chromium cases on the real `launchWebAuthFlow` | **Never**    |
| Redirect + callback handling             | `readGoogleCallback`                                                   | The redirect is matched before anything on the URL is read       | **Never**    |
| State / CSRF                             | `timingSafeEqual` on `state`, in both the provider and connector flows | Unit cases for mismatch, absent and replayed state               | **Never**    |
| Authorization TTL                        | `AUTHORIZATION_TTL_MS` (10 min) in the connector flow                  | Unit                                                             | **Never**    |
| Token storage                            | `CredentialStore.setOAuthTokens`, inside the K1-protected area         | `02c` of the Google journey asserts it is protected like a key   | **Never**    |
| Refresh                                  | `needsRefresh` with the caller's horizon; one attempt, never retried   | Unit, plus the horizon arithmetic                                | **Never**    |
| Client misconfiguration                  | `CLIENT_MISMATCH`, which now prints the redirect URI to register       | Unit                                                             | **Never**    |
| Cancellation / decline                   | `DECLINED`, separated from a client problem                            | Unit                                                             | **Never**    |
| **Revocation on disconnect**             | **New.** `revoke-authorization.ts`                                     | 11 unit cases, three mutation-controlled rules                   | **Never**    |

**Revocation is the one that changed today, and it had been missing entirely.**
`revokeEndpoint` was declared when the Google flow was built and read by
nothing — it appeared exactly once in the repository, in its own declaration.
So a disconnect deleted the tokens and told Google nothing: this build could no
longer use the grant, and the user's Google account went on listing the
extension as authorized. It now asks Google to withdraw the grant first,
because the local removal destroys the token needed to ask, and a disconnect
still always disconnects whatever the answer.

What the owner must do, exactly: register a **Chrome Extension** OAuth client
for the published extension id and set `VITE_ABA_GOOGLE_PROVIDER_CLIENT_ID`
(G-6). Until then the panel reports the Google method unavailable with a
reason, the build fails if the value is set and unusable, and none of the rows
above can move. No secret is involved at any point — Google issues none for
this client type, and the build could not hold one safely if it did.

## Connectors

| Surface                                                 | Status                  | Evidence                                                                                                                                                                     | What is unproven                                                                                       |
| ------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Connector framework, sessions, token auth, site binding | UNIT / MOCK-INTEGRATION | `tests/security/connector-security.test.ts` (57), `tests/unit/connector-session.test.ts` (35), `tests/unit/connector-token-auth.test.ts` (29), `tests/e2e/connector.spec.ts` | —                                                                                                      |
| GitHub, Figma, Jira, Confluence                         | MOCK-INTEGRATION        | `tests/integration/figma-connector.test.ts` (28), `tests/integration/confluence-connector.test.ts` (23), `tests/integration/connector-workflow.test.ts` (39)                 | That any of the four real APIs answers as the fixtures do                                              |
| Any connector against its real service                  | BLOCKED                 | —                                                                                                                                                                            | Needs an account and a token per service. Recorded as `EXTERNAL_REQUIRED` on `P-023-C8` and `P-023-C9` |
| The reference QA workflow across four services          | BLOCKED                 | —                                                                                                                                                                            | `P-022-C8`, `P-024-C9`                                                                                 |

## MCP

| Surface                      | Status                       | Evidence                                                                                             |
| ---------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| Protocol, transport, interop | MOCK-INTEGRATION             | `tests/integration/mcp-interop.test.ts`, `tests/e2e/mcp.spec.ts`                                     |
| A real remote MCP server     | BLOCKED, with a live harness | `tests/integration/mcp-remote-live.test.ts` — opt-in on `MCP_REMOTE_TEST_URL`, never run in `verify` |

## Chrome platform

These are the rows where "live" is genuinely available, because the external
service is the browser and the browser is here. All of the following run against
the real extension in real Chromium.

| Surface                                           | Status                  | Evidence                                                                       |
| ------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| Side panel, service-worker lifecycle, MV3 restart | LIVE-VERIFIED (browser) | `tests/e2e/mv3-lifecycle.spec.ts`, `tests/e2e/browser-restart.spec.ts`         |
| `debugger` attach and release                     | LIVE-VERIFIED (browser) | `tests/e2e/advanced-forms.spec.ts`, `tests/e2e/field-sensitivity.spec.ts`      |
| Optional permissions (`downloads`, `identity`)    | LIVE-VERIFIED (browser) | `tests/e2e/download-granted.spec.ts`, `tests/e2e/auth-google-protocol.spec.ts` |
| Alarms, notifications, shortcuts, tab groups      | LIVE-VERIFIED (browser) | `schedules`, `notifications`, `shortcuts`, `tab-order`, `tab-scope` specs      |
| Accessibility of the panel                        | LIVE-VERIFIED (browser) | `tests/e2e/accessibility.spec.ts`                                              |

"LIVE-VERIFIED (browser)" is deliberately qualified. It means the Chrome API was
really called and really answered. It says nothing about any provider.

### A limitation I overstated, now measured

**This section used to claim more than was true, and the correction is the
point.** It said a retired model "stays selected after it has failed", with
nothing recording what the worker had learned, and concluded that closing it
properly needed a protocol change not worth making blind.

Reading the code again, and then running it, says otherwise. The chain already
exists:

1. A doctor run on a retired model ends `FAILED` — its `model` check _passes_,
   because the model is genuinely in the vendor's list, and the `text` check is
   what fails.
2. `doctorVerdict` maps `FAILED` to `status: 'failed'` and keeps the summary as
   `statusReason`.
3. `ConnectedAccounts.tsx` renders that reason as a warning on the account row.

Verified end to end against the live vendor on 4 October 2026, through the
extension's own account routes:

```
retired model: readiness=FAILED  summary="This model is still listed but Google
                                 has retired it for this account. Choose a
                                 different model…"
retired row:   status=failed     reason=(the same sentence)
```

So the worker does write down what it learned, and the panel does show it. What
is genuinely still true, and all that is:

- **The vendor's model list cannot be filtered.** Google lists
  `gemini-2.5-flash`, `gemini-2.5-pro` and `gemini-2.5-flash-lite` and refuses
  to run them. Knowing which of a catalogue a credential can use means probing
  each one, which spends the user's quota on a question the first real task
  answers for free.
- **`modelStale` is still set only by discovery.** A retired model is in the
  catalogue, so it is never marked stale, so the next task is _attempted_
  rather than refused in advance. That costs one failed request after the
  warning is already on screen — and it is the right trade: the alternative
  fights with discovery over the same flag, and a model wrongly marked stale is
  an account that cannot run at all.

The lesson worth keeping is about the earlier write-up rather than the code. It
reasoned from one file — `modelStale` is not set, therefore nothing is recorded
— and stopped. Three files along, something was.

### Two reach limits that no amount of testing closes

These are decisions, not gaps, and they are recorded in
[BLOCKER-CERTIFICATION.md](../release/BLOCKER-CERTIFICATION.md) as C-6 and C-1.
They belong here because a reader of the browser rows above would otherwise
take them as complete.

- **C-6 — cross-origin iframes.** The content script runs in the top frame
  only (`all_frames: false`). Shadow roots are walked; a form inside a
  third-party iframe is not reachable, which puts some payment and embedded-
  widget flows out of range. Widening it would inject into every frame of every
  granted page, including ad and tracker frames, which multiplies the untrusted
  surface the page model reads from. Neither option is free, `P-006-C10` stays
  PARTIAL either way, and the permission change is cheaper to justify after a
  first review than before one.
- **C-1 — plugins.** `P-025` is NOT-STARTED. The parity adjudication found
  plugins to be documented Claude-in-Chrome behaviour in Cowork-session mode
  only, delivered by a cloud session, and absent from the classic-mode
  capability list this project reproduces. So nothing in the comparison is
  waiting on it.

## Validation strategy

### What the owner can run today, with no credential

```bash
npm run verify        # 4,525 unit/integration/security cases, 0 live
npm run verify:full   # the above plus the real-Chromium suite
```

Neither touches an external service. Both are the floor, not the proof.

### What the owner can run with one key, for one provider

```bash
ABA_LIVE_PROTOCOL=anthropic|gemini|openai-compatible|nine-router \
ABA_LIVE_API_KEY=… \
ABA_LIVE_BASE_URL=…    # openai-compatible only
ABA_LIVE_MODEL=…       # optional; discovered when omitted
  npx vitest run tests/integration/provider-live.test.ts
```

Runs that have actually been made, recorded so they can be repeated:

```bash
# Gemini, free tier. Found every defect listed at the top of this file.
ABA_LIVE_PROTOCOL=gemini ABA_LIVE_MODEL=gemini-flash-latest

# A commercial gateway speaking Chat Completions. Reached AGENT_READY.
ABA_LIVE_PROTOCOL=openai-compatible \
ABA_LIVE_BASE_URL=https://openrouter.ai/api/v1 \
ABA_LIVE_MODEL=nvidia/nemotron-3.5-lightning:free

# The anthropic path, against a loopback stand-in rather than the vendor.
# Verifies the harness, and is not evidence about api.anthropic.com.
ABA_LIVE_PROTOCOL=anthropic ABA_LIVE_BASE_URL=http://127.0.0.1:<port>
```

And the gateway harness, which has its own file and its own two variables:

```bash
NINEROUTER_TEST_BASE_URL=… NINEROUTER_TEST_API_KEY=… \
  npx vitest run tests/integration/nine-router-live.test.ts
```

Pass the key in the process environment, never on the command line: an argument
is visible in `ps`.

Nine cases: real discovery, real connection, the capability doctor's verdict on
a real model, a real completion, a real stream, **a real two-turn tool round
trip**, a model the endpoint lists and refuses to run, and two cases asserting
the credential does not come back out — after first asserting that it really
went out.

This **spends money**, a few small requests' worth, and only when those
variables are set. Nothing in `verify` runs it.

Three things the first real runs taught the harness itself, each of which had
made it report a defect that was not one:

- **It took `ids[0]`.** Being listed is not being usable, which
  `nine-router-live.test.ts` already recorded about a gateway and this file did
  not carry over. Google's first three generative entries are all retired, so
  the harness picked a dead model and reported six failures. It now finds a
  model by asking, preferring one that accepts a tool, and keeps the first
  unusable one it meets as evidence for case C3.
- **It ran under vitest's 5-second default.** A real completion routinely
  exceeds it and the doctor — eight sequential round trips — always does. Live
  cases now carry 120s, and the doctor 240s.
- **It treated a rate limit as a verdict.** A free-tier key runs out partway
  through nine cases making a couple of dozen real requests, and a 429 on case
  E1 says nothing about whether the credential leaks into the audit trail. A
  rate limit is now reported **INCONCLUSIVE**, loudly, and nothing else is: an
  authentication failure, a malformed request, a retired model and a wrong
  answer all stay failures.

A run where every case prints INCONCLUSIVE has established nothing, and says
so six times. Read the output, not the exit code.

The harness was also exercised against a local Chat Completions stand-in, with
two mutations — a stand-in that ignores the tool result, and this build's
redaction removed — each caught by the case meant to catch it. That is a check
on the harness, not a provider verification.

### The safest practical Google authorization check

A live Google authorization needs a client id, which needs a published
extension id. The lowest-risk order is:

1. Submit, and let Chrome assign the extension id.
2. Create a **Chrome Extension** OAuth client for that exact id — not a Web
   client; a Web client is the one that wants a secret, and no secret is ever
   embedded here.
3. Set `VITE_ABA_GOOGLE_PROVIDER_CLIENT_ID` and rebuild. The build fails if the
   value is set and unusable, so a typo cannot ship.
4. Load the unpacked build, authorize a Google account that owns a Gemini API
   project, and run one task.
5. A `redirect_uri_mismatch`, `invalid_client` or `unauthorized_client` reply
   surfaces as `CLIENT_MISMATCH`, which means the client is registered to a
   different extension id — step 2 again, with the id from `chrome://extensions`.

Until step 4 happens, the Google row stays BLOCKED, and no document in this
repository should say otherwise.

### Chrome Web Store package integrity

Two checks were added after noticing that nothing enforced either.

- **No value from the developer's own `.env` may appear in the artifact.**
  Shape-independent, and that is the point: on the machine this was written on,
  `.env` held five live provider keys, and `validate-release.mjs` now compares
  each against every file in `dist/`, naming the variable and never its value.
  Vite only inlines `VITE_`-prefixed variables, so today none of them can reach
  the bundle — which is a property of a build tool's configuration, exactly the
  kind of thing that holds until someone adds a `define`, reads `process.env`
  directly, or prefixes a secret with `VITE_` by mistake. Verified in both
  directions by injecting a real key into `dist/` and watching the build fail.
- **Google's newer key format is now detected.** The credential patterns knew
  `AIza…` and not `AQ.…`, which is the format of the keys actually in use. A
  detector that knows one of a provider's two formats reports clean on the
  other.

### What should never be used as validation

- The temporary 9Router key that appeared in this repository's history. It is to
  be treated as exposed until rotated at the provider, and rotating it is an
  owner action.
- A commercial provider's free tier reached by a route this build does not
  implement. A consumer subscription is not API access.
