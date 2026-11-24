import { waitKind, type WaitingOn } from './task-turn.js'
import type { DelegationFields } from './delegation.js'
import { waitsBody, waitsOf, type Wait } from './task-waits.js'

/**
 * Hand over: give a task to an agent while its owner stays (decision task-assignee-owner-and-agent-delegate).
 * Three modes: now (the runner starts the delegate), schedule (a job starts it at a time), together
 * (Work on it now: a session in a desk, with the owner in the chat). This file plans the change; the use case
 * (application/task-commands.ts) carries it out and keeps it undoable.
 *
 * v0.23 (task state model): a delegation always means the agent works on its own. Delegate now writes
 * delegation { agent, checkpoint, requested_at } — the runner's trigger — and leaves the status alone: it never goes
 * back to planned. Work on it now writes no delegation; a task delegated before loses it (with a journal line), so
 * the runner does not start the agent on its own meanwhile, and the status moves to active.
 *
 * An open question is never dropped: a plan that clears a question waiting on the owner puts it
 * into the journal and into the delegate's brief in the same step.
 */

export type HandOverMode = 'now' | 'schedule' | 'together'
export const HAND_OVER_MODES: readonly HandOverMode[] = ['now', 'schedule', 'together']

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
  /** The task's waits (brain schema 23); without them, the one waitingOn stands for. */
  waits?: Wait[]
  waitingOn?: WaitingOn
  delegation?: DelegationFields
}

export type HandOverRefusal =
  | 'task_closed'
  | 'delegate_not_in_space'
  | 'checkpoint_required'
  | 'schedule_required'
  | 'desk_required'

export interface TaskPatch {
  status?: string
  delegation?: DelegationFields | null
  waits?: Wait[] | null
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
  /** The time of the hand-over (ISO): a Delegate now's request. */
  now: string
}

const CHECKPOINTS = new Set(['before', 'after', 'none'])

export function planHandOver(task: HandOverTask, req: HandOverRequest, ctx: HandOverContext): { ok: true; plan: HandOverPlan } | { ok: false; refusal: HandOverRefusal } {
  if (task.status === 'resolved' || task.status === 'invalidated') return { ok: false, refusal: 'task_closed' }
  if (!ctx.agents.includes(req.delegate)) return { ok: false, refusal: 'delegate_not_in_space' }
  if (req.mode !== 'together' && (!req.checkpoint || !CHECKPOINTS.has(req.checkpoint))) return { ok: false, refusal: 'checkpoint_required' }
  if (req.mode === 'schedule' && !req.schedule) return { ok: false, refusal: 'schedule_required' }
  if (req.mode === 'together' && !req.desk) return { ok: false, refusal: 'desk_required' }

  const patch: TaskPatch = {}
  const lines: string[] = []
  if (req.mode === 'now') patch.delegation = { agent: req.delegate, checkpoint: req.checkpoint, requested_at: ctx.now }
  // A job starts it at its time (application/jobs.ts); no request for the runner.
  if (req.mode === 'schedule') patch.delegation = { agent: req.delegate, checkpoint: req.checkpoint }
  if (req.mode === 'together') {
    if (task.delegation?.agent || task.delegate) patch.delegation = null
    if (task.status === 'planned') patch.status = 'active'
  }
  if (req.mode === 'now') lines.push(`Handed to ${req.delegate} with checkpoint ${req.checkpoint}; the owner stays.`)
  if (req.mode === 'schedule') {
    const when = req.schedule!.at ?? `"${req.schedule!.cron}"`
    lines.push(`Scheduled ${req.delegate} for ${when} (${req.schedule!.timeZone}) with checkpoint ${req.checkpoint}; the owner stays.`)
  }
  if (req.mode === 'together') {
    const was = task.delegation?.agent ?? task.delegate
    lines.push(`Working on it with ${req.delegate} in desk ${req.desk}; the owner stays.${was ? ` ${was} is no longer delegated, so it does not go on alone meanwhile.` : ''}`)
  }

  const plan: HandOverPlan = { patch, journal: '' }
  // The owner's open questions leave the task's waits; every other wait stays.
  const waits = waitsOfTask(task)
  const asked = waits.filter((w) => w.who === task.owner && waitKind(w) === 'question')
  if (asked.length > 0) {
    const question = asked.map((w) => w.why ?? 'an open question (see the session)').join(' · ')
    const left = waits.filter((w) => !asked.includes(w))
    patch.waits = waitsBody(left).waits
    plan.carriedQuestion = question
    plan.brief = `The owner had an open question when this task was handed to you. Answer or settle it first: "${question}"`
    lines.push(`Handed over with the open question: "${question}" It goes into ${req.delegate}'s brief.`)
  }
  plan.journal = lines.join(' ')
  if (req.mode === 'schedule') plan.job = req.schedule
  if (req.mode === 'together') plan.session = { desk: req.desk! }
  return { ok: true, plan }
}

const waitsOfTask = (task: HandOverTask): Wait[] => task.waits ?? waitsOf({ waiting_on: task.waitingOn })

/** The change that puts a task back as it was before a hand-over. */
export function planUndo(before: HandOverTask): { patch: Required<TaskPatch>; journal: string } {
  const delegation = before.delegation ?? (before.delegate ? { agent: before.delegate, ...(before.checkpoint ? { checkpoint: before.checkpoint } : {}) } : null)
  return {
    patch: { delegation, waits: waitsBody(waitsOfTask(before)).waits, status: before.status },
    journal: 'Hand-over undone; the task is back as it was.',
  }
}
