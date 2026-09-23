# K1 — Client-Side End-to-End Encryption for Cloud Sync

Status: **design v3, pending review. Nothing here is implemented.** There is
no Cloud Sync transport and no encryption code in the repository, and none may
be added until this document is reviewed and approved.

One correction to what this said when written: `server/` now exists, holding
the identity and authentication domain. It holds **no key and no ciphertext**,
and no column in its schema is capable of carrying either — so the boundary
this document describes is untouched.

K1 remains the intended security boundary for Cloud Sync if and when Cloud
Sync is built. It is not a boundary the current product relies on, because the
current product stores everything locally and uploads nothing. See
`LOCAL_FIRST_ARCHITECTURE.md` §8.

Baseline: `67aafe9`, CI #47 green, 2267 unit/integration/security and 213 real
Chromium tests.

## 0. What "K1 client-side E2EE" means

The product term is **K1 client-side E2EE**, and it is defined by what it does
and does not cover. Using it without that definition attached is how a
reasonable claim becomes an overclaim.

> **K1 is client-side encryption designed so that the backend and cloud service
> cannot decrypt protected user content.**
>
> **K1 does not provide endpoint-compromise protection once the active local
> KEK is available on a trusted device.**

| **Protected by K1**                                     |                                            |
| ------------------------------------------------------- | ------------------------------------------ |
| backend compromise                                      | the service holds ciphertext and no key    |
| cloud database compromise                               | same                                       |
| ciphertext theft                                        | 128-bit key, infeasible to search (§4)     |
| network interception                                    | TLS, and ciphertext beneath it             |
| malicious backend operator **without endpoint access**  | cannot decrypt, cannot forge               |
| ciphertext transplant between users                     | AAD binds `abaUserId` (§10)                |
| record substitution                                     | AAD binds `recordId` and `recordType`      |
| record replay and rollback **within the sync protocol** | monotonic revision, high-water marks (§15) |

| **Not protected by K1**                               |                                              |
| ----------------------------------------------------- | -------------------------------------------- |
| full compromise of the user's trusted device          | the KEK is present and usable there          |
| an attacker with read access to the Chrome profile    | can read the KEK from `chrome.storage.local` |
| an attacker able to extract active local KEK material | by definition holds the key                  |
| malware running with equivalent local user privileges | indistinguishable from the user              |

**This is a boundary, not a cryptographic failure.** The construction is sound;
what the second table describes is the set of attackers who already hold the
key, and no cipher protects against an adversary in possession of the key. It
is the direct and intended consequence of the approved lifecycle in which
normal operation does not re-prompt for the recovery key (§7.4).

**What changed in v3.** Six decisions were approved:

|     | Decision                                                                                      | Effect                                               |
| --- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | Keep the construction; make the endpoint boundary **explicit**                                | §0, §3, §4                                           |
| 2   | Terminology must match the threat model                                                       | every claim in this document is qualified against §0 |
| 3   | **Q5 resolved** — 90-day tombstone retention, but elapsed time alone never authorises a purge | §14A                                                 |
| 4   | **Q6 resolved** — audit content is `LOCAL_ONLY` for the initial release                       | §12, §13                                             |
| 5   | Backend knowledge boundary re-reviewed                                                        | §26                                                  |
| 6   | Invariants and gates extended                                                                 | §27, §28                                             |

**What changed in v2**, retained for the record: a generated 128-bit recovery
key replaced a user passphrase, which removed the password KDF entirely (§7.1).

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

| #   | Goal                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | The backend cannot read task, workflow, shortcut or workspace content — honest, compromised, or hostile. Scoped by §0: a claim about the _backend_, not about a compromised endpoint. |
| G2  | The backend never receives the recovery key, in plaintext or in any form it could derive one from.                                                                                    |
| G3  | Ciphertext cannot be moved between users, records, or record types without decryption failing.                                                                                        |
| G4  | A stale or replayed record cannot silently overwrite a newer one.                                                                                                                     |
| G5  | Provider API keys never leave the device, encrypted or not.                                                                                                                           |
| G6  | Losing a session, a device, or the backend never destroys user work.                                                                                                                  |
| G7  | Losing local storage never creates a second identity for the same account.                                                                                                            |
| G8  | Cloud Sync grants no browser authority: it is storage, never a permission.                                                                                                            |
| G9  | **Authentication alone never decrypts anything.** A valid session is not a key.                                                                                                       |

**Security level: 128 bits.** The recovery key carries 128 bits of entropy, so
the whole system provides 128-bit security against key recovery — not 256,
despite AES-256 appearing below. 128 bits is the standard symmetric target and
is beyond brute force (§4), but it is stated plainly rather than left for a
reader to infer "256" from the cipher name.

## 3. Explicit non-goals

- **Not** protection against a compromised device. §0 states this as a
  boundary and §7.4 explains why it follows from the approved lifecycle: key
  material rests locally, so an attacker holding the Chrome profile holds the
  key. Not a cryptographic failure — an adversary in possession of the key is
  outside what any cipher addresses.
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
| Malicious backend operator **without endpoint access**                            | cannot decrypt; §10 binding blocks transplant                | can delete or withhold — availability, not confidentiality                                                                              |
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
document does not quietly build it. The resulting boundary is stated in §0 and
is **approved**, not outstanding: a per-worker or per-browser-start prompt is
explicitly ruled out.

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

**Audit is not synced at all in the initial release** (Q6, §12). An audit
record carries `destination`, `origin` and `site` — browsing history in all but
name — and the approved policy is to keep it on the device rather than to
encrypt and upload it. No audit sync row is created, so the backend receives no
audit content _and_ no audit metadata. Were audit to sync later, its body would
go in `ct` like any other record and the `seq`/`prevDigest` chain would ride
inside the ciphertext, unverifiable by the backend — which it never could
verify and was never asked to.

## 12. Initial Cloud Sync policy

> **Supersedes the two-phase split in v2.** That phasing deferred tasks,
> workflows and shortcuts until "after the E2EE design is implemented and
> validated". This document _is_ that design, so the approved initial policy
> covers them — encrypted — and defers **audit** instead, on data-minimisation
> grounds rather than cryptographic ones.

**Everything that syncs, syncs encrypted.** One wire format, from the first
Cloud Sync commit. A second plaintext format shipped "temporarily" outlives its
phase.

### SYNC — encrypted body, plaintext routing metadata

- tasks (terminal only, §14)
- workflows
- shortcuts
- approved workspace metadata
- preferences
- approved connection metadata

### LOCAL_ONLY — never uploaded in this release

- provider API keys
- provider OAuth secrets
- provider credentials of any kind, including fragments
- **audit content**

### NEVER CLOUD — not uploaded in any release

- page content
- provider prompts
- provider responses
- raw browser content
- secrets of any kind

### Audit — `LOCAL_ONLY`, resolving Q6

Audit content does not sync in the initial release, **in plaintext or
encrypted**. The reason is scope and data minimisation, not a cryptographic
obstacle: the envelope would protect it perfectly well. Audit is the
highest-volume record type, its per-device streams never merge (§14), and its
content is browsing history — `destination`, `origin`, `site`. Not uploading it
is the smaller, more defensible product.

**No audit sync metadata is required either.** Because no audit row exists,
there is nothing for the sync protocol to order, acknowledge or reconcile.
`serverSeq`, revisions and tombstone accounting operate over the record types
listed under SYNC and do not reference audit at all — so there is no carve-out
to define, and this document does not invent one.

Audit synchronisation may become a later explicit product decision. It is not
one now, and nothing in this design depends on it.

### Provider connection metadata — what is plaintext

| Field                                                                     | Class                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------- |
| `connectionId`, `providerId`, `protocol`, `authKind`, `modelId`, `status` | plaintext row fields — structural, no user content      |
| `revision`, `deviceId`, `updatedAt`, `serverSeq`, `deleted`               | plaintext row fields                                    |
| `kdSalt`, `kdInfo`, `keyVersion`                                          | plaintext, non-secret, needed to derive on a new device |
| `accountLabel`, `baseUrl`, capability detail                              | **encrypted body**                                      |

`baseUrl` is encrypted because a self-hosted or local endpoint can be an
internal hostname — user infrastructure, not structural metadata.

> **`accountLabel`, resolving Q4.** `deriveAccountLabel`
> (`account-model.ts:186`) currently produces `"api.openai.com (key …1234)"` —
> the last four characters of the API key. The suffix is removed in the
> implementation phase. **`accountLabel` must never contain an API-key
> fragment, an OAuth token fragment, a client secret, or any credential
> fingerprint.** A label may carry ordinary non-secret metadata: provider name,
> a user-entered label, a non-sensitive description.
>
> Until that change ships the label is credential-derived and classified
> `SECRET_LOCAL_ONLY`. Afterwards it is ordinary user content and is **still
> encrypted**, for a different reason: a user-entered label is whatever the
> user typed. Two reasons, two mechanisms, neither depending on the other.
>
> **`account-model.ts` is not modified by this task.**

## 13. Record types

"Cloud?" is the **initial release** policy (§12). Nothing marked `LOCAL_ONLY`
or `never` is deferred for cryptographic reasons.

| Record                            | Cloud?           | Body encrypted? | Notes                                                                                                   |
| --------------------------------- | ---------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| task                              | yes              | yes             | terminal tasks only (§14)                                                                               |
| workflow                          | yes              | yes             | fork on conflict                                                                                        |
| shortcut                          | yes              | yes             | fork on conflict                                                                                        |
| preferences                       | yes              | yes             | field-level merge after decryption                                                                      |
| workspace metadata                | yes              | yes             | title and origins are browsing signal                                                                   |
| provider connection metadata      | yes              | partly          | structural fields plaintext; `accountLabel` and `baseUrl` encrypted                                     |
| **audit content**                 | **`LOCAL_ONLY`** | n/a             | **Q6** — not synced in this release, plaintext or encrypted. Data minimisation, not a crypto limit. §12 |
| audit sync metadata               | **none exists**  | n/a             | no audit row is created, so the protocol has nothing to order or acknowledge                            |
| workspace runtime binding         | **never**        | n/a             | `LOCAL_ONLY`; tab/group/window ids mean nothing elsewhere                                               |
| **provider credentials**          | **never**        | n/a             | **`SECRET_LOCAL_ONLY`, permanently**                                                                    |
| **provider credential fragments** | **never**        | n/a             | **`SECRET_LOCAL_ONLY`** — Q4; credential material regardless of length                                  |
| page content, prompts, responses  | **never**        | n/a             | not uploaded in any release                                                                             |
| recovery key                      | **never**        | n/a             | the secret itself; §7.2                                                                                 |
| KEK, any DEK                      | **never**        | n/a             | derived key material; never leaves the device                                                           |
| ABA refresh/access token          | never            | n/a             | session material, not user work                                                                         |

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

| Type                | Conflict handling                                                                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tasks               | **sync only when terminal.** A running task belongs to the device running it; a terminal task is immutable — the conflict is removed rather than resolved                                                                    |
| workflows           | **fork.** The loser becomes `"<name> (edited on <device>)"`. Never silently overwritten                                                                                                                                      |
| shortcuts           | fork, disambiguating the name                                                                                                                                                                                                |
| preferences         | field-level LWW on per-field `updatedAt`; independent scalars, so no work is destroyed                                                                                                                                       |
| connection metadata | `connectionId` is device-minted and unique, so only the same connection's fields collide → field-level LWW                                                                                                                   |
| workspace metadata  | field-level LWW on title; membership is local runtime state and does not sync                                                                                                                                                |
| audit               | **does not sync** (Q6, §12), so there is no conflict to handle. Were it to sync later, per-device append-only streams would never be interleaved: merging two chains destroys the `seq`/`prevDigest` property they exist for |

Deletes are tombstones (`deleted: true`), so a delete on one device is not
resurrected by another's stale copy. Retention and safe purge: §14A.

## 14A. Tombstone retention and safe purge

**Retention policy: 90 days.** That is a _retention_ figure — the minimum a
tombstone is kept — and **it is not by itself a condition for deleting one**.
Confusing the two produces the following, which the design must prevent:

```
Device A deletes record R        → tombstone at serverSeq T
Device B goes offline, holding R
90 days elapse
Tombstone purged on elapsed time alone
Device B reconnects, still holding R, never told it was deleted
Device B pushes R                → R is resurrected
```

The user deleted something and it came back. No cryptography is involved and
none would help: this is a distributed-systems failure, and elapsed time is the
wrong signal because it says nothing about whether anyone still holds the
record.

### The required condition

> A tombstone may be purged only when the protocol has **positive evidence**
> that no device which could still hold the record is able to reintroduce it.

That needs three pieces of state, none of which is a clock:

1. **Per-device acknowledgement watermark.** Each device reports
   `syncedThroughSeq` — the highest `serverSeq` it has fully applied. Stored
   server-side, per `(abaUserId, deviceId)`. It is an acknowledgement, not a
   timestamp.
2. **A purge horizon.** The server records `purgeHorizon`: the `serverSeq`
   below which tombstones have been removed. It only ever increases.
3. **Device retirement.** A device not seen for `D` days leaves the
   acknowledgement quorum, so one machine that never returns cannot block
   purging forever. `D` must exceed the 90-day retention (see the parameter
   note in §29).

The rule:

```
purgeable(tombstone at seq T)  ⟺  T < min( syncedThroughSeq )  over all
                                   non-retired devices of this user
                                   AND  age(T) ≥ 90 days
```

Both conjuncts are required. Age alone is the bug above; acknowledgement alone
would purge history sooner than the retention policy promises.

### The returning-device rule

Retirement makes purging possible, so it must not make resurrection possible.
A device whose `syncedThroughSeq` is **below `purgeHorizon`** has provably
missed deletions it can never learn about, and therefore **may not delta-sync**.
It must reconcile instead, and the reconciliation is not "upload everything
local":

- The client tracks, per record, the `serverSeq` at which it last saw that
  record confirmed by the server.
- A local record whose last-confirmed seq is **below `purgeHorizon`**, and
  which the server does not have, is **not** re-uploaded as existing. The
  client cannot distinguish "deleted elsewhere" from "never reached the
  server", so it does not assert either.
- If the client **modified** that record after its last-confirmed seq, the
  local change is real work and is preserved — surfaced to the user as a
  record that may have been deleted on another device, for them to keep or
  discard. It is never silently resurrected and never silently dropped.
- A local record created entirely after the last-confirmed seq has no tombstone
  risk and uploads normally.

### What this deliberately does not rely on

| Not used            | Why                                                        |
| ------------------- | ---------------------------------------------------------- |
| client clock        | wrong on real machines, and whatever a hostile client says |
| last-seen timestamp | a proxy for acknowledgement, not acknowledgement           |
| local date          | same                                                       |

Every decision above is on server-assigned `serverSeq`, which is monotonic and
not client-supplied. The 90-day figure is the only wall-clock element, and it
can only ever _delay_ a purge, never authorise one.

**Not implemented.** This section specifies the mechanism; building it is
implementation work gated by §28.

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

Re-reviewed for v3. The backend may receive **only** approved synchronisation
metadata and encrypted payloads.

### The backend may receive

| Information                                                                                             | Reason                                                     |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `abaUserId`                                                                                             | it is the account                                          |
| email, `googleSub`, `emailVerified`                                                                     | authentication is its job                                  |
| IP, timestamp                                                                                           | rate limiting and abuse prevention                         |
| `recordId`, `recordType`, `schemaVersion`                                                               | routing and conflict detection                             |
| `revision`, `serverSeq`, `deviceId`, `updatedAt`, `deleted`                                             | ordering, replay rejection, tombstones                     |
| `syncedThroughSeq` per device                                                                           | the acknowledgement watermark for safe purge (§14A)        |
| `kdSalt`, `kdInfo`, `keyVersion`                                                                        | non-secret; required to derive on a new device             |
| envelope header, nonces, wrapped DEK, ciphertext bytes                                                  | useless without the recovery key                           |
| record count, size, write timing                                                                        | unavoidable; metadata privacy is an explicit non-goal (§3) |
| structural connection fields: `connectionId`, `providerId`, `protocol`, `authKind`, `modelId`, `status` | §12                                                        |

### The backend must never receive

| Information                      | Reason                                                                |
| -------------------------------- | --------------------------------------------------------------------- |
| **recovery key**                 | the only decryption secret; never transmitted in any form or encoding |
| **KEK**                          | derived key material; never leaves the device                         |
| **any DEK** (unwrapped)          | same; only the wrapped form is stored                                 |
| **provider API key**             | `SECRET_LOCAL_ONLY`, permanently                                      |
| **provider OAuth secret**        | same                                                                  |
| **provider credential fragment** | Q4; credential material regardless of length                          |
| **plaintext tasks**              | encrypted                                                             |
| **plaintext workflows**          | encrypted                                                             |
| **plaintext shortcuts**          | encrypted                                                             |
| **plaintext audit content**      | `LOCAL_ONLY` — not uploaded at all (§12)                              |
| **page content**                 | never uploaded, any release                                           |
| **provider prompts**             | same                                                                  |
| **provider responses**           | same                                                                  |
| workspace title, member origins  | browsing signal; encrypted                                            |
| `accountLabel`, `baseUrl`        | user content, and — until Q4 ships — credential-derived               |
| Chrome tab / group / window ids  | local runtime state; meaningless elsewhere                            |

There is no field in `SyncRow` or the envelope capable of carrying anything in
the second table. That absence is the enforcement.

## 27. Security invariants

Testable, in the style of the repository's existing invariants.

| #        | Invariant                                                                                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K-1      | No sync payload contains a provider credential — no field in `SyncRow` or the envelope can hold one.                                                                   |
| K-2      | No request to the backend contains the recovery key, in plaintext or any encoding.                                                                                     |
| K-3      | Given only a sync row, decryption without the recovery key fails — the backend cannot decrypt K1-protected ciphertext.                                                 |
| K-4      | A row whose `abaUserId` is altered fails to decrypt.                                                                                                                   |
| K-5      | A row whose `recordType` is altered fails to decrypt.                                                                                                                  |
| K-6      | A row whose `recordId` is altered fails to decrypt.                                                                                                                    |
| K-7      | A row whose `revision` is altered fails to decrypt.                                                                                                                    |
| K-8      | A ciphertext from user A never decrypts under user B's key.                                                                                                            |
| K-9      | A write with a stale `baseRevision` is rejected, never merged.                                                                                                         |
| K-10     | A served revision below the client's high-water mark is rejected.                                                                                                      |
| K-11     | Logout clears session keys and changes no byte of local user data, including the KEK.                                                                                  |
| K-12     | An authentication outage, up to and past the grace period, never changes `abaUserId`.                                                                                  |
| K-13     | After a simulated reinstall, authenticating as the same identity yields the same `abaUserId` — never a new one.                                                        |
| K-14     | Cloud Sync state is never an input to `authorizeEgress`, `ToolRegistry.dispatch`, route trust or workspace membership.                                                 |
| K-15     | No Chrome tab, group or window id appears in any sync payload.                                                                                                         |
| K-16     | Every encryption uses a fresh nonce; no two records share a DEK.                                                                                                       |
| K-17     | Rotating the recovery key re-encrypts no record body.                                                                                                                  |
| K-18     | No log record contains the recovery key, a derived key, or a plaintext body.                                                                                           |
| K-19     | A record that fails to decrypt is retained, never deleted.                                                                                                             |
| K-20     | An envelope with a higher `v` is refused, not parsed.                                                                                                                  |
| K-21     | The recovery key is 128 bits from `crypto.getRandomValues` — not a counter, not a timestamp, not `Math.random`.                                                        |
| K-22     | The backend cannot derive the recovery key from anything it holds: no stored value is a function of it.                                                                |
| K-23     | A valid authenticated session, alone, decrypts nothing.                                                                                                                |
| K-24     | No provider-credential fragment appears in plaintext sync metadata — `accountLabel` included.                                                                          |
| K-25     | No password-based KDF is applied to the recovery key; the only derivation is HKDF, and no iteration-count parameter exists in a `v: 1` envelope.                       |
| K-26     | Losing the recovery key leaves ciphertext present, identity unchanged, and nothing downgraded to plaintext.                                                            |
| **K-27** | **No request to the backend contains the KEK.**                                                                                                                        |
| **K-28** | **K1 makes no claim of protection against a compromised trusted endpoint holding the active KEK** — asserted against the shipped product copy, not only this document. |
| **K-29** | **A tombstone is never purged on elapsed time alone**: purge requires the acknowledgement condition in §14A.                                                           |
| **K-30** | **Initial Cloud Sync uploads no audit content**, encrypted or otherwise, and creates no audit sync row.                                                                |

### Coverage of the v3 invariant requirements

| Required                                                 | Satisfied by |
| -------------------------------------------------------- | ------------ |
| K-NEW-1 backend cannot decrypt K1 ciphertext             | K-3          |
| K-NEW-2 recovery key never transmitted in plaintext      | K-2          |
| K-NEW-3 KEK never transmitted                            | **K-27**     |
| K-NEW-4 provider API keys remain `SECRET_LOCAL_ONLY`     | K-1          |
| K-NEW-5 credential fragments not plaintext sync metadata | K-24         |
| K-NEW-6 no endpoint-compromise claim                     | **K-28**     |
| K-NEW-7 tombstone not purged on 90 days alone            | **K-29**     |
| K-NEW-8 initial sync uploads no audit content            | **K-30**     |
| K-NEW-9 authentication alone cannot decrypt              | K-23         |
| K-NEW-10 reinstall cannot create a new identity          | K-13         |

## 28. Implementation gates

None is optional; none is satisfied by this document alone. **None is
implemented.**

1. **Architecture review** of this document, and explicit approval.
2. **Cryptographic review** by someone who did not write it — the AAD encoding,
   the nonce argument, and §0's boundary as written in product copy.
3. **Threat-model review** against §4, including the recovery-key rows.
4. **Endpoint-compromise threat-model tests** — assert the product claims only
   what §0 claims (K-28), including the UI and store-listing copy.
5. **Cloud/backend plaintext absence tests** — no plaintext body of any synced
   record reaches a captured request (K-3).
6. **KEK non-egress tests** (K-27).
7. **Recovery-key non-egress tests** (K-2, K-22).
8. **Ciphertext transplant tests** — K-4 to K-8, each as its own case.
9. **Tombstone offline-device resurrection test** — the §14A scenario end to
   end: delete, take a device offline past retention, purge under the
   acknowledgement rule, reconnect, assert no resurrection and no silent loss
   of work created offline.
10. **Tombstone purge safety test** — a purge attempted on elapsed time alone
    is refused (K-29).
11. **Audit-content non-egress test** (K-30).
12. **Provider API-key non-egress test** — K-1 as a mutation: add a field that
    could carry a credential and require the suite to fail.
13. **`accountLabel` credential-fragment non-egress test** (K-24), asserted
    against the shipped `deriveAccountLabel`.
14. **Reinstall recovery test** — discard local storage, restore, assert the
    same `abaUserId`, that the recovery key is required, and that no provider
    key returns.
15. **Test vectors** — fixed recovery key, salt, nonces and plaintext producing
    a byte-exact envelope, committed, so a later refactor cannot silently
    change the format.
16. **Generated recovery-key entropy validation** (K-21) — a mutation
    substituting a weak source must fail the suite.
17. **Wrong recovery key**, including the checksum and key-check paths.
18. **Recovery-key loss** — ciphertext retained, identity unchanged, no
    plaintext downgrade (K-26).
19. **Authentication-without-key** — a valid session decrypts nothing (K-23).
20. **Corrupted ciphertext** — flipped bits in `ct`, tag, nonce and AAD.
21. **Logout and session-expiry** (K-11) and **seven-day outage** (K-12).
22. **No password KDF against the recovery key** (K-25).
23. **Real Chromium coverage** of derive, encrypt, decrypt and restore, because
    WebCrypto behaviour is the platform's and not a fake's.

## 29. Open questions

**All six resolved.**

|     |                                                                                   |          |
| --- | --------------------------------------------------------------------------------- | -------- |
| Q1  | Generated 128-bit recovery key                                                    | §7.2     |
| Q2  | No Argon2id, scrypt, WASM or CSP change — not applicable against a uniform secret | §7.1     |
| Q3  | Recovery credential, not a per-session credential; the resulting boundary is §0   | §7.4     |
| Q4  | API-key suffix removed from `accountLabel`; fragments are `SECRET_LOCAL_ONLY`     | §12      |
| Q5  | 90-day retention, purge only on the acknowledgement condition                     | §14A     |
| Q6  | Audit content `LOCAL_ONLY` for the initial release; no audit sync row exists      | §12, §13 |

No new product questions are raised, and none of the above is resolved by
implication.

### Cryptographic ambiguity still requiring review

**None.** The construction — HKDF-SHA-256 → 256-bit KEK → per-record DEK →
AES-256-GCM with length-prefixed AAD — is determinate, uses only standard
WebCrypto primitives, and leaves no parameter unspecified.

The item v2 raised for review, the local resting place of the KEK, is
**resolved by decision rather than left open**: it is approved, and §0 states
the resulting boundary as a product claim instead of a caveat. It stays on the
gate list (§28 items 2 and 4) as something an independent reviewer should see,
which is not the same as being unresolved.

One value is left to implementation review. It is a tuning parameter, not a
question of correctness:

- **Device retirement window `D` (§14A).** It must exceed the 90-day tombstone
  retention, or a device could leave the acknowledgement quorum while its
  tombstones are still live. Too short degrades the experience for a
  legitimately offline device; too long lets tombstones accumulate. Neither is
  a correctness failure, and the safe-purge rule in §14A holds for any `D`
  satisfying that constraint.
