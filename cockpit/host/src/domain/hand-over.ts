import { waitKind, type WaitingOn } from './task-turn.js'
import { waitsBody, waitsOf, type Wait } from './task-waits.js'

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
}

export type HandOverRefusal =
  | 'task_closed'
  | 'delegate_not_in_space'
  | 'checkpoint_required'
  | 'schedule_required'
  | 'desk_required'

export interface TaskPatch {
  status?: string
  delegate?: string | null
  checkpoint?: string | null
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
}

const CHECKPOINTS = new Set(['before', 'after', 'none'])

export function planHandOver(task: HandOverTask, req: HandOverRequest, ctx: HandOverContext): { ok: true; plan: HandOverPlan } | { ok: false; refusal: HandOverRefusal } {
  if (task.status === 'resolved' || task.status === 'invalidated') return { ok: false, refusal: 'task_closed' }
  if (!ctx.agents.includes(req.delegate)) return { ok: false, refusal: 'delegate_not_in_space' }
  if (!req.checkpoint || !CHECKPOINTS.has(req.checkpoint)) return { ok: false, refusal: 'checkpoint_required' }
  if (req.mode === 'schedule' && !req.schedule) return { ok: false, refusal: 'schedule_required' }
  if (req.mode === 'together' && !req.desk) return { ok: false, refusal: 'desk_required' }

  const patch: TaskPatch = { delegate: req.delegate, checkpoint: req.checkpoint }
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
  return {
    patch: { delegate: before.delegate ?? null, checkpoint: before.checkpoint ?? null, waits: waitsBody(waitsOfTask(before)).waits, status: before.status },
    journal: 'Hand-over undone; the task is back as it was.',
  }
}
