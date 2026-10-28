-- ============================================================
-- EML v0.20 → v0.21 Migration
--
-- Schema 21 goes with the local op log (release F2): every brain write becomes
-- an op in an ordered, hash-chained log in the brain file, and the brain can
-- be rebuilt from it. This step adds the two log tables and ord — the
-- insertion order — to engrams, relations and entries (rebuilt with it, filled
-- in their current rowid order, so what is shown in which order stays as it
-- is). No value of an existing row changes, so there is no hygiene check.
-- Right after this file, in the same transaction, the runner writes the log's
-- genesis — seq 1 with a snapshot of the brain as it is now (database.ts
-- applyMigration).
--
-- foreign_keys MUST be OFF while this runs (the forward-migration runner and
-- database.ts runMigrateWithFkOff handle it): with FKs on, DROP TABLE engrams
-- would cascade-delete every row that references it. engrams_fts is a
-- standalone FTS5 table keyed by id; the rebuild leaves it as it is.
--
-- No BEGIN/COMMIT: the runner runs a migrate file, its ledger row and the
-- genesis in one transaction, so a crash leaves the brain at 20 or at 21 with
-- its genesis, never in between.
-- ============================================================

-- ---------- engrams ----------
CREATE TABLE engrams_v021 (
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

INSERT INTO engrams_v021 (id, type, scope, title, content, status, significance, properties, origin, ingested_by, ingestion_method, session_id, model, harness, created_at, updated_at, rev, ord)
SELECT id, type, scope, title, content, status, significance, properties, origin, ingested_by, ingestion_method, session_id, model, harness, created_at, updated_at, rev, ROW_NUMBER() OVER (ORDER BY rowid)
FROM engrams
ORDER BY rowid;

DROP TABLE engrams;
ALTER TABLE engrams_v021 RENAME TO engrams;
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

-- ---------- relations ----------
CREATE TABLE relations_v021 (
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
  UNIQUE(source_id, target_id, relation)
);

INSERT INTO relations_v021 (id, source_id, target_id, relation, detection_method, strength, explanation, metadata, created_at, ord)
SELECT id, source_id, target_id, relation, detection_method, strength, explanation, metadata, created_at, ROW_NUMBER() OVER (ORDER BY rowid)
FROM relations
ORDER BY rowid;

DROP TABLE relations;
ALTER TABLE relations_v021 RENAME TO relations;
CREATE INDEX idx_relations_source         ON relations(source_id);
CREATE INDEX idx_relations_target         ON relations(target_id);
CREATE INDEX idx_relations_type           ON relations(relation);
CREATE UNIQUE INDEX idx_relations_ord     ON relations(ord);

-- ---------- entries ----------
CREATE TABLE entries_v021 (
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

INSERT INTO entries_v021 (id, engram_id, kind, at, author, session_id, model, stage, text, source, stance, quote, rule_id, ord)
SELECT id, engram_id, kind, at, author, session_id, model, stage, text, source, stance, quote, rule_id, ROW_NUMBER() OVER (ORDER BY rowid)
FROM entries
ORDER BY rowid;

DROP TABLE entries;
ALTER TABLE entries_v021 RENAME TO entries;
CREATE INDEX idx_entries_engram ON entries(engram_id, at);
CREATE UNIQUE INDEX idx_entries_ord ON entries(ord);

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
