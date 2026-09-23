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
- **An HTTP transport.** The approved architecture keeps controller boundaries
  separate from domain logic; this phase implements the domain. A routing
  layer with no endpoint behind it is not a foundation, it is scaffolding.
- **A database driver.** The schema renders to PostgreSQL DDL and the port is
  asynchronous, so wiring a driver is deployment work. Installing one now
  would add a dependency nothing exercises — and would make a database a
  requirement for building and testing an extension that does not use one.
  The deployment intent is a **managed** database that applies migrations on
  deploy: the project owner maintains source code, not database servers.

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
