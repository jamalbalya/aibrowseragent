# Identity, Persistence and Sync — Design Review

Status: **design review, partly implemented and partly superseded.**

Two corrections to what this document said when it was written, both recorded
rather than absorbed:

- **The backend is no longer absent.** `server/` exists — accounts, identities,
  sessions, devices and the Google sign-in flow — and is tested. Still true:
  **nothing is deployed, and no data is uploaded anywhere.**
- **The default storage mode is no longer `undecided`.** It is `local`, and
  `undecided` survives only as a legacy value that resolves to `local`. See
  `LOCAL_FIRST_ARCHITECTURE.md` §1, which supersedes this document on where
  data lives and what is required to run the product.

Phases 1–7 of the foundation are implemented and tested. Cloud Sync itself
(the record model, the upload path, K1) remains **not built**.

What ships in this wave: the multi-account model with `connectionId`,
connection-scoped credentials and consent, safe legacy migration, the account
and AI-brain routes and UI, the data-classification gate, the persistent
identity/session split, and the reinstall-recovery logic. What does not:
Google or email authentication, sessions against a real backend, and Cloud
Sync itself. Sections A–W below describe the whole design; each one's status
is stated where it is not obvious.

The governing invariant, from which everything below follows:

```
authentication session  !=  ABA user account  !=  AI connections
                        !=  provider credentials  !=  user work
```

Five lifecycles. None may be coupled to another. Re-authentication must never
start a user from zero.

---

## A. User identity model

| Concept                           | Lives                                                   | Lifetime                         |
| --------------------------------- | ------------------------------------------------------- | -------------------------------- |
| `abaUserId`                       | backend (authority) + local cache in `identity-profile` | permanent until account deletion |
| auth method (`google` \| `email`) | backend                                                 | until unlinked                   |
| `email`, `emailVerified`          | backend + local cache                                   | until changed                    |

`abaUserId` is the **only** identity persistent data is bound to. It is cached
locally and survives every session event, because every connected account is
bound to it: forgetting it when a session ended would leave accounts owned by
an id nothing remembered, and the user would sign back in to an apparently
empty installation.

`IdentityProfileStore.recordSignIn` **refuses** a different `abaUserId` rather
than overwriting. Overwriting would strand every account bound to the previous
id — present in storage, owned by a user this device no longer remembers,
invisible to everybody. A different user requires an explicit local wipe first,
with the consequences stated.

## B. Authentication session model

| Token   | Lifetime     | Storage                           | Survives                                |
| ------- | ------------ | --------------------------------- | --------------------------------------- |
| access  | 15 min       | `chrome.storage.session` (memory) | worker restart; **not** browser restart |
| refresh | 30 d rolling | `chrome.storage.local`            | browser restart; server-side revocable  |

`chrome.storage.session` surviving service-worker eviction and clearing on
browser close is measured behaviour, not an assumption.

States are a pure function of what is stored — `evaluateSession(session,
access, now, reachable)`:

```
none  ·  active  ·  refresh_due  ·  offline_grace  ·  expired
```

`SessionStore` imports no account store, no credential store, no profile, no
task or workflow store. **The persistence invariant is a dependency-graph
property:** a session ending cannot delete user data because the code that ends
sessions was never given a way to name it. `clear()` removes two keys inside
its own namespace; that is the whole of its reach.

## C. Local data model

Everything persistent lives in `chrome.storage.local` under a namespace per
store: `accounts`, `identity-profile`, `identity-session`, `tasks`,
`workflows`, `shortcuts`, `audit`, `evidence`, `credentials`, `settings`,
`health`, `policy`.

Namespace separation is what makes the invariant testable: a whole-keyspace
diff before and after any session operation must show changes **only** under
`identity-session:`. That assertion protects stores that do not exist yet,
which naming four stores explicitly would not.

## D. Cloud data model

> **Finding that shapes this section.** `AgentTask` carries `objective` (the
> user's instruction), `plan`, and `steps[].summary` (page-derived).
> `AuditEvent` carries `destination`, `origin` and `site` — browsing history in
> all but name. Syncing these as plaintext puts page-derived data and browsing
> history on the AI Browser Agent backend, which contradicts the requirement
> that the backend must not see page content merely because Cloud Sync exists.

**Only end-to-end encryption satisfies both requirements at once.** Three
options were considered:

|     | Key source                                    | Backend can read | Survives reinstall            | Verdict                     |
| --- | --------------------------------------------- | ---------------- | ----------------------------- | --------------------------- |
| K1  | user sync passphrase, PBKDF2-SHA256 → AES-GCM | no               | yes, if the user remembers it | **recommended**             |
| K2  | backend-held key                              | **yes**          | yes                           | contradicts the requirement |
| K3  | no encryption                                 | **yes**          | yes                           | contradicts the requirement |

K1 is the standard model (Firefox Sync, Chrome sync passphrase, 1Password). The
backend stores ciphertext plus a plaintext envelope of `{recordId, type,
revision, updatedAt, deviceId, deleted}` — enough to sync and resolve
conflicts, not enough to read anything. Losing the passphrase loses the
ciphertext's meaning; that must be stated at the moment it is set, not buried.

**Shipping recommendation:** cloud sync of _connection metadata only_ first
(your stated fallback), since it carries no page data and needs no passphrase.
Tasks, workflows, shortcuts and audit follow once K1 exists. Do not ship
plaintext sync of task or audit data at any point.

## E. Local/Cloud selection state

Stored at `settings:data-storage` as `'local' | 'cloud' | 'undecided'`,
defaulting to **`undecided`**. Nothing is uploaded while undecided. The prompt
is offered, dismissible, and re-offerable from settings — never forced, never
defaulted to cloud.

Switching cloud → local stops uploading and offers to delete the server copy as
a **separate, explicit** action. Switching local → cloud uploads what exists
after the passphrase is set.

## F. Sync strategy

Per-record, not per-store. Every synced record gains:

```ts
{ revision: number; updatedAt: number; deviceId: string; deleted?: boolean }
```

`deviceId` is a local random UUID, minted once, never derived from anything
identifying. The client sends `baseRevision`; the server rejects a write whose
`baseRevision` is stale, and the client then resolves per §G. Deletes are
tombstones retained 90 days, so a delete on device A is not resurrected by
device B's stale copy.

## G. Conflict resolution strategy

Naive last-write-wins is rejected: it silently destroys user work.

| Data                    | Conflict possible?               | Resolution                                                                                                                                               |
| ----------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tasks**               | **no** — sync only when terminal | A running task belongs to the device running it. Terminal tasks are immutable. This removes the conflict rather than resolving it.                       |
| **Workflows**           | yes — user-edited                | **Keep both.** The loser is forked as `"<name> (edited on <device>)"`. Never silently overwritten.                                                       |
| **Shortcuts**           | yes — name-keyed                 | Keep both, disambiguate the name; the user merges.                                                                                                       |
| **Preferences**         | yes                              | Field-level LWW on per-field `updatedAt`. Independent scalars, so no work is destroyed.                                                                  |
| **Connection metadata** | rarely                           | `connectionId` is device-minted and globally unique, so only the same connection's `modelId`/`status` can collide → field-level LWW.                     |
| **AI Brain**            | **no**                           | Keyed by `deviceId`. Which brain you drive on your laptop is naturally device-local. A fresh install adopts the most recently used brain across devices. |
| **Audit**               | **no**                           | Per-device chains, never merged. See below.                                                                                                              |

> **Finding.** The audit log's integrity chain is `seq` + `prevDigest`. Two
> devices produce two chains, and interleaving them into one destroys
> verifiability — the property the chain exists for. Audit therefore syncs as
> **per-device append-only streams**, each independently verifiable, presented
> to the user as one merged _view_ assembled at read time.

## H–J. Recovery flows

All three converge on the same sequence, because all three present the
extension with empty local storage and a user who can authenticate:

```
empty local storage
   → sign in (Google or email)
   → backend resolves the SAME abaUserId
   → local profile written with that id
   → cloud manifest fetched
   → passphrase requested (K1)
   → records decrypted and written to local stores
   → "Your AI Browser Agent data has been restored."
```

| Flow                              | Local storage | Extension id | Notes                                                                 |
| --------------------------------- | ------------- | ------------ | --------------------------------------------------------------------- |
| **H.** Chrome uninstall/reinstall | destroyed     | new          | worst case; identical to a new device                                 |
| **I.** Extension reinstall        | destroyed     | **changes**  | any `chrome-extension://` redirect URI must be re-registered — see §T |
| **J.** Chrome profile recreation  | destroyed     | new          | identical to H                                                        |

**Local mode has no recovery.** If the user chose Local, destroyed storage is
destroyed. This must be said plainly at the moment of choosing and again at
uninstall. Do not imply recovery that cannot happen. An export/import path is
the honest mitigation and the panel already has local-only export.

**The backend must never mint a new `abaUserId` for an identity it already
knows.** Resolution is by `google_sub` first, then verified email; a miss
creates, a hit returns. This is the single most important line in the recovery
path.

## K. Provider connection model

```ts
ConnectedAccount {
  connectionId  // device-minted UUID; the identity everything hangs off
  abaUserId     // scoping label, NOT an authorization input
  providerId    // provider family
  protocol      // wire protocol: openai-compatible | anthropic | gemini
  authKind      // api_key | oauth2
  displayName · accountLabel · baseUrl? · modelId
  capabilities · capabilityScope · status · lastValidated · createdAt
}
```

No secret in the record. The credential is at `credentials:conn:<connectionId>`
and nothing that lists accounts can reach it.

`openai-compatible` stays protocol-oriented and takes an arbitrary `baseUrl`,
so DeepSeek, Groq, Together, Mistral, Kimi, Qwen and OpenRouter connect without
a provider-specific adapter. **Protocol compatibility is not capability
compatibility** — the capability doctor still measures every
`{connectionId, modelId}` pair, and a measurement scoped to one never transfers
to another.

## L. Credential recovery model

Provider API keys are **`SECRET_LOCAL_ONLY`** in the shipping design. They are
never sent to the backend, encrypted or otherwise, in this wave.

They are stored at `credentials:conn:<connectionId>` — keyed by _connection_,
never by provider. The legacy `credentials:apiKey:<providerId>` scheme is what
made two accounts on one provider overwrite each other, and the two are
reached through separate methods so a provider id cannot be passed where a
connection belongs. Verified against real `chrome.storage.local` in
`TEST-E2E-020`, not only against a fake.

On restore, connection metadata comes back and the credential does not. The
account is marked `status: 'disconnected'` with a reason the UI states
verbatim:

> _"Your OpenAI — Work connection was restored, but its API key needs to be
> reconnected on this device."_

This is strictly better than losing the account, and it never pretends a
credential still works. Under K1 these could become
`SECRET_RECOVERABLE_ONLY_IF_SECURE_DESIGN_EXISTS` — not before.

## M. AI Brain model

`{ connectionId, modelId }`, keyed per `abaUserId` in `active-brains`.

Switching preserves every P-033 property and **strengthens one**:

| Property                 | Under multi-account                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Capability invalidation  | `capabilityScope: {connectionId, modelId}`; any mismatch → `UNKNOWN_CAPABILITIES`                                                                                                                                                    |
| **Consent invalidation** | **Defect fixed.** `ProviderPin.identity` is `providerId@origin`, so two OpenAI accounts shared one identity and consent for a personal key silently authorised a work key. `connectionId` is now compared **first** in `matchesPin`. |
| Credential isolation     | one credential per `connectionId`                                                                                                                                                                                                    |
| Taint preservation       | unchanged; a switch re-evaluates, never inherits                                                                                                                                                                                     |
| No silent fallback       | removing the brain's account clears the brain rather than re-pointing it                                                                                                                                                             |

## N. Legacy migration

Ordering is the design:

1. write the new credential → 2. write the account record → 3. **read both back
   and verify** → 4. only then delete the legacy credential → 5. only then write
   the marker.

A crash leaves either the old key alone (1–3) or both copies (4). Never
neither. Idempotent. Never throws — startup must continue.

Migrated accounts are `abaUserId: 'unassigned'`, because migration runs before
anyone signs in. **Unowned data is never claimed automatically.**
`associationOffer()` asks; `associateUnassigned()` acts only on explicit
confirmation; `declineAssociation()` records a no and deletes nothing. On a
shared or handed-down profile, auto-claiming would hand one person another
person's provider credentials with no way to undo it —
`bindAccountToUser` permits no second move.

Capability measurements are deliberately dropped: a measurement taken before
the account had an identity cannot be scoped to one, and a stale measurement
reads as evidence.

## O–R. Lifecycle behaviours

| Event                   | Session                      | Persistent data                                                                                 |
| ----------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| **O.** Logout           | cleared                      | **untouched** — accounts, keys, brain, tasks, workflows, shortcuts, audit, preferences all kept |
| **P.** Access expiry    | silent refresh               | untouched                                                                                       |
| **P.** Refresh expiry   | re-auth required             | untouched                                                                                       |
| **Q.** Backend outage   | `offline_grace` up to 7 days | untouched                                                                                       |
| **Q.** Grace lapsed     | re-auth required             | **untouched** — nothing is deleted to demand a sign-in                                          |
| **R.** Account deletion | revoked                      | the **only** normal destructive path, and it is two separate erasures                           |

Account deletion erases the backend account. It **cannot** reach browser-local
storage, so the local wipe is a second, explicit action. Claiming "your data is
deleted" while an API key remains on disk would be a lie.

## S. Privacy / data-flow model

**"No data leaves the device" must be removed everywhere it appears** once
authentication ships — PRIVACY.md, store-listing.md, the panel, the README.

|                 | ABA backend sees                                                                          | AI provider sees                                   |
| --------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Content         | email, `abaUserId`, IP + timestamp (rate limiting); under Cloud Sync, **ciphertext only** | prompts, page text, screenshots                    |
| Governed by     | our privacy policy                                                                        | the existing egress/taint/consent model, unchanged |
| Sees the other? | never sees prompts or page content                                                        | never sees the email or session                    |

Neither layer gains anything from the other existing.

## T. Security threat model

| Threat                                   | Control                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity path leaks page data            | new `identity` egress channel pinned to one backend origin; no task context parameter; not in `ToolRegistry`; narrow payload schema              |
| New unguarded network primitive          | the identity transport calls `guardedSend` and takes an injected port, **not** a `fetchImpl`, so the three-holder invariant stays three          |
| Cross-account consent                    | `connectionId` compared first in `matchesPin`                                                                                                    |
| Cross-user data access                   | `visibleTo()` filters by `abaUserId`; `setBrain` refuses another user's connection                                                               |
| Silent account merge                     | refused; explicit linking with fresh proof only                                                                                                  |
| Pre-hijack via unverified email          | no `auth_method` is ever created with `email_verified: false`                                                                                    |
| Google `email_verified: false`           | never links, never matches on email                                                                                                              |
| OTP brute force                          | Argon2id hash, 5 attempts, 10-min TTL, rate limits, constant-time compare                                                                        |
| Backend reads user work                  | K1 end-to-end encryption; backend holds ciphertext                                                                                               |
| Sync overwrites work                     | per-record revisions; workflows/shortcuts fork rather than overwrite                                                                             |
| Credential in the cloud                  | API keys are `SECRET_LOCAL_ONLY`; never uploaded                                                                                                 |
| **Extension id change on reinstall (I)** | any `chrome-extension://` redirect URI breaks. The §4 design redirects to **our own https origin** instead, so reinstall does not break sign-in. |

Consumer AI website automation, cookie extraction, and reading browser session
state are **out of scope and prohibited**. Provider authorization uses the
provider's official mechanism or is not implemented.

## U. Backend schema

Four tables, ten endpoints, no provider secrets, no page data.

```
aba_user        id · created_at · deleted_at
auth_method     id · aba_user_id · kind · google_sub(uniq) · email(uniq,lower)
                · email_verified · linked_at
session         id · aba_user_id · refresh_token_hash(argon2id)
                · expires_at · revoked_at
login_challenge id · method · pkce_challenge · state · nonce · email
                · otp_hash · attempts · expires_at · consumed_at
sync_record     aba_user_id · record_id · type · revision · updated_at
                · device_id · deleted · ciphertext      (Cloud Sync only)
```

`POST /v1/auth/{start, email/verify, exchange, refresh, logout, logout-all,
link/start, link/complete}` · `GET /v1/auth/google/callback` · `GET /v1/me` ·
`DELETE /v1/me` · `GET|POST /v1/sync`.

## V. UI flow

```
Sign In                  Data Storage                  Settings
[ Sign in with Google ]  ( ) Local on this device      Signed in as …
      or                 ( ) Cloud Sync                Connected AI Accounts
[ Continue with Email ]  ( ) Ask me later                OpenAI — Personal
                                                         OpenAI — Work
                                                         Anthropic — Claude
                                                       + Connect AI Provider
                                                       AI Brain: ● OpenAI — Personal / GPT-…
```

**The existing API-key connection forms are moved under `+ Connect AI
Provider`, not rewritten.** Base URL, API key, model, Connect and Run
capability check all keep working exactly as they do today.

## W. Test strategy

`TEST-SECURITY-035` covers the persistence invariant with 25 cases, including
the 17 named in the requirement. Its core assertion is a **whole-keyspace
diff**: after any session operation, only keys under `identity-session:` may
differ. That protects stores not yet written.

Mutation targets on production code (never on a test's own copy of the logic):
`connectionId` isolation in `matchesPin` · the `ALREADY_OWNED` guard in
`bindAccountToUser` · the `NOT_A_USER_ID` guard · `DIFFERENT_USER` in
`recordSignIn` · migration read-back verification · credential-before-record
ordering in `remove` · the identity-origin pin · `email_verified` linking ·
OTP attempt counting · sync `baseRevision` checking.

Reinstall cases 9–11 (extension reinstall, profile recreation, Chrome
reinstall) are modelled by **discarding the local storage area and rebuilding
every store**, which is exactly what those events do. True Chrome uninstall is
not automatable and is recorded as a **HUMAN-BLOCKED** manual acceptance step —
never reported as PASS.

---

## Data classification

| Data                                  | Classification                                               |
| ------------------------------------- | ------------------------------------------------------------ |
| Provider API keys                     | `SECRET_LOCAL_ONLY`                                          |
| ABA refresh token                     | `SECRET_LOCAL_ONLY`                                          |
| ABA access token                      | `NEVER_PERSISTED` (memory only)                              |
| Google `id_token`                     | `NEVER_PERSISTED` (never reaches the extension)              |
| Google access/refresh token           | `NEVER_PERSISTED` (never requested)                          |
| OTP code                              | `NEVER_PERSISTED` client-side                                |
| PKCE verifier · state · nonce         | `NEVER_PERSISTED` (memory, single-use)                       |
| `abaUserId` · email · `emailVerified` | `CLOUD_SYNCED` (backend is authority)                        |
| Connection metadata                   | `USER_SELECTABLE` (local, or cloud if Cloud Sync)            |
| AI Brain selection                    | `USER_SELECTABLE`, keyed per device                          |
| Tasks (terminal only)                 | `USER_SELECTABLE`, E2E-encrypted under K1                    |
| Workflows · shortcuts                 | `USER_SELECTABLE`, E2E-encrypted under K1                    |
| Preferences                           | `USER_SELECTABLE`                                            |
| Audit trail                           | `USER_SELECTABLE`, per-device chains, E2E-encrypted under K1 |
| Evidence digests                      | `LOCAL_ONLY`                                                 |
| Persistence health                    | `LOCAL_ONLY`                                                 |
| Policy state                          | `LOCAL_ONLY`                                                 |
| `deviceId`                            | `LOCAL_ONLY`                                                 |
| Connector OAuth tokens                | `SECRET_LOCAL_ONLY`                                          |
| Page content · screenshots            | `NEVER_PERSISTED` to the ABA backend, under any setting      |

No entry is ambiguous. Anything added later must be classified here before it
is persisted.

---

## Account-owner decisions — confirmed

1. **K1 confirmed.** Cloud Sync of sensitive user work uses client-side
   end-to-end encryption under a passphrase-derived key. The backend must not
   be able to read task content, page-derived summaries, workflows, sensitive
   shortcuts, or audit/history content. The plaintext passphrase is never
   stored on the backend. The encryption design itself is still to be written
   and reviewed before implementation.
2. **Metadata-only Cloud Sync is the first milestone.** Identity metadata,
   connection metadata (`connectionId`, `providerId`, protocol, `authKind`,
   `accountLabel`, model and safe capability metadata), safe preferences,
   workspace metadata once it exists, and sync bookkeeping. Task bodies, page
   content, prompts, screenshots, sensitive workflow content and audit
   content are **not** synced until E2EE is implemented and validated.
3. **Provider API keys remain `SECRET_LOCAL_ONLY` permanently.** Never
   uploaded, encrypted or otherwise. After a reinstall, connection metadata is
   restored and the credential requires a reconnect — and user work is never
   deleted because a credential is unavailable.

---

## Browser Workspace boundary — designed, not implemented

The design review has since been carried out and lives in
[`BROWSER_WORKSPACE.md`](./BROWSER_WORKSPACE.md). **No workspace code exists
yet**; that document is a review awaiting approval, and its §22 is the
implementation plan.

Summarised here because two of its constraints bear directly on identifiers
this wave introduced.

The requirement: activating the agent from a tab makes that tab the initial
context of a _workspace_; tabs the agent opens join the same Chrome tab group;
only tabs in the active workspace count as live browser context; the user can
drag tabs in and out to change membership.

Three things to settle before any of it is built, flagged now because they are
where this design would go wrong:

1. **Chrome ids are not application identity.** `tabGroupId`, `tabId` and
   `windowId` are runtime handles: they do not survive a browser restart, and
   a group the user ungroups takes its id with it. A `workspaceId` minted and
   persisted by this extension is the durable identity, with Chrome ids
   re-bound to it at startup. Using a `tabGroupId` as the stored key would
   make every workspace evaporate on restart, which is the same class of
   mistake as binding user data to a session.
2. **Membership is a boundary, not an authorization.** A tab being inside the
   workspace must not shortcut origin policy, consent, taint, the egress gate,
   route trust or `ToolRegistry`. The boundary can only ever _narrow_ what is
   considered context; it must never widen what may be done to it. That is the
   same relationship route trust has to policy — a filter in front, which can
   subtract and never add.
3. **It must not be coupled to the AI brain.** Switching workspace must not
   switch provider, and switching provider must not switch workspace. Two
   independent selections, following the separation this wave established
   between identity, accounts and brain.

Persistence follows §D and the classification table: `workspaceId` and its
membership are `USER_SELECTABLE` metadata; runtime Chrome ids are
`LOCAL_ONLY` and are never synced, because they mean nothing on another
device.

Coverage would need real Chromium — tab-group membership, drag in and out,
ungroup, close and navigate are browser behaviours a fake cannot establish —
plus mutation tests on the isolation guard.
