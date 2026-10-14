-- EML v0.14 → v0.15 Migration
--
-- Staged tasks (docs/specs/v0.15-PROPOSAL.md §3–§4, §I.1):
--
-- (a) `part_of` relation (child task → parent task). The verb is guarded by a
--     CHECK constraint; SQLite cannot alter a CHECK, so `relations` is rebuilt:
--     new table → copy (explicit column list) → drop → rename → indexes. The
--     detection_method CHECK and UNIQUE(source_id, target_id, relation) stay as
--     they are. Precedent: v0.9_migrate.sql §2. relations has no FK and nothing
--     references it, so the rebuild touches nothing else.
--
-- (b) `task_entries`: the append-only journal of a task (progress, step backs,
--     hand-off notes). Own table, not a properties array (parallel sessions
--     would lose entries on read-modify-write) and not engrams (would flood
--     recall/boot). Additive. FK to engrams with ON DELETE CASCADE — from now on
--     any `engrams` rebuild must run with foreign_keys OFF (the runners do).
--
-- `stage` and `outcome` are task properties — no `engrams` rebuild.
-- ============================================================

BEGIN TRANSACTION;

-- ---------- (a) relations rebuild: + part_of ----------
DROP INDEX IF EXISTS idx_relations_source;
DROP INDEX IF EXISTS idx_relations_target;
DROP INDEX IF EXISTS idx_relations_type;

CREATE TABLE relations_v015 (
  id                  TEXT PRIMARY KEY,
  source_id           TEXT NOT NULL,
  target_id           TEXT NOT NULL,
  relation            TEXT NOT NULL
                      CHECK(relation IN (
                        'supports','contradicts','supersedes',
                        'derived_from','evaluates','refines','related_to',
                        'blocks','part_of'
                      )),
  detection_method    TEXT NOT NULL
                      CHECK(detection_method IN ('manual','agent_declared','auto_subject','auto_temporal','auto_semantic')),
  strength            REAL NOT NULL DEFAULT 1.0,
  explanation         TEXT,
  metadata            TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_id, target_id, relation)
);

INSERT INTO relations_v015
  (id, source_id, target_id, relation, detection_method, strength, explanation, metadata, created_at)
SELECT
  id, source_id, target_id, relation, detection_method, strength, explanation, metadata, created_at
FROM relations;

DROP TABLE relations;
ALTER TABLE relations_v015 RENAME TO relations;

CREATE INDEX idx_relations_source         ON relations(source_id);
CREATE INDEX idx_relations_target         ON relations(target_id);
CREATE INDEX idx_relations_type           ON relations(relation);

-- ---------- (b) task_entries ----------
CREATE TABLE IF NOT EXISTS task_entries (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,                  -- ISO-8601, set by the server
  author      TEXT,                           -- ingested-by handle of the caller (NULL in-process)
  stage       TEXT,                           -- stage at the time of the entry (or the new stage)
  text        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_entries_task ON task_entries(task_id, at);

INSERT OR IGNORE INTO _eml_migrations (version, name) VALUES (15, '015_v0.15');

COMMIT;
