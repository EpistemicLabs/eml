-- ============================================================
-- EML brain schema v0.18 — fresh brain
--
-- The complete schema a new brain starts with (schema 18). Existing brains
-- reach the same schema through the vX.Y_migrate.sql chain; a test checks that
-- both paths end in an identical schema.
-- ============================================================

BEGIN TRANSACTION;

CREATE TABLE agents (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  parent_id           TEXT,
  domains             TEXT,
  description         TEXT,
  metadata            TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  email               TEXT,
  description         TEXT,
  metadata            TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_email              ON users(email);

CREATE TABLE entities (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK(kind IN ('person','org','asset')),
  description         TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE projects (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK(status IN ('active','paused','archived')),
  goal                TEXT,
  description         TEXT,
  owner               TEXT,
  parent_project      TEXT REFERENCES projects(id),
  tags                TEXT,
  started_at          TEXT,
  ended_at            TEXT,
  metadata            TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_projects_status          ON projects(status);
CREATE INDEX idx_projects_parent          ON projects(parent_project);

CREATE TABLE engrams (
  -- ============ Identity ============
  id                  TEXT PRIMARY KEY,

  -- ============ Categorization (Type → Scope/Title) ============
  type                TEXT NOT NULL
                      CHECK(type IN (
                        'decision','rule','profile','status',
                        'task','event','log',
                        'reference',
                        'note'
                      )),
  scope               TEXT NOT NULL,
  title               TEXT,

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
CREATE INDEX idx_engrams_scope            ON engrams(scope);
CREATE INDEX idx_engrams_title            ON engrams(title);
CREATE INDEX idx_engrams_type             ON engrams(type);
CREATE INDEX idx_engrams_status           ON engrams(status);
CREATE INDEX idx_engrams_significance     ON engrams(significance);
CREATE INDEX idx_engrams_created          ON engrams(created_at);
CREATE INDEX idx_engrams_ingested_by      ON engrams(ingested_by);

CREATE TABLE relations (
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
CREATE INDEX idx_relations_source         ON relations(source_id);
CREATE INDEX idx_relations_target         ON relations(target_id);
CREATE INDEX idx_relations_type           ON relations(relation);

CREATE VIRTUAL TABLE engrams_fts USING fts5(
  id UNINDEXED,
  content,
  scope,
  title
);

CREATE TABLE tags (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE engram_tags (
  engram_id     TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
  tag_id        TEXT NOT NULL REFERENCES tags(id)     ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (engram_id, tag_id)
);
CREATE INDEX idx_engram_tags_tag    ON engram_tags(tag_id);
CREATE INDEX idx_engram_tags_engram ON engram_tags(engram_id);

CREATE TABLE labels (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE engram_labels (
  engram_id     TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
  label_id      TEXT NOT NULL REFERENCES labels(id)  ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (engram_id, label_id)
);
CREATE INDEX idx_engram_labels_label  ON engram_labels(label_id);
CREATE INDEX idx_engram_labels_engram ON engram_labels(engram_id);

CREATE TABLE subjects (
  id          TEXT PRIMARY KEY,               -- slug of name (same slugify as tags/labels)
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active'  -- 'active' | 'closed'
                CHECK (status IN ('active','closed')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE engram_subjects (
  engram_id   TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
  subject_id  TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (engram_id, subject_id)
);
CREATE INDEX idx_engram_subjects_subject ON engram_subjects(subject_id);
CREATE INDEX idx_engram_subjects_engram  ON engram_subjects(engram_id);

CREATE TABLE task_entries (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,                  -- ISO-8601, set by the server
  author      TEXT,                           -- ingested-by handle of the caller (NULL in-process)
  stage       TEXT,                           -- stage at the time of the entry (or the new stage)
  text        TEXT NOT NULL
);
CREATE INDEX idx_task_entries_task ON task_entries(task_id, at);

CREATE TABLE _eml_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO labels (id, name, description, created_at) VALUES ('review', 'review', 'Flagged for re-check: an active decision/rule/profile whose review_due_at has passed. Stamped by the nightly deterministic sweep; cleared on confirmReview / supersede / invalidate.', datetime('now'));

INSERT INTO _eml_migrations (version, name) VALUES (18, '018_v0.18');

COMMIT;
