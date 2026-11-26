import type { Job } from '../domain/job.js'
import type { JobStore } from '../job-store.js'

/**
 * What a limited task's session may do with the schedule tool: look after its own task's schedule and nothing
 * else. It may set its next wake-up and its goal, and end the schedule once the goal is reached. It may
 * not make schedules (their runs would have its maker's wider tools), touch other tasks, or change what its
 * task does, whom it hears from or what it may use, since its text comes from strangers.
 */

/** Fields a limited task's session may set on its own task's schedule with update. */
const OWN_JOB_FIELDS = new Set(['action', 'job', 'at', 'timezone', 'goal'])
const OWN_JOB_ACTIONS = new Set(['list', 'update', 'finish'])

const REFUSED = 'this task is limited: its session can only set its next wake-up (update with at), its goal, or finish its own schedule'

/** Why a limited task's session may not send this request, or null when it may. `matches` tells whether `job` names its own task. */
export function limitedJobRefusal(input: Record<string, unknown>, matches: (key: string) => boolean): string | null {
  const action = typeof input.action === 'string' ? input.action : ''
  if (!OWN_JOB_ACTIONS.has(action)) return REFUSED
  if (action === 'list') return null
  if (typeof input.job !== 'string' || !matches(input.job)) return `${REFUSED}; "${String(input.job ?? '')}" is not its task`
  const other = Object.keys(input).filter((key) => input[key] !== undefined && !OWN_JOB_FIELDS.has(key))
  return other.length ? `${REFUSED}; it cannot change ${other.join(', ')}` : null
}

/**
 * The task whose run started a session (the ledger's jobId: the task's record) and whether it is limited, for the
 * schedule tool's caller. A session whose record can no longer be found counts as limited here, so the limit fails
 * closed. The tool then looks the task up (application/jobs.ts): a limited record stays while its task is open, so
 * an open task without a record was not limited and its session is free; a task that is closed or gone reaches nothing.
 */
export function sessionJobFacts(jobId: string | null, job: { limited?: boolean } | undefined): { jobId: string | null; limited: boolean } {
  if (!jobId) return { jobId: null, limited: false }
  return { jobId, limited: job ? job.limited === true : true }
}

/** A session as the ledger has it, for its record. */
export interface SessionLink { jobId?: string | null; taskId?: string | null }

/**
 * The record a run's session is read by, for its limits, its channel tools and bridge, and the tools lent to it: the
 * record its ledger jobId names; when that names none, the record of its task (a record's id is its task's id).
 * Undefined: no run started it, or neither has a record.
 */
export function recordOfSession(entry: SessionLink, store: Pick<JobStore, 'get'>): Job | undefined {
  if (!entry.jobId) return undefined
  return store.get(entry.jobId) ?? (entry.taskId ? store.get(entry.taskId) : undefined)
}

/**
 * What holds a run's session in the schedule tool: its own task (its record's task, else the session's task, else the
 * jobId) and what says whether it is limited (its record, else the version 1 job its jobId names while that job still
 * waits to move). `limits` undefined: nothing says, and the tool decides by whether its own task is open.
 */
export function sessionScope(entry: SessionLink, store: Pick<JobStore, 'get' | 'pendingV1'>): { ownTaskId: string | null; limits: { limited?: boolean } | undefined } {
  const record = recordOfSession(entry, store)
  const waiting = !record && entry.jobId ? store.pendingV1()?.jobs[entry.jobId] : undefined
  return { ownTaskId: record?.taskId ?? entry.taskId ?? entry.jobId ?? null, limits: record ?? waiting }
}
