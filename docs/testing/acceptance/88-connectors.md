# §88 — Connector acceptance tests

> For every connector: connect, scope validation, read, write, auth expiry,
> revocation, rate limit, permission denied, least privilege.

Nine items. Read [README.md](README.md) first.

**"Every connector" means one connector here.** This repository implements
GitHub (`src/connectors/adapters/github.ts`) and nothing else. Jira,
Confluence, Figma and Google Sheets — which §85 D and E name — do not exist,
and this package does not pretend the framework's coverage is coverage of
them.

**The second thing to know before reading any verdict below.** This project
owns no registered OAuth application, so no real grant has ever been
performed. What that changes, item by item, is stated rather than averaged
out: the protocol is covered exhaustively in unit tests, the read and write
paths against a mock service, the redirect landing in real Chromium, and the
extension's refusal to start a flow it cannot finish. What has never happened
is a human approving a consent screen at github.com and a real token coming
back.

| Item              | Verdict                                                     |
| ----------------- | ----------------------------------------------------------- |
| Connect           | `AUTOMATED` for every path, `MANUAL` for a real grant       |
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

**Verdict: `AUTOMATED` for every state transition and every failing path.
`MANUAL` for a real grant, which needs a registered OAuth application.**

- EVIDENCE: tests/unit/connector-session.test.ts :: has exactly one route into READY
- EVIDENCE: tests/unit/connector-session.test.ts :: never reaches READY on any failing path
- EVIDENCE: tests/unit/connector-session.test.ts :: sends the verifier, and never the challenge, to the token endpoint
- EVIDENCE: tests/unit/connector-session.test.ts :: refuses a callback whose state was forged, and exchanges nothing
- EVIDENCE: tests/unit/connector-session.test.ts :: uses a state exactly once
- EVIDENCE: tests/unit/connector-session.test.ts :: refuses to start at all without an OAuth configuration
- EVIDENCE: tests/e2e/connector.spec.ts :: authorizing refuses honestly when no OAuth application is configured
- EVIDENCE: tests/e2e/connector.spec.ts :: the OAuth callback page is reachable by redirect from an authorization server
- EVIDENCE: tests/e2e/connector.spec.ts :: the callback page carries no script that could handle the code itself

`never reaches READY on any failing path` is swept rather than enumerated,
which is the assertion worth trusting: a new failing path added later is
covered by construction rather than by somebody remembering to add a case.

`refuses to start at all without an OAuth configuration` is the honest
behaviour under the missing dependency — the extension says it cannot finish
rather than opening a window that will fail.

Two structural facts about this connector that the specification does not ask
for and a reviewer should know: the extension holds no `identity` permission
and `chrome.identity` is genuinely unavailable, and the callback page carries
no script, so the authorization code cannot be handled by the page itself.

- EVIDENCE: tests/e2e/connector.spec.ts :: chrome.identity is genuinely unavailable, not merely unused
- EVIDENCE: tests/e2e/connector.spec.ts :: the extension holds no identity, cookies or webRequest permission

### Procedure C-1 — manual (a real grant)

**Account owner action.** Requires registering an OAuth application on GitHub
and configuring its client id — see `docs/connectors.md`.

1. Register an OAuth app with the callback URL the extension serves
   (`chrome-extension://<id>/oauth/callback.html`, the id from the README
   setup).
2. Configure the client id in settings and start the authorization.
3. Approve at github.com.
4. Confirm the connector reports connected and names the scopes **GitHub
   granted**, not the scopes requested.
5. Confirm no token appears in the service worker log or in any exported audit
   file.

Met when the connector is connected with granted scopes displayed and no
credential is visible anywhere. Record the scopes GitHub actually returned —
a service granting less than was asked for is the case
`stores what the service granted, not what was asked for` exists for.

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

- EVIDENCE: tests/e2e/connector.spec.ts :: the connector is registered, and reports itself unconfigured rather than broken
- EVIDENCE: tests/e2e/connector.spec.ts :: connector tools are in the registry the model is offered
- EVIDENCE: tests/e2e/connector.spec.ts :: a model-driven connector call is refused while the connector is not connected
- EVIDENCE: tests/security/connector-security.test.ts :: records a connector operation with the operation name and no arguments

Reporting _unconfigured_ rather than _broken_ matters for a capability that
cannot be finished in this repository: the difference tells a user whether to
fix something or to go and register an application.

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

After C-1. Revoke the authorization at
`https://github.com/settings/applications`, then ask the agent to use the
connector. Met when it reports that authorization is needed and does not
retry with the dead token.

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
- EVIDENCE: tests/unit/token-vault.test.ts :: exposes no method that returns a bare access token
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
