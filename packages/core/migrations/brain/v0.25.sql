-- ============================================================
-- EML brain schema v0.25 — fresh brain
--
-- The complete schema a new brain starts with (schema 25). Existing brains
-- reach the same schema through the vX.Y_migrate.sql chain; a test checks that
-- both paths end in an identical schema.
--
-- Schema 25 (asks and check-backs are separate) changes no state table: a
-- task's schedule moves out of its delegation into its own field schedule
-- { crons?, at?, why?, by?, by_session?, time_zone?, paused?, ends_at? }, a
-- wait's kind can be do and a wait carries due — checked in the application
-- (src/fields.ts, src/task-state.ts).
--
-- Schema 24 (a task holds its schedule) changes no state table: a task's
-- delegation.schedule becomes { crons?, at?, why?, by_session?, time_zone?,
-- paused?, ends_at? } — a list of repeating times and at most one wake-up —
-- checked in the application (src/fields.ts, src/task-state.ts).
--
-- Schema 23 (task state): the runs table — one session on a task, written
-- only by the member it names (src/runs.ts) — and the task fields delegation
-- and waits, which core keeps mirrored with delegate/checkpoint and
-- waiting_on (src/task-state.ts). Nothing is removed or narrowed.
--
-- Schema 22 changes no state table. It is the task system's task fields and
-- display_title (packages/core/src/fields.ts), checked in the application, and
-- the contract of a shared brain: what an entry must look like is one contract
-- per schema (contracts/v22.json). op_log gains verdicts, a column of the
-- replica like rejected.
--
-- Schema 20 (sync-ready write path): every timestamp is written by the
-- application, ISO-8601 UTC with milliseconds — no column defaults the clock
-- would fill; the migration runner writes the ledger row. engrams.rev is the
-- revision counter.
--
-- Schema 21 (local op log): op_log and op_snapshots; engrams, relations and
-- entries carry ord, their insertion order. The runner writes the log's
-- genesis after this file (database.ts applyMigration).
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
  agent               TEXT,                   -- the agent that wrote for ingested_by (v0.21); NULL for a human's own write
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
  rev                 INTEGER NOT NULL,

  -- ============ Insertion order (v0.21) ============
  -- 1, 2, … in the order rows were written: the tiebreak for every ordering by
  -- time (a write stamps all its rows with one time), kept by a rebuild from
  -- the log where the rowid is not
  ord                 INTEGER NOT NULL
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
CREATE UNIQUE INDEX idx_engrams_ord       ON engrams(ord);
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
  ord                 INTEGER NOT NULL,           -- insertion order (v0.21), as engrams.ord
  source_brain        TEXT,                       -- the brain holding source_id when it is not this one (v0.21, cross-brain reference)
  target_brain        TEXT,                       -- as source_brain for target_id; at least one end is in this brain
  UNIQUE(source_id, target_id, relation),
  CHECK(source_brain IS NULL OR target_brain IS NULL)
);
CREATE INDEX idx_relations_source         ON relations(source_id);
CREATE INDEX idx_relations_target         ON relations(target_id);
CREATE INDEX idx_relations_type           ON relations(relation);
CREATE UNIQUE INDEX idx_relations_ord     ON relations(ord);

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

-- v0.23: a run — one session working on a task, as its member's cockpit knows
-- it (src/runs.ts). An object, not an engram: no content, not in recall; its
-- start and end are journaled on its task. id is the session id. Fixed after
-- create: id, task_id, member, origin, started_at. No reference to engrams: a
-- run outlives a task that leaves the brain.
CREATE TABLE runs (
  id            TEXT PRIMARY KEY,               -- the session id
  task_id       TEXT NOT NULL,                  -- the task it works on
  member        TEXT NOT NULL,                  -- the member whose session it is; the only one who writes it
  agent         TEXT,                           -- the agent in the session
  origin        TEXT NOT NULL CHECK (origin IN ('user','runner','job')),
  driver        TEXT NOT NULL CHECK (driver IN ('human','agent')),
  state         TEXT NOT NULL CHECK (state IN ('running','idle','ended')),
  started_at    TEXT NOT NULL,                  -- ISO-8601 UTC ms
  last_activity_at TEXT NOT NULL,               -- when something last happened in it (start, a turn end, the end)
  ended_at      TEXT,                           -- set when it ends, cleared on a resume
  end_reason    TEXT CHECK (end_reason IN ('finished','put_away','failed','crashed')),
  result        TEXT,                           -- the result line of its last handoff
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_runs_task ON runs(task_id);

-- An engram's append-only entries (v0.19, was task_entries): a task's journal
-- (note = written by the agent, change = written by the server), a learning's
-- evidence, the review confirmations of a decision, rule or profile.
CREATE TABLE entries (
  id          TEXT PRIMARY KEY,
  engram_id   TEXT NOT NULL REFERENCES engrams(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK(kind IN ('note','change','evidence','review')),
  at          TEXT NOT NULL,                  -- ISO-8601, set by the server
  author      TEXT,                           -- ingested-by handle of the caller (NULL in-process)
  agent       TEXT,                           -- as engrams.agent (v0.21)
  session_id  TEXT,
  model       TEXT,
  stage       TEXT,                           -- task: stage at the time of the entry (or the new stage)
  text        TEXT NOT NULL,
  source      TEXT CHECK(source IS NULL OR source IN ('user','observed','self')),        -- evidence
  stance      TEXT CHECK(stance IS NULL OR stance IN ('supports','contradicts','declined')), -- evidence
  quote       TEXT,                           -- evidence: the user's words, verbatim
  rule_id     TEXT,                           -- evidence: the rule the incident concerns
  ord         INTEGER NOT NULL                -- insertion order (v0.21), as engrams.ord
);
CREATE INDEX idx_entries_engram ON entries(engram_id, at);
CREATE UNIQUE INDEX idx_entries_ord ON entries(ord);

CREATE TABLE _eml_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL
);

-- The op log (v0.21): every brain write in order, hash-chained. An entry's
-- link hashes the previous link, its seq, its time and its payload's hash
-- (decision op-log-chain-covers-seq-and-time); payload is the op's envelope
-- {op_id, schema, call, args, provenance[, team]} as JSON in the caller's key order
-- (protocol op.ts). A shared brain keeps every relayed record at its seq: one
-- it refused stays in the chain as rejected, and one that did not open has
-- canonicalJson of the record as its payload (PROTOCOL.md §4).
-- seq 1 is the brain's genesis: the state the log starts from, kept in
-- op_snapshots. Entries are never changed or removed (decision
-- op-log-no-redaction).
CREATE TABLE op_log (
  seq           INTEGER PRIMARY KEY,          -- 1, 2, … without gaps; 1 = genesis
  at            TEXT NOT NULL,                -- the op's time, ISO-8601 UTC ms; every row it writes carries it
  op_id         TEXT,                         -- NULL only for a rejected record that names no valid op_id
  prev_hash     TEXT NOT NULL,                -- hash of seq - 1; 64 zeros for seq 1
  payload_hash  TEXT NOT NULL,                -- sha256 of payload, hex
  hash          TEXT NOT NULL,                -- sha256 of prev_hash, seq, at, payload_hash
  signature     BLOB,                         -- the author device's signature over payload_hash (shared brains); NULL in a private brain
  rejected      TEXT,                         -- NULL = applied; else why the replica refused it (shared brains): outside the hash and the state
  payload       TEXT NOT NULL,
  verdicts      TEXT,                         -- shared brains: sha256 chain (64 hex) over this replica's applied / rejected verdicts up to this entry; NULL for entries taken before a build fills it; outside the hash and the state
  CHECK (op_id IS NOT NULL OR rejected IS NOT NULL)
);
-- An op_id occurs once in a log (decision shared-log-rejected-entries): the
-- index holds it for applied entries; a replica refuses a record whose op_id
-- is in the log at all, applied or rejected, and keeps it as rejected.
CREATE UNIQUE INDEX idx_op_log_op_id ON op_log(op_id) WHERE rejected IS NULL;
CREATE INDEX idx_op_log_op_id_any ON op_log(op_id);

-- The brain's state after op `seq` (log/snapshot.ts): every state table as
-- gzipped canonical JSON, with the hash of that JSON.
CREATE TABLE op_snapshots (
  seq           INTEGER PRIMARY KEY REFERENCES op_log(seq),
  schema        INTEGER NOT NULL,
  state_hash    TEXT NOT NULL,
  data          BLOB NOT NULL
);
