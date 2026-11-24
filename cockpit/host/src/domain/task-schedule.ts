import { isHeld, type Job } from './job.js'
import { nextCronTime, parseAt, parseCron } from './schedule.js'
import type { ScheduleFields } from './delegation.js'

/**
 * A task's schedule (decision task-schedules-live-in-the-brain, brain schema 23): delegation.schedule says when the
 * agent works on the task again — one time (at) or a repeat rule (cron), in a time zone, paused or not, and whether each
 * firing starts a new session or resumes the last one. The next run time is computed from it, never stored.
 *
 * The owner's cockpit fires it with a local job, which keeps what only that machine needs (run counts, failures, grants,
 * reply mode, mail triggers). The job's timing is mirrored into the task (application/schedule-mirror.ts), so every
 * member's board shows "Scheduled · Thu 10:00" and the runner holds the task.
 */

/** A job's timing as the task's schedule; null when it has no time-based trigger or has ended. */
export function scheduleOfJob(job: Pick<Job, 'triggers' | 'target' | 'paused' | 'pendingApproval' | 'endedAt'>): ScheduleFields | null {
  if (job.endedAt) return null
  const trigger = job.triggers.find((t): t is Extract<Job['triggers'][number], { type: 'schedule' }> => t.type === 'schedule')
  if (!trigger) return null
  const when: ScheduleFields = {}
  if (trigger.cron !== undefined) when.cron = trigger.cron
  else {
    const at = parseAt(trigger.at, trigger.timeZone)
    if (at === null) return null
    when.at = new Date(at).toISOString()
  }
  return {
    ...when,
    time_zone: trigger.timeZone,
    ...(isHeld(job) ? { paused: true } : {}),
    session: job.target.type === 'worker' ? 'new' : 'resume',
  }
}

/** The schedule a task's jobs give it: the one of its running job that is due first, else any held one; null without. */
export function scheduleOfJobs(jobs: ReadonlyArray<Pick<Job, 'triggers' | 'target' | 'paused' | 'pendingApproval' | 'endedAt' | 'nextRunAt'>>): ScheduleFields | null {
  const open = jobs.filter((j) => scheduleOfJob(j) !== null)
  const running = open.filter((j) => !isHeld(j) && j.nextRunAt).sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!))
  const pick = running[0] ?? open[0]
  return pick ? scheduleOfJob(pick) : null
}

/** When the schedule fires next after `now` (ISO), or null: paused, a time that has passed, or a rule that never fires. */
export function nextRunOfSchedule(schedule: ScheduleFields | null | undefined, now: number): string | null {
  if (!schedule || schedule.paused) return null
  if (schedule.at) {
    const at = Date.parse(schedule.at)
    return Number.isFinite(at) && at > now ? new Date(at).toISOString() : null
  }
  if (!schedule.cron) return null
  try {
    const next = nextCronTime(parseCron(schedule.cron), schedule.time_zone ?? 'UTC', now)
    return next === null ? null : new Date(next).toISOString()
  } catch {
    return null
  }
}

/** The same schedule, whatever the key order or the ISO form of at. */
export function sameSchedule(a: ScheduleFields | null | undefined, b: ScheduleFields | null | undefined): boolean {
  if (!a || !b) return !a && !b
  const at = (s: ScheduleFields) => (s.at ? Date.parse(s.at) : null)
  return at(a) === at(b) && (a.cron ?? null) === (b.cron ?? null) && (a.time_zone ?? null) === (b.time_zone ?? null)
    && Boolean(a.paused) === Boolean(b.paused) && (a.session ?? null) === (b.session ?? null)
}
