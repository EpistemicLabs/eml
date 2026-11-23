import { waitKind, type WaitingOn } from './task-turn.js'

/**
 * Hand over: give a task to an agent while its owner stays (decision task-assignee-owner-and-agent-delegate).
 * Three modes: now (the runner starts the delegate), schedule (a job starts it at a time), together
 * (a session in a desk, with the owner in the chat). This file plans the change; the use case
 * (application/hand-over.ts) carries it out and keeps it undoable.
 *
 * An open question is never dropped: a plan that clears a question waiting on the owner puts it
 * into the journal and into the delegate's brief in the same step.
 */

export type HandOverMode = 'now' | 'schedule' | 'together'
export const HAND_OVER_MODES: readonly HandOverMode[] = ['now', 'schedule', 'together']

/**
 * How the delegate works on the task (brain schema 23, task.delegation.mode): alone (the runner or a
 * job starts it) or together (with the owner in the chat; the runner never starts it).
 */
export type DelegationMode = 'alone' | 'together'

/** Work on it now → together; Delegate now and Schedule → alone. */
export const delegationModeOf = (mode: HandOverMode): DelegationMode => (mode === 'together' ? 'together' : 'alone')

/** The delegate works on its own (delegation.mode alone): the runner may start it. A task without a delegation (a brain before 23) counts as alone. */
export const worksAlone = (task: { properties?: { delegation?: { mode?: string } | null } | null }) => (task.properties?.delegation?.mode ?? 'alone') === 'alone'

/** task.delegation as stored (schema 23); core keeps delegate and checkpoint mirrored from it. */
export interface Delegation {
  agent: string
  checkpoint?: string
  mode: DelegationMode
  requested_at?: string
  next_run_at?: string
}

export type ScheduleSpec = { timeZone: string } & ({ at: string; cron?: undefined } | { cron: string; at?: undefined })

export interface HandOverRequest {
  mode: HandOverMode
  delegate: string
  checkpoint?: string
  schedule?: ScheduleSpec
  desk?: string
}

export interface HandOverTask {
  id: string
  status: string
  owner?: string
  delegate?: string
  checkpoint?: string
  /** Schema 23: the hand-over as one value; absent on a task without a delegate. */
  delegation?: Delegation
  waitingOn?: WaitingOn
}

export type HandOverRefusal =
  | 'task_closed'
  | 'delegate_not_in_space'
  | 'checkpoint_required'
  | 'schedule_required'
  | 'desk_required'

/**
 * One task write. It carries delegation or delegate/checkpoint, never both (core refuses a call
 * with both shapes); core mirrors the other shape, so agents and older logic reading delegate and
 * checkpoint see the same hand-over.
 */
export interface TaskPatch {
  status?: string
  delegation?: Delegation | null
  delegate?: string | null
  checkpoint?: string | null
  waiting_on?: WaitingOn | null
}

/**
 * The hand-over fields a patch leaves on a task, as core mirrors them (packages/core task-state.ts):
 * a delegation sets delegate and checkpoint, null clears all three. For showing a pending hand-over.
 */
export function mirroredHandOver(patch: Pick<TaskPatch, 'delegation' | 'delegate' | 'checkpoint'>): { delegation?: Delegation | null; delegate?: string | null; checkpoint?: string | null } {
  if (patch.delegation === undefined) return { ...('delegate' in patch ? { delegate: patch.delegate } : {}), ...('checkpoint' in patch ? { checkpoint: patch.checkpoint } : {}) }
  if (patch.delegation === null) return { delegation: null, delegate: null, checkpoint: null }
  return { delegation: patch.delegation, delegate: patch.delegation.agent, checkpoint: patch.delegation.checkpoint ?? null }
}

export interface HandOverPlan {
  patch: TaskPatch
  journal: string
  carriedQuestion?: string
  /** What the delegate reads first when it starts. */
  brief?: string
  job?: ScheduleSpec
  session?: { desk: string }
}

export interface HandOverContext {
  /** The agents of the task's space. */
  agents: string[]
}

const CHECKPOINTS = new Set(['before', 'after', 'none'])

export function planHandOver(task: HandOverTask, req: HandOverRequest, ctx: HandOverContext): { ok: true; plan: HandOverPlan } | { ok: false; refusal: HandOverRefusal } {
  if (task.status === 'resolved' || task.status === 'invalidated') return { ok: false, refusal: 'task_closed' }
  if (!ctx.agents.includes(req.delegate)) return { ok: false, refusal: 'delegate_not_in_space' }
  if (!req.checkpoint || !CHECKPOINTS.has(req.checkpoint)) return { ok: false, refusal: 'checkpoint_required' }
  if (req.mode === 'schedule' && !req.schedule) return { ok: false, refusal: 'schedule_required' }
  if (req.mode === 'together' && !req.desk) return { ok: false, refusal: 'desk_required' }

  const patch: TaskPatch = { delegation: { agent: req.delegate, checkpoint: req.checkpoint, mode: delegationModeOf(req.mode) } }
  // The runner starts planned tasks: an active one handed over now goes back to planned.
  if (req.mode === 'now' && task.status === 'active') patch.status = 'planned'
  const lines: string[] = []
  if (req.mode === 'now') lines.push(`Handed to ${req.delegate} with checkpoint ${req.checkpoint}; the owner stays.`)
  if (req.mode === 'schedule') {
    const when = req.schedule!.at ?? `"${req.schedule!.cron}"`
    lines.push(`Scheduled ${req.delegate} for ${when} (${req.schedule!.timeZone}) with checkpoint ${req.checkpoint}; the owner stays.`)
  }
  if (req.mode === 'together') lines.push(`Working on it with ${req.delegate} in desk ${req.desk}; the owner stays.`)

  const plan: HandOverPlan = { patch, journal: '' }
  const w = task.waitingOn
  if (w && w.who === task.owner && waitKind(w) === 'question') {
    const question = w.why ?? 'an open question (see the session)'
    patch.waiting_on = null
    plan.carriedQuestion = question
    plan.brief = `The owner had an open question when this task was handed to you. Answer or settle it first: "${question}"`
    lines.push(`Handed over with the open question: "${question}" It goes into ${req.delegate}'s brief.`)
  }
  plan.journal = lines.join(' ')
  if (req.mode === 'schedule') plan.job = req.schedule
  if (req.mode === 'together') plan.session = { desk: req.desk! }
  return { ok: true, plan }
}

/**
 * The change that puts a task back as it was before a hand-over: its delegation as it was (mode and
 * all), or, for a task that had none, the flat fields (a checkpoint without a delegate from before
 * schema 23 stays as it was).
 */
export function planUndo(before: HandOverTask): { patch: TaskPatch; journal: string } {
  const handOver: TaskPatch = before.delegation
    ? { delegation: before.delegation }
    : { delegate: before.delegate ?? null, checkpoint: before.checkpoint ?? null }
  return {
    patch: { ...handOver, waiting_on: before.waitingOn ?? null, status: before.status },
    journal: 'Hand-over undone; the task is back as it was.',
  }
}
