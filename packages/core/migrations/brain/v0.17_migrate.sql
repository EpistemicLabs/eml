-- ============================================================
-- EML v0.16 → v0.17 Migration
--
-- A rename, no change in behaviour (decision themes-are-subjects):
--   - the engram field `subject` (the kebab-case recall anchor) becomes `title`;
--   - themes (the cross-scope strands with a lifecycle) become subjects:
--     `themes` → `subjects`, `engram_themes` → `engram_subjects`,
--     `theme_id` → `subject_id`.
-- Dropped because the name `subject` now means the strand, and both were never
-- used: the entity kind `subject` and the relation detection_method
-- `auto_subject` (no code ever wrote it).
--
-- (a) Data first, so the copies below pass the new CHECKs: an entity of kind
--     `subject` becomes `asset`; an `auto_subject` relation becomes `manual`.
-- (b) engrams: RENAME COLUMN subject → title, index renamed.
-- (c) themes → subjects: ALTER TABLE … RENAME keeps the rows and rewrites the
--     REFERENCES in engram_subjects; indexes recreated under the new names.
-- (d) entities + relations rebuilt for the narrower CHECKs (pattern of
--     v0.15_migrate.sql).
-- (e) engrams_fts rebuilt: an FTS5 table cannot rename a column. It holds one
--     row per engram (NULL title stored as '', as the write path does).
--
-- foreign_keys MUST be OFF while this runs (the forward-migration runner and
-- database.ts runMigrateWithFkOff handle it).
-- ============================================================

BEGIN TRANSACTION;

-- ---------- (a) data ----------
UPDATE entities  SET kind = 'asset'              WHERE kind = 'subject';
UPDATE relations SET detection_method = 'manual' WHERE detection_method = 'auto_subject';

-- ---------- (b) engrams: subject → title ----------
DROP INDEX IF EXISTS idx_engrams_subject;
ALTER TABLE engrams RENAME COLUMN subject TO title;
CREATE INDEX idx_engrams_title            ON engrams(title);

-- ---------- (c) themes → subjects ----------
DROP INDEX IF EXISTS idx_engram_themes_theme;
DROP INDEX IF EXISTS idx_engram_themes_engram;
ALTER TABLE themes RENAME TO subjects;
ALTER TABLE engram_themes RENAME TO engram_subjects;
ALTER TABLE engram_subjects RENAME COLUMN theme_id TO subject_id;
CREATE INDEX idx_engram_subjects_subject ON engram_subjects(subject_id);
CREATE INDEX idx_engram_subjects_engram  ON engram_subjects(engram_id);

-- ---------- (d) entities + relations: narrower CHECKs ----------
CREATE TABLE entities_v017 (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK(kind IN ('person','org','asset')),
  description         TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO entities_v017 (id, name, kind, description, created_at, updated_at)
SELECT id, name, kind, description, created_at, updated_at FROM entities;

DROP TABLE entities;
ALTER TABLE entities_v017 RENAME TO entities;

DROP INDEX IF EXISTS idx_relations_source;
DROP INDEX IF EXISTS idx_relations_target;
DROP INDEX IF EXISTS idx_relations_type;

CREATE TABLE relations_v017 (
  id                  TEXT PRIMARY KEY,
  source_id           TEXT NOT NULL,
  target_id           TEXT NOT NULL,
  relation            TEXT NOT NULL
                      CHECK(relation IN (
                        'supports','contradicts','supersedes',
                        'derived_from','refines','related_to',
                        'blocks','part_of'
                      )),
  detection_method    TEXT NOT NULL
                      CHECK(detection_method IN ('manual','agent_declared','auto_temporal','auto_semantic')),
  strength            REAL NOT NULL DEFAULT 1.0,
  explanation         TEXT,
  metadata            TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_id, target_id, relation)
);

INSERT INTO relations_v017
  (id, source_id, target_id, relation, detection_method, strength, explanation, metadata, created_at)
SELECT
  id, source_id, target_id, relation, detection_method, strength, explanation, metadata, created_at
FROM relations;

DROP TABLE relations;
ALTER TABLE relations_v017 RENAME TO relations;

CREATE INDEX idx_relations_source         ON relations(source_id);
CREATE INDEX idx_relations_target         ON relations(target_id);
CREATE INDEX idx_relations_type           ON relations(relation);

-- ---------- (e) engrams_fts: subject → title ----------
DROP TABLE engrams_fts;
CREATE VIRTUAL TABLE engrams_fts USING fts5(
  id UNINDEXED,
  content,
  scope,
  title
);
INSERT INTO engrams_fts (id, content, scope, title)
SELECT id, content, scope, coalesce(title, '') FROM engrams;

INSERT OR IGNORE INTO _eml_migrations (version, name) VALUES (17, '017_v0.17');

COMMIT;
