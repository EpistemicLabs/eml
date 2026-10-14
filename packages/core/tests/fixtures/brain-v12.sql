-- Test fixture: a brain exactly as schema 12 left it (tags, before labels).
-- Starting point for the migration tests (v0.13 → v0.16); the migration files
-- before v0.13 are not part of this repo. Generated from the old chain.

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
  kind                TEXT NOT NULL CHECK(kind IN ('person','org','asset','subject')),
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

  -- ============ Categorization (Mode → Type → Scope/Subject) ============
  mode                TEXT NOT NULL
                      CHECK(mode IN ('epistemic','context')),
  type                TEXT NOT NULL
                      CHECK(type IN (
                        'observation','hypothesis','assessment','prediction','pattern',
                        'decision','rule','profile','status',
                        'task','event','log',
                        'reference'
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

  -- ============ Ingestion (technische Audit-Spur) ============
  -- v0.9 Cluster 1: the ingested_by column stays (legacy import audit) but is
  -- no longer set from user input.
  ingested_by         TEXT,
  ingestion_method    TEXT
                      CHECK(ingestion_method IS NULL OR ingestion_method IN ('hook','direct','bulk','other')),
  session_id          TEXT,

  -- ============ Timestamps ============
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_engrams_scope            ON engrams(scope);
CREATE INDEX idx_engrams_subject          ON engrams(subject);
CREATE INDEX idx_engrams_type             ON engrams(type);
CREATE INDEX idx_engrams_mode             ON engrams(mode);
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
                        'derived_from','evaluates','refines','related_to',
                        'blocks'
                      )),
  detection_method    TEXT NOT NULL
                      CHECK(detection_method IN ('manual','agent_declared','auto_subject','auto_temporal','auto_semantic')),
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
  subject
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

CREATE TABLE _eml_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);


INSERT INTO _eml_migrations (version, name) VALUES (12, '012_v0.12');

COMMIT;
