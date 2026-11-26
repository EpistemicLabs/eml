/**
 * A task's delegation (brain schema 23; its schedule since 24): the hand-over to an agent that works on it on its own.
 *
 *   delegation { agent, checkpoint, requested_at?, schedule? }
 *
 * requested_at is the runner's trigger. A request is open while no run on the task started at or after it, so the
 * status never has to go back to planned to start a task again: it moves forward only (planned → active → closed).
 *
 * Only an open request starts a task: planned with a delegate and a checkpoint alone starts nothing. Every hand-over
 * carries a request (Delegate now, eml_track_task, a task created with a delegate and a checkpoint), and a delegation
 * without one waits for its owner to hand it over (decision task-state-migration-rules).
 */

/**
 * The task's schedule (brain schema 24, domain/task-schedule.ts): repeating times and at most one wake-up. The keys in
 * the order the brain stores them; at least one of crons and at.
 */
export interface ScheduleFields {
  /** Repeating times, five-field cron each: 1 to 10, no duplicates. */
  crons?: string[]
  /** The one wake-up (ISO). */
  at?: string
  /** The wake-up's reason, what to do then; only with at. */
  why?: string
  /** The session that set the wake-up; only with at. */
  by_session?: string
  /** The IANA zone the crons are read in. */
  time_zone?: string
  /** The whole schedule is paused. */
  paused?: boolean
  /**
   * The end of the repeating times (ISO): none of them fires after it. The wake-up is independent of it and fires at
   * its own time, before the end or after it (domain/task-schedule.ts dueOf).
   */
  ends_at?: string
}

export interface DelegationFields {
  agent?: string
  checkpoint?: string
  requested_at?: string
  schedule?: ScheduleFields
}

export interface DelegatedTask {
  status: string
  properties?: {
    delegation?: DelegationFields | null
    delegate?: string
    checkpoint?: string
  } | null
}

const OPEN = new Set(['planned', 'active'])

/** The task's delegation, or null; one written only flat (before 23) reads from delegate and checkpoint. */
export function delegationOf(task: DelegatedTask): DelegationFields | null {
  const props = task.properties ?? {}
  if (props.delegation && typeof props.delegation === 'object' && props.delegation.agent) return props.delegation
  return props.delegate ? { agent: props.delegate, ...(props.checkpoint ? { checkpoint: props.checkpoint } : {}) } : null
}

/**
 * The runner has an open request to start the task: it is open, delegated with a checkpoint, and no run started at
 * or after its request (`lastRunStartedAt`: when the newest run on it started, or null).
 */
export function requestOpen(task: DelegatedTask, lastRunStartedAt: string | null): boolean {
  if (!OPEN.has(task.status)) return false
  const d = delegationOf(task)
  if (!d?.agent || !d.checkpoint) return false
  if (!d.requested_at) return false
  const requested = Date.parse(d.requested_at)
  const started = lastRunStartedAt ? Date.parse(lastRunStartedAt) : NaN
  return !Number.isFinite(started) || started < requested
}

/** The newest run's start per task, from GET /object/run?latest=… (newest first per task: the first one wins). */
export function lastStartsOf(objects: ReadonlyArray<Record<string, unknown>>): Map<string, string> {
  const starts = new Map<string, string>()
  for (const o of objects) {
    if (typeof o.task_id === 'string' && typeof o.started_at === 'string' && !starts.has(o.task_id)) starts.set(o.task_id, o.started_at)
  }
  return starts
}
