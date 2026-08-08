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
-- address can test it against the digest — so it is redacted in logs and is
-- covered by the same deletion path as the rest of a user's data. Nothing about
-- the cookieless beacon changes: no IP, no User-Agent, no user id, no cookie.
--
-- Additive; forward-only. (SQLite ADD COLUMN has no IF NOT EXISTS — the
-- migration runner applies each file exactly once, same as 0014/0030.)

ALTER TABLE event ADD COLUMN oci_email_sha256 TEXT;

-- The uploader's email-only candidate query (only reachable behind the
-- default-off GOOGLE_ADS_UPLOAD_WITHOUT_CLICK_ID flag) filters on this column
-- plus `ts`; the partial index mirrors the gclid/gbraid/wbraid ones from
-- 0014/0030 so that query stays cheap and never scans the whole table.
CREATE INDEX IF NOT EXISTS event_email_hash_ts_idx
  ON event (ts) WHERE oci_email_sha256 IS NOT NULL;
