# Email one-time-code authentication

_Status: implemented. **Production email delivery is not configured**, so no
build in this repository can send a code to a real mailbox. See §11._

This document describes the second authentication method AI Browser Agent
supports. It is a **method inside the existing authentication architecture**,
not a second architecture: accounts, identities, sessions, rotation, reuse
detection, devices and authorization are exactly the ones
`IDENTITY_AUTH_ARCHITECTURE.md` specifies, and nothing here re-decides any of
them.

---

## 1. The flow

```
  POST /v1/auth/email/start    { email }
       → 200 { challengeId, expiresAt, resendAvailableAt }
       → a six-digit code is mailed to the address

  POST /v1/auth/email/verify   { challengeId, code, deviceId? }
       → 200 { abaUserId, accessToken, refreshToken, … , email }
       → 401 { error, reason, remainingAttempts }
```

Two steps rather than Google's three, because there is no external
authorization server and therefore no redirect to come back from. The proof of
control is the code, and the code goes to the mailbox.

**No value from this flow ever reaches a URL.** Not the code, not the challenge
id, not a token. Both routes are `POST` with a JSON body, and neither returns a
redirect.

---

## 2. The code

Six decimal digits, drawn by rejection sampling from the platform CSPRNG so the
distribution is uniform over all 10⁶ values (`server/app/otp.ts`). Leading
zeros are preserved, which keeps a tenth of the space that naive integer
formatting would silently discard.

The space is small, and that is the whole reason for everything in §3. A
six-digit code is made strong by being single-use, TTL-bounded,
attempt-bounded and rate-limited — properties of the flow, not of the number.
Remove any one and the arithmetic stops working.

Comparison is constant-time (`timingSafeEqual`). An early-exit `===` leaks a
prefix, and a prefix oracle turns a million guesses into sixty.

---

## 3. The controls, and what each one is for

| Control                     | Value             | What it stops                                               |
| --------------------------- | ----------------- | ----------------------------------------------------------- |
| TTL                         | 10 minutes        | A code read from an old message, or a mailbox later lost    |
| Verification attempts       | 5 per challenge   | Guessing one code                                           |
| Single use                  | consumed on match | Presenting a captured code a second time                    |
| Resend invalidates          | always            | A resend loop accumulating simultaneously valid codes       |
| Sends per address           | 5 per 15 minutes  | Mailing a stranger repeatedly                               |
| Resend cooldown per address | 1 per 30 seconds  | A misfiring retry loop spending the whole allowance at once |
| Starts per caller           | 20 per 15 minutes | One caller starting sign-ins against many addresses         |
| Verifications per caller    | 50 per 15 minutes | Minting codes so that each may be guessed once              |
| Live challenges             | 10 000            | Allocating server memory from an unauthenticated route      |

Rate limiting is **not** deferred. An OTP endpoint without it is a free email
cannon aimed at anybody whose address the caller knows, and the window in
which it is missing is the window in which it is abused.

---

## 4. Why an OTP is never stored

Every other piece of authentication state in this backend is a row in
`server/db/schema.ts`. An OTP challenge deliberately is not, and the reason is
the size of the secret.

A refresh token is 256 bits of CSPRNG output, so storing its digest is a real
defence: an attacker holding the database cannot recover the token. A six-digit
code has a million candidates. **Any** representation of it that reaches
durable storage — the code, a hash, a salted digest — falls to a search that
finishes before a page loads. There is no hash that fixes this, which is why
`server/app/token.ts`'s note about introducing Argon2id for this phase was not
acted on: the primitive was never the problem.

So the code is classified **TRANSIENT** and the classification is enforced
structurally rather than by care. `server/app/otp-challenge-store.ts` has no
table, no column, no migration, no `Store` method and no serialisation of any
kind. A process restart loses every open challenge, which is correct: the
person asks for a new code, at a cost of one email.

`login_challenge` — which already permits `method = 'email'` — is deliberately
**not** used. It is a durable table, and a durable table is precisely what an
OTP must not touch.

---

## 5. Atomicity

`attempt` is the only operation that can complete a sign-in. It does all of its
reading, counting and removal in a single synchronous block with no `await`
inside it, so JavaScript runs it to completion before any other task and the
second of two concurrent presentations necessarily finds the challenge gone.
Concurrent verification of one valid code therefore succeeds **at most once**.

That is a genuine guarantee for a single-process, in-memory store, and it is
**not** a guarantee across processes. A multi-instance deployment needs a
shared store with a compare-and-set, exactly as `Store.claimSessionRotation`
already documents for sessions. The same applies to the rate limiter: it is per
process, so the effective limit multiplies by the instance count.

---

## 6. Identity

An email identity is `kind: 'email'`, `subject: null`, `email_verified: true`.
It therefore occupies the subjectless branch of `auth_identity_email_key`,
which is what makes "one account per verified address" a database constraint
rather than a convention.

Accounts are created at **verification**, never at start. Attachment goes
through `IdentityService.attachIdentity`, so the linking rules, the
`IDENTITY_IN_USE` refusal and the uniqueness race are the tested ones.

**A Google identity and an email identity carrying the same address do not
merge, and neither unlocks the other.** A Google `sub` proves control of a
Google account; a code proves control of a mailbox; a shared address string is
not a proof of either (AUTH-27). One person may therefore end up with two
accounts — visible, annoying and repairable through the explicit link flow.
The alternative, merging, is unrecoverable and would let a domain that
reassigned an address hand over somebody else's account.

---

## 7. Enumeration

`start` performs **no account lookup at all**. It does not ask whether the
address is known, because it does not need to — an account comes into existence
at verification. There is therefore no account-dependent branch, no
account-dependent work and no account-dependent response.

That is a stronger statement than "the responses look the same", and it is the
one made here. It is **not** a claim about wall-clock indistinguishability
under load, which nothing in this repository measures and which is therefore
not claimed.

`verify` reports the state of **the caller's own challenge** — wrong code,
expired, attempts spent — because the challenge id is a 128-bit opaque value
this server minted and handed to exactly one client, so telling that client
about its own challenge reveals nothing to anybody else. The outcomes that
_would_ reveal something — an address already held by another account, an
account in the deleted state — are collapsed into one `UNAVAILABLE`.

**Residual, stated rather than claimed away:** a rate-limit refusal on `start`
reveals that _someone_ recently requested a code for that address. Per-address
limiting is required, so this cannot be removed without removing the control.

---

## 8. Unicode and IDN are open, so non-ASCII addresses are refused

Whether `é` and its decomposed form are one address, and whether a punycode
domain and its Unicode spelling are one domain, are **open** questions that the
email identity decision gate deliberately left open.

Accepting such an address now would settle them by default: whatever bytes
arrived would become the stored identity, and any later normalisation rule
would then either merge two existing accounts or split one. So `start` refuses
a non-ASCII address.

This is a **stated limitation of the current build, not a decision about the
policy.** Refusing is reversible; merging is not — the same asymmetry that
decided the local-part rule. A punycode domain, being ASCII, is accepted as the
literal domain it is; nothing maps between it and its Unicode spelling, and
that absence is the open question, not an answer to it.

Canonicalisation is `normaliseEmail` and nothing else: local part byte for
byte, domain lowercased, surrounding whitespace trimmed, interior whitespace
refused. No dot stripping, no `+tag` removal, no provider-specific rewriting,
no NFC or NFKC.

---

## 9. What the extension holds

The code is an argument to `EmailSignIn.verify`, becomes a request body, and is
gone when the call returns. It is never written to `chrome.storage.local`,
never to `chrome.storage.session`, never to the session store, never to the
identity profile, never onto a task, workflow or audit record, and never into a
log line. The panel holds it in React state on a view that closes.

The challenge id is held the same way — in panel state, not in storage. A
worker restart or a closed panel loses the in-flight sign-in, and the person
asks for a new code. Persisting a handle to a live authentication across
restarts would be the worse trade.

Both routes are `CLASS_B_PANEL_CONTROL_PLANE`: no content script, no page and
no model can reach either. An authentication a page could start is an
authentication a page could start without the user.

---

## 10. Logging

`LOGGABLE_FIELDS` is an allowlist, so the code and the address have no field to
travel in — the allowlist fails closed, and the worst outcome of a field nobody
anticipated is a missing diagnostic. `emailDomain` is loggable because
"deliveries to this domain are failing" is a real operational question; the
address is not.

---

## 11. Delivery is not configured

`server/app/email-delivery.ts` declares a port and ships **no implementation**.
The default, `unconfiguredDelivery`, reports `configured: false`, and a backend
wired with it has no email routes at all — they answer 404, exactly as the
Google routes do without Google credentials.

**No mail-provider credential exists in this repository, none is configured,
and live delivery has never been exercised.** The end-to-end suite runs against
a recording transport that keeps the message instead of sending it, which
proves the flow between this extension and this backend and proves nothing
about deliverability. This is reported as unconfigured rather than claimed as
working.

A deployment supplies an adapter. It must not fail the sign-in by throwing: a
throwing adapter is treated as a failed send, the challenge is discarded, and
the caller is told, rather than left waiting for a message that is not coming.

---

## 12. The rate-limiting source

`createAuthRouter` requires a `sourceOf(request)`. It is required even for a
deployment with no email sign-in, on purpose: an optional field is one a
deployment forgets, and email routes would then ship with every caller sharing
one counter — either no protection or a global denial of service — with nothing
having failed to make that visible.

What it returns is whatever the deployment genuinely knows: a peer address, a
proxy-supplied client address it trusts, a tenant id. It is used for counting
and nothing else — never stored, never logged, never compared against an
account, and it authorises nothing. A wrong value weakens a limit; it cannot
grant access.

---

## 13. What this phase did not do

- **Cloud Sync.** Untouched.
- **Account deletion.** Still deferred, still blocked on the audit hash chain.
- **The Unicode / IDN / confusables decision.** Still open (§8).
- **Chrome Web Store submission.** Not attempted.
- **A PostgreSQL deployment, or any deployment infrastructure.** None added.
- **A second authentication architecture.** Sessions, rotation, reuse
  detection, logout, devices and `Principal` are the existing ones.
