# Backend — identity and authentication foundation

The domain foundation for the AI Browser Agent backend: accounts,
authentication identities, sessions and devices, plus the schema they persist
to.

**Not deployed. Not reachable. Nothing here serves a request.**

## What this is

| Implemented                                                       | Where                     |
| ----------------------------------------------------------------- | ------------------------- |
| The schema, declared once as data                                 | `db/schema.ts`            |
| The migration DDL, generated from it                              | `migrations/`             |
| A persistence port                                                | `db/store.ts`             |
| An in-memory adapter that enforces every declared constraint      | `db/memory-store.ts`      |
| Accounts, and the deletion state                                  | `app/account-service.ts`  |
| Identity resolution, linking and unlinking                        | `app/identity-service.ts` |
| Session families: creation, rotation, reuse detection, revocation | `app/session-service.ts`  |
| Device registration, retirement and reactivation                  | `app/device-service.ts`   |
| The ownership primitive every operation goes through              | `domain/authorization.ts` |
| Environment-injected configuration with no secret defaults        | `config.ts`               |
| Allowlist logging                                                 | `logging.ts`              |

## What this is not

Deliberately absent, because each belongs to a later phase and shipping a
half-built version of any of them would be worse than shipping none:

- **Google OAuth** and **email OTP.** The external flows produce a
  `VerifiedIdentity`; this layer consumes one. That seam is what lets the
  linking rules be complete and tested while the integrations do not exist.
- **`login_challenge` / `auth_challenge`.** A challenge row exists only to
  carry an in-flight external flow — `state`, `nonce`, a PKCE verifier, an OTP
  hash — and every one of those columns is part of an integration this phase
  excludes. Creating the table now would mean columns for secrets with no code
  that writes them and no test that could exercise them.
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
  would add a dependency nothing exercises.

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
alongside it. Where this implementation differs from a document in a way that
matters, the difference is recorded rather than absorbed — see the comment at
the top of `app/token.ts` for the one such case.
