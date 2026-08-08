-- 0032: carry a hashed customer email on conversion events.
--
-- Google's Data Manager API accepts a `userData.userIdentifiers[]` list beside
-- the ad click id (worker/marketing/ads/userIdentifiers.ts). Supplying a hashed
-- email lets Google attribute a conversion when the click id alone can't —
-- cross-device journeys, iOS/consent-limited clicks, and clicks whose gclid
-- never survived the round trip.
--
-- PRIVACY. This column stores ONLY hex(sha256(normalized_email)) — never a
-- plaintext address, never a user id, never a session→account link. The hash is
-- computed at INSERT time by the code paths that already hold the address
-- (signup, the Google OAuth new-user branch, the /book-demo lead form, and the
-- beacon when the caller happens to have an active session); the `event` table
-- itself never sees the address. It is deliberately the same value we send to
-- Google, and nothing more: a one-way digest, not a reversible identifier.
--
-- It is still a *stable pseudonymous* identifier — anyone holding a candidate
-- address can test it against the digest — so it is redacted in logs
-- (redactHash). Nothing about the cookieless beacon changes: no IP, no
-- User-Agent, no user id, no cookie.
--
-- ⚠️ DELETION IS NOT AUTOMATIC. `reapOne` (worker/cron/tasks.ts) purges the
-- user, credentials, sessions, projects, org rows and audit_event; it does NOT
-- touch `event`, which carries no user_id to key a delete on. So this hash
-- survives an account deletion until someone clears it by hand. That is stated
-- in public/privacy-policy §7, which routes the request to
-- support+privacy@gtfsx.com. Wiring it into reap is a small change nobody has
-- made yet: UPDATE event SET oci_email_sha256 = NULL WHERE oci_email_sha256 = ?
-- with hashEmailHex(user.email).
--
-- Additive; forward-only. (SQLite ADD COLUMN has no IF NOT EXISTS — the
-- migration runner applies each file exactly once, same as 0014/0030.)

ALTER TABLE event ADD COLUMN oci_email_sha256 TEXT;

-- The uploader's email-only candidate query (only reachable behind the
-- default-off GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID_KINDS setting, and only for
-- kinds in EMAIL_ONLY_ELIGIBLE_KINDS) filters on this column plus `ts` and
-- `kind`; the partial index mirrors the gclid/gbraid/wbraid ones from
-- 0014/0030 so that query stays cheap and never scans the whole table.
CREATE INDEX IF NOT EXISTS event_email_hash_ts_idx
  ON event (ts) WHERE oci_email_sha256 IS NOT NULL;
