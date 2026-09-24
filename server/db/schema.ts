/**
 * The identity/authentication schema, declared once.
 *
 * This module is the **single source of truth** for the backend's persistent
 * shape. Three things read it and must agree:
 *
 *  - `sql.ts` renders it to the checked-in migration DDL, and a test compares
 *    the render against the file byte for byte, so a schema change that does
 *    not reach a migration fails the build.
 *  - `memory-store.ts` enforces the same primary keys, unique indexes,
 *    foreign keys and write-once columns, so a test written against the
 *    in-memory store is testing the real rules rather than a lenient fake.
 *  - The invariant suites assert structural properties over it — that no
 *    column could ever carry a provider credential, a K1 key or a Chrome
 *    runtime identifier (AUTH-5, AUTH-6, AUTH-7).
 *
 * Declaring the schema as data rather than as SQL text is what makes that
 * third one possible: a string of DDL can only be grepped, while a descriptor
 * can be walked, and a new column is checked the moment it is added rather
 * than whenever somebody remembers to update a regular expression.
 *
 * **Scope.** Identity and authentication only. Cloud Sync's tables —
 * `sync_record`, `push_idempotency`, and the sync half of the device row —
 * belong to `CLOUD_SYNC_PROTOCOL.md` and to the sync phase. They are
 * deliberately absent, not forgotten.
 */

export type ColumnType = 'text' | 'integer' | 'boolean' | 'timestamptz';

export interface ColumnSpec {
  readonly name: string;
  readonly type: ColumnType;
  readonly nullable: boolean;
  /**
   * Written at insert and never updated.
   *
   * This is the mechanism behind "an identity's owner is assigned once": the
   * column is not merely conventionally stable, the store refuses an update
   * that changes it. Moving an identity between accounts is therefore not an
   * operation the persistence layer can express (AUTH-23).
   */
  readonly writeOnce?: boolean;
  /** Why the column exists. An unexplained column is a column nobody owns. */
  readonly why: string;
}

export interface UniqueSpec {
  readonly name: string;
  readonly columns: readonly string[];
  /**
   * Columns that must all be *present* for the constraint to apply, making
   * this a partial index.
   *
   * Expressed as column names rather than as a SQL predicate so that one
   * declaration drives both halves: `sql.ts` renders it to a `WHERE` clause,
   * and `memory-store.ts` evaluates it directly. A hand-written predicate
   * string would have to be re-implemented in JavaScript to be enforced
   * in-memory, and the two would drift the first time one was edited.
   *
   * "Present" means non-null, and additionally `true` for a boolean column —
   * which is what makes `email_verified` usable here: an unverified address
   * is a claim rather than an identity, and two claims on one address must
   * not collide into a single account.
   */
  readonly requires?: readonly string[];
  /**
   * Columns that must all be **absent** for the constraint to apply.
   *
   * The mirror of `requires`, and it exists for one reason: a uniqueness key
   * may be correct for the kinds a column identifies and wrong for the kinds
   * it merely describes. `auth_identity.email` is the identity for a kind
   * that has no subject and display metadata for a kind that has one, so the
   * key that enforces "one account per address" has to apply to the first and
   * not to the second. Saying "where `subject` is null" states that in terms
   * of the schema rather than by naming kinds, so a future subjectless kind
   * is covered without editing this.
   *
   * Rendered and evaluated the same way `requires` is, from one declaration.
   */
  readonly requiresNull?: readonly string[];
  readonly why: string;
}

export interface ForeignKeySpec {
  readonly columns: readonly string[];
  readonly references: { readonly table: string; readonly columns: readonly string[] };
  readonly onDelete: 'cascade' | 'restrict' | 'set null';
}

export interface CheckSpec {
  readonly name: string;
  readonly expression: string;
  /**
   * The same rule in JavaScript, so it can be enforced and tested without a
   * database.
   *
   * `UniqueSpec.requires` is declared once and honoured by both the SQL
   * renderer and the memory store; checks had no equivalent, so they were
   * rendered into DDL and enforced *nowhere* under test. That is how
   * `auth_identity_email_lowercase` came to say `email = lower(email)` while
   * the canonicaliser deliberately preserves local-part case — a
   * contradiction that would only have appeared against real Postgres, at
   * sign-in, for anybody whose address has a capital letter before the `@`.
   *
   * Optional because a check whose meaning is genuinely SQL-only should say
   * so by omission rather than by a JavaScript approximation nobody can
   * trust. Where it is present, the memory store enforces it.
   */
  readonly holds?: (row: Readonly<Record<string, unknown>>) => boolean;
  readonly why: string;
}

/** Everything after the last `@`. Mirrors `normaliseEmail`'s split exactly. */
export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1);
}

export interface IndexSpec {
  readonly name: string;
  readonly columns: readonly string[];
  /** The access pattern it serves. An index without one is speculative. */
  readonly why: string;
}

export interface TableSpec {
  readonly name: string;
  readonly why: string;
  readonly columns: readonly ColumnSpec[];
  readonly primaryKey: readonly string[];
  readonly unique: readonly UniqueSpec[];
  readonly foreignKeys: readonly ForeignKeySpec[];
  readonly checks: readonly CheckSpec[];
  readonly indexes: readonly IndexSpec[];
}

/**
 * Column-name fragments that may never appear anywhere in this schema.
 *
 * Every entry is a category of value the approved architecture states the
 * backend must never receive (IDENTITY_AUTH_ARCHITECTURE §18.2, K1 §26). The
 * check is on the **name** because a name is what a future column would be
 * given: nobody adds `provider_api_key` by accident, they add it on purpose,
 * and this is what stops that happening without a conversation.
 *
 * It is not a substitute for the absence of a write path. It is the second
 * line, and it is the one a schema diff trips over.
 */
export const FORBIDDEN_COLUMN_FRAGMENTS: readonly string[] = [
  // Provider credentials — SECRET_LOCAL_ONLY, permanently (AUTH-5, AUTH-6).
  'api_key',
  'apikey',
  'provider_secret',
  'client_secret',
  'oauth_secret',
  'credential',
  // K1 key material — never transmitted, in any form (AUTH-4).
  'recovery_key',
  'recoverykey',
  'kek',
  'dek',
  'passphrase',
  // K1 payloads and user work — encrypted elsewhere, absent here.
  'ciphertext',
  'envelope',
  'plaintext',
  'page_content',
  'prompt',
  'model_response',
  'audit_content',
  // Chrome runtime handles — recycled, restart-unstable, meaningless off-device
  // (AUTH-7, SYNC-5).
  'tab_id',
  'tabid',
  'window_id',
  'windowid',
  'tab_group_id',
  'tabgroupid',
  'extension_id',
  'extensionid',
  // Raw bearer tokens. Only one-way verification material is stored (§6.3).
  'refresh_token',
  'access_token',
  'raw_token',
  // Google's own tokens. The backend redeems an authorization code and reads
  // the id_token's claims; it stores none of them, and there is no column any
  // of them could be written to.
  'id_token',
  'google_token',
  'authorization_code',
];

/** Identity kinds the schema admits. New kinds are added here, deliberately. */
export const AUTH_IDENTITY_KINDS = ['google', 'email'] as const;
export type AuthIdentityKind = (typeof AUTH_IDENTITY_KINDS)[number];

export const ACCOUNT_STATES = ['active', 'deleted'] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];

const abaUser: TableSpec = {
  name: 'aba_user',
  why: 'The ABA account. The partition key for everything the backend holds.',
  columns: [
    {
      name: 'id',
      type: 'text',
      nullable: false,
      writeOnce: true,
      why: 'abaUserId — server-generated, opaque, permanent until deletion (AUTH-1).',
    },
    {
      name: 'created_at',
      type: 'timestamptz',
      nullable: false,
      writeOnce: true,
      why: 'When the account came into existence. The one date a support question about an account can be answered from.',
    },
    {
      name: 'state',
      type: 'text',
      nullable: false,
      why: "'active' or 'deleted'. Deletion is a state, never an absent row (§15.1).",
    },
    {
      name: 'deleted_at',
      type: 'timestamptz',
      nullable: true,
      why: 'Set with the deleted state; the tombstone a replayed request meets.',
    },
  ],
  primaryKey: ['id'],
  unique: [],
  foreignKeys: [],
  checks: [
    {
      name: 'aba_user_state_valid',
      expression: `state IN ('active', 'deleted')`,
      why: 'No third state exists; a deletion grace period is an open product question and is not invented here.',
    },
    {
      name: 'aba_user_deleted_at_matches_state',
      expression: `(state = 'deleted') = (deleted_at IS NOT NULL)`,
      why: 'A deleted account without a timestamp, or a timestamp without the state, is a row two readers would disagree about.',
    },
  ],
  indexes: [],
};

const authIdentity: TableSpec = {
  name: 'auth_identity',
  why: 'An external identity that resolves to one ABA account. One account may hold several.',
  columns: [
    { name: 'id', type: 'text', nullable: false, writeOnce: true, why: 'Row identity.' },
    {
      name: 'aba_user_id',
      type: 'text',
      nullable: false,
      writeOnce: true,
      why: 'The owner. Write-once: an identity is never moved between accounts (AUTH-23).',
    },
    {
      name: 'kind',
      type: 'text',
      nullable: false,
      writeOnce: true,
      why: "'google' or 'email'. Part of every uniqueness key so a future kind cannot collide with an existing one.",
    },
    {
      name: 'subject',
      type: 'text',
      nullable: true,
      writeOnce: true,
      why: "The provider's stable subject (google_sub). Null for kinds that have none.",
    },
    {
      name: 'email',
      type: 'text',
      nullable: true,
      why: 'Canonical form: surrounding whitespace removed and the domain folded to lower case, local part byte-for-byte as given (AUTH-31). Null for kinds that carry no address.',
    },
    {
      name: 'email_verified',
      type: 'boolean',
      nullable: false,
      why: 'Never true without a completed proof. An unverified address never matches and never links (AUTH-18).',
    },
    {
      name: 'linked_at',
      type: 'timestamptz',
      nullable: false,
      writeOnce: true,
      why: 'When this identity was attached — half of the linking audit trail.',
    },
    {
      name: 'linked_via',
      type: 'text',
      nullable: true,
      writeOnce: true,
      why: 'The session that performed the link; null for the identity an account was created with. Audit only, never an authorization input.',
    },
    {
      name: 'last_used_at',
      type: 'timestamptz',
      nullable: true,
      why: 'Display and stale-identity review. Never an authorization input.',
    },
  ],
  primaryKey: ['id'],
  unique: [
    {
      name: 'auth_identity_subject_key',
      columns: ['kind', 'subject'],
      requires: ['subject'],
      why: 'An external subject belongs to at most one ABA account. This constraint is what makes the identity-in-use refusal a database property rather than only an application check (AUTH-23).',
    },
    {
      name: 'auth_identity_email_key',
      columns: ['kind', 'email'],
      requires: ['email', 'email_verified'],
      // Where the kind has a subject, the subject is the identity and this
      // column is metadata (AUTH-29). A uniqueness key over metadata denies
      // service on a value that authorises nothing: two distinct Google
      // subjects can carry one address — a domain reassigns it, and our copy
      // of the old holder's is never refreshed — and the second of them could
      // then never sign in at all, while each attempt left an account behind.
      requiresNull: ['subject'],
      why: 'One ABA account per verified address, for the kinds where the address IS the identity. Unverified rows are excluded because an unverified address is a claim, not an identity (AUTH-18). Subject-bearing rows are excluded because there the address is metadata and the subject is the identity — uniqueness belongs on the authenticator, and auth_identity_subject_key already provides it (AUTH-29).',
    },
  ],
  foreignKeys: [
    {
      columns: ['aba_user_id'],
      references: { table: 'aba_user', columns: ['id'] },
      onDelete: 'cascade',
    },
  ],
  checks: [
    {
      name: 'auth_identity_kind_valid',
      expression: `kind IN ('google', 'email')`,
      why: 'A kind the domain does not know is a row nothing can resolve.',
    },
    {
      name: 'auth_identity_has_an_identifier',
      expression: 'subject IS NOT NULL OR email IS NOT NULL',
      why: 'An identity with neither identifies nobody and would match every lookup that tested only for null.',
    },
    {
      name: 'auth_identity_email_domain_lowercase',
      // Everything after the **last** `@`, which is the same split
      // `normaliseEmail` makes: a quoted local part may legally contain one.
      // `regexp_replace` with a greedy `^.*@` takes the last separator.
      expression:
        "email IS NULL OR regexp_replace(email, '^.*@', '') = lower(regexp_replace(email, '^.*@', ''))",
      holds: (row) => {
        const email = row['email'];
        if (email === null || email === undefined) return true;
        if (typeof email !== 'string') return false;
        const domain = domainOf(email);
        return domain === domain.toLowerCase();
      },
      why: 'Normalisation is enforced at the boundary, not hoped for: a row whose domain is not folded would be invisible to the lookup that folds first. Only the domain, because that is all `normaliseEmail` folds — RFC 5321 §2.4 reserves the local part to the destination host, so folding it would be a guess that can merge two people into one account. The previous form of this check required the whole address to be lowercase, which contradicted the canonicaliser and would have refused every address with a capital letter before the `@`.',
    },
  ],
  indexes: [
    {
      name: 'auth_identity_owner_idx',
      columns: ['aba_user_id'],
      why: "Listing an account's identities, and the unlink last-identity check.",
    },
  ],
};

const session: TableSpec = {
  name: 'session',
  why: 'One authenticated sign-in. Authorization comes from here and nowhere else.',
  columns: [
    { name: 'id', type: 'text', nullable: false, writeOnce: true, why: 'Row identity.' },
    {
      name: 'aba_user_id',
      type: 'text',
      nullable: false,
      writeOnce: true,
      why: 'The only source of abaUserId for an authorization decision (AUTH-8).',
    },
    {
      name: 'auth_identity_id',
      type: 'text',
      nullable: true,
      // Deliberately NOT write-once, and the exception is narrow: the only
      // writer after insert is the `ON DELETE SET NULL` referential action
      // when the identity is unlinked. Marking it write-once would make the
      // adapter refuse that action and disagree with the DDL, which is a
      // worse outcome than the immutability it would buy — nothing authorises
      // on this column, so its stability is an audit property rather than a
      // security one.
      why: 'Which identity established this session. Read only to revoke on unlink; never an authorization input.',
    },
    {
      name: 'family_id',
      type: 'text',
      nullable: false,
      writeOnce: true,
      why: 'The rotation chain. Reuse of any member revokes the whole family (AUTH-16).',
    },
    {
      name: 'refresh_digest',
      type: 'text',
      nullable: false,
      why: 'One-way verification material for the refresh token. The token itself is never stored.',
    },
    {
      name: 'digest_version',
      type: 'integer',
      nullable: false,
      // The forward-compatibility column the refresh-token review asked for.
      // A digest cannot be recomputed without the token, so an algorithm
      // change is prospective only: existing rows keep verifying under the
      // version they were written with, and adopt a new one at their next
      // rotation. Without a stored discriminator a mixed population has to be
      // guessed at, and guessing means trying every algorithm on every
      // request — which is how an old one stays reachable for ever.
      why: 'Which refresh-digest algorithm produced this row. 1 = SHA-256 domain-separated (§6.6).',
    },
    {
      name: 'issued_at',
      type: 'timestamptz',
      nullable: false,
      writeOnce: true,
      why: 'When this link in the rotation chain was minted. Distinguishes a long-lived family from a freshly created one.',
    },
    {
      name: 'expires_at',
      type: 'timestamptz',
      nullable: false,
      why: 'Refresh expiry, rolled forward on each rotation.',
    },
    {
      name: 'rotated_at',
      type: 'timestamptz',
      nullable: true,
      why: 'Set when superseded. A presented token whose row has this set is a reuse signal, not merely a stale one.',
    },
    {
      name: 'revoked_at',
      type: 'timestamptz',
      nullable: true,
      why: 'Logout, reuse, unlink, deletion.',
    },
    {
      name: 'revoked_reason',
      type: 'text',
      nullable: true,
      why: 'Operational diagnosis. A fixed vocabulary, never free text from a request.',
    },
    {
      name: 'last_seen_at',
      type: 'timestamptz',
      nullable: false,
      why: 'Drives the client grace window.',
    },
  ],
  primaryKey: ['id'],
  unique: [
    {
      name: 'session_refresh_digest_key',
      columns: ['refresh_digest'],
      why: 'A digest identifies at most one session, so presenting a token is an unambiguous lookup rather than a scan that could match two rows.',
    },
  ],
  foreignKeys: [
    {
      columns: ['aba_user_id'],
      references: { table: 'aba_user', columns: ['id'] },
      onDelete: 'cascade',
    },
    {
      columns: ['auth_identity_id'],
      // SET NULL, not CASCADE, and the difference is the audit trail.
      // Unlinking revokes the sessions that identity established (§20.7) and
      // then removes the row; cascading would delete the revoked sessions
      // too, erasing the evidence that they were revoked and why. The session
      // survives with no provenance, which is exactly what it now has.
      references: { table: 'auth_identity', columns: ['id'] },
      onDelete: 'set null',
    },
  ],
  checks: [
    {
      name: 'session_revoked_reason_matches_state',
      expression: '(revoked_at IS NULL) = (revoked_reason IS NULL)',
      why: 'A reason without a revocation, or a revocation without a reason, is a row that cannot be explained afterwards.',
    },
  ],
  indexes: [
    {
      name: 'session_owner_idx',
      columns: ['aba_user_id', 'revoked_at'],
      why: 'Sign-out-everywhere, and listing an account’s live sessions.',
    },
    {
      name: 'session_family_idx',
      columns: ['family_id'],
      why: 'Revoking a whole family on reuse detection — the hot path of the replay defence.',
    },
    {
      name: 'session_identity_idx',
      columns: ['auth_identity_id'],
      why: 'Revoking the sessions an unlinked identity established.',
    },
  ],
};

const device: TableSpec = {
  name: 'device',
  why: 'One installation, belonging to one ABA account. Provenance, never an authenticator.',
  columns: [
    {
      name: 'aba_user_id',
      type: 'text',
      nullable: false,
      writeOnce: true,
      why: 'The owner. A device is never moved between accounts.',
    },
    {
      name: 'device_id',
      type: 'text',
      nullable: false,
      writeOnce: true,
      why: 'Client-minted, opaque, not secret, not derived from any Chrome runtime handle (AUTH-7, AUTH-20).',
    },
    {
      name: 'registered_at',
      type: 'timestamptz',
      nullable: false,
      writeOnce: true,
      why: 'When this installation first appeared. A reinstall produces a new row, so this dates the install rather than the account.',
    },
    {
      name: 'last_seen_at',
      type: 'timestamptz',
      nullable: false,
      why: 'Drives retirement eligibility.',
    },
    {
      name: 'retired_at',
      type: 'timestamptz',
      nullable: true,
      why: 'Null while active. Retirement deletes no record and revokes no session.',
    },
    {
      name: 'reactivated_at',
      type: 'timestamptz',
      nullable: true,
      why: 'The last reactivation, for audit. Reactivation restores the existing state, never a fresh one.',
    },
  ],
  // Composite, and deliberately so: the same device_id under two accounts is
  // two rows, because a device is scoped to its owner and carries no meaning
  // across accounts.
  primaryKey: ['aba_user_id', 'device_id'],
  unique: [],
  foreignKeys: [
    {
      columns: ['aba_user_id'],
      references: { table: 'aba_user', columns: ['id'] },
      onDelete: 'cascade',
    },
  ],
  checks: [],
  indexes: [
    {
      name: 'device_owner_active_idx',
      columns: ['aba_user_id', 'retired_at'],
      why: "Listing an account's active devices.",
    },
  ],
};

/**
 * One in-flight authentication or link.
 *
 * Deliberately absent from the Phase 1 foundation, and present now for the
 * reason it was absent then: every column here exists to carry an external
 * flow, and there was no external flow. The Google sign-in phase is what
 * makes it real.
 *
 * Everything secret on this row is held **server-side only**. The client is
 * given `id` and nothing else, and `id` alone authorises nothing: the
 * verifier, the nonce and the exchange material never leave this table.
 */
const loginChallenge: TableSpec = {
  name: 'login_challenge',
  why: 'One in-flight authentication. Short-lived, single-use, server-side secrets only.',
  columns: [
    {
      name: 'id',
      type: 'text',
      nullable: false,
      writeOnce: true,
      why: 'The only part the client holds. Opaque, and useless without the row it names.',
    },
    {
      name: 'method',
      type: 'text',
      nullable: false,
      writeOnce: true,
      why: "'google' today. The column exists so a second method does not need a second table.",
    },
    {
      name: 'purpose',
      type: 'text',
      nullable: false,
      writeOnce: true,
      why: "'sign_in' or 'link'. Linking reuses this row shape and must not be confused with a sign-in.",
    },
    {
      name: 'aba_user_id',
      type: 'text',
      nullable: true,
      writeOnce: true,
      why: 'Non-null only for a link, where the target account is already known from the session. Never read from a request.',
    },
    {
      name: 'state',
      type: 'text',
      nullable: true,
      writeOnce: true,
      why: 'CSPRNG, >= 128 bits. Binds the callback to the request that started it — the CSRF control.',
    },
    {
      name: 'nonce',
      type: 'text',
      nullable: true,
      writeOnce: true,
      why: 'CSPRNG, >= 128 bits. Echoed in the id_token and compared, so a previously issued token cannot be replayed.',
    },
    {
      name: 'pkce_verifier',
      type: 'text',
      nullable: true,
      writeOnce: true,
      why: 'Server-side only, never sent to the client. What makes a stolen authorization code useless.',
    },
    {
      name: 'redirect_uri',
      type: 'text',
      nullable: true,
      writeOnce: true,
      why: 'Recorded at start and re-sent at redemption, so the value Google checks is the value this flow began with.',
    },
    {
      name: 'exchange_digest',
      type: 'text',
      nullable: true,
      why: 'One-way material for the one-time exchange code. The code itself is never stored, exactly as a refresh token is not.',
    },
    {
      name: 'resolved_aba_user_id',
      type: 'text',
      nullable: true,
      why: 'The account the callback resolved, held until the exchange collects it. Written by the server, never by a request.',
    },
    {
      name: 'resolved_auth_identity_id',
      type: 'text',
      nullable: true,
      why: 'The identity row the callback resolved, so the session records the provenance the exchange did not have to trust.',
    },
    {
      name: 'attempts',
      type: 'integer',
      nullable: false,
      why: 'Exchange attempts. Capped, so a guessed exchange code cannot be searched for.',
    },
    {
      name: 'created_at',
      type: 'timestamptz',
      nullable: false,
      writeOnce: true,
      why: 'When the flow began. Bounds how long a challenge can sit open.',
    },
    {
      name: 'expires_at',
      type: 'timestamptz',
      nullable: false,
      why: 'Short. A challenge past this is inert whatever else is true of it.',
    },
    {
      name: 'consumed_at',
      type: 'timestamptz',
      nullable: true,
      why: 'Set before any further work, so a replayed callback finds a row that is already spent.',
    },
  ],
  primaryKey: ['id'],
  unique: [
    {
      name: 'login_challenge_state_key',
      columns: ['state'],
      requires: ['state'],
      why: 'A callback arrives with a state and nothing else, so the lookup must resolve to exactly one row. Two rows sharing a state would make the binding ambiguous, which is the binding failing.',
    },
    {
      name: 'login_challenge_exchange_key',
      columns: ['exchange_digest'],
      requires: ['exchange_digest'],
      why: 'The same, for the exchange step.',
    },
  ],
  foreignKeys: [
    {
      columns: ['aba_user_id'],
      references: { table: 'aba_user', columns: ['id'] },
      onDelete: 'cascade',
    },
  ],
  checks: [
    {
      name: 'login_challenge_method_valid',
      expression: `method IN ('google', 'email')`,
      why: 'A method the server cannot complete is a row nothing will ever consume.',
    },
    {
      name: 'login_challenge_purpose_valid',
      expression: `purpose IN ('sign_in', 'link')`,
      why: 'Linking and signing in have different authorization requirements; a third value would satisfy neither.',
    },
    {
      name: 'login_challenge_link_has_target',
      expression: `purpose <> 'link' OR aba_user_id IS NOT NULL`,
      why: 'A link with no target account is a link that would have to take one from the request, which is the attack the two-proof rule exists to prevent.',
    },
  ],
  indexes: [
    {
      name: 'login_challenge_expiry_idx',
      columns: ['expires_at'],
      why: 'The sweeper that deletes expired challenges, so credential material does not sit past its purpose.',
    },
  ],
};

/** Every table, in dependency order. The order is the migration order. */
export const SCHEMA: readonly TableSpec[] = [
  abaUser,
  authIdentity,
  session,
  device,
  loginChallenge,
];

/** The refresh-digest algorithm this build writes. See §6.6. */
export const CURRENT_DIGEST_VERSION = 1;

export function table(name: string): TableSpec {
  const found = SCHEMA.find((entry) => entry.name === name);
  if (!found) throw new Error(`No such table in the schema: ${name}`);
  return found;
}
