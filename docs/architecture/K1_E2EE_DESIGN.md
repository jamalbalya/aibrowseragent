# K1 — End-to-End Encryption for Cloud Sync

Status: **design v2, pending review. Nothing here is implemented.** No
production code was changed to produce this document, and none may change
until it is reviewed and approved. There is no backend, no Cloud Sync
transport and no encryption code in the repository.

Baseline: `59114e4`, CI #46 green, 2267 unit/integration/security and 213 real
Chromium tests.

**What changed in v2.** Four product decisions were approved and they alter the
cryptography, not merely the wording:

|     | Decision                                                                | Effect                                                                            |
| --- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Q1  | **Generated 128-bit recovery key**, no user passphrase in v1            | the secret is uniformly random, so there is nothing for a password KDF to stretch |
| Q2  | **No Argon2id, no scrypt, no WASM, no CSP change**                      | not applicable once Q1 holds                                                      |
| Q3  | The recovery key is a **recovery credential**, not a session credential | key material persists locally; §7.4 states what that costs                        |
| Q4  | **Remove the API-key suffix from `accountLabel`**                       | credential fragments are `SECRET_LOCAL_ONLY`, never sync metadata                 |

v1 specified PBKDF2-HMAC-SHA-256 at 600 000 iterations. **That is removed.**
See §7 for why running a password KDF against a uniformly random secret buys
nothing.

---

## 1. Purpose and scope

Cloud Sync must let a person recover their work on a new device without the AI
Browser Agent backend being able to read that work. Everything sensitive is
encrypted on the device under a key the backend never receives.

**In scope:** key hierarchy, key derivation, cipher, envelope, associated data,
what the backend may see, revision and rollback handling, device identity,
recovery, reinstall, logout, account deletion, versioning and rotation.

**Out of scope, named because they are adjacent and must not be assumed:** the
backend's schema and endpoints, the authentication flows, provider OAuth, the
sync transport, and the recovery-key presentation UX (Q1 leaves that to
implementation review, and this document does not invent requirements for it).

## 2. Security goals

| #   | Goal                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------- |
| G1  | The backend cannot read task, workflow, shortcut, audit or workspace content — honest, compromised, or hostile. |
| G2  | The backend never receives the recovery key, in plaintext or in any form it could derive one from.              |
| G3  | Ciphertext cannot be moved between users, records, or record types without decryption failing.                  |
| G4  | A stale or replayed record cannot silently overwrite a newer one.                                               |
| G5  | Provider API keys never leave the device, encrypted or not.                                                     |
| G6  | Losing a session, a device, or the backend never destroys user work.                                            |
| G7  | Losing local storage never creates a second identity for the same account.                                      |
| G8  | Cloud Sync grants no browser authority: it is storage, never a permission.                                      |
| G9  | **Authentication alone never decrypts anything.** A valid session is not a key.                                 |

**Security level: 128 bits.** The recovery key carries 128 bits of entropy, so
the whole system provides 128-bit security against key recovery — not 256,
despite AES-256 appearing below. 128 bits is the standard symmetric target and
is beyond brute force (§4), but it is stated plainly rather than left for a
reader to infer "256" from the cipher name.

## 3. Explicit non-goals

- **Not** protection against a compromised device. See §7.4: under the approved
  Q3 lifecycle, key material rests locally, so an attacker with the extension's
  storage can decrypt. This is a consequence of the approved UX, stated rather
  than hidden.
- **Not** server-side recovery. Losing the recovery key means losing the
  plaintext (Q1). No escrow, no second key, no backdoor.
- **Not** metadata privacy. The backend learns record counts, sizes, types and
  timing.
- **Not** protection against a fully consistent rollback of all state to a
  client holding no prior state (§15).
- **Not** multi-user sharing or key exchange. One user, one key.

## 4. Threat model

| Threat                                                                            | Handled by                                                   | Residual                                                                                                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Backend compromise                                                                | ciphertext only; no key ever sent                            | metadata                                                                                                                                |
| Database compromise                                                               | same                                                         | same                                                                                                                                    |
| Network interception                                                              | TLS, and ciphertext beneath it                               | traffic analysis                                                                                                                        |
| Malicious backend operator                                                        | cannot decrypt; §10 binding blocks transplant                | can delete or withhold — availability, not confidentiality                                                                              |
| Stolen ciphertext (cloud)                                                         | AES-256-GCM under a 128-bit-entropy key                      | none practical — see brute force below                                                                                                  |
| Stolen ciphertext (local)                                                         | same                                                         | **but see local key material, below**                                                                                                   |
| **Recovery-key brute force**                                                      | 2¹²⁸ search, each guess costing an HKDF plus a GCM tag check | infeasible: at 10¹⁸ guesses/second, ~10¹³ years                                                                                         |
| **Recovery-key theft**                                                            | —                                                            | **full compromise of cloud and local data.** The key is the only secret; whoever holds it can decrypt everything, from anywhere         |
| **Recovery-key accidental disclosure** (screenshot, chat, backup, support ticket) | presentation-time warnings; rotation (§25)                   | same as theft until rotated, and rotation cannot un-read what was already read                                                          |
| **Recovery-key loss**                                                             | nothing, by decision                                         | encrypted data is permanently unreadable. No reset to a new identity, no silent downgrade to plaintext, no discarding of the ciphertext |
| **Local key material at rest**                                                    | none beyond the browser profile's own protection             | disk access to the profile yields the KEK and therefore the cloud plaintext. Identical posture to provider API keys today. §7.4         |
| Replayed sync record                                                              | monotonic revision, AAD binding                              | §15                                                                                                                                     |
| Rollback of old records                                                           | monotonic revision + client high-water mark                  | a client with no retained state cannot detect a consistent full rollback                                                                |
| **Cross-user ciphertext transplant**                                              | `abaUserId` in AAD → tag fails                               | —                                                                                                                                       |
| Record/type substitution                                                          | `recordId`, `recordType` in AAD → tag fails                  | —                                                                                                                                       |
| Device loss                                                                       | sessions revocable; §25 on what revocation does _not_ do     | whatever the device's storage held                                                                                                      |
| Storage loss                                                                      | recovery, §17                                                | local-only data is gone; never promised otherwise                                                                                       |
| **Session theft**                                                                 | **a session decrypts nothing (G9)**                          | attacker reads sync _metadata_ and may delete records                                                                                   |
| Provider credential leakage                                                       | never synced; no field exists to carry one                   | device compromise                                                                                                                       |
| Accidental plaintext logging                                                      | §22 and the existing redaction layer                         | —                                                                                                                                       |

## 5. Trust boundaries

```
  User  (holds the recovery key, written down, offline)
    │  supplied at setup and at recovery — not at every session (Q3)
    ▼
  Chrome extension  ── TRUSTED. Holds the KEK and plaintext while running.
    │
    ├──▶ chrome.storage.local   ── local ciphertext, the wrapped/derived KEK,
    │                              and provider API keys (NEVER synced)
    │
    ├──▶ Auth/session backend   ── SEMI-TRUSTED. Proves who you are.
    │                              Never sees the recovery key or any key.
    │
    └──▶ Cloud Sync storage     ── UNTRUSTED for confidentiality.
                                   Ciphertext + sync metadata only.
```

Eight identities, deliberately separate:

| Identity                   | What it is                     | Lifetime                 | Synced?                    |
| -------------------------- | ------------------------------ | ------------------------ | -------------------------- |
| `abaUserId`                | the account                    | permanent until deletion | yes (backend is authority) |
| auth session               | proof you are signed in now    | minutes to 30 days       | no                         |
| **recovery key**           | **the only decryption secret** | until rotated            | **never, in any form**     |
| `deviceId`                 | this installation              | until reinstall          | as metadata                |
| `workspaceId`              | a browser context boundary     | until deleted            | metadata; body encrypted   |
| task / workflow / shortcut | user work                      | until deleted            | encrypted                  |
| `connectionId`             | a connected AI account         | until disconnected       | metadata; body encrypted   |
| provider credential        | the API key                    | until disconnected       | **never**                  |

## 6. Key hierarchy

```
Recovery Key   128 bits, crypto.getRandomValues, shown once, user-retained
   │           NEVER transmitted. NEVER stored in plaintext after setup.
   │
   │  HKDF-SHA-256           Extract(salt = kdSalt) then Expand(info = "aba/k1/kek/v1")
   │                         Key derivation for domain separation — NOT password hardening (§7)
   ▼
KEK    256-bit key-encryption key. Held locally (§7.4) so normal operation
   │   does not re-prompt (Q3). Effective strength: 128 bits, per §2.
   │
   │  AES-256-GCM wrap, AAD = record binding (§10)
   ▼
DEK    per-record, 256 bits, random, stored only wrapped
   │
   │  AES-256-GCM, AAD = the same record binding
   ▼
record ciphertext
```

**One DEK per record.** Alternatives and why they lose:

- _One key for everything_ — random 96-bit GCM nonces under a single key give
  collision probability growing with the square of the record count, and a GCM
  nonce collision is catastrophic rather than untidy. It also makes a key
  rotation a full re-encryption of every byte the user owns.
- _One DEK per collection_ — better, but rotation still re-encrypts whole
  collections, and a leaked collection key exposes everything in it.

Per-record wins on three counts. Each DEK encrypts exactly one message, so
nonce reuse across records is structurally impossible. **Rotating the recovery
key re-wraps DEKs and re-encrypts nothing** — O(records) small operations
rather than O(bytes). And a leaked DEK exposes one record.

Cost: ~44 bytes of wrapped DEK per record. Not a consideration.

The KEK wraps many DEKs under random 96-bit nonces. The birthday bound gives
~2⁻³² collision probability at 2³² wraps; a user will not own four billion
records. Documented rather than assumed.

Domain separation, user binding, record binding, versioning and rotation come
from the HKDF `info` string, `abaUserId` in AAD, `recordId` in AAD,
`v`/`keyVersion` in the envelope, and §25.

## 7. Key derivation — and why there is no password KDF

### 7.1 The distinction this section exists to make

Two different things are often both called "a KDF" and they solve different
problems:

|          | Password-based KDF                                                         | Key-derivation function                                |
| -------- | -------------------------------------------------------------------------- | ------------------------------------------------------ |
| Examples | PBKDF2, Argon2id, scrypt, bcrypt                                           | HKDF                                                   |
| Input    | a **low-entropy** human secret                                             | a **high-entropy** uniform secret                      |
| Job      | make each guess expensive, so a small guess space becomes costly to search | turn one good key into several, with domain separation |
| Cost     | deliberately large                                                         | deliberately negligible                                |

K1 v1's secret is a uniformly random 128-bit value. **There is no guess space
to make expensive.** Running PBKDF2 at 600 000 iterations against it would add
latency to every unlock and reduce the attacker's work from 2¹²⁸ to… 2¹²⁸. The
correct primitive is the second column.

This is the direct consequence of approving Q1, and it is why v1's KDF section
is deleted rather than retuned.

### 7.2 The recovery key

|                       |                                                                                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generation            | `crypto.getRandomValues(new Uint8Array(16))` — 128 bits                                                                                                                                                                 |
| Source                | the platform CSPRNG. No custom RNG, no `Math.random`, no entropy pooling of our own                                                                                                                                     |
| Entropy               | 128 bits, uniform                                                                                                                                                                                                       |
| Encoding for the user | an unambiguous alphabet (Crockford base32 or a wordlist) with a checksum, so a transcription error is caught at entry rather than surfacing as "wrong key". Exact presentation is an implementation/review concern (Q1) |
| Transmission          | **never.** Not to the backend, not in an envelope, not in a log, not in telemetry                                                                                                                                       |

### 7.3 Derivation

```
PRK = HKDF-Extract(salt = kdSalt, IKM = recoveryKey)
KEK = HKDF-Expand(PRK, info = "aba/k1/kek/v1", L = 32)
```

|           |                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Algorithm | **HKDF-SHA-256** (RFC 5869), via `crypto.subtle.deriveBits`                                                                           |
| IKM       | the 128-bit recovery key                                                                                                              |
| Salt      | 16 random bytes, per user, **non-secret**, stored as plaintext metadata and synced — a new device needs it                            |
| Info      | `"aba/k1/kek/v1"` — domain separation, and the version marker that lets a future K2 derive a different key from the same recovery key |
| Output    | 256 bits                                                                                                                              |

**The salt is for domain separation, not entropy.** RFC 5869 makes the salt
optional, and with a uniform IKM it adds no hardness. It is included because it
separates users and installations at no cost, and because HKDF-Extract with a
salt is the construction as specified. It is not presented as strengthening
anything.

HKDF is native to WebCrypto. **No Argon2id, no scrypt, no WebAssembly, no
`wasm-unsafe-eval`, and no change to the CSP** (`script-src 'self'; object-src
'self'`). Q2 is not applicable.

### 7.4 Where the KEK rests, and what that costs

Q3 approves that the recovery key is **not** required at every browser start,
worker restart, or task. That has a direct and unavoidable consequence:

> **Key material must persist locally, so an attacker with access to the
> browser profile's storage can decrypt both local and cloud data.**

This is not a flaw in the cryptography; it is what the approved lifecycle
means. Stated in full:

- After setup, the **derived KEK** is held in `chrome.storage.local`. The
  recovery key itself is discarded from storage once the KEK exists — a modest
  benefit (a storage dump does not hand over the human-transcribable form a
  user may have reused elsewhere) and no more than that. The attacker who has
  the KEK can already read everything.
- Holding it only in memory would lose it on browser restart and force
  re-entry, which Q3 rules out.
- **This is the same posture the extension already has.** Provider API keys sit
  in `chrome.storage.local` today. K1 does not lower the bar; it raises it for
  _cloud_ data, which previously had no protection at all because it did not
  exist.
- What K1 protects against is exactly what it claims: the backend, the
  database, the network, and anyone holding ciphertext without the key.

A tighter model — KEK in memory only, prompt per session — is a coherent
alternative with a real usability cost. It is not what was approved, and this
document does not quietly build it.

## 8. Encryption algorithm

|           |                                                             |
| --------- | ----------------------------------------------------------- |
| Algorithm | **AES-256-GCM**, via `crypto.subtle.encrypt` / `decrypt`    |
| Key       | 256 bits (128 bits of effective entropy, §2)                |
| Nonce     | **96 bits**, `crypto.getRandomValues`, fresh per encryption |
| Tag       | **128 bits**, appended to the ciphertext by WebCrypto       |
| AAD       | §10                                                         |

AES-GCM provides confidentiality and integrity together, and the tag covers the
associated data, which is what makes §10's binding enforceable rather than
advisory. Nothing is invented: AES-256-GCM and HKDF-SHA-256 are standard and
both native to the platform.

96 bits is the nonce size GCM is specified and analysed for. Nonces are random
rather than counter-based: a counter needs reliable persistent per-key state,
and a counter that resets — after a reinstall, a crash, a restored backup —
reuses a nonce, which is the one failure GCM does not survive. With a
per-record DEK used exactly once, a random nonce cannot collide with itself.

**Decryption failure is final.** A tag mismatch means the ciphertext, the AAD or
the key is wrong. The record is not decrypted, not partially decrypted, and not
repaired. It is reported per §23 and the local copy is left untouched.

## 9. Envelope format

JSON. Binary fields are base64url without padding.

```jsonc
{
  "v": 1, // envelope version
  "alg": "AES-256-GCM", // content cipher
  "kdf": "HKDF-SHA256", // key derivation — NOT password hashing (§7)
  "kdSalt": "…", // 16 bytes, per user, non-secret
  "kdInfo": "aba/k1/kek/v1",
  "keyVersion": 1, // increments on rotation (§25)
  "wrap": {
    "nonce": "…", // 12 bytes
    "dek": "…", // wrapped DEK + 16-byte tag
  },
  "nonce": "…", // 12 bytes, content
  "ct": "…", // ciphertext + 16-byte tag
}
```

There is **no iteration-count field**, because there is no password KDF. A
reader encountering one in a `v: 1` envelope should treat the envelope as
malformed rather than as an older variant.

| Field                                                                                 | Class                                                                          |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `v`, `alg`, `kdf`, `kdSalt`, `kdInfo`, `keyVersion`                                   | **plaintext metadata** — visible to the backend, none of it secret             |
| `wrap.nonce`, `wrap.dek`, `nonce`                                                     | plaintext metadata, meaningless without the recovery key                       |
| `abaUserId`, `recordId`, `recordType`, `schemaVersion`, `revision`, `v`, `keyVersion` | **authenticated, not encrypted** — carried in the sync row, bound by AAD (§10) |
| `ct`                                                                                  | **encrypted** — the record body, and nothing else                              |

`v` and `keyVersion` appear both in the header and in the AAD, so editing the
plaintext header to steer a client onto a different algorithm or key fails the
tag.

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

The same AAD binds the wrapped DEK, so a wrapped DEK cannot be moved either.

| Field             | Attack it defeats                                                    |
| ----------------- | -------------------------------------------------------------------- |
| `abaUserId`       | serving user A's ciphertext to user B                                |
| `recordId`        | substituting one record's ciphertext for another's                   |
| `recordType`      | presenting a workflow as a preference to reach a different code path |
| `schemaVersion`   | feeding an old body shape to a new parser                            |
| `revision`        | presenting an old body as the current one                            |
| `v`, `keyVersion` | downgrading the algorithm or key while the tag still checks          |

`deviceId` is deliberately **not** in the AAD: a record written on one device
must decrypt on another.

## 11. Cloud Sync payload

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

**The backend may store** ciphertext and synchronisation metadata:
`abaUserId`, `recordId`, `recordType`, `schemaVersion`, `revision`,
`deviceId`, `updatedAt`, `serverSeq`, `deleted`, and the envelope's plaintext
header.

**The backend must never receive** the recovery key · any provider API key ·
any provider OAuth secret · plaintext task, workflow, shortcut or audit
content · plaintext page content · prompts or model responses · workspace
titles or member origins · the KEK or any DEK.

**Audit data is encrypted, not metadata-only.** An audit record carries
`destination`, `origin` and `site` — browsing history in all but name. Its body
goes in `ct`; only ordering metadata stays plaintext. The chain's `seq` and
`prevDigest` are inside the ciphertext, so the backend cannot verify the chain
— which it never could and was never asked to. Verification stays client-side.

## 12. The metadata-only phase

> **Finding carried from v1, now resolved by Q4.** `deriveAccountLabel`
> (`account-model.ts:186`) produces `"api.openai.com (key …1234)"` — the last
> four characters of the API key. Q4 approves removing that suffix.
> **`accountLabel` must never contain an API-key fragment, an OAuth token
> fragment, a client secret, or any credential fingerprint.** A label may carry
> ordinary non-secret metadata: provider name, a user-entered label, a
> non-sensitive description.
>
> Until that change ships, `accountLabel` is credential-derived and is
> classified `SECRET_LOCAL_ONLY`. After it ships, it is ordinary user content
> and is **still encrypted**, for a different reason: a user-entered label is
> whatever the user typed. Two reasons, two mechanisms, and neither depends on
> the other.

"Metadata-only" means **which record types sync**, not that they sync in the
clear. The two readings must not be confused.

**Recommendation: the envelope exists from the first Cloud Sync commit.** One
wire format, not two. A second plaintext format shipped "temporarily" outlives
its phase.

| Phase 1 syncs                                                                          | As                                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `connectionId`, `providerId`, `protocol`, `authKind`, `modelId`, `status`              | plaintext row fields — structural, no user content      |
| `revision`, `deviceId`, `updatedAt`, `serverSeq`, `deleted`                            | plaintext row fields                                    |
| `kdSalt`, `kdInfo`, `keyVersion`                                                       | plaintext, non-secret, needed to derive on a new device |
| `accountLabel`, `baseUrl`, capability detail, workspace title and origins, preferences | **encrypted body**                                      |

`baseUrl` is encrypted because a self-hosted or local endpoint can be an
internal hostname, which is user infrastructure rather than structural
metadata.

| Phase 1 does **not** sync                              | Why                     |
| ------------------------------------------------------ | ----------------------- |
| tasks, workflows, shortcuts, audit                     | deferred to phase 2     |
| page content, prompts, responses, screenshots          | never sync, any phase   |
| provider API keys, OAuth secrets, credential fragments | never sync, permanently |

## 13. Record types

| Record                            | Cloud?    | Body encrypted? | Notes                                                                                |
| --------------------------------- | --------- | --------------- | ------------------------------------------------------------------------------------ |
| task                              | phase 2   | yes             | terminal tasks only (§14)                                                            |
| workflow                          | phase 2   | yes             | fork on conflict                                                                     |
| shortcut                          | phase 2   | yes             | fork on conflict                                                                     |
| audit                             | phase 2   | yes             | per-device streams; `seq`/`prevDigest` inside `ct`                                   |
| preferences                       | phase 1   | yes             | field-level merge after decryption                                                   |
| workspace metadata                | phase 1   | yes             | title and origins are browsing signal                                                |
| workspace runtime binding         | **never** | n/a             | `LOCAL_ONLY`; tab/group/window ids mean nothing elsewhere                            |
| provider connection metadata      | phase 1   | partly          | structural fields plaintext; `accountLabel` and `baseUrl` encrypted                  |
| **provider credentials**          | **never** | n/a             | **`SECRET_LOCAL_ONLY`, permanently**                                                 |
| **provider credential fragments** | **never** | n/a             | **`SECRET_LOCAL_ONLY`** — Q4; a fragment is credential material regardless of length |
| recovery key                      | **never** | n/a             | the secret itself; §7.2                                                              |
| ABA refresh/access token          | never     | n/a             | session material, not user work                                                      |

No field in `SyncRow` or the envelope can hold a provider credential. That is
the enforcement: not a rule to remember, but the absence of a place to put one.

## 14. Sync revision model

Per-record `revision`, monotonic per `(abaUserId, recordId)`. Writes are
conditional: the client sends `baseRevision`, and the server rejects the write
if the stored revision has moved. No global last-write-wins.

**Comparison needs no plaintext.** Conflict _detection_ compares integers in
the plaintext row. Conflict _resolution_ happens on the client after
decryption, where the content is readable. The backend arbitrates ordering, not
meaning.

| Type                | Conflict handling                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| tasks               | **sync only when terminal.** A running task belongs to the device running it; a terminal task is immutable — the conflict is removed rather than resolved                            |
| workflows           | **fork.** The loser becomes `"<name> (edited on <device>)"`. Never silently overwritten                                                                                              |
| shortcuts           | fork, disambiguating the name                                                                                                                                                        |
| preferences         | field-level LWW on per-field `updatedAt`; independent scalars, so no work is destroyed                                                                                               |
| connection metadata | `connectionId` is device-minted and unique, so only the same connection's fields collide → field-level LWW                                                                           |
| workspace metadata  | field-level LWW on title; membership is local runtime state and does not sync                                                                                                        |
| audit               | **no conflict.** Per-device append-only streams, never interleaved — merging two chains destroys the `seq`/`prevDigest` property they exist for. Merged into one _view_ at read time |

Deletes are tombstones (`deleted: true`), so a delete on one device is not
resurrected by another's stale copy. Retention: **Q5, open.**

## 15. Replay and rollback protection

| Mechanism                            | Purpose                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------- |
| server-enforced monotonic `revision` | a stale write is rejected, not merged                                   |
| `serverSeq`, monotonic per user      | a total order the client can page and gap-check                         |
| `revision` in the AAD                | an old body cannot be presented as the current revision — the tag fails |
| client high-water mark per record    | a served revision below one already seen is rejected locally            |
| tombstones                           | a delete is a fact, not an absence                                      |

**Client timestamps are never authoritative.** They are display metadata and a
tiebreak for independent preference fields; clocks are wrong, and on a hostile
client they are whatever it says.

**The residual, stated plainly.** A client with _no_ retained state — a fresh
install — cannot distinguish current server state from a consistent rollback of
everything. It has nothing to compare against. An encrypted manifest of
record→revision only moves the problem up one level, since the manifest can be
rolled back too. Detecting this needs an out-of-band trust anchor this design
does not have. A device that has synced before _does_ detect rollback.

## 16. Device identity

`deviceId` is `dev_` + `crypto.randomUUID()`, generated on first use and held
in `chrome.storage.local`.

- **Not secret.** A label. Nothing is authorised by presenting one.
- **Not derived** from any Chrome runtime handle — extension, tab, group and
  window ids are runtime state that changes on reinstall and is recycled.
- **Unique per installation**; a reinstall produces a new one. Two `deviceId`s
  for one machine is normal.
- **Independent of `abaUserId`** and of the recovery key.

It exists so audit streams stay per-device and so a conflict can name the other
side. It is not an authentication factor and not a key input.

## 17. Recovery

```
empty local state
  → authenticate (Google or email)
  → backend resolves the SAME abaUserId              ← never mints a new one
  → fetch manifest: kdSalt, kdInfo, keyVersion, record list
  → user supplies the RECOVERY KEY                   ← authentication did not provide this
  → HKDF → KEK; verify against the key-check value
  → fetch and decrypt records
  → write local state
```

**Authentication and decryption are separate steps, and neither substitutes for
the other.** Signing in retrieves ciphertext. Only the recovery key turns it
into data. A stolen session reaches step 4 and stops.

A **key-check value** — a fixed known plaintext encrypted under the KEK — lets
a wrong key be reported immediately rather than as a wall of failures. It leaks
nothing beyond what any ciphertext already offers, and against a 128-bit
uniform secret that is nothing usable.

| Situation               | Behaviour                                                                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| wrong recovery key      | key-check fails → `WRONG_RECOVERY_KEY`; retry offered; nothing written. A checksum in the encoding catches transcription errors before this point                                                                                                              |
| lost recovery key       | the data cannot be decrypted. No server-side recovery (Q1). The ciphertext is **kept**, not discarded; the identity is **not** reset; nothing downgrades to plaintext. Starting fresh is an explicit destructive choice the user makes, never an automatic one |
| partial restore         | per record. Records that decrypt are restored; those that do not are listed as unreadable and **kept** as ciphertext                                                                                                                                           |
| corrupted ciphertext    | tag fails → that record is unreadable; the rest proceed                                                                                                                                                                                                        |
| revoked authentication  | no manifest, no restore; local state untouched                                                                                                                                                                                                                 |
| unavailable backend     | restore deferred; the extension works locally                                                                                                                                                                                                                  |
| duplicate device        | normal — a new `deviceId`, both sync                                                                                                                                                                                                                           |
| conflicting local state | local data is never discarded to make room. Records merge per §14; a true conflict forks                                                                                                                                                                       |

## 18. Extension reinstall

Uninstalling the extension may destroy `chrome.storage.local` entirely —
including the KEK.

After reinstall, authenticating with the same identity:

- recovers the **same** `abaUserId` — never a new one;
- **requires the recovery key** to decrypt anything, because the KEK went with
  the storage;
- restores encrypted work once the key is supplied;
- **does not restore provider API keys** — they were never uploaded;
- leaves connections needing a secret marked `disconnected` with the reconnect
  notice already implemented (`CREDENTIAL_RECONNECT_NOTICE`);
- downloads no provider secret, because none exists to download.

Restoring the shape of someone's setup and asking for one key back is better
than losing the account, and far better than presenting a connection that will
fail at its first request with an error the user cannot interpret.

## 19. Relationship to authentication

**Authentication is not the encryption key** (G9). A session proves who you
are; the recovery key decrypts. The two are never derivable from each other:
the recovery key is never sent, never a login factor, and never stored
server-side in any form — not hashed, not as a verifier.

An attacker holding a stolen session can enumerate record ids, types, sizes and
timings, and can delete records — availability and metadata, not
confidentiality.

### 19A. Authentication outage grace

| State                                              | Behaviour                                       |
| -------------------------------------------------- | ----------------------------------------------- |
| authenticated                                      | normal                                          |
| backend unreachable, within 7 days of last contact | `offline_grace`; everything local keeps working |
| past 7 days                                        | re-authentication required                      |

Past the grace period the **only** consequence is a sign-in prompt. No data is
deleted, `abaUserId` is not rotated, no work is orphaned, nothing is reset, and
the recovery key is not re-requested — the KEK is still local.

## 20. Logout

Logout destroys the access and refresh tokens and revokes the session
server-side.

It does **not** delete: local encrypted work, the KEK, cloud records,
`abaUserId`, the identity profile, workspace records, connection metadata, or
provider credentials. It does not expose a provider credential — it does not
touch them. It does not re-prompt for the recovery key.

Structural, not a rule: `SessionStore` imports no account store, no credential
store, no profile and no task store, so the code that ends sessions has no
reachable path to user data.

## 21. Account deletion

The one destructive path, and it is **two** erasures that must not be
conflated:

1. **Backend** — hard-delete `auth_method` and `session`; delete sync rows;
   tombstone `aba_user` (id and `deleted_at` only) for a 30-day replay window,
   then purge. Requires re-authentication within the last five minutes.
2. **Local** — a separate, explicit wipe of `chrome.storage.local`: accounts,
   credentials, tasks, workflows, audit, evidence, workspaces, identity, and
   the KEK.

Deleting the backend account **cannot** reach into browser storage. Saying
"your data is deleted" while an API key remains on disk would be a lie, so the
UI offers both and states which does what.

A deletion record naming the account and time is retained for the tombstone
window. It carries no content.

Not implemented.

## 22. Logging rules

Never logged, in any build: the **recovery key** · the KEK or any DEK · HKDF
output · plaintext record bodies · ciphertext payloads · provider API keys ·
provider OAuth secrets · **provider credential fragments** · page content ·
nonces paired with identifiable ciphertext.

May be logged: record id, record type, revision, device id, error code,
envelope version, byte counts.

The repository's existing redaction layer already forbids most of this. The
recovery key and the derived keys are new and must be added to that surface,
not to a separate one.

## 23. Error semantics

| Condition              | Code                     | Message shape                                                                                                                  |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| wrong recovery key     | `WRONG_RECOVERY_KEY`     | "That recovery key does not unlock this data."                                                                                 |
| malformed recovery key | `RECOVERY_KEY_MALFORMED` | "That does not look like a recovery key." — from the checksum, before any derivation                                           |
| corrupt envelope       | `ENVELOPE_INVALID`       | "This record could not be read."                                                                                               |
| tag mismatch           | `DECRYPT_FAILED`         | same as corrupt — deliberately indistinguishable                                                                               |
| auth failure           | `AUTH_REQUIRED`          | "Sign in again to continue."                                                                                                   |
| authorization failure  | `FORBIDDEN`              | no hint whether the record exists                                                                                              |
| stale revision         | `STALE_REVISION`         | "This changed on another device."                                                                                              |
| replay detected        | `REPLAY_REJECTED`        | same shape as stale                                                                                                            |
| record mismatch        | `DECRYPT_FAILED`         | an AAD mismatch is a decryption failure; naming _which_ field mismatched would tell an attacker which substitution to try next |
| unsupported version    | `UNSUPPORTED_VERSION`    | "This data was written by a newer version."                                                                                    |

A wrong key and a corrupted record are distinguishable to the user only because
the key-check runs first, on data the user already controls. Beyond that,
failures are uniform.

## 24. Cryptographic versioning

`v` is the envelope version and the only field a reader may consult before
deciding how to parse. `v: 1` is this document: HKDF-SHA-256 and AES-256-GCM,
no password KDF.

- A client seeing a **higher** `v` refuses with `UNSUPPORTED_VERSION`. It does
  not guess, and it does not delete the record.
- A K2 introducing a different cipher or derivation increments `v`, and uses a
  different `kdInfo` so the same recovery key yields a different key. K1
  records stay readable by a K2 client; K1 clients refuse K2 records rather
  than mis-parsing them.
- `v` is in the AAD, so a header downgrade fails the tag.
- Records of mixed versions coexist; migration is per record, never a flag day.
- **A `v: 1` envelope containing a password-KDF parameter is malformed**, not
  an older dialect. There is no earlier deployed format to be compatible with.

## 25. Key rotation

Not implemented. Described so the design does not preclude it.

| Operation                                          | Work                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **recovery-key rotation**                          | generate a new 128-bit key; new `kdSalt`; derive a new KEK; **re-wrap every DEK**; `keyVersion += 1`; show the new key once. **No record body is re-encrypted** — the payoff of per-record DEKs                                                                                                                        |
| **key rotation** without changing the recovery key | new KEK via a new `kdInfo` suffix; re-wrap; `keyVersion += 1`                                                                                                                                                                                                                                                          |
| **algorithm migration**                            | new `v`; re-encrypt lazily on next write or eagerly in the background                                                                                                                                                                                                                                                  |
| **re-encryption**                                  | per record, idempotent, resumable; a partial run leaves a mix of `keyVersion`s, all readable                                                                                                                                                                                                                           |
| **device revocation**                              | sessions are revoked server-side. A device that retained the KEK is out of reach — **revocation is not a cryptographic erase and must not be described as one.** Rotating the recovery key is what invalidates a leaked KEK, and only for data written after the rotation; anything already exfiltrated stays readable |

Rotation after a suspected disclosure (§4) limits future exposure. It cannot
un-read what was already read, and the UI must not imply otherwise.

## 26. Backend knowledge boundary

| Information                                                 | Backend can see?     | Reason                                                    |
| ----------------------------------------------------------- | -------------------- | --------------------------------------------------------- |
| `abaUserId`                                                 | **yes**              | it is the account                                         |
| email, `googleSub`, `emailVerified`                         | **yes**              | authentication is its job                                 |
| IP, timestamp                                               | **yes**              | rate limiting and abuse prevention                        |
| `recordId`, `recordType`, `schemaVersion`                   | **yes**              | routing and conflict detection                            |
| `revision`, `serverSeq`, `deviceId`, `updatedAt`, `deleted` | **yes**              | ordering, replay rejection, tombstones                    |
| record count, size, write timing                            | **yes, unavoidably** | metadata privacy is an explicit non-goal (§3)             |
| `kdSalt`, `kdInfo`, `keyVersion`                            | **yes**              | non-secret; required to derive on a new device            |
| envelope header, nonces, wrapped DEK, ciphertext            | **yes (as bytes)**   | useless without the recovery key                          |
| **recovery key**                                            | **no, ever**         | the only decryption secret; never transmitted in any form |
| KEK, any DEK                                                | **no**               | never leave the device                                    |
| task, workflow, shortcut bodies                             | **no**               | encrypted                                                 |
| audit content, `destination`/`origin`/`site`                | **no**               | browsing history; encrypted                               |
| workspace title, member origins                             | **no**               | browsing signal; encrypted                                |
| `accountLabel`, `baseUrl`                                   | **no**               | user content, and — until Q4 ships — credential-derived   |
| **provider credential fragments**                           | **no**               | Q4; credential material regardless of length              |
| page content, prompts, model responses, screenshots         | **no**               | never uploaded, any phase                                 |
| **provider API keys, OAuth secrets**                        | **no, permanently**  | `SECRET_LOCAL_ONLY`; no field exists to carry one         |
| Chrome tab / group / window ids                             | **no**               | local runtime state; meaningless elsewhere                |

## 27. Security invariants

Written to be testable, in the style of the repository's existing invariants.

| #        | Invariant                                                                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| K-1      | No sync payload contains a provider credential — no field in `SyncRow` or the envelope can hold one.                                                 |
| K-2      | **No request to the backend contains the recovery key, the KEK or any unwrapped DEK, in any encoding.**                                              |
| K-3      | Given only a sync row, decryption without the recovery key fails.                                                                                    |
| K-4      | A row whose `abaUserId` is altered fails to decrypt.                                                                                                 |
| K-5      | A row whose `recordType` is altered fails to decrypt.                                                                                                |
| K-6      | A row whose `recordId` is altered fails to decrypt.                                                                                                  |
| K-7      | A row whose `revision` is altered fails to decrypt.                                                                                                  |
| K-8      | A ciphertext from user A never decrypts under user B's key.                                                                                          |
| K-9      | A write with a stale `baseRevision` is rejected, never merged.                                                                                       |
| K-10     | A served revision below the client's high-water mark is rejected.                                                                                    |
| K-11     | Logout clears session keys and changes no byte of local user data, including the KEK.                                                                |
| K-12     | An authentication outage, up to and past the grace period, never changes `abaUserId`.                                                                |
| K-13     | After a simulated reinstall, authenticating as the same identity yields the same `abaUserId`.                                                        |
| K-14     | Cloud Sync state is never an input to `authorizeEgress`, `ToolRegistry.dispatch`, route trust or workspace membership.                               |
| K-15     | No Chrome tab, group or window id appears in any sync payload.                                                                                       |
| K-16     | Every encryption uses a fresh nonce; no two records share a DEK.                                                                                     |
| K-17     | Rotating the recovery key re-encrypts no record body.                                                                                                |
| K-18     | No log record contains the recovery key, a derived key, or a plaintext body.                                                                         |
| K-19     | A record that fails to decrypt is retained, never deleted.                                                                                           |
| K-20     | An envelope with a higher `v` is refused, not parsed.                                                                                                |
| **K-21** | **The recovery key is 128 bits drawn from `crypto.getRandomValues`** — not a counter, not a timestamp, not `Math.random`.                            |
| **K-22** | **The backend cannot derive the recovery key from anything it holds**: no stored value is a function of it.                                          |
| **K-23** | **A valid authenticated session, alone, decrypts nothing.** Authentication with no recovery key yields ciphertext and stops.                         |
| **K-24** | **No provider-credential fragment appears in plaintext sync metadata** — `accountLabel` included.                                                    |
| **K-25** | **No password-based KDF is applied to the recovery key**; the only derivation is HKDF, and no iteration-count parameter exists in a `v: 1` envelope. |
| **K-26** | Losing the recovery key leaves the ciphertext present, the identity unchanged, and nothing downgraded to plaintext.                                  |

## 28. Implementation gates

None is optional; none is satisfied by this document alone.

1. **Architecture review** of this document, and explicit approval.
2. **Cryptographic review** by someone who did not write it — specifically
   §7.4 (local key material), the AAD encoding, and the nonce argument.
3. **Threat-model review** against §4, including the recovery-key rows.
4. **Test vectors** — fixed recovery key, salt, nonces and plaintext producing
   a byte-exact envelope, committed, so a later refactor cannot silently change
   the format.
5. **Serialization compatibility plan** — a `v: 1` envelope written today must
   decrypt unchanged after any later refactor; enforced by the vectors.
6. **Generated recovery-key entropy validation** — 128 bits, from
   `crypto.getRandomValues`; a mutation substituting a weak source must fail
   the suite (K-21).
7. **Wrong recovery key** — including the checksum path and the key-check path.
8. **Recovery-key loss** — ciphertext retained, identity unchanged, no
   plaintext downgrade (K-26).
9. **Authentication-without-key** — a valid session decrypts nothing (K-23).
10. **Cross-user transplant** — K-4 to K-8, each as its own case.
11. **Corrupted ciphertext** — flipped bits in `ct`, tag, nonce and AAD.
12. **Reinstall recovery** — discard local storage, restore, assert the same
    `abaUserId`, that the recovery key is required, and that no provider key
    returns.
13. **Logout and session-expiry** — K-11.
14. **Seven-day outage** — K-12, at the boundary on both sides.
15. **Provider-secret non-egress** — K-1 as a mutation: add a field that could
    carry a credential and require the suite to fail.
16. **`accountLabel` carries no credential-derived suffix** — K-24, asserted
    against the shipped `deriveAccountLabel`.
17. **No password KDF against the recovery key** — K-25.
18. **Real Chromium coverage** of derive, encrypt, decrypt and restore, because
    WebCrypto behaviour is the platform's and not a fake's.

These are not implemented, and this document does not claim any of them passes.

## 29. Open questions

**Q1 — RESOLVED.** Generated 128-bit recovery key. No user passphrase in K1 v1.

**Q2 — RESOLVED / not applicable.** No Argon2id, no scrypt, no WASM, no CSP
change. A password KDF has no role against a uniform secret (§7.1).

**Q3 — RESOLVED at architecture level.** The recovery key is a recovery
credential, required at setup and at recovery, not per session or per worker.
The security cost is §7.4 and is stated rather than mitigated away. Session UX
is not designed here.

**Q4 — RESOLVED.** Remove the API-key suffix from `accountLabel`. Credential
fragments are `SECRET_LOCAL_ONLY` and never plaintext sync metadata (§12, §13,
§26). **`account-model.ts` is not modified by this task** — the change belongs
to the implementation phase.

**Q5 — OPEN. Tombstone retention.** 90 days was proposed in v1 by analogy, not
measured. It interacts with how long a device may stay offline and still
converge. No product decision has been made and none is assumed here.

**Q6 — OPEN. Whether audit syncs at all.** Audit is the highest-volume record
type and the one whose per-device streams never merge. The architecture can say
what audit sync _would_ look like (§11, §13, §14) but cannot settle whether the
volume and the browsing-history sensitivity are worth it — that is a product
judgement about what users need off-device, not a technical one. Left open.

### Cryptographic ambiguity still requiring review

One item, raised rather than resolved:

**The local resting place of the KEK (§7.4).** The cryptography is
unambiguous; the _posture_ deserves a second opinion. Q3 requires that normal
operation not re-prompt, which requires the KEK to persist in
`chrome.storage.local`, which means profile disk access yields cloud plaintext.
That is consistent with where provider API keys already live, and it is a real
reduction in what "end-to-end encrypted" protects against compared with a
prompt-per-session model. It is recorded as gate 2 for an independent reviewer
rather than settled here.
