-- ============================================================
-- EML v0.22 → v0.23 Migration
--
-- Schema 23 (task state) adds what the cockpit's task model needs, and
-- removes or narrows nothing:
--
-- - runs: one session working on a task (src/runs.ts), written only by the
--   member it names, on real events only (no heartbeat). A new state table.
-- - task.delegation ({ agent, checkpoint?, requested_at?, schedule? })
--   and task.waits ([{ id, who, kind?, why?, since?, session_id?, snoozed_until? }]): new task
--   fields. Core keeps delegation mirrored with delegate/checkpoint and
--   waiting_on as the most urgent of waits on every task write
--   (src/task-state.ts). This step brings every existing task into that
--   state, so the mirror holds for every task from the first op at 23 on:
--     · a task with a delegate gets delegation { agent: delegate,
--       checkpoint (when it is one of before · after · none) } — never a
--       requested_at or a schedule: only the cockpit's migration pass, which
--       its owner has seen as a dry run, decides which task the runner may
--       start; a checkpoint without a delegate stays as it is, without a
--       delegation;
--     · a task waiting on someone (waiting_on with a who) gets waits with that
--       one wait: id = its session_id (else "waiting_on"), who, kind (when it
--       is one of review · question · go · stopped · outside), why and
--       session_id as text, since when it is an ISO-8601 UTC timestamp with
--       milliseconds (what the cockpit writes).
--   No other field changes, and neither rev nor updated_at: the step adds the
--   shape the fields already state. Every device derives the same rows
--   (json_patch drops the keys that are NULL and keeps the order given).
--
-- Right after this file, in the same transaction, the runner writes the
-- checkpoint a rebuild at schema 23 starts from (database.ts applyMigration;
-- a shared brain's comes through its relay).
--
-- No BEGIN/COMMIT: the runner runs a migrate file, its ledger row and the
-- checkpoint in one transaction.
-- ============================================================

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

UPDATE engrams
   SET properties = json_set(properties, '$.delegation', json(json_patch('{}', json_object(
         'agent', json_extract(properties, '$.delegate'),
         'checkpoint', CASE WHEN json_extract(properties, '$.checkpoint') IN ('before', 'after', 'none')
                            AND json_type(properties, '$.checkpoint') = 'text'
                            THEN json_extract(properties, '$.checkpoint') END
       ))))
 WHERE type = 'task'
   AND json_valid(properties)
   AND json_type(properties, '$.delegate') = 'text'
   AND json_extract(properties, '$.delegate') <> ''
   AND json_type(properties, '$.delegation') IS NULL;

UPDATE engrams
   SET properties = json_set(properties, '$.waits', json_array(json(json_patch('{}', json_object(
         'id', CASE WHEN json_type(properties, '$.waiting_on.session_id') = 'text'
                     AND trim(json_extract(properties, '$.waiting_on.session_id')) <> ''
                    THEN json_extract(properties, '$.waiting_on.session_id') ELSE 'waiting_on' END,
         'who', json_extract(properties, '$.waiting_on.who'),
         'kind', CASE WHEN json_type(properties, '$.waiting_on.kind') = 'text'
                       AND json_extract(properties, '$.waiting_on.kind') IN ('question', 'go', 'stopped', 'review', 'outside')
                      THEN json_extract(properties, '$.waiting_on.kind') END,
         'why', CASE WHEN json_type(properties, '$.waiting_on.why') = 'text' THEN json_extract(properties, '$.waiting_on.why') END,
         'since', CASE WHEN json_type(properties, '$.waiting_on.since') = 'text'
                        AND json_extract(properties, '$.waiting_on.since')
                            GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
                       THEN json_extract(properties, '$.waiting_on.since') END,
         'session_id', CASE WHEN json_type(properties, '$.waiting_on.session_id') = 'text' THEN json_extract(properties, '$.waiting_on.session_id') END
       )))))
 WHERE type = 'task'
   AND json_valid(properties)
   AND json_type(properties, '$.waiting_on') = 'object'
   AND json_type(properties, '$.waiting_on.who') = 'text'
   AND trim(json_extract(properties, '$.waiting_on.who')) <> ''
   AND json_type(properties, '$.waits') IS NULL;
