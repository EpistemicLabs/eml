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
 */

export interface ScheduledTask {
  id: string
  status: string
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

/** The body of the track call that gives the task this schedule; null when the task's delegation needs no write. */
export function scheduleWrite(task: ScheduledTask, schedule: ScheduleFields | null, agent?: string | null): { delegation: DelegationFields } | null {
  const delegation = delegationOf(task)
  if (sameSchedule(delegation?.schedule, schedule)) return null
  if (delegation) return { delegation: withSchedule(delegation, schedule) }
  if (!agent) throw new ScheduleWriteError('no agent to hold its schedule: the task is not delegated and its space has no agent')
  return { delegation: withSchedule({ agent }, schedule) }
}

export async function editTaskSchedule(brain: Pick<EmlApi, 'get' | 'post'>, taskId: string, edit: ScheduleEdit, opts: ScheduleWriteOptions = {}): Promise<ScheduleWritten> {
  const task = await brain.get(`/engram/${encodeURIComponent(taskId)}`) as ScheduledTask
  const current = delegationOf(task)?.schedule ?? null
  const next = edit(current, task)
  const write = scheduleWrite(task, next, opts.agent)
  const { delegation: _never, ...fields } = opts.fields ?? {}
  const body = { ...fields, ...(write ?? {}), ...(opts.text ? { text: opts.text } : {}) }
  if (Object.keys(body).length > 0) await brain.post(`/task/${encodeURIComponent(taskId)}/track`, body)
  return { task, schedule: write ? write.delegation.schedule ?? null : current, changed: write !== null }
}

/** Set the task's schedule as a whole (null ends it): for a caller that has worked the new one out already. */
export const writeTaskSchedule = (brain: Pick<EmlApi, 'get' | 'post'>, taskId: string, schedule: ScheduleFields | null, opts: ScheduleWriteOptions = {}): Promise<ScheduleWritten> =>
  editTaskSchedule(brain, taskId, () => schedule, opts)
