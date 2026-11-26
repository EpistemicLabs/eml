import type { ProviderId } from './agent-provider.js'
import type { ToolProfile } from './tool-profile.js'
import type { ChannelTrigger, JobGrant, JobNotify, ReplyChannel, ReplyMode } from './job.js'

/**
 * The job of jobs.json version 1, before a task held its schedule (brain schema 24): its own name, prompt, target and
 * schedule triggers. Since 24 all of that is read from the task, and the local record (domain/job.ts) keeps only what
 * this machine needs.
 *
 * Only the migration of a version 1 file reads this shape (domain/job-migration.ts, job-store.ts): the type stays for
 * it. Nothing makes, changes or fires such a job any more.
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
   * Set on the check an end_turn call's next.when made: a one-time job like any other for the migration.
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
