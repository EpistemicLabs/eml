import type { EmlApi } from '@engramprotocol/mcp-server'
import { delegationOf, type DelegationFields, type ScheduleFields } from '../domain/delegation.js'
import { sameSchedule, withSchedule } from '../domain/task-schedule.js'

/**
 * The one way the host writes a task's schedule (domain/task-schedule.ts) to the brain.
 *
 * The brain takes a schedule only inside a whole delegation, and a whole delegation written without a schedule ends
 * the schedule. So no caller builds that write itself: this reads the task, applies an edit to its schedule, and
 * posts /task/<id>/track with the delegation as it stands — agent, checkpoint and request unchanged — and the new
 * schedule, or without one when the edit left none. Nothing is written when the edit changes nothing.
 *
 * A task without a delegation gets one for `agent` when it gets a schedule (no checkpoint, no request: its schedule
 * starts it, not the runner).
 *
 * The write is a read-modify-write of the whole delegation, and several parts of the host make it for the same task:
 * the engine (a fired wake-up cleared, a pause after failures), a session ending its turn, the schedule tool, the
 * page's commands. So in this process the writes of one task run one after the other, in the order they were asked
 * for: each reads what the one before wrote, and none is lost. Against a writer outside this process (another
 * cockpit on a shared brain, an agent's own brain tool) the write carries the rev the task was read at (the brain's
 * base_rev precondition); when the task changed in between, it is read again and the edit made once more. A caller
 * that worked its edit out against an earlier read (the jobs migration's plan) names that read's rev instead
 * (`baseRev`): then a task that changed since is not written at all.
 */

export interface ScheduledTask {
  id: string
  status: string
  /** The engram's revision as read; the write names it so the brain refuses it when the task changed in between. */
  rev?: number
  title?: string | null
  content?: string
  ingested_by?: string | null
  properties?: { delegation?: DelegationFields | null; delegate?: string; checkpoint?: string; assignee_ids?: string[]; display_title?: string } | null
}

/** The edit: the task's schedule now (null: none) to the one it gets (null: none). The task is there to decide by. */
export type ScheduleEdit = (schedule: ScheduleFields | null, task: ScheduledTask) => ScheduleFields | null

export interface ScheduleWriteOptions {
  /** The agent a task without a delegation is delegated to when it gets a schedule: the space's. */
  agent?: string | null
  /** A journal line that goes with the write; without a change of the schedule it is written on its own. */
  text?: string
  /** Further fields of the same track call (content, goal, status …); never `delegation`. */
  fields?: Record<string, unknown>
  /** Nothing at all is written (no journal line, no further field) when the edit leaves the schedule as it is. */
  onlyWithChange?: boolean
  /**
   * The rev the caller read the task at and worked its edit out against (a plan made earlier): the write is made only
   * while the task is still at it. A task that changed since is not written and not tried again: ScheduleChangedError.
   */
  baseRev?: number
}

export interface ScheduleWritten {
  task: ScheduledTask
  /** The task's schedule after the call. */
  schedule: ScheduleFields | null
  /** The schedule changed in the brain. */
  changed: boolean
}

/** A schedule could not be written; its message says why. */
export class ScheduleWriteError extends Error {}

/** The task changed since the caller read it (ScheduleWriteOptions.baseRev): nothing was written. */
export class ScheduleChangedError extends ScheduleWriteError {
  constructor() { super('the task changed since it was read: nothing was written') }
}

/** The body of the track call that gives the task this schedule; null when the task's delegation needs no write. */
export function scheduleWrite(task: ScheduledTask, schedule: ScheduleFields | null, agent?: string | null): { delegation: DelegationFields } | null {
  const delegation = delegationOf(task)
  if (sameSchedule(delegation?.schedule, schedule)) return null
  if (delegation) return { delegation: withSchedule(delegation, schedule) }
  if (!agent) throw new ScheduleWriteError('no agent to hold its schedule: the task is not delegated and its space has no agent')
  return { delegation: withSchedule({ agent }, schedule) }
}

/**
 * The schedule writes under way or waiting, per task. A task's id is the key: ids are unique across spaces, and two
 * spaces that did share one would only wait for each other. An entry goes once its last write is over.
 */
const queues = new Map<string, Promise<unknown>>()

/** Run `work` after every write of the task that was asked for before it; a write that failed holds nothing up. */
function inTurn<T>(taskId: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(taskId) ?? Promise.resolve()).then(work, work)
  const tail = run.then(() => {}, () => {})
  queues.set(taskId, tail)
  void tail.then(() => { if (queues.get(taskId) === tail) queues.delete(taskId) })
  return run
}

/** How many tasks have a schedule write under way or waiting (for tests: nothing is kept for an idle task). */
export const scheduleWritesQueued = (): number => queues.size

const isConflict = (err: unknown) => (err as { status?: number })?.status === 409

export function editTaskSchedule(brain: Pick<EmlApi, 'get' | 'post'>, taskId: string, edit: ScheduleEdit, opts: ScheduleWriteOptions = {}): Promise<ScheduleWritten> {
  return inTurn(taskId, async () => {
    for (let attempt = 0; ; attempt++) {
      const task = await brain.get(`/engram/${encodeURIComponent(taskId)}`) as ScheduledTask
      if (opts.baseRev !== undefined && task.rev !== opts.baseRev) throw new ScheduleChangedError()
      const current = delegationOf(task)?.schedule ?? null
      const next = edit(current, task)
      const write = scheduleWrite(task, next, opts.agent)
      const { delegation: _never, base_rev: _rev, ...fields } = opts.fields ?? {}
      const body = { ...fields, ...(write ?? {}), ...(opts.text ? { text: opts.text } : {}) }
      if (Object.keys(body).length === 0 || (opts.onlyWithChange && !write)) return { task, schedule: current, changed: false }
      try {
        await brain.post(`/task/${encodeURIComponent(taskId)}/track`, typeof task.rev === 'number' ? { ...body, base_rev: task.rev } : body)
        return { task, schedule: write ? write.delegation.schedule ?? null : current, changed: write !== null }
      } catch (err) {
        // The caller's edit was made for the task as it read it: one that changed is the caller's to plan again.
        if (opts.baseRev !== undefined && isConflict(err)) throw new ScheduleChangedError()
        // The task changed between the read and the write: once more, on the task as it is now.
        if (attempt > 0 || !isConflict(err)) throw err
      }
    }
  })
}

/** Set the task's schedule as a whole (null ends it): for a caller that has worked the new one out already. */
export const writeTaskSchedule = (brain: Pick<EmlApi, 'get' | 'post'>, taskId: string, schedule: ScheduleFields | null, opts: ScheduleWriteOptions = {}): Promise<ScheduleWritten> =>
  editTaskSchedule(brain, taskId, () => schedule, opts)
