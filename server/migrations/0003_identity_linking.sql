-- 0003_identity_linking
--
-- GENERATED from server/db/schema.ts. Do not edit by hand: a test renders
-- the descriptor and compares it against this file, so an edit here that
-- the descriptor does not produce fails the build.
--
-- Account linking. `login_challenge` already carried `purpose` and a
-- target account from the first migration; what it lacked was somewhere
-- for a link callback to put what it verified.
--
-- Both columns are nullable and server-written. A sign-in challenge
-- leaves them null and resolves an account instead.

-- A **link** callback has no account to resolve — the target is already on the row — so it records the verified subject here instead, and the exchange attaches it under a Principal the client proves separately. Written by the server from a verified assertion, never from a request.
ALTER TABLE login_challenge ADD COLUMN resolved_subject text;

-- The verified address that travelled with that subject, carried for the same reason and under the same rule. Canonical by the time it is written, because the callback canonicalises before it records anything.
ALTER TABLE login_challenge ADD COLUMN resolved_email text;
