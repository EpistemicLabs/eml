import type { ProviderId } from './agent-provider.js'
import type { WorkerStatus } from './session-attention.js'
import type { ToolProfile } from './tool-profile.js'

/**
 * The local record of a scheduled task, and its runs (jobs.json version 2, job-store.ts).
 *
 * A task holds its schedule in the brain (delegation.schedule, domain/task-schedule.ts): when it runs, what a run is
 * for and whether it is paused are read from the task. What only this machine needs sits here, ONE record per task
 * with the task's id as its id — so a session's ledger entry (jobId), the channel bridge's routes, push tags, grants
 * and the limited-profile lookup name the task. It keeps:
 *
 *   - where the schedule stands on this cockpit: the cursor the repeating times are due after, the wake-up it fired
 *     last, how many runs it started and how many failed in a row;
 *   - the user's per-machine settings: who hears of a run, the limited switch and lent tools, the tool profile, the
 *     reply mode per channel, an end after so many runs, where a new session of the task starts;
 *   - the channel triggers (mail, Slack, WhatsApp) the bridge wakes the task for.
 *
 * A record is made when the host first sees a schedule on a task it fires, and when the schedule tool or the user
 * sets one of those settings. It goes when the task has no schedule this cockpit fires, no channel trigger and no open
 * run (recordKeeping below, which also says what stays: a limit set on it). Each wake is a run (JobRun), kept as the
 * task's history under the record's id; it goes with the record.
 */

/** A channel trigger (the bridge's; not fired by the scheduler). `match` is the bridge's to read. */
export type ChannelTrigger = { type: 'mail' | 'slack' | 'whatsapp'; match: unknown[] }

export type ReplyChannel = 'mail' | 'slack' | 'whatsapp'

/** What the user may lend a limited job for a while. */
export type GrantTool = 'chrome' | 'SendMessage'
export const GRANT_TOOLS: readonly GrantTool[] = ['chrome', 'SendMessage']

export interface JobGrant {
  tool: GrantTool
  until: string
  reason: string | null
}

/** The grants still running at `now`. */
export const activeGrants = (job: { grants?: JobGrant[] }, now: number): JobGrant[] =>
  (job.grants ?? []).filter((grant) => Date.parse(grant.until) > now)
export type ReplyMode = 'send' | 'draft'

/** Who hears of a run: only when someone is needed (review, question, failed), always, or never. */
export type JobNotify = 'needs-me' | 'always' | 'never'

export interface Job {
  /** The task's id: one record per task. */
  id: string
  /** The brain space it runs in; null = the main space. */
  spaceId: string | null
  /** The brain task it belongs to: the same as `id`. */
  taskId: string
  /** The session that set it up; null when the user or the cockpit did. */
  createdBy: string | null
  createdAt: string
  updatedAt: string
  /** The channels that wake the task besides its schedule. */
  triggers: ChannelTrigger[]
  /** The project a new session of the task starts in; null: the task's own (its scope's project). */
  projectId: string | null
  /** The provider a new session of the task starts with; absent: the project's default. */
  provider?: ProviderId
  /** What its sessions may use: copied from its maker when it was made, never wider. */
  toolProfile: ToolProfile | null
  /** Per channel: send freely or draft for review (the bridge enforces it). */
  reply: Partial<Record<ReplyChannel, ReplyMode>>
  /** It ends on its own after so many runs, counted here (max_runs). A time to end at is the schedule's ends_at. */
  end: { afterRuns: number } | null
  notify: JobNotify
  /** Why the cockpit paused the task's schedule (failures in a row); null when it did not. The pause itself is on the task. */
  pausedReason: string | null
  /**
   * New channel addresses wait for the user's OK; until then the channel does not wake the task. Only the user clears
   * it, never a session.
   */
  pendingApproval?: boolean
  /**
   * Limited (the user's switch): its sessions get no shell, no messages to other sessions, of the space's MCP servers
   * only the brain, and the schedule tool for their own task only (application/limited-job-scope.ts); web tools stay.
   * A record starts free; only the user limits it, never a session.
   */
  limited?: boolean
  /** Tools the user lent a limited job for a while; a grant ends at `until` or when its session reports done. */
  grants?: JobGrant[]
  /** Repeating times are due after it (ISO); set to "now" when the schedule is first seen, so past times never fire. Null: not seen yet. */
  cursor: string | null
  /** The wake-up (`at`) fired last: it fires once, also when the brain write that clears it failed. */
  firedWake: string | null
  /** When its last run started; null before the first. */
  lastRunAt: string | null
  /** Runs started or waiting to start, over its whole life. */
  runCount: number
  /** Failed runs in a row. */
  failures: number
}

/** A new record for a task, with nothing set: every setting at its default, the schedule not seen yet. */
export function newRecord(task: { id: string; spaceId: string | null }, at: string, by: string | null = null): Job {
  return {
    id: task.id, spaceId: task.spaceId, taskId: task.id, createdBy: by, createdAt: at, updatedAt: at,
    triggers: [], projectId: null, toolProfile: null, reply: {}, end: null, notify: 'needs-me', pausedReason: null,
    cursor: null, firedWake: null, lastRunAt: null, runCount: 0, failures: 0,
  }
}

export type RunStatus =
  /** Due; starts when there is room (or at nextAttemptAt, after a busy target). */
  | 'waiting'
  /** Being started or delivered; a host restart in this state retries once. */
  | 'starting'
  /** The session has it. */
  | 'started'
  /** Its session ended its turn; `outcome` says how. */
  | 'finished'
  | 'failed'
  /** Due while the cockpit was down, too long ago to still run. */
  | 'missed'
  /** Due while a session of the task was working, or while its previous run had not started; or its task closed before it started. */
  | 'skipped'

export interface JobRun {
  id: string
  /** The record's id: the task's (a run from before schema 24 that ended with its job keeps that job's id). */
  jobId: string
  /** What fired it. */
  trigger: 'schedule' | 'manual' | ReplyChannel
  /** Its run number in the job (1 = the first). */
  number: number
  dueAt: string
  createdAt: string
  status: RunStatus
  attempts: number
  nextAttemptAt: string | null
  /** The session it woke or started. */
  sessionId: string | null
  startedAt: string | null
  finishedAt: string | null
  /** How the session said it stood at the end; null when it said nothing. */
  outcome: WorkerStatus | null
  /** Why it failed, was skipped or missed, or waits. */
  note: string | null
  /** Its session was started for this run (a new one); absent or false: a session that existed got it as a message. */
  newSession?: boolean
  /** A channel event's key; the same key never wakes the job twice. */
  idempotencyKey?: string
  /** What a channel event says (counts, never content); the woken session reads it after the header. */
  message?: string
  /** For a run the schedule fired: the times that came due, so the run's text names them whenever it starts. */
  fired?: RunFired
}

/** What of a task's schedule one firing names (domain/task-schedule.ts dueOf): the wake-up and every repeating time due. */
export interface RunFired {
  wake?: { at: string; why: string | null; bySession: string | null }
  crons?: Array<{ cron: string; dueAt: string }>
  /** The zone the schedule's times are read in; absent when it names none. */
  timeZone?: string
}

/** Limits on what sessions may schedule. */
export const JOB_LIMITS = {
  /** Open tasks with a schedule per space. */
  perSpace: 100,
  /** A repeating schedule fires at most this often. */
  minGapMs: 15 * 60_000,
  /** A one-time run at most this far ahead. */
  maxAheadMs: 366 * 24 * 60 * 60_000,
  /** A repeating run due longer ago than this (the cockpit was down) is missed instead of run late. */
  lateLimitMs: 6 * 60 * 60_000,
  /** A run that cannot start for this long after it was due fails. */
  retryWindowMs: 60 * 60_000,
  /** Failed runs in a row before the job pauses itself. */
  failuresToPause: 3,
  /** Runs the runner starts in one tick, each only with room for it. */
  startsPerTick: 2,
  /** Runs kept per job. */
  history: 100,
  nameChars: 60,
  goalChars: 500,
} as const

// Waits between attempts to start a run whose target was busy or the machine full.
const RETRY_STEPS_MS = [1, 2, 5, 10, 20, 30].map((m) => m * 60_000)

export function retryDelay(attempts: number): number {
  return RETRY_STEPS_MS[Math.min(Math.max(attempts - 1, 0), RETRY_STEPS_MS.length - 1)]
}

/**
 * This cockpit holds it back: it waits for the user's OK, or the cockpit paused it after failures. A pause the user
 * set is on the task's schedule (delegation.schedule.paused), not here.
 */
export const isHeld = (job: Pick<Job, 'pendingApproval' | 'pausedReason'>): boolean => job.pendingApproval === true || job.pausedReason !== null

/** The mail addresses and domains a job listens on, as "address:x" / "domain:y". */
export function mailKeys(job: { triggers: ReadonlyArray<{ type: string; match?: unknown[] }> }): Set<string> {
  const keys = new Set<string>()
  for (const trigger of job.triggers) {
    if (trigger.type !== 'mail') continue
    for (const item of (trigger.match ?? []) as Array<Record<string, unknown>>) {
      if (item?.kind === 'address' && typeof item.address === 'string') keys.add(`address:${item.address.toLowerCase()}`)
      if (item?.kind === 'domain' && typeof item.domain === 'string') keys.add(`domain:${item.domain.toLowerCase()}`)
    }
  }
  return keys
}

/** Where a record's task stands for this cockpit: it fires its schedule, it is open without one it fires, or it is closed (or gone). */
export type TaskStanding = 'fires' | 'open' | 'closed'

/**
 * What a pass does with a task's record (application/job-runner.ts).
 *
 *   - `stopListening`: the task is closed, so nothing wakes it any more: its channel triggers, lent tools and a
 *     pending approval go, and a run that waits to start is skipped (application/end-task-record.ts).
 *   - `remove`: the record goes. For an open task that is when it has no schedule this cockpit fires, no channel
 *     trigger and no open run, and holds no limit the user or its maker set: a limited record and one with a tool
 *     profile stay while the task is open, so a schedule set later starts no session with more than was allowed.
 *     For a closed task it goes once no run of it is open (a waiting one is skipped first).
 */
export function recordKeeping(
  record: Pick<Job, 'triggers' | 'grants' | 'pendingApproval' | 'limited' | 'toolProfile'>, standing: TaskStanding, runs: readonly JobRun[],
): { stopListening: boolean; remove: boolean } {
  if (standing === 'fires') return { stopListening: false, remove: false }
  if (standing === 'closed') {
    const listens = record.triggers.length > 0 || (record.grants?.length ?? 0) > 0 || record.pendingApproval === true
    // A waiting run is skipped with the listening; one a session has goes on and keeps the record until it ends.
    return { stopListening: listens || runs.some((run) => run.status === 'waiting'), remove: !runs.some((run) => run.status === 'starting' || run.status === 'started') }
  }
  const limits = record.limited === true || record.toolProfile !== null
  return { stopListening: false, remove: record.triggers.length === 0 && !limits && !runs.some(isOpenRun) }
}

/** A run that has not come to an end: the next one waits for it. */
export const isOpenRun = (run: JobRun): boolean => run.status === 'waiting' || run.status === 'starting' || run.status === 'started'

/** The note of a run that was due when its schedule was ended and so never started. */
export const ENDED_BEFORE_START = 'its job was ended before it started'
/** The note of a run that was due when its task was closed some other way and so never started. */
export const CLOSED_BEFORE_START = 'its task was closed before it started'
/** The note of a time that came due while a session of the task was in a turn (the four-line order, line a). */
export const SKIPPED_WORKING = 'a session of the task was working'
/** The note of a time that came due while the task's previous run still waited to start. */
export const SKIPPED_NOT_STARTED = 'the previous run had not started yet'
