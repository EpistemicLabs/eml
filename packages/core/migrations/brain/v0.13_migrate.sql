-- v0.13 — Labels: a controlled WORKFLOW/ROLE facet on engrams.
-- Decision: labels-axis-review (656aba63). Task: labels-axis-mvp (c7ee7e6f).
--
-- Orthogonal to tags (v0.12): a TAG answers "what is this about" (theme), a
-- LABEL answers "what function does this entry serve right now" (role/state:
-- review, later pinned/verified/...). Structurally a clone of the tags axis
-- (registry + junction), but labels drive SURFACING + lifecycle, not clustering.
--
-- Additive-only: two new tables, no existing table touched. Labels are STORED
-- junction rows (not derived-on-read) and multi-per-engram, exactly like tags.
--
-- MVP writer: the nightly deterministic date-sweep (packages/server) is the ONLY
-- writer — it stamps `review` on active decision/rule/profile whose
-- review_due_at has passed. No manual write path in this release.

-- Registered label vocabulary. `id` is the normalized slug of `name` (same
-- slugify as tags, done in the app layer). Seeded with the fixed MVP vocab;
-- eml_label_create is deferred, so this is the whole vocabulary for now.
CREATE TABLE IF NOT EXISTS labels (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Engram ↔ label membership. Many-to-many, separate from relations AND from
-- engram_tags. ON DELETE CASCADE keeps the junction consistent (EML has no
-- DELETE endpoints — cleanup is manual — but the DB stays sane).
CREATE TABLE IF NOT EXISTS engram_labels (
  engram_id     TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
  label_id      TEXT NOT NULL REFERENCES labels(id)  ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (engram_id, label_id)
);

CREATE INDEX IF NOT EXISTS idx_engram_labels_label  ON engram_labels(label_id);
CREATE INDEX IF NOT EXISTS idx_engram_labels_engram ON engram_labels(engram_id);

-- Seed the fixed MVP vocabulary: `review` (member #1, the staleness-review flag).
INSERT OR IGNORE INTO labels (id, name, description)
VALUES ('review', 'review', 'Flagged for re-check: an active decision/rule/profile whose review_due_at has passed. Stamped by the nightly deterministic sweep; cleared on confirmReview / supersede / invalidate.');

INSERT OR IGNORE INTO _eml_migrations (version, name) VALUES (13, '013_v0.13');
