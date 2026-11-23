-- ============================================================
-- EML v0.21 → v0.22 Migration
--
-- Schema 22 goes with the cockpit's task system: a task may carry depends_on,
-- checkpoint, waiting_on, goal and delegate, and display_title — the name a
-- person reads in a list, next to the kebab title that stays the recall anchor.
-- They live in properties (fields.ts), so no table changes. The step exists
-- because what a logged op may carry changed: a replica on schema 21 refuses
-- these fields, so a shared brain crosses to 22 on every member before such an
-- op is written. Right after this file, in the same transaction, the runner
-- writes the checkpoint a rebuild at schema 22 starts from (database.ts
-- applyMigration).
--
-- No BEGIN/COMMIT: the runner owns the transaction.
-- ============================================================

SELECT 1;
