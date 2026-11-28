import type { TurnResult } from './task-turn.js'

/**
 * Waiting on its steps: a main task whose open steps are all
 * covered waits on them, outside Needs you and the Inbox. Derived from what the board already knows of each step, never
 * a field an agent sets.
 *
 * A step is covered when something moves it or someone has it in view:
 *   - an agent works on it (working);
 *   - its schedule or the runner starts it later, or it waits for a sibling it depends on (checks_back, runner);
 *   - it waits on someone (waits), or its own wait is parked (parked);
 *   - the owner has a row on the step itself: a question, a review, a step of theirs, a failed run (asked);
 *   - it waits on steps of its own (steps).
 * One that nobody is on (Needs you · nobody, the owner's own, a parent not active) is not covered: then the main task
 * stays where it would be without steps, so nothing hides that someone has to move.
 *
 * A covered step can still stall: it is open, nothing works on it, nothing will start it at a time, and nothing
 * happened on it for STALL_MS, or its due date has passed. A stalled step counts as not covered, and puts one row on
 * the owner's Inbox ("Step <name> stalled").
 */

export type StepHow = 'working' | 'checks_back' | 'runner' | 'waits' | 'parked' | 'asked' | 'steps'

/** No turn on a step for this long, with nothing coming that starts it: it stalled. */
export const STALL_MS = 24 * 60 * 60 * 1000

/** One open step as its main task shows it. */
export interface StepCover {
  id: string
  name: string
  /** What covers it; null when nothing does (or it stalled). */
  how: StepHow | null
  /** checks_back: its next run. */
  at?: string
  /** waits: whom it waits on. working, checks_back, runner: the agent on it. */
  who?: string
}

/** A stalled step: why, and since when nothing happened on it. */
export interface Stall {
  stepId: string
  name: string
  /** Its last activity: the newest of its last update and its runs' last activity. */
  since: string
  why: 'idle' | 'due'
  due?: string
}

/** What the board knows of one step. */
export interface StepFacts {
  id: string
  name: string
  turn: TurnResult
  delegate?: string
  waitingOn?: { who?: string }
  nextRunAt: string | null
  due?: string
  /** The newest of its last update and its runs' last activity (ISO), if known. */
  lastActivity?: string | null
}

/** What covers the step, read from its turn; null when nothing does. */
export function coverOf(step: Pick<StepFacts, 'turn'>): StepHow | null {
  const { turn, group } = step.turn
  if (turn === 'agent_working') return group === 'stale' ? null : 'working'
  if (turn === 'agent_scheduled') {
    if (group === 'steps') return 'steps'
    if (group === 'runner' || group === 'blocked') return 'runner'
    return 'checks_back'
  }
  if (turn === 'waiting_on_others') return 'waits'
  if (turn === 'parked') return 'parked'
  if (turn === 'review') return 'asked'
  if (turn === 'needs_you' && (group === 'asked' || group === 'failed')) return 'asked'
  return null
}

/** The step stalled: why, or null. A step an agent works on, or one the owner has a row on, never stalls. */
export function stallOf(step: StepFacts, now: number): Stall | null {
  const how = coverOf(step)
  if (how === 'working' || how === 'asked' || how === 'steps') return null
  const since = step.lastActivity ?? null
  // Past its due date: the day it was due is over (in UTC, as the board reads due dates).
  if (step.due && step.due.slice(0, 10) < new Date(now).toISOString().slice(0, 10)) return { stepId: step.id, name: step.name, since: since ?? step.due, why: 'due', due: step.due }
  // Something will start it at a time: it is not stalled while that time is ahead.
  if (how === 'checks_back' || how === 'runner' || how === 'parked') return null
  const at = since ? Date.parse(since) : NaN
  if (Number.isFinite(at) && now - at >= STALL_MS) return { stepId: step.id, name: step.name, since: since!, why: 'idle' }
  return null
}

/** The open steps of a main task, as its card and the turn read them. */
export interface StepsSummary {
  /** Its open steps, covered first, the working ones before the others. */
  open: StepCover[]
  /** Every open step is covered (and none stalled). */
  covered: boolean
  stalls: Stall[]
}

const ORDER: readonly StepHow[] = ['working', 'asked', 'checks_back', 'waits', 'runner', 'steps', 'parked']

/** The summary of a main task's open steps; null when it has none. */
export function stepsSummary(steps: readonly StepFacts[], now: number): StepsSummary | null {
  if (steps.length === 0) return null
  const stalls: Stall[] = []
  const open: StepCover[] = steps.map((s) => {
    const stall = stallOf(s, now)
    if (stall) stalls.push(stall)
    const how = stall ? null : coverOf(s)
    const who = how === 'waits' ? s.waitingOn?.who : how === 'working' || how === 'checks_back' || how === 'runner' ? s.delegate : undefined
    return { id: s.id, name: s.name, how, ...(how === 'checks_back' && s.nextRunAt ? { at: s.nextRunAt } : {}), ...(who ? { who } : {}) }
  })
  const rank = (c: StepCover) => (c.how === null ? ORDER.length : ORDER.indexOf(c.how))
  open.sort((a, b) => rank(a) - rank(b))
  return { open, covered: open.every((c) => c.how !== null), stalls }
}
