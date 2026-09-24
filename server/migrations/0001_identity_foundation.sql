-- 0001_identity_foundation
--
-- GENERATED from server/db/schema.ts. Do not edit by hand: a test renders
-- the descriptor and compares it against this file, so an edit here that
-- the descriptor does not produce fails the build.
--
-- Identity and authentication only. Cloud Sync tables belong to
-- CLOUD_SYNC_PROTOCOL.md and to the sync phase.

-- The ABA account. The partition key for everything the backend holds.
CREATE TABLE aba_user (
  id text NOT NULL,
  created_at timestamptz NOT NULL,
  state text NOT NULL,
  deleted_at timestamptz,
  PRIMARY KEY (id),
  CONSTRAINT aba_user_state_valid CHECK (state IN ('active', 'deleted')),
  CONSTRAINT aba_user_deleted_at_matches_state CHECK ((state = 'deleted') = (deleted_at IS NOT NULL))
);

-- An external identity that resolves to one ABA account. One account may hold several.
CREATE TABLE auth_identity (
  id text NOT NULL,
  aba_user_id text NOT NULL,
  kind text NOT NULL,
  subject text,
  email text,
  email_verified boolean NOT NULL,
  linked_at timestamptz NOT NULL,
  linked_via text,
  last_used_at timestamptz,
  PRIMARY KEY (id),
  FOREIGN KEY (aba_user_id) REFERENCES aba_user (id) ON DELETE CASCADE,
  CONSTRAINT auth_identity_kind_valid CHECK (kind IN ('google', 'email')),
  CONSTRAINT auth_identity_has_an_identifier CHECK (subject IS NOT NULL OR email IS NOT NULL),
  CONSTRAINT auth_identity_email_domain_lowercase CHECK (email IS NULL OR regexp_replace(email, '^.*@', '') = lower(regexp_replace(email, '^.*@', '')))
);

-- An external subject belongs to at most one ABA account. This constraint is what makes the identity-in-use refusal a database property rather than only an application check (AUTH-23).
CREATE UNIQUE INDEX auth_identity_subject_key ON auth_identity (kind, subject) WHERE subject IS NOT NULL;

-- One ABA account per verified address, for the kinds where the address IS the identity. Unverified rows are excluded because an unverified address is a claim, not an identity (AUTH-18). Subject-bearing rows are excluded because there the address is metadata and the subject is the identity — uniqueness belongs on the authenticator, and auth_identity_subject_key already provides it (AUTH-29).
CREATE UNIQUE INDEX auth_identity_email_key ON auth_identity (kind, email) WHERE email IS NOT NULL AND email_verified AND subject IS NULL;

-- Listing an account's identities, and the unlink last-identity check.
CREATE INDEX auth_identity_owner_idx ON auth_identity (aba_user_id);

-- One authenticated sign-in. Authorization comes from here and nowhere else.
CREATE TABLE session (
  id text NOT NULL,
  aba_user_id text NOT NULL,
  auth_identity_id text,
  family_id text NOT NULL,
  refresh_digest text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  rotated_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (aba_user_id) REFERENCES aba_user (id) ON DELETE CASCADE,
  FOREIGN KEY (auth_identity_id) REFERENCES auth_identity (id) ON DELETE SET NULL,
  CONSTRAINT session_revoked_reason_matches_state CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

-- A digest identifies at most one session, so presenting a token is an unambiguous lookup rather than a scan that could match two rows.
CREATE UNIQUE INDEX session_refresh_digest_key ON session (refresh_digest);

-- Sign-out-everywhere, and listing an account’s live sessions.
CREATE INDEX session_owner_idx ON session (aba_user_id, revoked_at);

-- Revoking a whole family on reuse detection — the hot path of the replay defence.
CREATE INDEX session_family_idx ON session (family_id);

-- Revoking the sessions an unlinked identity established.
CREATE INDEX session_identity_idx ON session (auth_identity_id);

-- One installation, belonging to one ABA account. Provenance, never an authenticator.
CREATE TABLE device (
  aba_user_id text NOT NULL,
  device_id text NOT NULL,
  registered_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  retired_at timestamptz,
  reactivated_at timestamptz,
  PRIMARY KEY (aba_user_id, device_id),
  FOREIGN KEY (aba_user_id) REFERENCES aba_user (id) ON DELETE CASCADE
);

-- Listing an account's active devices.
CREATE INDEX device_owner_active_idx ON device (aba_user_id, retired_at);
