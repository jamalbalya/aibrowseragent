# Local-First Architecture

Status: **implemented.** This document describes what the repository does, not
what it intends to do. Every claim below is backed by a named test, and the
tests are the authority where the two disagree.

This document is the **top of the storage and infrastructure chain**. Where it
conflicts with an earlier document on where data lives or what is required to
run the product, this one governs and the earlier one is marked superseded in
§11 below.

---

## 1. The local-first principle

AI Browser Agent is a Chrome extension. A person installs it, connects an AI
provider, and uses it. That is the whole path, and nothing in it is allowed to
require anything else.

```
Install extension → Open it → Connect an AI provider → Use the browser agent
```

Concretely, a fresh installation:

- stores everything in `chrome.storage.local` and `chrome.storage.session`;
- uploads nothing;
- needs no AI Browser Agent account;
- needs no backend to be reachable;
- needs no database of any kind.

**Local is the default and the primary model, not a fallback.** The runtime
storage mode of a fresh install is `local`, and `DEFAULT_STORAGE_MODE` is the
one place that is decided.

> Evidence: `tests/security/local-first.test.ts` 01, 02;
> `tests/e2e/local-first.spec.ts` "a fresh installation is in local mode".

### There is no "undecided" runtime state

Earlier builds defaulted the storage preference to `undecided` and prompted the
user to resolve it. That behaved correctly — `undecided` uploaded nothing — but
it presented local-first as an unanswered question rather than as the product.

`undecided` is now a **legacy persisted value only**. Records containing it
still exist in real profiles, so the parser still reads them; `resolveStorageMode`
maps them to `local`. Two properties hold:

- Every input that is not an explicit, well-formed `cloud` resolves to `local` —
  including a corrupt record, an absent one, a value from a future build, and
  the legacy `undecided`.
- A record that resolved _away_ from what it stored does not keep its
  `chosenAt` timestamp. The user did not choose the mode now in force, and
  saying they did would misreport consent.

> Evidence: `tests/security/local-first.test.ts` 06, 07, 17.

---

## 2. Zero user-managed infrastructure

Neither an end user nor the project owner is ever required to install,
configure, run, repair, back up or monitor any of the following:

| Not required        | Why it is not required                                                     |
| ------------------- | -------------------------------------------------------------------------- |
| PostgreSQL          | No driver is installed; nothing at build or test time opens a connection   |
| Docker / containers | No compose file, no Dockerfile, no container in any script                 |
| A local server      | The extension has no localhost dependency and no default backend origin    |
| Manual SQL          | The only SQL in the repository is generated DDL for an optional deployment |
| Manual migrations   | Local schema migration runs inside the extension, automatically            |
| Database backups    | There is no database to back up; the user's copy is an export file         |
| A VPS               | Nothing the extension does requires a host                                 |

The developer path is equally free of it:

```
GitHub → code → npm ci → tests → build
```

`npm ci && npm test && npm run build` requires no service to be running.

> Evidence: `tests/security/local-first.test.ts` 12 (no database or container
> dependency in `package.json`), 14 (no compose file or Dockerfile exists),
> 15 (no test opens a connection or shells out to Docker).

---

## 3. Chrome storage architecture

Two areas, with two different lifetimes, chosen per data kind:

| Area                     | Lifetime                                | Holds                                                                                                         |
| ------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `chrome.storage.local`   | Survives restart and worker eviction    | Tasks, workflows, shortcuts, workspaces, settings, connection metadata, provider credentials, audit, evidence |
| `chrome.storage.session` | Memory; cleared when the browser closes | Access tokens, OAuth transients, Chrome runtime handles (tab group ids)                                       |

Everything durable goes through the `StorageArea` interface, and each store
gets its own `NamespacedStorageArea`, so one store cannot read or overwrite
another's keys by construction.

### Records are independent, not one blob

Tasks already worked this way. Workflows, shortcuts and workspaces did not:
each kept every record inside a single value. That had two costs, and both
were real rather than theoretical:

- **Blast radius.** One unparseable byte in a value holding fifty workflows
  lost fifty workflows.
- **Write cost.** Saving one shortcut rewrote every shortcut.

All four now use the same layout, with the format version in the key:

```
workflows:v1:index    → { ids: [...] }         ids only, newest first
workflows:v1:wf_abc   → { v: 1, record }       one record
shortcuts:v1:sc_abc   → { v: 1, record }
workspace:v1:ws_abc   → { v: 1, record }
task:<id>             → the task record        (pre-existing layout, unchanged)
settings / app-settings → one record by nature
```

The index holds **ids only**. A record is written before the index moves, so
an interruption between the two leaves an orphaned record — invisible and
harmless — rather than an index entry pointing at nothing.

> Evidence: `tests/unit/local-record-migration.test.ts` (13 cases);
> `tests/integration/local-store-upgrade.test.ts` (9 cases).

---

## 4. Data classification

`src/storage/data-classification.ts` is the single table, and it is total by
construction: `Record<PersistedDataKind, DataClass>` means a new data kind does
not compile until it has been classified.

| Class               | Kinds                                                                      | Leaves the device?        |
| ------------------- | -------------------------------------------------------------------------- | ------------------------- |
| `SECRET_LOCAL_ONLY` | provider credential, connector token, ABA refresh token                    | **Never**, under any mode |
| `NEVER_PERSISTED`   | access token, OAuth transient, page content                                | Never stored, so never    |
| `CLOUD_SYNCED`      | identity profile                                                           | Only in cloud mode        |
| `USER_SELECTABLE`   | connection metadata, AI brain, task, workflow, shortcut, preference, audit | Only in cloud mode        |
| `LOCAL_ONLY`        | evidence, persistence health, policy, device id                            | Never                     |

`cloudEligible(kind, mode)` is the only place the question is answered, and
every branch that is not an explicit yes is a no.

There is deliberately **no data kind for a model response or a prompt.**
Neither is persisted, so there is nothing for any future sync path to pick up.
Adding one would require classifying it, which is where it would be noticed.

> Evidence: `tests/security/local-first.test.ts` 02–05;
> `tests/security/data-classification.test.ts`.

---

## 5. The provider credential boundary

Provider API keys are `SECRET_LOCAL_ONLY` and **permanently so**. They:

- are stored per connection, at `conn:<connectionId>`, never shared between
  accounts;
- are never sent to the AI Browser Agent backend;
- are never eligible for Cloud Sync, in either storage mode;
- never appear in logs, telemetry, analytics, audit exports or cloud records;
- are **excluded from local export by design**, not by omission.

The reason is scope of loss. The backend holding every user's provider keys
would make one breach of it a breach of every key every user owns, for
services the user pays for separately. Nothing about adding sync changes that
arithmetic.

**A provider connection needs no AI Browser Agent account.** The API-key path
is complete on its own: connect a key, pick a model, use the agent. Signing in
is neither a prerequisite nor a trigger for anything about the provider.

Multiple connections remain supported, each with its own credential, its own
capability measurement and its own label.

### Which store is authoritative

**`AccountStore` is authoritative.** A connected AI account is an entry there,
with its credential at `credentials:conn:<connectionId>`, and
`resolveProvider` reads the brain from it before anything else. That is the
only record a task can run against.

`settings.provider-connection` is **not a second source of truth.** It is the
single-slot record from before accounts existed, and it now exists in two
roles and no others:

| Role                                                                            | Written by                                           | Read by                                                                    |
| ------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| A **projection** of the brain account, carrying the `connectionId` it came from | the account routes, through `projectBrainToSettings` | the panel — the header status line and the composer's readiness gate       |
| A genuine **pre-account** record, with no `connectionId`                        | builds before accounts existed                       | the one-time migration, which turns it into an account and then deletes it |

The `connectionId` is what tells them apart, and it is structural rather than
a flag: only a projection has one. The migration skips a record that carries
one — see **Legacy records** below for why that is not merely tidiness.

`resolveProvider` still falls back to the pre-account path when there is no
brain, which is what keeps an installation working that has not migrated.

### The defect this replaced

This was not a tidiness question. The shipped Settings form connected through
`accounts.connect` and then ran the capability check and the model selection
through the _provider_ routes, which wrote the other record. Connecting an
account therefore left the brain unset, `resolveProvider` fell through to the
pre-account path, and it looked there for a credential at
`apiKey:<providerId>` that `accounts.connect` had never written.

The result, measured in a real browser: connect an AI account in Settings, see
the capability check report `AGENT_READY`, start a task, and get
**`AUTH_REQUIRED — Enter the endpoint base URL`**. The account was connected,
its key was on disk, and nothing would use it. The only way through was to
open Connected Accounts and select the account by hand.

Three things fixed it, and none of them added a store:

1. **The first account becomes the one in use.** `accounts.connect` takes the
   brain when there is no brain — and only then, so connecting a second
   account never moves the user off the one they chose. The migration already
   did exactly this for the account it carried forward.
2. **The panel record is projected from the brain**, on every write that can
   change which account is in use: connect, select, capability check,
   disconnect, associate. `activeProviderId` and `activeModelId` move with it,
   so the pair the export carries names the account actually in use.
3. **Settings drives the account it created.** The capability check runs
   through `accounts.runDoctor`, which stamps the measurement onto the account
   with the `(connectionId, modelId)` pair it was taken on — the only form
   `resolveProvider` will honour. The provider-id route stored it where the
   panel could read "ready" from a measurement the runtime was ignoring.

The form's own **Disconnect** button is gone. It called `provider.disconnect`,
which clears the pre-account slot and the `apiKey:<providerId>` credential,
and reported "Disconnected and removed the stored key" while the account's
real key, stored under its connection id, stayed exactly where it was.
Connected Accounts removes the account and its credential together, which is
the only place that can honestly claim to.

The `provider.*` routes are **kept, not deleted**: they serve the pre-account
fallback and the provider-conformance suites. What changed is that no shipped
UI writes through them.

> Evidence: `tests/security/local-first.test.ts` 03;
> `tests/security/multi-account-isolation.test.ts`;
> `tests/security/local-export.test.ts` 01–03 and 05;
> `tests/security/legacy-migration.test.ts` 13;
> `tests/e2e/provider-connection.spec.ts` (11 cases, real Chromium);
> `tests/e2e/local-first.spec.ts` "the export carries the user's work and no credential".

---

## 6. Optional authentication

Google sign-in exists, and it is **optional in the strong sense**: the code
path that offers it is absent when no backend origin is compiled in, and every
local feature works regardless.

```
loadIdentityConfig()  →  null when VITE_ABA_BACKEND_ORIGIN is unset
                      →  AuthController receives google: null
                      →  status reports { configured: false }
                      →  the panel offers no sign-in
```

There is **no default backend origin**. A build with none has no
authentication, and the panel says so rather than failing a request to
nowhere.

### What signing in is, and is not

Signing in identifies an **AI Browser Agent account**. It does not
authenticate, authorise, connect or alter OpenAI, Anthropic, Gemini or any
other AI provider. Those stay exactly where they were, each with its own
credential. The account panel says this in words, because it is the confusion
the whole separation exists to prevent.

The governing invariant, unchanged from `IDENTITY_AND_SYNC.md`:

```
authentication session ≠ ABA user account ≠ AI connections
                       ≠ provider credentials ≠ user work
```

> Evidence: `tests/e2e/auth-google.spec.ts`;
> `tests/e2e/local-first.spec.ts` "a fresh installation…" (asserts
> `configured: false` and a working extension in the same test).

---

## 7. The optional backend

```
Chrome Extension
      │
      ├── LOCAL functionality ──────────────► chrome.storage.  No backend.
      │     tasks · workflows · shortcuts · workspaces · settings
      │     provider connections · provider credentials · browser automation
      │
      └── OPTIONAL identity ────────────────► backend, when one is deployed
            ABA account · Google sign-in · (future) email sign-in
            (future) Cloud Sync · (future) cross-device restore
```

`server/` is **kept**, because it is what optional authentication needs. The
dependency is one-directional and enforced:

- No file under `src/` imports anything under `server/`, by `@server/` alias or
  by relative climb. A test reads the source tree and fails if one does.
- `dist/` contains no server symbol.
- `server/` imports nothing from `src/`.

`server/` is not bundled, not shipped, and not required to build or test the
extension.

### There is no duplicate persistence implementation

`server/` persists accounts, identities, sessions and devices. The extension
persists tasks, workflows, shortcuts, workspaces, settings and credentials.
The two sets do not overlap, and no record type is written by both.

> Evidence: `tests/security/local-first.test.ts` 11, 13;
> `tests/security/release-claims.test.ts`.

---

## 8. Optional Cloud Sync

**Cloud Sync is not implemented.** `CLOUD_SYNC_PROTOCOL.md` and
`K1_E2EE_DESIGN.md` are designs; there is no sync client, no sync endpoint, no
encryption code and no upload path in this repository.

Saying so plainly matters more than the feature would: a product that claimed
sync it did not have would be telling users their data was somewhere it is not.

When it is built, these hold and are not negotiable:

1. It is **opt-in**. Nothing uploads while the mode is `local`.
2. **Signing in does not enable it.** Authentication and storage location are
   separate decisions, and `choose('cloud', …)` is the only thing that changes
   the mode.
3. Provider credentials and page content stay out of it, whatever the mode.
4. K1 remains the security boundary: the backend holds ciphertext and no key.

Choosing `cloud` today records consent for a path that does not yet exist. It
uploads nothing, because there is nothing to upload through.

> Evidence: `tests/security/local-first.test.ts` 02, 06;
> `tests/security/release-claims.test.ts`.

---

## 9. Local recovery: export and import

Local storage means the data belongs to one Chrome profile. That is the right
default and it has an honest cost: **deleting the profile deletes the data.**

Export is what makes that cost avoidable _if the user acts before the loss_.
It is not a backup service and is not described as one. Nothing automatic
creates an export, and no export is ever uploaded.

**An export contains:** workflows, shortcuts, connection metadata (connection
id, provider id, display name, model id, base URL — five fields, no more) and
the **portable** settings.

**Portable settings are an allowlist, not a filter.** `PORTABLE_SETTING_KEYS`
names the five that travel: `logLevel`, `debugMode`, `notificationsEnabled`,
`activeProviderId`, `activeModelId`. `AppSettings` also holds `permissionMode`
and `allowInsecureOrigins`, and those are this installation's **security
posture** rather than a preference. They stay out for two reasons, and the
second is the one that matters:

- carrying them is pointless, because an import does not apply settings;
- and a portable file that _contains_ a security posture is a policy-injection
  vector waiting for whoever wires settings import next. An attacker-supplied
  archive that could flip `allowInsecureOrigins` to true would be granting
  itself a capability. There is no such field in the file, so there is nothing
  to flip.

An allowlist rather than a denylist because the failure directions are not
symmetric: a setting added and forgotten is excluded by default, where a
denylist would export it. It is applied **in both directions** — building a
document and parsing one — so the set of keys that can exist in a file is the
same whoever wrote it.

**An export deliberately excludes:** every provider API key, every OAuth
secret, every connector credential, every ABA token, the account label that
carries a key suffix, and **the local installation identity**. The document
says so in itself, in a `notice` field, because a file outlives the screen
that produced it.

**The local identity is never exported.** An archive that carried one would be
an archive that could claim to _be_ another installation rather than bring
records to this one. There is no `installationId`, no `abaUserId` and no
device-derived identifier anywhere in the format, and an archive that asserts
one is ignored: nothing in the import path reads an owner field. Device B
keeps the identity it minted.

**An import is untrusted input.** It is the same trust class as any downloaded
file, because that is what it might be. So:

- The document is validated structurally, and refused with a reason it is not.
- A **newer format version is refused**, not best-effort parsed.
- It is **bounded before it is walked**: at most `MAX_RECORDS_PER_SECTION`
  (1000) records per section and `MAX_SETTING_KEYS` (100) settings keys, and
  the credential scan is depth-limited to 12. The bound comes first because
  the scan and the apply loop are both driven by these lengths, so a refusal
  after either would not be worth anything.
- A document carrying a credential-shaped field is **refused outright, never
  cleaned** — such a file was not produced by this exporter or was edited
  afterwards, and importing the acceptable-looking remainder is the wrong
  answer.
- Every record is applied **through the store that owns it**. `WorkflowStore.save`
  re-validates the definition, recomputes the canonical hash and re-derives the
  risk; `ShortcutStore.create` re-runs name normalisation and both collision
  checks. An import cannot install a workflow the recorder would have refused,
  cannot claim a hash it did not earn, and cannot take a name that already
  means something.
- An imported recording carries `taintAtCapture: 'UNKNOWN'`, because no
  measurement on this device supports any stronger claim.
- Connections are **counted, not written**: a connection without its key would
  fail at its first request while looking ready, so the panel reports how many
  keys to re-enter instead.

### What is portable, and what is not

The question "may this travel in a file?" is now a table in code rather than a
list in the exporter: `EXPORT_PORTABILITY` in `storage/data-classification.ts`,
total over every persisted kind, with `EXPORTABLE_KINDS` **derived** from it.
The exporter no longer keeps its own list that merely happened to agree.

It is deliberately a **second** table rather than a reuse of `cloudEligible`.
They answer different questions and would each be wrong as the other: cloud
eligibility asks whether a server the user trusts may hold something,
portability asks whether a file the user may email or restore onto a machine
that is not theirs may contain it. `audit` is the clearest case — syncable in
principle, and not portable, because a hash chain re-anchored on another
device would verify while describing decisions that device never made.

| Kind                                                                                                                 | Portability                          | Why                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `workflow`, `shortcut`                                                                                               | **PORTABLE**                         | the user's own work, re-validated by the owning store on import                                                          |
| `connection-metadata`                                                                                                | **PORTABLE_AFTER_TRANSFORMATION**    | five fields saying what you connected to; never how you authenticate                                                     |
| `preference`                                                                                                         | **PORTABLE_AFTER_TRANSFORMATION**    | the portable allowlist only; security posture stays behind                                                               |
| `provider-credential`, `connector-token`, `aba-refresh-token`, `aba-access-token`, `oauth-transient`, `page-content` | **NOT_PORTABLE_BY_DESIGN**           | secrets, and no transformation makes a key in a mailed file acceptable                                                   |
| `evidence`                                                                                                           | **NOT_PORTABLE_BY_DESIGN**           | payload plus an HMAC digest under a per-task salt: the digest alone proves nothing, the salt is private key material     |
| `policy`                                                                                                             | **NOT_PORTABLE_BY_DESIGN**           | a site rule is consent; an imported one is an archive granting itself permission to automate a site                      |
| `persistence-health`                                                                                                 | **NOT_PORTABLE_BY_DESIGN**           | it **gates execution**, so a `HEALTHY` record from elsewhere would be an archive clearing this device's safety interlock |
| `identity-profile`, `device-id`                                                                                      | **LOCAL_ONLY**                       | exporting either is how two installations come to claim one owner                                                        |
| `ai-brain`                                                                                                           | **LOCAL_ONLY**                       | names a `connectionId` whose credential deliberately does not travel                                                     |
| `skill-run`                                                                                                          | **LOCAL_ONLY**                       | progress through a run on a worker generation that no longer exists                                                      |
| `audit`                                                                                                              | **LOCAL_ONLY**                       | has its own scoped export route; the chain is anchored to this installation                                              |
| `task`                                                                                                               | **REQUIRES_FURTHER_SECURITY_DESIGN** | see below                                                                                                                |
| `workspace`                                                                                                          | **REQUIRES_FURTHER_SECURITY_DESIGN** | see below                                                                                                                |

**Tasks and workspaces are deferred, not forgotten.** A task carries
page-derived tab context, a monotone taint state, a per-task HMAC salt and
evidence ids: exporting one puts browsing content in a portable file, and
importing one asks an installation to accept a taint state it never measured
and evidence ids that resolve to nothing — a taint downgrade dressed as a
restore. A workspace's members are tab origins and titles, which is browsing
history, and `workspaceId` is the boundary tasks are bound to, so an imported
one names a Chrome tab group that does not exist. Neither is unsolvable.
Neither has been solved, and the classification is what distinguishes that
from nobody having got round to it.

**Skills are not in the table at all**, because nothing persists them: the
registry is rebuilt at every worker start from the definitions shipped in the
build, and is hash-verified there. A restore reconstructs them by running the
same build. Skill _runs_ are persisted and classified above.

Reclassifying a kind as portable is a review gate rather than a one-word edit:
`data-export` asserts at module load that every portable kind has a section of
the document to write into, so marking `task` portable fails the build until
somebody has decided what a task looks like in a file.

Two persisted kinds — `workspace` and `skill-run` — were **missing from the
classification table entirely** until this audit went looking for them. The
table is total over `PersistedDataKind`, which is what made adding a _kind_
safe; nothing forced a new _store_ to declare one.

> Evidence: `tests/security/export-portability.test.ts` (8 cases).

### Imported data is data

An import moves records. It does not move standing. Nothing in the file
becomes authorization, authentication, policy configuration, route trust, a
permission, a provider or connector credential, a consent, or egress
authorization:

| What a file might assert                 | What happens                                                  |
| ---------------------------------------- | ------------------------------------------------------------- |
| A workflow id, version or hash           | Discarded; the store mints and recomputes its own             |
| `taintAtCapture: KNOWN_UNTAINTED`        | Discarded; an imported recording is `UNKNOWN`                 |
| `risk`                                   | Discarded; re-derived from the tools the steps actually reach |
| `permissionMode`, `allowInsecureOrigins` | Cannot survive parsing; outside the portable allowlist        |
| An owner, device or account id           | Never read; the installation keeps its own identity           |
| A credential-shaped field                | The whole document is refused                                 |

`data.export` and `data.import` are both `CLASS_B_PANEL_CONTROL_PLANE`, so
neither is reachable by a model, and neither touches the network: an export is
built in the worker from local storage and an import is read from a file the
user chose.

### Legacy records

The one-time migration turns a pre-account `settings.provider-connection` plus
its `apiKey:<providerId>` credential into an account, in an order chosen so
that no interruption can delete a credential it has not first proved it can
read back. It records a marker when it finishes — including on a fresh install
with nothing to migrate — so it runs once and never again.

It is fire-and-forget at worker start, which is what makes the projection
guard load-bearing rather than defensive. A panel that connects an account
while migration is still running writes a projection into the very record
migration is about to read. Without the guard, migration would mint a _second_
account for a connection that already has one, look for a credential at
`apiKey:<providerId>` that a projection never has, conclude the connection has
no usable key, and **clear the settings slot** — leaving a panel showing
nothing connected while the account and its key sat untouched a namespace
away.

Nothing is silently deleted, merged, or adopted into another identity: a
migrated account is carried forward **unowned** and claimed only by an
explicit click in Connected Accounts, because `bindAccountToUser` permits no
second move.

No new migration was needed for this phase. The correction changes which
routes write the settings record, not what is stored in it, and a projection
is re-derived from the account store on the next write rather than converted.

> Evidence: `tests/security/legacy-migration.test.ts` (13 cases, 13 being the
> projection guard with its negative control).

### Atomicity: the exact guarantee

**An import is not a transaction, and is not described as one.** Each record
is written through its own store, one at a time. Chrome's storage layer offers
no cross-record transaction, so an import interrupted partway — the worker
killed, the disk full — leaves the records written so far in place and the
rest absent. Nothing is rolled back.

What _is_ guaranteed:

- **Per record, all or nothing.** A record is written by the store that owns
  it, through the same versioned-record path as any other write. A partially
  written record is not a state the stores can be left in.
- **Every record is accounted for.** `ImportOutcome` counts
  `workflowsImported`, `workflowsRefused`, `shortcutsImported`,
  `shortcutsRefused`, `connectionsNeedingKeys` and `failed`. Nothing is
  dropped silently, and an unexpected throw counts as `failed`, never as an
  acceptance.
- **A refusal and a failure are different answers.** `REFUSED` is the store's
  judgement — a workflow naming a tool this build does not have, a shortcut
  whose name collides. The record is the problem, and the user can act on it.
  `FAILED` is everything else: the write did not complete and the record may
  have been perfectly good. The two used to be one number, and the conflation
  was a real defect — a full disk produced "2 could not be restored", which
  reads as _your data was rejected_ when what happened is _this device
  failed_.
- **A failure reaches persistence health.** `failed > 0` reports
  `('storage', 'DEGRADED', 'import writes did not complete')`. `storage` is a
  gating domain, so a disk that failed partway through an import stops work
  until somebody has looked at it, rather than leaving a half-restored
  installation running.
- **Re-importing is safe.** Records the stores already hold are refused by
  name rather than merged or auto-renamed, so running the same file twice
  does not silently produce duplicates.

> Evidence: `tests/security/local-export.test.ts` (23 cases);
> `tests/e2e/export-import.spec.ts` (14 cases, real Chromium: shape, key
> absence, identity absence, posture, foreign-owner import, malformed,
> version, credential, bounds, double import, re-validation, round trip,
> worker termination, no network);
> `tests/e2e/local-first.spec.ts` (export, credential refusal, unrelated file).

---

## 10. Backend failure behaviour

| The backend is       | Local functionality | Local data |
| -------------------- | ------------------- | ---------- |
| never deployed       | works               | intact     |
| unreachable          | works               | intact     |
| returning errors     | works               | intact     |
| deployed and healthy | works identically   | intact     |

A backend outage does not delete local data, does not invalidate tasks,
workflows or workspaces, and does not prevent using a connected local AI
provider. There is no code path in which backend unavailability reaches a
local store.

The reason this is structural rather than careful is §7: no local store has a
reference to anything that talks to the backend.

> Evidence: `tests/security/local-first.test.ts` 08, 09, 10 — tasks,
> workspaces and shortcuts exercised with nothing configured at all.

---

## 11. PostgreSQL: optional managed backend infrastructure only

**Classification: OPTIONAL MANAGED BACKEND INFRASTRUCTURE.**

PostgreSQL is relevant in exactly one situation: somebody deploying the
optional identity backend. It is irrelevant to every other reader of this
repository — end users, and the project owner during development.

Every remaining occurrence in the repository, classified:

| Location                                   | Classification                                                    |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `server/db/sql.ts`                         | Optional backend infrastructure — renders DDL text                |
| `server/migrations/*.sql`                  | Optional backend infrastructure — generated text                  |
| `server/config.ts` (`ABA_DATABASE_URL`)    | Optional backend infrastructure — read only when the backend runs |
| `server/db/memory-store.ts` (comment)      | Documentation                                                     |
| `server/README.md`                         | Documentation                                                     |
| `.env.example`                             | Documentation — names only, every value empty                     |
| `tests/unit/server-config-logging.test.ts` | Test-only — a fake URL, asserted **not** to be logged             |
| `docs/spec/…`                              | Documentation / history                                           |

**None must be removed**, and none imposes a requirement: there is no
PostgreSQL driver in `package.json`, `MemoryStore` is the only implementation
of the `Store` port, and no test or build step opens a connection.

The deployment intent is a **managed** database — a hosted service that applies
migrations on deploy. The project owner maintains source code, not databases.

Explicitly **not present and not to be added**: a docker-compose PostgreSQL
service, a local PostgreSQL setup script, database startup scripts, manually
operated backup scripts, database repair instructions, or database
administration instructions.

> Evidence: `tests/security/local-first.test.ts` 12, 13, 14, 15.

---

## 12. Local schema migration

Migrations run **inside the extension**, automatically, on the first read after
an update. A user never runs SQL, a migration command, a setup command, a
script or a terminal command — there is no terminal in which they could.

The ordering is chosen so every interruption point leaves the data intact:

1. Read the old generation.
2. Migrate each record **individually** and validate the result.
3. Write the new records and the new index.
4. **Read one back and verify it.**
5. Only then remove the old generation.

Interrupted before 5, the old generation is still there and the next start
migrates again; ids are preserved, so the repeat is a no-op rather than a
duplicate. Interrupted after 5, the new generation is complete.

### What failure does

Nothing deletes data it could not read.

| Situation                       | Outcome                                                         |
| ------------------------------- | --------------------------------------------------------------- |
| Old version present             | Migrated silently; user does nothing                            |
| Record from a **newer** version | Hidden, left on disk — a downgrade cannot know what it means    |
| Malformed record                | Dropped from the read, left on disk, counted                    |
| Partial corruption              | Only the corrupt entries are lost                               |
| A migration step throws         | That record is quarantined; the others still migrate            |
| The whole upgrade throws        | Old generation untouched; the store reads empty for the session |
| Records under other keys        | Never read, written or removed                                  |

Every failure is reported to `PersistenceHealthStore`, so a degradation
outlives the service worker that noticed it.

> Evidence: `tests/unit/local-record-migration.test.ts` 01–13;
> `tests/integration/local-store-upgrade.test.ts` 01–09.

---

## 13. Security boundaries

This change is a storage and infrastructure simplification. It weakens none of
the following, and each is still enforced by its existing suite:

| Boundary                               | State                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Route trust (six classes, total table) | Unchanged. `data.export` and `data.import` are `CLASS_B_PANEL_CONTROL_PLANE`, unreachable by a model |
| Workspace boundary                     | Unchanged. A legacy task without `workspaceId` is still refused browser operations                   |
| Task isolation                         | Unchanged                                                                                            |
| Egress authorization                   | Unchanged. `authorizeEgress` was not modified                                                        |
| Consent                                | Unchanged                                                                                            |
| Taint tracking                         | Unchanged. An imported workflow carries `UNKNOWN`, which is the conservative value                   |
| Provider pinning                       | Unchanged                                                                                            |
| Credential isolation                   | Unchanged, and extended: credentials are excluded from export and refused on import                  |
| `ToolRegistry`                         | Unchanged. No new tool was added; export and import are panel routes                                 |
| Audit                                  | Unchanged                                                                                            |
| K1 boundaries                          | Unchanged. No K1 code exists to change                                                               |
| Network primitives                     | Still exactly three holders. The storage layer has none, and a test asserts it                       |

### Two boundaries this change strengthened

**The skill-definition validator no longer crashes on malformed input.** A
binding that was not a binding used to fall through every branch and reach
`validatePath(undefined)`, which threw a `TypeError` instead of returning a
problem. A validator that crashes on bad input is a validator that cannot
refuse it. It now refuses. This matters here because `data.import` feeds
untrusted definitions into exactly that path.

> Evidence: `tests/unit/skill-model.test.ts`, "a definition whose bindings are
> not bindings".

**Local persistence introduces no network primitive.** Asserted over every
file in `src/storage/`: a store that could reach the network is a store that
could upload, whatever the mode says.

> Evidence: `tests/security/local-first.test.ts` 16;
> `tests/security/security-invariants.test.ts`.

---

## Superseded decisions

Recorded rather than erased. Each earlier decision was correct when made; what
changed is stated, with the reason.

| Document                                    | Decision                                                           | Status                                                                                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IDENTITY_AND_SYNC.md` §storage preference  | Default storage mode is `undecided`, with a prompt to resolve it   | **Superseded by §1.** The default is `local`. `undecided` remains readable as a legacy value and resolves to `local`. The behaviour is identical — both upload nothing — but local-first is the product rather than an unanswered question |
| `IDENTITY_AND_SYNC.md` status line          | "No backend code exists, no authentication flow runs"              | **Superseded.** `server/` exists and Google sign-in is implemented. Still true: no backend is deployed, and no data is uploaded anywhere                                                                                                   |
| `IDENTITY_AUTH_ARCHITECTURE.md` status line | "Design only. Nothing here is implemented"                         | **Superseded.** The identity/auth domain and Google sign-in are implemented                                                                                                                                                                |
| `server/README.md`                          | "`login_challenge` deliberately absent"; "Google OAuth … excluded" | **Superseded.** Both arrived with Google sign-in                                                                                                                                                                                           |
| Workflow / shortcut / workspace storage     | One value per record type                                          | **Superseded by §3.** Independent versioned records, upgraded automatically                                                                                                                                                                |

Unchanged and still authoritative: the K1 cryptographic design, the Cloud Sync
protocol design, the account-linking policy, the refresh-token digest decision,
and the data classification table.
