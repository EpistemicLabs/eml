-- ============================================================
-- EML v0.19 → v0.20 Migration
--
-- Schema 20 goes with the sync-ready write path (release F1): every brain
-- write is one command, a deterministic function of the brain, the command
-- and its env (clock, ids, actor).
--
-- Tables:
--   - engrams: rev, the revision counter (decision engram-revision-counter).
--     Every existing engram starts at 1.
-- ============================================================

BEGIN TRANSACTION;

ALTER TABLE engrams ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;

INSERT OR IGNORE INTO _eml_migrations (version, name) VALUES (20, '020_v0.20');

COMMIT;
