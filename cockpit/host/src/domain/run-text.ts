import { formatInZone, parseCron } from './schedule.js'
import { JOB_HEADER_STATUS } from './turn-end.js'
import type { JobRun, RunFired } from './job.js'

/**
 * What a session reads when the cockpit fires its task's schedule (application/job-runner.ts): one bracketed line
 * that says who sends this and what fired — each repeating time in words and as its cron text, the wake-up with its
 * reason, a channel message, or a run started by hand. The task's own text says what each time is for, so the line
 * only names the time. A new session reads it after the prompt built from its task (application/task-runner.ts
 * stepPrompt); a session that continues reads it alone.
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const two = (n: number) => String(n).padStart(2, '0')
const list = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)

/**
 * A repeating time in words: "on weekdays at 08:00", "every day at 18:00 and 22:00", "every Monday and Thursday at
 * 09:30", "on day 1 of every month at 07:00", "every hour at :15". Null for a cron none of these shapes fit (and for
 * what is not a cron): the caller then shows the cron text alone.
 */
export function cronInWords(cron: string): string | null {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return null
  let spec
  try { spec = parseCron(cron) } catch { return null }
  const [minute, hour, day, month, weekday] = fields
  if (month !== '*' || spec.minutes.length !== 1) return null
  const everyHour = hour === '*'
  if (!everyHour && spec.hours.length > 6) return null
  const m = spec.minutes[0]
  const at = everyHour ? `every hour at :${two(m)}` : `at ${list([...spec.hours].sort((a, b) => a - b).map((h) => `${two(h)}:${two(m)}`))}`
  let days: string
  if (day === '*' && weekday === '*') days = everyHour ? '' : 'every day'
  else if (day === '*') {
    const set = [...spec.weekdays].sort((a, b) => a - b)
    if (set.length === 7) days = everyHour ? '' : 'every day'
    else if (set.join() === '1,2,3,4,5') days = 'on weekdays'
    else if (set.join() === '0,6') days = 'at the weekend'
    else days = everyHour ? `on ${list(set.map((d) => DAYS[d]))}` : `every ${list(set.map((d) => DAYS[d]))}`
  } else if (weekday === '*') {
    const set = [...spec.days].sort((a, b) => a - b)
    if (set.length > 4) return null
    days = `on day ${list(set.map(String))} of every month`
  } else return null
  return everyHour ? [at, days].filter(Boolean).join(' ') : `${days} ${at}`
}

/** A time that was due longer ago than this is said to be late. */
const LATE_MS = 2 * 60_000

const lateness = (dueAt: string, now: number): string => {
  const late = now - Date.parse(dueAt)
  return late > LATE_MS ? `, ${Math.round(late / 60_000)} min late` : ''
}

/**
 * What fired, as a half sentence: "the repeating time on weekdays at 08:00 (cron "0 8 * * 1-5", Asia/Makassar), due
 * Mon 9 Nov 08:00", "the wake-up set for Fri 13 Nov 10:00 (Asia/Makassar)", "a new message on mail", "the owner
 * started it by hand (Run now)". Several are joined with "; "; a wake-up that joined a run started by hand or by a
 * message is named after it. `zone`: where the user reads a time when the schedule
 * names no zone.
 */
export function firedWords(run: Pick<JobRun, 'trigger' | 'dueAt' | 'fired'>, now: number, zone: string): string {
  const fired: RunFired = run.fired ?? {}
  const tz = fired.timeZone ?? zone
  const parts: string[] = []
  if (run.trigger === 'manual') parts.push('the owner started it by hand (Run now)')
  else if (run.trigger !== 'schedule') parts.push(`a new message on ${run.trigger}`)
  // A wake-up that came due while the run waited to start joined it, whatever started the run.
  if (fired.wake) parts.push(`the wake-up set for ${formatInZone(Date.parse(fired.wake.at), tz)} (${tz})${lateness(fired.wake.at, now)}`)
  for (const cron of fired.crons ?? []) {
    const words = cronInWords(cron.cron)
    parts.push(`the repeating time ${words ? `${words} ` : ''}(cron "${cron.cron}", ${tz}), due ${formatInZone(Date.parse(cron.dueAt), tz)}${lateness(cron.dueAt, now)}`)
  }
  return parts.length > 0 ? parts.join('; ') : `a time due ${formatInZone(Date.parse(run.dueAt), tz)} (${tz})${lateness(run.dueAt, now)}`
}

/**
 * What every run for a task's schedule reads: while the schedule is on, the task is not closed (a review approves one
 * run; its owner ends the schedule and closes the task).
 */
export const SCHEDULE_TASK_RULE = 'While the task has a schedule, never close it, whatever its checkpoint: hand the result over; its owner ends the schedule and closes the task.'

/**
 * The line that names what fired, and after it what belongs to the firing: the wake-up's reason (what the session
 * that set it wanted done then) and a channel message's text (counts, never content).
 */
export function firedText(run: Pick<JobRun, 'number' | 'trigger' | 'dueAt' | 'fired' | 'message'>, task: { id: string; name: string }, now: number, zone: string): string {
  const line = `[From the cockpit, not from your user: run ${run.number} for task "${task.name}" (${task.id.slice(0, 8)}). `
    + `What fired: ${firedWords(run, now, zone)}. Nobody may be watching: ${JOB_HEADER_STATUS}. ${SCHEDULE_TASK_RULE}]`
  const why = run.fired?.wake?.why?.trim()
  return [line, ...(why ? [`The wake-up's reason: ${why}`] : []), ...(run.message ? [run.message] : [])].join('\n\n')
}

/** Who started a new session for a run, as the prompt built from its task begins (stepPrompt's startedBy). */
export function startedBy(run: Pick<JobRun, 'trigger'>): string {
  if (run.trigger === 'manual') return 'The task\'s owner (Run now)'
  return run.trigger === 'schedule' ? 'The task\'s schedule' : `A new message on ${run.trigger}`
}
