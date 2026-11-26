import type { ProviderId } from './agent-provider.js'
import type { ToolProfile } from './tool-profile.js'
import { formatInZone, nextCronTime, parseCron } from './schedule.js'
import { CHECK_RUN_RULE, JOB_HEADER_STATUS } from './turn-end.js'
import type { ChannelTrigger, JobGrant, JobNotify, JobRun, ReplyChannel, ReplyMode } from './job.js'

/**
 * The job of jobs.json version 1, before a task held its schedule (brain schema 24): its own name, prompt, target and
 * schedule triggers. Since 24 all of that is read from the task, and the local record (domain/job.ts) keeps only what
 * this machine needs.
 *
 * Two things still read this shape:
 *   - the migration of a version 1 file (domain/job-migration.ts), which is why the type stays;
 *   - SEAM (parts B2 and B3 of "a task holds its schedule"): the job engine that is not rebuilt yet
 *     (application/job-runner.ts, application/jobs.ts, application/turn-check.ts, jobs-api.ts). It works on a store of
 *     these jobs that the host keeps empty and never writes (index.ts legacyJobStore). Once those parts fire from the
 *     task and the local record, everything below the type goes.
 */


/** routine: on a schedule. errand: ends when its goal is met. standing: never ends on its own. */
export type JobKind = 'routine' | 'errand' | 'standing'

export type JobTarget =
  /** A fresh worker per run, in a project of the job's space. */
  | { type: 'worker'; projectId: string; provider?: ProviderId }
  /** A session that exists: the one that made the job, or another of its space. */
  | { type: 'session'; sessionId: string }
  /**
   * One worker of its own, started on the first run and woken again on the next ones. No longer
   * created: the jobs made with it keep running until they move to a worker and a task.
   */
  | { type: 'job-session'; projectId: string; provider?: ProviderId; sessionId: string | null }

export type ScheduleTrigger = { type: 'schedule'; timeZone: string } & ({ cron: string; at?: undefined } | { at: string; cron?: undefined })
export type JobTriggerV1 = ScheduleTrigger | ChannelTrigger

/** When the job ends on its own: after so many runs, or at a time. */
export interface JobEnd {
  afterRuns?: number
  at?: string
}

export interface JobV1 {
  id: string
  name: string
  kind: JobKind
  /** The brain space it runs in; null = the main space. */
  spaceId: string | null
  /** The session that made it; null when the user did. */
  createdBy: string | null
  /**
   * Set on the check an end_turn call's next.when made (application/turn-check.ts): the session's
   * later calls move or remove it. A job the agent made with the schedule tool has none and is its own.
   */
  origin?: 'end_turn'
  createdAt: string
  updatedAt: string
  /** The brain task it belongs to, if any. */
  taskId: string | null
  /** What the woken session reads. */
  prompt: string
  /** What has to be true for the job to be over, set by the agent; every run is told it. */
  goal?: string | null
  target: JobTarget
  triggers: JobTriggerV1[]
  /** What its sessions may use: copied from its maker when it was made, never wider. */
  toolProfile: ToolProfile | null
  /** Per channel: send freely or draft for review (the bridge enforces it). */
  reply: Partial<Record<ReplyChannel, ReplyMode>>
  end: JobEnd | null
  notify: JobNotify
  paused: boolean
  /** Why it paused itself (failures in a row); null when paused by hand or running. */
  pausedReason: string | null
  /**
   * New channel addresses wait for the user's OK in the Jobs view; until then the job
   * holds still like a paused one. Only the user clears it, never a session.
   */
  pendingApproval?: boolean
  /**
   * Limited (the user's switch): its sessions get no shell, no messages to other sessions, of the
   * space's MCP servers only the brain, and the schedule tool for their own job only
   * (application/limited-job-scope.ts); web tools stay. A job starts free; only the user limits
   * it, never a session.
   */
  limited?: boolean
  /** Tools the user lent a limited job for a while; a grant ends at `until` or when its session reports done. */
  grants?: JobGrant[]
  /** It will not run again. */
  endedAt: string | null
  /** When the schedule is due next; null when it has no further time. */
  nextRunAt: string | null
  /** Runs started or waiting to start, over its whole life. */
  runCount: number
  /** Failed runs in a row. */
  failures: number
}

export const isScheduleTrigger = (trigger: JobTriggerV1): trigger is ScheduleTrigger => trigger.type === 'schedule'

/** It does not run now: paused, or waiting for the user's OK. */
export const isHeld = (job: Pick<JobV1, 'paused' | 'pendingApproval'>): boolean => job.paused || job.pendingApproval === true

/** The first time after `after` (exclusive) a schedule trigger is due; null if none. */
export function nextTriggerTime(trigger: ScheduleTrigger, after: number): number | null {
  if (trigger.at !== undefined) {
    const at = Date.parse(trigger.at)
    return at > after ? at : null
  }
  return nextCronTime(parseCron(trigger.cron), trigger.timeZone, after)
}

/** When the job is due next after `after`: its earliest schedule trigger, within its end. */
export function nextDue(job: Pick<JobV1, 'triggers' | 'end' | 'runCount'>, after: number): number | null {
  if (job.end?.afterRuns !== undefined && job.runCount >= job.end.afterRuns) return null
  let next: number | null = null
  for (const trigger of job.triggers) {
    if (!isScheduleTrigger(trigger)) continue
    const at = nextTriggerTime(trigger, after)
    if (at !== null && (next === null || at < next)) next = at
  }
  if (next !== null && job.end?.at && next > Date.parse(job.end.at)) return null
  return next
}

/** Only schedules: nothing else can wake it once they have no time left. */
export const onlyScheduled = (job: Pick<JobV1, 'triggers'>): boolean => job.triggers.every(isScheduleTrigger)

/** A repeating schedule, not a single date. */
export const repeats = (job: Pick<JobV1, 'triggers'>): boolean => job.triggers.some((t) => isScheduleTrigger(t) && t.cron !== undefined)

/** "every 0 8 * * 1-5 (Asia/Makassar)" or "once, Fri 13 Nov 10:00 (Asia/Makassar)". */
export function describeTrigger(trigger: JobTriggerV1): string {
  if (trigger.type === 'mail') {
    const from = (trigger.match as Array<Record<string, unknown>>).map((m) => String(m.address ?? m.domain ?? '')).filter(Boolean)
    return `on mail from ${from.join(', ')}`
  }
  if (!isScheduleTrigger(trigger)) return `on ${trigger.type}`
  return trigger.cron !== undefined
    ? `cron "${trigger.cron}" (${trigger.timeZone})`
    : `once, ${formatInZone(Date.parse(trigger.at), trigger.timeZone)} (${trigger.timeZone})`
}

/** The zone a job's times read in: its first schedule's. */
export function jobTimeZone(job: Pick<JobV1, 'triggers'>, fallback: string): string {
  return job.triggers.find(isScheduleTrigger)?.timeZone ?? fallback
}

/** The first line a woken session reads: who sends this and what it is. */
export function runHeader(job: JobV1, run: JobRun, now: number, zone: string): string {
  const late = now - Date.parse(run.dueAt)
  const when = run.trigger === 'manual'
    ? 'started by hand'
    : run.trigger !== 'schedule'
      ? `woken by ${run.trigger}`
      : `due ${formatInZone(Date.parse(run.dueAt), zone)} ${zone}${late > 2 * 60_000 ? `, ${Math.round(late / 60_000)} min late` : ''}`
  return `[Scheduled by the cockpit: job "${job.name}" (${job.id.slice(0, 8)}), run ${run.number}, ${when}. `
    + `Not from your user, and nobody may be watching: ${JOB_HEADER_STATUS}. `
    // A check set by ending a turn is moved and removed by ending a turn, not with the schedule tool.
    + (job.origin === 'end_turn' ? CHECK_RUN_RULE : 'The schedule tool changes or stops this job.' + continuation(job) + taskRule(job)) + ']'
}

/**
 * What every run of a job on a task reads (runHeader): while the job has not ended, the task's schedule is on and the
 * task is not closed. The run ends its job first and hands the result over, so no later run lands on a closed task.
 */
export const JOB_TASK_RULE = 'While this job has not ended, never close its task, whatever its checkpoint: once its goal is reached, end the job first (schedule tool, action finish) and hand the result over; the owner closes the task.'

function taskRule(job: JobV1): string {
  return job.taskId ? ` ${JOB_TASK_RULE}` : ''
}

/**
 * How a run goes on with unfinished work. A repeating job goes on at its next run; any other one
 * sets its own next wake-up, since a one-time wake-up would replace a repeating schedule.
 */
function continuation(job: JobV1): string {
  const repeating = job.triggers.some((trigger) => isScheduleTrigger(trigger) && trigger.cron !== undefined)
  const next = 'set your next wake-up with the schedule tool (update with at)'
  if (job.goal) {
    return ` Goal: ${job.goal.replace(/[.\s]+$/, '')}. Report done only once it is reached; until then, `
      + `${repeating ? 'the next scheduled run continues it' : `before you stop, ${next}`}. Once it is reached, end the job with finish.`
  }
  return repeating ? '' : ` If the work is not finished, ${next} before you stop.`
}
