-- ============================================================
-- EML v0.19 → v0.20 Migration
--
-- Schema 20 goes with the sync-ready write path (release F1): every brain
-- write is one command, a deterministic function of the brain, the command
-- and its env (clock, ids, actor). Everything here is a deterministic
-- rewrite; nothing needs judgement, so there is no hygiene check.
--
-- Tables:
--   - every brain table with a timestamp is rebuilt without its
--     DEFAULT (datetime('now')) — the application writes every timestamp —
--     and its timestamps rewritten to ISO-8601 UTC with milliseconds
--     (SQLite's 'YYYY-MM-DD HH:MM:SS' is UTC, so the rewrite is lossless);
--     entries.at is rewritten in place. The migration ledger keeps its default.
--   - engrams: rev (revision counter, every engram at 1); the status
--     `expired` is gone — expired engrams become invalidated (decision
--     drop-expired-status); properties.expires_at removed;
--     properties.review_due_at rewritten to ISO-8601 UTC ms (a date alone
--     becomes T00:00:00.000Z).
--   - labels and engram_labels dropped (decision drop-labels-axis): review_due
--     is computed at read time.
--
-- A value strftime() cannot read is kept as it was; the release audit
-- (scripts/audit-brain-migration.mjs) counts what is not ISO afterwards.
--
-- foreign_keys MUST be OFF while this runs (the forward-migration runner and
-- database.ts runMigrateWithFkOff handle it): with FKs on, DROP TABLE engrams
-- would cascade-delete every row that references it. engrams_fts is a
-- standalone FTS5 table keyed by id; the rebuild leaves it as it is.
-- ============================================================

BEGIN TRANSACTION;

-- ---------- agents ----------
CREATE TABLE agents_v020 (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  parent_id           TEXT,
  domains             TEXT,
  description         TEXT,
  metadata            TEXT,
  created_at          TEXT NOT NULL
);

INSERT INTO agents_v020 (id, name, parent_id, domains, description, metadata, created_at)
SELECT
  id,
  name,
  parent_id,
  domains,
  description,
  metadata,
  COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at), created_at)
FROM agents;

DROP TABLE agents;
ALTER TABLE agents_v020 RENAME TO agents;

-- ---------- users ----------
CREATE TABLE users_v020 (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  email               TEXT,
  description         TEXT,
  metadata            TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

INSERT INTO users_v020 (id, name, email, description, metadata, created_at, updated_at)
SELECT
  id,
  name,
  email,
  description,
  metadata,
  COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at), created_at),
  COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), updated_at)
FROM users;

DROP TABLE users;
ALTER TABLE users_v020 RENAME TO users;
CREATE INDEX idx_users_email              ON users(email);

-- ---------- entities ----------
CREATE TABLE entities_v020 (
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

INSERT INTO entities_v020 (id, name, kind, status, description, metadata, status_tracks, created_at, updated_at)
SELECT
  id,
  name,
  kind,
  status,
  description,
  metadata,
  status_tracks,
  COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at), created_at),
  COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), updated_at)
FROM entities;

DROP TABLE entities;
ALTER TABLE entities_v020 RENAME TO entities;

-- ---------- projects ----------
CREATE TABLE projects_v020 (
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

INSERT INTO projects_v020 (id, name, status, goal, description, owner, parent_project, started_at, ended_at, metadata, status_tracks, created_at, updated_at)
SELECT
  id,
  name,
  status,
  goal,
  description,
  owner,
  parent_project,
  started_at,
  ended_at,
  metadata,
  status_tracks,
  COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at), created_at),
  COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), updated_at)
FROM projects;

DROP TABLE projects;
ALTER TABLE projects_v020 RENAME TO projects;
CREATE INDEX idx_projects_status          ON projects(status);
CREATE INDEX idx_projects_parent          ON projects(parent_project);

-- ---------- engrams ----------
CREATE TABLE engrams_v020 (
  id                  TEXT PRIMARY KEY,
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
  content             TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK(status IN ('planned','active','superseded','invalidated','resolved')),
  significance        TEXT NOT NULL DEFAULT 'normal'
                      CHECK(significance IN ('critical','high','normal','low','trivial')),
  properties          TEXT,
  origin              TEXT,
  ingested_by         TEXT,
  ingestion_method    TEXT
                      CHECK(ingestion_method IS NULL OR ingestion_method IN ('hook','direct','bulk','mcp','other')),
  session_id          TEXT,
  model               TEXT,
  harness             TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  rev                 INTEGER NOT NULL
);

INSERT INTO engrams_v020 (id, type, scope, title, content, status, significance, properties, origin, ingested_by, ingestion_method, session_id, model, harness, created_at, updated_at, rev)
SELECT
  id,
  type,
  scope,
  title,
  content,
  CASE WHEN status = 'expired' THEN 'invalidated' ELSE status END,
  significance,
  CASE WHEN properties IS NULL OR NOT json_valid(properties) THEN properties
       ELSE json_remove(CASE WHEN json_type(properties, '$.review_due_at') = 'text'
                 THEN json_set(properties, '$.review_due_at', COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(properties, '$.review_due_at')), json_extract(properties, '$.review_due_at')))
                 ELSE properties END, '$.expires_at') END,
  origin,
  ingested_by,
  ingestion_method,
  session_id,
  model,
  harness,
  COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at), created_at),
  COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), updated_at),
  1
FROM engrams;

DROP TABLE engrams;
ALTER TABLE engrams_v020 RENAME TO engrams;
CREATE INDEX idx_engrams_scope            ON engrams(scope);
CREATE INDEX idx_engrams_title            ON engrams(title);
CREATE INDEX idx_engrams_type             ON engrams(type);
CREATE INDEX idx_engrams_status           ON engrams(status);
CREATE INDEX idx_engrams_significance     ON engrams(significance);
CREATE INDEX idx_engrams_created          ON engrams(created_at);
CREATE INDEX idx_engrams_ingested_by      ON engrams(ingested_by);
CREATE INDEX idx_engrams_origin           ON engrams(origin);
CREATE INDEX idx_engrams_session          ON engrams(session_id);
CREATE UNIQUE INDEX idx_engrams_core_profile ON engrams(scope)
  WHERE type = 'profile' AND status = 'active' AND json_extract(properties, '$.core') = 1;

-- ---------- relations ----------
CREATE TABLE relations_v020 (
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

INSERT INTO relations_v020 (id, source_id, target_id, relation, detection_method, strength, explanation, metadata, created_at)
SELECT
  id,
  source_id,
  target_id,
  relation,
  detection_method,
  strength,
  explanation,
  metadata,
  COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at), created_at)
FROM relations;

DROP TABLE relations;
ALTER TABLE relations_v020 RENAME TO relations;
CREATE INDEX idx_relations_source         ON relations(source_id);
CREATE INDEX idx_relations_target         ON relations(target_id);
CREATE INDEX idx_relations_type           ON relations(relation);

-- ---------- tags ----------
CREATE TABLE tags_v020 (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','archived')),
  created_at    TEXT NOT NULL
);

INSERT INTO tags_v020 (id, name, description, status, created_at)
SELECT
  id,
  name,
  description,
  status,
  COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at), created_at)
FROM tags;

DROP TABLE tags;
ALTER TABLE tags_v020 RENAME TO tags;

-- ---------- engram_tags ----------
CREATE TABLE engram_tags_v020 (
  engram_id     TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
  tag_id        TEXT NOT NULL REFERENCES tags(id)     ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (engram_id, tag_id)
);

INSERT INTO engram_tags_v020 (engram_id, tag_id, created_at)
SELECT
  engram_id,
  tag_id,
  COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at), created_at)
FROM engram_tags;

DROP TABLE engram_tags;
ALTER TABLE engram_tags_v020 RENAME TO engram_tags;
CREATE INDEX idx_engram_tags_tag    ON engram_tags(tag_id);
CREATE INDEX idx_engram_tags_engram ON engram_tags(engram_id);

-- ---------- subjects ----------
CREATE TABLE subjects_v020 (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','closed')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

INSERT INTO subjects_v020 (id, name, description, status, created_at, updated_at)
SELECT
  id,
  name,
  description,
  status,
  COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at), created_at),
  COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), updated_at)
FROM subjects;

DROP TABLE subjects;
ALTER TABLE subjects_v020 RENAME TO subjects;

-- ---------- engram_subjects ----------
CREATE TABLE engram_subjects_v020 (
  engram_id   TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
  subject_id  TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (engram_id, subject_id)
);

INSERT INTO engram_subjects_v020 (engram_id, subject_id, created_at)
SELECT
  engram_id,
  subject_id,
  COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at), created_at)
FROM engram_subjects;

DROP TABLE engram_subjects;
ALTER TABLE engram_subjects_v020 RENAME TO engram_subjects;
CREATE INDEX idx_engram_subjects_subject ON engram_subjects(subject_id);
CREATE INDEX idx_engram_subjects_engram  ON engram_subjects(engram_id);

-- ---------- entries: timestamps to ISO-8601 UTC ms (no default to drop) ----------
UPDATE entries SET at = COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', at), at);

-- ---------- labels axis gone ----------
DROP TABLE engram_labels;
DROP TABLE labels;

INSERT OR IGNORE INTO _eml_migrations (version, name) VALUES (20, '020_v0.20');

COMMIT;
