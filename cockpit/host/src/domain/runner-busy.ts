/**
 * Whether a session on a task keeps the runner from starting its delegate.
 *
 * A session someone started on the task blocks it: a worker, or the owner's own session that
 * opened after the hand-over. The owner's own session that was already open when they chose
 * Delegate now does not, while it is idle: the owner handed the task over and their pane stays
 * (note task-state-model-as-built). Without this the task stood in "Agent scheduled · runner"
 * until the owner archived their own pane (B3 in reports/Task state model review.md). A session
 * that is in a turn still blocks it; the runner starts once that turn ends.
 */

export interface SessionOnTask {
  createdAt: string
  archived: boolean
  /** In a turn right now. */
  working: boolean
}

/** `delegatedAt`: when the task's latest Delegate now was chosen; null when there was none on this cockpit. */
export function sessionsBlockRunner(sessions: SessionOnTask[], delegatedAt: string | null): boolean {
  const since = delegatedAt ? Date.parse(delegatedAt) : NaN
  return sessions.some((s) => {
    if (s.archived) return false
    if (s.working || !Number.isFinite(since)) return true
    return Date.parse(s.createdAt) >= since
  })
}
