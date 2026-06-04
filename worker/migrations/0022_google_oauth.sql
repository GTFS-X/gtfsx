-- Google OAuth ("Continue with Google"), issue #20.
--
-- The Google identity itself is stored in the existing `credential` table via
-- kind='google_oauth' + oauth_provider='google' + oauth_subject=<Google sub>,
-- which already carries a partial-unique index on (oauth_provider,
-- oauth_subject) (see 0001_auth.sql). No schema change is needed to bind the
-- identity.
--
-- This migration adds an explicit `email_verified` flag to `user`. Until now
-- the only signal that an email was confirmed was status='active'. Google
-- asserts `email_verified` on the id_token / userinfo response and we require
-- it to be true before trusting the address, so we record that assertion
-- directly. Password signups set it true at the moment they consume their
-- verify-email link; OAuth signups set it true at account-creation time
-- because Google already proved control of the inbox.
--
-- Backfill: every user that is already `active` got there by verifying their
-- email (verify-email link or magic-link consume) or via an invitation that
-- proved inbox control, so they are email_verified=1. pending_verification /
-- disabled / deleted_soft rows stay 0.

ALTER TABLE user ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

UPDATE user SET email_verified = 1 WHERE status = 'active';
