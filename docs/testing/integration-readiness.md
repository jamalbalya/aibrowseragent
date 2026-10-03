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

**Two provider rows are now LIVE-VERIFIED, and that changed on 3 October 2026.**
It is stated here rather than left to be inferred, and so is the shape of it:
Gemini and a generic OpenAI-compatible endpoint have been exercised with real
credentials against real services, including a complete agentic turn — a model
calling a tool, the tool's result going back, and an answer that could only
have come from reading it. Anthropic has not, because no key for it exists
here.

Going live cost three defects' worth of embarrassment and was worth every
penny. Each of the three had passed every mocked test in this repository,
because a fixture accepts whatever you send it:

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

## AI providers

| Surface                      | Status                                | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | What is unproven                                                                                                                                                                      |
| ---------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai-compatible` protocol | LIVE-VERIFIED (gateway)               | `tests/unit/openai-compatible.test.ts` (28); `tests/e2e/provider-integration.spec.ts` against a local server; **and live against `openrouter.ai` on 2026-10-03 via `provider-live.test.ts`** — 466 models discovered, doctor **AGENT_READY** with `tools=pass streaming=pass text=pass context=pass`                                                                                                                                                                                  | `api.openai.com` itself, directly rather than through a gateway. Two free models declined vision and structured output, which is a fact about them                                    |
| `anthropic` protocol         | UNIT                                  | `tests/unit/anthropic.test.ts` (41)                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Every byte on the wire. No request has left this machine for `api.anthropic.com`, because no Anthropic key exists here. This is the one provider row no amount of local work can move |
| `gemini` protocol            | LIVE-VERIFIED                         | `tests/unit/gemini.test.ts` (41); `tests/integration/google-account-journey.test.ts` (27); **and live against `generativelanguage.googleapis.com` on 2026-10-03** — `gemini-flash-lite-latest` reached **AGENT_READY** with all twelve doctor checks passing, and the full two-turn tool round trip completed: the model called the tool, the result was sent back, and the answer carried a value that appears only in that result. All four defects above were found and fixed here | Nothing on this adapter. The remaining Gemini gap is the **OAuth** credential path, which needs a client id and is a separate row below                                               |
| `nine-router` protocol       | MOCK-INTEGRATION, with a live harness | `tests/unit/nine-router-catalog.test.ts` (15), `tests/integration/nine-router-pipeline.test.ts` (19), `tests/e2e/nine-router.spec.ts`; and `tests/integration/nine-router-live.test.ts` (opt-in, real)                                                                                                                                                                                                                                                                                | Nothing, once the live harness is run — it is the only provider that has one that has been exercised against a real gateway                                                           |
| Capability doctor            | LIVE-VERIFIED                         | `tests/unit/capability-doctor.test.ts` (23); and its full probe sequence run against two real endpoints, reaching `AGENT_READY` on one and measuring eight capabilities on the other                                                                                                                                                                                                                                                                                                  | Anthropic's refusal shapes                                                                                                                                                            |
| Any provider, end to end     | LIVE-VERIFIED for two of four         | `tests/integration/provider-live.test.ts`, run against Gemini (all nine cases) and OpenRouter                                                                                                                                                                                                                                                                                                                                                                                         | Anthropic (no key) and `api.openai.com` directly (a key exists but the run would be paid, and this project holds to free tiers)                                                       |

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

Two runs that have actually been made, recorded so they can be repeated:

```bash
# Gemini, free tier. Found all three defects listed at the top of this file.
ABA_LIVE_PROTOCOL=gemini ABA_LIVE_MODEL=gemini-flash-latest

# A commercial gateway speaking Chat Completions. Reached AGENT_READY.
ABA_LIVE_PROTOCOL=openai-compatible \
ABA_LIVE_BASE_URL=https://openrouter.ai/api/v1 \
ABA_LIVE_MODEL=nvidia/nemotron-3.5-lightning:free
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
