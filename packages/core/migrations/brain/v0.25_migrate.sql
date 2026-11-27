-- ============================================================
-- EML v0.24 → v0.25 Migration
--
-- Schema 25 (asks and check-backs are separate): a task's schedule is its own
-- field, not part of its delegation — who works on a task and when someone
-- looks again are separate, and a hand-over no longer touches the schedule.
-- The wake-up names who it is for: by, a handle (src/task-state.ts). No table
-- changes; this step moves the stored schedules, so every task holds the new
-- shape from the first op at 25 on:
--   · properties.delegation.schedule becomes properties.schedule, its keys in
--     their stored order: crons, at, why, by, by_session, time_zone, paused,
--     ends_at;
--   · a schedule with a wake-up (at) gets by = the delegation's agent: at 24
--     only the delegated agent's runner fired a wake-up;
--   · delegation keeps agent, checkpoint and requested_at.
-- A schedule schema 24 stored always has crons or at (task-state.ts refused
-- one without). A task without a delegation.schedule is left alone.
-- No other field changes, and neither rev nor updated_at: the task states what
-- it stated before. Every device derives the same rows (json_patch drops the
-- keys that are NULL and keeps the order given; json_set appends schedule as
-- the last key of properties; no clock, no random value, no rowid order). A
-- second run finds no delegation.schedule and changes nothing.
--
-- Right after this file, in the same transaction, the runner writes the
-- checkpoint a rebuild at schema 25 starts from (database.ts applyMigration;
-- a shared brain's comes through its relay).
--
-- No BEGIN/COMMIT: the runner runs a migrate file, its ledger row and the
-- checkpoint in one transaction.
-- ============================================================

UPDATE engrams
   SET properties = json_remove(json_set(properties, '$.schedule', json(json_patch('{}', json_object(
         'crons', json(json_extract(properties, '$.delegation.schedule.crons')),
         'at', json_extract(properties, '$.delegation.schedule.at'),
         'why', CASE WHEN json_type(properties, '$.delegation.schedule.at') = 'text'
                     THEN json_extract(properties, '$.delegation.schedule.why') END,
         'by', CASE WHEN json_type(properties, '$.delegation.schedule.at') = 'text'
                         AND json_type(properties, '$.delegation.agent') = 'text'
                    THEN json_extract(properties, '$.delegation.agent') END,
         'by_session', CASE WHEN json_type(properties, '$.delegation.schedule.at') = 'text'
                            THEN json_extract(properties, '$.delegation.schedule.by_session') END,
         'time_zone', json_extract(properties, '$.delegation.schedule.time_zone'),
         'paused', json(CASE json_type(properties, '$.delegation.schedule.paused')
                             WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' END),
         'ends_at', json_extract(properties, '$.delegation.schedule.ends_at')
       )))), '$.delegation.schedule')
 WHERE type = 'task'
   AND json_valid(properties)
   AND json_type(properties, '$.delegation.schedule') = 'object';
