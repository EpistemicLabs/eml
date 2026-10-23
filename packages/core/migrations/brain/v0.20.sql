-- ============================================================
-- EML brain schema v0.20 — fresh brain
--
-- The complete schema a new brain starts with (schema 20). Existing brains
-- reach the same schema through the vX.Y_migrate.sql chain; a test checks that
-- both paths end in an identical schema.
--
-- Schema 20 (sync-ready write path): every timestamp is written by the
-- application, ISO-8601 UTC with milliseconds — no column defaults the clock
-- would fill; the migration runner writes the ledger row. engrams.rev is the
-- revision counter.
--
-- No BEGIN/COMMIT: the runner (database.ts) runs this file and the ledger row
-- in one transaction.
-- ============================================================

CREATE TABLE agents (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  parent_id           TEXT,
  domains             TEXT,
  description         TEXT,
  metadata            TEXT,
  created_at          TEXT NOT NULL
);

CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  email               TEXT,
  description         TEXT,
  metadata            TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_users_email              ON users(email);

CREATE TABLE entities (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK(kind IN ('person','org','asset')),
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK(status IN ('active','archived')),
  description         TEXT,
  metadata            TEXT,
  status_tracks       TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
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
  started_at          TEXT,
  ended_at            TEXT,
  metadata            TEXT,
  status_tracks       TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
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
                        'note',
                        'learning'
                      )),
  scope               TEXT NOT NULL,
  title               TEXT,

  -- ============ Content ============
  content             TEXT NOT NULL,

  -- ============ Lifecycle ============
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK(status IN ('planned','active','superseded','invalidated','resolved')),
  significance        TEXT NOT NULL DEFAULT 'normal'
                      CHECK(significance IN ('critical','high','normal','low','trivial')),

  -- ============ Type-specific Properties (validated by application layer) ============
  properties          TEXT,

  -- ============ Provenance ============
  origin              TEXT,                   -- the software that wrote it (cockpit-notes, …); NULL for agent writes
  ingested_by         TEXT,
  ingestion_method    TEXT
                      CHECK(ingestion_method IS NULL OR ingestion_method IN ('hook','direct','bulk','mcp','other')),
  session_id          TEXT,                   -- stamped by the server on every write (v0.19)
  model               TEXT,                   -- the model that wrote it, when the server can know it
  harness             TEXT,                   -- the MCP client (claude-code, codex, …)

  -- ============ Timestamps ============
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,

  -- ============ Revision (v0.20) ============
  -- 1 on create, +1 on every write that changes the row; engram.update and
  -- task.track take an optional base_rev precondition (decision engram-revision-counter)
  rev                 INTEGER NOT NULL
);
CREATE INDEX idx_engrams_scope            ON engrams(scope);
CREATE INDEX idx_engrams_title            ON engrams(title);
CREATE INDEX idx_engrams_type             ON engrams(type);
CREATE INDEX idx_engrams_status           ON engrams(status);
CREATE INDEX idx_engrams_significance     ON engrams(significance);
CREATE INDEX idx_engrams_created          ON engrams(created_at);
CREATE INDEX idx_engrams_ingested_by      ON engrams(ingested_by);
CREATE INDEX idx_engrams_origin           ON engrams(origin);
CREATE INDEX idx_engrams_session          ON engrams(session_id);
-- One core profile (the identity the boot loads) per scope among active engrams.
CREATE UNIQUE INDEX idx_engrams_core_profile ON engrams(scope)
  WHERE type = 'profile' AND status = 'active' AND json_extract(properties, '$.core') = 1;

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
  created_at          TEXT NOT NULL,
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
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','archived')),
  created_at    TEXT NOT NULL
);

CREATE TABLE engram_tags (
  engram_id     TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
  tag_id        TEXT NOT NULL REFERENCES tags(id)     ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (engram_id, tag_id)
);
CREATE INDEX idx_engram_tags_tag    ON engram_tags(tag_id);
CREATE INDEX idx_engram_tags_engram ON engram_tags(engram_id);

CREATE TABLE subjects (
  id          TEXT PRIMARY KEY,               -- slug of name (same slugify as tags)
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active'  -- 'active' | 'closed'
                CHECK (status IN ('active','closed')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE engram_subjects (
  engram_id   TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
  subject_id  TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (engram_id, subject_id)
);
CREATE INDEX idx_engram_subjects_subject ON engram_subjects(subject_id);
CREATE INDEX idx_engram_subjects_engram  ON engram_subjects(engram_id);

-- An engram's append-only entries (v0.19, was task_entries): a task's journal
-- (note = written by the agent, change = written by the server), a learning's
-- evidence, the review confirmations of a decision, rule or profile.
CREATE TABLE entries (
  id          TEXT PRIMARY KEY,
  engram_id   TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK(kind IN ('note','change','evidence','review')),
  at          TEXT NOT NULL,                  -- ISO-8601, set by the server
  author      TEXT,                           -- ingested-by handle of the caller (NULL in-process)
  session_id  TEXT,
  model       TEXT,
  stage       TEXT,                           -- task: stage at the time of the entry (or the new stage)
  text        TEXT NOT NULL,
  source      TEXT CHECK(source IS NULL OR source IN ('user','observed','self')),        -- evidence
  stance      TEXT CHECK(stance IS NULL OR stance IN ('supports','contradicts','declined')), -- evidence
  quote       TEXT,                           -- evidence: the user's words, verbatim
  rule_id     TEXT                            -- evidence: the rule the incident concerns
);
CREATE INDEX idx_entries_engram ON entries(engram_id, at);

CREATE TABLE _eml_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL
);
