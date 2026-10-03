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
5. Choose the account and model to run as the agent's brain.
6. Run the capability check. It measures that exact pair — this account, this
   model — and the measurement is discarded if either changes.
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
  `generativelanguage.googleapis.com`, and renews it before expiry.

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
| Header               | the vendor's key header | `Authorization: Bearer`                                 |
| Expires              | no                      | yes, typically within the hour                          |
| On expiry            | —                       | renewed before the next request, once, and written back |
| On a refused renewal | —                       | reports no credential; does **not** retry               |
| `authKind`           | `api_key`               | `oauth2`                                                |

`credentialForConnection` is the one place that difference is resolved, so the
brain resolver, discovery and the capability doctor all get a usable credential
or nothing, and none of them knows which kind it was. A refused renewal returns
nothing rather than throwing: the caller's refusal is "this needs authorizing
again", which is the truth and names the fix.

Disconnecting clears **both** shapes unconditionally. The failure that would
otherwise be easy is a disconnect that removes the key slot an authorized
account never had and leaves a live refresh token behind.

## Where the requests go

Two origins are reached that no other part of the build reaches, and both are
disclosed in `docs/release/data-flows.md`:

| Origin                  | What is sent                                                      | When                                      |
| ----------------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| `accounts.google.com`   | an authorization request the user performs in Chrome's own window | the user pressed Connect with Google      |
| `oauth2.googleapis.com` | the code and PKCE verifier, or a refresh token                    | completing or renewing that authorization |

Both go through the egress gate on a channel of their own, `provider_auth`,
with an opaque payload policy so neither the code nor the refresh token reaches
an evidence digest. The destination is pinned: a token exchange aimed at any
other origin yields a `null` destination identity, which the gate denies by the
same rule that denies every unrecognisable destination.

## What has not been exercised live

|                                                               | Why                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A real Google authorization                                   | Needs an OAuth client registered to this extension's id. This repository holds none, and registering one is an owner action — `docs/release/OWNER-CHECKLIST.md` section G-6.                                                                                 |
| A real Gemini API call with an OAuth token                    | Needs the above, plus a Cloud project with the Generative Language API enabled.                                                                                                                                                                              |
| Whether an OAuth-authorized call needs a quota project header | Google's discovery document declares no OAuth scope for `generateContent` or `models.list`, and the documented OAuth quickstart covers retrieval. The bearer scheme is accepted; whether every method is, on every project configuration, is **unverified**. |

The shipped build therefore reports the Google method as **not available, with
a reason**, and offers the Gemini API key path instead. That is what
`tests/e2e/google-provider-auth.spec.ts :: connecting a Google account is
refused honestly in this build` asserts: a named refusal and a sentence that
sends the user to something that works, not a button that opens Google's own
error page.
