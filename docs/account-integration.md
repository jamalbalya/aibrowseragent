# Connecting an AI account

This is the authoritative description of how a user gives AI Browser Agent an
AI model to run on, what a Google connection does and does not do, and which
parts have been exercised against a live service.

Two things it establishes up front, because both are easy to assume wrongly:

- **Nothing here is a login.** The extension opens, explores and runs local
  work with no account of any kind. There is a separate, optional product
  sign-in; it is not required, it is absent from every shipped build, and it
  grants no access to any AI service. See [the two Googles](#the-two-googles).
- **Connecting a Google account does not reveal your other AI accounts.** No
  vendor on this list offers an API that, given a Google identity, returns the
  accounts or subscriptions that identity holds elsewhere. Model discovery is a
  different thing and does work — after a credential exists, against that
  credential's own endpoint.

## The journey

Seven steps, and the only one that is optional is the first.

1. Open the side panel. There is nothing to sign in to and nothing is asked.
2. Settings → the provider you hold an account with.
3. Connect it, by the method that provider actually supports — a Google
   authorization for Gemini, a key you create for everything else.
4. The build asks the endpoint which models that credential can use, and
   shows what came back. It never shows a model list of its own.
5. Choose the account and model to run as the agent's brain. An account that
   has none shows **Choose a model** on its own row, which asks that account's
   endpoint with that account's credential — so a connection made in one panel
   session can be completed in another.
6. Run the capability check. It measures that exact pair — this account, this
   model — and the measurement is discarded if either changes. **Selecting a
   model does not measure it**: a task started before the check is refused as
   blocked rather than run on an unverified model.
7. Run a task. The request carries that account's credential and that model id.

Steps 4 to 7 are measured end to end in
`tests/e2e/google-provider-auth.spec.ts :: the whole journey runs with no
product sign-in at any point`, against a local endpoint in real Chromium, with
`auth.status` asserted signed-out throughout.

## What each provider actually supports

Checked against each vendor's own documentation or measured against the live
endpoint. `src/providers/accounts/authorization.ts` is the machine-readable
form of this table and the panel renders from it, so this page and the product
cannot drift.

| Provider          | Google authorization | API key | Models discovered | Why not Google                                            |
| ----------------- | -------------------- | ------- | ----------------- | --------------------------------------------------------- |
| Google Gemini     | **yes**              | yes     | from the endpoint | —                                                         |
| OpenAI-compatible | no                   | yes     | from the endpoint | OpenAI's own flow needs a loopback redirect or a server   |
| Anthropic Claude  | no                   | yes     | from the endpoint | Anthropic prohibits a third party routing a consumer plan |
| 9Router           | no                   | yes     | from the endpoint | It runs no authorization server; it issues its own keys   |

### Google Gemini — the one that works

Google will issue a **Chrome Extension** OAuth client, and Google states that a
client secret "is not applicable to requests from clients registered as
Android, iOS, or Chrome applications". So the authorization is a public client
with PKCE and there is nothing confidential in the extension.

What the build does with it:

- asks Chrome for the **optional** `identity` permission, at the moment the
  user presses the button;
- opens Google's consent screen through `launchWebAuthFlow`;
- exchanges the code at `https://oauth2.googleapis.com/token` with a PKCE
  verifier and no secret;
- stores the access and refresh tokens as that one connection's credential;
- presents the access token as `Authorization: Bearer` to
  `generativelanguage.googleapis.com`, with the configured Cloud project as
  `x-goog-user-project`, and renews it before expiry.

The scope is `https://www.googleapis.com/auth/cloud-platform`, which is the
scope Google's own Gemini OAuth guide uses. It is broad, and the panel says so
rather than narrowing to something that would not work: the narrower documented
scope, `generative-language.retriever`, covers semantic retrieval and cannot
run a model.

**That an access token is a credential this API accepts was measured, not
assumed.** `generativelanguage.googleapis.com/v1beta/models` answers an
unauthenticated request with _"Please use API Key or other form of API consumer
identity to call this API"_ and a bearer-token request with _"Expected OAuth 2
access token, login cookie or other valid authentication credential"_.

**Billing.** API usage is billed to a Google Cloud project, whether authorized
by OAuth or by a key. A Google One AI Premium or Gemini Advanced subscription is
sold for Google's own apps and is **not** an API entitlement; the panel
discloses this before the button.

### OpenAI — a flow that exists and still does not fit

OpenAI has **Sign in with ChatGPT**, and it needs no client secret: the
authorization server advertises `token_endpoint_auth_methods_supported`
including `none`, and the plan-sharing guide says plainly _"you don't need a
client secret or an API key"_.

It cannot be used here, and the blocker is not a secret — it is the redirect
URI. The plan-sharing flow requires `http://127.0.0.1:{port}/callback`, loopback
only, with the scheme, host and path fixed; an MV3 extension cannot listen on a
port. The other variant takes an https redirect, requires a registered client
and a server to receive the callback, and is **identity-only** — OpenAI's own
guide says ChatGPT plan usage "has a separate authorization and registration
flow". An identity sign-in that grants no model access is not worth a
permission.

### Anthropic — prohibited, not merely unavailable

Anthropic states that third-party developers may not offer Claude.ai login in
their own applications, may not route requests through Free, Pro or Max plan
credentials on behalf of their users, and may not collect, store or intermediate
Claude.ai credentials or session tokens. Building it would breach that, so the
build does not, and the panel says why with the source.

API key authentication through the Anthropic Console is the documented path for
a product, and that is what this build offers.

### Everything else

Kimi (Moonshot), DeepSeek, Groq, OpenRouter, Mistral, xAI, Together, Ollama and
LM Studio all speak the OpenAI protocol and all authenticate with a key the user
creates. `src/providers/registry/known-endpoints.ts` prefills their endpoints so
a user does not have to know which protocol their vendor speaks.

## The two Googles

Two buttons in this product say Google. They do different things and the panel
says so in both places.

|                    | Connect with Google            | Sign in with Google                        |
| ------------------ | ------------------------------ | ------------------------------------------ |
| Where              | Settings → Google Gemini       | Account panel                              |
| What it authorizes | Google's Gemini API            | an AI Browser Agent product account        |
| Produces           | a credential the agent runs on | a session                                  |
| Required?          | no — a key works instead       | no, and absent from every shipped build    |
| Needs a backend    | no                             | yes, one this project would have to deploy |
| Grants AI access   | yes, to Gemini only            | **none**                                   |

The product sign-in is in `src/identity/`. The provider authorization is in
`src/providers/oauth/`. They share no state, and
`tests/security/google-provider-auth.test.ts :: names no identity module`
asserts the provider flow imports nothing from the identity layer — so one
cannot quietly become the other.

## The `identity` permission

`launchWebAuthFlow` needs it, and nothing else in this build does.

The permission was previously refused outright, and the reason was good: the
same permission unlocks `chrome.identity.getAuthToken`, which can mint a token
for the **browser profile's own** Google account. That is a capability this
product must never hold. Google registers exactly one redirect for a Chrome
Extension client, `https://<extension-id>.chromiumapp.org/`, which resolves
nowhere and is intercepted only by `launchWebAuthFlow` — so authorizing Gemini
is impossible without it, and `chrome-extension://` is not an accepted Google
redirect.

It is taken in the narrowest form available:

- **optional.** Absent from `permissions`, present in `optional_permissions`,
  requested when the user presses the button, declinable, revocable.
- **`getAuthToken` is left with no client id.** It reads its client id and
  scopes from the manifest's `oauth2` key and this manifest declares none.

Both are measured in real Chromium rather than argued:
`tests/e2e/google-provider-auth.spec.ts :: identity is not granted until asked
for, and getAuthToken cannot work` grants nothing, calls `getAuthToken`, and
asserts no token comes out.

Every connector still uses the tab-watching flow in
`src/connectors/oauth/auth-flow-port.ts`, which needs no permission at all.

## What a connected account holds

|                      | Pasted key              | Authorized with Google                                  |
| -------------------- | ----------------------- | ------------------------------------------------------- |
| Stored at            | `credentials:conn:<id>` | `credentials:oauth:<id>`                                |
| Credential           | one key string          | access token, refresh token, expiry, granted scope      |
| Header               | the vendor's key header | `Authorization: Bearer`, plus `x-goog-user-project`     |
| Expires              | no                      | yes, typically within the hour                          |
| On expiry            | —                       | renewed before the next request, once, and written back |
| On a refused renewal | —                       | reports no credential; does **not** retry               |
| `authKind`           | `api_key`               | `oauth2`                                                |

`credentialForConnection` is the one place that difference is resolved, so the
brain resolver, discovery and the capability doctor all get a usable credential
or nothing, and none of them knows which kind it was. A refused renewal returns
nothing rather than throwing: the caller's refusal is "this needs authorizing
again", which is the truth and names the fix.

The quota project is stored **on the account**, not globally, because two
authorized accounts can belong to different Cloud projects and one paying for
the other's calls is not a detail. It is written at connect time from the
build's configuration and never from a message, and it is **never guessed from
the client id** — the digits at the start of a Google client id usually are a
project number, and "usually" is not a documented mapping for a value that
decides whose quota is spent.

### When an authorization stops working

An access token expires within the hour, and a refusal to renew it is final —
the grant may have been revoked. Three things happen, and the third is what
stops the user being stranded:

- the credential resolver returns nothing, so no request is made with a spent
  token;
- the **account** is marked disconnected with a reason naming the fix, so the
  panel stops showing a healthy row whose every request refuses. The reason is
  not "reconnect its API key" — an authorized account never had one;
- the row offers **Authorize again**, which writes the new token to the **same
  connection**. The model, the consent pin and the audit history stay attached
  to the account the user already had, rather than being stranded on a dead row
  beside a new one with the same label.

The capability measurement is deliberately **not** carried across a
re-authorization. It was taken with a credential that no longer exists, and a
capability carried across a credential change is evidence about one thing read
as a claim about another. The check must be run again, which the panel says.

Re-authorizing is refused unless the named connection is already a Gemini
account authorized with Google — so a Google token can never be attached to an
account that was connected some other way.

Disconnecting clears **both** shapes unconditionally. The failure that would
otherwise be easy is a disconnect that removes the key slot an authorized
account never had and leaves a live refresh token behind.

## Where the requests go

Two origins are reached that no other part of the build reaches, and both are
disclosed in `docs/release/data-flows.md`:

| Origin                              | What is sent                                                      | When                                              |
| ----------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| `accounts.google.com`               | an authorization request the user performs in Chrome's own window | the user pressed Connect with Google              |
| `generativelanguage.googleapis.com` | the task, with the access token and the Cloud project name        | an authorized Gemini account is the agent's brain |
| `oauth2.googleapis.com`             | the code and PKCE verifier, or a refresh token                    | completing or renewing that authorization         |

Both go through the egress gate on a channel of their own, `provider_auth`,
with an opaque payload policy so neither the code nor the refresh token reaches
an evidence digest. The destination is pinned: a token exchange aimed at any
other origin yields a `null` destination identity, which the gate denies by the
same rule that denies every unrecognisable destination.

## Does the Gemini API accept a bearer token? What is actually known

This was the one open question from the previous pass, and it is now narrowed
to a single thing an owner can settle. The four evidence classes are kept
apart on purpose.

### Confirmed by Google's own documentation

- **A Chrome Extension OAuth client carries no secret.** Google: a client
  secret "is not applicable to requests from clients registered as Android,
  iOS, or Chrome applications".
- **A user-credential call must name a quota project.** Google: _"When you
  provide user credentials to authenticate to a client-based API, you must
  specify the project to use for billing and quota… If your API call returns an
  error message saying that user credentials are not supported or that the
  quota project is not set, you must explicitly set the quota project by
  including the `x-goog-user-project` header."_ Google's own Gemini OAuth
  quickstart sends that header beside the bearer token.
- **`cloud-platform` is the scope Google's Gemini OAuth guide uses.** The
  narrower documented alternative, `generative-language.retriever`, covers
  semantic retrieval and cannot run a model.

### Confirmed by probing the live endpoint with no credential

Two `curl` calls, carrying a literal that is not a credential for anything:

| Request                                                                                   | Answer                                                                                                                                          |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1beta/models`, no authorization                                                    | `403` — _"Method doesn't allow unregistered callers… Please use API Key or other form of API consumer identity"_                                |
| `GET /v1beta/models`, `Authorization: Bearer <literal>`                                   | `401 UNAUTHENTICATED` — _"Expected OAuth 2 access token, login cookie or other valid authentication credential"_, `reason: CREDENTIALS_MISSING` |
| `POST /v1beta/models/gemini-2.5-flash:generateContent`, `Authorization: Bearer <literal>` | the same `401`, naming `google.ai.generativelanguage.v1beta.GenerativeService.GenerateContent`                                                  |

The third row is the one that matters and it is new. **`generateContent`
itself** — not just the model list — answers a bearer request by rejecting the
token's _validity_, and names the scheme it expected. A method that did not
accept bearer authentication at all would not say that.

**A correction to the previous record.** It said Google's discovery document
"declares no OAuth scope for `generateContent`", implying OAuth might not cover
it. That reading was too strong. The discovery documents for `v1` and `v1beta`
declare scopes for **seven and thirteen** methods respectively, all of them
file, cache or media operations, and all naming only
`devstorage.read_only` — a vestigial entry. The document does not describe this
API's OAuth scoping **at all**, so its silence about `generateContent` is not
evidence either way. The live probe above is the better evidence, and it points
the other way.

### Tested here with mocks and non-credential literals only

- The whole authorization: PKCE, the callback checks, the scope refusal, the
  renewal, the refusal to retry a refused renewal — 49 unit cases and 21
  integration cases over the real stack.
- The request shape: a bearer token in `Authorization` and never in
  `x-goog-api-key`, the quota project in `x-goog-user-project` and only
  alongside a bearer credential, and neither in a URL.
- Every refusal message, including the two that would otherwise send an owner
  the wrong way: Google's quota-project complaint, and a client registered for
  a different extension id.

### Still unverified, and exactly what would settle it

**Whether a validly issued `cloud-platform` token, with a quota project naming
a Cloud project that has the Generative Language API enabled, is accepted for
`generateContent`.** Nothing short of a real authorization can establish it,
and this repository holds no Google OAuth client.

The minimal procedure is `docs/release/OWNER-CHECKLIST.md` G-6 step 4.4: with a
configured build, connect a Google account, choose a model, and run one task.
If it answers, the question is closed. If Google refuses, the message is the
finding — the extension already turns the two refusals it can anticipate into
sentences naming the fix, and anything else should be reported verbatim.

## The journey's order, and the defect that made it impossible

The journey in §1 is: connect, see what this credential can actually reach,
choose a model. On 3 October 2026 that was found to be **impossible for two of
the four providers**, and it had been all along.

`connect` on the Gemini and Anthropic adapters refused a credential with no
model — `INVALID_ARGUMENT: A model id is required` — so a user had to know a
model id before they could ask what the model ids were. On Gemini that is
worse than circular: the three ids the vendor lists first are all models
Google has retired, so the obvious guess fails and the error used to send the
user back to the list that offered it.

It also made the two connection paths disagree. A Google authorization has
always produced an account with `modelId: null`, left for
`resolveBrainAccount` to refuse until a model is chosen. The pasted-key path
refused to produce the same thing.

The requirement now belongs to the operations that use a model. `connect`
validates the credential; `generate` and `stream` refuse with _"choose a model
for this account before running a task"_ before a request is built. Gemini puts
the model in the request path and Anthropic in the request body, so without
the guard the first would have built `/models/:generateContent` and the second
would have omitted the field — in both cases spending a vendor round trip on
something already known locally.

Why it took a real vendor and a real browser to see: every adapter test
supplied a model, because the adapter demanded one. The live harness even
carried a `'probe-placeholder'` model for exactly this reason, which is a
workaround written in place of a bug report.

## What has been exercised live

On 3 October 2026 this journey was driven against the real Gemini API with a
real key, which is what the table below used to say had never happened for any
part of it.

| Step                                      | Result                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect with a Gemini API key             | Works. `x-goog-api-key`, 200.                                                                                                                                                                                                               |
| Discover the models the connection offers | Works. 44 generative models through the adapter's own `listModels`.                                                                                                                                                                         |
| Select one and measure it                 | Works. The capability doctor measured `tools=pass streaming=pass vision=pass` against the live endpoint.                                                                                                                                    |
| Run the agent on it                       | **Was impossible, and is now fixed.** Every tool schema in this build carries `additionalProperties`, which Google's `Schema` type rejects by name — so tool calling failed, Gemini reported `CHAT_ONLY`, and the agent was disabled on it. |
| A bearer token on an API-key endpoint     | Refused, as designed: `401 … Expected OAuth 2 access token`. The two credential schemes are genuinely not interchangeable, which this build already assumed and can now say it has checked.                                                 |

On 3 October 2026 the same journey was driven again **inside the extension**,
through the account routes rather than the adapter, against two different
vendors. What that added:

| Step                                     | Result                                                                                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts.connect` with no model         | Accepted, after the fix above. Returns an account with `modelId: null`.                                                                                              |
| `accounts.listModels`                    | **44 models from Google, 466 from a commercial gateway** — real discovery through the extension's own route, not a fixture's idea of a catalogue.                    |
| `accounts.setBrain`                      | The chosen model is recorded and the account becomes the brain.                                                                                                      |
| `accounts.runDoctor`                     | `AGENT_READY` on both vendors, measured from inside the service worker.                                                                                              |
| A task, the brain switched, another task | The second task records `providerId: openai-compatible` and completes. **The switch took effect at the vendor** — which two real companies are the only way to show. |
| `accounts.list`                          | Both accounts, neither row carrying a credential.                                                                                                                    |
| `accounts.disconnect`                    | The removed account is gone and the brain stays on the survivor: no silent fallback, no stranding.                                                                   |
| A credential the vendor rejects          | An account is created and the capability doctor reports `FAILED` with the credentials check failing. The rejected key is not echoed back.                            |

Evidence: `tests/e2e/live-provider-in-browser.spec.ts`, opt-in on
`ABA_E2E_GEMINI_KEY` and `ABA_E2E_OPENROUTER_KEY`.

Two further things the endpoint taught, both now handled:

- Google **lists models it will not run** — `gemini-2.5-flash`,
  `gemini-2.5-pro` and `gemini-2.5-flash-lite` are the first three generative
  entries and each answers `404 … no longer available to new users`. Nothing in
  this build pre-selects a model, so nobody is steered onto one; and the
  refusal now says the model is retired rather than telling the user to check
  the list that offered it.
- Google **serves `:streamGenerateContent` on models whose entry omits it**, so
  the absence of that method is no longer read as a denial.

## What has not been exercised live

|                                                         | Why                                                                                                                                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A real Google authorization                             | Needs an OAuth client registered to this extension's id. This repository holds none, and registering one is an owner action — `docs/release/OWNER-CHECKLIST.md` section G-6. |
| A real Gemini API call with an OAuth token              | Needs the above, plus a Cloud project with the Generative Language API enabled.                                                                                              |
| Whether a valid token is accepted for `generateContent` | Needs a real authorization. The scheme is accepted and the quota-project header is now sent; see the section above for what is known and what would settle it.               |

The shipped build therefore reports the Google method as **not available, with
a reason**, and offers the Gemini API key path instead. That is what
`tests/e2e/google-provider-auth.spec.ts :: connecting a Google account is
refused honestly in this build` asserts: a named refusal and a sentence that
sends the user to something that works, not a button that opens Google's own
error page.
