# Backend — optional identity and authentication service

The domain for the AI Browser Agent backend: accounts, authentication
identities, sessions, devices and the Google sign-in flow, plus the schema
they persist to.

**Not deployed. Not reachable. Nothing here serves a request.**

## This directory is optional, and so is everything it needs

The Chrome extension does not import anything from here, is not built with it,
and does not need it to run. A user with no account and no reachable backend
gets the whole product: tasks, workflows, shortcuts, workspaces, browser
automation and their own AI provider, all stored locally.

What this directory adds is one optional capability — an **AI Browser Agent
account** — and the only thing that currently uses it is Google sign-in, which
is itself absent from any build with no configured backend origin.

**PostgreSQL is this directory's deployment target, not the project's
requirement.** No driver is installed, `MemoryStore` is the only implementation
of the `Store` port, and nothing in `npm ci && npm test && npm run build` opens
a connection. See `docs/architecture/LOCAL_FIRST_ARCHITECTURE.md` §11.

## What this is

| Implemented                                                       | Where                        |
| ----------------------------------------------------------------- | ---------------------------- |
| The schema, declared once as data                                 | `db/schema.ts`               |
| The migration DDL, generated from it                              | `migrations/`                |
| A persistence port                                                | `db/store.ts`                |
| An in-memory adapter that enforces every declared constraint      | `db/memory-store.ts`         |
| Accounts, and the deletion state                                  | `app/account-service.ts`     |
| Identity resolution, linking and unlinking                        | `app/identity-service.ts`    |
| Session families: creation, rotation, reuse detection, revocation | `app/session-service.ts`     |
| Device registration, retirement and reactivation                  | `app/device-service.ts`      |
| The ownership primitive every operation goes through              | `domain/authorization.ts`    |
| Environment-injected configuration with no secret defaults        | `config.ts`                  |
| Allowlist logging                                                 | `logging.ts`                 |
| Google sign-in: start, callback, exchange                         | `app/google-auth-service.ts` |
| The HTTP surface: four routes and nothing else                    | `http/router.ts`             |
| Access-token signing, which the domain leaves to the transport    | `app/access-token.ts`        |
| ID-token verification against Google's published keys             | `domain/oidc.ts`             |
| PKCE (S256 only)                                                  | `app/pkce.ts`                |

## What this is not

Deliberately absent, because each belongs to a later phase and shipping a
half-built version of any of them would be worse than shipping none:

- **Email OTP.** The external flow would produce a `VerifiedIdentity`, which
  this layer already consumes — the same seam Google sign-in arrived through.
  (**Google OAuth and `login_challenge` are no longer absent**: both arrived
  with the Google sign-in phase, and this list said otherwise until then.)
- **Cloud Sync.** `sync_record`, `push_idempotency` and the device
  acknowledgement watermark are specified in `CLOUD_SYNC_PROTOCOL.md` and
  belong to the sync phase.
- **K1 crypto.** The backend holds no key and no ciphertext. There is no
  column in this schema capable of carrying either.
- **A database driver.** The schema renders to PostgreSQL DDL and the port is
  asynchronous, so wiring a driver is deployment work. Installing one now
  would add a dependency nothing exercises — and would make a database a
  requirement for building and testing an extension that does not use one.
  The deployment intent is a **managed** database that applies migrations on
  deploy: the project owner maintains source code, not database servers.

## The HTTP surface

Four routes, no framework, and a handler that is a pure
`(Request) => Promise<Response>` over the platform's own types — so a test
drives it without opening a socket, and no dependency was added.

| Route                      | Method | What it does                                                         |
| -------------------------- | ------ | -------------------------------------------------------------------- |
| `/v1/auth/start`           | POST   | Mints the challenge; returns an id and an authorization URL          |
| `/v1/auth/google/redirect` | GET    | **Registered with Google.** Verifies and mints the exchange artifact |
| `/v1/auth/google/callback` | GET    | A static landing page. The extension watches this URL                |
| `/v1/auth/exchange`        | POST   | Trades the artifact for a session                                    |

**The redirect path and the callback path are deliberately different.** The
extension's tab watcher fires on the first URL matching the path it watches;
if Google redirected straight there, the watcher would capture Google's own
authorization code before the backend had done anything, and whether it did
would depend on Chrome's redirect timing. Two paths remove the race rather
than tuning it.

**No Google verification logic is in the router.** It reads query parameters
and a JSON body, calls the service, and maps a `Result` to a status. It never
sees an ID token, never compares an issuer and never touches a JWKS — and a
test asserts it holds no network primitive of its own.

Every refusal on a route answers with one status and one body, whatever was
wrong. An attacker who can tell "unknown state" from "spent challenge" from
"that Google account belongs to somebody else" learns what to try next.

## The session lifecycle

`/v1/auth/refresh` and `/v1/auth/logout` are **served**. They complete the life
of the session sign-in produces, and they take different credentials because
they answer different questions:

| Route                   | Credential                           | Why that one                                                                                                                                                       |
| ----------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/auth/refresh` | the refresh token, in the body       | An access token proves nothing about a rotation chain. The token is the credential, and the route has no parameter for an account, a subject, an email or a device |
| `POST /v1/auth/logout`  | the access token, in `Authorization` | It names the session it was minted for, so the session being ended is never a value the client chose. §19 of the architecture lists logout under the access token  |

Neither restates a security decision. Refresh hands the token to
`SessionService.rotateSession`, where the atomic claim, reuse detection, family
revocation, expiry and the deleted-account check already live. Logout resolves
a `Principal` and calls `revokeSession`, which revokes that session and deletes
nothing.

**Logout's authentication is not stateless.** The access token's signature and
expiry are checked, and then the `sid` is resolved through `sessions.verify`,
which re-reads the session _and_ the account. A revoked session, an expired one
and a deleted account are refused there, live, however valid the signature is —
which matters because logout is precisely an operation on a session's liveness.

### Still deferred

`GET /v1/me` and `GET /v1/devices` are **not built**. Neither is needed by
refresh or logout, so neither was added: `listDevices`, `getAccount` and
`listIdentities` exist and are tested, and nothing reaches them yet.

## How the pieces constrain each other

```
        db/schema.ts                    ← the single source of truth
             │
     ┌───────┴────────┐
     ▼                ▼
  db/sql.ts      db/memory-store.ts
     │                │
     ▼                ▼
 migrations/    constraints enforced in tests
     │
     └── a test compares the render against the file, byte for byte
```

A schema change that does not reach the migration fails the build. A
constraint declared in the descriptor is enforced by the in-memory adapter
without anybody writing a check for it. That is why a test written against
`MemoryStore` is testing the real rules: both halves are generated from one
declaration.

## Running it

There is nothing to run. The suites exercise it:

```
npx vitest run tests/unit/server-schema.test.ts
npx vitest run tests/unit/server-account-identity.test.ts
npx vitest run tests/unit/server-session.test.ts
npx vitest run tests/unit/server-device.test.ts
npx vitest run tests/unit/server-config-logging.test.ts
npx vitest run tests/integration/server-identity-lifecycle.test.ts
npx vitest run tests/security/server-auth-invariants.test.ts
npx vitest run tests/security/server-adversarial.test.ts
```

## Configuration

`config.ts` reads an environment record and refuses to start when a required
variable is missing. No secret has a default. `.env.example` lists the names
with empty values; `.env` and `.env.*` are gitignored.

## Authority

`docs/architecture/IDENTITY_AUTH_ARCHITECTURE.md` governs this code, with
`K1_E2EE_DESIGN.md`, `CLOUD_SYNC_PROTOCOL.md` and `IDENTITY_AND_SYNC.md`
alongside it. `LOCAL_FIRST_ARCHITECTURE.md` governs all of them on the
question of what is required to run the product, and classifies PostgreSQL as
optional managed backend infrastructure. Where this implementation differs from a document in a way that
matters, the difference is recorded rather than absorbed — see the comment at
the top of `app/token.ts` for the one such case.
