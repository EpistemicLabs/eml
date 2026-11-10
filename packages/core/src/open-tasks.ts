import { TASK_INACTIVITY_DAYS } from './types'
import { addDays } from './env'

// v0.15: the one definition of "open tasks in a scope" — boot/show dashboards
// (EngramStore.buildBrainState) and the project brain-state (ProjectStore) both
// read it. Open = planned + active (TASK_OPEN_STATUSES); ordered by priority,
// then due date, then last activity — the newer of the task's own update and
// its latest journal entry, most recent first (v0.18.3: was age, oldest first,
// which put the oldest tasks on top since most tasks share priority normal).
//
// v0.19.1: a planned task without movement for TASK_INACTIVITY_DAYS is backlog
// (decision review-per-type, task task-backlog-computed). Computed, never stored:
// the lists below leave it out and count it apart; search and eml_list still
// find it, and any movement (a patch or an entry) brings it back.

/**
 * The last movement of task `alias`: the later of its own update and its newest
 * entry. v0.20: every timestamp is ISO-8601 UTC ms, so text order is time order.
 */
export function lastMovementSql(alias: string): string {
  return `MAX(${alias}.updated_at, COALESCE((SELECT MAX(te.at) FROM entries te WHERE te.engram_id = ${alias}.id), ${alias}.updated_at))`
}

/** A task last moved before this is idle: the read's clock minus TASK_INACTIVITY_DAYS. */
export function inactivityCutoff(now: string): string {
  return addDays(now, -TASK_INACTIVITY_DAYS)
}

const LAST_MOVEMENT = lastMovementSql('e')

/** Task `e` is backlog: planned and not moved for TASK_INACTIVITY_DAYS. Binds inactivityCutoff(now). */
export const BACKLOG_SQL = `(e.status = 'planned' AND ${LAST_MOVEMENT} < ?)`

// The three queries below bind (scope, inactivityCutoff(now)).

/** How many open tasks outside the backlog a scope has (the list below stops at 10). */
export const OPEN_TASKS_COUNT_SQL = `
  SELECT COUNT(*) AS n FROM engrams e WHERE e.scope = ? AND e.type = 'task' AND e.status IN ('planned', 'active')
    AND NOT ${BACKLOG_SQL}
`

/** How many tasks of a scope are backlog. */
export const BACKLOG_COUNT_SQL = `
  SELECT COUNT(*) AS n FROM engrams e WHERE e.scope = ? AND e.type = 'task' AND ${BACKLOG_SQL}
`

export const OPEN_TASKS_IN_SCOPE_SQL = `
  SELECT e.* FROM engrams e
  WHERE e.scope = ? AND e.type = 'task'
    AND e.status IN ('planned', 'active')
    AND NOT ${BACKLOG_SQL}
  ORDER BY
    CASE json_extract(e.properties, '$.priority')
      WHEN 'urgent' THEN 4
      WHEN 'high'   THEN 3
      WHEN 'normal' THEN 2
      WHEN 'low'    THEN 1
      ELSE 2  -- no priority reads as normal, as every list shows it
    END DESC,
    COALESCE(json_extract(e.properties, '$.due_date'), '9999-12-31') ASC,
    ${LAST_MOVEMENT} DESC,
    e.ord DESC
  LIMIT 10
`

/** The line that names the backlog and the call that lists it (boot, eml_show, project block). */
export function backlogLine(n: number, scope: string): string {
  return `- ${n} in backlog (planned, no movement for ${TASK_INACTIVITY_DAYS} days) — eml_list type=task scope=${scope} status=planned`
}
