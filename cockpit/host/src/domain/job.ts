import type { ProviderId } from './agent-provider.js'
import type { WorkerStatus } from './session-attention.js'
import type { ToolProfile } from './tool-profile.js'
import { formatInZone, nextCronTime, parseCron } from './schedule.js'

/**
 * A job: work the cockpit wakes a session for, without anyone asking at that
 * moment. Its triggers say when — a schedule now; later a mail, a Slack
 * conversation or WhatsApp numbers (the channel bridge, job-contract.ts) — and
 * its target says whom: a fresh worker per run, a session that exists, or one
 * session of its own kept across runs. Each wake is a run (JobRun), kept as
 * the job's history. The runner (application/job-runner.ts) fires them; the
 * definitions and runs live in the host (job-store.ts), not in the brain: the
 * runner works without a brain server, and a job links its brain task by id.
 */

/** routine: on a schedule. errand: ends when its goal is met. standing: never ends on its own. */
export type JobKind = 'routine' | 'errand' | 'standing'

export type JobTarget =
  /** A fresh worker per run, in a project of the job's space. */
  | { type: 'worker'; projectId: string; provider?: ProviderId }
  /** A session that exists: the one that made the job, or another of its space. */
  | { type: 'session'; sessionId: string }
  /** One worker of its own, started on the first run and woken again on the next ones. */
  | { type: 'job-session'; projectId: string; provider?: ProviderId; sessionId: string | null }

export type ScheduleTrigger = { type: 'schedule'; timeZone: string } & ({ cron: string; at?: undefined } | { at: string; cron?: undefined })
/** A channel trigger (the bridge's; not fired by the scheduler). `match` is the bridge's to read. */
export type ChannelTrigger = { type: 'mail' | 'slack' | 'whatsapp'; match: unknown[] }
export type JobTrigger = ScheduleTrigger | ChannelTrigger

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
export const activeGrants = (job: Pick<Job, 'grants'>, now: number): JobGrant[] =>
  (job.grants ?? []).filter((grant) => Date.parse(grant.until) > now)
export type ReplyMode = 'send' | 'draft'

/** When the job ends on its own: after so many runs, or at a time. */
export interface JobEnd {
  afterRuns?: number
  at?: string
}

/** Who hears of a run: only when someone is needed (review, question, failed), always, or never. */
export type JobNotify = 'needs-me' | 'always' | 'never'

export interface Job {
  id: string
  name: string
  kind: JobKind
  /** The brain space it runs in; null = the main space. */
  spaceId: string | null
  /** The session that made it; null when the user did. */
  createdBy: string | null
  createdAt: string
  updatedAt: string
  /** The brain task it belongs to, if any. */
  taskId: string | null
  /** What the woken session reads. */
  prompt: string
  target: JobTarget
  triggers: JobTrigger[]
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
   * Limited (the user's switch): its sessions get no shell, no messages to other sessions, no
   * schedule tool and of the space's MCP servers only the brain; web tools stay. Set for a job
   * with a channel trigger when it is made; only the user changes it, never a session.
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
  /** Due while the previous run still worked. */
  | 'skipped'

export interface JobRun {
  id: string
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
  /** A channel event's key; the same key never wakes the job twice. */
  idempotencyKey?: string
  /** What a channel event says (counts, never content); the woken session reads it after the header. */
  message?: string
}

/** Limits on what sessions may schedule. */
export const JOB_LIMITS = {
  /** Jobs per space that have not ended. */
  perSpace: 25,
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
  promptChars: 20_000,
  nameChars: 60,
} as const

// Waits between attempts to start a run whose target was busy or the machine full.
const RETRY_STEPS_MS = [1, 2, 5, 10, 20, 30].map((m) => m * 60_000)

export function retryDelay(attempts: number): number {
  return RETRY_STEPS_MS[Math.min(Math.max(attempts - 1, 0), RETRY_STEPS_MS.length - 1)]
}

export const isScheduleTrigger = (trigger: JobTrigger): trigger is ScheduleTrigger => trigger.type === 'schedule'

/** It does not run now: paused, or waiting for the user's OK. */
export const isHeld = (job: Pick<Job, 'paused' | 'pendingApproval'>): boolean => job.paused || job.pendingApproval === true

/** The mail addresses and domains a job listens on, as "address:x" / "domain:y". */
export function mailKeys(job: Pick<Job, 'triggers'>): Set<string> {
  const keys = new Set<string>()
  for (const trigger of job.triggers) {
    if (trigger.type !== 'mail') continue
    for (const item of trigger.match as Array<Record<string, unknown>>) {
      if (item?.kind === 'address' && typeof item.address === 'string') keys.add(`address:${item.address.toLowerCase()}`)
      if (item?.kind === 'domain' && typeof item.domain === 'string') keys.add(`domain:${item.domain.toLowerCase()}`)
    }
  }
  return keys
}

/** A run that has not come to an end: the next one waits for it. */
export const isOpenRun = (run: JobRun): boolean => run.status === 'waiting' || run.status === 'starting' || run.status === 'started'

/** The first time after `after` (exclusive) a schedule trigger is due; null if none. */
export function nextTriggerTime(trigger: ScheduleTrigger, after: number): number | null {
  if (trigger.at !== undefined) {
    const at = Date.parse(trigger.at)
    return at > after ? at : null
  }
  return nextCronTime(parseCron(trigger.cron), trigger.timeZone, after)
}

/** When the job is due next after `after`: its earliest schedule trigger, within its end. */
export function nextDue(job: Pick<Job, 'triggers' | 'end' | 'runCount'>, after: number): number | null {
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
export const onlyScheduled = (job: Pick<Job, 'triggers'>): boolean => job.triggers.every(isScheduleTrigger)

/** A repeating schedule, not a single date. */
export const repeats = (job: Pick<Job, 'triggers'>): boolean => job.triggers.some((t) => isScheduleTrigger(t) && t.cron !== undefined)

/** "every 0 8 * * 1-5 (Asia/Makassar)" or "once, Fri 13 Nov 10:00 (Asia/Makassar)". */
export function describeTrigger(trigger: JobTrigger): string {
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
export function jobTimeZone(job: Pick<Job, 'triggers'>, fallback: string): string {
  return job.triggers.find(isScheduleTrigger)?.timeZone ?? fallback
}

/** The first line a woken session reads: who sends this and what it is. */
export function runHeader(job: Job, run: JobRun, now: number, zone: string): string {
  const late = now - Date.parse(run.dueAt)
  const when = run.trigger === 'manual'
    ? 'started by hand'
    : run.trigger !== 'schedule'
      ? `woken by ${run.trigger}`
      : `due ${formatInZone(Date.parse(run.dueAt), zone)} ${zone}${late > 2 * 60_000 ? `, ${Math.round(late / 60_000)} min late` : ''}`
  return `[Scheduled by the cockpit: job "${job.name}" (${job.id.slice(0, 8)}), run ${run.number}, ${when}. `
    + 'Not from your user, and nobody may be watching: report how you stand with session_status if you have it. '
    + 'The schedule tool changes or stops this job.]'
}
