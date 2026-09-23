# Identity and Authentication Architecture

Status: **partly implemented.** The status line above this one used to read
"design only", and that is no longer true.

| Part of this design                                                                                   | State                                                                  |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Accounts, identities, sessions, devices (domain + schema)                                             | **implemented** in `server/`                                           |
| Google sign-in, end to end                                                                            | **implemented** (`server/app/google-auth-service.ts`, `src/identity/`) |
| Local half — `SessionStore`, `IdentityProfileStore`, `evaluateSession`, connection-scoped credentials | **implemented**                                                        |
| Email OTP                                                                                             | not built                                                              |
| Account-linking UI                                                                                    | not built                                                              |
| Cloud Sync, K1                                                                                        | not built                                                              |
| The HTTP surface for the Google routes                                                                | **implemented** (`server/http/router.ts`)                              |
| A deployed backend, a running database, real Google credentials                                       | **not deployed / credential-blocked**                                  |

Everything implemented is implemented **optionally**: a build with no
configured backend origin has no authentication, and the extension is fully
usable without it. See `LOCAL_FIRST_ARCHITECTURE.md` §6, which governs the
question of what is required to run the product.

This is the fourth document in the identity chain and the last one before
implementation:

| Document                 | Owns                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `IDENTITY_AND_SYNC.md`   | the original design review; local stores; data classification                                        |
| `K1_E2EE_DESIGN.md`      | encryption: recovery key, KEK, DEKs, envelopes, AAD                                                  |
| `CLOUD_SYNC_PROTOCOL.md` | the sync protocol, device rows, sync tables, purge quorum                                            |
| **this document**        | **identity, authentication, sessions, device registration's authentication half, account lifecycle** |

Where those documents already decide something, this one cites rather than
restates. Where this one is the owner — the `session` table, the auth
endpoints, the challenge records — it says so.

---

## 1. The governing separation

Everything in this document follows from one rule, stated in
`IDENTITY_AND_SYNC.md` and unchanged here:

```
authentication session  !=  ABA user account  !=  AI connections
                        !=  provider credentials  !=  user work
```

Five lifecycles. None may be coupled to another. Expanded into the three chains
the product actually has:

```
  AUTH SESSION                ABA USER ACCOUNT            ABA USER ACCOUNT
       │                            │                           │
       ▼                            ▼                           ▼
  ABA USER ACCOUNT              AI CONNECTIONS               USER WORK
       │                            │                           │
       ▼                            ▼                           ▼
     DEVICES                LOCAL PROVIDER CREDENTIALS   TASKS · WORKFLOWS
       │                      (SECRET_LOCAL_ONLY)        SHORTCUTS · WORKSPACES
       ▼                                                        │
  CLOUD SYNC RECORDS                                            ▼
                                                        encrypted under K1
```

And, separately and deliberately disconnected from all three:

```
  USER RECOVERY KEY  ──HKDF-SHA-256──▶  KEK  ──▶  per-record DEK  ──▶  AES-256-GCM
```

**Authentication appears nowhere in that derivation.** Not as input, not as
salt, not as a wrapping key, not as a gate. That absence is the whole point of
§5 and is asserted by `AUTH-3`.

### What each arrow means, and what it does not

| Arrow                   | Means                                                 | Does **not** mean                                                               |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| session → account       | this session acts for this `abaUserId`                | the session _is_ the account, or can outlive it, or can rename it               |
| account → devices       | these installations belong to this account            | a device authorises anything; `deviceId` is provenance (Cloud Sync §5)          |
| account → sync records  | this partition belongs to this account                | the backend can read them                                                       |
| account → connections   | these AI accounts are scoped to this user for display | the connection is authorised by the ABA account, or vice versa                  |
| connection → credential | this credential is reached at `credentials:conn:<id>` | the credential is ever part of the connection record, or ever leaves the device |
| recovery key → KEK      | this key decrypts this user's work                    | authentication can produce it, or the backend can                               |

---

## 2. Compatibility with the approved documents

This design was checked line by line against the three documents it must not
contradict. The result is **no live contradiction**, and two things that must
be said out loud rather than quietly resolved.

### 2.1 Superseded wording in `IDENTITY_AND_SYNC.md` — reported, not silently overwritten

`IDENTITY_AND_SYNC.md` was written before K1 was designed. Three passages in it
describe a **user passphrase with PBKDF2-SHA256**:

| Location                | Stale wording                                          |
| ----------------------- | ------------------------------------------------------ |
| §D, options table       | "K1 — user sync passphrase, PBKDF2-SHA256 → AES-GCM"   |
| §D, closing paragraph   | "Losing the passphrase loses the ciphertext's meaning" |
| §H–J, recovery sequence | "passphrase requested (K1)"                            |

`K1_E2EE_DESIGN.md` v2 replaced the passphrase with a **generated 128-bit
recovery key** and deleted the password KDF entirely (K1 §7.1, §7.2), and v3 is
the approved baseline at `7e7a72b`. The approved product decision was explicit:
_"Do NOT implement a user passphrase in K1 v1."_

**This is a superseded statement, not an unresolved conflict.** The question it
appears to raise was already decided, by the account owner, in favour of the
generated key. This document therefore builds on K1 v3 and does not choose
between the two — there is nothing left to choose. It is reported here because
a reader arriving at `IDENTITY_AND_SYNC.md` §D first would otherwise believe
K1 uses a passphrase, and that belief would produce the wrong login screen.

**Recommended follow-up, not performed here:** correct those three passages in
`IDENTITY_AND_SYNC.md` to name the recovery key. This task's scope is one new
file, so no edit was made. Nothing in the present document depends on that
correction happening first.

### 2.2 Where a password KDF belongs, and where it does not

`IDENTITY_AND_SYNC.md` §T and §U specify **Argon2id** for the OTP hash and the
refresh-token hash. `K1_E2EE_DESIGN.md` §7.3 states **no Argon2id** and no
WebAssembly, and the approved decisions forbid `wasm-unsafe-eval`.

Both stand, and the rule that reconciles them is not "client versus server" —
it is **the entropy of the input**, applied consistently wherever a secret is
stored or derived:

| Where                                     | Primitive                        | Why                                                                                                                                                                                |
| ----------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **extension (client)** — recovery key     | HKDF-SHA-256 only, via WebCrypto | a uniform 128-bit secret has no guess space to make expensive (K1 §7.1); and WebCrypto has no Argon2id, which would require WASM and a CSP change                                  |
| **backend** — email OTP, and any password | **Argon2id**                     | six digits is roughly twenty bits and a password is worse; both are enumerable, so multiplying the cost of each guess is exactly the control (§8.1, §8.2)                          |
| **backend** — refresh token               | SHA-256, domain-separated        | 256 bits of server-generated CSPRNG output, untruncated at every stage. There is no enumerable space for a work factor to act on, and the token is single-use and revocable (§6.6) |

`IDENTITY_AND_SYNC.md` §U's blanket "argon2id" for the refresh-token hash is
**superseded by §6.6**, which was reviewed against the implementation rather
than assumed. The OTP half of that line stands unchanged.

The client rule is therefore precise and unaffected: **no password-hashing
primitive runs in the extension, and the CSP is unchanged.** `AUTH-15` asserts
it.

### 2.3 Everything else, verified consistent

| Claim                                                       | Source                                                        | This document                   |
| ----------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------- |
| access 15 min, refresh 30 d rolling                         | `IDENTITY_AND_SYNC.md` §B                                     | §6, unchanged                   |
| 7-day offline grace                                         | §B, §O–R; K1 §19A; Cloud Sync §22; `OFFLINE_GRACE_MS` in code | §9, unchanged                   |
| `abaUserId` resolved by `google_sub`, then verified email   | §H–J                                                          | §4.3, unchanged                 |
| a different `abaUserId` is refused, never overwritten       | `IdentityProfileStore.recordSignIn`                           | §4.4, unchanged                 |
| `deviceId` is `dev_` + `randomUUID()`, not an authenticator | K1 §16; Cloud Sync §5                                         | §11, unchanged                  |
| reinstall → same `abaUserId`, new `deviceId`                | K1 §18; Cloud Sync §20                                        | §10, §11                        |
| logout deletes nothing                                      | K1 §20; Cloud Sync §21                                        | §14, unchanged                  |
| account deletion is two erasures                            | K1 §21; Cloud Sync §29                                        | §15, unchanged                  |
| provider keys `SECRET_LOCAL_ONLY`, never uploaded           | K1 §12, §26; Cloud Sync §20                                   | §17, unchanged                  |
| `session` table is owned by the authentication design       | Cloud Sync §14, explicitly                                    | §23 — **owned here**            |
| device rows and `POST /v1/devices` belong to Cloud Sync     | Cloud Sync §5, §15                                            | §22 — referenced, not redefined |
| no `chrome.identity` permission                             | `auth-flow-port.ts`                                           | §7.5, unchanged                 |

No endpoint, table, lifetime or invariant in this document replaces one already
defined elsewhere.

---

## 3. What the backend is, and is not

The AI Browser Agent backend exists to answer one question — _which ABA user is
this?_ — and to hold ciphertext it cannot read.

| It does                                               | It does not                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------- |
| authenticate a person as an `abaUserId`               | authorise any AI provider                                   |
| issue and revoke sessions                             | hold, proxy, mint or validate a provider API key            |
| own the device registry's authorization               | decide what the agent may do in the browser                 |
| store encrypted sync records                          | decrypt them, or hold any key that could                    |
| enforce that a session touches only its own partition | see page content, prompts, model responses or audit content |

**Authenticating to AI Browser Agent authorises AI Browser Agent and nothing
else.** Signing in with Google proves an identity to this product. It does not
authorise OpenAI, Anthropic, Gemini, or any OpenAI-compatible endpoint; those
are connected separately, per connection, with their own credential, through
the existing provider architecture (§17). A Google sign-in does not even
authorise Google's AI products — a Gemini API key is still a Gemini API key,
entered by the user into a connection.

**Prohibited, permanently.** The product does not read consumer AI cookies,
session tokens or passwords; does not extract credentials from logged-in
websites; and does not automate a consumer AI website to obtain inference.
Provider authorization uses the provider's official mechanism or is not
implemented. This restates `IDENTITY_AND_SYNC.md` §T and is not weakened here.

---

## 4. ABA user identity

### 4.1 `abaUserId`

| Property     |                                                                                    |
| ------------ | ---------------------------------------------------------------------------------- |
| Shape        | `usr_` + an opaque server-generated identifier                                     |
| Authority    | **the backend.** It is the only thing that mints one                               |
| Lifetime     | permanent until account deletion (§15)                                             |
| Local copy   | cached in `identity-profile`, so the installation remembers whose data it holds    |
| Derived from | nothing the client can see — not the email, not `google_sub`, not any device value |

The local copy is a **cache, never a source**. The extension may read it to
scope local data and to decide whose accounts it is showing; it may never
invent one, increment one, or write a different one over it (§4.4).

**Why the id is opaque and not the email.** An email changes, is reassigned by
employers, and is a poor primary key. Every connected account, every workspace
and every sync partition is bound to `abaUserId`; if that value moved when an
email moved, the user's entire installation would come unbound from itself.

### 4.2 Why `abaUserId` is not any of the things it is near

| Not                        | Because                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| the authentication session | a session is minutes long and revocable; the account is permanent. `AUTH-2`                                            |
| an AI provider connection  | one user has many connections, on many providers, at many endpoints (§17)                                              |
| a provider credential      | a credential is a secret that never leaves the device; an id is a label that is sent on every request. `AUTH-6`        |
| user work                  | work outlives every session and survives sign-out entirely (§14)                                                       |
| a device                   | one account has many devices, and a device is minted locally (§11). `AUTH-7`                                           |
| a K1 key                   | no value the backend holds is a function of the recovery key (K1 §26, K-22). `AUTH-3`, `AUTH-4`                        |
| a Chrome runtime id        | extension id, tab, group and window ids are recycled runtime state. `AUTH-7`                                           |
| an authentication identity | **one account may hold several** — a Google identity and an email identity resolve to the same `abaUserId` (§4.5, §20) |

### 4.3 Resolution: how an authentication becomes an `abaUserId`

```
verified authentication assertion
   │
   ├─ google_sub matches an auth_identity ───────────────▶ return its aba_user_id
   │
   ├─ no google_sub match, and the assertion carries a
   │  VERIFIED email matching an EXISTING auth_identity ▶ return its aba_user_id  (a match, never a new link)
   │
   └─ no match ─────────────────────────────────────────▶ create a new aba_user
```

Three rules make this safe, and all three are load-bearing:

1. **`google_sub` first.** It is Google's stable subject identifier and does
   not change when the user changes their email address. Matching on email
   first would move an account whenever an address was reassigned.
2. **Only a _verified_ email ever matches.** An unverified address is an
   unproven claim, and matching on one is the pre-hijack attack: register an
   account under someone's address before they do, and inherit theirs when they
   arrive. `IDENTITY_AND_SYNC.md` §T already states that no `auth_method` is
   created with `email_verified: false`; Google's `email_verified: false` never
   links and never matches.
3. **A miss creates; a hit returns.** The backend never mints a new
   `abaUserId` for an identity it already knows. This is the single line the
   whole reinstall-recovery path rests on (K1 §17, Cloud Sync §20), and
   `AUTH-11` asserts it.

**Resolution matches an identity row that already exists; it never creates
one on an existing account.** Attaching a second identity is account linking —
a separate, authenticated operation requiring two independent proofs (§20).
Resolution never links on its own, and a verified email that is not already an
`auth_identity` row creates a **new** account rather than joining one that
happens to share the address.

### 4.5 One account, many identities

```
                      ABA account  (abaUserId — one, permanent)
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
      Google identity               Email identity
      (auth_identity)               (auth_identity)
      google_sub                    verified address
```

Each identity resolves to the account; neither **is** the account, and neither
is required to exist. An external identity belongs to **at most one** ABA
account (`AUTH-23`), which is what makes the refusal in §20.4.1 unambiguous.

### 4.4 A different user on the same installation

`IdentityProfileStore.recordSignIn` **refuses** an `abaUserId` different from
the one already cached, returning `DIFFERENT_USER`. It does not overwrite.

Overwriting would strand everything bound to the previous id: connected
accounts, workspaces and tasks would still be in `chrome.storage.local`, owned
by a user this installation no longer remembers, invisible to everybody and
deletable by nobody. Refusal keeps the data reachable and puts the decision in
front of a person.

The path forward is an **explicit local wipe**, with the consequences stated
before it runs, and it is the same wipe as the local half of account deletion
(§15.2). Nothing about signing in performs it.

This is already implemented and tested. It is restated because the backend must
not assume it can hand a client a new identity and have it accepted.

---

## 5. Authentication is not encryption

The most important section in this document.

| Authentication establishes                                   | Authentication does **not** establish  |
| ------------------------------------------------------------ | -------------------------------------- |
| which `abaUserId` this is                                    | the recovery key                       |
| that this client may reach that user's cloud partition       | the KEK                                |
| that this client may register and manage that user's devices | any DEK                                |
| that this client may delete that account                     | any plaintext of a K1-protected record |

> **A valid authenticated session is not sufficient to decrypt K1-protected
> cloud content, and never becomes sufficient.**

The mechanism is absence, not policy. The recovery key is never transmitted,
never a login factor, and never stored server-side in any form — not hashed,
not as a verifier, not as a wrapped copy. There is no field in any request or
response capable of carrying it, and no value the backend holds is a function
of it (K1 §19, §26; Cloud Sync §18).

**What a stolen session actually reaches.** Ciphertext, and the plaintext
routing metadata of `SyncRecord` (Cloud Sync §6): record ids, types, sizes,
revisions, timings. It can delete records. That is **availability and
metadata**, not confidentiality. `SYNC-11` and `AUTH-3` assert the difference,
and §19.1 treats the availability half as the real risk it is.

**What the login screen must therefore never say.** No copy anywhere may imply
that signing in restores data. Signing in retrieves ciphertext; the recovery
key turns it into data. A user who believes authentication is enough will not
save the recovery key, and will discover the design at the worst possible
moment.

---

## 6. Session model

### 6.1 The two tokens

| Token       | Lifetime       | Stored in                                | Survives worker eviction | Survives browser restart | Server-revocable |
| ----------- | -------------- | ---------------------------------------- | ------------------------ | ------------------------ | ---------------- |
| **access**  | ~15 min        | `chrome.storage.session` (memory-backed) | **yes**                  | **no**                   | by short life    |
| **refresh** | ~30 d, rolling | `chrome.storage.local` (disk)            | yes                      | yes                      | **yes**          |

`chrome.storage.session` surviving service-worker eviction and clearing on
browser close is measured behaviour, not an assumption. The split is the
design: a worker restart keeps both halves and the session simply continues; a
browser restart keeps only the refresh token and the session silently refreshes.
Neither asks the user to sign in again.

Lifetimes are as already specified in `IDENTITY_AND_SYNC.md` §B and are not
changed here.

### 6.2 States

A pure function of what is stored — `evaluateSession(session, access, now,
reachable)`, already implemented:

```
                    ┌──────┐
   no session ─────▶│ none │
                    └──────┘

   refresh valid + access valid          ──▶  active
   refresh valid + access stale + backend reachable      ──▶  refresh_due
   refresh valid + access stale + backend unreachable
        + within 7 d of last contact                     ──▶  offline_grace
   refresh valid + access stale + unreachable + past 7 d ──▶  expired(grace_lapsed)
   refresh expired                                       ──▶  expired(refresh_expired)
```

`isAuthenticated` is true for `active` and `offline_grace` only. `refresh_due`
is not a permission to act — it is an instruction to refresh first.

Being a pure function matters: every branch is exercisable without a storage
area, and the answer never depends on the order two reads resolved in.

### 6.3 Rotation and replay

| Property                 | Rule                                                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **refresh rotation**     | every successful `/refresh` issues a **new** refresh token and invalidates the presented one. Refresh tokens are single-use                                                                                                                                         |
| **rolling window**       | the new token's expiry is `now + 30 d`, so an actively used session does not expire; an idle one does                                                                                                                                                               |
| **replay detection**     | presenting an _already-rotated_ refresh token is a **reuse signal**: the entire session family is revoked and re-authentication is required                                                                                                                         |
| **why the whole family** | reuse means the token was captured. The attacker and the user both hold one; revoking only the presented one leaves the thief's valid                                                                                                                               |
| **storage at rest**      | the backend stores a **domain-separated SHA-256 digest**, never the token. A stolen database yields no presentable token, and the digest itself is not one (§6.6)                                                                                                   |
| **access token**         | not stored server-side at all; validated by signature and expiry. Short life is its revocation story                                                                                                                                                                |
| **binding**              | every token is bound to `(abaUserId, sessionId)`. A token is never bound to a `deviceId`, because a device is not an authenticator (§11). The session **records** which identity established it, for unlink revocation only — that value authorises nothing (§20.7) |
| **session fixation**     | the session is created **after** the identity assertion is verified, never before. No pre-issued identifier is adopted (§7.4, §8.4)                                                                                                                                 |

**Rotation is not a substitute for revocation.** A user signing out, or an
administrator revoking, marks the session row revoked server-side; every
subsequent refresh fails regardless of what the client holds.

### 6.4 Multiple sessions

One ABA user may hold many concurrent sessions — one per installation,
typically. Each is a separate `session` row with its own rotation chain.

- Revoking one does not touch the others. That is what makes "sign out of this
  browser" meaningful.
- `logout-all` revokes every session for the account, and is the control for a
  suspected compromise.
- A session is **not** a device. A device row (Cloud Sync §5) is provenance for
  sync watermarks; a session is authorization. They are created by different
  events, live for different lengths of time, and neither implies the other
  (§11.4).

### 6.5 Token storage rules

| Value             | Lives                                     | May appear in                                          |
| ----------------- | ----------------------------------------- | ------------------------------------------------------ |
| access token      | `identity-session:access` (memory-backed) | the `Authorization` header of an identity/sync request |
| refresh token     | `identity-session:refresh` (disk)         | the body of `/auth/refresh` only                       |
| `abaUserId` cache | `identity-profile:profile`                | local scoping, display                                 |
| provider API key  | `credentials:conn:<connectionId>`         | a provider request built by the provider transport     |
| KEK               | K1's own storage (K1 §7.4)                | nowhere outside the crypto layer                       |

> Session secrets are **never** written into a task, workflow, shortcut,
> workspace record, sync record, evidence item or audit event.

The enforcement is structural and already holds: `SessionStore` imports no
account store, no credential store, no profile, no task or workflow store. Its
`clear()` removes two keys inside its own namespace, and that is the whole of
its reach. A session ending cannot delete user data because the code that ends
sessions was never given a way to name it. A whole-keyspace diff before and
after any session operation must show changes **only** under
`identity-session:` — an assertion that protects stores which do not exist yet.

### 6.6 The refresh-token digest

The stored form of a refresh token, specified here because it was the one
place where this document and the implementation disagreed, and the
disagreement was resolved by review rather than by whichever side was written
last.

#### What a refresh token is

| Property              | Requirement                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| generation            | **CSPRNG only** — `crypto.getRandomValues`. Never a counter, a timestamp, a UUID, or any value derived from a user |
| entropy               | **256 bits**, uniform. 32 random bytes                                                                             |
| encoding              | lowercase hex, 64 characters, zero-padded per byte. A **bijective** encoding of the 32 bytes — nothing is lost     |
| truncation            | **none**, at any stage: not the token, not the digest, not the stored column                                       |
| who holds the value   | **the client only.** It is returned once, at creation and at each rotation, and cannot be recovered afterwards     |
| server-side plaintext | **never persisted.** No column, in any table, holds a refresh token                                                |
| logging               | **never logged**, in any form, at any level. The logger's field allowlist has no entry that could carry one (§18)  |

#### What the backend stores

```
refresh_digest = SHA-256( "aba/auth/refresh/v1" || ":" || token )
```

| Property                       | Requirement                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| algorithm                      | **SHA-256**, domain-separated. Not a password KDF — see the threat model below                                                                                            |
| domain separation              | the literal prefix above, so a digest computed for this purpose collides with nothing computed for another                                                                |
| storage                        | the **full** 256-bit digest, hex, 64 characters. Never truncated to save a column                                                                                         |
| digest logging                 | **never logged.** The digest is credential-adjacent material and is treated as credential material                                                                        |
| digest in responses            | **never returned** by any endpoint                                                                                                                                        |
| comparison                     | lookup is an indexed equality on the digest column. Any comparison performed in **application** code is constant-time                                                     |
| the digest is not a credential | presenting the digest in place of the token fails, because verification digests what it is given: `digest(digest) ≠ digest`. A database reader learns nothing presentable |

**A domain separator is not a salt, and this document does not call it one.**
A per-row salt defeats precomputation amortised across rows. The separator
does not do that; it only scopes the digest to this use. Against a uniform
256-bit input there is nothing to amortise, which is why no salt is required —
but the two must not be confused, because the reasoning that makes the salt
unnecessary is the entropy of the input, not the presence of the prefix.

#### Why not Argon2id here

A password KDF buys one thing: it multiplies the cost of **each guess**. That
is decisive when the input space is small enough to enumerate, and arithmetically
irrelevant when it is not. The question is therefore entirely about whether the
input space is enumerable — which is a fact about the implementation, not a
matter of taste.

The conditions under which the cost multiplier is irrelevant, each of which
must hold and each of which is a testable property rather than an assurance:

1. the token is generated by a CSPRNG, not a predictable source;
2. it carries 256 bits, with no structure an attacker can exploit;
3. the hex encoding loses nothing, so the searchable space is the full space;
4. the digest is stored untruncated, so a collision is not cheaper than a
   preimage;
5. the token is never persisted or logged anywhere in plaintext.

**If any one of those stopped being true, this conclusion would flip.** A
generator regression that shortened a token, an encoder that dropped a leading
zero, a digest truncated to 16 characters for an index — each would create a
searchable space, and with SHA-256 there is no work factor to absorb the
mistake. That is the honest cost of this choice, and the mitigation is that the
five properties are pinned by tests rather than by review.

Two further properties of _this_ secret, which a long-lived credential does not
have, and which reduce the value of offline cracking even before feasibility is
considered: a refresh token is **single-use and rotating**, so a token recovered
from a stolen database has probably already been superseded; and presenting a
superseded one is a **reuse signal that revokes the entire family** (§6.3). An
attacker who did the impossible work would, in the common case, announce
themselves and lose the session.

**Argon2id remains correct where the input is small.** The email OTP is six
digits — roughly twenty bits, trivially enumerable — and §8.2 continues to
require Argon2id for it, with an attempt limit and rate limits alongside. If
password authentication is ever introduced (§8.1), Argon2id is required there
too. The distinction is the entropy of the input, applied consistently, rather
than one primitive imposed everywhere.

#### Versioning and migration

The digest is versioned, because an algorithm decision that cannot be revisited
is a decision that will one day be wrong.

| Requirement             | Rule                                                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| version marker          | the algorithm and its version are identifiable from the stored row, so a mixed population is unambiguous rather than guessed at                       |
| current version         | `v1` — SHA-256, domain `aba/auth/refresh/v1`                                                                                                          |
| a change is prospective | a digest cannot be recomputed without the token, which the backend does not have. A new algorithm therefore applies to **newly issued** digests only  |
| no forced sign-out      | existing sessions keep verifying under the version they were written with, and adopt the new one at their next rotation — within 30 days, all of them |
| retiring an old version | once no unexpired session carries it. Until then both verify; after then the old path is deleted, not left dormant                                    |
| no backfill             | there is no migration that rewrites existing digests, and any design proposing one is proposing to store the token                                    |

> **Implementation status, stated rather than assumed.** The version marker is
> currently carried **inside the domain string** (`aba/auth/refresh/v1`) and
> **not** as a separate stored discriminator, so a row does not by itself say
> which algorithm produced it. That satisfies domain separation and does not
> satisfy the first row of the table above. Adding a stored discriminator is a
> **required implementation change before a second algorithm exists** — it is
> not needed while there is exactly one, and it must not be deferred past that
> point. Recorded here rather than left as a gap between document and code.

#### Storage

The column is `session.refresh_digest`, `text`, holding the 64-character
lowercase hex digest, with a unique index so that presenting a token is an
unambiguous single-row lookup rather than a scan that could match two rows.
It is credential material: never logged, never returned, hard-deleted with the
account.

---

## 7. Google authentication

Design only. Not implemented.

### 7.1 Flow

OAuth 2.0 authorization code with PKCE, and the code is redeemed **by the
backend**, not by the extension.

```
extension                     backend                        Google
    │                            │                              │
    │ POST /v1/auth/start        │                              │
    │   {method:"google"}        │                              │
    │───────────────────────────▶│  create login_challenge:     │
    │                            │   state, nonce, pkce_verifier│
    │◀───────────────────────────│  {authorizationUrl,          │
    │                            │    challengeId}              │
    │                            │                              │
    │ open a tab on authorizationUrl ────────────────────────────▶│
    │                            │                              │  user consents
    │                            │◀── GET /v1/auth/google/callback?code&state
    │                            │    verify state, exchange code
    │                            │    with verifier + client secret
    │                            │    verify id_token: iss, aud,
    │                            │    exp, nonce, signature
    │                            │    resolve abaUserId (§4.3)
    │                            │    mint one-time exchange code
    │◀── redirect to a terminal page carrying the exchange code ─│
    │                            │                              │
    │ POST /v1/auth/exchange     │                              │
    │   {challengeId, code}      │                              │
    │───────────────────────────▶│  consume; issue tokens       │
    │◀── {abaUserId, access, refresh, expiry} ──────────────────│
```

**Why the backend redeems the code.** A confidential client keeps the Google
client secret on a server. An extension is a public client: anything shipped in
it is readable by anyone who installs it. Redeeming server-side also means the
`id_token` is verified by the party that will act on it, rather than by a
client that could be modified to skip the check.

**Why a second exchange step.** The redirect lands on the backend, not in the
extension. The extension has no way to receive tokens from that redirect
directly, so the backend hands back a **one-time, short-lived exchange code**
which the extension trades for real tokens over a request it initiated itself.
Tokens never travel through a URL, and therefore never through browser history,
a referrer header or a server log.

### 7.2 State, nonce and PKCE

| Parameter       | Purpose                                                                                    | Rules                                                                      |
| --------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `state`         | binds the callback to the request that started it — CSRF on the callback                   | ≥ 128 bits from a CSPRNG; single-use; compared in constant time; expires   |
| `nonce`         | binds the returned `id_token` to this authentication — replay of a previously issued token | ≥ 128 bits; echoed in `id_token.nonce`; rejected on mismatch               |
| `code_verifier` | makes a stolen authorization code useless                                                  | ≥ 43 chars, `S256` only. **`plain` is not offered** — it defeats the point |
| `challengeId`   | names the `login_challenge` row for the exchange step                                      | opaque, single-use, dies with the challenge                                |

All four are generated and held **server-side** on the `login_challenge` row.
The extension holds only `challengeId`, which is useless alone.

The repository's existing connector OAuth already implements this shape —
`createCodeChallenge` is `S256`-only, `plain` is deliberately absent, `state` is
CSPRNG-derived, and a callback is matched on **origin and path exactly**
because a prefix match is an open redirect. The Google flow follows the same
rules rather than inventing new ones.

### 7.3 The redirect URI, and why it is not `chrome-extension://`

An extension's id **changes on reinstall** when it is not installed from the
store with a fixed key. A registered `chrome-extension://<id>/...` redirect URI
therefore breaks after a reinstall — precisely the scenario recovery has to
survive (`IDENTITY_AND_SYNC.md` §T, flow I).

The redirect URI is therefore **an https URI on the backend's own origin**,
registered once with Google and stable forever. It is unaffected by extension
id, browser profile or reinstall.

### 7.4 Callback handling

The backend's callback handler must, in this order, and abandon on the first
failure:

1. `state` exists, is unconsumed, is unexpired, and matches in constant time;
2. mark the challenge consumed **before** any further work, so a replayed
   callback finds nothing;
3. exchange `code` with the `code_verifier` and client secret;
4. verify the `id_token` **signature** against Google's published keys;
5. verify `iss`, `aud` (this client id), `exp`/`iat`, and `nonce`;
6. read `sub` and `email`/`email_verified`;
7. **refuse to link or match on email when `email_verified` is false** (§4.3);
8. resolve `abaUserId` (§4.3);
9. issue the one-time exchange code, bound to the challenge.

An `error` parameter, a missing `code`, an unknown `state` and a consumed
`state` all produce the **same** terminal page and the same error code. None
reveals whether an account exists.

### 7.5 `chrome.identity` is not used

`chrome.identity.launchWebAuthFlow` would require the `identity` permission,
and that permission also unlocks `chrome.identity.getAuthToken`, which mints a
token for the **browser profile's own signed-in Google account**. Requesting a
permission whose principal capability is one this product must never exercise —
reaching the user's Google account without their per-flow consent — in exchange
for a window-opening convenience, is the wrong trade.

The extension already holds `tabs`. It opens the authorization page in a tab it
created and watches **only that tab**, treating a navigation as the callback
only when origin _and_ path match exactly. This is what `launchWebAuthFlow`
does internally, minus the permission. The pattern is implemented and tested in
`auth-flow-port.ts` and is reused unchanged; **no new permission is requested
for authentication.**

### 7.6 Subject mapping, revocation and identity change

| Situation                                           | Behaviour                                                                                                                                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| first Google sign-in                                | create `aba_user` + `auth_identity{kind:'google', subject:sub}`                                                                                                                                     |
| returning                                           | match on `sub`, return the same `abaUserId`                                                                                                                                                         |
| the user changes their Google email address         | `sub` is unchanged, so the account is unchanged. The stored email is updated for display                                                                                                            |
| the user revokes the app's Google authorization     | existing ABA sessions keep working until they expire — they are ABA sessions, not Google ones. The **next** Google sign-in fails and must be re-consented                                           |
| Google account deleted                              | sign-in via Google stops working. The ABA account persists; a linked email identity remains usable (§20). With no other identity the account may be unreachable — the limitation is stated in §20.8 |
| two Google accounts, same person                    | two `auth_identity` rows, two ABA accounts, unless explicitly linked (§20). **Never merged automatically**                                                                                          |
| a `sub` already attached to a different `abaUserId` | refused. One external subject maps to at most one ABA account                                                                                                                                       |

---

## 8. Email authentication

Design only. Not implemented.

### 8.1 The choice: one-time code, no password

**Passwordless email OTP is the selected direction**, matching
`IDENTITY_AND_SYNC.md` §T and §U, which already specify an OTP hash, an attempt
limit and a TTL.

| Approach                 | Cost                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **email OTP (selected)** | requires deliverable email and a rate-limited verify endpoint                                                                                                                                                 |
| email + password         | adds a credential database, a password-reset flow that is itself an email-possession proof, password-strength policy, breach-list checking, and a second thing to steal — all to end up proving the same fact |
| magic link               | equivalent security, but link-clicking in a side panel is awkward, link prefetchers consume single-use links, and the link lands in the wrong browser more often than a code lands in the wrong field         |

The product requirement is _prove control of this address_. A password proves
something else — knowledge of a secret — and then falls back to email
possession anyway the first time it is forgotten. Adding it means storing a
credential the product does not need, so it is not added.

**If email/password is later required** as a product decision, the minimum is:
Argon2id (backend, §2.2) with per-user salt and reviewed parameters; the
password never logged, never echoed, never in a URL; reset as a single-use,
expiring, rate-limited email possession proof identical to §8.2; and a reset
that revokes every session. That is recorded so the requirement is not
rediscovered, not because it is planned.

### 8.2 The OTP flow

```
POST /v1/auth/start {method:"email", email}
   → always 202, always the same body, whether or not the address is known (§8.4)
   → create login_challenge: argon2id(otp), attempts=0, expires_at=now+10min
   → send the code

POST /v1/auth/email/verify {challengeId, code}
   → constant-time compare against the hash
   → on success: consume, resolve abaUserId (§4.3), issue tokens
   → on failure: attempts += 1; at 5, consume the challenge and stop
```

| Control                | Value                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| code space             | ≥ 6 digits from a CSPRNG — never a timestamp, counter or PRNG                               |
| expiry                 | 10 minutes                                                                                  |
| single use             | the challenge is consumed on success **and** on attempt exhaustion                          |
| attempt limit          | 5 per challenge, then the challenge dies; a new one must be requested                       |
| at rest                | `argon2id(code)` — never the code itself, so a stolen challenge table yields nothing usable |
| comparison             | constant time                                                                               |
| rate limit — per email | caps how fast one address can be targeted                                                   |
| rate limit — per IP    | caps breadth across addresses                                                               |
| rate limit — global    | protects the mail sender's reputation and caps cost                                         |
| replay                 | a consumed challenge is not a different error from an expired one (§24)                     |
| enumeration            | `/auth/start` response never varies on account existence (§8.4)                             |

Only a **successfully verified** address ever becomes an `auth_identity` with
`email_verified: true`. No unverified address is ever written as an identity —
this is the pre-hijack control from `IDENTITY_AND_SYNC.md` §T, unchanged.

### 8.3 Email normalisation

Addresses are compared **case-insensitively on the domain and stored lowercase
whole**, which is what `IDENTITY_AND_SYNC.md` §U's `email(uniq, lower)`
specifies.

No provider-specific canonicalisation is applied — dots are not stripped,
`+tags` are not removed. Two rules collide here and one has to win: treating
`a.b@gmail.com` and `ab@gmail.com` as one account is right for Gmail and wrong
for every provider that treats them as distinct, and getting it wrong merges
two people. **Not merging is the safe failure**, so the address is treated as
opaque below the `@`.

### 8.4 Account enumeration

`POST /v1/auth/start` returns the **same status, same body and same timing
envelope** whether or not the address has an account. A code is sent only when
an account exists or is being created, but the response cannot tell them apart.

| Leak                            | Control                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------- |
| differing status or body        | one response shape, always                                                      |
| differing latency               | the response does not wait on mail delivery; sending is queued after responding |
| differing error on verify       | wrong code, expired challenge and consumed challenge are one error code (§24)   |
| rate-limit messages             | never say _why_ a limit was hit                                                 |
| `GET /v1/me` on another account | `NOT_FOUND`, never a distinguishable authorization error (§19, Cloud Sync §15)  |

---

## 9. Authentication outage and the 7-day grace

### 9.1 Five states that must never be confused

The grace period exists for exactly one of them. Treating any other as an
outage is an authorization bypass, and `AUTH-14` asserts it.

| State                     | What happened                       | Detected by                                                          | Grace applies? |
| ------------------------- | ----------------------------------- | -------------------------------------------------------------------- | -------------- |
| **authentication outage** | the backend cannot be reached       | transport failure, timeout, 5xx — **no authenticated answer at all** | **yes**        |
| **expired credentials**   | the refresh token passed its expiry | local arithmetic on `refreshExpiresAt`; no network needed            | **no**         |
| **revoked session**       | the server revoked this session     | an authenticated **401 / `SESSION_REVOKED`** — the backend answered  | **no**         |
| **logout**                | the user chose to end the session   | a local action                                                       | **no**         |
| **account deleted**       | the account no longer exists        | an authenticated **401 / `ACCOUNT_DELETED`** — the backend answered  | **no**         |

> **The discriminator is whether the backend answered.** An outage is the
> absence of an answer. A revocation, a deletion and a rejection are answers.
> A client must never convert a received rejection into `offline_grace`, and
> `evaluateSession`'s `reachable` parameter is what carries that distinction:
> it records what the caller last _observed_, and a definitive rejection sets
> it true, not false.

This is the one place where a sloppy implementation would produce a real
bypass: a deleted account whose 401 was treated as unreachable would keep
working for seven more days. The rule is therefore stated as a contract on the
caller, and gate 20 (§28) tests exactly it.

### 9.2 What the grace permits

Seven days from `lastContactAt` (`OFFLINE_GRACE_MS`, implemented).

| Operation                                       | During `offline_grace` | Why                                                                                                                                                                           |
| ----------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| local work: browse, run tasks, record workflows | **yes**                | none of it involves the ABA backend. Making an outage a product outage would turn a minimal auth service into a single point of failure for functionality it takes no part in |
| local encrypted reads and writes                | **yes**                | the KEK is local; K1 does not consult the backend to decrypt                                                                                                                  |
| provider requests (the AI brain)                | **yes**                | credentials are local and the egress gate is local; the ABA backend is not in that path                                                                                       |
| cloud **pull**                                  | **no**                 | there is no backend to pull from — this is unavailability, not a policy decision                                                                                              |
| cloud **push**                                  | **no**, queued         | changes encrypt immediately and enter the durable local queue (Cloud Sync §24)                                                                                                |
| device registration / retirement                | **no**                 | server-side operations                                                                                                                                                        |
| account deletion                                | **no**                 | requires fresh re-authentication (§15)                                                                                                                                        |

Nothing is weakened. Every local security control — route trust, the egress
gate, taint, consent, policy, workspace membership — runs exactly as it does
with a live session. **The grace extends authentication continuity and nothing
else.**

### 9.3 What the grace never does

During the grace, and at its expiry:

- no work is deleted;
- `abaUserId` is not rotated, not recreated, not re-resolved;
- no work is orphaned;
- provider credentials are not deleted, not disabled, not re-prompted;
- the identity profile is untouched;
- the KEK is untouched and the recovery key is **not** re-requested — it was
  never in play (K1 §19A);
- the queued encrypted changes persist. Nothing is discarded to demand a
  sign-in.

**Expiry has exactly one consequence: a sign-in prompt.** That is the whole of
it, and it matches `IDENTITY_AND_SYNC.md` §O–R, K1 §19A and Cloud Sync §22
without alteration.

---

## 10. Extension reinstall and recovery

### 10.1 What a reinstall destroys

Uninstalling the extension, recreating the Chrome profile, or moving to a new
machine may destroy `chrome.storage.local` **entirely**: the identity profile,
the session, connected accounts, provider credentials, tasks, workflows,
shortcuts, workspaces, audit, evidence, the `deviceId` — and the KEK.

All three cases present the same thing to the extension: empty local storage
and a person who can authenticate. They therefore share one recovery path.

### 10.2 The recovery sequence

```
new install — no local state, no deviceId, no KEK
   │
   ├─▶ authenticate (Google or email)
   │       backend resolves the SAME abaUserId              ← never mints a new one
   │
   ├─▶ write the local identity profile with that id
   │
   ├─▶ GET /v1/sync/manifest                                 (Cloud Sync §13)
   │       kdSalt · kdInfo · keyVersion · keyCheck · counts · limits
   │
   ├─▶ user supplies the RECOVERY KEY                        ← authentication did not provide this
   │       HKDF-SHA-256 → KEK, verified against keyCheck
   │
   ├─▶ POST /v1/devices                                      register the NEW deviceId
   │
   ├─▶ GET /v1/sync/changes?since=0                          paginated, ascending
   │       decrypt, write local stores
   │
   └─▶ POST /v1/sync/ack                                     watermark at the restored head
```

Steps 1 and 4 are **two different proofs of two different things**, and neither
substitutes for the other. A stolen session reaches step 3 and stops.

### 10.3 What comes back, and what does not

| Restored                                       | Not restored                                                 |
| ---------------------------------------------- | ------------------------------------------------------------ |
| `abaUserId` — the same one                     | the previous `deviceId` — a new one is minted (§11)          |
| tasks, workflows, shortcuts, workspace records | the KEK — re-derived from the recovery key, never downloaded |
| connection **metadata**                        | **provider API keys — never**                                |
| preferences                                    | audit history — `LOCAL_ONLY`, never uploaded (K1 §12)        |
| `kdSalt`, `kdInfo`, `keyVersion`, `keyCheck`   | evidence — not a sync record type                            |

Restored connections carry `status: 'disconnected'` and the existing
`CREDENTIAL_RECONNECT_NOTICE`:

> _"Your OpenAI — Work connection was restored, but its API key needs to be
> reconnected on this device."_

Restoring the shape of someone's setup and asking for one key back is better
than losing the account, and far better than presenting a connection that will
fail at its first request with an error nobody can interpret. **No response
field in any endpoint is capable of carrying a provider credential** —
`AUTH-12`, and the absence is the enforcement.

### 10.4 When there is nothing to recover

| Situation                           | Behaviour                                                                                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| storage preference was `local`      | **there is no recovery.** Nothing was ever uploaded. This is said plainly when Local is chosen and again at uninstall; local-only export is the honest mitigation                                                                     |
| preference was `undecided`          | same — `undecided` uploads nothing (Cloud Sync §19)                                                                                                                                                                                   |
| recovery key lost                   | the ciphertext cannot be decrypted. No server-side recovery. The ciphertext is **kept**, the identity is **not** reset, nothing downgrades to plaintext, and starting fresh is an explicit destructive choice a person makes (K1 §17) |
| wrong recovery key                  | `keyCheck` fails → `WRONG_RECOVERY_KEY`; retry offered; nothing written                                                                                                                                                               |
| some records fail to decrypt        | per record: the rest restore, the failures are listed and **kept** as ciphertext (K1 §17)                                                                                                                                             |
| backend unreachable during recovery | restore deferred; the extension works locally                                                                                                                                                                                         |

> **Authentication never silently resets encryption and never silently deletes
> work.** There is no path in which failing to produce the recovery key causes
> the ciphertext to be discarded, the identity to be re-minted, or the account
> to be re-initialised.

---

## 11. Device identity

### 11.1 `deviceId`

Defined by K1 §16 and Cloud Sync §5, restated here only for its relationship to
authentication:

| Property     |                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------- |
| Shape        | `dev_` + `crypto.randomUUID()`                                                                     |
| Minted by    | the **client**, on first run                                                                       |
| Stored in    | `chrome.storage.local`                                                                             |
| Secret?      | **no.** A label. Presenting one authorises nothing; forging one gains nothing                      |
| Derived from | nothing — not `abaUserId`, not the recovery key, not any Chrome runtime handle                     |
| Purpose      | sync provenance, the purge quorum watermark, naming the other side of a conflict, per-device audit |

### 11.2 Independence from Chrome runtime identifiers

`deviceId` is **not** and never becomes: `tabId`, `windowId`, `tabGroupId`, the
extension runtime id, or anything derived from them. Those are recycled by
Chrome, unstable across restart, changed by reinstall, and meaningless on
another machine. `AUTH-7` asserts it, alongside `SYNC-5`, which already forbids
any Chrome runtime id from appearing in a sync payload at all.

### 11.3 Lifecycle

| Event                                  | `deviceId` | `abaUserId` | Server-side effect                                                                                  |
| -------------------------------------- | ---------- | ----------- | --------------------------------------------------------------------------------------------------- |
| service-worker eviction                | **same**   | same        | none — it is on disk, not in the worker                                                             |
| extension restart / update             | **same**   | same        | none                                                                                                |
| browser restart                        | **same**   | same        | none                                                                                                |
| sign out and back in                   | **same**   | same        | none — a device is not a session (§11.4)                                                            |
| **extension reinstall**                | **new**    | **same**    | a new device row; the old one remains until retired (Cloud Sync §10)                                |
| Chrome profile recreation              | **new**    | **same**    | same as reinstall                                                                                   |
| a second machine                       | **new**    | same        | a second device row; both sync                                                                      |
| a **different** ABA user, same install | same value | different   | a **separate** device row under that user — a watermark is meaningless across users (Cloud Sync §5) |

Two device rows for one physical machine is **normal after a reinstall**, not
an error to detect and not something to deduplicate. Attempting to recognise
"the same machine" would require a hardware or profile fingerprint, which is
exactly the PII this design declines to collect (§18).

### 11.4 A device is not a session, and neither authorises the other

|                     | Session                                 | Device                                  |
| ------------------- | --------------------------------------- | --------------------------------------- |
| Created by          | authenticating                          | first sync on an installation           |
| Lifetime            | minutes to 30 days                      | until retired or the account is deleted |
| Secret?             | **yes** — the tokens are bearer secrets | **no**                                  |
| Authorises?         | **yes** — it is the authorization       | **never**                               |
| Survives logout?    | no                                      | **yes**                                 |
| Survives reinstall? | no                                      | no — but its row does                   |

**A device never authorises another device.** One installation's `deviceId`,
runtime ids or local state grant nothing anywhere else. Every request is
authorised by its own session, and `abaUserId` is taken from that session and
never from the request body (§19).

---

## 12. Multiple devices

One ABA user, many installations.

| Concern                      | Design                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| registration                 | `POST /v1/devices`, once, on first sync. Owned by Cloud Sync §5; not redefined here                                                                                                    |
| limit                        | none fixed; abuse is a rate-limit concern (§19.3)                                                                                                                                      |
| naming                       | **open** (§29). If added, a name is user-supplied display text, synced as encrypted record content, never a plaintext backend field and never an authorization input                   |
| active / inactive            | `retired_at` on the device row — null is active                                                                                                                                        |
| retirement                   | eligible after `D` days without acknowledgement, `D > 90` (Cloud Sync §10). Removes the device from the purge quorum and **nothing else**: it deletes no record and revokes no session |
| reactivation                 | a retired device that **authenticates successfully** is reactivated and rejoins at its _existing_ watermark — never at the head, which would claim it had seen changes it has not      |
| recovery key on reactivation | **not required.** The device still holds its KEK; retirement was server-side bookkeeping, not a local wipe (Cloud Sync §10)                                                            |
| device list                  | `GET /v1/devices` — **added by this document** (§22); the caller's own devices only, scoped by session                                                                                 |
| watermark                    | `synced_through_seq` per device; monotonic; the purge quorum is `min()` over non-retired devices (Cloud Sync §9)                                                                       |

**Retirement is an authenticated, session-scoped operation**, which is what
stops it being an attack: a device cannot retire another user's device, and
retiring one's own removes it from a quorum without deleting anything. The
resurrection risk that retirement could otherwise create is handled by the
returning-device reconciliation table in Cloud Sync §10, which this document
does not alter.

---

## 13. Logout

Logout ends a session. It is not a deletion of anything.

|                    | Logout does                                 |
| ------------------ | ------------------------------------------- |
| session tokens     | **removed locally and revoked server-side** |
| that session's row | marked `revoked_at`                         |
| other sessions     | untouched, unless `logout-all`              |

|                                                          | Logout does **not** touch                                                                                                  |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `abaUserId`                                              | kept locally — it is what lets the sign-in screen say "sign back in as …" instead of showing a returning user a blank form |
| the identity profile                                     | kept, including `email` for that same reason                                                                               |
| local encrypted work                                     | every byte kept                                                                                                            |
| the KEK                                                  | kept — **no recovery-key re-entry on the next sign-in**                                                                    |
| cloud records                                            | kept                                                                                                                       |
| connection metadata                                      | kept                                                                                                                       |
| **provider credentials**                                 | kept, local, untouched — removed only when the user explicitly removes a connection                                        |
| the active AI brain                                      | kept                                                                                                                       |
| device registration                                      | kept; the device stays in the purge quorum                                                                                 |
| workspaces, tasks, workflows, shortcuts, audit, evidence | kept                                                                                                                       |

Re-authenticating restores access with **no recovery step**, because nothing
was lost. `AUTH-9` asserts it.

The guarantee is structural rather than a rule anyone has to remember:
`SessionStore` holds no reference to the account store, the credential store,
the task store or the identity profile, so there is no expression in the
program that ends a session and reaches user data.

**Logout is not account deletion**, and the UI must never present them
together in a way that suggests it is. Deletion is §15.

---

## 14. Session revocation

Revocation is server-initiated where logout is user-initiated, and the client
must be able to tell it from an outage (§9.1).

| Trigger                                 | Scope                                               | Client sees                                                            |
| --------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| user signs out                          | one session                                         | local clear, then `none`                                               |
| user signs out everywhere               | every session                                       | `401 SESSION_REVOKED` on next call                                     |
| **refresh-token reuse detected** (§6.3) | the whole family                                    | `401 SESSION_REVOKED`; re-authentication required                      |
| account deletion                        | every session                                       | `401 ACCOUNT_DELETED`                                                  |
| operator action                         | as scoped                                           | `401 SESSION_REVOKED`                                                  |
| **identity unlinked** (§20.5)           | only the sessions established through that identity | `401 SESSION_REVOKED`; sessions from a remaining identity keep working |

On any of these the client clears its session and shows a sign-in prompt. It
does **not** delete work, rotate `abaUserId`, drop the KEK or re-request the
recovery key — the same discipline as a lapsed grace (§9.3).

---

## 15. Account deletion

The one normal destructive operation (`AUTH-13`), and **two erasures that must
never be conflated**. This document does not implement either.

### 15.1 Backend erasure

`DELETE /v1/me`, requiring **re-authentication within the last five minutes** —
a live proof, not a token that happens to still be valid.

| Removed                                          | Retained                                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `auth_identity` rows — hard delete               | `aba_user` **tombstone**: id and `deleted_at` only, for a 30-day replay window (TUNABLE), then purged |
| `session` rows — every one                       |                                                                                                       |
| `login_challenge` rows                           |                                                                                                       |
| `sync_record` rows **including tombstones**      |                                                                                                       |
| `device` rows                                    |                                                                                                       |
| `push_idempotency` rows                          |                                                                                                       |
| `kd_salt`, `kd_info`, `key_version`, `key_check` |                                                                                                       |

The tombstone exists so a replayed request against a deleted account returns
`ACCOUNT_DELETED` rather than silently creating a new one. **It carries no
content** — no email, no `google_sub`, no ciphertext.

**Deletion is final for cloud data.** The ciphertext is gone and the recovery
key cannot bring it back. No recovery mechanism is invented for a deleted
account, and none may be added quietly.

### 15.2 Local erasure

A **separate, explicit** wipe of `chrome.storage.local`: connection metadata,
**provider credentials**, tasks, workflows, shortcuts, workspaces, audit,
evidence, preferences, the identity profile, the session and the KEK.

Deleting the backend account **cannot** reach into browser storage. Saying
"your data is deleted" while a provider API key remains on disk would be a lie,
so the UI offers both actions and states exactly which does what.

### 15.3 Relationships

| Entity                    | On account deletion                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `abaUserId`               | tombstoned, then purged. **Never reissued** to anyone                                                                                                                              |
| sessions                  | all revoked immediately; every subsequent call is `ACCOUNT_DELETED`                                                                                                                |
| devices                   | rows deleted. Other installations discover this through the authenticated 401, not through an outage (§9.1)                                                                        |
| sync records + tombstones | deleted. The purge quorum is irrelevant once the partition is gone                                                                                                                 |
| K1 ciphertext             | deleted server-side. Local ciphertext survives until the local wipe — and remains decryptable with the recovery key, which is correct: it is the user's data on the user's machine |
| connection metadata       | cloud copy deleted with the partition; local copy survives until the local wipe                                                                                                    |
| provider credentials      | **never on the backend to begin with.** Removed only by the local wipe                                                                                                             |
| local encrypted work      | survives until the local wipe                                                                                                                                                      |

---

## 16. Provider connections and the credential boundary

### 16.1 Three identities that must stay apart

```
ABA account   ≠   AI provider connection   ≠   provider credential
(abaUserId)       (connectionId)               (credentials:conn:<connectionId>)
```

One user may hold many providers, many connections to the **same** provider —
a personal key and a work key — and many OpenAI-compatible endpoints. Each
connection has a durable, device-minted `connectionId`, which is the identity
the credential key, the consent pin, the task binding and the capability
measurement all hang off (`IDENTITY_AND_SYNC.md` §K).

`abaUserId` on a `ConnectedAccount` is a **scoping label, not an authorization
input.** Nothing consults it to decide whether a request may be made; the
egress gate never sees it.

### 16.2 The credential boundary

Provider API keys and OAuth secrets are **`SECRET_LOCAL_ONLY`, permanently.**

| Rule                                            | Asserted by                    |
| ----------------------------------------------- | ------------------------------ |
| never in an authentication request or response  | `AUTH-5`                       |
| never in a Cloud Sync payload, encrypted or not | `SYNC-2`, `SYNC-21`, `AUTH-12` |
| never in a backend log                          | `AUTH-5`, K1 §22               |
| never restored from the cloud on any device     | `AUTH-12`                      |
| never an input to `abaUserId`                   | `AUTH-6`                       |
| never an input to `deviceId`                    | `AUTH-6`                       |
| never an input to a session token               | `AUTH-6`                       |
| never a K1 key input                            | K1 §6                          |

The enforcement is the same as everywhere else in this chain: **there is no
field capable of carrying one.** Not in `AuthRequest`, not in `AuthResponse`,
not in `SyncRecord`, not in the K1 envelope, not in the device row. That
absence is what a mutation test attacks (gate 17, §28).

### 16.3 Authenticating to ABA authorises no provider

Restated because it is the requirement most easily eroded: a Google sign-in
proves an identity to AI Browser Agent. It does not authorise OpenAI,
Anthropic, Gemini or any OpenAI-compatible endpoint, and it does not reduce
what the egress gate asks before a provider request. Provider authorization
remains per connection, per credential, through the existing architecture,
under the existing consent model — in which `connectionId` is compared **first**
in `matchesPin`, so consent for a personal key never authorises a work key.

---

## 17. Legacy data and pre-authentication state

The extension runs, stores work and holds provider credentials **before anyone
signs in**. Authentication arriving later must not disturb any of it.

### 17.1 The unassigned state

Accounts migrated from the legacy single-connection scheme carry
`abaUserId: 'unassigned'`, because migration runs before anyone has signed in.

**Unowned data is never claimed automatically.** `associationOffer()` asks;
`associateUnassigned()` acts only on explicit confirmation;
`declineAssociation()` records a no and **deletes nothing**. On a shared or
handed-down profile, auto-claiming would hand one person another person's
provider credentials with no way to undo it, and `bindAccountToUser` permits no
second move.

### 17.2 The cases

| Situation                                                     | Behaviour                                                                                                                                     |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| legacy local data exists, nobody has ever signed in           | it stays, `unassigned`, fully usable. Authentication is not a precondition for the extension working                                          |
| the user signs in to an **existing** ABA account              | `abaUserId` cached; unassigned data is **offered**, not claimed. Declining changes nothing and may be revisited                               |
| the user signs in for the **first time**, creating an account | identical — the offer is made, nothing is taken                                                                                               |
| local legacy data belongs to no known ABA user                | that is the normal `unassigned` state; it is not an error and nothing is cleaned up                                                           |
| **a different ABA user signs in on this profile**             | `recordSignIn` refuses with `DIFFERENT_USER` (§4.4). No data is merged, reassigned or deleted. An explicit local wipe is the only way forward |
| legacy data exists and the account already has cloud records  | the two are reconciled by Cloud Sync's normal revision rules after association; association does not bypass them                              |

### 17.3 Migration ordering, unchanged

1. write the new credential → 2. write the account record → 3. **read both back
   and verify** → 4. only then delete the legacy credential → 5. only then write
   the marker.

A crash leaves either the old key alone (1–3) or both copies (4). **Never
neither.** Idempotent, and it never throws, because startup must continue.

Capability measurements are deliberately dropped: a measurement taken before
the account had an identity cannot be scoped to one, and a stale measurement
reads as evidence.

> **Authentication never deletes legacy data, never silently reassigns it, and
> never merges two users.** `AUTH-9` covers the deletion half; §4.4 covers the
> reassignment half.

---

## 18. Privacy and what the backend receives

### 18.1 The authentication backend

| Receives                                                               | Why it is required                                                                                         | Retention                                             |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `google_sub` (Google sign-in)                                          | the stable key that resolves the same `abaUserId` every time (§4.3)                                        | until the identity is unlinked or the account deleted |
| email address                                                          | the identifier for email sign-in, and the **only** way a user reaches their account again on a new machine | same                                                  |
| `email_verified`                                                       | an unverified address must never match or link (§4.3)                                                      | same                                                  |
| `abaUserId`                                                            | it is the account                                                                                          | until deletion                                        |
| session metadata: issued/expiry/revoked, the refresh **digest** (§6.6) | issuing, rotating and revoking sessions                                                                    | §25                                                   |
| IP address and timestamp                                               | rate limiting and abuse prevention                                                                         | §25 — short                                           |
| `deviceId`, `synced_through_seq`, `last_ack_at`                        | the purge quorum (Cloud Sync §9)                                                                           | until retired/deleted                                 |
| `kdSalt`, `kdInfo`, `keyVersion`, `keyCheck`                           | **non-secret**; a new device needs them before it holds anything else (K1 §7.3)                            | until deletion                                        |
| account lifecycle timestamps                                           | creation, deletion tombstone                                                                               | §25                                                   |

**Is the email required?** Yes, and only for that reason: it is the recovery
path for account _access_. Without a stored identifier there is no way to
answer "this is the same person" after a reinstall, and the recovery key does
not help — it decrypts data, it does not name an account. This is stated so the
retention is justified rather than habitual.

**What is deliberately not collected:** no name, no profile picture, no Google
profile beyond `sub` / `email` / `email_verified`, no phone number, no address,
no browser fingerprint, no hardware identifier, no installed-extension list, no
browsing history, no usage analytics tied to an identity.

### 18.2 What the backend must never receive

| Never                           | Why                                                          |
| ------------------------------- | ------------------------------------------------------------ |
| provider API keys               | `SECRET_LOCAL_ONLY`, permanently. `AUTH-5`                   |
| provider OAuth secrets          | same                                                         |
| provider credential fragments   | credential material regardless of length (K1 Q4)             |
| page content                    | never uploaded in any release                                |
| prompts                         | same                                                         |
| model responses                 | same                                                         |
| the **recovery key**            | the only decryption secret. `AUTH-4`                         |
| the **KEK**                     | derived key material; never leaves the device                |
| any unwrapped **DEK**           | only the wrapped form is stored, and only inside an envelope |
| plaintext sync records          | encrypted before they exist as a request                     |
| audit content                   | `LOCAL_ONLY` for the initial release (K1 §12, `SYNC-10`)     |
| Chrome tab / group / window ids | local runtime state. `SYNC-5`, `AUTH-7`                      |

### 18.3 The two layers see nothing of each other

|                 | ABA backend sees                                                          | AI provider sees                                       |
| --------------- | ------------------------------------------------------------------------- | ------------------------------------------------------ |
| Content         | email, `abaUserId`, IP + timestamp; under Cloud Sync, **ciphertext only** | prompts, page text, screenshots                        |
| Governed by     | this product's privacy policy                                             | the existing egress / taint / consent model, unchanged |
| Sees the other? | **never** sees prompts or page content                                    | **never** sees the email, the session or `abaUserId`   |

Neither layer gains anything from the other existing. The provider request path
carries no ABA session, and the ABA request path carries no provider material.

**A product-copy consequence.** Once authentication ships, _"no data leaves the
device"_ is no longer true and must be removed everywhere it appears —
`PRIVACY.md`, the store listing, the panel and the README. That correction is
part of the implementation wave, not this document.

---

## 19. Authorization

Authentication proves **who**. Authorization decides **what**, and it is
enforced server-side on every request without exception.

### 19.1 The rule

> `abaUserId` is taken from the **session** and never from the request body,
> a path parameter, a query string or a header. No endpoint accepts a user id
> as an argument, so there is no shape in which one user can name another's
> partition.

| A session may                                             | A session may never                     |
| --------------------------------------------------------- | --------------------------------------- |
| read its own account (`GET /v1/me`)                       | read, name or enumerate another account |
| read its own sync manifest                                | read another partition's manifest       |
| read its own ciphertext                                   | read another partition's ciphertext     |
| write its own encrypted records                           | write into another partition            |
| list, register, retire and reactivate its **own** devices | touch another account's device rows     |
| revoke its own sessions                                   | revoke another account's sessions       |
| delete its own account                                    | delete another account                  |

Enforced again at the row level: every table below is keyed by `aba_user_id`
and every query is scoped by the session's value. Defence in depth, because a
single missing `WHERE` clause is how cross-user access actually happens.

**A record belonging to another user returns the same `NOT_FOUND` as one that
does not exist.** An authorization failure that is distinguishable from a
missing record is an existence oracle.

**What a stolen session can still do** is the honest residual: enumerate record
ids, types, sizes and timings, and **delete records**. Confidentiality holds —
the ciphertext stays ciphertext (`AUTH-3`, `SYNC-11`) — but availability does
not. This is why refresh rotation, reuse detection and `logout-all` exist
(§6.3, §14), and why deletion of an account requires fresh re-authentication
(§15.1).

### 19.2 Cloud Sync is storage, never browser authority

A cloud record can never widen what the agent may touch in the browser.
Workspace **membership does not sync**: a workspace record carries a title and
timestamps, and membership is resolved live from `chrome.tabs.get` by the
existing guard at the moment of every operation. There is no field a hostile
backend could set to grant browser reach, and `SYNC-5` asserts it.

Authentication changes nothing about this. A valid session does not make a
cloud record an authorization input, and no endpoint in §22 returns anything
the workspace guard, the route-trust table, the policy engine or the egress
gate consults.

### 19.3 Rate-limit categories

Categories rather than production numbers — those belong with real traffic, and
inventing them here would give them unearned authority.

| Category                   | Keyed on                 | Why it exists                                                             |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| authentication start       | IP, and email when given | enumeration probing and mail-sending cost                                 |
| email OTP verify           | challenge, IP            | brute force — on top of the 5-attempt per-challenge cap (§8.2)            |
| token refresh              | session, IP              | a refresh loop is either a bug or a probe                                 |
| account read / device list | session                  | ordinary abuse                                                            |
| device registration        | account, IP              | device-row flooding, which would otherwise inflate the purge quorum       |
| device retire / reactivate | account                  | quorum churn                                                              |
| account deletion           | account                  | it already requires fresh re-authentication; the limit is belt and braces |

Rate-limit responses never state **why** a limit was reached, because "too many
attempts for this address" is an existence oracle (§8.4).

---

## 20. Account linking — RESOLVED

**Multiple verified authentication identities may belong to one ABA account.
Linking is always explicit, always requires an already-authenticated ABA
session, and always requires the second identity to complete its own
proof-of-control flow. An identity already attached to another ABA account is
refused, not reassigned. Account merge is not implemented and is not designed
here.**

### 20.1 The three models, compared

Stated as consequences, not as a ranking.

| Dimension                | **A — one identity per account**                                                                          | **B — many verified identities per account**                                                                            | **C — no linking; each identity is its own account**                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| account takeover risk    | no link operation exists, so no link-shaped attack; the whole surface is the sign-in flow                 | adds one operation that attaches an identity to an account, which is an attack surface if either proof is weak          | identical to A — there is no link operation                                                                 |
| account merge complexity | none; merge is impossible by construction                                                                 | none, if merge stays unimplemented: linking attaches an identity to an account, it does not combine two accounts' data  | none; two accounts stay two accounts                                                                        |
| schema impact            | `auth_identity` would carry a uniqueness constraint on `aba_user_id` as well                              | **none.** The existing `auth_identity` table is already one-to-many on `aba_user_id` (§23)                              | none                                                                                                        |
| recovery implications    | one identity is the only route back; losing it loses account access                                       | a second identity is a second route back — the only mitigation for lost-identity that does not invent a support process | same as A, per account                                                                                      |
| UX                       | a user who signs in the "wrong way" is told this account uses Google, and cannot proceed                  | the user signs in either way and lands in the same account                                                              | a user who signs in the other way silently lands in an empty second account and believes their work is gone |
| duplicate accounts       | prevented at the cost of refusing the second method entirely                                              | reduced, not eliminated: a user who creates the second account **before** linking still has two                         | expected and permanent; every user with two habits has two accounts                                         |
| identity verification    | one completed flow, at sign-in                                                                            | two independent proofs for a link: the session on the target account, plus a fresh flow on the identity being added     | one completed flow, at sign-in                                                                              |
| unlinking                | not applicable — the only identity cannot be removed                                                      | needs an explicit rule, because removing the last identity would orphan the account (§20.5)                             | not applicable                                                                                              |
| lost identity            | account access is unreachable; the ciphertext is intact and undecryptable-by-anyone-else, but unreachable | the other linked identity still works. If **all** are lost, identical to A (§20.8)                                      | same as A                                                                                                   |
| session implications     | nothing new                                                                                               | a link is a sensitive account change and has a defined session consequence (§20.7)                                      | nothing new                                                                                                 |
| auditability             | one row per account; nothing to reconstruct                                                               | a link is an event with a time, an actor session and a method — reconstructable from `linked_at` and `linked_via` (§23) | one row per account                                                                                         |

### 20.2 The decision

**Model B**, in its conservative form. The properties that make it conservative
are not adjustable later without re-opening this gate:

| Property                                                        | Status                                  |
| --------------------------------------------------------------- | --------------------------------------- |
| linking is explicit — never inferred, never automatic           | **required**                            |
| linking requires an authenticated session on the target account | **required**                            |
| the identity being added completes its own fresh proof          | **required**                            |
| an identity attached elsewhere is **refused**                   | **required**                            |
| accounts are never merged                                       | **required** — merge is not implemented |
| encrypted cloud data is never moved between accounts            | **required**                            |
| `abaUserId` never changes                                       | **required**                            |

### 20.3 What may and may not prove ownership

This is the security core of the decision, and it is short on purpose.

> **Ownership of an authentication identity is established by completing that
> identity's own authentication flow. Nothing else establishes it.**

| Never proves ownership of anything | Why                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| a matching email **string**        | an address is a claim until a flow verifies it. Matching strings is the pre-hijack attack (§4.3)                      |
| a display name                     | user-supplied, non-unique, changeable at will                                                                         |
| provider metadata                  | `name`, `picture`, `hd`, locale and the rest are attributes of an identity, not proof of control of an **account**    |
| the browser profile                | a shared or handed-down profile belongs to whoever is sitting at it                                                   |
| local extension state              | the cached `abaUserId`, a stored `deviceId`, a present KEK: all client-side values an attacker with the profile holds |
| a `deviceId`                       | provenance, not an authenticator (`AUTH-20`)                                                                          |
| holding the K1 recovery key        | it decrypts data; it is **not** an authentication credential and must never become one (§20.8, `AUTH-4`)              |

`AUTH-27` asserts this as a single testable rule.

### 20.4 The linking protocol

Two proofs, in this order, neither substitutable for the other.

```
  authenticated session on ABA account X          ← proof 1: control of the ACCOUNT
            │
            ▼
  POST /v1/auth/link/start  { method }
            │   creates a login_challenge with purpose='link', aba_user_id = X
            │   (Google: state + nonce + PKCE, server-side · email: OTP)
            ▼
  the user completes that identity's OWN flow     ← proof 2: control of the IDENTITY
            │
            ▼
  POST /v1/auth/link/complete
            │
            ├─ identity already attached to account X          ──▶  no-op, success
            ├─ identity attached to a DIFFERENT account        ──▶  REFUSED  (§20.4.1)
            ├─ identity unattached, proof valid                ──▶  new auth_identity row on X
            └─ session for X expired mid-flow                  ──▶  REFUSED; the challenge is consumed
```

| Rule                                                              | Reason                                                                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| the session is re-checked at `link/complete`, not only at `start` | a flow can take minutes; authorising on a session that has since been revoked would let a revoked session complete a sensitive change |
| the challenge carries `aba_user_id` server-side                   | the client never names the target account, so there is no parameter in which to name someone else's                                   |
| the proof must be **fresh**                                       | a remembered or previously completed flow is not a proof of control _now_                                                             |
| an unverified email is never linkable                             | §4.3, and the pre-hijack control in `IDENTITY_AND_SYNC.md` §T. `AUTH-18`                                                              |
| the challenge is consumed before any write                        | a replayed `link/complete` finds nothing (§22.2)                                                                                      |
| linking is idempotent for an identity already on this account     | so a retried or double-submitted link is not an error the user has to interpret                                                       |

#### 20.4.1 When the identity already belongs to another account

**Refuse.** Specifically, and all five at once:

- do **not** merge the accounts,
- do **not** move the identity,
- do **not** move, copy or re-encrypt any cloud record,
- do **not** create, rename or retire any device row,
- do **not** reveal _which_ account holds it, or that a particular account
  exists — the refusal is the same whichever account is on the other side
  (§8.4, `AUTH-19`).

The user is told that this sign-in method is already in use on another AI
Browser Agent account, and that they can sign in with it directly. If a
combine-accounts capability is ever introduced it is a separate, explicitly
approved, high-risk operation — **not** an extension of linking, and not
designed here.

### 20.5 Unlinking

| Rule                                                                                                    | Reason                                                                                                     |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| unlinking requires an authenticated session on the account                                              | it is an account change                                                                                    |
| **an identity may not be removed if it would leave the account with no verified authentication method** | the account and its ciphertext would be unreachable by anyone, forever. `AUTH-25`                          |
| that rule may be relaxed **only** if a separate account-recovery mechanism is explicitly approved       | and no such mechanism is designed, invented or implied here                                                |
| unlinking is **not** account deletion                                                                   | it removes one route in. It deletes no work, no record, no device, no credential and no account. `AUTH-26` |
| unlinking does not change `abaUserId`                                                                   | §20.6                                                                                                      |
| unlinking an identity that is not on this account is refused without saying whose it is                 | same enumeration rule as §20.4.1                                                                           |

### 20.6 What linking and unlinking must not touch

| Must not                                                        | Because                                                                                             |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| change `abaUserId`                                              | every connected account, workspace, task and sync partition is bound to it. `AUTH-1`, `AUTH-24`     |
| rotate K1, or any key                                           | **an authentication identity change is an authentication change, not an encryption change**         |
| expose, request, derive from or verify against the recovery key | it is not an authentication credential (§20.8). `AUTH-4`                                            |
| derive any K1 material from the new identity                    | the derivation is recovery key → HKDF → KEK, and authentication appears nowhere in it (§1, §5)      |
| re-encrypt user records                                         | nothing about the record changed; a re-encrypt would rewrite every AAD for no reason                |
| duplicate encrypted records                                     | the partition is keyed by `abaUserId`, which did not change                                         |
| move records between accounts                                   | that is merge, which is not implemented                                                             |
| alter workspace authorization                                   | membership is live Chrome state and no cloud or identity record is an input to it (§19.2, `SYNC-5`) |
| alter provider connection identity                              | `connectionId` is device-minted and independent of the ABA account (§16)                            |
| alter provider credentials                                      | `SECRET_LOCAL_ONLY`; the backend has never held one. `AUTH-5`                                       |
| alter device rows or watermarks                                 | devices belong to the account, and the account did not change                                       |

Stated positively: **after a link or an unlink, the only thing that differs is
the set of rows in `auth_identity`.** Everything else in the system — locally,
in the cloud and in the key hierarchy — is byte-identical.

### 20.7 Session implications

| Question                                             | Answer                                                                                                                                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| do existing sessions survive a link?                 | **yes.** The account is unchanged; nothing about the existing session's authority has been altered                                                                                                                  |
| may the newly linked identity create a session?      | **yes**, from the next sign-in onwards — it resolves to the same `abaUserId` by the ordinary rules (§4.3). The link itself issues no new session                                                                    |
| does linking issue a session for the added identity? | **no.** `link/complete` returns the updated identity list, never tokens. A link is an account change, not an authentication                                                                                         |
| do existing sessions survive an unlink?              | **yes** — with one exception below                                                                                                                                                                                  |
| does unlinking revoke sessions?                      | **sessions established through the unlinked identity are revoked.** Removing a route in must remove the access it granted, or unlinking a compromised identity would leave its sessions running                     |
| does a link or unlink require re-authentication?     | linking requires the session plus a fresh identity proof (§20.4). Unlinking requires a session; whether it additionally requires a fresh proof is an implementation-review choice, and requiring one is never wrong |
| what about account deletion?                         | unchanged and separate: `DELETE /v1/me` requires re-authentication within five minutes (§15.1), and no unlink ever performs it                                                                                      |

To make the revocation rule implementable, a `session` row records the
`auth_identity` it was established through — see §23.

### 20.8 Sole-identity loss — the limitation, stated plainly

Model B reduces this risk by allowing a second route in. It does not remove it.

> **If a user loses every authentication identity on their ABA account, and no
> account-recovery mechanism has been separately approved, there may be no safe
> way to prove account ownership. Access to that account may be permanently
> unavailable.**

This is a limitation, not a defect to work around:

- the ciphertext is intact, and the user's recovery key still decrypts it — but
  nothing proves _which account_ is theirs;
- every mechanism that could bridge that gap — a support override, a secondary
  address, a possession challenge, an identity document — is an
  account-takeover path unless it is designed as carefully as the primary flow,
  and **no such mechanism is designed, invented or implied here**;
- **the K1 recovery key must never become an authentication credential.**
  Presenting it must never sign anyone in, and it must never be sent to the
  backend, in any encoding, for any purpose (`AUTH-4`). It decrypts data; it
  does not name an account, and treating it as a login factor would both
  transmit the one secret the design says is never transmitted and make a
  decryption key into an authorization one.

Local-only data is unaffected by all of this: it never depended on an account.

### 20.9 What remains a product decision

Not whether linking exists — that is decided above. What is left is **surface**:
whether the v1 UI exposes a "add another sign-in method" control at launch or
in a later release, and what the linked-identity list shows. The architecture,
the schema, the endpoints, the invariants and the refusal behaviour are the
same either way, which is why this is a launch-sequencing question and not an
open architectural one. It is **not** carried in §29.

---

## 21. Account recovery

Two different recoveries with two different keys. Conflating them is the single
most damaging mistake available in this design, because the conflated version
is the one where authentication decrypts data.

|                               | **Authentication recovery**                                       | **K1 data recovery**                      |
| ----------------------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| Restores                      | access to the account                                             | the plaintext of encrypted work           |
| Proof required                | control of a linked identity — a Google sign-in or a verified OTP | the **128-bit recovery key**              |
| Held by                       | the identity provider / the mail account                          | the user, and nobody else                 |
| Backend can assist?           | yes — it owns identity                                            | **no.** It holds no key and no verifier   |
| Failure means                 | reach the account another way, or it is unreachable               | the ciphertext is retained but unreadable |
| Can substitute for the other? | **never**                                                         | **never**                                 |

```
lost access to email/Google  ──▶ authentication recovery ──▶ account access restored
                                                          ──▶ ciphertext reachable
                                                          ──▶ still encrypted

lost recovery key            ──▶ NO recovery path
                                 ciphertext retained, unreadable
                                 identity NOT reset · nothing downgraded to plaintext
                                 starting fresh is an explicit choice a person makes
```

> Authentication recovery restores **access to ciphertext**. It does not, cannot
> and must never be extended to bypass the recovery key. `AUTH-3` and `AUTH-4`
> assert the two halves of that.

**Lost recovery key** is the case product copy usually gets wrong. The honest
statement, at the moment the key is generated and again at every reinstall
prompt: _if this key is lost, this data cannot be recovered by anyone,
including us._ The ciphertext is kept rather than deleted, the account is not
reset, and no path silently re-initialises encryption to make the product feel
like it still works.

---

## 22. API contract

Minimum surface. **Not implemented.** Names follow `IDENTITY_AND_SYNC.md` §U,
which already reserved them; device and sync endpoints belong to Cloud Sync §15
and are referenced rather than redefined.

All endpoints are HTTPS on the backend's own origin. `abaUserId` always comes
from the session (§19.1). Every response body is JSON `{ code, ... }` on error.

| Endpoint                          | Auth required                      | Authorization        | Idempotent                                    | Rate-limit category  |
| --------------------------------- | ---------------------------------- | -------------------- | --------------------------------------------- | -------------------- |
| `POST /v1/auth/start`             | **no**                             | —                    | no — each call mints a challenge              | authentication start |
| `GET /v1/auth/google/callback`    | **no**                             | `state` binding      | **yes** — a consumed `state` is inert         | authentication start |
| `POST /v1/auth/email/verify`      | **no**                             | challenge + attempts | no — attempts increment                       | email OTP verify     |
| `POST /v1/auth/exchange`          | **no** (one-time code)             | code binding         | **yes** — a consumed code is inert            | authentication start |
| `POST /v1/auth/refresh`           | refresh token                      | session              | **no** — rotation is single-use               | token refresh        |
| `POST /v1/auth/logout`            | access token                       | own session          | **yes**                                       | account read         |
| `POST /v1/auth/logout-all`        | access token                       | own account          | **yes**                                       | account read         |
| `POST /v1/auth/link/start`        | access token                       | own account          | no                                            | authentication start |
| `POST /v1/auth/link/complete`     | access token                       | own account          | **yes** — consumed challenge                  | authentication start |
| `DELETE /v1/auth/identities/{id}` | access token                       | own account          | **yes** — removing twice is `NOT_FOUND`       | account read         |
| `GET /v1/me`                      | access token                       | own account          | **yes**                                       | account read         |
| `DELETE /v1/me`                   | access token **+ re-auth < 5 min** | own account          | **yes** — deleting twice is `ACCOUNT_DELETED` | account deletion     |

`/auth/link/start` and `/auth/link/complete` carry the **two-proof** linking
protocol of §20.4; `DELETE /v1/auth/identities/{id}` is the unlink of §20.5 and
is **refused** when it would remove the account's last verified identity. The
identity being linked is never named by the client as belonging to any account:
the target `aba_user_id` is written onto the `login_challenge` server-side from
the session, so no request body can name another user's account (§19.1).
`GET /v1/me` returns the account's identity list — `kind`, a masked `email`,
`linked_at`, `last_used_at` — and never a `subject`, a token, or anything from
another account.

Device and sync endpoints — `POST /v1/devices`,
`POST /v1/devices/{id}/retire`, `POST /v1/devices/{id}/reactivate`,
`GET /v1/sync/manifest`, `GET /v1/sync/changes`, `POST /v1/sync/records`,
`POST /v1/sync/ack` — are defined in **Cloud Sync §15** and are not redefined
here. This document adds only their authentication requirement: **all of them
require a valid access token and are scoped to the session's `abaUserId`**, and
none of them accepts a user id as a parameter.

One endpoint is **added** by this document because Cloud Sync has no need of it
and a device-management UI does: `GET /v1/devices`, returning the caller's own
device rows — `deviceId`, `registered_at`, `last_ack_at`, `retired_at` — and
nothing else. It requires an access token, is scoped by the session, accepts no
user id, and returns no record content. Its rate-limit category is account
read.

### 22.1 Shapes

```jsonc
// POST /v1/auth/start
→ { "method": "google" }  |  { "method": "email", "email": "…" }
← { "challengeId": "chl_…", "authorizationUrl": "https://…" }   // google
← { "challengeId": "chl_…" }                                    // email, always 202
                                                                //   — identical whether or not the account exists

// POST /v1/auth/email/verify        → { "challengeId", "code" }
// POST /v1/auth/exchange            → { "challengeId", "code" }
← { "abaUserId": "usr_…",
    "accessToken": "…",  "accessExpiresAt":  1800000900000,
    "refreshToken": "…", "refreshExpiresAt": 1802592000000,
    "email": "…", "emailVerified": true, "authMethods": ["google"] }

// POST /v1/auth/refresh             → { "refreshToken" }
← the same shape; BOTH tokens are new (§6.3)

// GET /v1/me
← { "abaUserId", "email", "emailVerified", "authMethods", "createdAt" }
```

**No response body in this document carries**: a provider API key, a provider
OAuth secret, the recovery key, the KEK, a DEK, plaintext record content, page
content, a prompt, a model response, or a Chrome runtime id. There is no field
capable of it, which is the enforcement (`AUTH-4`, `AUTH-5`, `AUTH-12`).

### 22.2 Idempotency

- **Challenge-based endpoints** (`callback`, `exchange`, `email/verify`,
  `link/complete`) are idempotent by _consumption_: the challenge is marked
  consumed before the work proceeds, so a replay finds nothing and gets the
  same safe error rather than a second session.
- **`/auth/refresh` is deliberately not idempotent.** Rotation is single-use,
  and a repeat is a reuse signal that revokes the family (§6.3). A client must
  therefore serialise its own refreshes; two concurrent refreshes from one
  installation are a client bug that presents as a forced sign-out.
- **`/auth/logout`, `/logout-all` and `DELETE /v1/me`** are idempotent: the
  second call finds the state already reached and says so without changing
  anything.

---

## 23. Backend data model

Minimum entities for identity and authentication. **Not implemented.** The
Cloud Sync tables — `aba_user`, `device`, `sync_record`, `push_idempotency` —
are defined in **Cloud Sync §14** and are **not redefined here**. Cloud Sync §14
explicitly records that `session` is "owned by the authentication design"; this
section is that owner.

### `aba_user` — referenced, not owned

Defined in Cloud Sync §14: `id`, `created_at`, `deleted_at`, `kd_salt`,
`kd_info`, `key_version`, `key_check`, `server_seq`, `purge_horizon`. This
document adds no column to it. `kd_salt` is **non-secret by construction**
(K1 §7.3) and lives there because a new device needs it before it holds
anything else.

### `auth_identity`

An external identity that resolves to an ABA account. `IDENTITY_AND_SYNC.md`
§U calls this `auth_method`; the shape is identical and either name is
acceptable at implementation time.

| Field            | Type        | Notes                                                                                                                                      |
| ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`             | text PK     |                                                                                                                                            |
| `aba_user_id`    | text FK     | owner                                                                                                                                      |
| `kind`           | enum        | `google` \| `email`                                                                                                                        |
| `subject`        | text null   | `google_sub`. **Unique** where non-null                                                                                                    |
| `email`          | citext null | stored lowercase. **Unique** where non-null (§8.3)                                                                                         |
| `email_verified` | boolean     | **never `true` without a completed proof** (§4.3)                                                                                          |
| `linked_at`      | timestamptz | when this identity was attached (§20.7)                                                                                                    |
| `linked_via`     | text null   | the `session.id` that performed the link; null for the identity the account was created with. **Audit only**, never an authorization input |
| `last_used_at`   | timestamptz | for display and for stale-identity review only                                                                                             |

Indexes: unique `(kind, subject)`, unique `(kind, email)`, and `(aba_user_id)`
for listing. **Sensitive:** `email` and `subject` are PII. Retention: §25.
**Deletion:** hard-deleted on account deletion (§15.1).

**This shape already carries the resolved linking policy, unchanged.** It is
one-to-many on `aba_user_id`, so a Google identity and an email identity on one
account are two ordinary rows: **§20 requires no schema change**, and
`linked_via` is the only addition, for auditability.

Two constraints hold the security property, and neither may be relaxed:

| Constraint                                          | What it enforces                                                                                                                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unique `(kind, subject)` and unique `(kind, email)` | an external identity belongs to **at most one** ABA account. A link naming one already attached elsewhere cannot be written at all, so §20.4.1's refusal is a database property rather than only an application check (`AUTH-23`) |
| **no** unique constraint on `aba_user_id`           | many identities per account. Model A would have added one here, and adding one later would break every linked account                                                                                                             |

There is deliberately **no** `merge_source` column, no `previous_aba_user_id`
and no nullable owner. A row's `aba_user_id` is written once at creation and is
never updated, so moving an identity between accounts is not an operation the
schema can express (`AUTH-23`).

### `session`

| Field              | Type             | Notes                                                                                                                                             |
| ------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | text PK          | `ses_…`                                                                                                                                           |
| `aba_user_id`      | text FK          | **the source of `abaUserId` for every authorization decision** (§19.1)                                                                            |
| `family_id`        | text             | the rotation chain; reuse revokes the whole family (§6.3)                                                                                         |
| `refresh_digest`   | text             | domain-separated **SHA-256**, 64 hex characters, untruncated. The token itself is never stored (§6.6)                                             |
| `issued_at`        | timestamptz      |                                                                                                                                                   |
| `expires_at`       | timestamptz      | issue + ~30 d, rolled forward on each rotation                                                                                                    |
| `rotated_at`       | timestamptz null | set when superseded; a presented token with this set is **reuse**                                                                                 |
| `revoked_at`       | timestamptz null | logout, `logout-all`, reuse detection, deletion                                                                                                   |
| `auth_identity_id` | text FK          | which identity established this session. Read **only** to revoke on unlink (§20.7); never an authorization input — authorization is `aba_user_id` |
| `last_seen_at`     | timestamptz      | drives `lastContactAt` on the client and nothing else                                                                                             |

Index `(aba_user_id, revoked_at)` for `logout-all` and listing; index
`(family_id)` for reuse revocation; **unique** index on `refresh_digest`, so
presenting a token is an unambiguous single-row lookup rather than a scan that
could match two rows. **Sensitive:** `refresh_digest` is credential material —
never logged, never returned by any endpoint. **Deletion:** hard-deleted on
account deletion.

> A `session` row is **never** joined to a `device` row and never keyed by
> `deviceId`. A session is authorization; a device is provenance. Binding them
> would make a non-secret label part of an authorization decision (§11.4).

### `login_challenge`

One row per in-flight authentication or link, for both methods.
`IDENTITY_AND_SYNC.md` §U already names this table; the alternative name
`auth_challenges` from the task brief is the same entity.

| Field                | Type             | Notes                                                             |
| -------------------- | ---------------- | ----------------------------------------------------------------- |
| `id`                 | text PK          | `chl_…` — the only part the client holds                          |
| `method`             | enum             | `google` \| `email`                                               |
| `purpose`            | enum             | `sign_in` \| `link`                                               |
| `aba_user_id`        | text FK null     | non-null only for `link`, where the session is already known      |
| `state`              | text null        | Google. CSPRNG, ≥ 128 bits                                        |
| `nonce`              | text null        | Google. Echoed in `id_token.nonce`                                |
| `pkce_verifier`      | text null        | Google. **Server-side only** — never sent to the client           |
| `email`              | citext null      | email method                                                      |
| `otp_hash`           | bytea null       | **argon2id(code)** — never the code                               |
| `attempts`           | int              | capped at 5 (§8.2)                                                |
| `exchange_code_hash` | bytea null       | the one-time code the extension trades at `/auth/exchange` (§7.1) |
| `expires_at`         | timestamptz      | 10 min                                                            |
| `consumed_at`        | timestamptz null | set **before** further work, so a replay finds nothing (§7.4)     |

Index `(state)` and `(exchange_code_hash)` for callback and exchange lookup;
`(expires_at)` for the sweeper. **Sensitive:** `pkce_verifier`, `otp_hash`,
`exchange_code_hash`, `state`, `nonce` — all credential material, none ever
logged or returned. **Deletion:** swept on expiry; hard-deleted on account
deletion.

### `account_deletion`

| Field         | Type        | Notes                                       |
| ------------- | ----------- | ------------------------------------------- |
| `aba_user_id` | text PK     | the tombstone's key                         |
| `deleted_at`  | timestamptz | start of the 30-day replay window (TUNABLE) |

**Carries no content** — no email, no `google_sub`, no ciphertext. It exists so
a request against a deleted account answers `ACCOUNT_DELETED` rather than
silently creating a new one. Cloud Sync §29 records the same window on
`aba_user.deleted_at`; an implementation may use either representation, not
both.

### Encryption at rest

| Assumption                           | Statement                                                                                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| database-level encryption at rest    | **assumed and required** — volume or tablespace encryption, plus TLS in transit                                                                                              |
| what it protects against             | stolen disks and stolen backups                                                                                                                                              |
| what it does **not** protect against | a compromised application or a stolen live credential, which sees decrypted rows                                                                                             |
| therefore                            | it is **not** a substitute for hashing. `refresh_digest` (SHA-256, §6.6) and `otp_hash` (argon2id, §8.2) are applied **on top of** it, because the threat is a live read-out |
| K1 ciphertext                        | already ciphertext before it arrives. At-rest encryption adds a layer and changes nothing about the guarantee — the backend still holds no key                               |

---

## 24. Error semantics

Uniform shape `{ code, message }`. Two rules govern every row:

- **No error distinguishes "wrong" from "does not exist"** where the difference
  would confirm an account.
- **No error carries credential or key material**, nor any hint of it.

| Condition                                 | Code                     | User-facing shape                                                                    | Deliberately indistinguishable from           |
| ----------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| wrong OTP                                 | `AUTH_CHALLENGE_INVALID` | "That code is not valid."                                                            | expired, consumed, unknown challenge          |
| expired challenge                         | `AUTH_CHALLENGE_INVALID` | same                                                                                 | wrong code                                    |
| consumed challenge (replay)               | `AUTH_CHALLENGE_INVALID` | same                                                                                 | wrong code                                    |
| attempts exhausted                        | `AUTH_CHALLENGE_INVALID` | same, with "request a new code"                                                      | wrong code                                    |
| bad `state` / bad `nonce` / OAuth error   | `AUTH_CHALLENGE_INVALID` | one terminal page, one message                                                       | each other (§7.4)                             |
| account not found                         | — **no such error**      | `/auth/start` always answers the same (§8.4)                                         | account exists                                |
| expired session                           | `AUTH_REQUIRED`          | "Sign in again to continue."                                                         | —                                             |
| revoked session                           | `SESSION_REVOKED`        | "You were signed out. Sign in again."                                                | — **never** presented as an outage (§9.1)     |
| account deleted                           | `ACCOUNT_DELETED`        | "This account no longer exists."                                                     | — **never** presented as an outage            |
| refresh reuse detected                    | `SESSION_REVOKED`        | same as revoked — the client does not need to know which                             | ordinary revocation                           |
| authentication outage                     | — **no server error**    | "Working offline. Sign in again by <date>."                                          | — it is the **absence** of an answer          |
| unauthorized cloud access                 | `NOT_FOUND`              | nothing                                                                              | a record that does not exist (§19.1)          |
| device retired                            | `DEVICE_RETIRED`         | "This device needs to be reactivated."                                               | — (Cloud Sync §23)                            |
| recovery required                         | `RECOVERY_REQUIRED`      | "Enter your recovery key to restore your data."                                      | —                                             |
| invalid recovery key                      | `WRONG_RECOVERY_KEY`     | "That recovery key does not unlock this data."                                       | — (K1 §23)                                    |
| malformed recovery key                    | `RECOVERY_KEY_MALFORMED` | "That does not look like a recovery key." — from the checksum, before any derivation | —                                             |
| identity already linked elsewhere         | `IDENTITY_IN_USE`        | "That sign-in method is already used by another AI Browser Agent account."           | — **never names the other account** (§20.4.1) |
| identity already on **this** account      | — **no error**           | the link is a no-op and reports success (§20.4)                                      | a first-time link                             |
| unlink would remove the last identity     | `LAST_IDENTITY`          | "This is the only way you can sign in, so it cannot be removed."                     | —                                             |
| unlink of an identity not on this account | `NOT_FOUND`              | nothing                                                                              | an identity that does not exist (§20.5)       |
| rate limited                              | `RATE_LIMITED`           | "Too many attempts. Try again later."                                                | — never says _why_ (§19.3)                    |

`RECOVERY_REQUIRED` and `WRONG_RECOVERY_KEY` are **client-side** conditions.
The backend never emits them, because it has no way to evaluate them — it holds
no key and no verifier. Their presence in this table is the point: even the
error vocabulary keeps authentication and decryption apart.

---

## 25. Data retention

Nothing is retained that is not needed, and each row states what it is needed
for.

| Record                        | Retained                                   | Why                                                                          |
| ----------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| `auth_identity`               | until unlinked or the account is deleted   | it is the account's only route back after a reinstall (§18.1)                |
| `session`, active             | until expiry                               | it is the authorization                                                      |
| `session`, revoked or rotated | a **short** window (TUNABLE), then deleted | long enough to detect refresh reuse (§6.3) and answer a replay; no longer    |
| `login_challenge`             | until consumed or expired, then swept      | a challenge past its 10 minutes has no purpose and holds credential material |
| `device`                      | until retired or the account is deleted    | the purge quorum needs it (Cloud Sync §9)                                    |
| `device`, retired             | retained with `retired_at` set             | so reactivation restores the **existing** watermark rather than the head     |
| IP + timestamp logs           | a **short** operational window (TUNABLE)   | rate limiting and abuse investigation only. Never joined to record content   |
| `account_deletion` tombstone  | 30 days (TUNABLE), then purged             | replay safety (§15.1)                                                        |
| email address                 | with the identity                          | account recovery. **The only PII with a stated, load-bearing purpose**       |

**Not retained at all:** name, profile picture, phone number, address, browser
fingerprint, hardware identifier, installed-extension list, browsing history,
per-account usage analytics, or any Google profile field beyond `sub`, `email`
and `email_verified`.

A retention window marked TUNABLE is a parameter for implementation review; the
constraint is stated in the row and the design is correct for any value meeting
it.

---

## 26. Security invariants

Written in the style of the repository's existing invariants, so each is a test
rather than a sentiment.

| #           | Invariant                                                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AUTH-1**  | One ABA account has exactly one durable `abaUserId`; the backend is its only source, and a known identity never produces a new one.                                                                                                     |
| **AUTH-2**  | An authentication session is not the ABA identity: no session value is an input to `abaUserId`, and ending a session does not end the account.                                                                                          |
| **AUTH-3**  | A valid authenticated session, alone, decrypts nothing. No endpoint returns plaintext of a K1-protected record.                                                                                                                         |
| **AUTH-4**  | The recovery key never reaches the backend, in any encoding, hashed or as a verifier; no stored value is a function of it.                                                                                                              |
| **AUTH-5**  | No provider API key, OAuth secret or credential fragment appears in any authentication request, response, or backend log.                                                                                                               |
| **AUTH-6**  | No provider credential is an input to `abaUserId`, `deviceId`, a session token, or any K1 key.                                                                                                                                          |
| **AUTH-7**  | No Chrome runtime identifier — extension id, `tabId`, `windowId`, `tabGroupId` — is an input to `abaUserId` or `deviceId`, and none appears in an authentication payload.                                                               |
| **AUTH-8**  | Cross-user access is rejected server-side: `abaUserId` comes from the session, no endpoint accepts it as a parameter, and another user's record is `NOT_FOUND`.                                                                         |
| **AUTH-9**  | Logout, session expiry, revocation and a lapsed grace delete no user work — local or cloud — and delete no provider credential.                                                                                                         |
| **AUTH-10** | An authentication outage never rotates, recreates or re-resolves `abaUserId`.                                                                                                                                                           |
| **AUTH-11** | Extension reinstall followed by authentication with the same identity yields the same `abaUserId` — never a new one.                                                                                                                    |
| **AUTH-12** | Provider API keys are never restored from the cloud: no response field on any endpoint is capable of carrying one.                                                                                                                      |
| **AUTH-13** | Account deletion is the only normal destructive account operation, and it requires re-authentication within the last five minutes.                                                                                                      |
| **AUTH-14** | A revoked session and a deleted account are never treated as an outage: an authenticated rejection never enters `offline_grace`.                                                                                                        |
| **AUTH-15** | No password-hashing primitive (Argon2id, scrypt, PBKDF2, bcrypt) runs in the extension, and the CSP remains `script-src 'self'; object-src 'self'` with no `wasm-unsafe-eval`.                                                          |
| **AUTH-16** | A refresh token is single-use; presenting a rotated one revokes the entire session family.                                                                                                                                              |
| **AUTH-17** | No authentication artefact — access token, refresh token, `state`, `nonce`, PKCE verifier, OTP — is written into a task, workflow, shortcut, workspace, sync, evidence or audit record.                                                 |
| **AUTH-18** | An unverified email never matches an existing account and never becomes a linked identity.                                                                                                                                              |
| **AUTH-19** | `/auth/start` responses do not vary on whether an account exists.                                                                                                                                                                       |
| **AUTH-20** | A `deviceId` authorises nothing: no endpoint grants access on the basis of one, and no device's state authorises another device.                                                                                                        |
| **AUTH-21** | Authentication requests no new Chrome permission; `chrome.identity` is not used.                                                                                                                                                        |
| **AUTH-22** | Two ABA accounts are never merged — automatically or otherwise. Linking requires an authenticated session on the target account **and** a fresh proof of control of the identity being added; neither alone suffices.                   |
| **AUTH-23** | An external identity belongs to at most one ABA account. A link naming one already attached elsewhere is refused, and no identity row's `aba_user_id` is ever updated.                                                                  |
| **AUTH-24** | Linking and unlinking change `abaUserId` for nobody, rotate no key, expose no recovery key, re-encrypt no record, duplicate no record, and move no record between accounts.                                                             |
| **AUTH-25** | An identity cannot be unlinked if it would leave the account with no verified authentication method.                                                                                                                                    |
| **AUTH-26** | Unlinking is not account deletion: it removes no work, no cloud record, no device row, no provider credential and no account.                                                                                                           |
| **AUTH-27** | Account ownership is proved only by completing an authentication flow. A matching email string, a display name, provider metadata, the browser profile, local extension state, a `deviceId` and the K1 recovery key each prove nothing. |
| **AUTH-28** | A link refusal does not reveal which account holds the identity, or that any particular account exists.                                                                                                                                 |

---

## 27. Threat model

Only threats this architecture actually creates or must answer. Speculation
outside it is excluded on purpose.

| Threat                                         | Control                                                                                                                                                                                                                                                        | Residual                                                                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **stolen access token**                        | ~15-minute lifetime; held in memory-backed `chrome.storage.session`, gone on browser close; never in a URL; never written into any user record (`AUTH-17`)                                                                                                     | a window of minutes in which ciphertext and metadata are reachable — **not plaintext** (`AUTH-3`)                                       |
| **stolen refresh token**                       | single-use rotation; the whole family revoked on reuse (`AUTH-16`); stored only as a domain-separated SHA-256 digest (§6.6); `logout-all` is the user's control                                                                                                | the thief's first use succeeds; the legitimate client's next use triggers detection and both are cut off                                |
| **refresh replay**                             | `rotated_at` makes a superseded token identifiable; presenting one is the reuse signal, not merely an error                                                                                                                                                    | —                                                                                                                                       |
| **session fixation**                           | sessions are created only **after** the identity assertion is verified; no client-supplied identifier is ever adopted as a session id; `challengeId` names a challenge, never a session                                                                        | —                                                                                                                                       |
| **account enumeration**                        | one response shape from `/auth/start`; one error code across wrong/expired/consumed/unknown challenge; `NOT_FOUND` for another user's records; rate-limit messages never state the reason (§8.4, §24)                                                          | timing side channels need the mail send to stay off the response path — stated as a requirement, not assumed                            |
| **OAuth callback attacks**                     | `state` single-use, CSPRNG, constant-time compared, consumed **before** further work; exact origin **and** path match on the redirect — never a prefix, which is an open redirect; the code is redeemed server-side with a confidential client                 | —                                                                                                                                       |
| **CSRF on the callback**                       | `state` binding, as above                                                                                                                                                                                                                                      | —                                                                                                                                       |
| **`id_token` replay**                          | `nonce` bound to the challenge and verified in the token; signature, `iss`, `aud`, `exp` all verified by the backend                                                                                                                                           | —                                                                                                                                       |
| **PKCE downgrade**                             | `S256` only; `plain` is not implemented, so there is no parameter to downgrade to. The verifier never leaves the backend                                                                                                                                       | —                                                                                                                                       |
| **tokens leaking through the redirect**        | the redirect carries a **one-time exchange code**, not tokens; tokens are returned only on a request the extension itself initiated (§7.1)                                                                                                                     | —                                                                                                                                       |
| **email OTP brute force**                      | ≥ 6 CSPRNG digits, 10-minute expiry, 5 attempts then the challenge dies, per-email / per-IP / global rate limits, `argon2id` at rest, constant-time compare                                                                                                    | —                                                                                                                                       |
| **email account takeover (pre-hijack)**        | no `auth_identity` is ever created with `email_verified: false`; an unverified address never matches and never links (`AUTH-18`)                                                                                                                               | a compromised **mail account** is a compromised identity — outside this boundary, and the recovery key still gates the data             |
| **cross-user authorization**                   | `abaUserId` from the session only; no endpoint takes a user id; row-level scoping on every query; `NOT_FOUND` rather than a distinguishable denial (`AUTH-8`)                                                                                                  | —                                                                                                                                       |
| **device registration abuse**                  | registration is session-scoped and rate-limited; a device row grants nothing (`AUTH-20`)                                                                                                                                                                       | a user can inflate **their own** quorum, delaying **their own** tombstone purge                                                         |
| **device retirement abuse**                    | retirement is session-scoped, deletes no record and revokes no session; reactivation restores the **existing** watermark, never the head, so retirement cannot make a device claim it saw changes it has not (Cloud Sync §10)                                  | —                                                                                                                                       |
| **backend compromise**                         | the backend holds ciphertext, hashes and routing metadata. It holds no key, and no value it holds is a function of the recovery key (K1 §26)                                                                                                                   | **availability and metadata**: it can delete, withhold, reorder-by-omission and observe sizes and timings. Stated, not defended against |
| **hostile backend widening browser reach**     | workspace membership does not sync; membership is resolved live from `chrome.tabs.get`; no cloud record is an input to the workspace guard, route trust, policy or the egress gate (`SYNC-5`, §19.2)                                                           | —                                                                                                                                       |
| **provider credential leakage**                | `SECRET_LOCAL_ONLY`; no field in any authentication or sync payload can carry one; the identity transport's payload schema is narrow and takes no task context (`AUTH-5`, `AUTH-12`)                                                                           | —                                                                                                                                       |
| **identity path used to exfiltrate page data** | the identity egress channel is pinned to one backend origin, takes no task context parameter, is not registered in `ToolRegistry`, and calls `guardedSend` with an injected port rather than a `fetchImpl` — so the three network-primitive holders stay three | —                                                                                                                                       |
| **extension reinstall**                        | same `abaUserId`; new `deviceId`; the redirect URI is on the backend's own https origin, so a changed extension id does not break sign-in; provider keys are not restored (§10)                                                                                | —                                                                                                                                       |
| **logout used as a deletion vector**           | `SessionStore` has no reference to any store holding user data; `clear()` reaches two keys in its own namespace (`AUTH-9`)                                                                                                                                     | —                                                                                                                                       |
| **outage used as an authorization bypass**     | the grace applies only to the **absence of an answer**; an authenticated 401 — revoked or deleted — never enters `offline_grace` (`AUTH-14`, §9.1)                                                                                                             | —                                                                                                                                       |
| **malicious client**                           | can only reach its own partition, cannot forge another user's AAD, cannot lower its own watermark. Worst case it corrupts **its own** data, which it could do locally anyway                                                                                   | —                                                                                                                                       |
| **compromised Chrome profile**                 | **outside the boundary, by approved design.** The KEK, provider credentials and the refresh token are all on that machine and readable by an attacker who holds it (K1 §0, §7.4)                                                                               | full local compromise is full compromise; no cipher protects against an adversary holding the key                                       |

**Two threats deliberately absent.** Metadata privacy against the backend is an
explicit non-goal (K1 §3). Consumer-AI cookie theft and credential extraction
from logged-in sites are not threats to defend against but behaviours the
product is forbidden to perform (§3).

---

## 28. Implementation gates

Mandatory before authentication is considered production-ready. **None is
implemented.** Each is a behaviour to assert, not a feature to demonstrate.

1. **Google identity mapping** — the same `google_sub` twice yields the same
   `abaUserId`; a new `sub` creates exactly one account (`AUTH-1`, `AUTH-11`).
2. **Google email change** — `sub` unchanged, email changed: the account is
   unchanged and the stored email updates.
3. **Email authentication** — a verified OTP yields a session; an
   `email_verified: false` identity is never written (`AUTH-18`).
4. **OTP brute force** — the 6th attempt fails even with the correct code, and
   the challenge is dead; rate limits engage per email, per IP and globally.
5. **Duplicate identity** — a `sub` or verified email already attached to
   another `abaUserId` is refused with `IDENTITY_IN_USE`, nothing is moved, the
   other account is not named, and the identity row's `aba_user_id` is
   unchanged afterwards (`AUTH-23`, `AUTH-28`).
6. **Account linking, two proofs** — `link/complete` is refused with **only** a
   valid session and no fresh identity proof, and refused with **only** a valid
   identity proof and no session; refused when the session is revoked between
   `start` and `complete`; and succeeds only with both (`AUTH-22`).
7. **Session rotation** — every `/auth/refresh` returns a new refresh token and
   invalidates the presented one (`AUTH-16`).
8. **Refresh replay** — presenting a rotated token revokes the whole family and
   forces re-authentication (`AUTH-16`).
9. **Session fixation** — a client-supplied identifier is never adopted as a
   session id; the session exists only after verification.
10. **Logout** — a whole-keyspace diff of `chrome.storage.local` before and
    after shows changes **only** under `identity-session:` (`AUTH-9`).
11. **Session revocation** — a revoked session's next call is
    `SESSION_REVOKED`, the client signs out, and no user data changes.
12. **Account deletion** — requires re-authentication within five minutes;
    removes identities, sessions, devices, sync records and tombstones; leaves
    the `deleted_at` tombstone and nothing else; a second call is
    `ACCOUNT_DELETED` (`AUTH-13`).
13. **Local wipe is separate** — backend deletion changes no byte of
    `chrome.storage.local`, and the UI states which action does what.
14. **Cross-user authorization** — every endpoint, with a session for user A
    naming user B's account, device or record: `NOT_FOUND`, never a
    distinguishable error (`AUTH-8`).
15. **Device registration** — a device registers once, is session-scoped,
    and a `deviceId` presented without a valid session authorises nothing
    (`AUTH-20`).
16. **Device retirement and reactivation** — retirement deletes no record and
    revokes no session; reactivation restores the **existing** watermark, not
    the head; no recovery key is requested.
17. **Provider credential isolation** — as a **mutation**: add a field to the
    authentication request and to the device row capable of carrying a
    credential, and require the suite to fail (`AUTH-5`, `AUTH-6`, `AUTH-12`).
18. **Recovery key isolation** — no request body, response body, log line or
    stored column contains the recovery key or any function of it, asserted by
    capturing every request in a full session-plus-sync run (`AUTH-4`).
19. **K1 / authentication separation** — a valid session performs a full sync
    and decrypts **nothing** without the recovery key; the restore stops at
    `RECOVERY_REQUIRED` (`AUTH-3`).
20. **Outage versus revocation** — a transport failure enters `offline_grace`;
    an authenticated 401 (`SESSION_REVOKED`, `ACCOUNT_DELETED`) **never** does,
    at the boundary on both sides (`AUTH-14`, §9.1).
21. **Grace expiry** — at 7 days ± the boundary: a sign-in prompt, and nothing
    deleted, nothing rotated, no queued change discarded (`AUTH-10`).
22. **Reinstall recovery** — empty storage, authenticate, same `abaUserId`, new
    `deviceId`, recovery key required, provider keys absent, connections
    `disconnected` (`AUTH-11`, `AUTH-12`).
23. **Legacy data migration** — legacy data survives sign-in, is never
    auto-claimed, and a different `abaUserId` is refused with `DIFFERENT_USER`
    rather than overwriting (§4.4, §17).
24. **Malicious callback** — missing `code`, unknown `state`, consumed `state`,
    mismatched `nonce`, an `error` parameter, and a redirect whose origin or
    path differs by one character: all refused, all the same terminal page.
25. **CSRF / PKCE / state** — a callback without `state` is refused; `plain`
    PKCE is unrepresentable; the verifier never appears in a client-bound
    payload.
26. **Account enumeration resistance** — `/auth/start` responses are
    byte-identical for an existing and a non-existent address, and the four
    challenge failure modes share one code (`AUTH-19`).
27. **Cloud Sync authorization** — every sync endpoint requires a valid access
    token, is scoped by the session, and accepts no user id parameter; a cloud
    record never reaches the workspace guard (`SYNC-5`, §19.2).
28. **No new permission** — the shipped manifest after authentication is
    byte-compared against the current one for the permission array;
    `chrome.identity` appears nowhere in the bundle (`AUTH-21`).
29. **No password KDF in the client** — a bundle scan finds no Argon2id,
    scrypt, bcrypt or PBKDF2 implementation, no `.wasm`, and the CSP is
    unchanged (`AUTH-15`).
30. **Session secrets never persist into user records** — a full session plus
    task, workflow, shortcut, workspace and audit run, with every stored value
    scanned for the access token, refresh token, `state`, `nonce`, verifier and
    OTP (`AUTH-17`).
31. **Linking is inert everywhere but `auth_identity`** — a full before/after
    comparison across a link and an unlink: `abaUserId`, `kdSalt`, `keyVersion`,
    `keyCheck`, every `sync_record` row and envelope, every `device` row and
    watermark, every connection record and every local provider credential are
    byte-identical; the only difference is the identity rows (`AUTH-24`).
32. **Unlink safety** — removing the last verified identity is refused with
    `LAST_IDENTITY`; removing one of two succeeds; neither deletes work, a
    cloud record, a device row, a credential or the account (`AUTH-25`,
    `AUTH-26`).
33. **Unlink revokes only that identity's sessions** — sessions established
    through the removed identity are revoked; sessions established through a
    remaining identity keep working (§20.7).
34. **Ownership cannot be forged** — a link attempted using a matching email
    string, a display name, provider metadata, a supplied `abaUserId`, a
    `deviceId`, local extension state, or the K1 recovery key is refused in
    every case; only a completed authentication flow links (`AUTH-27`,
    `AUTH-4`).
35. **Newly linked identity signs in to the same account** — after linking, a
    fresh sign-in through the added identity resolves to the **same**
    `abaUserId`, and `link/complete` itself returns no tokens (§20.7,
    `AUTH-11`).

---

## 29. Open questions

Genuine product decisions only. Everything technical in this document is
determinate.

Account linking was Q1 and is **resolved** in §20: multiple verified identities
may belong to one ABA account, linking requires two independent proofs, an
identity attached elsewhere is refused, and merge is not implemented. What
survives that decision is a launch-sequencing question about UI surface, not an
architectural one, and it is recorded in §20.9 rather than here.

**Q1 — Device naming and the device-list UX.** Whether devices carry a
user-supplied name, and what the list shows. If names are added they are
encrypted record content, never a plaintext backend field and never an
authorization input (§12) — so this is a product question about whether the
value justifies the surface, not a technical one.

**Q2 — Account-deletion grace.** Whether `DELETE /v1/me` deletes immediately or
begins a cancellable window. Immediate deletion is honest and irreversible; a
window is kinder and means the account is not gone when the confirmation says
it is. The 30-day tombstone in §15.1 is a **replay-safety** record and is not a
recovery window; conflating the two would promise a recovery that does not
exist.

**Q3 — Sole-identity loss.** What is offered to a user whose only linked
identity becomes unusable — a deleted Google account, or a lost mailbox.
Linking (§20) narrows this: a user who has attached a second identity has a
second route back, which is the only mitigation available that invents no
support process. It does not close it, and §20.8 states the residual limitation
in full. There is no cryptographic problem here — the ciphertext is intact and
the recovery key still works — only that nothing proves they are the account
owner, and any mechanism invented to bridge that gap is an account-takeover
path. The K1 recovery key must not become that mechanism (`AUTH-4`). Left open
deliberately rather than answered with a support process this document has no
standing to define.

Everything else is settled. `D` (device retirement window), the revoked-session
retention window, the account-deletion tombstone window and the operational log
window are marked **TUNABLE**: parameters for implementation review, correct at
any value meeting the constraint stated with them.
