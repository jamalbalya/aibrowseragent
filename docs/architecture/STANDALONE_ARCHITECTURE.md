# Standalone Architecture — the zero-infrastructure requirement

Status: **authoritative product requirement.** It supersedes any statement in
another document that assumes a backend the product author operates.

> The product is a standalone Chrome extension. After a user installs it from
> the Chrome Web Store it must work without contacting, registering with, or
> being provisioned by the author. The author must not be required to run a
> server, a database, an email service, authentication infrastructure or
> monitoring, and must not pay per-user infrastructure costs.
>
> The GitHub repository is development and release infrastructure. It is not a
> runtime dependency.

```
Chrome  →  AI Browser Agent  →  works locally, alone
                            ↘
                              the user's own AI provider account
```

There is no `user → author's backend → AI provider` path, and none may be
added. A connection the user chooses to their **own** infrastructure is
permitted and is always optional.

---

## 1. The finding: the extension is already standalone

This was audited against the built artefact rather than the source, because
what ships is what matters. **Every URL literal in `dist/`:**

| Endpoint                                                     | Classification                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `https://api.openai.com/v1`                                  | AI PROVIDER (user's account)                                                                                        |
| `https://api.anthropic.com`                                  | AI PROVIDER (user's account)                                                                                        |
| `https://generativelanguage.googleapis.com/v1beta`           | AI PROVIDER (user's account)                                                                                        |
| `https://api.github.com`, `https://github.com/login/oauth/*` | USER-OWNED OPTIONAL — the GitHub connector, against the user's own account                                          |
| `http://127.0.0.1/*`, `http://localhost/*`                   | DEVELOPMENT ONLY — dropped from the release build by `RELEASE_BUILD=1`                                              |
| `http://*/*`, `https://*/*`                                  | CHROME PLATFORM — content-script match patterns                                                                     |
| `www.w3.org/*`, `json-schema.org/*`, `react.dev/errors/`     | CHROME PLATFORM / inert constants — XML namespaces, schema `$id` strings and a library's error URL. None is fetched |

**JAMAL-OWNED: none. UNKNOWN: none.**

Three further facts, each checked rather than assumed:

- **No backend origin is compiled in.** The origin is a build-time constant
  read from `VITE_ABA_BACKEND_ORIGIN`. The shipped bundle inlines the
  environment as the literal `{}`, so `loadIdentityConfig()` can only return
  `null` and no identity request can be constructed at all. The variable is set
  in exactly one place in the repository — `scripts/build-auth-fixture.mjs`,
  which builds `dist-auth/` for one end-to-end spec and is git-ignored.
- **No server code is in the bundle.** `dist/` contains no `MemoryStore`, no
  schema and no route table.
- **The install handler makes no network call.** It configures the side panel
  and returns.

**Executed evidence:** 24 of the 25 real-Chromium specs load `dist/` with no
backend of any kind and pass — 228 of 254 tests. The single exception is the
Google-protocol spec, which builds its own configured bundle against a local
fixture. The extension running standalone is not a claim; it is the condition
under which almost the whole browser suite already runs.

## 2. What the pivot costs

Very little, because the backend was never wired into the product.

`server/` (23 files, 4,801 lines) is a self-contained identity service that
`src/` has never imported — a boundary already asserted by a test. `src/identity/`
(7 files, 1,207 lines) is the client half, inert without a configured origin.

**K1 encryption and Cloud Sync are documents, not code.** There is no crypto
module, no key hierarchy, no sync client and no upload path anywhere in `src/`.
Nothing has to be removed to stop uploading, because nothing uploads.

The side panel already says the right thing when unconfigured:

> "Signing in is not available in this build. Your connected AI accounts and
> everything you have made keep working without it."

## 3. Classification

| Component                                                                      | Disposition                              | Why                                                                                                                            |
| ------------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Browser workspace, tasks, workflows, shortcuts, skills, audit, evidence, files | **KEEP**                                 | `chrome.storage`-backed, no network                                                                                            |
| Provider connections and credentials                                           | **KEEP**                                 | user-owned, `SECRET_LOCAL_ONLY`, direct to the provider                                                                        |
| Local-First record store, migrations, export/import                            | **KEEP**                                 | the storage model the pivot makes central                                                                                      |
| Route trust, egress gate, consent, taint, destination policy, pinning          | **KEEP**                                 | none depends on a server; see §5                                                                                               |
| Connector framework + GitHub connector                                         | **KEEP — user-owned optional**           | already the template for every future user-owned connection                                                                    |
| `server/`                                                                      | **DEFER, do not delete**                 | reusable if a user ever self-hosts; deleting it now discards a reviewed design and proves nothing the import boundary does not |
| `src/identity/` Google sign-in + session client                                | **DEFER**                                | inert today; the transport, PKCE and state/nonce handling are reusable                                                         |
| Email OTP (design only)                                                        | **DEFER**                                | no code exists; the decisions it produced outlive it — see §6                                                                  |
| `login_challenge` email fields, Argon2id plan                                  | **DEFER**                                | unbuilt; the schema anticipates them without depending on them                                                                 |
| Cloud Sync (design only)                                                       | **REPLACE** with user-owned destinations | the protocol's shape survives; the assumption of one product-run server does not                                               |
| K1 (design only)                                                               | **KEEP the design, REPLACE its premise** | end-to-end encryption matters _more_ when the destination is a user's own storage                                              |
| ABA server-side account, sessions, devices, linking                            | **REPLACE**                              | see §4                                                                                                                         |

## 4. Identity without a server

The product does not need a central account to operate locally. Local data
ownership needs a **scope**, not an authenticated identity — and a scope can be
minted on the device.

| Need                          | Standalone answer                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| local operation               | none. The extension works with no identity at all                                       |
| local data ownership          | an **installation profile** minted locally: an opaque id, no address, no credential     |
| encryption                    | a locally generated key, and (when K1 lands) a recovery key the user holds              |
| workspace ownership           | live Chrome state, which already authorises nothing from a server                       |
| provider connection ownership | the installation profile; credentials never leave the device                            |
| export/import                 | a file the user controls                                                                |
| optional multi-device         | proof of control of the **destination** the user chose — not an account with the author |

`IdentityProfileStore` already holds a local profile and already refuses a
different user's id. What must go is the assumption that its `abaUserId` comes
from a server: it becomes a locally minted installation id, and the sign-in
that produced it becomes optional.

**No forced Google login. No forced email login. No fabricated local email
account.**

## 4a. The installation identity — IMPLEMENTED

`src/identity/local-identity.ts`. A `loc_` prefix and 128 bits of
`crypto.getRandomValues`, minted on first run, read back before it is
believed, and stored in `chrome.storage.local`.

**It replaces a placeholder, not a login.** Every workspace, connected
provider account and active brain is stored against an owner id, and the only
source of one was a sign-in — so with no backend deployed, every installation
ran under the shared literal `unassigned`. The account model refuses to bind
anything to that value by name, so a standalone user could never take
ownership of what they connected. Now they own it from first run.

| Property             | How                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| locally generated    | `crypto.getRandomValues`, 16 bytes, no arguments                                                                 |
| opaque               | a prefix and hex; no field to carry anything about a person                                                      |
| derived from nothing | not hardware, not a Chrome runtime handle, not an address                                                        |
| survives restart     | `chrome.storage.local`, re-read on every worker start                                                            |
| created offline      | no network call exists on the path                                                                               |
| never regenerated    | a valid record is returned untouched                                                                             |
| fails closed         | a malformed record is refused, never replaced; a write that does not survive read-back is reported, not believed |

**What it is not** — and each of these is asserted rather than promised:
authentication, authorization, an encryption key, a recovery key, a provider
credential, a human identity, a Google or email identity. It authorises
nothing because no authorization path takes an owner id as an input: route
trust is the sender classifier, task isolation the task record, the workspace
boundary live Chrome state, egress the destination policy, consent the consent
store, taint the taint state. It is a filter over local rows, applied _after_
those checks rather than instead of them.

**Reinstall.** Storage survives → the identity survives. Chrome deletes the
extension's storage → it is gone, and a fresh install mints a new one. There
is no hidden copy and no server holding a spare. Carrying data across an
uninstall is what export and import are for.

**Not exported.** The export allowlist is four kinds derived from the
classification table, and an installation label is not one of them — excluded
by construction rather than by a filter somebody has to remember. It is
installation-specific on purpose: transferring it would leave two
installations claiming to be one owner.

**Not shown.** No route carries it and no surface renders it. A person sees
"your data is stored on this device", never an id.

**Conflict fails closed.** A profile id and an installation id that disagree —
reachable if an installation ran standalone and later signed in — resolve to
neither. Preferring the profile would hide every standalone row behind an
owner that never wrote them; preferring the local id would ignore an
authentication that did happen. Adopting one into the other is a migration
with its own consent questions, so it is left to a person.

## 5. Security under the pivot

Every control in the extension is enforced **on the device**, by the service
worker, against Chrome's live state. None consults a server, so none weakens:

route trust and sender classification, task isolation, workspace boundary,
provider pinning, credential isolation, egress authorization, destination
policy, consent, taint tracking, evidence, the audit trail, persistence health,
browser action authorization, workflow and shortcut security, upload/download
safety, and the real-Chromium coverage that exercises them.

**Nothing depended on server authentication**, and that is checkable rather
than asserted: `src/` imports nothing from `server/`, the account panel is the
only surface that reads authentication state, and no tool, dispatch path or
`ToolRegistry` entry reaches the identity transport.

The one control that _would_ be needed for a user-owned destination does not
exist yet and must be built with it: proving the destination is the one the
user named, and refusing to send anything anywhere else.

## 6. What survives from the cancelled work

The Email OTP and Google-auth phases produced decisions that are about
**identity semantics**, not about who runs a server, and they survive intact:

- an address is not an authenticator where a subject exists (`AUTH-29`);
- a uniqueness key belongs on an authenticator, never on metadata (`AUTH-30`);
- the canonical email form — domain folds, local part does not;
- proof of control is established only by completing a flow (`AUTH-27`);
- identities are never merged and never moved (`AUTH-22`, `AUTH-23`);
- an OTP must be delivered to the canonical address, never the typed one.

Each applies unchanged to a user-owned destination that authenticates.

## 7. Blockers

**None to standalone operation.** The Chrome Web Store requirement — usable
after install with no contact with the author, no provisioning, no registration,
no server configuration and no dependency on the repository — is met by the
current build.

What remains is **presentation and scope**, not capability: the sign-in surface
should offer local operation as the default rather than describing itself as
unavailable, and the documents that still frame a product backend as the
direction need correcting.
