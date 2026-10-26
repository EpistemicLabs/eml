-- ============================================================
-- EML v0.20 → v0.21 Migration
--
-- Schema 21 goes with the local op log (release F2): every brain write becomes
-- an op in an ordered, hash-chained log in the brain file, and the brain can
-- be rebuilt from it. This step only adds the two tables; no existing row
-- changes, so there is no hygiene check. Right after this file, in the same
-- transaction, the runner writes the log's genesis — seq 1 with a snapshot of
-- the brain as it is now (database.ts applyMigration).
--
-- No BEGIN/COMMIT: the runner runs a migrate file, its ledger row and the
-- genesis in one transaction, so a crash leaves the brain at 20 or at 21 with
-- its genesis, never in between.
-- ============================================================

-- The op log (v0.21): every brain write in order, hash-chained. An entry's
-- link hashes the previous link, its seq, its time and its payload's hash
-- (decision op-log-chain-covers-seq-and-time); payload is the op's envelope
-- {op_id, schema, call, args, provenance} as canonical JSON (log/op.ts).
-- seq 1 is the brain's genesis: the state the log starts from, kept in
-- op_snapshots. Entries are never changed or removed (decision
-- op-log-no-redaction).
CREATE TABLE op_log (
  seq           INTEGER PRIMARY KEY,          -- 1, 2, … without gaps; 1 = genesis
  at            TEXT NOT NULL,                -- the op's time, ISO-8601 UTC ms; every row it writes carries it
  op_id         TEXT NOT NULL UNIQUE,
  prev_hash     TEXT NOT NULL,                -- hash of seq - 1; 64 zeros for seq 1
  payload_hash  TEXT NOT NULL,                -- sha256 of payload, hex
  hash          TEXT NOT NULL,                -- sha256 of prev_hash, seq, at, payload_hash
  signature     BLOB,                         -- the author device's signature over payload_hash (shared brains); NULL in a private brain
  payload       TEXT NOT NULL
);

-- The brain's state after op `seq` (log/snapshot.ts): every state table as
-- gzipped canonical JSON, with the hash of that JSON.
CREATE TABLE op_snapshots (
  seq           INTEGER PRIMARY KEY REFERENCES op_log(seq),
  schema        INTEGER NOT NULL,
  state_hash    TEXT NOT NULL,
  data          BLOB NOT NULL
);
