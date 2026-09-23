# K1 — Local Encryption

**Status: implemented, opt-in, off by default.**

K1 encrypts the credentials this extension stores on disk, behind a passphrase
the user chooses and this code never keeps. It is not sync, not a backup, not
an account, and not a service. Nobody operates anything it depends on.

---

## 1. Threat model

### What K1 actually protects against

**Somebody who can read the browser profile directory.** `chrome.storage.local`
is a LevelDB directory inside the Chrome profile, in plaintext. A stolen or
shared laptop, a synced or copied profile, a disk image, a filesystem backup,
another program running as the same user — all of these read it. That is the
threat, and it is the only one K1 addresses.

Against that reader, K1 provides:

- **At-rest confidentiality** for the protected set. The stored records are
  AES-GCM ciphertext, and the key is not in the profile.
- **Integrity and authenticity** for those records. A record edited in the
  profile fails authentication rather than decrypting to something else, and a
  record copied from one storage key to another fails too, because the key
  name is authenticated alongside the content.

### What K1 does **not** protect against, stated plainly

- **Anything running inside the extension while it is unlocked.** The worker
  holds the unwrapped key while unlocked, because it has to in order to use
  the credentials. A compromised extension is outside this boundary.
- **Anybody with the passphrase.** There is no second factor.
- **A person at an unlocked machine.** Unlocked means unlocked. Switching
  protection off requires the passphrase, so that person cannot _remove_ the
  protection, but they can use the browser while it is on.
- **Memory disclosure.** The key and the decrypted credentials are JavaScript
  values in the worker. JavaScript cannot reliably zero memory, and this
  document does not claim it does.
- **Rollback of a record to an earlier valid ciphertext.** An older envelope
  for the same key under the same data key is authentic and decrypts.
  Detecting that needs a monotonic counter somewhere the attacker cannot also
  roll back, and an extension has nowhere like that — the counter would live in
  the same profile directory. **Not solved.**
- **Traffic analysis of what exists.** Record _names_ are not encrypted, so a
  reader of the profile can see that two AI accounts are connected and which
  providers they are. The credentials are what is hidden; the shape is not.
- **Anything Chrome's own extension isolation does not already prevent.** K1
  adds nothing to the boundary between this extension and a web page, or
  between this extension and another one.

### Availability and recovery

**There is no recovery.** The passphrase is not stored, not escrowed, and not
derivable. If it is forgotten, the protected records are gone; the user
disconnects those AI accounts and enters keys from their provider again.
Everything else — workflows, shortcuts, workspaces, settings, history — is
untouched, because none of it is encrypted.

There is no AI Browser Agent service that could reset it. Building one would
put the thing the passphrase protects into somebody else's hands, which is the
arrangement K1 exists to avoid.

### Why a passphrase is not a design preference

It is a consequence of where an extension can put a key, established by
looking:

| Place                    | On disk?                        | Survives browser restart? |
| ------------------------ | ------------------------------- | ------------------------- |
| `chrome.storage.local`   | **yes**, in the profile         | yes                       |
| `chrome.storage.session` | no — held in memory             | **no**                    |
| OS keychain              | not reachable from an extension | —                         |

A key in `chrome.storage.local` sits beside the ciphertext, so it protects
against nothing. A key in `chrome.storage.session` cannot persist. There is no
third option. The only key material not sitting next to the data is material
the user supplies — which is also why K1 cannot be switched on for somebody
silently: without a passphrase there would be nothing to claim.

---

## 2. What is encrypted, and what is not

`K1_PROTECTION` in `storage/data-classification.ts`, total over every persisted
kind — a third table beside cloud eligibility and portability, because "may a
server hold this", "may a file carry this" and "is this encrypted on this disk"
are three different questions.

| Kind                                                                                        | Class               | Why                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider-credential`                                                                       | **ENCRYPTED**       | paid for, reaches services this extension has nothing to do with, may not be re-issuable                                                                               |
| `aba-refresh-token`                                                                         | **ENCRYPTED**       | durable and long-lived; the only other credential that reaches disk                                                                                                    |
| `connector-token`, `aba-access-token`, `oauth-transient`, `page-content`                    | MEMORY_ONLY         | never written to disk, which is better than encrypting it                                                                                                              |
| `identity-profile`, `device-id`                                                             | PLAINTEXT_BY_DESIGN | the panel must render the unlock screen before anything is unlocked; the unlock cannot depend on itself                                                                |
| `persistence-health`                                                                        | PLAINTEXT_BY_DESIGN | it gates execution; unreadable-while-locked would fail closed on every locked start                                                                                    |
| `policy`                                                                                    | PLAINTEXT_BY_DESIGN | consulted on paths unrelated to credentials                                                                                                                            |
| `connection-metadata`, `ai-brain`                                                           | PLAINTEXT_BY_DESIGN | what you connected to, never how you authenticate — and what the panel shows while locked, so it can say _which_ account needs unlocking                               |
| `task`, `workflow`, `shortcut`, `workspace`, `preference`, `audit`, `evidence`, `skill-run` | PLAINTEXT_BY_DESIGN | the user's own work; disclosure is bounded by the profile that already holds it, and protecting it would mean a passphrase prompt before the panel could list anything |

**Not everything is encrypted, deliberately.** A protected store is unreadable
until the passphrase is typed — once per browser session. Protecting the whole
extension would put a passphrase prompt in front of the side panel itself,
which is how a security feature gets switched off and left off.

One entry in the first draft of this table was wrong in a way worth recording:
`connector-token` was marked ENCRYPTED, which would have been a claim the
implementation does not make. Connector tokens are not in a protected
namespace because they are not in a durable one.

---

## 3. Key architecture

```
passphrase --PBKDF2-SHA256--> KEK --AES-GCM--> (wrapped) DEK --AES-GCM--> records
             600k iters,                        256 random bits
             16-byte salt
```

- **DEK** — 256 bits from `crypto.getRandomValues`. Every protected record is
  encrypted under it. **Not derived from the passphrase**, so changing the
  passphrase re-wraps one small record instead of re-encrypting everything.
- **KEK** — derived from the passphrase, non-extractable, used only to wrap
  the DEK.
- **No separate verifier.** The wrapped DEK _is_ the verifier: unwrapping
  authenticates or it does not. A passphrase hash would be one more thing an
  offline attacker could test against.

**PBKDF2 is what Web Crypto implements.** Argon2id or scrypt would be better
against a GPU attacker and neither is available in the extension runtime.
Shipping a JavaScript Argon2 would mean depending on a memory-hard primitive
nobody here can audit. The honest answer is the standard primitive at OWASP's
2023 floor for PBKDF2-HMAC-SHA-256 — 600,000 iterations — with the limitation
written down rather than hidden. It is paid once per unlock, not per record.

**Never derived from:** the installation identity, any provider or account id,
anything about the device, browser or profile. Every one of those lives on the
same disk as the ciphertext, so deriving from them would be the same
non-protection with more steps — and the installation identity is ownership
metadata, which becoming key material would quietly turn into a credential.
Asserted against the sources, not just stated.

---

## 4. Key lifecycle

| State            | Meaning                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `OFF`            | K1 was never switched on. Records are plaintext; nothing is claimed.                                      |
| `UNLOCKED`       | The data key is held in `chrome.storage.session`. Records read and write normally.                        |
| `LOCKED`         | The wrapped key is on disk, the unwrapped one is not. Protected reads and writes **fail**.                |
| `NEEDS_RECOVERY` | K1 is enabled and the key metadata is missing or unreadable. The records cannot be decrypted by anything. |

**`NEEDS_RECOVERY` is the state this design exists to name.** A missing key
must never look like first-time setup: generating a fresh key there would
produce an installation that reports success and silently cannot read a single
existing record. So the enabled flag and the key metadata are **separate**
records — one says what the user chose, the other is what makes it work — and
`initialize` refuses outright while the flag is set.

**Where the unwrapped key lives, and why.** `chrome.storage.session`: held in
memory, never written to disk, access level already restricted to trusted
contexts. An in-memory variable in the worker would be the obvious choice and
is the wrong one under MV3 — the worker is evicted every few minutes, so the
user would be asked for the passphrase on a cadence that would make them turn
the feature off. Session storage survives eviction and does not survive a
browser restart, which is the behaviour a lock should have.

| Event                             | Effect                                                                |
| --------------------------------- | --------------------------------------------------------------------- |
| Worker evicted and restarted      | stays **unlocked** — the key is in session storage, not in the worker |
| Panel closed and reopened         | no effect                                                             |
| Extension reloaded                | session storage is cleared → **locked**                               |
| Browser restarted                 | **locked**                                                            |
| Malformed or missing key metadata | **NEEDS_RECOVERY**, never OFF                                         |
| Failed passphrase change          | old wrapping intact; nothing was re-encrypted                         |
| Uninstall / reinstall             | storage is gone, so K1 is gone with the data it protected             |

**What "locked" means, by store.** Only the protected set is affected. Tasks,
workspaces, workflows, shortcuts, settings, audit and the account _list_ all
read and write normally while locked. What cannot happen is running a task,
because that needs a provider credential, and the refusal is a refusal rather
than a silent "no provider configured". Export and import are unaffected.

---

## 5. Storage envelope

```json
{ "v": 1, "alg": "AES-GCM-256", "kid": "k<16 hex>", "iv": "<base64, 12 bytes>", "ct": "<base64>" }
```

No personal data, no identity, no key material. `kid` is an opaque generation
label so a rotation can tell an envelope it can still read from one it cannot.

**The authenticated data is `k1|<version>|<kid>|<label>/<key>`** — the storage
location as well as the key id. AES-GCM catches tampering on its own; what it
does not catch is a ciphertext being _moved_. Copying the envelope stored under
one connection's key over another's would otherwise pass every check, because
the bytes are genuinely ones this installation wrote. Binding the location
makes that a decryption failure.

| Condition                                  | Behaviour                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Not an envelope                            | treated as a pre-K1 plaintext record, and converted by migration                                              |
| Newer `v`                                  | `UNSUPPORTED_VERSION` — refused, not partly read                                                              |
| Unknown `alg`                              | `UNSUPPORTED_ALGORITHM`                                                                                       |
| Missing field, bad base64, wrong IV length | `MALFORMED`                                                                                                   |
| Tampered ciphertext, IV or `kid`           | `AUTHENTICATION_FAILED`                                                                                       |
| Wrong key                                  | `AUTHENTICATION_FAILED` — deliberately the same answer as tampering, because distinguishing them is an oracle |
| Envelope moved to another key              | `AUTHENTICATION_FAILED`                                                                                       |
| Locked                                     | the read **throws**; it never returns `undefined`                                                             |

**A locked or unreadable record is never reported as absent.** "You have no API
key" invites the user to reconnect, which overwrites the key they still have;
"I cannot read it" invites them to unlock. That distinction is the single most
important behaviour in this layer.

---

## 6. Migration

Switching protection on encrypts existing plaintext **in place** — the
ciphertext is written under the key the plaintext was at — so there is no
moment where the plaintext has been removed and the ciphertext has not landed.
Each record is written, then read back and compared, before it counts.

Restart-safe by construction rather than by a marker: each record is examined
on its own, a plaintext value is encrypted and an envelope is left alone. A run
interrupted after three of five converts the remaining two next time, and
re-running when everything is already encrypted does nothing.

**A damaged envelope is never treated as legacy plaintext.** Sealing an
unreadable envelope inside a second envelope would make it permanently
unreadable and report success. The shape check that distinguishes them is
strict: a value that looks _almost_ like an envelope is damaged, not legacy.

**Switching off** decrypts everything first and refuses as a whole if anything
will not open — half a store decrypted, with the key about to be deleted, is
worse than either end state. It also requires the passphrase, so protection
cannot be removed by somebody who has the machine but not the passphrase.

---

## 7. Provider credentials

Already `SECRET_LOCAL_ONLY` and already in their own namespace, so K1 wrapped
that namespace rather than inventing a second secret mechanism. The credential
store does not know whether it is writing ciphertext: protection is a decorator
over its storage area, which keeps the decision about _what_ is protected in
one place instead of spread through every store that holds something sensitive.

- **Metadata versus secret.** What you connected to — provider, model, base
  URL, display name — stays plaintext, so the panel can list your accounts
  while locked and tell you which one needs unlocking. How you authenticate is
  the encrypted half.
- **While locked**, a provider connection cannot be used and the task refuses.
- **After reinstall**, storage is gone, so the keys are gone; the user
  reconnects. That was already true before K1.
- **No leakage path was added.** The credential still reaches nothing but the
  provider's own endpoint, and K1 adds no log line, diagnostic, audit field,
  error message or export field containing key material — the error messages
  name a _failure kind_, never the passphrase or the key.

---

## 8. Local identity

Unchanged, and deliberately untouched. It stays plaintext ownership metadata,
it is not wrapped, no encryption metadata references it, and corrupting it
affects nothing about decryption — the encrypted records are partitioned by
storage key, not by identity.

**No key material is derived from a `loc_` identifier**, and that is asserted
against the sources rather than promised: a test reads the four crypto modules
and fails if any of them so much as mentions the identity store, `navigator`,
or a user-agent string.

---

## 9. Export and import

**Option A: the export format is unchanged.** It remains a plaintext portable
archive with secrets excluded — the established contract, and K1 does not
silently alter it. An export taken on a protected installation is
byte-compatible with one taken on an unprotected one, because the things K1
protects were never in it.

An encrypted export is a **separate future capability**, not part of K1.
Nothing in the current architecture requires K1 to provide it: the export
carries no credentials, no identity, no brain, no security posture and no
taint, so there is nothing in it that encryption would be protecting.

**Import cannot touch the encryption state.** The K1 records are not in the
export format, the import path does not write them, and an archive asserting
`k1` fields changes nothing — held by a browser test that imports exactly such
an archive and checks the state is where it was.

---

## 10. Security boundaries

K1 adds no authorization path. Route trust is unchanged: the five K1 routes are
`CLASS_B_PANEL_CONTROL_PLANE`, unreachable by a model, because a model that
could unlock could read the credentials it is not allowed to read.

**Nothing becomes trusted by having decrypted.** A decrypted record is the same
record it was before K1 — authenticated ciphertext proves it was not altered on
disk, and proves nothing about what it says. Taint, consent, policy, pinning,
the workspace boundary and persistence health all read exactly what they read
before, and none of them takes the encryption state as an input.

---

## 11. MV3 and performance

- The unwrapped key is in session storage, so a worker eviction does not force
  a re-prompt and does not require the worker to stay alive.
- 600,000 PBKDF2 iterations run once per unlock, not per record, and not at
  worker startup: nothing about K1 blocks the worker coming up. A locked
  installation starts normally and refuses the reads that need a key.
- No decrypted plaintext is cached. Each read decrypts, which is a few
  microseconds of AES-GCM over a short string, and avoids a cache that would
  outlive the lock.
- **JavaScript cannot reliably zero memory.** The key and the decrypted values
  are ordinary values subject to garbage collection at a time nothing here
  controls. This document does not claim otherwise.
