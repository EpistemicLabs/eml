import type { ScheduleFields } from './delegation.js'
import { cronInWords } from './run-text.js'
import { formatInZone } from './schedule.js'
import { nextRunOfSchedule } from './task-schedule.js'
import { waitKind, type WaitingOn } from './task-turn.js'
import { withoutOutside } from './turn-end.js'

/**
 * What the task holds after an end_turn call, as the tool's answer ends with it (decision
 * asks-and-check-backs-are-separate: a tool returns the resulting state). In words an agent reads, without ids:
 *
 *   The task now — Lifecycle: open. Asks: lasse's move: sign the form (due 2026-11-28). Check: kept, atlas checks
 *   back Fri 27 Nov 10:00 (Asia/Bangkok). Repeating: none. Next run: Fri 27 Nov 10:00 (Asia/Bangkok).
 *
 * Times are the user's local time, with the zone they were read in.
 */

/** What the call did to the wake-up (application/turn-wake.ts WakeOutcome). */
export type CheckOutcome = 'set' | 'kept' | 'removed' | 'none'

export interface TaskStateFacts {
  /** The task's status: planned, active, resolved, invalidated. */
  status: string
  /** The task's waits after the call. */
  waits: readonly WaitingOn[]
  /** The task's schedule after the call. */
  schedule: ScheduleFields | null
  outcome: CheckOutcome
  /** The user's time zone: the times are said in it. */
  zone: string
  now: number
  /** The viewer the cockpit runs for (the owner): a wake-up for them is a reminder. */
  owner?: string
}

const LIFECYCLE: Record<string, string> = {
  planned: 'planned, not started',
  active: 'open',
  resolved: 'closed (done)',
  invalidated: 'closed (dropped)',
  superseded: 'closed (replaced)',
}

const end = (text: string) => text.replace(/[.\s]+$/, '')

/** A time as the user reads it, with the zone it is in. */
export const localTime = (at: string, zone: string): string => `${formatInZone(Date.parse(at), zone)} (${zone})`

/** A due as people read it: a date as written, an instant in the user's zone. */
const dueText = (due: string, zone: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(due) ? due : localTime(due, zone))

/** One wait as a short phrase: "lasse's move: sign the form (due 2026-11-28)". */
export function askPhrase(w: WaitingOn, zone: string): string {
  const who = withoutOutside(w.who)
  const why = w.why ? `: ${end(w.why)}` : ''
  const due = w.due ? ` (due ${dueText(w.due, zone)})` : ''
  switch (waitKind(w)) {
    case 'question': return `a question for ${who}${why}${due}`
    case 'go': return `${who}'s go${why}${due}`
    case 'stopped': return `stopped, for ${who}${why}`
    case 'do': return `${who}'s move${why}${due}`
    case 'review': return `review for ${who}${why}${due}`
    default: return `waiting on ${who}${why}${due}`
  }
}

/** The wake-up as a phrase: "atlas checks back <time>", or "a reminder for lasse at <time>". */
export function checkPhrase(schedule: ScheduleFields, zone: string, owner?: string): string {
  const at = localTime(schedule.at!, zone)
  if (schedule.by && owner && schedule.by === owner) return `a reminder for ${schedule.by} at ${at}`
  return `${schedule.by ?? 'the agent'} checks back ${at}`
}

function repeatingText(schedule: ScheduleFields | null): string {
  if (!schedule?.crons?.length) return 'none'
  const zone = schedule.time_zone ?? 'UTC'
  const times = schedule.crons.map((c) => cronInWords(c) ?? `"${c}"`).join('; ')
  return `${times} (${zone})${schedule.paused ? ', paused' : ''}${schedule.ends_at ? `, until ${localTime(schedule.ends_at, zone)}` : ''}`
}

export function stateEcho(facts: TaskStateFacts): string {
  const { schedule, zone } = facts
  const asks = facts.waits.length > 0 ? facts.waits.map((w) => askPhrase(w, zone)).join('; ') : 'none'
  const check = schedule?.at
    ? `${facts.outcome === 'set' ? 'set' : 'kept'}, ${checkPhrase(schedule, zone, facts.owner)}`
    : facts.outcome === 'removed' ? 'removed, no wake-up' : 'none'
  const open = facts.status === 'planned' || facts.status === 'active'
  const next = open ? nextRunOfSchedule(schedule, facts.now) : null
  return [
    `The task now — Lifecycle: ${LIFECYCLE[facts.status] ?? facts.status}.`,
    `Asks: ${asks}.`,
    `Check: ${check}.`,
    `Repeating: ${repeatingText(schedule)}.`,
    `Next run: ${next ? localTime(next, zone) : 'none'}.`,
  ].join(' ')
}
