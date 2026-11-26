import { nextCronTime, parseCron, shortestGap } from './schedule.js'
import type { DelegationFields, ScheduleFields } from './delegation.js'

/**
 * A task's schedule (decision task-schedules-live-in-the-brain; brain schema 24): delegation.schedule is the only place
 * a schedule lives. It holds repeating times (crons, read in time_zone) and at most one wake-up (at, with its reason
 * why and the session that set it, by_session); paused and ends_at hold for the whole schedule. The next run is
 * computed from it, never stored, and the task's text says what each time is for.
 *
 * The cockpit of the task's owner fires it. What only that machine needs it keeps in a local record per task
 * (domain/job.ts): among it the cursor the crons are due after and the wake-up it fired last.
 *
 * Everything here is pure. The edit helpers take a schedule (or null: none) and return the next one, or null when
 * nothing is left; a bad input throws a ScheduleError whose message the caller shows. A schedule is written to the
 * brain through application/task-schedule-write.ts, never by hand: a write of a whole delegation without its schedule
 * ends the schedule.
 */

/**
 * The notes the schedule mirror (removed with schema 24) wrote with a schedule before it wrote the field alone. A task
 * whose newest note is one of them has no status line from it (domain/status-line.ts): it says nothing about where
 * the task stands.
 */
export const MIRROR_NOTES: readonly string[] = [
  'Its schedule, as the job on the owner\'s cockpit runs it.',
  'No job runs it at a time any more: its schedule is cleared.',
]

/** What the brain accepts (packages/core): more is refused, so the helpers refuse or cut before the write. */
export const SCHEDULE_LIMITS = {
  /** Repeating times per task. */
  crons: 10,
  /** Characters of a wake-up's reason; a longer one is cut. */
  whyChars: 2000,
} as const

/** A schedule edit that cannot be made; its message says why, for whoever asked. */
export class ScheduleError extends Error {}

type Scheduled = { properties?: { delegation?: { schedule?: ScheduleFields | null } | null } | null }

/** The task's schedule, or null: one without a repeating time and without a wake-up is none. */
export function scheduleOf(task: Scheduled): ScheduleFields | null {
  return tidy(task.properties?.delegation?.schedule)
}

/**
 * The task has a schedule: the task is the truth, whatever this cockpit knows of it. Such a task is not closed: a
 * review approves one run, Close is refused, End schedule clears it and closes the task. A paused schedule and one
 * past its end still count: only ending it takes it off the task.
 */
export function hasSchedule(task: Scheduled): boolean {
  return scheduleOf(task) !== null
}

const iso = (at: number) => new Date(at).toISOString()
const time = (text: string | null | undefined): number | null => {
  const at = text ? Date.parse(text) : NaN
  return Number.isFinite(at) ? at : null
}

/** The schedule with its keys in the brain's order and nothing empty; null when it has no time at all. */
function tidy(schedule: ScheduleFields | null | undefined): ScheduleFields | null {
  if (!schedule) return null
  const crons = [...new Set((schedule.crons ?? []).map((c) => c.trim()).filter(Boolean))]
  const at = time(schedule.at)
  if (crons.length === 0 && at === null) return null
  const ends = time(schedule.ends_at)
  return {
    ...(crons.length > 0 ? { crons } : {}),
    ...(at !== null ? { at: iso(at) } : {}),
    ...(at !== null && schedule.why?.trim() ? { why: schedule.why.trim().slice(0, SCHEDULE_LIMITS.whyChars) } : {}),
    ...(at !== null && schedule.by_session ? { by_session: schedule.by_session } : {}),
    ...(schedule.time_zone ? { time_zone: schedule.time_zone } : {}),
    ...(schedule.paused ? { paused: true } : {}),
    ...(ends !== null ? { ends_at: iso(ends) } : {}),
  }
}

/** A cron's next time after `after` in the zone; null when it never fires or is not a cron. */
function nextOf(cron: string, zone: string, after: number): number | null {
  try {
    return nextCronTime(parseCron(cron), zone, after)
  } catch {
    return null
  }
}

/** The schedule fires nothing now: paused, or past its end. */
const isOff = (schedule: ScheduleFields, now: number): boolean => {
  const ends = time(schedule.ends_at)
  return Boolean(schedule.paused) || (ends !== null && now > ends)
}

/** The schedule fires nothing at `now`: there is none, it is paused, or its end has passed. */
export function scheduleIsOff(schedule: ScheduleFields | null | undefined, now: number): boolean {
  const s = tidy(schedule)
  return !s || isOff(s, now)
}

/** Two times name the same instant, whatever their ISO form; false when either is no time. */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  const at = time(a)
  return at !== null && at === time(b)
}

/**
 * When the schedule fires next after `now` (ISO): the earliest of its wake-up and each repeating time's next one.
 * Null: no schedule, paused, ended (nothing at or before ends_at is left), or no time ahead. A wake-up that has passed
 * is not ahead: it is due (dueOf), not next.
 */
export function nextRunOfSchedule(schedule: ScheduleFields | null | undefined, now: number): string | null {
  const s = tidy(schedule)
  if (!s || isOff(s, now)) return null
  const times: number[] = []
  const at = time(s.at)
  if (at !== null && at > now) times.push(at)
  for (const cron of s.crons ?? []) {
    const next = nextOf(cron, s.time_zone ?? 'UTC', now)
    if (next !== null) times.push(next)
  }
  if (times.length === 0) return null
  const next = Math.min(...times)
  const ends = time(s.ends_at)
  return ends !== null && next > ends ? null : iso(next)
}

/** What this cockpit remembers of a task's schedule (the local record, domain/job.ts). */
export interface ScheduleState {
  /** Repeating times are due after it (ISO); null: the schedule was not seen before. */
  cursor?: string | null
  /** The wake-up fired last (its at): it fires once, also when clearing it on the task failed. */
  firedWake?: string | null
}

export interface DueWake { at: string; why: string | null; bySession: string | null }
export interface DueCron { cron: string; dueAt: string }

export interface ScheduleDue {
  /** What fires now, as ONE firing that names every time that is due; null when nothing is. dueAt: the earliest of them. */
  firing: { dueAt: string; wake: DueWake | null; crons: DueCron[] } | null
  /** Repeating times that were due longer ago than the late limit (the cockpit was not running): recorded, not run. */
  missed: DueCron[]
  /** The cursor to keep from now on. It moves only when it has to, so a pass with nothing due writes nothing. */
  cursor: string
}

/**
 * What of a schedule is due at `now`.
 *
 *   - The wake-up is due once its time has come, however long ago (it fires late), unless it is the one fired last.
 *   - A repeating time is due when its first time after the cursor has come; later than `lateLimitMs` it is missed
 *     instead. Each cron gives at most one time per pass: what else fell due while the cockpit was down is not made up.
 *   - A schedule seen for the first time (no cursor) is due from now on: no repeating time of the past fires.
 *   - A paused schedule and one past ends_at are never due; their cursor moves to now, so nothing from that time is
 *     made up afterwards.
 *
 * The caller keeps `cursor` at once. The wake-up has fired only when a run that carries it got to a session: then the
 * caller sets firedWake to its at and clears it on the task; until then it is due again at every pass.
 */
export function dueOf(schedule: ScheduleFields | null | undefined, state: ScheduleState, now: number, lateLimitMs: number): ScheduleDue {
  const s = tidy(schedule)
  const cursor = time(state.cursor)
  if (!s || isOff(s, now)) return { firing: null, missed: [], cursor: iso(now) }

  const at = time(s.at)
  const wake: DueWake | null = at !== null && at <= now && at !== time(state.firedWake)
    ? { at: iso(at), why: s.why ?? null, bySession: s.by_session ?? null }
    : null

  const due: DueCron[] = []
  const missed: DueCron[] = []
  if (cursor !== null) {
    for (const cron of s.crons ?? []) {
      const next = nextOf(cron, s.time_zone ?? 'UTC', cursor)
      if (next === null || next > now) continue
      ;(now - next > lateLimitMs ? missed : due).push({ cron, dueAt: iso(next) })
    }
  }
  const moved = cursor === null || due.length > 0 || missed.length > 0
  const firing = wake || due.length > 0
    ? { dueAt: iso(Math.min(...(wake ? [Date.parse(wake.at)] : []), ...due.map((d) => Date.parse(d.dueAt)))), wake, crons: due }
    : null
  return { firing, missed, cursor: moved ? iso(now) : iso(cursor) }
}

/** What this cockpit knows of a task's schedule beside the task: its record's state, and a run of it that waits to start. */
export interface ScheduleFacts extends ScheduleState {
  /** The due time of a run that waits to start (no room yet, a busy session); null or absent: none. */
  waitingRunDueAt?: string | null
  /** New channel addresses of the task wait for the user's OK (the record's pendingApproval): the board shows it. */
  needsOk?: boolean
}

/**
 * When the task is started next for its schedule, as this cockpit knows it (ISO), or null when nothing is coming: a
 * run that waits to start (its due time), else a time that is due now and not fired yet (the wake-up, a repeating
 * time after the cursor), else the schedule's next time ahead. What holds the task runner off a task, what the
 * next-step check counts as a next trigger, and what the board shows as the next run. A time already due lies in the
 * past.
 */
export function runComingAt(schedule: ScheduleFields | null | undefined, facts: ScheduleFacts, now: number, lateLimitMs: number): string | null {
  if (facts.waitingRunDueAt) return facts.waitingRunDueAt
  return dueOf(schedule, facts, now, lateLimitMs).firing?.dueAt ?? nextRunOfSchedule(schedule, now)
}

/**
 * Why a repeating time cannot be taken, or null: not a cron, one that never fires, or one that fires more often than
 * `minGapMs` (domain/job.ts JOB_LIMITS.minGapMs).
 */
export function cronRefusal(cron: string, zone: string, now: number, minGapMs: number): string | null {
  let spec
  try { spec = parseCron(cron) } catch (err) { return `cron: ${(err as Error).message}` }
  if (nextCronTime(spec, zone, now) === null) return 'that cron never fires'
  const gap = shortestGap(spec, zone, now)
  if (gap !== null && gap < minGapMs) return `that cron fires every ${Math.round(gap / 60_000)} min; at most every ${minGapMs / 60_000} min`
  return null
}

const checked = (cron: string): string => {
  const text = cron.trim()
  try { parseCron(text) } catch (err) { throw new ScheduleError(`cron: ${(err as Error).message}`) }
  return text
}

/**
 * Set the wake-up: it replaces the task's wake-up and never touches a repeating time. `at` is an instant (ISO);
 * `timeZone` is kept only when the schedule names none yet.
 */
export function setWake(schedule: ScheduleFields | null | undefined, wake: { at: string; why?: string | null; bySession?: string | null; timeZone?: string }): ScheduleFields {
  const at = time(wake.at)
  if (at === null) throw new ScheduleError(`at: "${wake.at}" is not a date and time`)
  const { why: _why, by_session: _by, ...rest } = schedule ?? {}
  return tidy({
    ...rest, at: iso(at),
    ...(wake.why ? { why: wake.why } : {}),
    ...(wake.bySession ? { by_session: wake.bySession } : {}),
    ...(rest.time_zone || !wake.timeZone ? {} : { time_zone: wake.timeZone }),
  })!
}

/**
 * Clear the wake-up, with its reason and its session; the repeating times stay. With `onlyBySession` it is cleared
 * only when that session set it. Null when nothing is left.
 */
export function clearWake(schedule: ScheduleFields | null | undefined, opts: { onlyBySession?: string } = {}): ScheduleFields | null {
  if (!schedule) return null
  if (opts.onlyBySession !== undefined && schedule.by_session !== opts.onlyBySession) return tidy(schedule)
  const { at: _at, why: _why, by_session: _by, ...rest } = schedule
  return tidy(rest)
}

/**
 * Add a repeating time; one the task already has is not added twice. `timeZone` is the zone the crons are read in
 * when the schedule has no repeating time yet: all of a task's crons are read in one zone, so a later one joins it.
 */
export function addCron(schedule: ScheduleFields | null | undefined, cron: string, timeZone?: string): ScheduleFields {
  const text = checked(cron)
  const crons = schedule?.crons ?? []
  if (crons.map((c) => c.trim()).includes(text)) return tidy(schedule)!
  if (crons.length >= SCHEDULE_LIMITS.crons) throw new ScheduleError(`a task has at most ${SCHEDULE_LIMITS.crons} repeating times; remove one first`)
  const zone = crons.length > 0 ? schedule?.time_zone ?? timeZone : timeZone ?? schedule?.time_zone
  return tidy({ ...schedule, crons: [...crons, text], ...(zone ? { time_zone: zone } : {}) })!
}

/**
 * The zone a cron must be written in to join the schedule, when `zone` is another one: a task's repeating times are
 * read in ONE zone, so a cron written elsewhere would join it at other hours than its writer meant. Null when the
 * cron can be added as it is (the schedule has no repeating time yet, or theirs is this zone). The one rule for every
 * way a repeating time is added: the schedule tool and the page's hand-over.
 */
export function cronZoneRefusal(schedule: ScheduleFields | null | undefined, zone: string): string | null {
  const theirs = schedule?.crons?.length ? schedule.time_zone : undefined
  return theirs && theirs !== zone ? theirs : null
}

/** Remove a repeating time. Removing the last one of a schedule without a wake-up leaves no schedule: null. */
export function removeCron(schedule: ScheduleFields | null | undefined, cron: string): ScheduleFields | null {
  if (!schedule) return null
  const { crons = [], ...rest } = schedule
  const left = crons.filter((c) => c.trim() !== cron.trim())
  return tidy(left.length > 0 ? { ...rest, crons: left } : rest)
}

/** Replace all repeating times; an empty list removes them. Null when nothing is left. */
export function setCrons(schedule: ScheduleFields | null | undefined, crons: readonly string[], timeZone?: string): ScheduleFields | null {
  const next = [...new Set(crons.map(checked))]
  if (next.length > SCHEDULE_LIMITS.crons) throw new ScheduleError(`a task has at most ${SCHEDULE_LIMITS.crons} repeating times`)
  const { crons: _old, ...rest } = schedule ?? {}
  return tidy({ ...rest, ...(next.length > 0 ? { crons: next } : {}), ...(timeZone ? { time_zone: timeZone } : {}) })
}

/** Pause or resume the whole schedule. Null without one. */
export function setPaused(schedule: ScheduleFields | null | undefined, paused: boolean): ScheduleFields | null {
  if (!schedule) return null
  const { paused: _was, ...rest } = schedule
  return tidy(paused ? { ...rest, paused: true } : rest)
}

/** Set when the schedule ends (ISO), or take the end off with null. Null without a schedule. */
export function setEndsAt(schedule: ScheduleFields | null | undefined, endsAt: string | null): ScheduleFields | null {
  if (!schedule) return null
  const { ends_at: _was, ...rest } = schedule
  if (endsAt === null) return tidy(rest)
  const at = time(endsAt)
  if (at === null) throw new ScheduleError(`ends_at: "${endsAt}" is not a date and time`)
  return tidy({ ...rest, ends_at: iso(at) })
}

/** The same schedule, whatever the key order or the ISO form of its times. */
export function sameSchedule(a: ScheduleFields | null | undefined, b: ScheduleFields | null | undefined): boolean {
  return JSON.stringify(tidy(a)) === JSON.stringify(tidy(b))
}

/**
 * The delegation with this schedule, everything else unchanged; null takes the schedule off. What every write of a
 * whole delegation goes through: the brain reads a delegation without a schedule as the end of the schedule.
 */
export function withSchedule<D extends DelegationFields>(delegation: D, schedule: ScheduleFields | null | undefined): D {
  const { schedule: _old, ...rest } = delegation
  const next = tidy(schedule)
  return (next ? { ...rest, schedule: next } : rest) as D
}

/** "0 8 * * 1-5; 0 18 * * 1-5 (Europe/Berlin), wake-up 2026-11-27T02:00:00.000Z, paused": a schedule for a journal line or a report. */
export function scheduleText(schedule: ScheduleFields | null | undefined): string {
  const s = tidy(schedule)
  if (!s) return 'none'
  const parts = [
    ...(s.crons ? [`${s.crons.join('; ')}${s.time_zone ? ` (${s.time_zone})` : ''}`] : []),
    ...(s.at ? [`wake-up ${s.at}`] : []),
    ...(s.ends_at ? [`until ${s.ends_at}`] : []),
    ...(s.paused ? ['paused'] : []),
  ]
  return parts.join(', ')
}
