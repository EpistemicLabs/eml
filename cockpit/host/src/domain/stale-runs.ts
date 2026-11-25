/**
 * Hung workers: a run of this cockpit on a task handed to an agent that says running but has had no
 * activity for STALE_MS (domain/runs.ts). Nobody would notice: the agent asks nothing and ends
 * nothing. So the task gets a wait of kind stopped on its owner, "No activity for 1 h", which the
 * Inbox lists and Now shows under Needs you · failed.
 *
 * The wait is the session's own wait: its id and session_id are the session's. A session holds at
 * most one wait per task (domain/task-waits.ts), so nothing has to be cleaned up when the session
 * moves on: the router's write at its next turn end replaces or removes it, the next-step check's
 * "stopped without a next step" replaces it, and the user's answer or putting the session away
 * removes it. For the same reason it is never written over a wait the session already has: that
 * one already says who has to act. It is told apart from the session's other waits by its why.
 *
 * Activity is the later of the run's last write (the brain stamps it, but a run is written only
 * when its state changes) and what this cockpit sees of the session itself, so a long turn that
 * is still doing something is not hung. Only this cockpit's own sessions are judged: another
 * member's silent run is their cockpit's to tell, and the board marks it stale.
 */

import { isStale, STALE_MS, type RunFacts } from './runs.js'
import { waitKind } from './task-turn.js'
import { waitsOf, withoutSession, withSessionWait, type Wait } from './task-waits.js'

/** A time span in the largest unit that fits it evenly: "1 h", "90 min". */
export function spanText(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  return minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`
}

/** The why of a hung worker's wait; it is also how the wait is recognised. */
export const STALE_WHY = `No activity for ${spanText(STALE_MS)}`

/** The wait says its session went silent (and not that it failed or stopped without a next step). */
export function isStaleWait(w: Wait): boolean {
  return waitKind(w) === 'stopped' && w.why === STALE_WHY && (w.session_id ?? w.id) === w.id
}

/**
 * The sessions whose run on this task went silent. Such a session still says it is in a turn; the
 * board and the runner both ask here, so neither counts it as working: its task shows under Needs
 * you, and it holds none of the runner's slots.
 */
export function hungOn(properties: { waits?: unknown; waiting_on?: unknown } | null | undefined): ReadonlySet<string> {
  return new Set(waitsOf(properties ?? undefined).filter(isStaleWait).map((w) => w.id))
}

/** A task's sessions with the hung ones (hungOn) as not working. */
export function withoutHung<T extends { sessionId: string; working: boolean }>(sessions: readonly T[], hung: ReadonlySet<string>): T[] {
  return sessions.map((s) => (s.working && hung.has(s.sessionId) ? { ...s, working: false } : s))
}

export interface OwnSession {
  sessionId: string
  taskId: string | null
  archived: boolean
  /** When this cockpit last saw the session do something (ISO time); null when it cannot tell. */
  activityAt?: string | null
}

/**
 * This cockpit's sessions whose run is hung, with their task: the run is this member's, on the
 * session's task, running, and neither the run nor the session showed activity for STALE_MS.
 * A session put away, without a task or without a run is never hung.
 */
export function hungSessions(facts: { runs: readonly RunFacts[]; sessions: readonly OwnSession[]; me: string; now: number }): Map<string, string> {
  const own = new Map(facts.sessions.filter((s) => s.taskId && !s.archived).map((s) => [s.sessionId, s]))
  const hung = new Map<string, string>()
  for (const run of facts.runs) {
    const session = own.get(run.id)
    if (!session || run.member !== facts.me || run.task_id !== session.taskId) continue
    const seen = [run.last_activity_at, session.activityAt].filter((at): at is string => typeof at === 'string' && Number.isFinite(Date.parse(at))).sort().at(-1)
    if (isStale({ ...run, last_activity_at: seen ?? null }, facts.now)) hung.set(run.id, run.task_id)
  }
  return hung
}

interface StaleTask {
  status: string
  properties?: { assignee_ids?: string[]; delegate?: string; waits?: unknown; waiting_on?: unknown }
}

/**
 * The task's waits after looking at one session, or null when they stay as they are.
 *   - Hung, on an open task handed to an agent, and the session has no wait: the stopped wait on the
 *     task's owner (`me` when it names none) is added.
 *   - Not hung, or the task is closed or no longer handed over: the session's stale wait is removed.
 *   - Any other wait of the session is left alone.
 */
export function staleWaitsAfter(facts: { task: StaleTask; sessionId: string; hung: boolean; me: string; now: Date }): Wait[] | null {
  const waits = waitsOf(facts.task.properties)
  const mine = waits.find((w) => (w.session_id ?? w.id) === facts.sessionId)
  const open = facts.task.status === 'planned' || facts.task.status === 'active'
  const applies = facts.hung && open && Boolean(facts.task.properties?.delegate)
  if (!applies) return mine && isStaleWait(mine) ? withoutSession(waits, facts.sessionId) : null
  if (mine) return null
  const owner = facts.task.properties?.assignee_ids?.[0] || facts.me
  return withSessionWait(waits, { who: owner, kind: 'stopped', why: STALE_WHY, since: facts.now.toISOString(), session_id: facts.sessionId })
}
