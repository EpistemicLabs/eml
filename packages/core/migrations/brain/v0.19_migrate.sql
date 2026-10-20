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
-- Data (nothing disappears silently — a value either finds its field, becomes
-- an edge or an entry, or stays readable in detail / the journal):
--   (0) malformed properties first: '' becomes NULL; anything that is not a
--       JSON object is wrapped as {"legacy_properties": <raw text>} so the
--       JSON steps below can run and the raw text reaches (j).
--   (a) significance is reset to normal (the pre-migration backup keeps the
--       old values; a deterministic rule comes later).
--   (b) properties.source_id is split by meaning: a known author (an agent or
--       user id, or <agent>-claude-code, normalised to <agent>) fills
--       ingested_by where it is empty; a software marker (cockpit-notes,
--       cockpit-review-triage, eml-default-brain) moves to origin. The key
--       leaves only where it now equals ingested_by or was moved to origin;
--       any other value (another author, session titles and the like) reaches
--       (j). properties.source_type is dropped when it says agent (the
--       default) or system next to a marker that went to origin; user
--       reaches (j).
--   (c) existing task entries become kind note, the server-written ones
--       ("<type> taken|written: <label> (<id>)") kind change.
--   (d) properties.review_note on an active decision / rule / profile becomes
--       a review entry; on any other engram it reaches (j).
--   (e) renames: reference source_url / url → source, researched_at /
--       accessed_at → checked_at; event change_type launched → released; a
--       decision's alternatives given as one string become a list.
--   (f) a profile titled <id> or <id>-identity in agent.<id> / user.<id> is
--       the scope's core profile (core: true; the newest one if several); a
--       core key from v0.18 free properties is cleared first.
--   (g) the cockpit notes pane's user_content_hash moves to properties.app.
--   (h) supersedes edges: properties.supersedes / superseded_by (one id or a
--       list) become relations where the value is an existing id of a
--       superseded engram; the key leaves only when every value got its edge,
--       else it reaches (j). A superseded status without an incoming edge is
--       linked from the next newer status in its scope.
--   (i) obsolete keys are dropped: boot (the v0.18 boot list; rules by scope
--       replace it).
--   (j) every other key the type does not have becomes a note entry on a task
--       (dated from a _YYYY_MM_DD suffix in the key when that is a real date,
--       else updated_at; entry id <task id>-prop-<key>) and a "key: value"
--       line in detail on every other type.
--   Projects: metadata is rebuilt with every value as text (lists and objects
--       as their JSON), metadata that is not an object becomes {"legacy": …};
--       tags go to metadata.tags (project_tags when tags is taken).
--
-- Needs SQLite ≥ 3.44 (group_concat … ORDER BY); better-sqlite3 ships 3.53.
--
-- foreign_keys MUST be OFF while this runs (the forward-migration runner and
-- database.ts runMigrateWithFkOff handle it): with FKs on, DROP TABLE engrams
-- would cascade-delete every row that references it.
-- ============================================================

BEGIN TRANSACTION;

-- ---------- malformed properties (0) ----------
-- Everything below reads properties as JSON. '' is nothing; a value that is
-- not a JSON object is kept as text under legacy_properties, so (j) can
-- show it instead of json_each yielding a NULL key.
UPDATE engrams SET properties = NULL WHERE properties = '';
UPDATE engrams SET properties = json_object('legacy_properties', properties)
 WHERE properties IS NOT NULL
   AND CASE WHEN NOT json_valid(properties) THEN 1 WHEN json_type(properties) <> 'object' THEN 1 ELSE 0 END;

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

-- known authors: the source_id value → the handle that goes into ingested_by
-- (<agent>-claude-code is the agent)
CREATE TEMP TABLE v019_authors (id TEXT PRIMARY KEY, author TEXT NOT NULL);
INSERT OR IGNORE INTO v019_authors (id, author) SELECT id, id FROM agents;
INSERT OR IGNORE INTO v019_authors (id, author) SELECT id, id FROM users;
INSERT OR IGNORE INTO v019_authors (id, author) SELECT id || '-claude-code', id FROM agents;

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
       THEN (SELECT a.author FROM v019_authors a WHERE a.id = json_extract(properties, '$.source_id'))
       ELSE ingested_by END,
  ingestion_method, session_id, NULL, NULL, created_at, updated_at
FROM engrams
ORDER BY rowid;

-- A software marker has found its home in origin, an author in ingested_by
-- (only where it is the same author — a second one reaches (j)); source_type
-- agent was the default and says nothing, system says what origin now says
-- (the v0.17 / v0.18 seed rules), user reaches (j).
UPDATE engrams_v019
   SET properties = json_remove(properties, '$.source_id')
 WHERE json_extract(properties, '$.source_id') IN ('cockpit-notes', 'cockpit-review-triage', 'eml-default-brain')
    OR (SELECT a.author FROM v019_authors a WHERE a.id = json_extract(properties, '$.source_id')) = ingested_by;
UPDATE engrams_v019 SET properties = json_remove(properties, '$.source_type')
 WHERE json_extract(properties, '$.source_type') = 'agent'
    OR (json_extract(properties, '$.source_type') = 'system' AND origin IS NOT NULL);

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
-- Only the types with a review cycle, and only while they are active: a
-- review confirms a live decision / rule / profile. Everywhere else the note
-- is history and reaches (j).
INSERT INTO entries (id, engram_id, kind, at, author, text)
SELECT id || '-review-note', id, 'review', strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), ingested_by,
       json_extract(properties, '$.review_note')
FROM engrams
WHERE status = 'active' AND type IN ('decision', 'rule', 'profile')
  AND json_type(properties, '$.review_note') = 'text' AND trim(json_extract(properties, '$.review_note')) <> '';

UPDATE engrams SET properties = json_remove(properties, '$.review_note')
 WHERE status = 'active' AND type IN ('decision', 'rule', 'profile')
   AND json_type(properties, '$.review_note') = 'text' AND trim(json_extract(properties, '$.review_note')) <> '';

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
-- core was no field in v0.18; a stray value would collide with the unique
-- index below, so the convention decides alone.
UPDATE engrams SET properties = json_remove(properties, '$.core')
 WHERE type = 'profile' AND json_type(properties, '$.core') IS NOT NULL;

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

CREATE UNIQUE INDEX idx_engrams_core_profile ON engrams(scope)
  WHERE type = 'profile' AND status = 'active' AND json_extract(properties, '$.core') = 1;

-- ---------- app state of the notes pane (g) ----------
UPDATE engrams
   SET properties = json_set(json_remove(properties, '$.user_content_hash'), '$.app',
         json_object('user_content_hash', json_extract(properties, '$.user_content_hash')))
 WHERE origin IS NOT NULL AND json_extract(properties, '$.user_content_hash') IS NOT NULL;

-- ---------- supersedes edges (h) ----------
-- Every pair the two keys name: supersedes points from the engram to each
-- value, superseded_by from each value to the engram. One id or a list; a
-- value that is not text (a number, a nested list) names nothing.
CREATE TEMP TABLE v019_supersedes AS
SELECT e.id AS holder, 'supersedes' AS via, e.id AS src, j.value AS tgt, e.updated_at AS at
FROM engrams e, json_each(CASE WHEN json_type(e.properties, '$.supersedes') = 'array'
                               THEN json_extract(e.properties, '$.supersedes')
                               ELSE json_array(json_extract(e.properties, '$.supersedes')) END) j
WHERE json_type(e.properties, '$.supersedes') IN ('text', 'array') AND j.type = 'text'
UNION ALL
SELECT e.id, 'superseded_by', j.value, e.id, e.updated_at
FROM engrams e, json_each(CASE WHEN json_type(e.properties, '$.superseded_by') = 'array'
                               THEN json_extract(e.properties, '$.superseded_by')
                               ELSE json_array(json_extract(e.properties, '$.superseded_by')) END) j
WHERE json_type(e.properties, '$.superseded_by') IN ('text', 'array') AND j.type = 'text';

-- The edge, where both ends exist and the target is in fact superseded. The
-- id is deterministic (a preflight on a copy and the live run agree); the
-- UNIQUE on (source, target, relation) keeps an existing edge.
INSERT OR IGNORE INTO relations (id, source_id, target_id, relation, detection_method, strength, explanation, created_at)
SELECT p.src || '-supersedes-' || p.tgt, p.src, p.tgt, 'supersedes', 'agent_declared', 1.0,
       'v0.19 migration: from properties.' || p.via, coalesce(p.at, datetime('now'))
FROM v019_supersedes p
WHERE p.src <> p.tgt
  AND EXISTS (SELECT 1 FROM engrams s WHERE s.id = p.src)
  AND EXISTS (SELECT 1 FROM engrams t WHERE t.id = p.tgt AND t.status = 'superseded')
ORDER BY p.via DESC, p.holder, p.tgt, p.src;

-- The key leaves only when every value it names has its edge now; a title,
-- an id prefix or a live target stays and reaches (j).
UPDATE engrams SET properties = json_remove(properties, '$.supersedes')
 WHERE json_type(properties, '$.supersedes') IN ('text', 'array')
   AND NOT EXISTS (
     SELECT 1 FROM v019_supersedes p WHERE p.holder = engrams.id AND p.via = 'supersedes'
        AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.source_id = p.src AND r.target_id = p.tgt AND r.relation = 'supersedes'))
   AND NOT EXISTS (
     SELECT 1 FROM json_each(CASE WHEN json_type(engrams.properties, '$.supersedes') = 'array'
                                  THEN json_extract(engrams.properties, '$.supersedes')
                                  ELSE json_array(json_extract(engrams.properties, '$.supersedes')) END) j
      WHERE j.type <> 'text');
UPDATE engrams SET properties = json_remove(properties, '$.superseded_by')
 WHERE json_type(properties, '$.superseded_by') IN ('text', 'array')
   AND NOT EXISTS (
     SELECT 1 FROM v019_supersedes p WHERE p.holder = engrams.id AND p.via = 'superseded_by'
        AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.source_id = p.src AND r.target_id = p.tgt AND r.relation = 'supersedes'))
   AND NOT EXISTS (
     SELECT 1 FROM json_each(CASE WHEN json_type(engrams.properties, '$.superseded_by') = 'array'
                                  THEN json_extract(engrams.properties, '$.superseded_by')
                                  ELSE json_array(json_extract(engrams.properties, '$.superseded_by')) END) j
      WHERE j.type <> 'text');

DROP TABLE v019_supersedes;

-- A status is superseded by the next status in its scope: the first newer one
-- (created_at, then rowid) is the successor where no edge says otherwise. The
-- newest superseded status of a scope has no successor and keeps its finding.
INSERT OR IGNORE INTO relations (id, source_id, target_id, relation, detection_method, strength, explanation, created_at)
SELECT s.id || '-supersedes-' || o.id, s.id, o.id, 'supersedes', 'auto_temporal', 1.0,
       'v0.19 migration: the next newer status in the scope', s.created_at
FROM engrams o JOIN engrams s ON s.id = (
       SELECT n.id FROM engrams n
       WHERE n.type = 'status' AND n.scope = o.scope AND n.id <> o.id
         AND (n.created_at > o.created_at OR (n.created_at = o.created_at AND n.rowid > o.rowid))
       ORDER BY n.created_at, n.rowid LIMIT 1)
WHERE o.type = 'status' AND o.status = 'superseded'
  AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.target_id = o.id AND r.relation = 'supersedes')
ORDER BY o.rowid;

-- ---------- obsolete keys (i) ----------
-- boot was the v0.18 boot list; rules by scope replace it and the value says
-- nothing anyone will look up.
UPDATE engrams SET properties = json_remove(properties, '$.boot')
 WHERE json_type(properties, '$.boot') IS NOT NULL;

-- ---------- keys without a field (j) ----------
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
-- change entry of where the task came from. The entry id carries -prop- so it
-- cannot meet the -review-note entry of (d) or an id a key spells.
INSERT INTO entries (id, engram_id, kind, at, author, stage, text)
SELECT x.id || '-prop-' || x.key, x.id,
       CASE WHEN x.key = 'source_id' THEN 'change' ELSE 'note' END,
       CASE WHEN x.key = 'source_id' THEN strftime('%Y-%m-%dT%H:%M:%fZ', e.created_at)
            WHEN x.key GLOB '*[0-9][0-9][0-9][0-9][-_][0-9][0-9][-_][0-9][0-9]'
             AND date(replace(substr(x.key, -10), '_', '-')) = replace(substr(x.key, -10), '_', '-')
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
  CASE WHEN tags_text IS NULL THEN metadata_text
       WHEN json_type(coalesce(metadata_text, '{}'), '$.tags') IS NULL
       THEN json_set(coalesce(metadata_text, '{}'), '$.tags', tags_text)
       ELSE json_set(metadata_text, '$.project_tags', tags_text) END,
  NULL, created_at, updated_at
FROM (
  -- metadata with every value as text (a list or object as its JSON); what is
  -- no JSON object at all is kept under legacy
  SELECT p.*,
         CASE WHEN p.metadata IS NULL OR p.metadata = '' THEN NULL
              WHEN NOT json_valid(p.metadata) THEN json_object('legacy', p.metadata)
              WHEN json_type(p.metadata) <> 'object' THEN json_object('legacy', p.metadata)
              ELSE (SELECT json_group_object(j.key,
                             CASE WHEN j.type IN ('object', 'array') THEN json(j.value) || ''
                                  WHEN j.type = 'true' THEN 'true' WHEN j.type = 'false' THEN 'false'
                                  WHEN j.type = 'null' THEN 'null' ELSE CAST(j.value AS TEXT) END)
                    FROM json_each(p.metadata) j) END AS metadata_text,
         CASE WHEN json_valid(p.tags) AND json_type(p.tags) = 'array' AND json_array_length(p.tags) > 0
              THEN (SELECT group_concat(value, ', ') FROM json_each(p.tags)) END AS tags_text
  FROM projects p
);

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
