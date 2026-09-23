# Cloud Sync — Protocol and Backend Data Model

Status: **design, pending review. Nothing here is implemented.** No production
code was changed to produce this document. There is no backend, no database, no
endpoint and no sync client in the repository.

Baseline: `7e7a72b`, CI #48 green. Code baseline `f7e09e6`: 2267
unit/integration/security and 213 real Chromium tests.

Depends on **`K1_E2EE_DESIGN.md`** (approved). Every cryptographic decision
there is authoritative and is cited, never restated differently: the 128-bit
recovery key, HKDF-SHA-256 → 256-bit KEK, per-record DEKs, AES-256-GCM, the
length-prefixed AAD, and the endpoint boundary in its §0.

Values marked **TUNABLE** are parameters for implementation review, not
architectural choices. They are flagged rather than guessed at.

---

## 1. Purpose and scope

Let a person's work follow them to a new device, without the backend being able
to read it.

**In scope:** the record model, revisions and ordering, conflict handling,
tombstones and their safe purge, device registration and retirement, pull and
push, the manifest, the backend schema, the API contract, failure and offline
behaviour, and the security invariants that bound all of it.

**Out of scope, named so they are not assumed:** the authentication flows
themselves (§18 defines only the relationship), the recovery-key UX, the
cryptographic construction (K1 owns it), and any backend deployment concern.

## 2. Architecture overview

```
 Device A                         Backend                        Device B
 ────────                         ───────                        ────────
 plaintext ──┐                                                ┌── plaintext
             │ encrypt (K1)                       decrypt (K1)│
        envelope ──push──▶  sync_record  ──changes──▶  envelope
                           + routing metadata
                           (cannot decrypt)
             ◀──ack(syncedThroughSeq)──
```

Three properties the rest of the document keeps true:

1. **The backend orders; it never interprets.** It assigns `serverSeq`,
   rejects stale writes and serves changes in order. Every decision that needs
   to read content happens on a client, after decryption.
2. **Deletion is a fact that must be delivered, not a gap.** Tombstones are
   records. Purging one is only safe once every device that could contradict it
   has acknowledged it (§9).
3. **Sync is storage, never permission.** Nothing that arrives from the cloud
   grants browser access. The workspace membership guard and route trust decide
   that, live, on the device (§16, SYNC-5).

## 3. Client / backend trust boundaries

```
  User ── holds the recovery key (offline, written down)
    │
    ▼
  Chrome extension ── TRUSTED. Holds the KEK and plaintext while running.
    │                 K1 §0: not protected against a compromised endpoint.
    │
    ├── chrome.storage.local ── local plaintext + KEK + provider API keys
    │                           (provider keys NEVER leave this box)
    │
    ├── Auth backend ── SEMI-TRUSTED. Establishes identity and session.
    │                   Cannot decrypt anything (§18).
    │
    └── Sync backend ── UNTRUSTED for confidentiality.
                        Ciphertext + routing metadata. Trusted only for
                        ordering and availability, and §16 bounds even that.
```

## 4. Identity model

Nine identifiers. Conflating any two is a defect, and three of them never reach
the cloud at all.

| Identifier                                     | Scope                      | Assigned by | Cloud?                      | Notes                                                     |
| ---------------------------------------------- | -------------------------- | ----------- | --------------------------- | --------------------------------------------------------- |
| `abaUserId`                                    | the account                | backend     | **yes** — the partition key | permanent until account deletion                          |
| authentication session                         | one sign-in                | backend     | no                          | short-lived; **never a decryption capability** (§18)      |
| `deviceId`                                     | one installation           | client      | **yes** — as provenance     | not secret, not an authenticator (§5)                     |
| `workspaceId`                                  | a browser context boundary | client      | **yes** — metadata only     | **never an authorization credential**                     |
| `taskId`                                       | one task                   | client      | yes                         | terminal tasks only (§8)                                  |
| `workflowId`                                   | one workflow               | client      | yes                         |                                                           |
| `shortcutId`                                   | one shortcut               | client      | yes                         |                                                           |
| `connectionId`                                 | a connected AI account     | client      | **yes** — metadata only     | credential lives at `credentials:conn:<id>`, local-only   |
| **Chrome `tabId` / `tabGroupId` / `windowId`** | runtime handles            | Chrome      | **never**                   | recycled, restart-unstable, meaningless on another device |

### The rule that must not erode

`workspaceId` syncs; **workspace membership does not**. Membership is live
Chrome state, evaluated on the device by the existing guard, which reads
`chrome.tabs.get` at the moment of every operation. A restored workspace record
names a scope; it does not populate one, and it authorises nothing.

A cloud record can therefore never widen what the agent may touch. That is
SYNC-5, and §16 states the attack it forecloses.

## 5. Device registration

### `deviceId`

- **Generation:** `dev_` + `crypto.randomUUID()`, on first run.
- **Persistence:** `chrome.storage.local`. Survives worker eviction and browser
  restart; **does not survive extension reinstall or profile loss**.
- **Reinstall:** produces a _new_ `deviceId`. The old one remains registered
  until retired (§10). Two device rows for one physical machine is normal and
  is not an error to detect.
- **Not derived** from any Chrome runtime handle, the ABA user id, or the
  recovery key.
- **Not secret.** It is provenance, not an authenticator: presenting one
  authorises nothing, and forging one gains nothing. Authorization comes from
  the session (§18).

### Registration

A device registers once, on first sync, with `POST /v1/devices`. The backend
records `(abaUserId, deviceId)` and initialises `syncedThroughSeq = 0`. A
device is always owned by exactly one `abaUserId`; a second user signing in on
the same installation registers a **separate** device row under their own
account, because a watermark is meaningless across users.

### Multiple devices, retirement, reactivation

Many devices per user, no fixed limit (§26 covers abuse). Retirement and
reactivation are §10, because they exist to serve tombstone purge and are only
comprehensible alongside it.

## 6. Sync record model

One shape, on the wire and in storage.

| Field                     | Type   | Class                                 | Purpose                                                                             |
| ------------------------- | ------ | ------------------------------------- | ----------------------------------------------------------------------------------- |
| `abaUserId`               | string | **plaintext**                         | partition; in AAD                                                                   |
| `recordId`                | string | **plaintext**                         | identity; in AAD                                                                    |
| `recordType`              | enum   | **plaintext**                         | routing; in AAD                                                                     |
| `schemaVersion`           | int    | **plaintext**                         | body shape; in AAD                                                                  |
| `encVersion`              | int    | **plaintext**                         | envelope `v`; in AAD                                                                |
| `keyVersion`              | int    | **plaintext**                         | K1 key generation; in AAD                                                           |
| `revision`                | int    | **plaintext**                         | per-record, monotonic; in AAD                                                       |
| `deviceId`                | string | **plaintext**                         | provenance. **Not in AAD** — a record written on one device must decrypt on another |
| `deviceSeq`               | int    | **plaintext**                         | idempotency key component (§12)                                                     |
| `serverSeq`               | int64  | **plaintext**                         | server-assigned total order                                                         |
| `createdAt` / `updatedAt` | int64  | **plaintext**                         | **server-assigned.** Client clocks are display only and never decide anything       |
| `deleted`                 | bool   | **plaintext**                         | tombstone hint **for the server's own indexing** — see below                        |
| `envelope`                | object | header plaintext, body **ciphertext** | K1 §9                                                                               |

Everything a person wrote is inside `envelope.ct`. The table above is the
complete set of plaintext the backend ever holds for a record.

### Tombstones carry an envelope

A tombstone is not an empty row. It carries a normal K1 envelope encrypting a
fixed marker, and **the client trusts the decrypted marker, not the plaintext
`deleted` flag**.

The reason is narrow and worth stating. The plaintext flag is not in K1's AAD,
so a hostile backend could flip it. Flipping live → deleted is a denial it
could achieve anyway by withholding the row. Flipping deleted → live would
_resurrect_ a record — except that the decrypted body says `__tombstone`, which
it cannot forge without the key. Authority therefore sits inside the ciphertext,
and K1's AAD needs no change.

### Record types

`task` · `workflow` · `shortcut` · `preferences` · `workspace` ·
`connection`. There is no `audit` type (§27).

## 7. Revision model

| Counter     | Scope                   | Assigned by       | Monotonic    |
| ----------- | ----------------------- | ----------------- | ------------ |
| `revision`  | `(abaUserId, recordId)` | server, on accept | yes          |
| `deviceSeq` | `(abaUserId, deviceId)` | client, per push  | yes          |
| `serverSeq` | `abaUserId`             | server, on accept | yes, gapless |

**Writes are conditional.** A push carries `baseRevision`. The server accepts
only if the stored revision equals it, then assigns `revision = baseRevision+1`
and the next `serverSeq`. A mismatch is a conflict (§12), never a merge and
never an overwrite.

**No global last-write-wins.** Nothing compares timestamps to decide a winner.
`serverSeq` orders the stream; `revision` decides acceptance; content-level
resolution happens on a client that can read the content (§8).

**Concurrency.** Two devices pushing the same record: the first to be accepted
advances the revision, the second gets 409 with the winning record attached and
resolves per §8. Two devices pushing _different_ records never conflict —
`serverSeq` simply orders them.

## 8. Conflict policies

The backend detects; the client resolves. Resolution requires plaintext, and
the backend has none.

| Type            | Policy                                                                                                                                                                                                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **task**        | **Terminal-only.** Only terminal tasks sync, and a terminal task is immutable. A push against an existing terminal task is rejected `IMMUTABLE_RECORD` — not merged, not forked. Ids are UUIDs, so this indicates a client defect or a replay, and failing loudly is correct.                                                       |
| **workflow**    | **Fork.** On 409 the client decrypts both. If they differ materially it creates a **new record with a new `workflowId`** holding the losing version, titled `"<name> (edited on <device>)"`, and accepts the winner. Nothing is overwritten and nothing is discarded.                                                               |
| **shortcut**    | **Fork**, identically, disambiguating the name.                                                                                                                                                                                                                                                                                     |
| **preferences** | **Field-level LWW**, resolved client-side: decrypt both, compare per-field `updatedAt` carried _inside_ the body, merge, push the merge at the winner's revision. Independent scalars, so no work is destroyed. The backend cannot do this and is not asked to.                                                                     |
| **workspace**   | **Field-level LWW on descriptive fields only** — `title`, `createdAt`. That is the whole of the conflict surface, because the fields that would matter are not in the record: **membership, bindings and runtime ids do not sync** (§4). A workspace conflict therefore cannot change what the agent may touch, which is the point. |
| **connection**  | **Field-level LWW** on `modelId`, `status`, `accountLabel`, `baseUrl`, capability detail. `connectionId` is device-minted and unique, so two devices can only collide on the same connection's fields. **No credential is present**, so no conflict path can touch one.                                                             |

## 9. Tombstones

The critical section. A tombstone that is purged too early resurrects deleted
data; one that is never purged grows without bound.

**Approved policy: 90 days is a retention floor, not a deletion condition.**

```
purgeable(tombstone at serverSeq T)  ⟺
      age(T) ≥ 90 days
  ∧   T < min( syncedThroughSeq )  over all non-retired devices of this user
```

Both conjuncts. Age alone is the bug below; acknowledgement alone would purge
history sooner than the retention policy promises.

### `syncedThroughSeq`

> The highest `serverSeq` a device has **durably applied and acknowledged**.

- **Meaning:** every change at or below this point has been written to that
  device's local storage. Not "received", not "requested" — applied. A device
  that crashes mid-apply must not have advanced it.
- **Advanced by:** `POST /v1/sync/ack` after the local write commits. Pulling
  changes never advances it; only the explicit ack does. That separation is the
  whole guarantee.
- **Stored:** server-side, per `(abaUserId, deviceId)`. Monotonic — the server
  rejects a lower value rather than accepting a regression.
- **Not** a timestamp, not a last-seen marker, not derived from any clock.

### `purgeHorizon`

Per-user, monotonic, server-held: the `serverSeq` below which tombstones have
been purged. It rises only when a purge runs, and never falls.

### The attack this prevents

```
Device A deletes R           → tombstone at serverSeq T
Device B goes offline, still holding R
90 days elapse
Tombstone purged on age alone           ← the bug
Device B reconnects, never told R was deleted
Device B pushes R                       → R is resurrected
```

The user deleted something and it came back. No cryptography is involved and
none would help: elapsed time says nothing about who still holds the record.
Under the rule above the purge cannot run, because `B.syncedThroughSeq` is
still below `T`.

### Offline devices

An offline device blocks purging for as long as it remains non-retired. That is
correct: it is the only evidence that would make purging safe. Unbounded
blocking is resolved by retirement (§10), not by ignoring the device.

### Devices that return

A device whose `syncedThroughSeq` is **below `purgeHorizon`** has provably
missed deletions it can never learn about. It **may not delta-sync**. It must
reconcile (§10), and the discriminator is not the horizon but whether the
client ever saw the record confirmed.

## 10. Device retirement

Retirement makes purging possible, so it must not make resurrection possible.

### Eligibility and state

A device is eligible for retirement when it has not acknowledged for **`D`
days**, where **`D` > 90** (TUNABLE; the constraint is that a device must not
leave the quorum while its tombstones are still live). Server-side state on the
device row: `retired_at`, null when active.

Retirement removes the device from the `min(syncedThroughSeq)` quorum and
nothing else. It deletes no record and revokes no session.

### Reactivation

A retired device that authenticates successfully is reactivated: `retired_at`
cleared, and it rejoins the quorum at its _existing_ watermark — never at the
current head, which would silently claim it had seen changes it has not.

**Reactivation does not require the recovery key.** The device still holds its
KEK; retirement was a server-side bookkeeping state, not a local wipe.

### The returning device with stale state

On reactivation, if `syncedThroughSeq < purgeHorizon`, the client performs a
**full reconciliation** rather than an incremental pull. For each local record:

| Local state                       | Present on server? | Action                                                                                        |
| --------------------------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| clean, has `lastConfirmedSeq`     | yes                | normal revision reconciliation                                                                |
| clean, has `lastConfirmedSeq`     | **no**             | it was on the server and is gone → **deleted**. Remove locally.                               |
| clean, no `lastConfirmedSeq`      | no                 | never uploaded → push as new                                                                  |
| **dirty**, has `lastConfirmedSeq` | **no**             | **surface to the user.** Edited offline, deleted elsewhere. Keep or discard is their decision |
| dirty, no `lastConfirmedSeq`      | no                 | new local work → push as new                                                                  |

`lastConfirmedSeq` is client-side: the `serverSeq` at which the server last
confirmed that record, from a pull or a successful push. Its presence is what
distinguishes "was deleted" from "never synced" — and it does so without
consulting a clock.

**Offline modifications are never silently dropped, and deleted records are
never silently resurrected.** The one ambiguous case is escalated to the
person, because the protocol genuinely cannot decide it and guessing would be
wrong in one direction or the other.

## 11. Sync pull

### Bootstrap

`GET /v1/sync/manifest` (§13) returns crypto parameters and cursors. Small,
constant-size, no record bodies.

### Incremental

`GET /v1/sync/changes?since=<serverSeq>&limit=<n>` returns records with
`serverSeq > since`, in ascending `serverSeq` order, including tombstones.
Response carries `nextCursor` and `hasMore`.

- **`since = 0`** is the full history, paginated identically. There is no
  separate "initial" endpoint to diverge from the incremental one.
- **`since < purgeHorizon`** is rejected `CURSOR_BELOW_HORIZON`, and the client
  reconciles per §10. Serving it would omit purged tombstones and silently
  resurrect their records.
- **Ordering is gapless**, so a client can detect a missing page rather than
  skipping it.

### Authentication, authorization, integrity

Session-authenticated (§18). Every query is scoped to the session's
`abaUserId`; there is no request shape in which a client names another user's
partition (§16). Integrity of _content_ is the GCM tag, checked on the client —
the backend cannot verify it and is not trusted to.

### Acknowledgement

After durably applying a page, the client calls `POST /v1/sync/ack` with the
highest fully-applied `serverSeq`. This is the only thing that advances
`syncedThroughSeq` (§9).

## 12. Sync push

`POST /v1/sync/records` with a batch of records, each carrying `baseRevision`,
`deviceId` and `deviceSeq`.

### Idempotency

The idempotency key is `(abaUserId, deviceId, deviceSeq)`. The server stores
the outcome and returns the **same** result for a repeat, rather than applying
twice. A retry after a timeout is therefore safe, which matters because the
client cannot distinguish "never arrived" from "arrived, response lost".

### Optimistic concurrency

Accepted only when the stored revision equals `baseRevision`. On acceptance the
server assigns `revision+1` and the next `serverSeq`.

### Responses

| Outcome              | Status                     | Body                                                                          |
| -------------------- | -------------------------- | ----------------------------------------------------------------------------- |
| accepted             | 200                        | new `revision`, `serverSeq`                                                   |
| stale revision       | 409 `STALE_REVISION`       | the **current** record, so the client can resolve without another round trip  |
| immutable record     | 409 `IMMUTABLE_RECORD`     | terminal task already present (§8)                                            |
| duplicate            | 200                        | the original outcome, from the idempotency store                              |
| cursor below horizon | 409 `CURSOR_BELOW_HORIZON` | reconcile (§10)                                                               |
| retired device       | 409 `DEVICE_RETIRED`       | reactivate first (§10)                                                        |
| too large            | 413 `RECORD_TOO_LARGE`     | nothing is written; the client retains the record and stops retrying (§33 Q1) |

### Transaction boundaries

**Per record, not per batch.** A batch is a transport convenience: each record
succeeds or fails independently, and the response reports per-record outcomes.
An all-or-nothing batch would let one conflicted record block unrelated work
indefinitely.

`serverSeq` allocation and the record write are a single transaction, so a
gapless order is a database property rather than a convention.

## 13. Manifest

`GET /v1/sync/manifest` — the bootstrap document.

```jsonc
{
  "abaUserId": "usr_…",
  "kdSalt": "…",            // K1 §7.3 — non-secret, needed to derive on a new device
  "kdInfo": "aba/k1/kek/v1",
  "keyVersion": 1,
  "keyCheck": { … },        // K1 §17 — envelope over a fixed plaintext
  "serverSeq": 918273,      // current head
  "purgeHorizon": 41200,
  "device": { "deviceId": "dev_…", "syncedThroughSeq": 918100, "retiredAt": null },
  "counts": { "task": 412, "workflow": 18, "shortcut": 7, "preferences": 1,
              "workspace": 3, "connection": 4 },
  "limits": { "maxRecordBytes": 262144 }  // §33 Q1 — TUNABLE, illustrative here
}
```

Counts are for progress display only; nothing branches on them.

`limits.maxRecordBytes` is the backend's maximum accepted record size on the
wire. The client enforces the **smaller** of it and its own compiled-in
maximum, so a served value can only tighten the check and never loosen it
(SYNC-26, §33 Q1).

**The manifest must not contain**, and has no field capable of carrying:
plaintext tasks · page content · provider prompts · provider responses ·
provider API keys · OAuth secrets · the recovery key · the KEK · any DEK.

`keyCheck` is a K1 envelope over a fixed plaintext. It leaks nothing an
attacker could not already attempt against any ciphertext, and against a
128-bit uniform secret that is nothing usable.

## 14. Backend schema

Minimum viable. Not implemented.

### `aba_user`

| Field           | Type             | Notes                                                         |
| --------------- | ---------------- | ------------------------------------------------------------- |
| `id`            | text PK          | `usr_…`                                                       |
| `created_at`    | timestamptz      |                                                               |
| `deleted_at`    | timestamptz null | tombstone for account deletion (§29)                          |
| `kd_salt`       | bytea(16)        | K1 §7.3, non-secret                                           |
| `kd_info`       | text             |                                                               |
| `key_version`   | int              |                                                               |
| `key_check`     | jsonb            | envelope over a fixed plaintext                               |
| `server_seq`    | bigint           | the user's allocator; incremented under the write transaction |
| `purge_horizon` | bigint           | monotonic (§9)                                                |

Ownership: the partition key for everything below. Retention: until deletion.
**Security:** `kd_salt` is non-secret by construction; it is stored here
because a new device needs it before it holds anything else.

### `device`

| Field                          | Type             | Notes                                            |
| ------------------------------ | ---------------- | ------------------------------------------------ |
| `aba_user_id`                  | text FK          |                                                  |
| `device_id`                    | text             |                                                  |
| `synced_through_seq`           | bigint           | monotonic; server rejects regression (§9)        |
| `registered_at`, `last_ack_at` | timestamptz      | `last_ack_at` drives retirement eligibility only |
| `retired_at`                   | timestamptz null | (§10)                                            |

PK `(aba_user_id, device_id)`. Index on `(aba_user_id, retired_at)` for the
quorum minimum. **Security:** `device_id` is not an authenticator; authorization
is the session.

### `sync_record`

| Field                                          | Type         | Notes                                                |
| ---------------------------------------------- | ------------ | ---------------------------------------------------- |
| `aba_user_id`                                  | text FK      |                                                      |
| `record_id`                                    | text         |                                                      |
| `record_type`                                  | text         |                                                      |
| `revision`                                     | int          |                                                      |
| `server_seq`                                   | bigint       | unique per user                                      |
| `device_id`, `device_seq`                      | text, bigint | provenance, idempotency                              |
| `schema_version`, `enc_version`, `key_version` | int          |                                                      |
| `deleted`                                      | boolean      | routing hint; authority is the decrypted marker (§6) |
| `envelope`                                     | jsonb        | header + ciphertext                                  |
| `created_at`, `updated_at`                     | timestamptz  | **server-assigned**                                  |

PK `(aba_user_id, record_id)`. Indexes: `(aba_user_id, server_seq)` for the
change feed — the hot path; `(aba_user_id, deleted, server_seq)` for purge
scans. Retention: live records until deleted; tombstones per §9.
**Security:** every query is scoped by `aba_user_id` from the session, never
from the request body (§16).

### `push_idempotency`

| Field                                    | Type        | Notes                  |
| ---------------------------------------- | ----------- | ---------------------- |
| `aba_user_id`, `device_id`, `device_seq` | PK          | the key                |
| `outcome`                                | jsonb       | the response to replay |
| `created_at`                             | timestamptz |                        |

Retention: **TUNABLE**, and must exceed the client's maximum retry window or a
late retry becomes a duplicate write.

### `session`

Owned by the authentication design, not this one. Referenced here only as the
source of `abaUserId` for authorization (§18).

## 15. API contract

All endpoints session-authenticated. `abaUserId` comes from the session and is
never read from the request.

| Endpoint                             | Purpose                         | Idempotent                      |
| ------------------------------------ | ------------------------------- | ------------------------------- |
| `POST /v1/devices`                   | register this installation      | yes, by `deviceId`              |
| `GET /v1/sync/manifest`              | bootstrap (§13)                 | yes                             |
| `GET /v1/sync/changes?since=&limit=` | incremental pull (§11)          | yes                             |
| `POST /v1/sync/records`              | batch push (§12)                | yes, by `(deviceId, deviceSeq)` |
| `POST /v1/sync/ack`                  | advance `syncedThroughSeq` (§9) | yes, monotonic                  |
| `POST /v1/devices/{id}/retire`       | user-initiated retirement       | yes                             |
| `POST /v1/devices/{id}/reactivate`   | on return (§10)                 | yes                             |

`/auth/*` belongs to the authentication design and is out of scope (§18).

### Errors

Uniform shape `{ code, message }`, with codes from §23. Two rules:

- **Authorization failures never confirm existence.** A record belonging to
  another user returns the same `NOT_FOUND` as one that does not exist.
- **Messages never carry record content**, because content is ciphertext the
  backend cannot read and must not echo into a log.

## 16. Security

| Threat                         | Control                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **cross-user record access**   | `abaUserId` comes from the session, never the request. No endpoint accepts a user id as a parameter, so there is no shape in which one user names another's partition. Enforced again at the row level by the PK.                                                                              |
| **record transplant**          | K1 AAD binds `abaUserId`, `recordId`, `recordType`, `schemaVersion`, `revision`. A moved ciphertext fails its tag. The backend cannot construct a valid one because it has no key.                                                                                                             |
| **replay**                     | `(deviceId, deviceSeq)` idempotency; a replayed push returns the original outcome instead of applying again. `revision` in the AAD means an old body cannot masquerade as a current one.                                                                                                       |
| **stale writes**               | conditional on `baseRevision`; a mismatch is 409, never a merge.                                                                                                                                                                                                                               |
| **rollback**                   | server `serverSeq` is monotonic and gapless; clients hold a high-water mark and reject a served revision below one already seen. **Residual:** a client with no retained state cannot detect a consistent full rollback (K1 §15) — it has nothing to compare against.                          |
| **duplicate writes**           | idempotency store (§14).                                                                                                                                                                                                                                                                       |
| **malicious client**           | can only write its own partition, cannot forge another user's AAD, cannot advance another device's watermark, cannot lower its own (monotonic). Worst case it corrupts its own data — which it could do locally anyway.                                                                        |
| **malicious backend operator** | holds ciphertext; cannot decrypt, cannot forge. **Can** delete, withhold, reorder-by-omission and observe metadata — availability and metadata, not confidentiality. Stated rather than defended against, because no client-side design prevents a storage provider from losing data.          |
| **compromised database**       | same: ciphertext plus the plaintext routing table in §6, and nothing else.                                                                                                                                                                                                                     |
| **device compromise**          | K1 §0 — outside the boundary. The KEK is on that device.                                                                                                                                                                                                                                       |
| **device retirement abuse**    | retirement is server-side and affects only the purge quorum. A retired device cannot push (`DEVICE_RETIRED`) until reactivated, and reactivation restores its **existing** watermark rather than the head, so retirement cannot be used to make a device claim it has seen changes it has not. |

### Cloud Sync grants no browser authority

The design rule, stated as an attack that must fail:

> A hostile backend serves a workspace record naming tabs, groups or windows.
> The extension restores it. The agent gains access to those tabs.

It fails at the first step: **membership does not sync** (§4). A workspace
record carries a title and timestamps. The extension's guard resolves
membership from `chrome.tabs.get` at the moment of each operation, and a cloud
record is not an input to it. There is no field a hostile backend could set to
widen the agent's reach, and `SYNC-5` asserts it.

## 17. Backend knowledge boundary

| Data                                                                                 | Backend can see?          | Why                                                      |
| ------------------------------------------------------------------------------------ | ------------------------- | -------------------------------------------------------- |
| `abaUserId`                                                                          | **yes**                   | the partition key                                        |
| `recordId`, `recordType`, `schemaVersion`                                            | **yes**                   | routing and conflict detection                           |
| `revision`, `serverSeq`, `deviceId`, `deviceSeq`                                     | **yes**                   | ordering, idempotency, provenance                        |
| `createdAt`, `updatedAt` (server-assigned)                                           | **yes**                   | ordering                                                 |
| `deleted` flag                                                                       | **yes**                   | its own indexing; authority is the decrypted marker (§6) |
| `syncedThroughSeq`, `retiredAt`                                                      | **yes**                   | the purge quorum (§9)                                    |
| `kdSalt`, `kdInfo`, `keyVersion`, `keyCheck`                                         | **yes**                   | non-secret; a new device needs them                      |
| **encrypted content**                                                                | **yes — ciphertext only** | it stores the envelope and cannot open it                |
| record count, size, timing                                                           | **yes, unavoidably**      | metadata privacy is an explicit non-goal (K1 §3)         |
| **plaintext tasks, workflows, shortcuts, preferences, workspace, connection bodies** | **no**                    | encrypted under K1                                       |
| **audit content**                                                                    | **no**                    | `LOCAL_ONLY`; no audit record exists (§27)               |
| **page content**                                                                     | **no**                    | never uploaded, any release                              |
| **provider prompts, model responses**                                                | **no**                    | same                                                     |
| **provider API keys**                                                                | **no**                    | `SECRET_LOCAL_ONLY`, permanently                         |
| **provider OAuth secrets**                                                           | **no**                    | same                                                     |
| **provider credential fragments**                                                    | **no**                    | K1 Q4; credential material regardless of length          |
| **recovery key**                                                                     | **no**                    | never transmitted in any form                            |
| **KEK**                                                                              | **no**                    | derived locally, never leaves the device                 |
| **any DEK**                                                                          | **no**                    | only the wrapped form is stored                          |
| **Chrome tab / group / window ids**                                                  | **no**                    | local runtime state (§4)                                 |

No field in `SyncRecord`, the manifest, or any request body is capable of
carrying anything in the lower block. That absence is the enforcement.

## 18. Authentication interaction

Authentication is designed elsewhere. This document defines only the
relationship, and it is a separation rather than a handshake.

**Authentication establishes:** the `abaUserId`, and a session that authorises
sync requests for that user's partition.

**Authentication does not establish:** any ability to decrypt. A session
retrieves ciphertext and stops there.

The backend must not be able to derive the recovery key from a session, and
cannot: the key is never sent, never a login factor, and never stored
server-side in any form — not hashed, not as a verifier (K1 §19). No value the
backend holds is a function of it (K1 K-22).

An attacker holding a stolen session can enumerate record ids, types, sizes and
timings, and can delete records. That is availability and metadata. It is not
confidentiality, and `SYNC-11` asserts the difference.

## 19. Local / cloud preference

```
                 ┌──────────────┐
      install ──▶│  undecided   │  ← default. ZERO cloud upload.
                 └──┬────────┬──┘
         explicit   │        │   explicit choice
         choice     ▼        ▼
              ┌─────────┐  ┌────────┐
              │  local  │◀▶│ cloud  │
              └─────────┘  └────────┘
```

**`undecided` uploads nothing.** Not a soft yes, not a deferred yes. Silence is
not consent, and `SYNC-12` asserts it.

### undecided → local

Nothing is uploaded, then or later. The user is told plainly that local-only
data cannot be recovered if the profile is lost, because that is true and
discovering it afterwards is the worst possible moment.

### undecided → cloud, and local → cloud

Requires **explicit confirmation**, and initialisation in this order:

1. generate the recovery key (K1 §7.2), display it, require acknowledgement
   that it has been saved;
2. derive the KEK, write `kdSalt`/`keyCheck` to the backend;
3. register the device (§5);
4. encrypt and push existing local records.

No upload happens before step 1 completes. A user who abandons setup at step 1
has uploaded nothing.

### cloud → local

- Future uploads stop immediately.
- **Local data is retained in full.** Switching storage preference is not a
  deletion instruction.
- **Cloud data is retained too.** This design invents no destructive behaviour:
  removing the cloud copy is a separate, explicit action with its own
  confirmation, and account deletion (§29) is the path that removes everything.
- The device stays registered until retired or explicitly removed, so it does
  not silently vanish from another device's purge quorum.

## 20. Reinstall recovery

```
new install (no local state, new deviceId)
  → authenticate                       → same abaUserId, never a new one
  → GET /sync/manifest                 → kdSalt, kdInfo, keyVersion, keyCheck
  → user supplies the RECOVERY KEY     ← authentication did not provide this
  → HKDF → KEK, verified against keyCheck
  → POST /devices                      → register the new deviceId
  → GET /sync/changes?since=0          → paginated, ascending
  → decrypt, write local state
  → POST /sync/ack                     → watermark starts at the restored head
```

- **Provider credentials are not restored.** They were never uploaded. There is
  no field in any response capable of carrying one.
- **Connection metadata restores as `disconnected`**, carrying the existing
  `CREDENTIAL_RECONNECT_NOTICE`. Restoring the shape of someone's setup and
  asking for one key back is better than losing the account, and far better
  than presenting a connection that will fail at its first request.
- **A record that fails to decrypt is retained, not dropped**, and reported
  (K1 §17).
- The old device remains registered until retired (§10). Two devices for one
  machine is expected after a reinstall.

## 21. Logout and session expiry

|                       |                                                    |
| --------------------- | -------------------------------------------------- |
| session tokens        | **removed**, and revoked server-side               |
| local encrypted state | **kept** — every byte                              |
| the KEK               | **kept**; no recovery-key re-entry on next sign-in |
| cloud records         | **kept**                                           |
| `abaUserId`           | **kept**; never rotated, never recreated           |
| provider credentials  | **kept**, local, untouched                         |
| device registration   | **kept**; the device stays in the purge quorum     |

Re-authentication restores access with no recovery step, because nothing was
lost. This is structural rather than a rule: the session store holds no
reference to the account store, the credential store, the task store or the
identity profile (K1 §20).

## 22. Authentication outage grace

| State                                                          | Sync behaviour                                                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **normal session**                                             | pull, push and ack as usual                                                                                                                            |
| **grace** (backend unreachable, within 7 days of last contact) | sync is _unavailable_, not _forbidden_. Local work continues; changes queue (§24). Nothing is deleted, `abaUserId` is not rotated, no work is orphaned |
| **grace expired** (past 7 days)                                | re-authentication required before sync resumes. **The queue persists.** Nothing is discarded to demand a sign-in                                       |

The grace period extends authentication continuity and nothing else. Its expiry
has exactly one consequence: a sign-in prompt.

## 23. Failure modes

| Condition                  | Code                   | Behaviour                                                                                                                                  |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| network loss               | —                      | queue locally, retry with backoff (§24)                                                                                                    |
| backend unavailable        | `5xx`                  | same; never a data-losing fallback                                                                                                         |
| stale revision             | `STALE_REVISION`       | resolve per §8 with the returned record                                                                                                    |
| corrupted ciphertext       | `DECRYPT_FAILED`       | that record is unreadable; **retained**, reported, the rest proceed                                                                        |
| unknown encryption version | `UNSUPPORTED_VERSION`  | refuse to parse, **do not delete**, prompt to update (K1 §24)                                                                              |
| unauthorized user          | `NOT_FOUND`            | never confirms existence (§15)                                                                                                             |
| retired device             | `DEVICE_RETIRED`       | reactivate (§10)                                                                                                                           |
| duplicate push             | —                      | 200 with the original outcome                                                                                                              |
| conflicting local state    | `STALE_REVISION`       | §8; forks rather than overwrites where the policy says so                                                                                  |
| cursor below horizon       | `CURSOR_BELOW_HORIZON` | full reconciliation (§10)                                                                                                                  |
| record over the size limit | `RECORD_TOO_LARGE`     | refused before upload; **retained** locally and reported, never truncated and never uploaded in part (§33 Q1)                              |
| partial sync               | —                      | per-record outcomes (§12); applied records ack, failures retry. `syncedThroughSeq` advances only to the last **contiguous** applied change |

That last row matters: acking a high watermark while a lower change failed
would claim the device had applied something it had not, and the purge quorum
would then be wrong.

## 24. Offline behaviour

- **Local work continues unaffected.** Sync is an addition to the extension,
  never a precondition for it.
- Changes encrypt immediately and enter a durable local queue — encrypted at
  rest even before they leave, so an offline queue is not a plaintext spool.
- **Ordering** is per-record by `deviceSeq`; a record pushes in the order it
  was changed. Across records, order is irrelevant — `serverSeq` establishes it
  on arrival.
- **Retries** use exponential backoff with jitter (**TUNABLE**), and are safe
  because every push is idempotent (§12).
- **Duplicate prevention** is the `(deviceId, deviceSeq)` key, not
  deduplication by content — content is ciphertext and two encryptions of the
  same plaintext differ.
- **Conflicts** surface on reconnection, resolved per §8. A long-offline device
  may additionally need §10 reconciliation.

## 25. Pagination and large datasets

| Parameter              | Value       | Status                                                                                                      |
| ---------------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| default page size      | 100 records | **TUNABLE**                                                                                                 |
| maximum page size      | 500 records | **TUNABLE**                                                                                                 |
| maximum response bytes | —           | **TUNABLE**; the byte cap binds before the record cap, because record sizes vary                            |
| maximum single record  | —           | **TUNABLE**, floor derived in §33 Q1; enforced client-side before upload and again by the backend (SYNC-23) |

Cursor semantics: `since` is an exclusive `serverSeq`; results ascend;
`nextCursor` is the highest `serverSeq` returned; `hasMore` is explicit rather
than inferred from a short page, so a page that is short for byte reasons is
not mistaken for the end.

A cursor remains valid while it is at or above `purgeHorizon`. Below that it is
rejected rather than silently serving an incomplete history (§11).

## 26. Rate limits

Categories, not production numbers — those belong with real traffic, and
inventing them here would give them unearned authority.

| Category            | Shape                             | Rationale                                                            |
| ------------------- | --------------------------------- | -------------------------------------------------------------------- |
| authentication      | strictest, per-IP and per-account | credential-adjacent                                                  |
| device registration | strict, per-account               | registration is rare and unbounded registration is an abuse vector   |
| manifest            | moderate, per-session             | small and cacheable                                                  |
| changes (pull)      | generous, per-session             | a large restore is legitimate and must not be throttled into failure |
| records (push)      | moderate, per-device              | bounded by real user activity                                        |
| ack                 | generous                          | one per applied page                                                 |
| retire / reactivate | strict                            | state-changing and rare                                              |

A throttled sync **retries**; it never drops a change and never resolves a
conflict by giving up.

## 27. Audit

**Audit content is `LOCAL_ONLY`** (K1 Q6). Cloud Sync does not upload it, in
plaintext or encrypted. There is no `audit` record type, so there is no audit
row, no audit envelope and **no audit sync metadata** — the protocol has
nothing to order, acknowledge or reconcile for it, and this document invents no
carve-out.

The reason is data minimisation, not a cryptographic obstacle: the envelope
would protect audit perfectly well. Audit is the highest-volume record type and
its content is browsing history — `destination`, `origin`, `site`.

Should security telemetry ever be wanted, it is a **separate architecture** with
its own consent, its own retention and its own review. It is not this protocol
extended quietly.

## 28. Privacy

**Minimum backend metadata** is exactly the plaintext block in §17 and nothing
more. No analytics, no telemetry, no behavioural logging, no page content, no
provider content, no provider secrets.

|                          |                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **retention**            | live records until deleted; tombstones per §9; idempotency keys per §14; sessions per the authentication design                                                                                        |
| **deletion**             | §29                                                                                                                                                                                                    |
| **data minimisation**    | a field exists only where the protocol cannot function without it. `deviceId` earns its place through the purge quorum; `serverSeq` through ordering. Anything that would merely be _useful_ is absent |
| **unavoidable exposure** | record counts, sizes and timing. Metadata privacy is an explicit non-goal (K1 §3) and is stated rather than implied away                                                                               |

## 29. Account deletion

The explicit destructive action, and **two erasures that must not be
conflated**:

**Backend.** Delete `sync_record` rows including tombstones, `device` rows,
`push_idempotency` rows and sessions. Tombstone `aba_user` — id and
`deleted_at` only — for a 30-day replay window (**TUNABLE**), then purge.
Requires re-authentication within the last five minutes.

**Local.** A separate, explicit wipe: tasks, workflows, shortcuts, audit,
evidence, workspaces, preferences, connection metadata, **provider
credentials**, the identity profile and the KEK.

Deleting the backend account **cannot** reach into browser storage. Saying
"your data is deleted" while a provider API key remains on disk would be a lie,
so the UI offers both and states which does what.

Deletion is final for cloud data: the ciphertext is gone and the recovery key
cannot bring it back.

## 30. Threat model

| Adversary                        | Can                                                     | Cannot                                                                                                                     |
| -------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **malicious server**             | delete, withhold, reorder by omission, observe metadata | decrypt, forge a valid AAD, resurrect a record (the tombstone marker is inside the ciphertext), grant browser access       |
| **compromised database**         | read ciphertext and the §17 plaintext                   | decrypt                                                                                                                    |
| **stolen ciphertext**            | attempt 2¹²⁸                                            | anything practical (K1 §4)                                                                                                 |
| **stolen device**                | read what that device holds                             | — it is inside K1 §0's boundary; the honest answer is that the KEK is there                                                |
| **compromised Chrome profile**   | same                                                    | same                                                                                                                       |
| **malicious authenticated user** | corrupt their own partition                             | reach another partition — session-scoped, PK-enforced, AAD-bound                                                           |
| **replay attacker**              | resend a captured push                                  | cause a second write — idempotency and `revision`-in-AAD both refuse                                                       |
| **rollback attacker**            | serve an older state                                    | fool a device that has synced before (high-water mark). **Can** fool a fresh install, which has nothing to compare against |
| **offline device**               | hold stale records indefinitely                         | resurrect a deleted record — it blocks purge while non-retired, and reconciles when it returns (§10)                       |
| **retired device**               | return and reactivate                                   | claim to have seen changes it has not; reactivation restores its existing watermark                                        |
| **cross-user attack**            | —                                                       | name another partition; no request shape accepts a user id                                                                 |

## 31. Security invariants

Testable, in the style of the repository's existing invariants.

| #       | Invariant                                                                                                                                                                                     |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SYNC-1  | The backend never receives plaintext user work — no request body carries an unencrypted record body.                                                                                          |
| SYNC-2  | The backend never receives a provider secret or credential fragment.                                                                                                                          |
| SYNC-3  | The backend never receives the recovery key, in any encoding.                                                                                                                                 |
| SYNC-4  | The backend never receives the KEK or an unwrapped DEK.                                                                                                                                       |
| SYNC-5  | **No Chrome runtime id appears in any sync payload, and no cloud record is an input to workspace membership or route trust.** Cloud Sync grants no browser authority.                         |
| SYNC-6  | A user cannot read another user's records; `abaUserId` is taken from the session and never from a request.                                                                                    |
| SYNC-7  | A stale revision cannot silently overwrite a newer one — a `baseRevision` mismatch is refused.                                                                                                |
| SYNC-8  | A deleted record cannot be resurrected by a non-retired stale device.                                                                                                                         |
| SYNC-9  | A tombstone is never purged on elapsed time alone; the watermark conjunct is required.                                                                                                        |
| SYNC-10 | Initial Cloud Sync uploads no audit content and creates no audit record.                                                                                                                      |
| SYNC-11 | A valid authenticated session, alone, decrypts nothing.                                                                                                                                       |
| SYNC-12 | With the storage preference `undecided`, zero bytes are uploaded.                                                                                                                             |
| SYNC-13 | A repeated push with the same `(deviceId, deviceSeq)` applies once.                                                                                                                           |
| SYNC-14 | `syncedThroughSeq` never decreases, and advances only on an explicit ack after a durable local write.                                                                                         |
| SYNC-15 | A returning device below `purgeHorizon` cannot delta-sync; it reconciles.                                                                                                                     |
| SYNC-16 | Offline modifications are never silently dropped, and deleted records are never silently resurrected — the ambiguous case is escalated to the user.                                           |
| SYNC-17 | A record that fails to decrypt, or carries an unknown encryption version, is retained rather than deleted.                                                                                    |
| SYNC-18 | Logout and session expiry change no byte of local or cloud user data.                                                                                                                         |
| SYNC-19 | An authentication outage, during or past grace, never rotates `abaUserId`.                                                                                                                    |
| SYNC-20 | Reinstall with the same identity yields the same `abaUserId` — never a new one.                                                                                                               |
| SYNC-21 | No provider credential is restorable from the cloud; no response field can carry one.                                                                                                         |
| SYNC-22 | Server-assigned timestamps and sequences are the only ordering inputs; no correctness decision reads a client clock.                                                                          |
| SYNC-23 | No record is uploaded whose **encoded sync payload** exceeds `MAX_SYNC_RECORD_BYTES`; the check is on the wire size, runs before encryption, and runs again at the backend before acceptance. |
| SYNC-24 | A record over the limit is refused whole — never truncated, never stripped of fields, never uploaded in part, and never uploaded unencrypted or to any other destination.                     |
| SYNC-25 | A record over the limit is retained locally, unmodified, and remains readable, editable and deletable; its tombstone is always under the limit and always syncs.                              |
| SYNC-26 | A size limit served by the backend can only lower the client's compiled-in maximum, never raise it.                                                                                           |

## 32. Implementation gates

Mandatory before backend implementation is considered complete. **None is
implemented.**

1. **Cross-user access** — every endpoint, with a session for user A naming
   user B's record: `NOT_FOUND`, never a distinguishable error (SYNC-6).
2. **Ciphertext transplant** — a record moved between users, record ids, or
   record types fails to decrypt (K1 K-4…K-8).
3. **Replay** — a captured push resent applies once (SYNC-13).
4. **Rollback** — a device that has synced rejects a served revision below its
   high-water mark (SYNC-7).
5. **Offline device beyond 90 days** — the §9 scenario end to end: delete, take
   a device past retention, attempt purge, assert it is refused while the
   device is non-retired (SYNC-8, SYNC-9).
6. **Device retirement** — retirement removes the device from the quorum,
   permits purge, and deletes nothing (§10).
7. **Returning device** — below `purgeHorizon`, reconciliation runs, the
   five-case table in §10 is exercised, and the dirty-and-absent case reaches
   the user rather than being decided silently (SYNC-15, SYNC-16).
8. **Duplicate push** — idempotency across a simulated response loss.
9. **Concurrent updates** — two devices, same record: one wins, the other
   resolves per §8 without data loss; forks are asserted for workflows and
   shortcuts.
10. **Corrupted ciphertext** — flipped bits in `ct`, tag, nonce and AAD; the
    record is retained and reported (SYNC-17).
11. **Unknown encryption version** — refused, retained, not parsed (SYNC-17).
12. **Authentication outage, 7-day grace** — at the boundary on both sides;
    no deletion, no identity rotation (SYNC-19).
13. **Logout and session expiry** — no byte of user data changes (SYNC-18).
14. **Reinstall recovery** — same `abaUserId`, recovery key required, provider
    keys absent, connections `disconnected` (SYNC-20, SYNC-21).
15. **Provider-secret non-egress** — as a mutation: add a field to `SyncRecord`
    capable of carrying a credential and require the suite to fail (SYNC-2).
16. **Page-content non-egress** — no captured request contains page text,
    prompt or model response (SYNC-1).
17. **Audit non-egress** — no audit record is created or uploaded (SYNC-10).
18. **Preference `undecided`** — zero bytes uploaded across a full session
    (SYNC-12).
19. **Chrome runtime id non-egress** — no tab, group or window id in any
    payload, and no cloud record reaches the workspace guard (SYNC-5).
20. **Ack semantics** — `syncedThroughSeq` advances only after a durable write,
    never on receipt, and never regresses (SYNC-14).
21. **Oversized record** — a record one byte over the limit: no request is
    made, no `deviceSeq` is consumed, the local record is byte-identical
    afterwards, the rest of the queue syncs, and the user-facing state names
    the size and the limit (SYNC-23, SYNC-24, SYNC-25).
22. **Oversized record, deletion and recovery** — deleting one still syncs its
    tombstone; bringing it back under the limit makes it sync with no
    intervention; a record that grew after being synced resolves through §8
    rather than overwriting (SYNC-25).
23. **Backend size enforcement** — a client with the check disabled is refused
    at the backend with `RECORD_TOO_LARGE` and nothing is written; a backend
    advertising a larger limit than the client's compiled-in maximum does not
    raise it (SYNC-23, SYNC-26).

## 33. Open questions

One remains. Q1 is resolved below, and the resolution is kept here with the
evidence that produced it rather than moved elsewhere, because the number is
only defensible alongside the measurements.

### Q1 — Maximum encrypted record size — RESOLVED

**One record, one envelope, one row, with a hard maximum size enforced on the
client before anything is encrypted and again by the backend before anything
is accepted. No chunking in v1.**

#### What the repository actually stores

Six record types (§6), all persisted as plain JSON in `chrome.storage.local`.
`unlimitedStorage` is granted (`public/manifest.json`), so Chrome's per-item
storage quota does not shape the answer; the constraint is a protocol
constraint only.

| Record type   | Structural limits already enforced in the repository                                                                                                                                                                   | Field that can grow without a hard bound                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `workflow`    | `MAX_STEPS_PER_SKILL = 24`, `MAX_SKILL_INPUTS = 12`, `MAX_COMPOSITION_DEPTH = 3`, `MAX_BINDING_PATH_SEGMENTS = 6` (`src/skills/core/skill-model.ts`); element binding `role`/`name` ≤ 200 chars; 50 workflows retained | a `literal` binding's value — checked for plain-data shape and depth ≤ 8, never size |
| `task`        | `DEFAULT_BUDGET` 60 tool calls / 40 model requests (`src/agent/budget/budget.ts`); model-message step summary `text.slice(0, 200)`; 100 tasks retained (`src/tasks/task-store.ts`)                                     | `objective` — trimmed, never length-checked; `steps[]` has no cap in the model       |
| `workspace`   | members deduplicated by `origin` (`src/workspaces/workspace-model.ts`)                                                                                                                                                 | `members[]` — one entry per distinct origin ever seen, and nothing evicts one        |
| `shortcut`    | 100 shortcuts, name ≤ 48, display name ≤ 120 (`src/shortcuts/`)                                                                                                                                                        | none                                                                                 |
| `connection`  | fixed field set, no collections (`src/providers/accounts/account-model.ts`)                                                                                                                                            | none                                                                                 |
| `preferences` | fixed field set (`src/config/settings.ts`)                                                                                                                                                                             | none                                                                                 |

Three further facts decide the shape of the answer.

**`steps[]` is bounded in practice even though the model does not bound it.**
`AgentRuntime` carries `task.usage` across a resume and resets only
`elapsedMs`, so the tool-call and model-request budgets survive pause, worker
eviction and restart. The reachable ceiling for one task is therefore roughly
60 + 40 steps plus retry and error steps — about 112 — not an unbounded log.
`plan[]` and `tabs[]` are declared on `AgentTask` and never written by any
code path, so they contribute nothing.

**No synced record carries page content or a provider response body.** What
page-derived text does reach a record is already small and already capped: a
model-message step's summary is `text.slice(0, 200)`; an element binding's
`role` and `name` are `PAGE_DERIVED` and refused above 200 characters; a
page-derived value can only be stored as a workflow literal when the task was
tainted and the value is ≤ 24 characters (`SHORT_VALUE`, `parameteriser.ts`) —
anything longer becomes an input slot; a workspace member carries an origin and
a tab title. Evidence is referenced by id and is not a record type at all, and
audit content is `LOCAL_ONLY` (§27). There is no path by which a page, a
prompt, a full model response or a screenshot becomes a sync record, so this
limit is not a page-size problem wearing a protocol hat.

**The unbounded fields are unbounded in the type, not in ordinary use.** Every
one of them is a user-authored or model-proposed string, or a list of distinct
origins. None of them is a stream.

#### Measured sizes

Serialized from the models above; each row names the shape it measures. Wire
bytes are the encoded sync payload per §6 and K1 §9, computed with the formula
below.

| Record                                             | Plaintext JSON | Wire bytes  | Wire        |
| -------------------------------------------------- | -------------- | ----------- | ----------- |
| `preferences`, at its maximum                      | 341 B          | 1 125 B     | 1.1 KiB     |
| `shortcut`, at its maximum                         | 459 B          | 1 283 B     | 1.3 KiB     |
| `connection`, at its maximum                       | 1 145 B        | 2 197 B     | 2.1 KiB     |
| tombstone marker body                              | 70 B           | 764 B       | 0.7 KiB     |
| `workspace`, 12 members                            | 3 969 B        | 5 963 B     | 5.8 KiB     |
| `workflow`, 24 steps, 4 arguments, 64 B literals   | 23 973 B       | 32 635 B    | 31.9 KiB    |
| `task`, 40 steps                                   | 24 374 B       | 33 169 B    | 32.4 KiB    |
| `workspace`, 200 distinct origins                  | 62 731 B       | 84 312 B    | 82.3 KiB    |
| `task`, budget ceiling: 112 steps, bounded fields  | 74 534 B       | 100 049 B   | 97.7 KiB    |
| `workflow` ceiling, 24 × 6 element bindings at cap | 88 550 B       | 118 737 B   | 116.0 KiB   |
| `workflow` ceiling, 24 × 8 element bindings at cap | 114 688 B      | 153 588 B   | 150.0 KiB   |
| `workflow`, 24 steps, 16 arguments, 4 KiB literals | 1 315 474 B    | 1 754 636 B | 1 713.5 KiB |
| `workspace`, 2 000 distinct origins                | 629 031 B      | 839 379 B   | 819.7 KiB   |

The last two rows are the unbounded fields exercised, not records anyone has
produced. Everything reachable through the repository's own caps sits between
1 KiB and 150 KiB.

#### Overhead, exactly

```
ct_b64     = ceil((plaintextBytes + 16) * 4 / 3)   // GCM tag, then base64url
envelope   = 265 B   // K1 §9 header with kdSalt(16), wrap.nonce(12),
                     //   wrap.dek(32+16), nonce(12), all base64url
syncRow    = 384 B   // §6 plaintext fields at realistic widths
wireBytes  = ct_b64 + 649
```

The expansion is deterministic: **wire size is a function of plaintext size
alone**. That is what makes the check possible before any key is touched.

| Wire limit | Usable plaintext |
| ---------- | ---------------- |
| 64 KiB     | 47.5 KiB         |
| 128 KiB    | 95.5 KiB         |
| 256 KiB    | 191.5 KiB        |
| 512 KiB    | 383.5 KiB        |

#### The three options, compared

Stated as costs, not as a ranking.

| Dimension                 | A — single record, hard maximum                                                        | B — chunked across rows                                                                                 | C — hybrid: single by default, chunk above a threshold                         |
| ------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Schema                    | §6 unchanged                                                                           | adds a chunk index, a chunk count and a manifest row; `sync_record` gains a composite identity          | both, plus a discriminator                                                     |
| Client complexity         | one size check                                                                         | split, reassemble, verify completeness, handle a missing chunk                                          | both paths, and the transition between them                                    |
| Integrity                 | one AEAD tag covers the whole body                                                     | per-chunk tags leave chunk **ordering and completeness** outside AEAD unless a manifest digest is added | as B above the threshold                                                       |
| K1 implications           | none — K1 §9/§10 apply unchanged                                                       | AAD must gain a chunk index and a total, or chunks are interchangeable; that is a K1 change             | a K1 change, conditionally applied                                             |
| Push and retries          | per-record transaction as today (§12)                                                  | a partial-write failure mode: some chunks accepted, some not; a record that is neither old nor new      | the partial-write mode exists, reached less often — which makes it less tested |
| Idempotency               | `(deviceId, deviceSeq)` per record                                                     | per chunk, plus a rule for a repeated partial set                                                       | both                                                                           |
| Revisions and conflicts   | `baseRevision` per record; §8 unchanged                                                | a revision spans rows, so the conditional write becomes multi-row and §8 needs a chunk-set comparison   | §8 gains a case                                                                |
| Pull and pagination       | a page is a set of records (§25)                                                       | a page can split a record, so `hasMore` no longer means what §25 says it means                          | as B when a chunked record is in the page                                      |
| Deletion and tombstones   | one tombstone                                                                          | a tombstone must retire every chunk, and a missed chunk is an orphan the purge quorum never covers      | as B                                                                           |
| Storage overhead          | ~649 B per record                                                                      | ~649 B per **chunk**, plus the manifest                                                                 | between the two                                                                |
| What the user experiences | a record above the limit does not sync, and the user is told                           | records of any size sync                                                                                | as B, above the threshold                                                      |
| Migration                 | can become B or C later behind `schemaVersion`; a v1 client refuses an unknown version | cannot become A without a re-upload                                                                     | carries both futures and both present costs                                    |

#### Why A, for v1

The repository does not contain a record type that legitimately exceeds a
sensible limit. Every reachable ceiling measures at or under 150 KiB on the wire, and
the two rows that exceed it are produced only by fields that have no cap for
reasons unrelated to sync — a `literal` binding is size-checked for shape and
depth but not bytes, and a workspace remembers every distinct origin forever.
Those are worth bounding on their own merits; they are not evidence that sync
needs a chunking protocol.

Chunking would buy the ability to sync a record nobody has produced, and would
pay for it with a partial-write failure mode, a K1 AAD change, a multi-row
conditional write, an orphan-chunk case the purge quorum does not cover, and a
pagination rule that no longer means what §25 says. Introducing all of that for
hypothetical data is the wrong trade, and it is reversible: A migrates to B or
C behind `schemaVersion`, and B does not migrate back.

#### The size policy

The **number is TUNABLE**; the **invariant is not**.

> **The size check is on the encoded sync payload, and it happens before the
> record is encrypted and again before the backend accepts it.**
>
> ```
> wireBytes(record) = ceil((plaintextBytes + 16) * 4 / 3) + envelopeBytes + rowBytes
> wireBytes(record) ≤ MAX_SYNC_RECORD_BYTES
> ```

Checking the plaintext alone would be wrong by a third plus the header, and
that is exactly the margin in which a record passes locally and is refused
remotely.

`MAX_SYNC_RECORD_BYTES` is left TUNABLE because the production value also
depends on a backend row and request limit that does not exist yet. Two
constraints bind whatever is chosen:

- **Floor.** It must exceed every record reachable through the repository's own
  caps. The largest measured is 150.0 KiB (a 24-step workflow with eight
  element bindings per step, all at the 200-character cap). A limit below that
  would refuse a record the extension is entitled to produce.
- **Ceiling.** It must sit below the backend's maximum row and request size and
  below §25's maximum response bytes, or a record that pushes cannot be pulled
  back — the worst possible failure, because it is invisible until a second
  device tries to read it.

The client's copy of the limit is served by the manifest (§13) so the two
cannot drift, and the client enforces the **smaller** of its compiled-in value
and the served one. A served value is a constraint, never a permission: it can
lower the limit, never raise it past the compiled-in maximum, because a hostile
backend raising it is a way to make a client build a request it would otherwise
refuse.

#### What happens at the limit

The client check runs at enqueue, before encryption and before a `deviceSeq` is
assigned. An oversized record therefore never enters the sync queue, never
consumes a sequence number, and never produces a request.

| Rule                                       | Behaviour                                                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| never partially uploaded                   | the record is refused whole; §12's per-record transaction means no other record in the batch is affected                            |
| never truncated, and no field dropped      | there is no path that shortens a record to make it fit — a shortened record would be a different record, silently                   |
| never falls back to plaintext              | refusal is the only outcome; see the security rules below                                                                           |
| the local record is untouched              | it is still readable, editable, replayable and deletable exactly as before; nothing about it is a sync artefact                     |
| the user is told, deterministically        | the record is shown as **not syncing — too large**, with its size and the limit, in the same surface that shows sync state          |
| the queue is not blocked                   | every other record continues to sync                                                                                                |
| the state clears by itself                 | the next change that brings the record under the limit makes it eligible again; nothing has to be re-enabled                        |
| a backend 413 is terminal for that attempt | the record leaves the queue, is marked the same way, and is not retried on a backoff — the size will not change by waiting          |
| deletion still works                       | a tombstone encrypts a fixed marker and measures 0.7 KiB, so an oversized record is always deletable, and the deletion always syncs |

A record that synced before and has since grown past the limit is the same
state, with one consequence worth naming: the cloud keeps the last accepted
revision, and it is now stale. The local record is authoritative, the divergence
is visible, and when the record next becomes pushable the outcome is an ordinary
`baseRevision` mismatch resolved by §8 — the same path a long-offline device
takes. Nothing new is invented for it, and the stale cloud copy never overwrites
the local one.

#### Security

Oversize is a refusal, and a refusal must not become a bypass.

| Must not happen                                      | Why it cannot                                                                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| falling back to plaintext cloud storage              | there is no plaintext upload path in the protocol to fall back to; SYNC-1 asserts it and the size check adds no new path      |
| falling back to an alternate or unencrypted endpoint | §15 is the complete endpoint set; an oversized record produces no request at all                                              |
| spilling into provider storage                       | a provider request is a model call on the egress path; it is not a storage path, and no record type is reachable from it      |
| using browser runtime storage as a cloud substitute  | `chrome.storage` is local; that is where the record already is, and staying there is the defined behaviour, not a workaround  |
| bypassing the storage preference                     | the size check runs after the preference check, so `undecided` still uploads zero bytes (SYNC-12) whatever a record's size is |
| bypassing encryption                                 | the check is on the **predicted** wire size of an encrypted record; there is no unencrypted branch to take                    |
| bypassing provider-secret or page-content isolation  | size changes nothing about what a record may contain; SYNC-2 and SYNC-1 are unaffected                                        |
| a hostile backend enlarging what a client will build | the served limit can only lower the compiled-in one (above)                                                                   |
| an oversized record becoming an availability attack  | per-record transactions; one refusal never stalls another record or the watermark                                             |

#### Migration path, if a real record ever needs it

In order, and each step is independently useful:

1. **Bound the three unbounded fields at their source** — a byte cap on a
   `literal` binding value, a length cap on `objective`, and an eviction or cap
   on `workspace.members[]`. This is where the growth actually is, and capping
   it removes the need for anything else. It is a repository change, out of
   scope for this document.
2. **Raise `MAX_SYNC_RECORD_BYTES`**, if the backend's row limit allows. The
   manifest serves it, so no client change is required.
3. **Only then, chunking**, introduced as `schemaVersion + 1` for the affected
   record type. A v1 client refuses an unknown `schemaVersion` and retains the
   record (SYNC-17), so an old client never half-reads a chunked one. K1's AAD
   would gain a chunk index and a chunk total in the same step — without them
   chunks are interchangeable, which is the failure the per-chunk tag does not
   catch.

Nothing in the v1 wire format forecloses step 3, and no data written under v1
needs re-uploading to reach it.

**Q2 — Per-account storage quota and its behaviour at the limit.** Unbounded
encrypted storage has a real cost, and a quota needs an error contract: whether
a push over quota is refused, whether the oldest terminal tasks are shed, and
what the user is told. Shedding data automatically is the kind of behaviour this
document declines to invent.

Everything else is settled. The device retirement window `D` (§10), page sizes
(§25), retry backoff (§24), idempotency retention (§14) and the deletion replay
window (§29) are marked **TUNABLE**: they are parameters for implementation
review, and the protocol is correct for any value meeting the stated constraint.
