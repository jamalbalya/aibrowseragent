# §88 — Connector acceptance tests

> For every connector: connect, scope validation, read, write, auth expiry,
> revocation, rate limit, permission denied, least privilege.

Nine items. Read [README.md](README.md) first.

**"Every connector" means four connectors here.** This repository implements
GitHub, Figma, Jira and Confluence (`src/connectors/adapters/`). Google
Sheets — which §85 E also names — does not exist, and this package does not
pretend the framework's coverage is coverage of it.

This paragraph used to say _"one connector here … and nothing else"_. The nine
items below are still written for GitHub, because GitHub is the only one of the
four with a **write**: the other three are read-only, and not out of caution —
Figma reports nothing about what a token may do, and Atlassian Basic
authentication reports no scopes at all, so a declared write could never be
established and would be refused every time. `88-write` is therefore not
available on them. Section D-2 of `docs/release/OWNER-CHECKLIST.md` is the
procedure for running the other eight items against Figma, Jira or
Confluence.

**The second thing to know before reading any verdict below.** No token from
anybody's account is held here, so no real grant has ever been performed. What
that changes, item by item, is stated rather than averaged out: the protocol is
covered exhaustively in unit tests, the read and write paths against a mock
service, the redirect landing in real Chromium, the token path end to end
including the three states a token's reach can be in, and the credential check
against the **live** service — GitHub's own refusal of a string that is not a
credential for anything, over the network, in real Chromium. What has never
happened is a real token coming back and a read or a write against real data.

**And the blocker was misidentified until now.** This section used to say the
project "owns no registered OAuth application", implying that registering one
would unblock the manual procedures. It would not. GitHub's web application
flow lists `client_secret` as required when exchanging the code; Atlassian
requires one and supports no PKCE at all; Figma requires one even with PKCE.
A secret inside an extension is readable by anyone who unzips it, so this build
carries none and the flow is unreachable here at any registration. It went
unnoticed because without a client id the flow is refused _before it starts_,
so nothing ever reached the step that needs the secret. `docs/connectors.md`
has the table and the vendor sources.

The manual procedures below are rewritten accordingly. They now need a token
the owner creates in their own GitHub account, which is a thing the owner can
actually do.

| Item              | Verdict                                                     |
| ----------------- | ----------------------------------------------------------- |
| Connect           | `AUTOMATED` for every path, `MANUAL` for a real token       |
| Scope validation  | `AUTOMATED`                                                 |
| Read              | `AUTOMATED` against a mock service, `MANUAL` against GitHub |
| Write             | `AUTOMATED` against a mock service, `MANUAL` against GitHub |
| Auth expiry       | `AUTOMATED`                                                 |
| Revocation        | `AUTOMATED` for the extension's side, `MANUAL` for GitHub's |
| Rate limit        | `AUTOMATED`                                                 |
| Permission denied | `AUTOMATED`                                                 |
| Least privilege   | `AUTOMATED`                                                 |

---

## Connect

**Verdict: `AUTOMATED` for every state transition and every failing path, on
both mechanisms. `MANUAL` for a real grant, which needs a token from somebody's
own account — not, as this said before, a registered OAuth application.**

- EVIDENCE: tests/unit/connector-session.test.ts :: has exactly one route into READY
- EVIDENCE: tests/unit/connector-session.test.ts :: never reaches READY on any failing path
- EVIDENCE: tests/unit/connector-session.test.ts :: sends the verifier, and never the challenge, to the token endpoint
- EVIDENCE: tests/unit/connector-session.test.ts :: refuses a callback whose state was forged, and exchanges nothing
- EVIDENCE: tests/unit/connector-session.test.ts :: uses a state exactly once
- EVIDENCE: tests/unit/connector-session.test.ts :: refuses to start at all without an OAuth configuration
- EVIDENCE: tests/e2e/connector.spec.ts :: the authorization flow is refused, and says why rather than being offered
- EVIDENCE: tests/e2e/connector.spec.ts :: the OAuth callback page is reachable by redirect from an authorization server
- EVIDENCE: tests/e2e/connector.spec.ts :: the callback page carries no script that could handle the code itself
- EVIDENCE: tests/unit/connector-token-auth.test.ts :: asks the service while the vault is still empty
- EVIDENCE: tests/unit/connector-token-auth.test.ts :: stores nothing at all when the service refuses the token
- EVIDENCE: tests/unit/connector-token-auth.test.ts :: stores nothing when the service could not be asked, and says which
- EVIDENCE: tests/unit/connector-token-auth.test.ts :: reaches READY only through AUTHENTICATING, like every other route
- EVIDENCE: tests/unit/connector-token-auth.test.ts :: records no scopes and says they were not established
- EVIDENCE: tests/unit/connector-token-auth.test.ts :: refuses every operation that needs a scope
- EVIDENCE: tests/unit/connector-token-auth.test.ts :: is distinguishable from a token the service said has no scopes
- EVIDENCE: tests/unit/connector-token-auth.test.ts :: leaves the old token in place when the new one is refused
- EVIDENCE: tests/unit/connector-token-auth.test.ts :: cannot be reconnected while the service has refused access
- EVIDENCE: tests/unit/connector-token-auth.test.ts :: is in no status the session ever published
- EVIDENCE: tests/e2e/connector.spec.ts :: a token the service refuses leaves nothing connected and nothing stored
- EVIDENCE: tests/e2e/connector.spec.ts :: a token attempt is recorded, and the token is not
- EVIDENCE: tests/integration/connector-workflow.test.ts :: refuses a write it cannot prove the token may do, before sending anything
- EVIDENCE: tests/integration/connector-workflow.test.ts :: writes with a token whose permissions the service did state

`never reaches READY on any failing path` is swept rather than enumerated,
which is the assertion worth trusting: a new failing path added later is
covered by construction rather than by somebody remembering to add a case.

`refuses to start at all without an OAuth configuration` is the honest
behaviour under the missing dependency — the extension says it cannot finish
rather than opening a window that will fail.

**The missing dependency was misidentified, and the correction is above.** This
package used to say a real grant waited on a registered OAuth application. It
does not: GitHub's web application flow requires a `client_secret` in the code
exchange, Atlassian requires one and supports no PKCE, and Figma requires one
even with PKCE — and this extension must not carry a secret. The flow was
therefore unreachable at any registration, which nobody noticed because without
a client id it is refused before it starts. What a real grant waits on is a
token from an account, and the shipped build accepts one.

Three properties of that path are worth reading the cases for. The credential
is **checked before it is stored**, so a refusal leaves the vault untouched and
an eviction mid-connect cannot leave an unverified token that `reconcile` reads
back as a connection. A **refused token and an unreachable service are
different outcomes**, because they send the user to different actions. And a
token's reach has **three** states: GitHub reports a classic token's scopes,
reports nothing for a fine-grained one, and the second records no scopes and
refuses every write rather than claiming what the descriptor asked for.

Two structural facts about this connector that the specification does not ask
for and a reviewer should know: the extension holds no `identity` permission
and `chrome.identity` is genuinely unavailable, and the callback page carries
no script, so the authorization code cannot be handled by the page itself.

- EVIDENCE: tests/e2e/connector.spec.ts :: chrome.identity is genuinely unavailable, not merely unused
- EVIDENCE: tests/e2e/connector.spec.ts :: the extension holds no identity, cookies or webRequest permission

### Procedure C-1 — manual (a real grant)

**Account owner action.** Needs a GitHub account and nothing else. No
application registration: see the correction at the top of this file for why
one would not help.

1. At <https://github.com/settings/tokens>, create a **classic** personal
   access token with the `public_repo` scope. Classic rather than fine-grained
   on purpose — GitHub reports a classic token's scopes in an `x-oauth-scopes`
   header and reports nothing for a fine-grained one, so a fine-grained token
   connects, reads, and refuses every write. Doing this with one is procedure
   C-2.
2. Paste it into Settings → Connectors → GitHub → Connect.
3. Confirm the connector reports connected, names the account, and names the
   scopes **GitHub returned**, not the scopes the descriptor wanted.
4. Confirm no token appears in the service worker log, in the audit list, or in
   any exported audit file.
5. Revoke the token on the same GitHub page afterwards, and confirm procedure
   V-1's behaviour.

Met when the connector is connected with granted scopes displayed and no
credential is visible anywhere. Record the scopes GitHub actually returned —
a service granting less than was asked for is the case
`stores what the service granted, not what was asked for` exists for.

### Procedure C-2 — manual (a token whose reach the service will not state)

**Account owner action.** The other half of the three-state scope behaviour,
and the half no mock can establish: that GitHub really does send no
`x-oauth-scopes` header for a fine-grained token.

1. At <https://github.com/settings/tokens?type=beta>, create a **fine-grained**
   token with read access to one public repository.
2. Paste it in and connect.
3. Confirm the connector reports connected, and that the panel says the service
   did not report what the token may do.
4. Ask the agent to read an issue. Met when the read succeeds.
5. Ask the agent to comment on one. Met when it is refused **before** anything
   is sent, naming the permission that was never established — and not when it
   is attempted and fails at GitHub.

If GitHub does send the header for a fine-grained token, that is a finding and
the behaviour in `readGitHubTokenProbe` should be corrected to match it. Record
what was observed either way.

---

## Scope validation

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/e2e/connector.spec.ts :: reading needs no scope and writing does
- EVIDENCE: tests/unit/connector-session.test.ts :: stores what the service granted, not what was asked for
- EVIDENCE: tests/unit/connector-session.test.ts :: falls back to the requested scopes when the service names none
- EVIDENCE: tests/security/connector-security.test.ts :: refuses an origin the connector never declared

Storing granted rather than requested scopes is the whole item: a connector
that records what it asked for will later believe it can do something the
service never allowed, and will discover otherwise mid-write.

---

## Read

**Verdict: `AUTOMATED` against a mock service over real HTTP. `MANUAL`
against GitHub itself.**

- EVIDENCE: tests/e2e/connector.spec.ts :: the connector is registered, and says how it can be connected
- EVIDENCE: tests/e2e/connector.spec.ts :: connector tools are in the registry the model is offered
- EVIDENCE: tests/e2e/connector.spec.ts :: a model-driven connector call is refused while the connector is not connected
- EVIDENCE: tests/security/connector-security.test.ts :: records a connector operation with the operation name and no arguments

Reporting _unconfigured_ rather than _broken_ matters for a capability that
cannot be finished in this repository: the difference tells a user whether to
fix something or to go and get a credential. For GitHub it now says the latter,
and says where — a token page in the user's own account, rather than an
application registration that would not have helped.

### Procedure R-1 — manual

After C-1. Ask the agent to fetch an issue from a repository you own and
summarise it. Confirm the connector tool was used rather than the browser
navigating to github.com and reading the page — that preference is the shape
§85 D is really about.

---

## Write

**Verdict: `AUTOMATED` against a mock service. `MANUAL` against GitHub
itself.**

- EVIDENCE: tests/e2e/connector.spec.ts :: reading needs no scope and writing does
- EVIDENCE: tests/unit/write-guard.test.ts :: refuses a second attempt while the first is still in flight
- EVIDENCE: tests/unit/write-guard.test.ts :: refuses to replay a write whose outcome is unknown
- EVIDENCE: tests/unit/write-guard.test.ts :: persists the claim before the request, so an eviction leaves a trace

The duplicate-write procedure in [86-security.md](86-security.md) is the
manual half of this item; it is not repeated here.

---

## Auth expiry

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/unit/token-vault.test.ts :: refuses a token that has expired
- EVIDENCE: tests/unit/token-vault.test.ts :: treats a token as expired slightly before it is
- EVIDENCE: tests/unit/token-vault.test.ts :: treats a token with no stated expiry as usable
- EVIDENCE: tests/unit/connector-session.test.ts :: drops out of READY when the grant expires
- EVIDENCE: tests/unit/connector-session.test.ts :: replaces the access token and stays READY
- EVIDENCE: tests/unit/connector-session.test.ts :: keeps the refresh token when the response omits one
- EVIDENCE: tests/unit/token-vault.test.ts :: takes a rotated refresh token when the response carries one

Both refresh shapes are covered because services differ: one omits the refresh
token on renewal and one rotates it, and a client that assumes either will
lock the user out against the other.

The early-expiry margin exists so a token is never used in the window where it
would lapse mid-request — which would surface as a mysterious failure rather
than as an expiry.

---

## Revocation

**Verdict: `AUTOMATED` for what the extension does. `MANUAL` for a real
revocation at GitHub.**

- EVIDENCE: tests/unit/connector-session.test.ts :: goes to NEEDS_AUTH and clears the grant when the refresh is refused
- EVIDENCE: tests/unit/token-vault.test.ts :: leaves nothing behind in storage
- EVIDENCE: tests/unit/token-vault.test.ts :: clears one connector without touching another
- EVIDENCE: tests/e2e/connector.spec.ts :: disconnecting is recorded, with no credential in the record

A revoked grant reaches the extension as a refused refresh, and the response
is to clear the grant and ask again — never to keep trying with a credential
the service has repudiated.

### Procedure V-1 — manual

After C-1. Delete the token at `https://github.com/settings/tokens` — not
`/settings/applications`, which lists authorized OAuth apps and will be empty,
since this build authorises none. Then ask the agent to use the connector. Met
when it reports that authorization is needed and does not retry with the dead
token.

---

## Rate limit

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/unit/budget-retry.test.ts :: retries transient failures with growing backoff
- EVIDENCE: tests/unit/budget-retry.test.ts :: caps the delay at the configured maximum
- EVIDENCE: tests/unit/budget-retry.test.ts :: applies jitter so concurrent tasks do not synchronise
- EVIDENCE: tests/unit/budget-retry.test.ts :: stops at the attempt limit
- EVIDENCE: tests/unit/budget-retry.test.ts :: reads a delay in seconds
- EVIDENCE: tests/unit/budget-retry.test.ts :: reads an HTTP date
- EVIDENCE: tests/unit/budget-retry.test.ts :: clamps a past date to zero rather than returning a negative delay

`Retry-After` arrives in two formats and GitHub uses both across its APIs, so
both are parsed. The clamp exists because a date already in the past would
otherwise produce a negative delay.

---

## Permission denied

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/e2e/connector.spec.ts :: an unknown connector is refused rather than invented
- EVIDENCE: tests/e2e/connector.spec.ts :: a model-driven connector call is refused while the connector is not connected
- EVIDENCE: tests/security/connector-security.test.ts :: refuses every call when there is no usable credential
- EVIDENCE: tests/security/connector-security.test.ts :: refuses a connector built without a transport
- EVIDENCE: tests/unit/budget-retry.test.ts :: never retries a decision, an auth failure, or an invalid input

A denial is a decision, and decisions are never retried. Retrying a denial
would turn one refusal into a series of them, which is how a rate limit is
earned for free.

---

## Least privilege

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/e2e/connector.spec.ts :: reading needs no scope and writing does
- EVIDENCE: tests/e2e/connector.spec.ts :: connector tokens live in session storage, which a content script cannot read
- EVIDENCE: tests/security/connector-security.test.ts :: is sent as an Authorization header
- EVIDENCE: tests/security/connector-security.test.ts :: never appears in a URL
- EVIDENCE: tests/security/connector-security.test.ts :: never appears in a tool result
- EVIDENCE: tests/security/connector-security.test.ts :: never appears in evidence
- EVIDENCE: tests/security/connector-security.test.ts :: never appears in a log line
- EVIDENCE: tests/security/connector-security.test.ts :: never appears in the connector status a caller can read
- EVIDENCE: tests/security/connector-security.test.ts :: is refused by the audit trail if a caller ever tries to record one
- EVIDENCE: tests/unit/token-vault.test.ts :: exposes exactly one credential exit, and no bare-token getter
- EVIDENCE: tests/unit/token-vault.test.ts :: is the only method whose result contains the token
- EVIDENCE: tests/security/connector-security.test.ts :: does not let a caller reach the token by holding the transport
- EVIDENCE: tests/security/connector-security.test.ts :: cannot be displaced by a caller-supplied Authorization header
- EVIDENCE: tests/security/connector-security.test.ts :: can never take the AI provider pin
- EVIDENCE: tests/security/connector-security.test.ts :: does not inherit a provider consent, and a provider does not inherit its own

Least privilege is read here as _the narrowest thing that can hold the token_,
and it is swept across every surface a token could surface on rather than
asserted once. `exposes no method that returns a bare access token` is
asserted over the vault's whole interface, so a method added later that
returned one would fail without anybody remembering this rule.

The redirect rules belong to the same item, because following a redirect is
how a credential leaves the origin it was scoped to:

- EVIDENCE: tests/security/connector-security.test.ts :: never follows one automatically
- EVIDENCE: tests/security/connector-security.test.ts :: refuses one that leaves the declared origins
- EVIDENCE: tests/security/connector-security.test.ts :: refuses a scheme downgrade in a redirect
- EVIDENCE: tests/security/connector-security.test.ts :: refuses the opaque redirect a real browser returns
- EVIDENCE: tests/security/connector-security.test.ts :: stops a redirect loop rather than chasing it
