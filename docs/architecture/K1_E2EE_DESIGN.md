# K1 — End-to-End Encryption for Cloud Sync

Status: **design, pending review. Nothing here is implemented.** No production
code was changed to produce this document, and none may change until it is
reviewed and approved. There is no backend, no Cloud Sync transport and no
encryption code in the repository.

Baseline: `f7e09e6`, CI #45 green, 2267 unit/integration/security and 213 real
Chromium tests.

---

## 1. Purpose and scope

Cloud Sync must let a person recover their work on a new device without the AI
Browser Agent backend being able to read that work. Everything sensitive is
encrypted on the device, under a key derived from a secret the backend never
receives. The backend stores ciphertext and the small amount of plaintext
metadata synchronisation genuinely requires.

**In scope:** key hierarchy, KDF, cipher, envelope, associated data, what the
backend may see, revision and rollback handling, device identity, recovery,
reinstall, logout, account deletion, versioning and rotation.

**Out of scope for this document** — named because they are adjacent and must
not be assumed: the backend's own schema and endpoints, the authentication
flows (Google, email), provider OAuth, the sync transport itself, and the UI.

## 2. Security goals

| #   | Goal                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| G1  | The backend cannot read task, workflow, shortcut, audit or workspace content, whether honest, compromised, or operated by someone hostile. |
| G2  | The backend never receives the passphrase or anything password-equivalent.                                                                 |
| G3  | Ciphertext cannot be moved between users, between records, or between record types without decryption failing.                             |
| G4  | A stale or replayed record cannot silently overwrite a newer one.                                                                          |
| G5  | Provider API keys never leave the device, in any form, encrypted or not.                                                                   |
| G6  | Losing a session, a device, or the backend never destroys user work.                                                                       |
| G7  | Losing local storage never creates a second identity for the same account.                                                                 |
| G8  | Cloud Sync grants no browser authority: it is storage, never a permission.                                                                 |

## 3. Explicit non-goals

- **Not** protection against a compromised device. An attacker with code
  execution in the extension's context while it is unlocked sees plaintext.
  Nothing client-side can prevent that, and claiming otherwise would be false.
- **Not** server-side passphrase recovery. Losing the passphrase means losing
  the plaintext (decision 14). No escrow, no recovery key, no backdoor.
- **Not** metadata privacy. The backend learns record counts, sizes, types and
  timing. Hiding those needs padding and cover traffic, which is a different
  design with real cost.
- **Not** protection against a fully consistent rollback of _all_ state to a
  client holding no prior state. See §15.
- **Not** multi-user sharing, multi-tenant access control, or key exchange
  between people. There is one user per key.

## 4. Threat model

| Threat                          | Handled by                                                  | Residual                                                                 |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| Backend compromise              | ciphertext only; keys never leave the device                | metadata (counts, sizes, timing)                                         |
| Database compromise             | same                                                        | same                                                                     |
| Network interception            | TLS + ciphertext at rest in transit                         | traffic analysis                                                         |
| Malicious backend operator      | cannot decrypt; §10 binding stops transplant                | can delete or withhold — availability, not confidentiality               |
| Stolen ciphertext               | AES-256-GCM; key not present                                | offline guessing against the KDF — see §7                                |
| Stolen local ciphertext         | same, and the device holds no plaintext key at rest         | same                                                                     |
| Passphrase guessing             | KDF cost + entropy                                          | **the weakest point in the design.** See §7 and Q1                       |
| Passphrase loss                 | nothing — by decision                                       | data unreadable, permanently                                             |
| Replayed sync record            | server-enforced monotonic revision, AAD binding             | see §15                                                                  |
| Rollback of old records         | monotonic revision + client high-water mark                 | a client with no retained state cannot detect a consistent full rollback |
| Cross-user ciphertext confusion | `abaUserId` in AAD → GCM auth fails                         | —                                                                        |
| Device loss                     | device holds no long-term plaintext key; sessions revocable | whatever was on screen                                                   |
| Storage loss                    | recovery from cloud, §17                                    | local-only data is gone; stated, never promised otherwise                |
| Session theft                   | a session decrypts nothing — §19                            | attacker can read sync _metadata_ and delete records                     |
| Provider credential leakage     | never synced, never in an envelope, no field to hold one    | device compromise                                                        |
| Accidental plaintext logging    | §22, enforced by the existing redaction layer and tests     | —                                                                        |

## 5. Trust boundaries

```
  User  (knows the passphrase)
    │  passphrase, typed, never stored
    ▼
  Chrome extension  ── TRUSTED. Holds plaintext and keys, in memory, while unlocked.
    │
    ├──▶ chrome.storage.local   ── local ciphertext + non-secret metadata
    │                              + provider API keys (NEVER synced)
    │
    ├──▶ Auth/session backend   ── SEMI-TRUSTED. Proves who you are.
    │                              Never sees the passphrase or any key.
    │
    └──▶ Cloud Sync storage     ── UNTRUSTED for confidentiality.
                                   Ciphertext + sync metadata only.
```

Seven identities, deliberately separate. Conflating any two is a defect:

| Identity                       | What it is                  | Lifetime                 | Synced?                    |
| ------------------------------ | --------------------------- | ------------------------ | -------------------------- |
| `abaUserId`                    | the account                 | permanent until deletion | yes (backend is authority) |
| auth session                   | proof you are signed in now | minutes to 30 days       | no                         |
| `deviceId`                     | this installation           | until reinstall          | as metadata                |
| `workspaceId`                  | a browser context boundary  | until deleted            | metadata, encrypted body   |
| `taskId` / workflow / shortcut | user work                   | until deleted            | encrypted                  |
| `connectionId`                 | a connected AI account      | until disconnected       | metadata, encrypted body   |
| provider credential            | the API key                 | until disconnected       | **never**                  |

## 6. Key hierarchy

```
passphrase  (or generated recovery key — see Q1)
   │  PBKDF2-HMAC-SHA-256, per-user salt              §7
   ▼
MK    master key, 256 bits, memory only, never stored, never transmitted
   │  HKDF-SHA-256, info = "aba/k1/kek/v1"            domain separation
   ▼
KEK   key-encryption key, 256 bits, memory only
   │  AES-256-GCM wrap, AAD = record binding          §10
   ▼
DEK   per-record, 256 bits, random, stored only wrapped
   │  AES-256-GCM
   ▼
record ciphertext
```

**One DEK per record.** The alternatives were considered and rejected:

- _One key for everything_ — every record encrypted under the same key with
  random 96-bit GCM nonces. Nonce collision probability grows with the square
  of the record count, and a collision under GCM is catastrophic, not merely
  untidy. It also makes a passphrase change a full re-encryption of every byte
  the user owns.
- _One DEK per collection_ — better, but a passphrase change still re-encrypts
  whole collections, and a leaked collection key exposes everything in it.

Per-record wins on three counts. Each DEK is used for exactly one message, so
nonce reuse across records is structurally impossible. **A passphrase change
re-wraps DEKs and re-encrypts nothing** — O(records) small operations rather
than O(bytes). And a DEK that leaks exposes one record.

The cost is ~44 bytes of wrapped DEK per record, which is not a consideration.

The KEK wraps many DEKs under random 96-bit nonces. The birthday bound gives
~2⁻³² collision probability at 2³² wraps; a user will not own four billion
records. Documented rather than assumed.

Domain separation, user binding, record binding, versioning and rotation are
delivered by: the HKDF `info` string, `abaUserId` in AAD, `recordId` in AAD,
`v`/`keyVersion` in the envelope, and §25.

## 7. Key derivation function

### The constraint, stated first

**Argon2id is not available.** WebCrypto offers PBKDF2, HKDF, AES-GCM, AES-KW,
HMAC, ECDH, ECDSA and RSA — no Argon2, no scrypt, no bcrypt. Argon2id would
need WebAssembly, and this extension's CSP is

```
script-src 'self'; object-src 'self'
```

with **no `wasm-unsafe-eval`** (`public/manifest.json:45`). Loading a WASM
Argon2 requires adding that directive, which widens what the extension can
execute and is outside what this design may change. A pure-JavaScript Argon2id
is not an acceptable substitute: memory-hard functions in JS are orders of
magnitude slower and their timing behaviour is not something to rely on.

### The choice

|            |                                                                                |
| ---------- | ------------------------------------------------------------------------------ |
| Algorithm  | **PBKDF2-HMAC-SHA-256** (RFC 8018), via `crypto.subtle.deriveBits`             |
| Iterations | **600 000**                                                                    |
| Salt       | 16 bytes from `crypto.getRandomValues`, per user, stored as plaintext metadata |
| Output     | 256 bits                                                                       |
| Encoding   | base64url, unpadded, for every binary field                                    |
| Version id | `kdf: "PBKDF2-HMAC-SHA256"`, `kdfParams: { iterations, saltLen }`              |

600 000 iterations is OWASP's published guidance for PBKDF2-HMAC-SHA-256. It
is a defensible figure with a citable source rather than one chosen to feel
large, which is the only reason to prefer it.

### The honest weakness

PBKDF2 is **not memory-hard**. Against an attacker with GPUs or ASICs and a
stolen ciphertext, it is materially weaker than Argon2id at equivalent
wall-clock cost. A user who chooses a weak passphrase is not protected by this
design to the degree the phrase "end-to-end encrypted" tends to imply.

Two mitigations, the second of which is the real answer:

1. Refuse passphrases below a measured strength floor at the point of setting
   one, rather than warning and accepting.
2. **Offer a generated 128-bit recovery key as the default secret** —
   displayed once as words or base32, which the user stores. Against a
   high-entropy secret, KDF hardness stops mattering: there is no low-entropy
   guess space to grind. This turns the weakest element of the design into a
   non-issue.

Option 2 is a product decision with a real usability cost and is **Q1** in §29.
It is not decided here.

### Parameter upgrade

`kdfParams` is stored per user alongside the salt. Raising the iteration count
later re-derives MK from the existing passphrase under the new parameters and
re-wraps DEKs — no re-encryption. A client encountering `kdfParams` it does not
support refuses with `UNSUPPORTED_KDF` and does not guess.

### What the backend receives

The backend receives the **salt** and `kdfParams`, both non-secret and both
required to derive on a new device. It receives no passphrase, no MK, no KEK,
no DEK, and no value derived from the passphrase that could be replayed as a
credential. Authentication uses an entirely separate mechanism (§19).

## 8. Encryption algorithm

|           |                                                             |
| --------- | ----------------------------------------------------------- |
| Algorithm | **AES-256-GCM**, via `crypto.subtle.encrypt` / `decrypt`    |
| Key       | 256 bits                                                    |
| Nonce     | **96 bits**, `crypto.getRandomValues`, fresh per encryption |
| Tag       | **128 bits**, appended to the ciphertext by WebCrypto       |
| AAD       | §10                                                         |

AES-GCM provides confidentiality and integrity together; the tag covers both
the ciphertext and the associated data, which is what makes §10's binding
enforceable rather than advisory. Nothing here is invented: AES-256-GCM,
PBKDF2 and HKDF are all standard and all native to the platform.

96 bits is the nonce size GCM is specified and analysed for. Nonces are random
rather than counter-based because a counter needs reliable persistent state
per key, and a counter that resets — after a reinstall, a crash, a restored
backup — reuses a nonce, which is the one failure GCM does not survive. With a
per-record DEK used exactly once, a random nonce cannot collide with itself.

**Failure behaviour: decryption failure is final.** A tag mismatch means the
ciphertext, the AAD, or the key is wrong; the record is not decrypted, not
partially decrypted, and not repaired. It is reported per §23 and the local
copy is left untouched.

## 9. Envelope format

JSON. Binary fields are base64url without padding.

```jsonc
{
  "v": 1, // envelope version (integer)
  "alg": "AES-256-GCM", // content cipher
  "kdf": "PBKDF2-HMAC-SHA256",
  "kdfParams": { "iterations": 600000, "saltLen": 16 },
  "salt": "…", // 16 bytes, per user
  "keyVersion": 1, // increments on rotation, §25
  "wrap": {
    "nonce": "…", // 12 bytes
    "dek": "…", // wrapped DEK + tag
  },
  "nonce": "…", // 12 bytes, content
  "ct": "…", // ciphertext + 16-byte tag
}
```

Field classification, which is the part that matters:

| Field                                                                                 | Class                                                                          |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `v`, `alg`, `kdf`, `kdfParams`, `salt`, `keyVersion`                                  | **plaintext metadata** — the backend sees it, none of it is secret             |
| `wrap.nonce`, `wrap.dek`, `nonce`                                                     | plaintext metadata, meaningless without the passphrase                         |
| `abaUserId`, `recordId`, `recordType`, `schemaVersion`, `revision`, `v`, `keyVersion` | **authenticated, not encrypted** — carried in the sync row, bound by AAD (§10) |
| `ct`                                                                                  | **encrypted** — the record body, and nothing else                              |

`v` and `keyVersion` appear both as envelope fields and in the AAD. That is
deliberate: it stops an attacker editing the plaintext header to steer a client
onto a different algorithm or key while the tag still verifies.

## 10. Associated data

AAD is authenticated and not encrypted. Its purpose is to make a ciphertext
mean something only in the exact place it was written.

```
AAD = concat(
  field("aba/k1/aad/v1"),   // domain separator
  field(abaUserId),
  field(recordId),
  field(recordType),
  field(uint(schemaVersion)),
  field(uint(revision)),
  field(uint(v)),
  field(uint(keyVersion)),
)

field(x) = uint32be(byteLength(utf8(x))) || utf8(x)
```

**Length-prefixed, not JSON.** Canonical JSON has more than one plausible
canonicalisation, and an ambiguous AAD encoding is a way to make two different
contexts produce identical bytes. Length prefixes remove the question: no field
value can be split or merged across a boundary.

The same wrap AAD binds the DEK, so a wrapped DEK cannot be moved either.

What each field prevents:

| Field             | Attack it defeats                                                    |
| ----------------- | -------------------------------------------------------------------- |
| `abaUserId`       | serving user A's ciphertext to user B                                |
| `recordId`        | substituting one record's ciphertext for another's                   |
| `recordType`      | presenting a workflow as a preference to reach a different code path |
| `schemaVersion`   | feeding an old body shape to a new parser                            |
| `revision`        | presenting an old body as the current one                            |
| `v`, `keyVersion` | downgrading the algorithm or key while the tag still checks          |

`deviceId` is deliberately **not** in the AAD. A record written on one device
must decrypt on another; binding it to a device would break the entire point.

## 11. Cloud Sync payload

A sync row is envelope plus routing metadata:

```jsonc
{
  "abaUserId": "usr_…",
  "recordId":  "task_…",
  "recordType":"task",
  "schemaVersion": 1,
  "revision": 42,
  "deviceId": "dev_…",
  "updatedAt": 1700000000000,
  "serverSeq": 918273,
  "deleted": false,
  "envelope": { … }
}
```

**The backend may see** `abaUserId`, `recordId`, `recordType`,
`schemaVersion`, `revision`, `deviceId`, `updatedAt`, `serverSeq`, `deleted`,
and the envelope's plaintext header (`v`, `alg`, `kdf`, `kdfParams`, `salt`,
`keyVersion`, nonces, wrapped DEK, ciphertext bytes).

**The backend must never see** plaintext tasks, workflows, shortcuts, audit
content, workspace titles or member origins, page content, prompts, model
responses, provider API keys, provider OAuth secrets, the passphrase, MK, KEK
or any DEK.

**Audit data is encrypted, not metadata-only.** An audit record carries
`destination`, `origin` and `site` — browsing history in all but name. Its body
goes in `ct`. What stays plaintext is the ordering metadata the sync needs:
`recordId`, `deviceId`, `revision`, `serverSeq`.

The audit chain's `seq` and `prevDigest` are inside the ciphertext. The backend
therefore cannot verify the chain — which it never could and was never asked
to. Verification is a client-side property, unchanged.

## 12. The metadata-only phase

> **Finding that shapes this section.** `deriveAccountLabel`
> (`account-model.ts:186`) produces `"api.openai.com (key …1234)"` — the **last
> four characters of the API key**. It has been described as safe connection
> metadata. It is not: it is a fragment of a credential, and decision 9 says
> provider keys never reach the backend. Four characters is not a key, but it
> is key material, and the rule does not have a size threshold.

"Metadata-only" means **which record types sync**, not that they sync in the
clear. The two readings must not be confused, and the requirement is explicit
that sensitive content is never uploaded in plaintext.

**Recommendation: the envelope exists from the first Cloud Sync commit.** One
wire format, not two. Anything that is not structural sync metadata is
encrypted, whichever phase it ships in. A second plaintext format shipped
"temporarily" is the kind of thing that outlives its phase.

| Phase 1 syncs                                                                | As                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------- |
| `connectionId`, `providerId`, `protocol`, `authKind`, `modelId`, `status`    | plaintext row fields — structural, no user content      |
| `revision`, `deviceId`, `updatedAt`, `serverSeq`, `deleted`                  | plaintext row fields                                    |
| `salt`, `kdfParams`                                                          | plaintext, non-secret, needed to derive on a new device |
| `accountLabel`, capability details, workspace title and origins, preferences | **encrypted body**                                      |

| Phase 1 does **not** sync                     | Why                               |
| --------------------------------------------- | --------------------------------- |
| tasks, workflows, shortcuts, audit            | deferred to phase 2 by decision 2 |
| page content, prompts, responses, screenshots | never sync, any phase             |
| provider API keys, OAuth secrets              | never sync, permanently           |

## 13. Record types

| Record                       | Cloud?    | Body encrypted? | Notes                                                     |
| ---------------------------- | --------- | --------------- | --------------------------------------------------------- |
| task                         | phase 2   | yes             | terminal tasks only (§14)                                 |
| workflow                     | phase 2   | yes             | fork on conflict                                          |
| shortcut                     | phase 2   | yes             | fork on conflict                                          |
| audit                        | phase 2   | yes             | per-device streams; `seq`/`prevDigest` inside `ct`        |
| preferences                  | phase 1   | yes             | field-level merge after decryption                        |
| workspace metadata           | phase 1   | yes             | title and origins are browsing signal                     |
| workspace runtime binding    | **never** | n/a             | `LOCAL_ONLY`; tab/group/window ids mean nothing elsewhere |
| provider connection metadata | phase 1   | partly          | structural fields plaintext; `accountLabel` encrypted     |
| **provider credentials**     | **never** | n/a             | **`SECRET_LOCAL_ONLY`, permanently**                      |
| ABA refresh/access token     | never     | n/a             | session material, not user work                           |

There is no field in `SyncRow` or the envelope that can hold a provider
credential. That is the enforcement: not a rule to remember, but the absence of
a place to put one.

## 14. Sync revision model

Per-record `revision`, monotonically increasing per `(abaUserId, recordId)`.
Writes are conditional: the client sends `baseRevision`, and the server rejects
the write if the stored revision has moved. No global last-write-wins.

**Comparison needs no plaintext.** Conflict _detection_ is a comparison of
integers in the plaintext row. Conflict _resolution_ happens on the client,
after decryption, where the content is readable. The backend arbitrates
ordering; it never arbitrates meaning.

| Type                | Conflict handling                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| tasks               | **sync only when terminal.** A running task belongs to the device running it, and a terminal task is immutable — the conflict is removed rather than resolved                        |
| workflows           | **fork.** The loser becomes `"<name> (edited on <device>)"`. Never silently overwritten                                                                                              |
| shortcuts           | fork, disambiguating the name                                                                                                                                                        |
| preferences         | field-level LWW on per-field `updatedAt`; independent scalars, so no work is destroyed                                                                                               |
| connection metadata | `connectionId` is device-minted and unique, so only the same connection's fields collide → field-level LWW                                                                           |
| workspace metadata  | field-level LWW on title; membership is local runtime state and does not sync                                                                                                        |
| audit               | **no conflict.** Per-device append-only streams, never interleaved — merging two chains destroys the `seq`/`prevDigest` property they exist for. Merged into one _view_ at read time |

Deletes are tombstones (`deleted: true`), retained 90 days, so a delete on one
device is not resurrected by another's stale copy.

## 15. Replay and rollback protection

| Mechanism                                       | Purpose                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| server-enforced monotonic `revision` per record | a stale write is rejected, not merged                                   |
| `serverSeq`, monotonic per user                 | a total order the client can page and check for gaps                    |
| `revision` in the AAD                           | an old body cannot be presented as the current revision — the tag fails |
| client high-water mark per record               | a served revision lower than one already seen is rejected locally       |
| tombstones                                      | a delete is a fact, not an absence                                      |

**Client timestamps are never authoritative.** They are display metadata and a
tiebreak for independent preference fields, nothing more; clocks are wrong,
and on a hostile client they are whatever it says.

**The residual, stated plainly.** A client with _no_ retained state — a fresh
install — cannot distinguish the current server state from a consistent
rollback of everything to an earlier point. It has nothing to compare against.
An encrypted manifest of record→revision only moves the problem up one level,
since the manifest can be rolled back too. Detecting this needs an
out-of-band trust anchor, which this design does not have and does not pretend
to. A device that has synced before _does_ detect rollback, via its high-water
marks.

## 16. Device identity

`deviceId` is `dev_` + `crypto.randomUUID()`, generated on first use and held
in `chrome.storage.local`.

- **Not secret.** It is a label. Nothing is authorised by presenting one, and a
  forged `deviceId` gains nothing.
- **Not derived** from any Chrome runtime handle. Extension ids, tab ids, group
  ids and window ids are runtime state: they change on reinstall, are recycled,
  and mean nothing on another machine.
- **Unique per installation**, and a reinstall produces a new one. Two
  `deviceId`s for one physical machine is normal and harmless.
- **Independent of `abaUserId`.** One account has many devices; one device may
  be used by one account at a time.

It exists so audit streams stay per-device and so a conflict can name the other
side. It is not an authentication factor.

## 17. Recovery

```
empty local state
  → authenticate (Google or email)
  → backend resolves the SAME abaUserId          ← never mints a new one
  → fetch manifest: salt, kdfParams, record list
  → prompt for the K1 passphrase
  → derive MK → KEK; verify against the key-check value
  → fetch and decrypt records
  → write local state
```

A **key-check value** — a fixed known plaintext encrypted under the KEK — lets
a wrong passphrase be reported immediately rather than as a wall of decryption
failures. It leaks nothing beyond what any ciphertext already offers an offline
guesser.

| Situation               | Behaviour                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| wrong passphrase        | key-check fails → `WRONG_PASSPHRASE`, retry offered, nothing written, no rate-limit bypass implied                                                    |
| lost passphrase         | the data cannot be decrypted. By decision 14 there is no recovery. The user may start fresh, which is an explicit destructive choice, never automatic |
| partial restore         | per-record. Records that decrypt are restored; those that do not are listed as unreadable and **kept** as ciphertext, never deleted                   |
| corrupted ciphertext    | tag fails → that record is unreadable; the rest proceed                                                                                               |
| revoked authentication  | no manifest, no restore; local state untouched                                                                                                        |
| unavailable backend     | restore deferred; the extension works locally                                                                                                         |
| duplicate device        | normal — a new `deviceId`, both sync                                                                                                                  |
| conflicting local state | local data is never discarded to make room. Records merge per §14; a true conflict forks                                                              |

## 18. Extension reinstall

Uninstalling the extension may destroy `chrome.storage.local` entirely.

After reinstall, authenticating with the same identity:

- recovers the **same** `abaUserId` — never a new one (decision 12);
- restores encrypted work once the passphrase is supplied;
- **does not restore provider API keys** — they were never uploaded;
- leaves connections needing a secret marked `disconnected` with the reconnect
  notice already implemented (`CREDENTIAL_RECONNECT_NOTICE`);
- downloads no provider secret, because none exists to download.

Restoring the shape of someone's setup and asking for one key back is better
than losing the account, and far better than presenting a connection that will
fail at its first request with an error the user cannot interpret.

## 19. Relationship to authentication

**Authentication is not the encryption key.** A session proves who you are. The
passphrase decrypts. A backend session is deliberately insufficient to read
anything: an attacker holding a stolen session token can enumerate record ids,
types, sizes and timings, and can delete records — an availability and metadata
problem, not a confidentiality one.

The two secrets must never be derivable from each other. The passphrase is
never sent, never used as a login factor, and never stored server-side in any
form — not hashed, not as a verifier.

### 19A. Authentication outage grace

| State                                              | Behaviour                                       |
| -------------------------------------------------- | ----------------------------------------------- |
| authenticated                                      | normal                                          |
| backend unreachable, within 7 days of last contact | `offline_grace`; everything local keeps working |
| past 7 days                                        | re-authentication required                      |

Past the grace period the **only** consequence is a sign-in prompt. No data is
deleted, `abaUserId` is not rotated, no work is orphaned, and nothing is
reset. The grace period extends authentication continuity and nothing else.

## 20. Logout

Logout destroys the access token and the refresh token, and revokes the session
server-side.

It does **not** delete: local encrypted work, cloud records, `abaUserId`, the
identity profile, workspace records, connection metadata, or provider
credentials. It does not expose a provider credential — it does not touch them.

This is structural, not a rule. `SessionStore` imports no account store, no
credential store, no profile and no task store, so the code that ends sessions
has no reachable path to user data.

## 21. Account deletion

The one destructive path, and it is **two** erasures that must not be conflated:

1. **Backend** — hard-delete `auth_method` and `session`; delete sync rows;
   tombstone `aba_user` (id and `deleted_at` only) for a 30-day replay window,
   then purge. Requires re-authentication within the last five minutes.
2. **Local** — a separate, explicit wipe of `chrome.storage.local`: accounts,
   credentials, tasks, workflows, audit, evidence, workspaces, identity.

Deleting the backend account **cannot** reach into browser storage. Saying
"your data is deleted" while an API key remains on disk would be a lie, so the
UI offers both and states which does what.

Audit consideration: a deletion record naming the account and time is retained
for the tombstone window. It carries no content.

Not implemented.

## 22. Logging rules

Never logged, in any build: the passphrase · MK, KEK or any DEK · KDF output ·
plaintext record bodies · ciphertext payloads · provider API keys · provider
OAuth secrets · page content · nonces paired with identifiable ciphertext.

May be logged: record id, record type, revision, device id, error code,
envelope version, byte counts.

The repository's existing redaction layer and its tests already forbid most of
this. The key material is new and must be added to that surface, not to a
separate one.

## 23. Error semantics

| Condition             | Code                                      | Message shape                                                                                                                  |
| --------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| wrong passphrase      | `WRONG_PASSPHRASE`                        | "That passphrase does not unlock this data."                                                                                   |
| corrupt envelope      | `ENVELOPE_INVALID`                        | "This record could not be read."                                                                                               |
| tag mismatch          | `DECRYPT_FAILED`                          | same as corrupt — deliberately indistinguishable                                                                               |
| auth failure          | `AUTH_REQUIRED`                           | "Sign in again to continue."                                                                                                   |
| authorization failure | `FORBIDDEN`                               | no hint whether the record exists                                                                                              |
| stale revision        | `STALE_REVISION`                          | "This changed on another device."                                                                                              |
| replay detected       | `REPLAY_REJECTED`                         | same shape as stale                                                                                                            |
| record mismatch       | `DECRYPT_FAILED`                          | an AAD mismatch is a decryption failure; saying _which_ field mismatched would tell an attacker which substitution to try next |
| unsupported version   | `UNSUPPORTED_VERSION` / `UNSUPPORTED_KDF` | "This data was written by a newer version."                                                                                    |

A wrong passphrase and a corrupted record are distinguishable to the user only
because the key-check value runs first, on data the user already controls.
Beyond that, failures are uniform.

## 24. Cryptographic versioning

`v` is the envelope version and the only field a reader may consult before
deciding how to parse. `v: 1` is this document.

- A client seeing a **higher** `v` refuses with `UNSUPPORTED_VERSION`. It does
  not guess, and it does not delete the record.
- A K2 introducing a different cipher or KDF increments `v`. K1 records stay
  readable by a K2 client; K1 clients refuse K2 records rather than
  mis-parsing them.
- `v` is in the AAD, so a header downgrade fails the tag.
- Records of mixed versions coexist; migration is per record and never a
  flag day.

## 25. Key rotation

Not implemented. Described so the design does not preclude it.

| Operation                                    | Work                                                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **passphrase change**                        | derive new MK/KEK from the new passphrase with a **new salt**; re-wrap every DEK; `keyVersion += 1`. **No record body is re-encrypted** — this is the payoff of per-record DEKs                                                |
| **key rotation** without a passphrase change | new random KEK sub-key via HKDF with a new `info` suffix; re-wrap; `keyVersion += 1`                                                                                                                                           |
| **algorithm migration**                      | new `v`; re-encrypt lazily on next write, or eagerly as a background pass                                                                                                                                                      |
| **re-encryption**                            | per record, idempotent, resumable; a partial run leaves a mix of `keyVersion`s, all readable                                                                                                                                   |
| **device revocation**                        | sessions are revoked server-side. A device that retained a KEK in memory is out of reach — revocation is not a cryptographic erase, and must not be described as one. Changing the passphrase is what invalidates a leaked KEK |

## 26. Backend knowledge boundary

| Information                                                 | Backend can see?     | Reason                                             |
| ----------------------------------------------------------- | -------------------- | -------------------------------------------------- |
| `abaUserId`                                                 | **yes**              | it is the account                                  |
| email, `googleSub`, `emailVerified`                         | **yes**              | authentication is its job                          |
| IP, timestamp                                               | **yes**              | rate limiting and abuse prevention                 |
| `recordId`, `recordType`, `schemaVersion`                   | **yes**              | routing and conflict detection                     |
| `revision`, `serverSeq`, `deviceId`, `updatedAt`, `deleted` | **yes**              | ordering, replay rejection, tombstones             |
| record count, size, write timing                            | **yes, unavoidably** | metadata privacy is an explicit non-goal (§3)      |
| KDF salt, `kdfParams`                                       | **yes**              | non-secret, and required to derive on a new device |
| envelope header, nonces, wrapped DEK, ciphertext            | **yes (as bytes)**   | useless without the passphrase                     |
| task, workflow, shortcut bodies                             | **no**               | encrypted                                          |
| audit content, `destination`/`origin`/`site`                | **no**               | browsing history; encrypted                        |
| workspace title, member origins                             | **no**               | browsing signal; encrypted                         |
| `accountLabel`                                              | **no**               | embeds the key's last four characters (§12)        |
| page content, prompts, model responses, screenshots         | **no**               | never uploaded, any phase                          |
| **provider API keys, OAuth secrets**                        | **no, permanently**  | `SECRET_LOCAL_ONLY`; no field exists to carry one  |
| passphrase, MK, KEK, DEK                                    | **no**               | never leave the device                             |
| Chrome tab / group / window ids                             | **no**               | local runtime state; meaningless elsewhere         |

## 27. Security invariants

Written to be testable, in the style of the repository's existing invariants.

| #    | Invariant                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| K-1  | No sync payload contains a provider credential — no field in `SyncRow` or the envelope can hold one.                   |
| K-2  | No request to the backend contains the passphrase, MK, KEK or any unwrapped DEK.                                       |
| K-3  | Given only a sync row, decryption without the passphrase fails.                                                        |
| K-4  | A row whose `abaUserId` is altered fails to decrypt.                                                                   |
| K-5  | A row whose `recordType` is altered fails to decrypt.                                                                  |
| K-6  | A row whose `recordId` is altered fails to decrypt.                                                                    |
| K-7  | A row whose `revision` is altered fails to decrypt.                                                                    |
| K-8  | A ciphertext from user A never decrypts under user B's key.                                                            |
| K-9  | A write with a stale `baseRevision` is rejected, never merged.                                                         |
| K-10 | A served revision below the client's high-water mark is rejected.                                                      |
| K-11 | Logout clears session keys and changes no byte of local user data.                                                     |
| K-12 | An authentication outage, up to and past the grace period, never changes `abaUserId`.                                  |
| K-13 | After a simulated reinstall, authenticating as the same identity yields the same `abaUserId`.                          |
| K-14 | Cloud Sync state is never an input to `authorizeEgress`, `ToolRegistry.dispatch`, route trust or workspace membership. |
| K-15 | No Chrome tab, group or window id appears in any sync payload.                                                         |
| K-16 | Every encryption uses a fresh nonce; no two records share a DEK.                                                       |
| K-17 | A passphrase change re-encrypts no record body.                                                                        |
| K-18 | No log record contains key material, a passphrase, or a plaintext body.                                                |
| K-19 | A record that fails to decrypt is retained, never deleted.                                                             |
| K-20 | An envelope with a higher `v` is refused, not parsed.                                                                  |

## 28. Implementation gates

None of these is optional, and none is satisfied by this document alone.

1. **Architecture review** of this document, and explicit approval.
2. **Cryptographic review** by someone who did not write it — specifically Q1,
   the AAD encoding, and the nonce argument.
3. **Threat-model review** against §4.
4. **Test vectors** — fixed passphrase, salt, nonces and plaintext producing a
   byte-exact envelope, committed, so a later refactor cannot silently change
   the format.
5. **Serialization compatibility plan** — a `v: 1` envelope written today must
   decrypt unchanged after any later refactor; enforced by the vectors.
6. **Rollback and recovery tests** (§15, §17).
7. **Cross-user transplant tests** — K-4 to K-8, each as its own case.
8. **Corrupted ciphertext tests** — flipped bits in `ct`, tag, nonce, AAD.
9. **Wrong-passphrase tests**, including the key-check path.
10. **Reinstall recovery tests** — discard local storage, restore, assert the
    same `abaUserId` and that no provider key returns.
11. **Logout and session-expiry tests** — K-11.
12. **Seven-day outage tests** — K-12, at the boundary on both sides.
13. **Provider-secret non-egress tests** — K-1, as a mutation: add a field that
    could carry a credential and require the suite to fail.
14. **Real Chromium coverage** of derive, encrypt, decrypt and restore, because
    WebCrypto behaviour is the platform's and not a fake's.

## 29. Open questions

Genuinely unresolved. No product decision is made here by omission.

**Q1 — Passphrase or generated recovery key?** §7's weakness is real: PBKDF2
is not memory-hard, Argon2id needs a CSP change this task may not make, and a
user-chosen passphrase is the whole security of the scheme. A generated 128-bit
key removes the problem entirely and costs usability. **Recommendation:**
generated key as the default, user passphrase as an informed opt-in with a
strength floor. Needs a product decision.

**Q2 — Does adding `wasm-unsafe-eval` for Argon2id merit its cost?** It widens
what the extension may execute and must be justified in the store listing. If
Q1 resolves to a generated key, Q2 is moot. Sequence Q1 first.

**Q3 — When is the passphrase prompted?** Once per browser session, or per
worker start? The KEK lives in memory, and `chrome.storage.session` is
memory-backed but readable by the extension's own contexts. Holding the KEK
there survives worker eviction and avoids re-prompting; holding it only in
worker memory is tighter and prompts more often. Security and usability
genuinely trade here.

**Q4 — Does `accountLabel` need its key suffix at all?** §12 found it embeds
four characters of the API key. Encrypting it solves the sync problem. Dropping
the suffix and distinguishing accounts by user-supplied name would remove the
credential fragment from the product entirely — a smaller change with a smaller
blast radius. Needs a product decision.

**Q5 — Tombstone retention.** 90 days is proposed by analogy, not measured.
It interacts with how long a device may stay offline and still converge.

**Q6 — Audit volume.** Audit is the highest-volume record type and the one
whose per-device streams never merge. Whether it is worth syncing at all, or
should stay `LOCAL_ONLY` with export, is unresolved.
