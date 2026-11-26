import { randomUUID } from 'node:crypto'
import type { DeliveryOutcome } from '../domain/session-delivery.js'
import type { WorkerStatus } from '../domain/session-attention.js'
import {
  activeGrants, CLOSED_BEFORE_START, isHeld, isOpenRun, JOB_LIMITS, newRecord, recordKeeping, retryDelay, SKIPPED_NOT_STARTED, SKIPPED_WORKING,
  type GrantTool, type Job, type JobRun, type ReplyChannel, type RunFired,
} from '../domain/job.js'
import { delegationOf, type DelegationFields } from '../domain/delegation.js'
import { decideFiring, type Fired, type FiringFacts } from '../domain/firing-order.js'
import { firedText, startedBy } from '../domain/run-text.js'
import { formatDuration } from '../domain/schedule.js'
import { runsHere } from '../domain/task-owner.js'
import { clearWake, dueOf, hasSchedule, sameInstant, scheduleIsOff, scheduleOf, setCrons, setPaused } from '../domain/task-schedule.js'
import { waitKind } from '../domain/task-turn.js'
import { waitsOf } from '../domain/task-waits.js'
import type { WakeOutcome } from '../domain/job-contract.js'
import type { NotificationInput, NotificationKind } from '../notifications.js'
import type { JobStore } from '../job-store.js'
import { endTaskRecord } from './end-task-record.js'
import type { ScheduleEdit } from './task-schedule-write.js'
import { stepPrompt } from './task-runner.js'

/**
 * Fires the tasks' schedules (decision task-schedules-live-in-the-brain). A task holds its schedule in the brain
 * (domain/task-schedule.ts); this cockpit fires the schedules of the tasks its member owns (domain/task-owner.ts
 * runsHere, the task runner's rule) and keeps one local record per task (domain/job.ts) with what only it needs:
 * the cursor the repeating times are due after, the wake-up it fired last, the runs.
 *
 * Every tick it settles the runs whose session has answered and starts the waiting runs, oldest first, a few per
 * tick and each only while the machine has room: ten tasks due at 8:00 start one after another, not at once. Once a
 * minute it also derives what is due: it reads each space's open tasks (two lists per space, no read per task), and
 * for every task with a schedule it fires works out what is due against the task's record (dueOf). Several times due
 * at once are ONE firing that names all of them; a repeating time due longer ago than the late limit is recorded as
 * missed; the cursor moves before anything starts, so no time fires twice. A wake-up has fired once a run that carries
 * it got to a session: then it is remembered on the record and cleared on the task. The same read keeps the records: one is made when a schedule is first seen
 * (its cursor is now, so no time of the past fires), and one goes by domain/job.ts recordKeeping; a closed task's
 * record stops listening first.
 *
 * What a firing does follows the four-line order (domain/firing-order.ts): a repeating time is skipped and recorded
 * while a session of the task works, else it goes to the session that waits on an answer, else to the session that set
 * the wake-up, else to a new session. The wake-up is never skipped: while a session works it stays due and fires in
 * the first read where the order can give it to a session; while a run of the task waits to start it joins that run.
 * A repeating time that comes due while the task's previous run has not started is skipped and recorded. A new session reads the prompt built from its task and a line naming what fired; a session that continues
 * reads that line alone (domain/run-text.ts).
 *
 * A run is written before anything is started, and is 'starting' while it is: a host restart in that state retries
 * it once. A new session's id is chosen before its start, so a restart can tell whether it got that far. A session
 * that is busy or a machine without room gets later attempts, up to an hour after the run was due; then the run
 * fails. Failures in a row pause the task's schedule (on the task, with the reason on the record) and tell the user.
 */

/** What came of trying to start a run. gone: its task is closed or gone. skipped: a session of the task was working. */
type Attempt = 'started' | 'retry' | 'failed' | 'gone' | 'skipped'

/** Where a run's session stands. */
export type RunSessionState = 'queued' | 'working' | 'idle' | 'stopped'

/** A space as the runner needs it. `key` is what its records carry as spaceId: null for the main space. */
export interface RunnerSpace {
  key: string | null
  name: string
  /** A shared brain: each member's cockpit fires only its member's tasks. null (not confirmed yet) counts as shared. */
  shared: boolean | null
}

/** A task as the runner reads it from the brain. */
export interface RunnerTask {
  id: string
  title?: string | null
  content?: string
  status: string
  scope?: string
  ingested_by?: string | null
  properties?: {
    assignee_ids?: string[]
    delegation?: DelegationFields | null
    delegate?: string
    checkpoint?: string
    display_title?: string
    waits?: unknown
    waiting_on?: unknown
  } | null
}

export interface JobRunnerDeps {
  store: JobStore
  now?: () => number
  /** This cockpit's member (the config handle): it fires the schedules of the tasks this member owns. */
  me: string
  spaces(): RunnerSpace[]
  /**
   * The space's open tasks (planned and active) as its brain lists them, with their properties. Null: its brain
   * cannot be asked now, so the space is left alone this time.
   */
  openTasks(space: RunnerSpace): Promise<RunnerTask[] | null>
  /**
   * The task still has version 1 jobs that have not moved onto it. The migration (application/job-migration.ts)
   * builds its schedule from them and replaces what the task holds, so until they have moved nothing is derived for
   * it and its record is left alone. Only that task waits: a job that never moves (it has no task) holds nothing up.
   */
  waitsForMigration?(taskId: string): boolean
  /** One task as the brain has it now; null when it has none. Throws when the brain cannot be asked. */
  task(space: RunnerSpace, taskId: string): Promise<RunnerTask | null>
  /** A session this cockpit does not have works on the task right now (another member's run, domain/runs.ts). */
  workingElsewhere?(space: RunnerSpace, taskId: string): Promise<boolean>
  /**
   * This cockpit's sessions on the task that are not put away, newest first, each with whether it is in a turn and
   * whether it is linked to the task's record (its ledger entry names the record as its job: it was started for it,
   * so it is launched with the channel bridge's tools). A channel message only goes to a linked session.
   */
  sessionsOf(taskId: string): Array<{ sessionId: string; working: boolean; linked?: boolean }>
  /** Write an edit of the task's schedule to the brain, with a journal line (application/task-schedule-write.ts). */
  editSchedule(space: RunnerSpace, taskId: string, edit: ScheduleEdit, text?: string): Promise<void>
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
  /**
   * Queue a new session of the task under `sessionId` with the text as its first prompt, in the record's project (the
   * task's own when it names none) and with the record's limits; returns why it could not, or null.
   */
  startWorker(record: Job, task: RunnerTask, sessionId: string, text: string): string | null
  /**
   * The project a new session of the task would start in (the record's, else the task's own); null: it has none, so
   * no session can start. Run now asks before it answers. Without it nothing is known beforehand.
   */
  projectOf?(record: Job, task: RunnerTask): string | null
  /** Lent tools went back (their time is up, or the session reported done): the host takes them from the session. */
  onGrantEnd?(record: Job, tools: GrantTool[]): void
  /** Tell the user (notifications.ts): a run that needs them, a failure, a pause. */
  notify(input: NotificationInput): void
  /**
   * Show it in the cockpit's review section: the task could not run, or its schedule paused itself. No session says
   * so itself, so one stands in (the task's newest run session, else whoever set the record up) as "Needs you".
   */
  flag(record: Job, text: string): void
  log(line: string): void
  /** The zone a time is told in when the schedule names none: the user's. */
  timeZone(): string
  /** How often the tasks are read to derive what is due; every tick settles and starts runs. Default: about once a minute. */
  deriveEveryMs?: number
}

const STATUS_WORDS: Record<WorkerStatus, string> = {
  done: 'done', review: 'finished, check the result', question: 'has a question for you', failed: 'failed',
}

const TICK_MS = 30_000
// A little under a minute: the tick that falls on the minute must not miss it by a few milliseconds.
const DERIVE_MS = 55_000
// A run's session that has stopped working this long without a status is finished all the same.
const SETTLE_MS = 90_000
// A queued worker that has not started in this time never will (the spawn queue drops it after a day).
const QUEUED_LIMIT_MS = 24 * 60 * 60_000
// How long a channel event's key keeps the same event from waking the task again.
const KEY_MEMORY_MS = 7 * 24 * 60 * 60_000
const NO_ROOM = 'no room: too little free memory, or the running cap with every session busy'
const OPEN = new Set(['planned', 'active'])
/** The journal line when a task's repeating times end after the runs they were set to have (max_runs). */
const RUNS_USED_UP = 'Its repeating times ended after the runs they were set to have.'

/** The run counts toward an end after so many runs (the record's `end`): a repeating time fired it. */
const countsToEnd = (run: Pick<JobRun, 'trigger' | 'fired'>): boolean => run.trigger === 'schedule' && (run.fired?.crons?.length ?? 0) > 0

const nameOfTask = (task: RunnerTask): string => task.properties?.display_title ?? task.title ?? task.id

/** What the user may be told when a run by hand cannot start. */
export type RunNowRefusal = 'run_open' | 'task_working' | 'needs_approval' | 'no_project'

export class JobRunner {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private readonly now: () => number
  /** When the tasks were last read; null: not yet. */
  private derivedAt: number | null = null
  /** What the last read said of the tasks that have a record: their name, and whether their schedule is paused. */
  private facts = new Map<string, { name: string; paused: boolean }>()
  /** Brain writes under way that the next pass waits for (a pause after failures). */
  private writes: Array<Promise<void>> = []

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

  /** The task's name as the last read had it; "task <id>" before the first. */
  nameOf(taskId: string): string {
    return this.facts.get(taskId)?.name ?? `task ${taskId.slice(0, 8)}`
  }

  /**
   * The record holds still for the channel bridge: it waits for the user's OK, the cockpit paused it after failures,
   * or the task's schedule is paused (as the last read had it). Its route says so and its wakes answer retry.
   */
  held(record: Job): boolean {
    return isHeld(record) || this.facts.get(record.id)?.paused === true
  }

  /** Runs a restart cut off while starting: one more try each. */
  recover(): void {
    for (const run of this.deps.store.allRuns()) {
      if (run.status !== 'starting') continue
      // Its new session got far enough to exist: it has the prompt.
      if (run.sessionId && run.newSession && this.deps.sessionState(run.sessionId) !== 'queued') {
        this.wakeFired(run)
        this.update(run, { status: 'started', startedAt: run.startedAt ?? new Date(this.now()).toISOString() })
        continue
      }
      if (run.attempts >= 2) this.failRun(run, 'cut off by a cockpit restart while starting')
      else this.update(run, { status: 'waiting', sessionId: null, nextAttemptAt: new Date(this.now()).toISOString(), note: 'retried after a cockpit restart' })
    }
  }

  /**
   * A run the owner started by hand (Run now), due at once. It follows the four-line order like a time: refused
   * while a session of the task works, and while the task's previous run is open. A paused schedule does not hold it.
   * A run that would need a new session on a task without a project is refused here, not started to fail.
   */
  async runNow(space: RunnerSpace, task: RunnerTask): Promise<JobRun | RunNowRefusal> {
    const now = this.now()
    const record = this.deps.store.get(task.id) ?? newRecord({ id: task.id, spaceId: space.key }, new Date(now).toISOString())
    if (record.pendingApproval) return 'needs_approval'
    if (this.deps.store.runs(task.id).some(isOpenRun)) return 'run_open'
    const facts = await this.factsOf(space, task, { times: true, wake: null, message: false }, new Set())
    const decision = decideFiring(facts)
    if (decision.kind === 'skip') return 'task_working'
    if (decision.kind === 'start' && this.deps.projectOf && this.deps.projectOf(record, task) === null) return 'no_project'
    if (!this.deps.store.get(task.id)) this.deps.store.put(record)
    this.facts.set(task.id, { name: nameOfTask(task), paused: scheduleOf(task)?.paused === true })
    const run = this.addRun(task.id, 'manual', now)
    void this.tick()
    return run
  }

  /**
   * The owner resumed the task's schedule: it goes on from now (what fell due during the pause is not made up), a
   * pause the cockpit set after failures is over, and its count starts anew.
   */
  resumed(taskId: string): void {
    const record = this.deps.store.get(taskId)
    this.facts.set(taskId, { name: this.nameOf(taskId), paused: false })
    if (record && (record.pausedReason !== null || record.failures > 0 || record.cursor !== null)) {
      this.deps.store.put({ ...record, pausedReason: null, failures: 0, cursor: null, updatedAt: new Date(this.now()).toISOString() })
    }
  }

  /** The owner paused the task's schedule: the bridge's wakes answer retry from now, before the next read says so. */
  paused(taskId: string): void {
    this.facts.set(taskId, { name: this.nameOf(taskId), paused: true })
  }

  /**
   * A channel message for the task (the bridge's /v1 wake). It is never skipped: it goes to a session by the
   * four-line order now, or the bridge is told to try again. Only a session linked to the record gets it, an
   * existing one or the one started for it: `delivered` is answered for nothing else. refused: the task is closed or gone. A key seen in the
   * last 7 days is not woken for again.
   */
  async wake(record: Job, channel: ReplyChannel, message: string, key: string): Promise<WakeOutcome> {
    const space = this.spaceOf(record)
    if (!space) return 'refused'
    let task: RunnerTask | null
    try {
      task = await this.deps.task(space, record.taskId)
    } catch {
      return 'retry'
    }
    if (!task || !OPEN.has(task.status)) return 'refused'
    const paused = scheduleOf(task)?.paused === true
    this.facts.set(task.id, { name: nameOfTask(task), paused })
    if (isHeld(record) || paused) return 'retry'
    const now = this.now()
    if (this.deps.store.seenKey(record.id, key, now - KEY_MEMORY_MS)) return 'delivered'
    const run = this.addRun(record.id, channel, now, { idempotencyKey: key, message })
    const result = await this.attempt(this.deps.store.get(record.id) ?? record, run, true, task)
    await this.flush()
    if (result === 'started') {
      this.deps.store.rememberKey(record.id, key, new Date(now).toISOString(), now - KEY_MEMORY_MS)
      return 'delivered'
    }
    if (result === 'gone') return 'refused'
    if (result === 'retry') this.drop(run)
    return 'retry'
  }

  private spaceOf(record: Pick<Job, 'spaceId'>): RunnerSpace | null {
    return this.deps.spaces().find((space) => space.key === (record.spaceId ?? null)) ?? null
  }

  private async flush(): Promise<void> {
    while (this.writes.length > 0) await Promise.all(this.writes.splice(0))
  }

  private async pass(): Promise<void> {
    const now = this.now()
    for (const record of this.deps.store.list()) {
      for (const run of this.deps.store.runs(record.id)) if (run.status === 'started') this.settle(record, run, now)
      const fresh = this.deps.store.get(record.id)
      // Expired grants leave the record; the session gets no tool from them anyway (activeGrants).
      if (fresh?.grants?.some((g) => Date.parse(g.until) <= now)) {
        const ended = fresh.grants.filter((g) => Date.parse(g.until) <= now).map((g) => g.tool)
        const kept = { ...fresh, grants: activeGrants(fresh, now) }
        this.deps.store.put(kept)
        this.deps.onGrantEnd?.(kept, ended)
      }
    }
    // A pause after failures is on the task before the tasks are read.
    await this.flush()
    if (this.derivedAt === null || now - this.derivedAt >= (this.deps.deriveEveryMs ?? DERIVE_MS)) {
      this.derivedAt = now
      for (const space of this.deps.spaces()) {
        try {
          await this.deriveSpace(space, now)
        } catch (err) {
          this.deps.log(`[jobs] ${space.name}: its schedules were not read: ${(err as Error).message}`)
        }
      }
    }
    let started = 0
    const waiting = this.deps.store.allRuns()
      .filter((run) => run.status === 'waiting' && Date.parse(run.nextAttemptAt ?? run.dueAt) <= now)
      .sort((a, b) => (a.nextAttemptAt ?? a.dueAt).localeCompare(b.nextAttemptAt ?? b.dueAt))
    for (const run of waiting) {
      if (started >= JOB_LIMITS.startsPerTick) break
      const record = this.deps.store.get(run.jobId)
      if (!record) continue
      if (await this.attempt(record, run) === 'started') started += 1
    }
    await this.flush()
  }

  /**
   * One space: what is due on the tasks this member fires, and the space's records kept in step with their tasks.
   * A space whose tasks cannot be read is left as it is: nothing fires and no record is touched.
   */
  private async deriveSpace(space: RunnerSpace, now: number): Promise<void> {
    const tasks = await this.deps.openTasks(space)
    if (!tasks) return
    const open = new Map(tasks.map((task) => [task.id, task]))
    const fires = (task: RunnerTask) => hasSchedule(task) && runsHere(space.shared, task, this.deps.me)
    const waits = (taskId: string) => this.deps.waitsForMigration?.(taskId) === true
    const fired = new Set<string>()
    // One task that cannot be derived (a brain write that fails) does not hold up the others.
    const derive = async (task: RunnerTask) => {
      try {
        await this.deriveTask(space, task, now)
      } catch (err) {
        this.deps.log(`[jobs] ${nameOfTask(task)}: its schedule was not derived: ${(err as Error).message}`)
      }
    }
    for (const task of tasks) {
      if (!fires(task) || waits(task.id)) continue
      fired.add(task.id)
      await derive(task)
    }
    for (const record of this.deps.store.list()) {
      if ((record.spaceId ?? null) !== space.key || fired.has(record.id) || waits(record.id)) continue
      let task = open.get(record.id) ?? null
      // Not among the open tasks: closed, gone, or the list did not reach it. The task itself says which.
      if (!task) task = await this.deps.task(space, record.taskId)
      const isOpen = task !== null && OPEN.has(task.status)
      if (task && isOpen && fires(task)) {
        await derive(task)
        continue
      }
      if (task) this.facts.set(record.id, { name: nameOfTask(task), paused: false })
      this.keep(record, isOpen ? 'open' : 'closed', now)
    }
  }

  /** A record whose task has no schedule this cockpit fires: it stops listening when the task is closed, and goes when nothing holds it. */
  private keep(record: Job, standing: 'open' | 'closed', now: number): void {
    const { store } = this.deps
    if (recordKeeping(record, standing, store.runs(record.id)).stopListening) {
      endTaskRecord(store, record.id, now, this.deps.onGrantEnd, CLOSED_BEFORE_START)
      this.deps.log(`[jobs] ${this.nameOf(record.id)}: its task is closed, so nothing wakes it any more`)
    }
    const current = store.get(record.id)
    if (!current) return
    if (recordKeeping(current, standing, store.runs(record.id)).remove) {
      store.remove(record.id)
      this.facts.delete(record.id)
      this.deps.log(`[jobs] ${record.id.slice(0, 8)}: its record is removed (${standing === 'closed' ? 'the task is closed' : 'no schedule, no channel, no open run'})`)
      return
    }
    // Without a schedule nothing was seen: one set later counts from then, its wake-up fires whatever fired before,
    // and an end after so many runs went with the repeating times it was set for.
    if (current.cursor !== null || current.firedWake !== null || current.end !== null) store.put({ ...current, cursor: null, firedWake: null, end: null, updatedAt: new Date(now).toISOString() })
  }

  /** What is due on one task this cockpit fires: missed times are recorded, and at most one firing becomes a run or is skipped. */
  private async deriveTask(space: RunnerSpace, task: RunnerTask, now: number): Promise<void> {
    const { store } = this.deps
    const at = new Date(now).toISOString()
    const schedule = scheduleOf(task)!
    const name = nameOfTask(task)
    this.facts.set(task.id, { name, paused: schedule.paused === true })
    const stored = store.get(task.id)
    let record = stored ?? newRecord({ id: task.id, spaceId: space.key }, at)
    const save = () => {
      if (stored && JSON.stringify(stored) === JSON.stringify(record)) return
      store.put(stored ? { ...record, updatedAt: at } : record)
    }
    // The pause the cockpit set after failures is over once the schedule runs again, whoever resumed it.
    if (record.pausedReason !== null && !schedule.paused) record = { ...record, pausedReason: null, failures: 0 }
    if (record.firedWake !== null) {
      // The wake-up it fired is off the task: forgotten. Still on it: the write that clears it failed, so again.
      if (!sameInstant(record.firedWake, schedule.at)) record = { ...record, firedWake: null }
      else this.clearFiredWake(space, task.id, record.firedWake)
    }
    if (scheduleIsOff(schedule, now)) {
      // Paused or past its end: nothing is due, and what falls due meanwhile is not made up once it runs again.
      if (record.cursor !== null) record = { ...record, cursor: null }
      save()
      return
    }
    const openRuns = store.runs(task.id).filter(isOpenRun)
    // An end after so many runs belongs to the repeating times: without one it counts nothing, and is off.
    if (record.end && !schedule.crons?.length) record = { ...record, end: null }
    // What is still to fire: the schedule, or with the runs of its repeating times used up, its wake-up alone.
    let timed: typeof schedule | null = schedule
    if (record.end && record.runCount >= record.end.afterRuns) {
      // The repeating times have had their runs: they go off the task once the last run is over, and the count with
      // them. The wake-up is not theirs: it stays, and with it the schedule. The task stays open.
      if (openRuns.length === 0) {
        save()
        await this.deps.editSchedule(space, task.id, (current) => setCrons(current, []), RUNS_USED_UP)
        const kept = store.get(task.id)
        if (kept) store.put({ ...kept, end: null, updatedAt: at })
        this.deps.log(`[jobs] ${name}: its repeating times ended after the runs they were set to have`)
        return
      }
      timed = setCrons(schedule, [])
      if (!timed) {
        save()
        return
      }
    }
    const due = dueOf(timed, record, now, JOB_LIMITS.lateLimitMs)
    if (!sameInstant(due.cursor, record.cursor)) record = { ...record, cursor: due.cursor }
    const timeZone = schedule.time_zone
    for (const missed of due.missed) {
      const late = formatDuration(now - Date.parse(missed.dueAt))
      this.record(task.id, missed.dueAt, 'missed', `due ${late} ago while the cockpit was not running`, { crons: [missed], ...(timeZone ? { timeZone } : {}) })
      this.tell(record, 'missed', `Missed a run due ${late} ago while the cockpit was not running (cron "${missed.cron}"); the next one is on schedule.`)
      this.deps.log(`[jobs] ${name}: missed a run due ${missed.dueAt}`)
    }
    // The cursor first: a run is never made twice for the same repeating time.
    save()
    const firing = due.firing
    if (!firing) return
    const zoned = timeZone ? { timeZone } : {}
    const crons = firing.crons.length > 0 ? firing.crons : null
    // A wake-up that rides in a run which has not ended is not due again: that run brings it.
    const wake = firing.wake && !openRuns.some((run) => sameInstant(run.fired?.wake?.at, firing.wake!.at)) ? firing.wake : null
    if (!crons && !wake) return
    const cronsDueAt = crons ? crons.map((c) => c.dueAt).sort()[0] : firing.dueAt
    /**
     * The repeating times that are due are skipped and recorded. The wake-up is never skipped (it carries a reason,
     * like a message): it is not marked as fired and stays on the task, so it is due again at the next read, and
     * fires in the first one where the four-line order can give it to a session. Nothing is recorded for it meanwhile.
     */
    const skipCrons = (note: string) => {
      if (!crons) return
      this.record(task.id, cronsDueAt, 'skipped', note, { crons, ...zoned })
      this.deps.log(`[jobs] ${name}: a time due ${cronsDueAt} is skipped, ${note}`)
    }
    if (openRuns.some((run) => run.status !== 'started')) {
      skipCrons(SKIPPED_NOT_STARTED)
      // A run of the task waits to start: the wake-up joins it, so the session that gets the run reads its reason too.
      const waiting = wake ? openRuns.find((run) => run.status === 'waiting') : undefined
      if (wake && waiting) {
        this.update(waiting, { fired: { ...waiting.fired, wake, ...zoned } })
        this.deps.log(`[jobs] ${name}: its wake-up joins run ${waiting.number}, which waits to start`)
      }
      return
    }
    const facts = await this.factsOf(space, task, { times: true, wake: wake ? { bySession: wake.bySession } : null, message: false }, new Set())
    if (decideFiring(facts).kind === 'skip') {
      skipCrons(SKIPPED_WORKING)
      return
    }
    const fired: RunFired = { ...(wake ? { wake } : {}), ...(crons ? { crons } : {}), ...zoned }
    const run = this.addRun(task.id, 'schedule', Date.parse(firing.dueAt), { fired })
    this.deps.log(`[jobs] ${name}: run ${run.number} is due`)
  }

  /**
   * A run that carries the wake-up got to a session (or failed for good): the wake-up has fired. It is remembered on
   * the record first, so it fires once even when the write that takes it off the task fails, then cleared on the task.
   */
  private wakeFired(run: JobRun): void {
    const at = run.fired?.wake?.at
    const record = this.deps.store.get(run.jobId)
    const space = record ? this.spaceOf(record) : null
    if (!at || !record || !space) return
    if (!sameInstant(record.firedWake, at)) this.deps.store.put({ ...record, firedWake: at })
    this.clearFiredWake(space, record.id, at)
  }

  /** The wake-up fired: it goes off the task, unless the task has another one by now. Failing, the next read tries again. */
  private clearFiredWake(space: RunnerSpace, taskId: string, at: string): void {
    this.writes.push(this.deps.editSchedule(space, taskId, (schedule) => (sameInstant(schedule?.at, at) ? clearWake(schedule) : schedule))
      .catch((err: unknown) => this.deps.log(`[jobs] ${this.nameOf(taskId)}: its fired wake-up was not cleared on the task: ${(err as Error).message}`)))
  }

  /** What the four-line order reads of the task: its sessions here with their turn and their wait, and work elsewhere. */
  private async factsOf(space: RunnerSpace, task: RunnerTask, fired: Fired, unwakeable: ReadonlySet<string>): Promise<FiringFacts> {
    const waits = waitsOf(task.properties ?? undefined)
    const sessions = this.deps.sessionsOf(task.id).map((session) => {
      const wait = waits.find((w) => (w.session_id ?? w.id) === session.sessionId)
      return { sessionId: session.sessionId, working: session.working, wait: wait ? waitKind(wait) : null, wakeable: !unwakeable.has(session.sessionId), linked: session.linked === true }
    })
    const workingElsewhere = sessions.some((s) => s.working) ? false : await this.deps.workingElsewhere?.(space, task.id).catch(() => false) ?? false
    return { fired, sessions, workingElsewhere }
  }

  /** The run's session answered, or stopped working without a word. */
  private settle(record: Job, run: JobRun, now: number): void {
    if (!run.sessionId || !run.startedAt) return
    const said = this.deps.statusSince(run.sessionId, run.startedAt)
    const status = said?.kind ?? null
    const state = this.deps.sessionState(run.sessionId)
    if (!status) {
      if (state === 'queued' && now - Date.parse(run.startedAt) > QUEUED_LIMIT_MS) {
        this.failRun(run, 'the worker never started')
        return
      }
      if (state === 'working' || state === 'queued' || now - Date.parse(run.startedAt) < SETTLE_MS) return
    }
    this.update(run, { status: 'finished', outcome: status, finishedAt: new Date(now).toISOString() })
    let fresh = this.deps.store.get(record.id)
    if (!fresh) return
    // A lent tool is for the work at hand: it goes back once the session says it is done.
    if (status === 'done' && fresh.grants?.length) {
      const ended = activeGrants(fresh, now).map((g) => g.tool)
      fresh = { ...fresh, grants: [] }
      this.deps.store.put(fresh)
      if (ended.length) this.deps.onGrantEnd?.(fresh, ended)
    }
    const needsYou = status === 'review' || status === 'question' || status === 'failed'
    if (fresh.notify === 'always' || (fresh.notify === 'needs-me' && needsYou)) {
      this.tell(fresh, status ?? 'done', `Run ${run.number}: ${said?.reason ?? (status ? STATUS_WORDS[status] : 'finished without saying how it went')}`, run.sessionId)
    }
    // Its session shows the failure itself; the count may still pause the schedule.
    if (status === 'failed') this.countFailure(fresh, `run ${run.number} ended as failed`, false)
    else if (fresh.failures) this.deps.store.put({ ...fresh, failures: 0 })
  }

  private addRun(taskId: string, trigger: JobRun['trigger'], due: number, extra: Pick<JobRun, 'idempotencyKey' | 'message' | 'fired'> = {}): JobRun {
    const record = this.deps.store.get(taskId)!
    const run: JobRun = {
      id: randomUUID(), jobId: taskId, trigger, number: record.runCount + 1,
      dueAt: new Date(due).toISOString(), createdAt: new Date(this.now()).toISOString(),
      status: 'waiting', attempts: 0, nextAttemptAt: null, sessionId: null, startedAt: null, finishedAt: null, outcome: null, note: null,
      ...extra,
    }
    // An end after so many runs counts the runs a repeating time fired: any other run moves the end along with it.
    const end = record.end && !countsToEnd(run) ? { afterRuns: record.end.afterRuns + 1 } : record.end
    this.deps.store.put({ ...record, runCount: record.runCount + 1, end })
    this.deps.store.addRun(run)
    return run
  }

  /** A run that never happened after all: its number is given back, and with it what it moved an end after so many runs by. */
  private drop(run: JobRun): void {
    const before = this.deps.store.get(run.jobId)
    this.deps.store.dropRun(run)
    const after = this.deps.store.get(run.jobId)
    if (before && after?.end && after.runCount < before.runCount && !countsToEnd(run)) this.deps.store.put({ ...after, end: { afterRuns: after.end.afterRuns - 1 } })
  }

  /** A time that never ran: missed or skipped, kept in the history without a run number. */
  private record(taskId: string, dueAt: string, status: 'missed' | 'skipped', note: string, fired: RunFired): void {
    const at = new Date(this.now()).toISOString()
    this.deps.store.addRun({
      id: randomUUID(), jobId: taskId, trigger: 'schedule', number: 0, dueAt, createdAt: at,
      status, attempts: 0, nextAttemptAt: null, sessionId: null, startedAt: null, finishedAt: at, outcome: null, note, fired,
    })
  }

  /**
   * Try to start one waiting run by the four-line order. `once`: a channel wake, which the bridge retries itself, so
   * a run that cannot start now gets no later attempt here. `known`: the task as just read, to save reading it again.
   */
  private async attempt(record: Job, run: JobRun, once = false, known?: RunnerTask): Promise<Attempt> {
    const now = this.now()
    const wait = (why: string, counted = false): Attempt => {
      if (!once) this.retry(this.current(run), why, counted)
      return 'retry'
    }
    if (now - Date.parse(run.dueAt) > JOB_LIMITS.retryWindowMs && run.attempts > 0) {
      this.failRun(run, `could not start within ${formatDuration(JOB_LIMITS.retryWindowMs)}: ${run.note ?? 'no room'}`)
      return 'failed'
    }
    const space = this.spaceOf(record)
    let task = known ?? null
    if (!task && space) {
      try {
        task = await this.deps.task(space, record.taskId)
      } catch (err) {
        return wait(`its task could not be read: ${(err as Error).message}`)
      }
    }
    // Nothing fires on a closed task: the run that was due is skipped, and nothing counts as a failure.
    if (!space || !task || !OPEN.has(task.status)) {
      this.update(run, { status: 'skipped', note: CLOSED_BEFORE_START, finishedAt: new Date(now).toISOString() })
      this.deps.log(`[jobs] ${this.nameOf(record.id)}: run ${run.number} skipped, ${CLOSED_BEFORE_START}`)
      return 'gone'
    }
    const name = nameOfTask(task)
    const fired: Fired = {
      times: run.trigger === 'schedule' || run.trigger === 'manual',
      wake: run.fired?.wake ? { bySession: run.fired.wake.bySession } : null,
      message: run.trigger !== 'schedule' && run.trigger !== 'manual',
    }
    const message = firedText(run, { id: task.id, name }, now, this.deps.timeZone())
    const unwakeable = new Set<string>()
    for (;;) {
      const decision = decideFiring(await this.factsOf(space, task, fired, unwakeable))
      if (decision.kind === 'skip') {
        // A session started working meanwhile. The run's wake-up is not used up: it was never marked as fired, so it
        // is due again at the next read. A run that was only the wake-up is taken back; any other is recorded as
        // skipped, without the wake-up.
        const { wake, ...rest } = this.current(run).fired ?? {}
        if (wake && run.trigger === 'schedule' && !rest.crons?.length) {
          this.drop(this.current(run))
          this.deps.log(`[jobs] ${name}: its wake-up stays due, ${SKIPPED_WORKING}`)
          return 'skipped'
        }
        this.update(run, { status: 'skipped', note: SKIPPED_WORKING, finishedAt: new Date(this.now()).toISOString(), ...(wake ? { fired: rest } : {}) })
        this.deps.log(`[jobs] ${name}: run ${run.number} skipped, ${SKIPPED_WORKING}${wake ? '; its wake-up stays due' : ''}`)
        return 'skipped'
      }
      if (decision.kind === 'retry') return wait('a session of the task is working and none that has the channel\'s tools can take the message now')
      if (decision.kind === 'start') {
        if (!this.deps.hasRoom()) return wait(NO_ROOM)
        // A new session: its id is named before the start, so a restart in between finds it (recover).
        const sessionId = randomUUID()
        this.update(run, { status: 'starting', attempts: this.current(run).attempts + 1, sessionId, newSession: true })
        const checkpoint = delegationOf(task)?.checkpoint ?? 'none'
        const prompt = stepPrompt({ id: task.id, title: name, content: task.content ?? '', startedBy: startedBy(run), ofJob: true }, checkpoint)
        const problem = this.deps.startWorker(this.deps.store.get(record.id) ?? record, task, sessionId, `${prompt}\n\n${message}`)
        if (problem) {
          this.failRun(this.current(run), `the worker could not start: ${problem}`)
          return 'failed'
        }
        this.started(run)
        this.deps.log(`[jobs] ${name}: run ${run.number} started session ${sessionId}`)
        return 'started'
      }
      const sessionId = decision.sessionId
      if (!this.deps.sessionRuns(sessionId) && !this.deps.hasRoom()) return wait(NO_ROOM)
      const before = this.current(run)
      this.update(run, { status: 'starting', attempts: before.attempts + 1, sessionId, newSession: false })
      const outcome = await this.deps.deliver(sessionId, message)
      if (outcome === 'delivered' || outcome === 'resumed') {
        this.started(run)
        this.deps.log(`[jobs] ${name}: run ${run.number} ${outcome} to ${sessionId} (${decision.kind === 'deliver' ? 'it is working' : decision.line === 'wake' ? 'it set the wake-up' : 'it waits on an answer'})`)
        return 'started'
      }
      if (outcome === 'busy' || outcome === 'running') return wait('its session was busy (running in a terminal, or switching)', true)
      // It is gone or takes no message: the order is asked again without it (a new session, or the bridge tries again).
      unwakeable.add(sessionId)
      this.update(run, { status: 'waiting', attempts: before.attempts, sessionId: null })
      this.deps.log(`[jobs] ${name}: run ${run.number} did not reach ${sessionId} (${outcome})`)
    }
  }

  private started(run: JobRun): void {
    const at = new Date(this.now()).toISOString()
    // The wake-up the run carries has fired now, and not before: remembered before the run counts as started.
    this.wakeFired(this.current(run))
    this.update(run, { status: 'started', startedAt: at, note: null })
    const record = this.deps.store.get(run.jobId)
    if (record) this.deps.store.put({ ...record, lastRunAt: at })
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
    // A run that fails for good uses its wake-up up: the failure is told, and it is not tried again pass after pass.
    this.wakeFired(this.current(run))
    this.update(run, { status: 'failed', note: why, finishedAt: new Date(this.now()).toISOString() })
    const record = this.deps.store.get(run.jobId)
    this.deps.log(`[jobs] ${this.nameOf(run.jobId)}: run ${run.number} failed: ${why}`)
    if (record) this.countFailure(record, `run ${run.number} failed: ${why}`)
  }

  private countFailure(record: Job, why: string, tell = true): void {
    const failures = record.failures + 1
    this.deps.store.put({ ...record, failures })
    if (failures >= JOB_LIMITS.failuresToPause && record.pausedReason === null) {
      this.writes.push(this.pauseAfterFailures(record.id, `${failures} failed runs in a row; last: ${why}`))
      return
    }
    if (!tell) return
    this.tell(record, 'failed', why[0].toUpperCase() + why.slice(1))
    if (record.notify !== 'never') this.deps.flag(record, `"${this.nameOf(record.id)}": ${why}`)
  }

  /**
   * Too many failures in a row: the task's schedule is paused on the task, and the record keeps why. The reason is
   * kept only once the task has the pause; a write that fails is tried again at the next failure.
   */
  private async pauseAfterFailures(taskId: string, reason: string): Promise<void> {
    const space = this.spaceOf(this.deps.store.get(taskId) ?? { spaceId: null })
    const name = this.nameOf(taskId)
    try {
      if (!space) throw new Error('its space is gone')
      await this.deps.editSchedule(space, taskId, (schedule) => setPaused(schedule, true), `The cockpit paused its schedule after ${reason}. Resume it on the task once fixed.`)
    } catch (err) {
      this.deps.log(`[jobs] ${name}: its schedule could not be paused after ${reason}: ${(err as Error).message}`)
      return
    }
    const record = this.deps.store.get(taskId)
    if (!record) return
    this.deps.store.put({ ...record, pausedReason: reason, updatedAt: new Date(this.now()).toISOString() })
    this.facts.set(taskId, { name, paused: true })
    // Always told, whatever the record's notify says: it will not run again until someone resumes it.
    const body = `Paused itself after ${reason}. Resume it on the task once fixed.`
    this.deps.notify({ kind: 'paused', title: name, body, jobId: record.id, sessionId: null, spaceId: record.spaceId })
    this.deps.flag(record, `The schedule of "${name}" ${body[0].toLowerCase()}${body.slice(1)}`)
  }

  private tell(record: Job, kind: NotificationKind, body: string, sessionId: string | null = null): void {
    if (record.notify === 'never') return
    this.deps.notify({ kind, title: this.nameOf(record.id), body, jobId: record.id, sessionId, spaceId: record.spaceId })
  }
}
