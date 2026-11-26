-- ============================================================
-- EML v0.23 → v0.24 Migration
--
-- Schema 24 (a task holds its schedule): a task's delegation.schedule is the
-- one place its schedule lives — a list of repeating times and at most one
-- wake-up: { crons?, at?, why?, by_session?, time_zone?, paused?, ends_at? }
-- (src/task-state.ts). The single cron and session (new · resume) of schema 23
-- are gone. No table changes; this step rewrites the stored schedules, so
-- every task holds the new shape from the first op at 24 on:
--   · cron (a text that is not blank) becomes crons with that one entry,
--     without the white space around it;
--   · at (text), time_zone (text that is not blank) and paused (true · false)
--     stay as they are;
--   · session and every other key are dropped;
--   · the keys end in their stored order: crons, at, time_zone, paused.
-- A schedule with neither a cron nor an at (no write of schema 23 stored one)
-- is no schedule and is removed.
-- No other field changes, and neither rev nor updated_at: the schedule states
-- what it stated before. Every device derives the same rows (json_patch drops
-- the keys that are NULL and keeps the order given; json_set replaces the
-- schedule in its place).
--
-- Right after this file, in the same transaction, the runner writes the
-- checkpoint a rebuild at schema 24 starts from (database.ts applyMigration;
-- a shared brain's comes through its relay).
--
-- No BEGIN/COMMIT: the runner runs a migrate file, its ledger row and the
-- checkpoint in one transaction.
-- ============================================================

UPDATE engrams
   SET properties = json_remove(properties, '$.delegation.schedule')
 WHERE type = 'task'
   AND json_valid(properties)
   AND json_type(properties, '$.delegation.schedule') IS NOT NULL
   AND NOT coalesce(json_type(properties, '$.delegation.schedule.at') = 'text', 0)
   AND NOT coalesce(json_type(properties, '$.delegation.schedule.cron') = 'text'
                    AND trim(json_extract(properties, '$.delegation.schedule.cron')) <> '', 0);

UPDATE engrams
   SET properties = json_set(properties, '$.delegation.schedule', json(json_patch('{}', json_object(
         'crons', json(CASE WHEN json_type(properties, '$.delegation.schedule.cron') = 'text'
                             AND trim(json_extract(properties, '$.delegation.schedule.cron')) <> ''
                            THEN json_array(trim(json_extract(properties, '$.delegation.schedule.cron'))) END),
         'at', CASE WHEN json_type(properties, '$.delegation.schedule.at') = 'text'
                    THEN json_extract(properties, '$.delegation.schedule.at') END,
         'time_zone', CASE WHEN json_type(properties, '$.delegation.schedule.time_zone') = 'text'
                            AND trim(json_extract(properties, '$.delegation.schedule.time_zone')) <> ''
                           THEN json_extract(properties, '$.delegation.schedule.time_zone') END,
         'paused', json(CASE json_type(properties, '$.delegation.schedule.paused')
                             WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' END)
       ))))
 WHERE type = 'task'
   AND json_valid(properties)
   AND json_type(properties, '$.delegation.schedule') IS NOT NULL;
