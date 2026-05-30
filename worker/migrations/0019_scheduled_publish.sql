-- Scheduled publish (BE-77): publish a snapshot at a future time.
--
-- A scheduled publish records the INTENT (project + snapshot + when); a
-- recurring cron (`*/15 * * * *`, see worker/cron) fires the actual publish via
-- the same performPublish() core the interactive route uses, so a scheduled
-- publish is identical to an interactive one. Snapshots are immutable, so the
-- snapshot's stored ZIP (zip_r2_key) + validation counts are stable between
-- scheduling and execution. See docs/ARCHITECTURE.md §4.

CREATE TABLE scheduled_publish (
  id                    TEXT PRIMARY KEY,                       -- ULID
  project_id            TEXT NOT NULL REFERENCES feed_project(id) ON DELETE CASCADE,
  snapshot_id           TEXT NOT NULL REFERENCES feed_snapshot(id),
  scheduled_for         INTEGER NOT NULL,                       -- unix ms — fire at the first cron run after this
  ignore_warnings       INTEGER NOT NULL DEFAULT 0,             -- publish despite validation errors
  status                TEXT NOT NULL DEFAULT 'pending',        -- 'pending' | 'executed' | 'cancelled' | 'failed'
  failure_reason        TEXT,                                   -- set when status='failed' (plan downgrade, missing ZIP, …)
  scheduled_by_user_id  TEXT REFERENCES user(id) ON DELETE SET NULL,
  created_at            INTEGER NOT NULL,
  executed_at           INTEGER                                 -- when the cron ran it (executed or failed)
);

-- Cron lookup: pending rows whose time has arrived.
CREATE INDEX scheduled_publish_due_idx ON scheduled_publish (status, scheduled_for);

-- At most one pending schedule per project — (re)scheduling replaces the prior
-- pending row (the API cancels the old one first). Past/terminal rows are
-- retained for history and don't count against this.
CREATE UNIQUE INDEX scheduled_publish_one_pending ON scheduled_publish (project_id) WHERE status = 'pending';
