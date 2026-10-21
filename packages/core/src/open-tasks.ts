// v0.15: the one definition of "open tasks in a scope" — boot/show dashboards
// (EngramStore.buildBrainState) and the project brain-state (ProjectStore) both
// read it. Open = planned + active (TASK_OPEN_STATUSES); ordered by priority,
// then due date, then last activity — the newer of the task's own update and
// its latest journal entry, most recent first (v0.18.3: was age, oldest first,
// which put the oldest tasks on top since most tasks share priority normal).
/** How many open tasks a scope has (the list above stops at 10). */
export const OPEN_TASKS_COUNT_SQL = `
  SELECT COUNT(*) AS n FROM engrams WHERE scope = ? AND type = 'task' AND status IN ('planned', 'active')
`

export const OPEN_TASKS_IN_SCOPE_SQL = `
  SELECT e.* FROM engrams e
  WHERE e.scope = ? AND e.type = 'task'
    AND e.status IN ('planned', 'active')
  ORDER BY
    CASE json_extract(e.properties, '$.priority')
      WHEN 'urgent' THEN 4
      WHEN 'high'   THEN 3
      WHEN 'normal' THEN 2
      WHEN 'low'    THEN 1
      ELSE 2  -- no priority reads as normal, as every list shows it
    END DESC,
    COALESCE(json_extract(e.properties, '$.due_date'), '9999-12-31') ASC,
    MAX(
      datetime(e.updated_at),
      COALESCE(datetime((SELECT MAX(te.at) FROM entries te WHERE te.engram_id = e.id)), datetime(e.updated_at))
    ) DESC
  LIMIT 10
`
