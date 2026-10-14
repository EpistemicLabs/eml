// v0.15: the one definition of "open tasks in a scope" — boot/show dashboards
// (EngramStore.buildBrainState) and the project brain-state (ProjectStore) both
// read it. Open = planned + active (TASK_OPEN_STATUSES); ordered by priority,
// then due date, then age.
export const OPEN_TASKS_IN_SCOPE_SQL = `
  SELECT * FROM engrams
  WHERE scope = ? AND type = 'task'
    AND status IN ('planned', 'active')
  ORDER BY
    CASE json_extract(properties, '$.priority')
      WHEN 'urgent' THEN 4
      WHEN 'high'   THEN 3
      WHEN 'normal' THEN 2
      WHEN 'low'    THEN 1
      ELSE 0
    END DESC,
    COALESCE(json_extract(properties, '$.due_date'), '9999-12-31') ASC,
    created_at ASC
  LIMIT 10
`
