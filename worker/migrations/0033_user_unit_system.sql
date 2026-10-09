-- 0033: account-level display-units preference (issue #76, follow-up to PR #77).
--
-- PR #77 shipped an imperial/metric toggle stored only in the browser
-- (localStorage `gb_unit_system`). This column lets the choice follow a
-- signed-in user across devices. It is display-only: no GTFS data, no
-- calculation and no plan gate depends on it.
--
-- NULL = the user has never chosen; clients treat it as the default
-- (imperial) and, if the browser already holds a choice, push that up once.
--
-- Additive only. Existing rows get NULL.

ALTER TABLE user ADD COLUMN unit_system TEXT CHECK (unit_system IN ('imperial', 'metric'));
