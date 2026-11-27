import type { ScheduleFields } from './delegation.js'
import { cronInWords } from './run-text.js'
import { localTime } from './schedule.js'
import { isReminder, nextRunOfSchedule, wakeOwnerText, type WakePeople } from './task-schedule.js'
import { waitKind, type WaitingOn } from './task-turn.js'
import { DATE_ONLY, withoutOutside } from './turn-end.js'

/**
 * What the task holds after an end_turn call, as the tool's answer ends with it (decision
 * asks-and-check-backs-are-separate: a tool returns the resulting state). In words an agent reads, without ids:
 *
 *   The task now — Lifecycle: open. Asks: dev-user's move: sign the form (due 2026-11-28). Check: kept, atlas checks
 *   back Fri 27 Nov 10:00 (Asia/Bangkok). Repeating: none. Next run: Fri 27 Nov 10:00 (Asia/Bangkok).
 *
 * Times are the user's local time, with the zone they were read in.
 */

/** What the call did to the wake-up: set it, kept the one there was, removed it, or there is none and was none. */
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
  /** Who a wake-up can be a person's reminder for (domain/task-schedule.ts isReminder). */
  people?: WakePeople
}

const LIFECYCLE: Record<string, string> = {
  planned: 'planned, not started',
  active: 'open',
  resolved: 'closed (done)',
  invalidated: 'closed (dropped)',
  superseded: 'closed (replaced)',
}

const end = (text: string) => text.replace(/[.\s]+$/, '')

/** A due as people read it: a date as written, an instant in the user's zone. */
const dueText = (due: string, zone: string): string => (DATE_ONLY.test(due) ? due : localTime(due, zone))

/** One wait as a short phrase: "dev-user's move: sign the form (due 2026-11-28)". */
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

/** The wake-up as a phrase: "atlas checks back <time>", or "a reminder for dev-user at <time>". */
export function checkPhrase(schedule: ScheduleFields, zone: string, people: WakePeople = { me: '' }): string {
  const at = localTime(schedule.at!, zone)
  return `${wakeOwnerText(schedule.by, people)}${isReminder(schedule.by, people) ? ' at' : ''} ${at}`
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
    ? `${facts.outcome === 'set' ? 'set' : 'kept'}, ${checkPhrase(schedule, zone, facts.people)}`
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
