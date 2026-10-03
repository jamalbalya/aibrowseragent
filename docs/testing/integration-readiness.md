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

**No row in this document is LIVE-VERIFIED.** That is the honest headline, and
it is stated once here rather than being left to be inferred from the table.

## AI providers

| Surface                      | Status                                | Evidence                                                                                                                                                                                               | What is unproven                                                                                                            |
| ---------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `openai-compatible` protocol | MOCK-INTEGRATION                      | `tests/unit/openai-compatible.test.ts` (28); `tests/e2e/provider-integration.spec.ts` against a local Chat Completions server, over real sockets from inside the extension                             | That OpenAI, or any commercial gateway, answers as that server does                                                         |
| `anthropic` protocol         | UNIT                                  | `tests/unit/anthropic.test.ts` (41)                                                                                                                                                                    | Every byte on the wire. No request has left this machine for `api.anthropic.com`                                            |
| `gemini` protocol            | UNIT                                  | `tests/unit/gemini.test.ts` (32); `tests/integration/google-account-journey.test.ts` (27)                                                                                                              | As above, for `generativelanguage.googleapis.com`                                                                           |
| `nine-router` protocol       | MOCK-INTEGRATION, with a live harness | `tests/unit/nine-router-catalog.test.ts` (15), `tests/integration/nine-router-pipeline.test.ts` (19), `tests/e2e/nine-router.spec.ts`; and `tests/integration/nine-router-live.test.ts` (opt-in, real) | Nothing, once the live harness is run — it is the only provider that has one that has been exercised against a real gateway |
| Capability doctor            | MOCK-INTEGRATION                      | `tests/unit/capability-doctor.test.ts` (23)                                                                                                                                                            | That a commercial model's refusals arrive in the shapes the fixtures use                                                    |
| Any provider, end to end     | BLOCKED                               | —                                                                                                                                                                                                      | Needs a credential. `tests/integration/provider-live.test.ts` is the command; see **Validation strategy**                   |

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
7. **A tool result the provider rejects.** Not observed, and the most plausible
   remaining candidate. The capability doctor proves tool calling with a
   _single_ turn — one tiny tool, one call back. A task then does something the
   doctor never does: it sends the tool's **result** and asks for another turn.
   That turn is where the three protocols diverge most, and until
   `provider-live.test.ts` is run against a real endpoint it is unproven
   against any of them. It is case D of that file.

Numbers 1 to 6 are structural: there is no path from a refused selection to a
provider request. Number 7 is not, and it is the reason the live harness exists.

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

Eight cases: real discovery, real connection, the capability doctor's verdict on
a real model, a real completion, a real stream, **a real two-turn tool round
trip**, and two cases asserting the credential does not come back out — after
first asserting that it really went out.

This **spends money**, a few small requests' worth, and only when those
variables are set. Nothing in `verify` runs it. One provider's worth of key
moves that provider's row from UNIT to LIVE-VERIFIED, and nothing else's.

The harness itself has been exercised: all eight cases were run against a local
Chat Completions stand-in and passed, and two mutations — a stand-in that
ignores the tool result, and this build's redaction removed — were each caught
by the case meant to catch them. That is a check on the harness, not a provider
verification, and it is not evidence about any commercial endpoint.

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

### What should never be used as validation

- The temporary 9Router key that appeared in this repository's history. It is to
  be treated as exposed until rotated at the provider, and rotating it is an
  owner action.
- A commercial provider's free tier reached by a route this build does not
  implement. A consumer subscription is not API access.
