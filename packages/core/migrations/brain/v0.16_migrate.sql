-- ============================================================
-- EML v0.15 → v0.16 Migration
--
-- The epistemic mode is removed (docs/specs/v0.16-PROPOSAL.md §3, §I.1): the
-- five epistemic types (observation, hypothesis, assessment, prediction,
-- pattern), the `mode` column and the `evaluates` relation verb.
--
-- (a) Data first, so the copies below pass the new CHECKs:
--     - every epistemic engram becomes a `note`; its former type is kept in
--       properties.original_epistemic_type. Content, status, scope, tags,
--       labels, relations and timestamps are unchanged; nothing is deleted.
--     - `evaluates` edges become `related_to`. UNIQUE(source_id, target_id,
--       relation) may already hold a related_to edge for the same pair: then
--       the evaluates edge is redundant and dropped (UPDATE OR IGNORE + DELETE).
--
-- (b) `engrams` rebuild without `mode` and with the nine-type CHECK; explicit
--     column list (as in v0.14), indexes recreated without idx_engrams_mode.
--     engrams_fts is keyed by id and does not carry mode; engram_tags,
--     engram_labels, engram_themes and task_entries reference engrams(id) and
--     the ids are unchanged.
--
-- (c) `relations` rebuild without `evaluates` in the CHECK (pattern of
--     v0.15_migrate.sql).
--
-- foreign_keys MUST be OFF while this runs (the forward-migration runner and
-- database.ts runMigrateWithFkOff handle it): with FKs on, DROP TABLE engrams
-- would cascade-delete every row that references it.
-- ============================================================

BEGIN TRANSACTION;

-- ---------- (a) data ----------
UPDATE engrams
   SET properties = json_set(coalesce(properties, '{}'), '$.original_epistemic_type', type),
       type = 'note'
 WHERE type IN ('observation','hypothesis','assessment','prediction','pattern');

UPDATE OR IGNORE relations SET relation = 'related_to' WHERE relation = 'evaluates';
DELETE FROM relations WHERE relation = 'evaluates';

-- ---------- (b) engrams rebuild: - mode, - epistemic types ----------
CREATE TABLE engrams_v016 (
  -- ============ Identity ============
  id                  TEXT PRIMARY KEY,

  -- ============ Categorization (Type → Scope/Subject) ============
  type                TEXT NOT NULL
                      CHECK(type IN (
                        'decision','rule','profile','status',
                        'task','event','log',
                        'reference',
                        'note'
                      )),
  scope               TEXT NOT NULL,
  subject             TEXT,

  -- ============ Content ============
  content             TEXT NOT NULL,

  -- ============ Lifecycle ============
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK(status IN ('planned','active','superseded','invalidated','expired','resolved')),
  significance        TEXT NOT NULL DEFAULT 'normal'
                      CHECK(significance IN ('critical','high','normal','low','trivial')),

  -- ============ Type-specific Properties (validated by application layer) ============
  properties          TEXT,

  -- ============ Ingestion (technical audit trail) ============
  ingested_by         TEXT,
  ingestion_method    TEXT
                      CHECK(ingestion_method IS NULL OR ingestion_method IN ('hook','direct','bulk','other')),
  session_id          TEXT,

  -- ============ Timestamps ============
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO engrams_v016 (
  id, type, scope, subject, content, status, significance, properties,
  ingested_by, ingestion_method, session_id, created_at, updated_at
)
SELECT
  id, type, scope, subject, content, status, significance, properties,
  ingested_by, ingestion_method, session_id, created_at, updated_at
FROM engrams;

DROP TABLE engrams;
ALTER TABLE engrams_v016 RENAME TO engrams;

CREATE INDEX idx_engrams_scope            ON engrams(scope);
CREATE INDEX idx_engrams_subject          ON engrams(subject);
CREATE INDEX idx_engrams_type             ON engrams(type);
CREATE INDEX idx_engrams_status           ON engrams(status);
CREATE INDEX idx_engrams_significance     ON engrams(significance);
CREATE INDEX idx_engrams_created          ON engrams(created_at);
CREATE INDEX idx_engrams_ingested_by      ON engrams(ingested_by);

-- ---------- (c) relations rebuild: - evaluates ----------
DROP INDEX IF EXISTS idx_relations_source;
DROP INDEX IF EXISTS idx_relations_target;
DROP INDEX IF EXISTS idx_relations_type;

CREATE TABLE relations_v016 (
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
                      CHECK(detection_method IN ('manual','agent_declared','auto_subject','auto_temporal','auto_semantic')),
  strength            REAL NOT NULL DEFAULT 1.0,
  explanation         TEXT,
  metadata            TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_id, target_id, relation)
);

INSERT INTO relations_v016
  (id, source_id, target_id, relation, detection_method, strength, explanation, metadata, created_at)
SELECT
  id, source_id, target_id, relation, detection_method, strength, explanation, metadata, created_at
FROM relations;

DROP TABLE relations;
ALTER TABLE relations_v016 RENAME TO relations;

CREATE INDEX idx_relations_source         ON relations(source_id);
CREATE INDEX idx_relations_target         ON relations(target_id);
CREATE INDEX idx_relations_type           ON relations(relation);

INSERT OR IGNORE INTO _eml_migrations (version, name) VALUES (16, '016_v0.16');

COMMIT;
