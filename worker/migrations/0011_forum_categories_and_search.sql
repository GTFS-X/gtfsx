-- Phase 11: forum housekeeping.
--   1) Drop the "getting-started" category — Editor & Workflow covers the
--      same ground; the second category was just confusing for new users.
--      Any threads already filed there are moved to "editor" first.
--   2) Build an FTS5 search index over thread titles + post bodies so the
--      community section can offer free-text search. Triggers keep the
--      index in sync with the canonical forum_thread / forum_post tables.

-- ─── 1. Remove "getting-started" ────────────────────────────────────────────

UPDATE forum_thread SET category_id = 'editor' WHERE category_id = 'getting-started';
DELETE FROM forum_category WHERE id = 'getting-started';

-- ─── 2. FTS5 search index ───────────────────────────────────────────────────
-- One row per indexable unit. `kind` distinguishes between a thread's title
-- (one row per thread) and a post's body (one row per post). At search time
-- we union both kinds and de-dupe back to the parent thread; this lets us
-- show snippets that highlight either the title or the post body, and
-- weights are managed via SQL (titles get a small priority boost).

CREATE VIRTUAL TABLE forum_search USING fts5(
  thread_id UNINDEXED,
  post_id UNINDEXED,
  kind UNINDEXED,                     -- 'title' | 'body'
  text,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- Seed the index with the current rows. New writes are kept in sync by the
-- triggers below.
INSERT INTO forum_search (thread_id, post_id, kind, text)
  SELECT id, NULL, 'title', title FROM forum_thread WHERE deleted_at IS NULL;
INSERT INTO forum_search (thread_id, post_id, kind, text)
  SELECT p.thread_id, p.id, 'body', p.body_md
    FROM forum_post p
    JOIN forum_thread t ON t.id = p.thread_id
   WHERE p.deleted_at IS NULL AND t.deleted_at IS NULL;

-- ─── Triggers ──────────────────────────────────────────────────────────────

CREATE TRIGGER forum_search_thread_insert
  AFTER INSERT ON forum_thread
  WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT INTO forum_search (thread_id, post_id, kind, text) VALUES (NEW.id, NULL, 'title', NEW.title);
END;

CREATE TRIGGER forum_search_thread_update
  AFTER UPDATE OF title, deleted_at ON forum_thread
BEGIN
  DELETE FROM forum_search WHERE thread_id = NEW.id AND kind = 'title';
  INSERT INTO forum_search (thread_id, post_id, kind, text)
    SELECT NEW.id, NULL, 'title', NEW.title WHERE NEW.deleted_at IS NULL;
  -- If the thread was soft-deleted, drop its post bodies from the index too.
  DELETE FROM forum_search WHERE thread_id = NEW.id AND kind = 'body' AND NEW.deleted_at IS NOT NULL;
END;

CREATE TRIGGER forum_search_post_insert
  AFTER INSERT ON forum_post
  WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT INTO forum_search (thread_id, post_id, kind, text) VALUES (NEW.thread_id, NEW.id, 'body', NEW.body_md);
END;

CREATE TRIGGER forum_search_post_update
  AFTER UPDATE OF body_md, deleted_at ON forum_post
BEGIN
  DELETE FROM forum_search WHERE post_id = NEW.id AND kind = 'body';
  INSERT INTO forum_search (thread_id, post_id, kind, text)
    SELECT NEW.thread_id, NEW.id, 'body', NEW.body_md WHERE NEW.deleted_at IS NULL;
END;
