-- ============================================================
-- EML v0.18 → v0.19 Migration
--
-- Schema 19 goes with the v0.19 tool surface (one create tool per engram
-- type, strict fields enforced in core, no free properties). Everything here
-- is a deterministic rewrite; what needs judgement is a brain-hygiene check
-- (core hygiene.ts, since_schema 19).
--
-- Tables:
--   - engrams rebuilt: type `learning`, ingestion_method `mcp`, provenance
--     columns origin / model / harness, indexes on origin and session_id, one
--     active core profile per scope (partial unique index).
--   - task_entries → entries: one append-only table for a task's journal
--     (note / change), a learning's evidence and review confirmations.
--   - tags.status, entities.status / metadata / status_tracks,
--     projects.status_tracks; projects.tags dropped (values → metadata.tags).
--
-- Data:
--   (a) significance is reset to normal (the pre-migration backup keeps the
--       old values; a deterministic rule comes later).
--   (b) properties.source_id is split by meaning: a known author (an agent or
--       user id, or <agent>-claude-code) fills ingested_by where it is empty;
--       a software marker (cockpit-notes, cockpit-review-triage,
--       eml-default-brain) moves to origin; any other value (session titles
--       and the like) stays as a "source_id: …" line in detail (tasks: a
--       change entry). properties.source_type is dropped.
--   (c) existing task entries become kind note, the server-written ones
--       ("<type> taken|written: <label> (<id>)") kind change.
--   (d) properties.review_note becomes a review entry.
--   (e) renames: reference source_url / url → source, researched_at /
--       accessed_at → checked_at; event change_type launched → released; a
--       decision's alternatives given as one string become a list.
--   (f) a profile titled <id> or <id>-identity in agent.<id> / user.<id> is
--       the scope's core profile (core: true; the newest one if several).
--   (g) the cockpit notes pane's user_content_hash moves to properties.app.
--   (h) obsolete keys are dropped: boot, decision_type, profile_type,
--       reference_type, applies_to, supersedes (the edge holds it),
--       translated_*, backfilled_*, renamed_*, recalibrated_*.
--   (i) every other key the type does not have becomes a note entry on a task
--       (dated from a _YYYY_MM_DD suffix in the key, else updated_at) and a
--       "key: value" line in detail on every other type.
--
-- foreign_keys MUST be OFF while this runs (the forward-migration runner and
-- database.ts runMigrateWithFkOff handle it): with FKs on, DROP TABLE engrams
-- would cascade-delete every row that references it.
-- ============================================================

BEGIN TRANSACTION;

-- ---------- field model of schema 19 (what each type keeps in properties) ----------
CREATE TEMP TABLE v019_fields (type TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (type, key));
INSERT INTO v019_fields (type, key) VALUES
  ('decision', 'rationale'), ('decision', 'alternatives'), ('decision', 'binding'),
  ('decision', 'expires_at'), ('decision', 'review_due_at'), ('decision', 'detail'),
  ('rule', 'applies'), ('rule', 'trigger'), ('rule', 'why'), ('rule', 'detail'),
  ('rule', 'agreed'), ('rule', 'rule_type'), ('rule', 'review_due_at'),
  ('profile', 'core'), ('profile', 'detail'), ('profile', 'review_due_at'),
  ('status', 'state'), ('status', 'next_step'), ('status', 'blockers'), ('status', 'detail'),
  ('task', 'context'), ('task', 'priority'), ('task', 'assignee_id'), ('task', 'due_date'),
  ('task', 'blockers'), ('task', 'stage'), ('task', 'outcome'),
  ('event', 'occurred_at'), ('event', 'change_type'), ('event', 'source_url'), ('event', 'detail'),
  ('log', 'what'), ('log', 'landed'), ('log', 'next'), ('log', 'open_threads'), ('log', 'detail'),
  ('reference', 'source'), ('reference', 'source_name'), ('reference', 'checked_at'), ('reference', 'detail'),
  ('note', 'binding'), ('note', 'detail');

CREATE TEMP TABLE v019_authors (id TEXT PRIMARY KEY);
INSERT OR IGNORE INTO v019_authors (id) SELECT id FROM agents;
INSERT OR IGNORE INTO v019_authors (id) SELECT id FROM users;
INSERT OR IGNORE INTO v019_authors (id) SELECT id || '-claude-code' FROM agents;

-- ---------- engrams rebuild (+ origin, + model, + harness; significance reset; (a), (b)) ----------
CREATE TABLE engrams_v019 (
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
                      CHECK(status IN ('planned','active','superseded','invalidated','expired','resolved')),
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
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO engrams_v019 (
  id, type, scope, title, content, status, significance, properties,
  origin, ingested_by, ingestion_method, session_id, model, harness, created_at, updated_at
)
SELECT
  id, type, scope, title, content, status, 'normal', properties,
  CASE WHEN json_extract(properties, '$.source_id') IN ('cockpit-notes', 'cockpit-review-triage', 'eml-default-brain')
       THEN json_extract(properties, '$.source_id') END,
  CASE WHEN (ingested_by IS NULL OR ingested_by = '')
        AND json_extract(properties, '$.source_id') IN (SELECT id FROM v019_authors)
       THEN json_extract(properties, '$.source_id') ELSE ingested_by END,
  ingestion_method, session_id, NULL, NULL, created_at, updated_at
FROM engrams;

-- An author or a software marker has found its home; source_type goes.
UPDATE engrams_v019
   SET properties = json_remove(properties, '$.source_id')
 WHERE json_extract(properties, '$.source_id') IN ('cockpit-notes', 'cockpit-review-triage', 'eml-default-brain')
    OR json_extract(properties, '$.source_id') IN (SELECT id FROM v019_authors);
UPDATE engrams_v019 SET properties = json_remove(properties, '$.source_type')
 WHERE json_extract(properties, '$.source_type') IS NOT NULL;

DROP TABLE engrams;
ALTER TABLE engrams_v019 RENAME TO engrams;

CREATE INDEX idx_engrams_scope            ON engrams(scope);
CREATE INDEX idx_engrams_title            ON engrams(title);
CREATE INDEX idx_engrams_type             ON engrams(type);
CREATE INDEX idx_engrams_status           ON engrams(status);
CREATE INDEX idx_engrams_significance     ON engrams(significance);
CREATE INDEX idx_engrams_created          ON engrams(created_at);
CREATE INDEX idx_engrams_ingested_by      ON engrams(ingested_by);
CREATE INDEX idx_engrams_origin           ON engrams(origin);
CREATE INDEX idx_engrams_session          ON engrams(session_id);

-- ---------- entries (c) ----------
CREATE TABLE entries (
  id          TEXT PRIMARY KEY,
  engram_id   TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK(kind IN ('note','change','evidence','review')),
  at          TEXT NOT NULL,
  author      TEXT,
  session_id  TEXT,
  model       TEXT,
  stage       TEXT,
  text        TEXT NOT NULL,
  source      TEXT CHECK(source IS NULL OR source IN ('user','observed','self')),
  stance      TEXT CHECK(stance IS NULL OR stance IN ('supports','contradicts','declined')),
  quote       TEXT,
  rule_id     TEXT
);
CREATE INDEX idx_entries_engram ON entries(engram_id, at);

INSERT INTO entries (id, engram_id, kind, at, author, stage, text)
SELECT id, task_id,
       CASE WHEN (text GLOB '[a-z]* taken: * (*)' OR text GLOB '[a-z]* written: * (*)')
             AND substr(text, -38, 1) = '(' AND substr(text, -1, 1) = ')'
            THEN 'change' ELSE 'note' END,
       at, author, stage, text
FROM task_entries
ORDER BY rowid;

DROP INDEX IF EXISTS idx_task_entries_task;
DROP TABLE task_entries;

-- Entries the migration adds get a deterministic id (the engram id plus a
-- suffix), so a preflight on a copy and the live run produce the same rows.

-- ---------- review_note → review entry (d) ----------
INSERT INTO entries (id, engram_id, kind, at, author, text)
SELECT id || '-review-note', id, 'review', strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), ingested_by,
       json_extract(properties, '$.review_note')
FROM engrams
WHERE json_type(properties, '$.review_note') = 'text' AND trim(json_extract(properties, '$.review_note')) <> '';

UPDATE engrams SET properties = json_remove(properties, '$.review_note')
 WHERE json_type(properties, '$.review_note') = 'text' AND trim(json_extract(properties, '$.review_note')) <> '';

-- ---------- renames (e) ----------
-- reference: source_url / url → source (source_url first; a second, different
-- url stays a key of its own and lands in detail below).
UPDATE engrams
   SET properties = json_set(properties, '$.source', coalesce(json_extract(properties, '$.source_url'), json_extract(properties, '$.url')))
 WHERE type = 'reference' AND json_extract(properties, '$.source') IS NULL
   AND coalesce(json_extract(properties, '$.source_url'), json_extract(properties, '$.url')) IS NOT NULL;
UPDATE engrams SET properties = json_remove(properties, '$.url')
 WHERE type = 'reference' AND json_extract(properties, '$.url') = json_extract(properties, '$.source');
UPDATE engrams SET properties = json_remove(properties, '$.source_url')
 WHERE type = 'reference' AND json_extract(properties, '$.source_url') = json_extract(properties, '$.source');

-- reference: researched_at / accessed_at → checked_at
UPDATE engrams
   SET properties = json_set(properties, '$.checked_at', coalesce(json_extract(properties, '$.researched_at'), json_extract(properties, '$.accessed_at')))
 WHERE type = 'reference' AND json_extract(properties, '$.checked_at') IS NULL
   AND coalesce(json_extract(properties, '$.researched_at'), json_extract(properties, '$.accessed_at')) IS NOT NULL;
UPDATE engrams SET properties = json_remove(properties, '$.researched_at')
 WHERE type = 'reference' AND json_extract(properties, '$.researched_at') = json_extract(properties, '$.checked_at');
UPDATE engrams SET properties = json_remove(properties, '$.accessed_at')
 WHERE type = 'reference' AND json_extract(properties, '$.accessed_at') = json_extract(properties, '$.checked_at');

-- event: launched → released
UPDATE engrams SET properties = json_set(properties, '$.change_type', 'released')
 WHERE type = 'event' AND json_extract(properties, '$.change_type') = 'launched';

-- decision: alternatives as one string → a list of one
UPDATE engrams SET properties = json_set(properties, '$.alternatives', json_array(json_extract(properties, '$.alternatives')))
 WHERE type = 'decision' AND json_type(properties, '$.alternatives') = 'text';

-- rule: a rule_type outside the list is not a rule_type — it goes to detail
UPDATE engrams
   SET properties = json_set(json_remove(properties, '$.rule_type'), '$.detail',
         CASE WHEN coalesce(json_extract(properties, '$.detail'), '') = ''
              THEN 'rule_type: ' || json_extract(properties, '$.rule_type')
              ELSE json_extract(properties, '$.detail') || char(10) || 'rule_type: ' || json_extract(properties, '$.rule_type') END)
 WHERE type = 'rule' AND json_extract(properties, '$.rule_type') IS NOT NULL
   AND json_extract(properties, '$.rule_type') NOT IN ('constraint', 'process', 'convention', 'behavior', 'security');

-- ---------- core profile (f) ----------
UPDATE engrams
   SET properties = json_set(coalesce(properties, '{}'), '$.core', json('true'))
 WHERE id IN (
   SELECT id FROM (
     SELECT id, row_number() OVER (PARTITION BY scope ORDER BY created_at DESC, id) AS n
     FROM engrams
     WHERE type = 'profile' AND status = 'active'
       AND ((scope LIKE 'agent.%' AND title IN (substr(scope, 7), substr(scope, 7) || '-identity'))
         OR (scope LIKE 'user.%'  AND title IN (substr(scope, 6), substr(scope, 6) || '-identity')))
   ) WHERE n = 1
 );
UPDATE engrams SET properties = json_remove(properties, '$.core')
 WHERE type = 'profile' AND json_extract(properties, '$.core') IS NOT NULL
   AND json_extract(properties, '$.core') <> 1;

CREATE UNIQUE INDEX idx_engrams_core_profile ON engrams(scope)
  WHERE type = 'profile' AND status = 'active' AND json_extract(properties, '$.core') = 1;

-- ---------- app state of the notes pane (g) ----------
UPDATE engrams
   SET properties = json_set(json_remove(properties, '$.user_content_hash'), '$.app',
         json_object('user_content_hash', json_extract(properties, '$.user_content_hash')))
 WHERE origin IS NOT NULL AND json_extract(properties, '$.user_content_hash') IS NOT NULL;

-- ---------- obsolete keys (h) ----------
CREATE TEMP VIEW v019_dropped AS
SELECT e.id AS id, j.key AS key FROM engrams e, json_each(e.properties) j
WHERE j.key IN ('boot', 'decision_type', 'profile_type', 'reference_type', 'applies_to', 'supersedes')
   OR j.key LIKE 'translated\_%' ESCAPE '\'
   OR j.key LIKE 'backfilled\_%' ESCAPE '\'
   OR j.key LIKE 'renamed\_%' ESCAPE '\'
   OR j.key LIKE 'recalibrated\_%' ESCAPE '\';

CREATE TEMP TABLE v019_drop AS SELECT id, key FROM v019_dropped;
UPDATE engrams
   SET properties = (
     SELECT json_group_object(j.key,
              CASE j.type WHEN 'true' THEN json('true') WHEN 'false' THEN json('false') WHEN 'null' THEN json('null')
                          WHEN 'object' THEN json(j.value) WHEN 'array' THEN json(j.value) ELSE j.value END)
     FROM json_each(engrams.properties) j
     WHERE NOT EXISTS (SELECT 1 FROM v019_drop d WHERE d.id = engrams.id AND d.key = j.key)
   )
 WHERE id IN (SELECT id FROM v019_drop);
DROP TABLE v019_drop;
DROP VIEW v019_dropped;

-- ---------- keys without a field (i) ----------
-- Every key the type does not have, with its value as text (a list or object
-- as JSON). `app` is the software's own state and stays where an origin is set.
CREATE TEMP TABLE v019_extra AS
SELECT e.id AS id, e.type AS type, j.key AS key,
       CASE WHEN j.type IN ('object', 'array') THEN json(j.value)
            WHEN j.type = 'true' THEN 'true' WHEN j.type = 'false' THEN 'false'
            WHEN j.type = 'null' THEN 'null' ELSE CAST(j.value AS TEXT) END AS value
FROM engrams e, json_each(e.properties) j
WHERE NOT EXISTS (SELECT 1 FROM v019_fields f WHERE f.type = e.type AND f.key = j.key)
  AND NOT (j.key = 'app' AND e.origin IS NOT NULL);

-- tasks: each key becomes a note entry in the journal; a legacy source_id the
-- change entry of where the task came from.
INSERT INTO entries (id, engram_id, kind, at, author, stage, text)
SELECT x.id || '-' || x.key, x.id,
       CASE WHEN x.key = 'source_id' THEN 'change' ELSE 'note' END,
       CASE WHEN x.key = 'source_id' THEN strftime('%Y-%m-%dT%H:%M:%fZ', e.created_at)
            WHEN x.key GLOB '*[0-9][0-9][0-9][0-9][-_][0-9][0-9][-_][0-9][0-9]'
            THEN replace(substr(x.key, -10), '_', '-') || 'T00:00:00.000Z'
            ELSE strftime('%Y-%m-%dT%H:%M:%fZ', e.updated_at) END,
       e.ingested_by, json_extract(e.properties, '$.stage'),
       CASE WHEN x.key = 'source_id' THEN 'legacy source: ' || x.value ELSE x.key || ': ' || x.value END
FROM v019_extra x JOIN engrams e ON e.id = x.id
WHERE x.type = 'task'
ORDER BY x.id, x.key;

-- every other type: "key: value" lines appended to detail, in key order
UPDATE engrams
   SET properties = json_set(properties, '$.detail',
         CASE WHEN coalesce(json_extract(properties, '$.detail'), '') = ''
              THEN (SELECT group_concat(x.key || ': ' || x.value, char(10) ORDER BY x.key) FROM v019_extra x WHERE x.id = engrams.id)
              ELSE json_extract(properties, '$.detail') || char(10) ||
                   (SELECT group_concat(x.key || ': ' || x.value, char(10) ORDER BY x.key) FROM v019_extra x WHERE x.id = engrams.id) END)
 WHERE type <> 'task' AND id IN (SELECT id FROM v019_extra);

-- then the keys leave properties
UPDATE engrams
   SET properties = (
     SELECT json_group_object(j.key,
              CASE j.type WHEN 'true' THEN json('true') WHEN 'false' THEN json('false') WHEN 'null' THEN json('null')
                          WHEN 'object' THEN json(j.value) WHEN 'array' THEN json(j.value) ELSE j.value END)
     FROM json_each(engrams.properties) j
     WHERE NOT EXISTS (SELECT 1 FROM v019_extra x WHERE x.id = engrams.id AND x.key = j.key)
   )
 WHERE id IN (SELECT id FROM v019_extra);

DROP TABLE v019_extra;

-- ---------- projects rebuild: - tags (→ metadata.tags), + status_tracks ----------
DROP INDEX IF EXISTS idx_projects_status;
DROP INDEX IF EXISTS idx_projects_parent;

CREATE TABLE projects_v019 (
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
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO projects_v019 (
  id, name, status, goal, description, owner, parent_project, started_at, ended_at, metadata, status_tracks, created_at, updated_at
)
SELECT
  id, name, status, goal, description, owner, parent_project, started_at, ended_at,
  CASE WHEN json_valid(tags) AND json_type(tags) = 'array' AND json_array_length(tags) > 0
       THEN json_set(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.tags',
              (SELECT group_concat(value, ', ') FROM json_each(projects.tags)))
       ELSE metadata END,
  NULL, created_at, updated_at
FROM projects;

DROP TABLE projects;
ALTER TABLE projects_v019 RENAME TO projects;

CREATE INDEX idx_projects_status          ON projects(status);
CREATE INDEX idx_projects_parent          ON projects(parent_project);

-- ---------- entities rebuild: + status, + metadata, + status_tracks ----------
CREATE TABLE entities_v019 (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK(kind IN ('person','org','asset')),
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK(status IN ('active','archived')),
  description         TEXT,
  metadata            TEXT,
  status_tracks       TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO entities_v019 (id, name, kind, status, description, metadata, status_tracks, created_at, updated_at)
SELECT id, name, kind, 'active', description, NULL, NULL, created_at, updated_at FROM entities;

DROP TABLE entities;
ALTER TABLE entities_v019 RENAME TO entities;

-- ---------- tags rebuild: + status ----------
CREATE TABLE tags_v019 (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','archived')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO tags_v019 (id, name, description, status, created_at)
SELECT id, name, description, 'active', created_at FROM tags;

DROP TABLE tags;
ALTER TABLE tags_v019 RENAME TO tags;

DROP TABLE v019_fields;
DROP TABLE v019_authors;

INSERT OR IGNORE INTO _eml_migrations (version, name) VALUES (19, '019_v0.19');

COMMIT;
