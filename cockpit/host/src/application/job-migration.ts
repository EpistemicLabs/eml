import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace } from '../brain-space.js'
import type { ScheduleFields } from '../domain/delegation.js'
import type { JobV1 } from '../domain/job-v1.js'
import { changedMeanwhile, jobFates, jobMigrationReport, leftoverNote, planJobMigration, SCHEDULES_ON_TASKS_SCHEMA, stepOf, type JobMigrationPlan, type JobMigrationTask, type NewRoutineTask, type TaskMigration } from '../domain/job-migration.js'
import type { NotificationInput } from '../notifications.js'
import type { JobStore } from '../job-store.js'
import { openTasks, taskById } from './task-read.js'
import { makeRoutineTask, routineTask } from './task-state-migration.js'
import { sameSchedule } from '../domain/task-schedule.js'
import { editTaskSchedule, ScheduleChangedError } from './task-schedule-write.js'

/**
 * The migration of jobs.json version 1 to version 2, written (domain/job-migration.ts plans it): one pass at the
 * host's start, once the brains are at schema 24. Per space it reads the tasks of the version 1 jobs, plans, and
 * writes task by task: the brain first (the schedule, the text, the journal, in one call through
 * application/task-schedule-write.ts), then the store (the record in, the jobs out of the version 1 data), then the
 * sessions of those jobs move to the record in the ledger, and the channel bridge is told the jobs' new id, since
 * its own database files their messages, wakes and drafts by job id.
 *
 * The version 1 file is copied next to itself before it is rewritten for the first time (job-store.ts). The report
 * of each real run is appended to a file next to it, and the user is told when a job did not move. The pass is
 * safe to run again: a job that moved is no longer in the version 1 data, so a second start finds nothing; a task
 * whose write failed, and a space whose brain did not answer, keep their jobs there for the next start. A crash
 * between a task's brain write and its store write plans that one task again: its schedule and text are found as
 * they should be and are not written twice; only its journal lines repeat. A task made for a job without one is
 * named on the job in the store as soon as it exists, so it is made once.
 *
 * Every write is checked against what was planned: a task's schedule and text go with the rev the plan read the task
 * at, so a task that changed in between is not written in this pass and is planned again in the next one; a
 * left-over schedule is removed only while the task still has that schedule and no record.
 *
 * A space whose brain is not at schema 24 yet (the brain server's control data says which it is at) is neither
 * planned nor looked through: its jobs wait. So does a space the brain server has not said the kind of (shared or
 * local).
 *
 * In a home that was on version 1, every space the cockpit had when the file was converted (job-store.ts v1Spaces) is
 * looked through once for schedules the old mirror left on tasks without a job (domain/job-migration.ts), before any
 * job of it moves, and also when it has no job: nothing ran such a schedule, and it must not start to fire. Each such
 * space has its own look, made whenever it can first be looked through (an agent bound to it, its kind known, its
 * brain at schema 24), also once an agent is bound to it later. Until a space was looked through the engine takes up
 * no schedule there by seeing it (application/job-runner.ts holdsFirstSight). A space added after the conversion is
 * never held nor looked through: a schedule on a task there is real. A home that never had a version 1 file is not
 * looked through: nothing there can be a leftover.
 */

export interface JobMigrationDeps {
  store: Pick<JobStore, 'pendingV1' | 'migrateV1'> & Partial<Pick<JobStore, 'setV1Task'>> & Partial<Pick<JobStore, 'pendingRenames' | 'renameConfirmed' | 'fromV1' | 'awaitsLeftoverLook' | 'markLeftoversChecked' | 'get'>>
  spaces(): BrainSpace[]
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post'> | null
  /**
   * Whether the space is shared, asked of the brain server again when the host does not know it yet (space.shared is
   * null); null: still not known. A space of unknown kind is not planned: whose cockpit fires a task depends on it.
   */
  spaceKind?(space: BrainSpace): Promise<boolean | null>
  /**
   * The schema version of the space's brain, as the brain server's control data has it (update-status.ts
   * brainSchemaVersion); null: it could not be read. A space whose brain is not at schema 24 is not planned.
   */
  brainSchema(space: BrainSpace): number | null
  /** This cockpit's member. */
  me: string
  /** The sessions that worked for a job work for the task's record from now on (the ledger's jobId). */
  moveSessions(fromJobId: string, toRecordId: string): void
  now(): number
  log(line: string): void
  /**
   * Keep the report of a real run: append it to the report file in the cockpit home, next to the backup of the
   * version 1 file, and return that file's path. Without it no report is kept.
   */
  saveReport?(markdown: string): string
  /**
   * Tell the channel bridge that a job has a new id (channel-bridge-api.ts renameBridgeJob), so what its own database
   * holds for the job follows. `off`: the bridge does not run, which is no error: the rename waits for the next
   * start. `failed`: it runs and did not take it.
   */
  renameInBridge?(fromJobId: string, toRecordId: string): Promise<'renamed' | 'off' | 'failed'>
  /** Tell the user (notifications.ts, as the engine tells a paused schedule): a run in which a job did not move. */
  notify?(input: NotificationInput): void
}

/** A space's plan, when it was made, and the tasks it was made against (as read then, with their rev). */
interface SpacePlan { plan: JobMigrationPlan; at: string; tasks: Record<string, JobMigrationTask | null> }
export interface JobMigrationResult {
  /** Tasks, by what became of them. */
  moved: number
  dropped: number
  left: number
  failed: string[]
  reports: string[]
  /** Jobs: those that go on firing on their task, and those that do not (left out, dropped while live, or still waiting). Jobs that were over do not count. */
  jobs: { moved: number; notMoved: number }
  /** Schedules the old mirror had left on tasks without a job, removed in this run. */
  leftovers: number
  /** Schedules that arrived paused as a whole because one of their repeating jobs was paused, while others ran. */
  arrivedPaused: number
  /** Schedules whose times all wait for the user's OK, because every job of their task was waiting for it. */
  arrivedHeld: number
  /** Where this run's report was kept; null: none was written (nothing was planned, nothing changed since the last one, or it failed). */
  reportFile: string | null
  /** Spaces this run could not look through yet for schedules left without a job: a later pass tries again. */
  unlooked: number
}

/** What a real run appends to the report file: its date, the count by job, what was not done, and each space's report. */
export function runReport(result: Pick<JobMigrationResult, 'jobs' | 'failed' | 'reports'>, at: string): string {
  const notDone = result.failed.length > 0 ? `Not done in this run:\n${result.failed.map((line) => `- ${line}`).join('\n')}\n\n` : ''
  return `# Run of ${at}\n\n${MOVED_LINE(result.jobs)}.\n\n${notDone}${result.reports.join('\n')}\n`
}

const MOVED_LINE = (jobs: JobMigrationResult['jobs']) => `Schedules moved onto their tasks: ${jobs.moved} moved, ${jobs.notMoved} not moved`

/** The space's open tasks that have a schedule, as the engine lists them: two reads, none per task. */
async function scheduledTasks(brain: Pick<EmlApi, 'get'>): Promise<JobMigrationTask[]> {
  return (await openTasks<JobMigrationTask>(brain)).filter((task) => task.properties?.delegation?.schedule)
}

const keyOf = (space: BrainSpace): string | null => (space.main ? null : space.id)

/** A space and a planned task in a log line: by their ids, never by their names. */
const spaceTag = (space: BrainSpace): string => `space ${keyOf(space) ?? 'main'}`
const taskTag = (task: Pick<TaskMigration, 'taskId' | 'jobs'>): string =>
  task.taskId ? `task ${task.taskId.slice(0, 8)}` : `job ${task.jobs.map((job) => job.id.slice(0, 8)).join(', ')}`

/** The routine task a job without a task gets, in the project its sessions start in. */
export const routineTaskOfJob = (me: string) => (job: JobV1): NewRoutineTask | null =>
  routineTask({ id: job.id, name: job.name, prompt: job.prompt }, job.target.type === 'session' ? null : job.target.projectId, me)

/** The tasks the space's jobs name, as its brain has them; null for one the brain does not have. Any other failure throws. */
export async function tasksOfJobs(brain: Pick<EmlApi, 'get'>, jobs: readonly JobV1[]): Promise<Record<string, JobMigrationTask | null>> {
  const tasks: Record<string, JobMigrationTask | null> = {}
  for (const id of new Set(jobs.flatMap((j) => (j.taskId ? [j.taskId] : [])))) tasks[id] = await taskById<JobMigrationTask>(brain, id)
  return tasks
}

/** The people of a space, as its brain lists its users; null when it does not answer. Who owns a task nobody is assigned to depends on them. */
export async function membersOf(brain: Pick<EmlApi, 'get'>): Promise<string[] | null> {
  try {
    const listed = await brain.get('/object/user') as { objects?: Array<{ id?: unknown }> }
    return (listed.objects ?? []).map((o) => o.id).filter((id): id is string => typeof id === 'string' && id !== '')
  } catch {
    return null
  }
}

/** What a pass says of a space it cannot plan yet because its kind is not known. */
export const KIND_UNKNOWN = 'the brain server has not said yet whether it is shared'
const NO_BRAIN = 'no brain to ask'

export function createJobMigration(deps: JobMigrationDeps) {
  let running: Promise<JobMigrationResult> | null = null
  /** A report of this process is in the file: a later pass adds one only when it changed something. */
  let reported = false

  /** Shared, local, or null: not known yet (asked again each time). */
  const kindOf = async (space: BrainSpace): Promise<boolean | null> =>
    space.shared ?? (deps.spaceKind ? await deps.spaceKind(space).catch(() => null) : null)

  /**
   * Whether a space can be planned and looked through in this pass; when not, why, and what becomes of its look for
   * schedules left without a job:
   *
   *   - `later`: it waits, and a later pass asks again — it has an agent and no brain to ask now; its kind is not
   *     known (whose cockpit fires a task depends on it); its brain is not at schema 24 yet, or its schema could not
   *     be read (a schedule of schema 23 reads as none, domain/task-schedule.ts scheduleOf: a look would find nothing
   *     left over and call it done). A brain that does not answer the plan's reads waits the same way (runOnce).
   *   - `none`: no agent is bound to the space, so the host has no task brain for it and the engine fires nothing
   *     there. It is neither looked through nor marked: once an agent is bound to it, it waits for its look like any
   *     other space, and is held until then. Its version 1 jobs still wait.
   */
  const readinessOf = async (space: BrainSpace, brain: Pick<EmlApi, 'get' | 'post'> | null): Promise<{ ready: true } | { ready: false; why: string; look: 'later' | 'none' }> => {
    // A space no agent is bound to has no task brain here, whatever else answers for it.
    if (!brain || isUnbound(space)) return { ready: false, why: NO_BRAIN, look: isUnbound(space) ? 'none' : 'later' }
    if (await kindOf(space) === null) return { ready: false, why: KIND_UNKNOWN, look: 'later' }
    const schema = deps.brainSchema(space)
    if (schema === null) return { ready: false, why: 'the schema of its brain could not be read', look: 'later' }
    if (schema < SCHEDULES_ON_TASKS_SCHEMA) return { ready: false, why: `its brain is at schema ${schema}, not at ${SCHEDULES_ON_TASKS_SCHEMA} yet`, look: 'later' }
    return { ready: true }
  }

  /** The space still waits for its one look for schedules left without a job (job-store.ts awaitsLeftoverLook). */
  const awaitsLook = (space: BrainSpace): boolean => deps.store.awaitsLeftoverLook?.(keyOf(space)) === true
  /** No agent is bound to the space: the host has no task brain for it, and the engine fires nothing there. */
  const isUnbound = (space: BrainSpace): boolean => space.agent === null
  /** What was said in the log of a space's look: each line once per space, not at every pass. */
  const saidOfLook = new Set<string>()
  const said = (line: string) => {
    if (saidOfLook.has(line)) return
    saidOfLook.add(line)
    deps.log(`[jobs] migration, ${line}`)
  }

  /**
   * The plan of one space, from the version 1 data and the brain as they are now; null when it has no job to move and
   * was looked through. Nothing is written.
   */
  const planSpace = async (space: BrainSpace, brain: Pick<EmlApi, 'get'>): Promise<SpacePlan | null> => {
    const pending = deps.store.pendingV1()
    const jobs = Object.values(pending?.jobs ?? {})
    const mine = jobs.filter((j) => (j.spaceId ?? null) === keyOf(space))
    const now = deps.now()
    const shared = await kindOf(space)
    // The first look through the space, while all its version 1 jobs are still there: the schedules left without a
    // job are named too, also in a space that has no job. Once it was looked through, never again: a schedule set on
    // a jobless task later is real.
    const first = shared !== null && awaitsLook(space)
    if (mine.length === 0 && !first) return null
    const scheduled = first ? await scheduledTasks(brain) : undefined
    const tasks = await tasksOfJobs(brain, mine)
    const plan = planJobMigration({
      jobs, runs: pending?.runs ?? {}, keys: pending?.keys ?? {}, space: { key: keyOf(space), name: space.name, shared },
      ...(scheduled ? { scheduled, records: new Set(scheduled.filter((task) => deps.store.get?.(task.id) !== undefined).map((task) => task.id)) } : {}),
      // Only a shared space has other members whose tasks are not this cockpit's.
      members: shared === true ? await membersOf(brain) : null,
      tasks, me: deps.me, now, routineTaskOf: routineTaskOfJob(deps.me),
    })
    return { plan, at: new Date(now).toISOString(), tasks }
  }

  /**
   * Write one planned task. `read`: the task as the plan read it; its rev goes with the write (the brain's base_rev
   * precondition), so the schedule and the text are written only onto the task they were planned against. A task that
   * changed since throws ScheduleChangedError, with nothing written.
   */
  const applyTask = async (space: BrainSpace, brain: Pick<EmlApi, 'get' | 'post'>, task: TaskMigration, read: JobMigrationTask | null): Promise<void> => {
    let taskId = task.taskId
    if (task.create) {
      // Found again by its title when an earlier try made it and was cut off before the next line.
      taskId = (await makeRoutineTask(brain, task.create)).id
      // The job names its task at once, before anything is written to it: a retry plans it there and makes no
      // second task, and the engine waits for the task until the job has moved.
      for (const jobId of task.settles) deps.store.setV1Task?.(jobId, taskId)
    }
    if (task.brain && taskId) {
      const text = task.brain.journal.join(' ')
      const fields = { ...(task.brain.content !== null ? { content: task.brain.content } : {}), ...(task.brain.goal ? { goal: task.brain.goal } : {}) }
      const schedule = task.schedule
      await editTaskSchedule(brain, taskId, task.brain.setSchedule ? () => schedule : (current) => current, {
        agent: space.agent, ...(text ? { text } : {}), fields, ...(typeof read?.rev === 'number' ? { baseRev: read.rev } : {}),
      })
    }
    const step = stepOf(task, taskId)
    deps.store.migrateV1(step)
    if (step.record) for (const jobId of task.renamed) deps.moveSessions(jobId, step.record.id)
  }

  /**
   * The channel bridge follows the ids of the jobs that moved: each one whose new id it has not confirmed is told
   * again, and forgotten once it has. Asked after the store step, never before: until the record exists the old id
   * is the one the cockpit answers for.
   */
  const confirmRenames = async (): Promise<void> => {
    const pending = Object.entries(deps.store.pendingRenames?.() ?? {})
    if (pending.length === 0 || !deps.renameInBridge) return
    let failed = 0
    for (const [from, to] of pending) {
      const outcome = await deps.renameInBridge(from, to).catch(() => 'failed' as const)
      if (outcome === 'renamed') deps.store.renameConfirmed?.(from)
      else if (outcome === 'failed') failed += 1
      // The bridge does not run: nothing more to ask now.
      else break
    }
    const left = Object.keys(deps.store.pendingRenames?.() ?? {}).length
    if (failed > 0) deps.log(`[jobs] migration: the channel bridge did not take the new id of ${failed} moved job(s); asked again at the next start`)
    else if (left > 0) deps.log(`[jobs] migration: the channel bridge does not run; it is told the new id of ${left} moved job(s) once it does`)
    else deps.log(`[jobs] migration: the channel bridge has the new id of ${pending.length} moved job(s)`)
  }

  const runOnce = async (): Promise<JobMigrationResult> => {
    const result: JobMigrationResult = { moved: 0, dropped: 0, left: 0, failed: [], reports: [], jobs: { moved: 0, notMoved: 0 }, leftovers: 0, arrivedPaused: 0, arrivedHeld: 0, reportFile: null, unlooked: 0 }
    /** What was not done: for the result and the report as the user reads it (names), and for the log (ids). */
    const failed = (shown: string, logged: string) => {
      result.failed.push(shown)
      deps.log(`[jobs] migration: ${logged}`)
    }
    // A home that was on version 1 has its spaces looked through once for schedules left without a job, also the
    // spaces that have no job. A home that never was has nothing of the kind: no space of it is asked.
    const hadJobs = deps.store.pendingV1() !== null
    const looks = deps.store.fromV1?.() === true
    if (!hadJobs && !(looks && deps.spaces().some((space) => awaitsLook(space) && !isUnbound(space)))) {
      await confirmRenames()
      return result
    }
    /** The space has no job that waits, and cannot be looked through now: it waits, said once in the log. */
    const unlooked = (space: BrainSpace, why: string) => said(`${spaceTag(space)}: not looked through yet for schedules left without a job: ${why}`)
    for (const space of deps.spaces()) {
      const brain = deps.brain(space)
      const waiting = Object.values(deps.store.pendingV1()?.jobs ?? {}).filter((j) => (j.spaceId ?? null) === keyOf(space)).length
      if (waiting === 0 && !awaitsLook(space)) continue
      const readiness = await readinessOf(space, brain)
      if (!readiness.ready || !brain) {
        const why = readiness.ready ? NO_BRAIN : readiness.why
        if (waiting > 0) failed(`${space.name}: ${why}, its ${waiting} job(s) wait`, `${spaceTag(space)}: ${why}, its ${waiting} job(s) wait`)
        else if (!readiness.ready && readiness.look === 'none') said(`${spaceTag(space)}: no agent is bound to it, so nothing there can fire: it is looked through for schedules left without a job once one is`)
        else unlooked(space, why)
        result.jobs.notMoved += waiting
        continue
      }
      let planned: SpacePlan | null
      try {
        planned = await planSpace(space, brain)
      } catch (err) {
        const what = `its brain did not answer (${(err as Error).message})`
        if (waiting === 0) unlooked(space, what)
        else failed(`${space.name}: ${what}, its ${waiting} job(s) wait`, `${spaceTag(space)}: ${what}, its ${waiting} job(s) wait`)
        result.jobs.notMoved += waiting
        continue
      }
      if (!planned) continue
      // The left-over schedules first, before any job of the space moves. One that cannot be removed is tried again:
      // the space counts as looked through only once all are gone, and until then the engine takes up no schedule
      // there by seeing it.
      let removed = true
      for (const left of planned.plan.leftovers ?? []) {
        try {
          // Checked again at the write: it is removed only while the task still has the schedule the plan saw and
          // still no record. Otherwise someone set it meanwhile, and it is left alone.
          const still = (current: ScheduleFields | null) => sameSchedule(current, left.schedule) && deps.store.get?.(left.taskId) === undefined
          const written = await editTaskSchedule(brain, left.taskId, (current) => (still(current) ? null : current), { text: leftoverNote(left.schedule, left.shared === true), onlyWithChange: true })
          if (written.changed) {
            result.leftovers += 1
            deps.log(`[jobs] migration, ${spaceTag(space)}: task ${left.taskId.slice(0, 8)}: a schedule without a job was left on this task; removed`)
          } else {
            left.changed = true
            deps.log(`[jobs] migration, ${spaceTag(space)}: task ${left.taskId.slice(0, 8)}: its schedule without a job changed meanwhile; left alone`)
          }
        } catch (err) {
          removed = false
          const what = `its schedule without a job could not be removed: ${(err as Error).message}`
          failed(`${space.name}: "${left.title}": ${what}`, `${spaceTag(space)}: task ${left.taskId.slice(0, 8)}: ${what}`)
        }
      }
      if (removed && planned.plan.leftovers !== undefined) deps.store.markLeftoversChecked?.(keyOf(space))
      for (const [index, task] of planned.plan.tasks.entries()) {
        const fates = jobFates({ tasks: [task] })
        if (task.outcome === 'left') {
          result.left += 1
          result.jobs.notMoved += fates.waits + fates.lost
          deps.log(`[jobs] migration, ${spaceTag(space)}: ${taskTag(task)} left as it is: ${task.why}`)
          continue
        }
        try {
          await applyTask(space, brain, task, task.taskId ? planned.tasks[task.taskId] ?? null : null)
          result[task.outcome] += 1
          if (task.pausedByJob) result.arrivedPaused += 1
          if (task.heldForOk) result.arrivedHeld += 1
          result.jobs.moved += fates.moved
          result.jobs.notMoved += fates.lost + fates.waits
        } catch (err) {
          if (err instanceof ScheduleChangedError) {
            // Not written, and no failure: its jobs stay in the version 1 data, and the next pass plans it again.
            planned.plan.tasks[index] = changedMeanwhile(task)
            result.left += 1
            result.jobs.notMoved += fates.moved + fates.lost + fates.waits
            deps.log(`[jobs] migration, ${spaceTag(space)}: ${taskTag(task)} changed while its jobs were planned: not written, planned again at the next pass`)
            continue
          }
          failed(`${space.name}: "${task.title}": ${(err as Error).message}`, `${spaceTag(space)}: ${taskTag(task)}: ${(err as Error).message}`)
          // Its jobs stay where they are for the next pass: none of them fires meanwhile.
          result.jobs.notMoved += fates.moved + fates.lost + fates.waits
        }
      }
      // The space's report, made once its writes are through: it says what was left alone because it had changed.
      // A space that had no job and nothing left over has nothing to report.
      if (waiting > 0 || (planned.plan.leftovers?.length ?? 0) > 0) result.reports.push(jobMigrationReport(planned.plan, { space: space.name, at: planned.at, dryRun: false }))
    }
    const rest = Object.values(deps.store.pendingV1()?.jobs ?? {})
    const known = new Set(deps.spaces().map(keyOf))
    const homeless = rest.filter((j) => !known.has(j.spaceId ?? null)).length
    if (homeless > 0) failed(`${homeless} job(s) of a space this cockpit no longer has stay as they are`, `${homeless} job(s) of a space this cockpit no longer has stay as they are`)
    // A space no agent is bound to is not looked through yet: it does not count until one is.
    if (looks) result.unlooked = deps.spaces().filter((space) => awaitsLook(space) && !isUnbound(space)).length
    if (hadJobs) deps.log(`[jobs] migration to schedules on tasks: ${result.moved} task(s) moved, ${result.dropped} dropped, ${result.left} left, ${result.failed.length} failed${rest.length ? `; ${rest.length} job(s) wait for the next start` : ''}`)
    await confirmRenames()
    // The report is kept: the first one of this process, then one for every pass that moved or dropped something.
    if (deps.saveReport && result.reports.length > 0 && (!reported || result.moved + result.dropped + result.leftovers > 0)) {
      try {
        result.reportFile = deps.saveReport(runReport(result, new Date(deps.now()).toISOString()))
        reported = true
        deps.log(`[jobs] migration: the report of this run is in ${result.reportFile}`)
        // Nothing is left out silently: a job that does not fire any more, or not yet, is told with where to read why.
        const stale = result.leftovers > 0 ? `, ${result.leftovers} schedule${result.leftovers === 1 ? '' : 's'} without a job removed` : ''
        // A routine that ran before and is paused now is a change the user did not make: said too.
        const paused = result.arrivedPaused > 0 ? `, ${result.arrivedPaused} schedule${result.arrivedPaused === 1 ? '' : 's'} arrived paused` : ''
        // Times that wait for the user's OK do not fire until it is given: said too.
        const held = result.arrivedHeld > 0 ? `, ${result.arrivedHeld} schedule${result.arrivedHeld === 1 ? ' waits' : 's wait'} for your OK` : ''
        if (result.jobs.notMoved + result.leftovers + result.arrivedPaused + result.arrivedHeld > 0) deps.notify?.({ kind: 'review', title: 'Schedules', body: `${MOVED_LINE(result.jobs)}${stale}${paused}${held} — see ${result.reportFile}`, jobId: 'jobs-migration-report', sessionId: null, spaceId: null })
      } catch (err) {
        deps.log(`[jobs] migration: its report could not be written: ${(err as Error).message}`)
      }
    }
    return result
  }

  return {
    /** The channel bridge runs (again): the renames it has not confirmed are told now. */
    confirmRenames,
    /** The pass: every space that has jobs to move, or is still to be looked through. A pass under way is joined, not doubled. */
    run(): Promise<JobMigrationResult> {
      if (!running) running = runOnce().finally(() => { running = null })
      return running
    },
  }
}

export type JobMigration = ReturnType<typeof createJobMigration>
