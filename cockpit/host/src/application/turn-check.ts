import { isOpenRun, JOB_LIMITS } from '../domain/job.js'
// SEAM (part B3): a turn's check still is a version 1 job (domain/job-v1.ts); see the comment below.
import { isScheduleTrigger, type JobV1 as Job } from '../domain/job-v1.js'
import { checkJobName } from '../domain/turn-end.js'
import type { JobStore } from '../job-store.js'
import type { JobAnswer, JobCaller } from './jobs.js'

/**
 * The check an end_turn call asks for with next.when (domain/turn-end.ts): one
 * one-time job per session that wakes this session at that time, the same job
 * the schedule tool makes with at, target self and the session's task.
 *
 * The job carries origin 'end_turn', so the session's later calls find it: a
 * call with another time moves it (a check that already ran is used again, on
 * the task the session works on now), a call without a time removes it. A
 * check whose own run is still open (it woke the session, and that turn ends
 * without a time) is ended, not removed: its run has yet to be settled and
 * told to the user. A job the agent made itself with the schedule tool has no
 * such mark and is never touched here.
 *
 * SEAM (part B3 of "a task holds its schedule"): this file goes. end_turn's next.when sets the wake-up of the
 * session's task (domain/task-schedule.ts setWake with by_session, written through application/task-schedule-write.ts);
 * a turn without a time clears it when this session set it (clearWake onlyBySession). Until then the schedule tool
 * it calls answers that it is being rebuilt (application/jobs.ts SCHEDULE_TOOL_REBUILT), so a call with a time is
 * told its check was not set.
 */

export interface TurnCheckDeps {
  /** The schedule tool's actions (application/jobs.ts): the check is made with the session's own reach and limits. */
  jobs: { handle(caller: JobCaller, input: Record<string, unknown>): Promise<JobAnswer> }
  store: Pick<JobStore<Job>, 'list' | 'put' | 'runs'>
  callerOf(sessionId: string): JobCaller | null
  /** The user's time zone now: a moved check reads its new time in it, not in the zone it was first set in. */
  zone?: () => string
  log(line: string): void
}

export interface CheckWanted {
  /** The time as the call wrote it; null: the call names none. */
  at: string | null
  /** The session's task as the user knows it; null without one. */
  taskName: string | null
  /** What the session reads when the check wakes it. */
  prompt: string
}

export interface TurnCheck {
  /** Brings the session's check in line with its call. Answers why the check could not be set, or null. Never throws. */
  settle(sessionId: string, wanted: CheckWanted): Promise<string | null>
  /** The session's check still to run: the zone its time was read in and the instant saved; null without one. */
  saved(sessionId: string): { at: number; zone: string } | null
}

const NO_TASK = 'this session'

/** "2026-11-26T20:15 (Asia/Bangkok) = 2026-11-26T13:15:00.000Z": the time as written, the zone it was read in and the instant saved. */
export function checkTimeLine(written: string, job: Pick<Job, 'triggers'> | undefined): string {
  const trigger = job?.triggers.find(isScheduleTrigger)
  return trigger?.at ? `${written} (${trigger.timeZone}) = ${trigger.at}` : written
}

/** The check's name within the limit for job names; `tag` tells two sessions' checks on one task apart. */
export function checkName(taskName: string | null, tag = ''): string {
  const suffix = tag ? ` (${tag})` : ''
  const room = JOB_LIMITS.nameChars - checkJobName('').length - suffix.length
  const name = (taskName ?? NO_TASK).replace(/\s+/g, ' ').trim()
  return `${checkJobName(name.length > room ? `${name.slice(0, room - 1)}…` : name)}${suffix}`
}

export function createTurnCheck(deps: TurnCheckDeps): TurnCheck {
  /** The session's checks, the one still to run first. */
  const checksOf = (sessionId: string): Job[] => deps.store.list()
    .filter((job) => job.origin === 'end_turn' && job.createdBy === sessionId)
    .sort((a, b) => Number(Boolean(a.endedAt)) - Number(Boolean(b.endedAt)))

  const settle = async (sessionId: string, wanted: CheckWanted): Promise<string | null> => {
    const caller = deps.callerOf(sessionId)
    const [check, ...more] = checksOf(sessionId)
    if (!caller) return wanted.at ? 'the cockpit does not know this session' : null
    // One check per session: any other is left over from an earlier one.
    const stale = wanted.at ? more : [check, ...more].filter((job): job is Job => Boolean(job))
    for (const job of stale.filter((j) => !j.endedAt)) {
      // Removing a job removes its runs: one that is still open would never be settled.
      const action = deps.store.runs(job.id).some(isOpenRun) ? 'finish' : 'delete'
      const answer = await deps.jobs.handle(caller, { action, job: job.id })
      const done = action === 'finish' ? 'ended, its run is still open' : 'removed'
      deps.log(`[check] ${sessionId.slice(0, 8)} check ${job.id.slice(0, 8)} ${answer.status < 400 ? done : `not ${action === 'finish' ? 'ended' : 'removed'}: ${answer.text}`}`)
    }
    if (!wanted.at) return null

    // Another job of the space goes by the name (another session's check on the same task, or a job the agent named so): this one says whose it is.
    const name = checkName(wanted.taskName)
    const taken = deps.store.list().some((job) => job.id !== check?.id && !job.endedAt && (job.spaceId ?? null) === (caller.spaceId ?? null) && job.name.toLowerCase() === name.toLowerCase())
    const as = taken ? checkName(wanted.taskName, sessionId.slice(0, 8)) : name
    if (check) {
      // The session may work on another task by now: the check goes with it.
      const answer = await deps.jobs.handle(caller, { action: 'update', job: check.id, at: wanted.at, ...(deps.zone ? { timezone: deps.zone() } : {}), prompt: wanted.prompt, name: as, task_id: caller.taskId ?? '' })
      if (answer.status >= 400) return answer.text
      deps.log(`[check] ${sessionId.slice(0, 8)} check ${check.id.slice(0, 8)} moved to ${checkTimeLine(wanted.at, answer.job ?? deps.store.list().find((job) => job.id === check.id))}`)
      return null
    }
    const answer = await deps.jobs.handle(caller, { action: 'create', name: as, prompt: wanted.prompt, at: wanted.at, target: 'self' })
    if (answer.status >= 400 || !answer.job) return answer.text
    deps.store.put({ ...answer.job, origin: 'end_turn' })
    deps.log(`[check] ${sessionId.slice(0, 8)} check ${answer.job.id.slice(0, 8)} set for ${checkTimeLine(wanted.at, answer.job)}`)
    return null
  }

  return {
    saved(sessionId) {
      const check = checksOf(sessionId).find((job) => !job.endedAt)
      const trigger = check?.triggers.find(isScheduleTrigger)
      return trigger?.at ? { at: Date.parse(trigger.at), zone: trigger.timeZone } : null
    },
    async settle(sessionId, wanted) {
      try {
        return await settle(sessionId, wanted)
      } catch (err) {
        deps.log(`[check] ${sessionId.slice(0, 8)} failed: ${(err as Error).message}`)
        return wanted.at ? (err as Error).message : null
      }
    },
  }
}
