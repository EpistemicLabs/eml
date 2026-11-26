import { EmlApiError, type EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace } from '../brain-space.js'
import type { Job } from '../domain/job.js'
import type { JobV1 } from '../domain/job-v1.js'
import { jobFates, jobMigrationReport, planJobMigration, stepOf, type JobMigrationPlan, type JobMigrationTask, type NewRoutineTask, type TaskMigration } from '../domain/job-migration.js'
import type { NotificationInput } from '../notifications.js'
import type { JobStore } from '../job-store.js'
import { makeRoutineTask, routineTask } from './task-state-migration.js'
import { writeTaskSchedule } from './task-schedule-write.js'

/**
 * The migration of jobs.json version 1 to version 2, written (domain/job-migration.ts plans it): one pass at the
 * host's start, once the brains are at schema 24. Per space it reads the tasks of the version 1 jobs, plans, and
 * writes task by task: the brain first (the schedule, the text, the journal, in one call through
 * application/task-schedule-write.ts), then the store (the record in, the jobs out of the version 1 data), then the
 * sessions of those jobs move to the record in the ledger.
 *
 * The version 1 file is copied next to itself before it is rewritten for the first time (job-store.ts). The report
 * of each real run is appended to a file next to it, and the user is told when a job did not move. The pass is
 * safe to run again: a job that moved is no longer in the version 1 data, so a second start finds nothing; a task
 * whose write failed, and a space whose brain did not answer, keep their jobs there for the next start. A crash
 * between a task's brain write and its store write plans that one task again: its schedule and text are found as
 * they should be and are not written twice; only its journal lines repeat.
 *
 * A brain that is not at schema 24 yet refuses the new schedule shape: that task's write fails and its jobs wait.
 * A space the brain server has not said the kind of (shared or local) is not planned at all: its jobs wait too.
 */

export interface JobMigrationDeps {
  store: Pick<JobStore<Job>, 'pendingV1' | 'migrateV1'>
  spaces(): BrainSpace[]
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post'> | null
  /**
   * Whether the space is shared, asked of the brain server again when the host does not know it yet (space.shared is
   * null); null: still not known. A space of unknown kind is not planned: whose cockpit fires a task depends on it.
   */
  spaceKind?(space: BrainSpace): Promise<boolean | null>
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
  /** Tell the user (notifications.ts, as the engine tells a paused schedule): a run in which a job did not move. */
  notify?(input: NotificationInput): void
}

export interface SpacePlan { space: BrainSpace; plan: JobMigrationPlan; report: string }
export interface JobMigrationResult {
  /** Tasks, by what became of them. */
  moved: number
  dropped: number
  left: number
  failed: string[]
  reports: string[]
  /** Jobs: those that go on firing on their task, and those that do not (left out, dropped while live, or still waiting). Jobs that were over do not count. */
  jobs: { moved: number; notMoved: number }
  /** Where this run's report was kept; null: none was written (nothing was planned, nothing changed since the last one, or it failed). */
  reportFile: string | null
}

/** What a real run appends to the report file: its date, the count by job, what was not done, and each space's report. */
export function runReport(result: Pick<JobMigrationResult, 'jobs' | 'failed' | 'reports'>, at: string): string {
  const notDone = result.failed.length > 0 ? `Not done in this run:\n${result.failed.map((line) => `- ${line}`).join('\n')}\n\n` : ''
  return `# Run of ${at}\n\n${MOVED_LINE(result.jobs)}.\n\n${notDone}${result.reports.join('\n')}\n`
}

const MOVED_LINE = (jobs: JobMigrationResult['jobs']) => `Schedules moved onto their tasks: ${jobs.moved} moved, ${jobs.notMoved} not moved`

const keyOf = (space: BrainSpace): string | null => (space.main ? null : space.id)

/** The routine task a job without a task gets, in the project its sessions start in. */
export const routineTaskOfJob = (me: string) => (job: JobV1): NewRoutineTask | null =>
  routineTask({ id: job.id, name: job.name, prompt: job.prompt }, job.target.type === 'session' ? null : job.target.projectId, me)

/** The tasks the space's jobs name, as its brain has them; null for one the brain does not have. Any other failure throws. */
export async function tasksOfJobs(brain: Pick<EmlApi, 'get'>, jobs: readonly JobV1[]): Promise<Record<string, JobMigrationTask | null>> {
  const tasks: Record<string, JobMigrationTask | null> = {}
  for (const id of new Set(jobs.flatMap((j) => (j.taskId ? [j.taskId] : [])))) {
    try {
      const found = await brain.get(`/engram/${encodeURIComponent(id)}`) as JobMigrationTask & { type?: string }
      tasks[id] = found && (found.type === undefined || found.type === 'task') ? found : null
    } catch (err) {
      if (err instanceof EmlApiError && err.status === 404) tasks[id] = null
      else throw err
    }
  }
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

export function createJobMigration(deps: JobMigrationDeps) {
  let running: Promise<JobMigrationResult> | null = null
  /** A report of this process is in the file: a later pass adds one only when it changed something. */
  let reported = false

  /** Shared, local, or null: not known yet (asked again each time). */
  const kindOf = async (space: BrainSpace): Promise<boolean | null> =>
    space.shared ?? (deps.spaceKind ? await deps.spaceKind(space).catch(() => null) : null)

  /** The plan of one space, from the version 1 data and the brain as they are now. Nothing is written. */
  const planSpace = async (space: BrainSpace, brain: Pick<EmlApi, 'get'>, dryRun: boolean): Promise<SpacePlan | null> => {
    const pending = deps.store.pendingV1()
    const jobs = Object.values(pending?.jobs ?? {})
    const mine = jobs.filter((j) => (j.spaceId ?? null) === keyOf(space))
    if (!pending || mine.length === 0) return null
    const now = deps.now()
    const shared = await kindOf(space)
    const plan = planJobMigration({
      jobs, runs: pending.runs, keys: pending.keys, space: { key: keyOf(space), name: space.name, shared },
      // Only a shared space has other members whose tasks are not this cockpit's.
      members: shared === true ? await membersOf(brain) : null,
      tasks: await tasksOfJobs(brain, mine), me: deps.me, now, routineTaskOf: routineTaskOfJob(deps.me),
    })
    return { space, plan, report: jobMigrationReport(plan, { space: space.name, at: new Date(now).toISOString(), dryRun }) }
  }

  const applyTask = async (space: BrainSpace, brain: Pick<EmlApi, 'get' | 'post'>, task: TaskMigration): Promise<void> => {
    let taskId = task.taskId
    if (task.create) taskId = (await makeRoutineTask(brain, task.create)).id
    if (task.brain && taskId) {
      const text = task.brain.journal.join(' ')
      const fields = task.brain.content !== null ? { content: task.brain.content } : {}
      if (task.brain.setSchedule) await writeTaskSchedule(brain, taskId, task.schedule, { agent: space.agent, text, fields })
      else if (text || task.brain.content !== null) await brain.post(`/task/${encodeURIComponent(taskId)}/track`, { ...fields, ...(text ? { text } : {}) })
    }
    const step = stepOf(task, taskId)
    deps.store.migrateV1(step)
    if (step.record) for (const jobId of task.renamed) deps.moveSessions(jobId, step.record.id)
  }

  const runOnce = async (): Promise<JobMigrationResult> => {
    const result: JobMigrationResult = { moved: 0, dropped: 0, left: 0, failed: [], reports: [], jobs: { moved: 0, notMoved: 0 }, reportFile: null }
    if (!deps.store.pendingV1()) return result
    for (const space of deps.spaces()) {
      const brain = deps.brain(space)
      const waiting = Object.values(deps.store.pendingV1()?.jobs ?? {}).filter((j) => (j.spaceId ?? null) === keyOf(space)).length
      if (waiting === 0) continue
      if (!brain) {
        result.failed.push(`${space.name}: no brain to ask, its ${waiting} job(s) wait`)
        result.jobs.notMoved += waiting
        continue
      }
      // Whose cockpit fires a task depends on the space's kind: not known, nothing of it is planned, and it waits.
      if (await kindOf(space) === null) {
        result.failed.push(`${space.name}: ${KIND_UNKNOWN}, its ${waiting} job(s) wait`)
        result.jobs.notMoved += waiting
        continue
      }
      let planned: SpacePlan | null
      try {
        planned = await planSpace(space, brain, false)
      } catch (err) {
        result.failed.push(`${space.name}: its brain did not answer (${(err as Error).message}), its ${waiting} job(s) wait`)
        result.jobs.notMoved += waiting
        continue
      }
      if (!planned) continue
      result.reports.push(planned.report)
      for (const task of planned.plan.tasks) {
        const fates = jobFates({ tasks: [task] })
        if (task.outcome === 'left') {
          result.left += 1
          result.jobs.notMoved += fates.waits + fates.lost
          deps.log(`[jobs] migration, ${space.name}: "${task.title}" left as it is: ${task.why}`)
          continue
        }
        try {
          await applyTask(space, brain, task)
          result[task.outcome] += 1
          result.jobs.moved += fates.moved
          result.jobs.notMoved += fates.lost + fates.waits
        } catch (err) {
          result.failed.push(`${space.name}: "${task.title}": ${(err as Error).message}`)
          // Its jobs stay where they are for the next pass: none of them fires meanwhile.
          result.jobs.notMoved += fates.moved + fates.lost + fates.waits
        }
      }
    }
    const rest = Object.values(deps.store.pendingV1()?.jobs ?? {})
    const known = new Set(deps.spaces().map(keyOf))
    const homeless = rest.filter((j) => !known.has(j.spaceId ?? null)).length
    if (homeless > 0) result.failed.push(`${homeless} job(s) of a space this cockpit no longer has stay as they are`)
    deps.log(`[jobs] migration to schedules on tasks: ${result.moved} task(s) moved, ${result.dropped} dropped, ${result.left} left, ${result.failed.length} failed${rest.length ? `; ${rest.length} job(s) wait for the next start` : ''}`)
    for (const line of result.failed) deps.log(`[jobs] migration: ${line}`)
    // The report is kept: the first one of this process, then one for every pass that moved or dropped something.
    if (deps.saveReport && result.reports.length > 0 && (!reported || result.moved + result.dropped > 0)) {
      try {
        result.reportFile = deps.saveReport(runReport(result, new Date(deps.now()).toISOString()))
        reported = true
        deps.log(`[jobs] migration: the report of this run is in ${result.reportFile}`)
        // Nothing is left out silently: a job that does not fire any more, or not yet, is told with where to read why.
        if (result.jobs.notMoved > 0) deps.notify?.({ kind: 'review', title: 'Schedules', body: `${MOVED_LINE(result.jobs)} — see ${result.reportFile}`, jobId: 'jobs-migration-report', sessionId: null, spaceId: null })
      } catch (err) {
        deps.log(`[jobs] migration: its report could not be written: ${(err as Error).message}`)
      }
    }
    return result
  }

  return {
    /** Version 1 jobs wait to be moved. */
    pending: (): boolean => deps.store.pendingV1() !== null,
    /**
     * The dry run of one space: its plan and report, nothing written; null when it has no job to move or no brain.
     * A space whose kind is not known plans every job as left, and says why.
     */
    async dryRun(space: BrainSpace): Promise<SpacePlan | null> {
      const brain = deps.brain(space)
      return brain ? planSpace(space, brain, true) : null
    },
    /** The pass: every space that has jobs to move. A pass under way is joined, not doubled. */
    run(): Promise<JobMigrationResult> {
      if (!running) running = runOnce().finally(() => { running = null })
      return running
    },
  }
}

export type JobMigration = ReturnType<typeof createJobMigration>
