import { waitKind, type WaitingOn } from './task-turn.js'
import type { DelegationFields, ScheduleFields } from './delegation.js'
import { cronInWords } from './run-text.js'
import { isTimeZone, formatInZone, unknownTimeZone } from './schedule.js'
import { readAt } from './schedule-tool.js'
import { addCron, cronRefusal, cronZoneRefusal, ScheduleError, setWake } from './task-schedule.js'
import { waitsBody, waitsOf, type Wait } from './task-waits.js'
import { PLACEHOLDER_TITLE } from './task-title.js'

/**
 * Hand over: give a task to an agent while its owner stays (decision task-assignee-owner-and-agent-delegate).
 * Three modes: now (the runner starts the delegate), schedule (its schedule starts it at a time), together
 * (Work on it now: a session in a desk, with the owner in the chat; on a task with its own open session it is Take
 * over, which opens that session instead of starting one). This file plans the change; the use case
 * (application/task-commands.ts) carries it out and keeps it undoable.
 *
 * v0.23 (task state model): a delegation always means the agent works on its own. Delegate now writes
 * delegation { agent, checkpoint, requested_at } — the runner's trigger — and leaves the status alone: it never goes
 * back to planned. Work on it now writes no delegation; a task delegated before loses it (with a journal line), so
 * the runner does not start the agent on its own meanwhile, and the status moves to active.
 *
 * The task's schedule is its own field, and no delegation written here touches it: Delegate now and
 * Work on it now leave it as it is, and Schedule adds to it (one time: the task's wake-up for the delegate, which
 * replaces the one it had; repeat: one more repeating time).
 *
 * An open question is never dropped: a plan that clears a question waiting on the owner puts it
 * into the journal and into the delegate's brief in the same step.
 */

export type HandOverMode = 'now' | 'schedule' | 'together'
export const HAND_OVER_MODES: readonly HandOverMode[] = ['now', 'schedule', 'together']

/** When a scheduled agent works on the task: one time (at, an instant) or a repeat rule (cron, read in timeZone). */
export type ScheduleSpec = { timeZone: string } & ({ at: string; cron?: undefined } | { cron: string; at?: undefined })

/** What a hand-over's schedule may be (domain/job.ts JOB_LIMITS). */
export interface ScheduleSpecLimits { minGapMs: number; maxAheadMs: number }

/**
 * A hand-over's schedule as the page sends it ({ timeZone, at | cron }), checked: `at` is read in the
 * zone when it names no offset and comes back as an instant. Undefined when none is given; `error` says what is wrong.
 */
export function readScheduleSpec(input: unknown, now: number, limits: ScheduleSpecLimits): ScheduleSpec | undefined | { error: string } {
  const s = input && typeof input === 'object' ? input as Record<string, unknown> : null
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
  const timeZone = text(s?.timeZone)
  if (!s || !timeZone) return undefined
  if (!isTimeZone(timeZone)) return { error: unknownTimeZone(timeZone) }
  const at = text(s.at), cron = text(s.cron)
  if (at && !cron) {
    const read = readAt(at, timeZone, now, limits.maxAheadMs)
    return 'error' in read ? read : { at: read.at, timeZone }
  }
  if (cron && !at) {
    const refusal = cronRefusal(cron, timeZone, now, limits.minGapMs)
    return refusal ? { error: refusal } : { cron, timeZone }
  }
  return undefined
}

export interface HandOverRequest {
  mode: HandOverMode
  delegate: string
  checkpoint?: string
  schedule?: ScheduleSpec
  desk?: string
  /** Delegate now: start a new session even when the task has its own open session to continue (domain/own-session.ts). */
  fresh?: boolean
}

export interface HandOverTask {
  id: string
  status: string
  /** The kebab title and the name people read: a placeholder name (domain/task-title.ts) is no name yet. */
  title?: string | null
  displayTitle?: string
  owner?: string
  delegate?: string
  checkpoint?: string
  /** The task's waits (brain schema 23); without them, the one waitingOn stands for. */
  waits?: Wait[]
  waitingOn?: WaitingOn
  delegation?: DelegationFields; schedule?: ScheduleFields | null
  goal?: string
}

export type HandOverRefusal =
  | 'task_closed'
  | 'delegate_not_in_space'
  | 'checkpoint_required'
  | 'schedule_required'
  /** The schedule cannot be added to the task's: not a time, or the task has as many repeating times as it can hold. */
  | 'schedule_invalid'
  /** A repeating time written in another zone than the task's repeating times are read in (the answer's message names it). */
  | 'schedule_zone'
  /** Take over without a desk (from the chip or the panel), but the task has no open session of its own (any more). */
  | 'no_session'
  /** Delegate now or Schedule on a task without a name or a goal: an agent alone needs to know what done means. */
  | 'not_ready'

export interface TaskPatch {
  status?: string
  delegation?: DelegationFields | null; schedule?: ScheduleFields | null
  waits?: Wait[] | null
}

export interface HandOverPlan {
  patch: TaskPatch
  journal: string
  carriedQuestion?: string
  /** What the delegate reads first when it starts. */
  brief?: string
  /** Work on it now: a new session in `desk`. Take over: the task's own session (`sessionId`), opened in `desk` when named. */
  session?: { desk?: string; sessionId?: string }
}

export interface HandOverContext {
  /** The agents of the task's space. */
  agents: string[]
  /** The time of the hand-over (ISO): a Delegate now's request. */
  now: string
  /** The task's own open session (domain/own-session.ts), or null: Take over opens it instead of starting one. */
  ownSession?: string | null
}

const CHECKPOINTS = new Set(['before', 'after', 'none'])

export function planHandOver(task: HandOverTask, req: HandOverRequest, ctx: HandOverContext): { ok: true; plan: HandOverPlan } | { ok: false; refusal: HandOverRefusal; message?: string } {
  if (task.status === 'resolved' || task.status === 'invalidated') return { ok: false, refusal: 'task_closed' }
  if (!ctx.agents.includes(req.delegate)) return { ok: false, refusal: 'delegate_not_in_space' }
  if (req.mode !== 'together' && (!req.checkpoint || !CHECKPOINTS.has(req.checkpoint))) return { ok: false, refusal: 'checkpoint_required' }
  if (req.mode === 'schedule' && !req.schedule) return { ok: false, refusal: 'schedule_required' }
  // A new session opens in a desk; Take over opens the task's own session where it is shown (a desk names its pane).
  // Asked for without a desk when there is no own session (it was put away since the page looked): the page offers one.
  if (req.mode === 'together' && !req.desk && !ctx.ownSession) return { ok: false, refusal: 'no_session' }
  // The agent works on it alone: only a task with a name and a goal is handed over (decision session-kind-follows-task-delegate).
  if (req.mode !== 'together' && !readyToDelegate(task)) return { ok: false, refusal: 'not_ready' }

  const patch: TaskPatch = {}
  const lines: string[] = []
  const schedule = task.schedule ?? null
  if (req.mode === 'now') patch.delegation = { agent: req.delegate, checkpoint: req.checkpoint, requested_at: ctx.now }
  // Its schedule starts it at its time; no request for the runner.
  if (req.mode === 'schedule') {
    const spec = req.schedule!
    // The same rule as the schedule tool's: a repeating time joins the task's others only in their zone.
    const theirs = spec.cron !== undefined ? cronZoneRefusal(schedule, spec.timeZone) : null
    if (theirs) return { ok: false, refusal: 'schedule_zone', message: `Times of this task are in ${theirs}, and this one was given in ${spec.timeZone}: give it in ${theirs}.` }
    try {
      patch.schedule = spec.at !== undefined ? setWake(schedule, { at: spec.at, by: req.delegate, timeZone: spec.timeZone }) : addCron(schedule, spec.cron, spec.timeZone)
      patch.delegation = { agent: req.delegate, ...(req.checkpoint ? { checkpoint: req.checkpoint } : {}) }
    } catch (err) {
      if (err instanceof ScheduleError) return { ok: false, refusal: 'schedule_invalid' }
      throw err
    }
  }
  const was = task.delegation?.agent ?? task.delegate
  if (req.mode === 'together') {
    // The agent no longer works on it alone; the task's schedule is the task's and stays.
    if (was) patch.delegation = null
    if (task.status === 'planned') patch.status = 'active'
  }
  if (req.mode === 'now') lines.push(`Handed to ${req.delegate} with checkpoint ${req.checkpoint}; the owner stays.${req.fresh ? ' It starts in a new session (Start fresh).' : ''}`)
  if (req.mode === 'schedule') {
    // The line is read as the task's status on the board: a time as people read it, never the stored instant.
    const { at, cron, timeZone } = req.schedule!
    const when = at !== undefined ? `for ${formatInZone(Date.parse(at), timeZone)} (${timeZone})` : `${cronInWords(cron) ?? `for "${cron}"`} (${timeZone})`
    lines.push(`Scheduled ${req.delegate} ${when} with checkpoint ${req.checkpoint}; the owner stays.`)
  }
  if (req.mode === 'together') {
    const where = req.desk ? ` in desk ${req.desk}` : ''
    const kept = was && schedule ? ' Its schedule stays.' : ''
    lines.push((ctx.ownSession
      ? `Taken over by the owner in its session${where}.${was ? ` ${was} is no longer delegated, so it does not go on alone; a turn it is in finishes first.` : ''}`
      : `Working on it with ${req.delegate}${where}; the owner stays.${was ? ` ${was} is no longer delegated, so it does not go on alone meanwhile.` : ''}`) + kept)
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
  if (req.mode === 'together') plan.session = { ...(req.desk ? { desk: req.desk } : {}), ...(ctx.ownSession ? { sessionId: ctx.ownSession } : {}) }
  return { ok: true, plan }
}

/** A task can be handed to an agent alone: it has a goal and a name (not the placeholder a session's task starts with). */
export function readyToDelegate(task: Pick<HandOverTask, 'title' | 'displayTitle' | 'goal'>): boolean {
  const named = Boolean(task.displayTitle?.trim()) || !PLACEHOLDER_TITLE.test(task.title ?? '')
  return Boolean(task.goal?.trim()) && named
}

/**
 * What a continued session reads first about a question carried over in the hand-over: it asked that question itself,
 * so it settles it, or asks again what only the owner can answer.
 */
export const continuedBrief = (question: string): string =>
  `Your question was still open when the owner delegated this task: "${question}". Settle it yourself where you can; ask it again only if only the owner can answer it.`

const waitsOfTask = (task: HandOverTask): Wait[] => task.waits ?? waitsOf({ waiting_on: task.waitingOn })

/** The change that puts a task back as it was before a hand-over, its delegation and its schedule. */
export function planUndo(before: HandOverTask): { patch: Required<TaskPatch>; journal: string } {
  const delegation = before.delegation ?? (before.delegate ? { agent: before.delegate, ...(before.checkpoint ? { checkpoint: before.checkpoint } : {}) } : null)
  return {
    patch: { delegation, schedule: before.schedule ?? null, waits: waitsBody(waitsOfTask(before)).waits, status: before.status },
    journal: 'Hand-over undone; the task is back as it was.',
  }
}
