import { randomUUID } from 'node:crypto'
import type { DeliveryOutcome } from '../domain/session-delivery.js'
import type { WorkerStatus } from '../domain/session-attention.js'
import {
  isOpenRun, JOB_LIMITS, jobTimeZone, nextDue, onlyScheduled, repeats, retryDelay, runHeader,
  type Job, type JobRun, type ReplyChannel,
} from '../domain/job.js'
import { formatDuration } from '../domain/schedule.js'
import type { WakeOutcome } from '../domain/job-contract.js'
import type { NotificationInput, NotificationKind } from '../notifications.js'
import type { JobStore } from '../job-store.js'

/**
 * Fires the jobs (domain/job.ts). Every tick it settles the runs whose session
 * has answered, turns due schedules into runs, and starts the waiting runs,
 * oldest first, a few per tick and each only while the machine has room: ten
 * jobs due at 8:00 start one after another, not at once.
 *
 * A run is written before anything is started, and is 'starting' while it is:
 * a host restart in that state retries it once. A worker's session id is
 * chosen before its start, so a restart can tell whether it got that far.
 * A target that is busy or a machine without room gets later attempts, up to
 * an hour after the run was due; then the run fails. Failures in a row pause
 * the job and tell whoever made it.
 */

/** What came of trying to start a run. gone: its target no longer exists. */
type Attempt = 'started' | 'retry' | 'failed' | 'gone'

/** Where a run's session stands. */
export type RunSessionState = 'queued' | 'working' | 'idle' | 'stopped'

export interface JobRunnerDeps {
  store: JobStore
  now?: () => number
  /** Room for one more running session (StartWorker.hasRoom; may stop a quiet one to make it). */
  hasRoom(): boolean
  /** queued: not started yet (no ledger entry); working: mid-turn; idle: runs, waiting for input; stopped. */
  sessionState(sessionId: string): RunSessionState
  /** It runs now: a message reaches it without starting anything. */
  sessionRuns(sessionId: string): boolean
  /** The status it gave at or after `since`, with its reason, if any. */
  statusSince(sessionId: string, since: string): { kind: WorkerStatus; reason: string | null } | null
  /** A message for a session; resumes a stopped one (application/deliver-message.ts). */
  deliver(sessionId: string, text: string): Promise<DeliveryOutcome>
  /** Queue a worker under `sessionId` with the text as its first prompt; returns why it could not, or null. */
  startWorker(job: Job, sessionId: string, text: string): string | null
  /** Tell the user (notifications.ts): a run that needs them, a failure, a pause. */
  notify(input: NotificationInput): void
  log(line: string): void
  /** Fallback zone for a job without a schedule. */
  timeZone(): string
}

const STATUS_WORDS: Record<WorkerStatus, string> = {
  done: 'done', review: 'finished, check the result', question: 'has a question for you', failed: 'failed',
}

const TICK_MS = 30_000
// A run's session that has stopped working this long without a status is finished all the same.
const SETTLE_MS = 90_000
// A queued worker that has not started in this time never will (the spawn queue drops it after a day).
const QUEUED_LIMIT_MS = 24 * 60 * 60_000
// How long a channel event's key keeps the same event from waking the job again.
const KEY_MEMORY_MS = 7 * 24 * 60 * 60_000

export class JobRunner {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private readonly now: () => number

  constructor(private deps: JobRunnerDeps) {
    this.now = deps.now ?? Date.now
  }

  start(): void {
    this.recover()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One pass; a pass already under way is joined, not doubled. */
  tick(): Promise<void> {
    if (!this.running) this.running = this.pass().finally(() => { this.running = null })
    return this.running
  }

  /** Runs a restart cut off while starting: one more try each. */
  recover(): void {
    for (const run of this.deps.store.allRuns()) {
      if (run.status !== 'starting') continue
      // The worker got far enough to exist: it has the prompt.
      if (run.sessionId && this.deps.sessionState(run.sessionId) !== 'queued' && this.isWorkerRun(run)) {
        this.update(run, { status: 'started', startedAt: run.startedAt ?? new Date(this.now()).toISOString() })
        continue
      }
      if (run.attempts >= 2) this.failRun(run, 'cut off by a cockpit restart while starting')
      else this.update(run, { status: 'waiting', nextAttemptAt: new Date(this.now()).toISOString(), note: 'retried after a cockpit restart' })
    }
  }

  /** A run started by hand (run_now), due at once. Null when the previous run is still open. */
  runNow(job: Job): JobRun | null {
    if (this.deps.store.runs(job.id).some(isOpenRun)) return null
    const run = this.addRun(job, 'manual', this.now())
    void this.tick()
    return run
  }

  /**
   * A channel event for the job (the bridge's /v1 wake): a run that starts now
   * or not at all. A key seen in the last 7 days is not woken for again.
   */
  async wake(job: Job, channel: ReplyChannel, message: string, key: string): Promise<WakeOutcome> {
    if (job.endedAt) return 'refused'
    if (job.paused) return 'retry'
    const now = this.now()
    if (this.deps.store.seenKey(job.id, key, now - KEY_MEMORY_MS)) return 'delivered'
    const run = this.addRun(job, channel, now, { idempotencyKey: key, message })
    const result = await this.attempt(job, run, true)
    if (result === 'started') {
      this.deps.store.rememberKey(job.id, key, new Date(now).toISOString(), now - KEY_MEMORY_MS)
      return 'delivered'
    }
    if (result === 'gone') return 'refused'
    if (result === 'retry') this.deps.store.dropRun(run)
    return 'retry'
  }

  private isWorkerRun(run: JobRun): boolean {
    const job = this.deps.store.get(run.jobId)
    return !!job && (job.target.type === 'worker' || (job.target.type === 'job-session' && job.target.sessionId === run.sessionId))
  }

  private async pass(): Promise<void> {
    const now = this.now()
    for (const job of this.deps.store.list()) {
      for (const run of this.deps.store.runs(job.id)) if (run.status === 'started') this.settle(job, run, now)
      const fresh = this.deps.store.get(job.id)
      if (fresh && !fresh.paused && !fresh.endedAt) this.schedule(fresh, now)
    }
    let started = 0
    const waiting = this.deps.store.allRuns()
      .filter((run) => run.status === 'waiting' && Date.parse(run.nextAttemptAt ?? run.dueAt) <= now)
      .sort((a, b) => (a.nextAttemptAt ?? a.dueAt).localeCompare(b.nextAttemptAt ?? b.dueAt))
    for (const run of waiting) {
      if (started >= JOB_LIMITS.startsPerTick) break
      const job = this.deps.store.get(run.jobId)
      if (!job) continue
      if (await this.attempt(job, run) === 'started') started += 1
    }
    for (const job of this.deps.store.list()) this.endIfDone(job)
  }

  /** The run's session answered, or stopped working without a word. */
  private settle(job: Job, run: JobRun, now: number): void {
    if (!run.sessionId || !run.startedAt) return
    const said = this.deps.statusSince(run.sessionId, run.startedAt)
    const status = said?.kind ?? null
    const state = this.deps.sessionState(run.sessionId)
    if (!status) {
      if (state === 'queued' && now - Date.parse(run.startedAt) > QUEUED_LIMIT_MS) this.failRun(run, 'the worker never started')
      if (state === 'working' || state === 'queued' || now - Date.parse(run.startedAt) < SETTLE_MS) return
    }
    this.update(run, { status: 'finished', outcome: status, finishedAt: new Date(now).toISOString() })
    const fresh = this.deps.store.get(job.id)
    if (!fresh) return
    const needsYou = status === 'review' || status === 'question' || status === 'failed'
    if (fresh.notify === 'always' || (fresh.notify === 'needs-me' && needsYou)) {
      this.tell(fresh, status ?? 'done', `Run ${run.number}: ${said?.reason ?? (status ? STATUS_WORDS[status] : 'finished without saying how it went')}`, run.sessionId)
    }
    // Its session shows the failure itself; the count may still pause the job.
    if (status === 'failed') this.countFailure(fresh, `run ${run.number} ended as failed`, false)
    else if (fresh.failures) this.deps.store.put({ ...fresh, failures: 0 })
  }

  /** A schedule that is due becomes a run, is skipped, or was missed. */
  private schedule(job: Job, now: number): void {
    if (!job.nextRunAt || Date.parse(job.nextRunAt) > now) return
    const due = Date.parse(job.nextRunAt)
    const late = now - due
    const open = this.deps.store.runs(job.id).some(isOpenRun)
    // The next time first: a run is never made twice for the same due time.
    const advanced: Job = { ...job, nextRunAt: null }
    if (repeats(job) && late > JOB_LIMITS.lateLimitMs) {
      this.putNext(advanced, now)
      this.record(job, due, 'missed', `due ${formatDuration(late)} ago while the cockpit was not running`)
      this.tell(job, 'missed', `Missed a run due ${formatDuration(late)} ago while the cockpit was not running; the next one is on schedule.`)
      this.deps.log(`[jobs] ${job.name}: missed a run due ${new Date(due).toISOString()}`)
      return
    }
    if (open) {
      this.putNext(advanced, now)
      this.record(job, due, 'skipped', 'the previous run was still going')
      return
    }
    const run = this.addRun({ ...job }, 'schedule', due)
    const counted = this.deps.store.get(job.id)
    if (counted) this.putNext({ ...counted, nextRunAt: null }, Math.max(now, due))
    this.deps.log(`[jobs] ${job.name}: run ${run.number} is due`)
  }

  private putNext(job: Job, after: number): void {
    const next = nextDue(job, after)
    this.deps.store.put({ ...job, nextRunAt: next === null ? null : new Date(next).toISOString(), updatedAt: new Date(this.now()).toISOString() })
  }

  private addRun(job: Job, trigger: JobRun['trigger'], due: number, extra: Pick<JobRun, 'idempotencyKey' | 'message'> = {}): JobRun {
    const fresh = this.deps.store.get(job.id) ?? job
    const run: JobRun = {
      id: randomUUID(), jobId: job.id, trigger, number: fresh.runCount + 1,
      dueAt: new Date(due).toISOString(), createdAt: new Date(this.now()).toISOString(),
      status: 'waiting', attempts: 0, nextAttemptAt: null, sessionId: null, startedAt: null, finishedAt: null, outcome: null, note: null,
      ...extra,
    }
    this.deps.store.put({ ...fresh, runCount: fresh.runCount + 1 })
    this.deps.store.addRun(run)
    return run
  }

  /** A run that never ran: missed or skipped, kept in the history. */
  private record(job: Job, due: number, status: 'missed' | 'skipped', note: string): void {
    const at = new Date(this.now()).toISOString()
    this.deps.store.addRun({
      id: randomUUID(), jobId: job.id, trigger: 'schedule', number: 0, dueAt: new Date(due).toISOString(), createdAt: at,
      status, attempts: 0, nextAttemptAt: null, sessionId: null, startedAt: null, finishedAt: at, outcome: null, note,
    })
  }

  /**
   * Try to start one waiting run. `once`: a channel wake, which the bridge
   * retries itself, so a run that cannot start now gets no later attempt here.
   */
  private async attempt(job: Job, run: JobRun, once = false): Promise<Attempt> {
    const now = this.now()
    if (now - Date.parse(run.dueAt) > JOB_LIMITS.retryWindowMs && run.attempts > 0) {
      this.failRun(run, `could not start within ${formatDuration(JOB_LIMITS.retryWindowMs)}: ${run.note ?? 'no room'}`)
      return 'failed'
    }
    const target = job.target
    const existing = target.type === 'session' ? target.sessionId : target.type === 'job-session' ? target.sessionId : null
    const known = existing !== null && this.deps.sessionState(existing) !== 'queued'
    // A fresh session needs the job's prompt; one that has run it before gets only what is new.
    const header = runHeader(job, run, now, jobTimeZone(job, this.deps.timeZone()))
    const text = [header, !known || !run.message ? job.prompt : null, run.message ?? null].filter(Boolean).join('\n\n')
    const wait = (why: string, counted = false): Attempt => {
      if (!once) this.retry(this.current(run), why, counted)
      return 'retry'
    }

    if (target.type === 'session' && !known) {
      this.failRun(run, 'its session no longer exists')
      return 'gone'
    }
    if (!(known && this.deps.sessionRuns(existing)) && !this.deps.hasRoom()) {
      return wait('no room: too little free memory, or the running cap with every session busy')
    }

    if (!known) {
      // A fresh worker: for every run, or the first of a job session.
      const sessionId = randomUUID()
      this.update(run, { status: 'starting', attempts: run.attempts + 1, sessionId })
      // Named before the start: a restart in between finds the session it belongs to (recover).
      if (target.type === 'job-session') this.setJobSession(job.id, sessionId)
      const problem = this.deps.startWorker(job, sessionId, text)
      if (problem) {
        if (target.type === 'job-session') this.setJobSession(job.id, null)
        this.failRun(this.current(run), `the worker could not start: ${problem}`)
        return 'failed'
      }
      this.update(this.current(run), { status: 'started', startedAt: new Date(this.now()).toISOString(), note: null })
      this.deps.log(`[jobs] ${job.name}: run ${run.number} started worker ${sessionId}`)
      return 'started'
    }

    this.update(run, { status: 'starting', attempts: run.attempts + 1, sessionId: existing })
    const outcome = await this.deps.deliver(existing, text)
    const current = this.current(run)
    if (outcome === 'delivered' || outcome === 'resumed') {
      this.update(current, { status: 'started', startedAt: new Date(this.now()).toISOString(), note: null })
      this.deps.log(`[jobs] ${job.name}: run ${run.number} ${outcome} to ${existing}`)
      return 'started'
    }
    if (outcome === 'busy' || outcome === 'running') return wait('its session was busy (running in a terminal, or switching)', true)
    const gone = outcome === 'unknown'
    this.failRun(current, gone ? 'its session no longer exists' : 'its session cannot take messages (it does not run in the chat view)')
    return gone ? 'gone' : 'failed'
  }

  private setJobSession(jobId: string, sessionId: string | null): void {
    const job = this.deps.store.get(jobId)
    if (job?.target.type === 'job-session') this.deps.store.put({ ...job, target: { ...job.target, sessionId } })
  }

  private current(run: JobRun): JobRun {
    return this.deps.store.runs(run.jobId).find((r) => r.id === run.id) ?? run
  }

  private update(run: JobRun, patch: Partial<JobRun>): void {
    this.deps.store.updateRun({ ...this.current(run), ...patch })
  }

  /** `counted`: this attempt is already in run.attempts (it got as far as 'starting'). */
  private retry(run: JobRun, why: string, counted = false): void {
    const attempts = counted ? run.attempts : run.attempts + 1
    this.update(run, { status: 'waiting', attempts, note: why, nextAttemptAt: new Date(this.now() + retryDelay(attempts)).toISOString() })
  }

  private failRun(run: JobRun, why: string): void {
    this.update(run, { status: 'failed', note: why, finishedAt: new Date(this.now()).toISOString() })
    const job = this.deps.store.get(run.jobId)
    this.deps.log(`[jobs] ${job?.name ?? run.jobId}: run ${run.number} failed: ${why}`)
    if (job) this.countFailure(job, `run ${run.number} failed: ${why}`)
  }

  private countFailure(job: Job, why: string, tell = true): void {
    const failures = job.failures + 1
    if (failures >= JOB_LIMITS.failuresToPause && !job.paused) {
      const reason = `${failures} failed runs in a row; last: ${why}`
      this.deps.store.put({ ...job, failures, paused: true, pausedReason: reason, updatedAt: new Date(this.now()).toISOString() })
      // Always told, whatever the job's notify says: it will not run again until someone resumes it.
      this.deps.notify({ kind: 'paused', title: job.name, body: `Paused itself after ${reason}. Resume it in Jobs once fixed.`, jobId: job.id, sessionId: null, spaceId: job.spaceId })
      return
    }
    this.deps.store.put({ ...job, failures })
    if (tell) this.tell(job, 'failed', why[0].toUpperCase() + why.slice(1))
  }

  private tell(job: Job, kind: NotificationKind, body: string, sessionId: string | null = null): void {
    if (job.notify === 'never') return
    this.deps.notify({ kind, title: job.name, body, jobId: job.id, sessionId, spaceId: job.spaceId })
  }

  /** A job with nothing left to wake it ends once its last run is over. */
  private endIfDone(job: Job): void {
    if (job.endedAt || job.nextRunAt || !onlyScheduled(job)) return
    if (this.deps.store.runs(job.id).some(isOpenRun)) return
    this.deps.store.put({ ...job, endedAt: new Date(this.now()).toISOString() })
    this.deps.log(`[jobs] ${job.name}: ended`)
  }
}
