-- 0002_google_auth
--
-- GENERATED from server/db/schema.ts. Do not edit by hand: a test renders
-- the descriptor and compares it against this file, so an edit here that
-- the descriptor does not produce fails the build.
--
-- The Google sign-in phase. Adds the in-flight challenge row, and the
-- refresh-digest version column the refresh-token review asked for.
--
-- Every secret on login_challenge is server-side only: the client holds
-- the id and nothing else.

-- One in-flight authentication. Short-lived, single-use, server-side secrets only.
CREATE TABLE login_challenge (
  id text NOT NULL,
  method text NOT NULL,
  purpose text NOT NULL,
  aba_user_id text,
  state text,
  nonce text,
  pkce_verifier text,
  redirect_uri text,
  exchange_digest text,
  resolved_aba_user_id text,
  resolved_auth_identity_id text,
  attempts integer NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY (id),
  FOREIGN KEY (aba_user_id) REFERENCES aba_user (id) ON DELETE CASCADE,
  CONSTRAINT login_challenge_method_valid CHECK (method IN ('google', 'email')),
  CONSTRAINT login_challenge_purpose_valid CHECK (purpose IN ('sign_in', 'link')),
  CONSTRAINT login_challenge_link_has_target CHECK (purpose <> 'link' OR aba_user_id IS NOT NULL)
);

-- A callback arrives with a state and nothing else, so the lookup must resolve to exactly one row. Two rows sharing a state would make the binding ambiguous, which is the binding failing.
CREATE UNIQUE INDEX login_challenge_state_key ON login_challenge (state) WHERE state IS NOT NULL;

-- The same, for the exchange step.
CREATE UNIQUE INDEX login_challenge_exchange_key ON login_challenge (exchange_digest) WHERE exchange_digest IS NOT NULL;

-- The sweeper that deletes expired challenges, so credential material does not sit past its purpose.
CREATE INDEX login_challenge_expiry_idx ON login_challenge (expires_at);

-- Which refresh-digest algorithm produced this row. 1 = SHA-256 domain-separated (§6.6).
ALTER TABLE session ADD COLUMN digest_version integer NOT NULL DEFAULT 1;
ALTER TABLE session ALTER COLUMN digest_version DROP DEFAULT;
