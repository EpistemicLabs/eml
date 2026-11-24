/**
 * A task's delegation (brain schema 23): the hand-over to an agent that works on it on its own.
 *
 *   delegation { agent, checkpoint, requested_at?, schedule? }
 *
 * requested_at is the runner's trigger. A request is open while no run on the task started at or after it, so the
 * status never has to go back to planned to start a task again: it moves forward only (planned → active → closed).
 *
 * For one release the runner also takes the old signal — a planned task with a delegate and a checkpoint but no
 * requested_at and no schedule — so a hand-over from a cockpit on the older logic still starts. The brain's migration
 * never gives a delegation a requested_at, and the cockpit's migration pass gives one only where the runner would
 * have started the task anyway.
 */

export interface ScheduleFields {
  at?: string
  cron?: string
  time_zone?: string
  paused?: boolean
  session?: 'new' | 'resume'
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
 * or after its request (`lastRunStartedAt`: when the newest run on it started, or null). See the header for the old
 * signal it still takes.
 */
export function requestOpen(task: DelegatedTask, lastRunStartedAt: string | null): boolean {
  if (!OPEN.has(task.status)) return false
  const d = delegationOf(task)
  if (!d?.agent || !d.checkpoint) return false
  if (d.requested_at) {
    const requested = Date.parse(d.requested_at)
    const started = lastRunStartedAt ? Date.parse(lastRunStartedAt) : NaN
    return !Number.isFinite(started) || started < requested
  }
  return task.status === 'planned' && !d.schedule
}

/** The newest run's start per task, from GET /object/run?latest=true. */
export function lastStartsOf(objects: ReadonlyArray<Record<string, unknown>>): Map<string, string> {
  const starts = new Map<string, string>()
  for (const o of objects) {
    if (typeof o.task_id === 'string' && typeof o.started_at === 'string') starts.set(o.task_id, o.started_at)
  }
  return starts
}
