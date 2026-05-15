-- Phase 8: community forum.
--
-- Tables for a single-tenant Q&A-style forum. Categories are admin-curated and
-- seeded by this migration. Threads have flat reply lists; the accepted-answer
-- post is hoisted to the top in the UI but not reordered in storage. Upvotes
-- are a single integer score per post (one vote per user per post, toggleable).
--
-- Display-name gate: a user must have `forum_display_name` set before any
-- write succeeds. The account-level `display_name` is shown as a default in
-- the picker modal, but the forum value is stored separately so users can
-- pseudonymize on the forum without changing their account profile.

CREATE TABLE forum_category (
  id              TEXT PRIMARY KEY,            -- short kebab-case slug, also the URL segment
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  sort_order      INTEGER NOT NULL DEFAULT 100,
  locked          INTEGER NOT NULL DEFAULT 0,  -- 1 = admin-only new threads
  created_at      INTEGER NOT NULL
);

CREATE INDEX forum_category_sort_idx ON forum_category (sort_order);

CREATE TABLE forum_thread (
  id              TEXT PRIMARY KEY,            -- ULID (sortable by time)
  category_id     TEXT NOT NULL REFERENCES forum_category(id),
  slug            TEXT NOT NULL,               -- derived from title
  title           TEXT NOT NULL,
  author_user_id  TEXT NOT NULL REFERENCES user(id),
  created_at      INTEGER NOT NULL,
  last_post_at    INTEGER NOT NULL,            -- mirrors most-recent post for sort-by-active
  post_count      INTEGER NOT NULL DEFAULT 1,  -- includes OP
  view_count      INTEGER NOT NULL DEFAULT 0,
  pinned          INTEGER NOT NULL DEFAULT 0,
  locked          INTEGER NOT NULL DEFAULT 0,
  solved_post_id  TEXT REFERENCES forum_post(id),
  deleted_at      INTEGER
);

CREATE INDEX forum_thread_category_idx ON forum_thread (category_id, deleted_at, pinned DESC, last_post_at DESC);
CREATE INDEX forum_thread_recent_idx ON forum_thread (deleted_at, last_post_at DESC);
CREATE INDEX forum_thread_author_idx ON forum_thread (author_user_id, created_at DESC);

CREATE TABLE forum_post (
  id              TEXT PRIMARY KEY,            -- ULID
  thread_id       TEXT NOT NULL REFERENCES forum_thread(id),
  author_user_id  TEXT NOT NULL REFERENCES user(id),
  body_md         TEXT NOT NULL,               -- markdown source; sanitize on render
  upvote_count    INTEGER NOT NULL DEFAULT 0,  -- denormalized from forum_post_upvote
  created_at      INTEGER NOT NULL,
  edited_at       INTEGER,
  deleted_at      INTEGER
);

CREATE INDEX forum_post_thread_idx ON forum_post (thread_id, created_at);
CREATE INDEX forum_post_author_idx ON forum_post (author_user_id, created_at DESC);

CREATE TABLE forum_post_upvote (
  post_id         TEXT NOT NULL REFERENCES forum_post(id),
  user_id         TEXT NOT NULL REFERENCES user(id),
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

CREATE INDEX forum_post_upvote_user_idx ON forum_post_upvote (user_id, created_at DESC);

-- One row per (user, thread) subscription. Author is auto-subscribed on
-- thread create; any user is auto-subscribed when they reply (opt-out per
-- email pref). Manual subscribe/unsubscribe via the SPA toggle.
CREATE TABLE forum_subscription (
  user_id         TEXT NOT NULL REFERENCES user(id),
  thread_id       TEXT NOT NULL REFERENCES forum_thread(id),
  source          TEXT NOT NULL DEFAULT 'manual', -- 'author' | 'manual' | 'reply'
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, thread_id)
);

CREATE INDEX forum_subscription_thread_idx ON forum_subscription (thread_id, user_id);

-- Per-user forum state: display name (independent of account display_name),
-- gravatar opt-out, and email preferences. Created lazily on first PATCH.
CREATE TABLE forum_user_state (
  user_id                       TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  forum_display_name            TEXT,           -- NULL until user picks one
  gravatar_opt_out              INTEGER NOT NULL DEFAULT 0,
  email_pref_replies            INTEGER NOT NULL DEFAULT 1,  -- replies on threads I authored
  email_pref_subscribed         INTEGER NOT NULL DEFAULT 1,  -- replies on threads I subscribed to
  email_pref_mark_solved        INTEGER NOT NULL DEFAULT 1,  -- my reply was marked as the answer
  email_pref_admin_alerts       INTEGER NOT NULL DEFAULT 1,  -- staff-only: every new thread
  email_pref_all_off            INTEGER NOT NULL DEFAULT 0,  -- global kill switch
  banned_until                  INTEGER,
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL
);

CREATE INDEX forum_user_state_banned_idx ON forum_user_state (banned_until)
  WHERE banned_until IS NOT NULL;

-- ─── Seed categories ────────────────────────────────────────────────────────

INSERT INTO forum_category (id, title, description, sort_order, locked, created_at) VALUES
  ('announcements',    '📣 Announcements',              'Release notes, scheduled maintenance, project news.',                                  10, 1, strftime('%s','now') * 1000),
  ('getting-started',  '🧭 Getting Started',            'Setting up your first feed, importing an existing one, the editor basics.',           20, 0, strftime('%s','now') * 1000),
  ('editor',           '🛠️ Editor & Workflow',          'Routes, stops, schedules, fares, shapes — questions about day-to-day editing.',        30, 0, strftime('%s','now') * 1000),
  ('import-export',    '📦 Import, Export & Validation','GTFS validator errors, import edge cases, export quirks.',                             40, 0, strftime('%s','now') * 1000),
  ('embeds-publishing','🖼️ Embeds & Publishing',         'Mini-site, per-route / per-stop / system-map embeds, branding, distribution.',         50, 0, strftime('%s','now') * 1000),
  ('feature-requests', '💡 Feature Requests',           'What we should build next.',                                                            60, 0, strftime('%s','now') * 1000),
  ('bugs',             '🐞 Bug Reports',                'Something''s wrong. Include feed + browser + steps.',                                   70, 0, strftime('%s','now') * 1000),
  ('general',          '💬 General',                    'Anything else GTFS-adjacent — show & tell, agency war stories, off-topic.',            80, 0, strftime('%s','now') * 1000);
