import * as fs from 'node:fs'
import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace } from '../brain-space.js'
import type { Job } from '../domain/job.js'
import { scheduleOfJob } from '../domain/task-schedule.js'
import { brainIdFromProjectId } from '../project-registry.js'
import { migrationReport, planTaskStateMigration, type MigrationPlan, type MigrationTask } from '../domain/task-state-migration.js'

/**
 * The task state migration of one space (domain/task-state-migration.ts): a dry run that lists every change, and the
 * run that writes them. The run writes only after its owner has seen the dry run (decision task-state-migration-rules:
 * never against the shared brain without it). Each task changes in one track call with one journal line; a job without
 * a task gets one; the snoozes it moved leave this cockpit's store.
 */

export interface TaskStateMigrationDeps {
  space(spaceId: string): BrainSpace | undefined
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post'> | null
  viewer: string
  jobs(): Job[]
  /** Give a job the task made for it. */
  setJobTask(jobId: string, taskId: string): void
  snoozes(): Array<{ key: string; until: string }>
  setSnoozes(snoozes: Array<{ key: string; until: string }>): void
  /** held-waits.json, if a cockpit before 23 left one. */
  heldWaitsFile: string
  liveSessions(spaceId: string): Array<{ sessionId: string; taskId: string }>
  now(): number
  log(line: string): void
}

export interface DryRun { ok: true; plan: MigrationPlan; report: string; at: string }
export type Refusal = { ok: false; refusal: 'unknown_space' | 'no_brain'; message?: string }

const inSpace = (job: Job, space: BrainSpace) => (job.spaceId ?? null) === (space.main ? null : space.id)

export function createTaskStateMigration(deps: TaskStateMigrationDeps) {
  const tasksOf = async (brain: Pick<EmlApi, 'get'>): Promise<MigrationTask[]> => {
    const lists = await Promise.all(['planned', 'active'].map((status) => brain.get('/list', { type: 'task', status, limit: 500 }) as Promise<{ engrams?: Array<MigrationTask & { title: string | null; properties?: MigrationTask['properties'] & { display_title?: string } }> }>))
    return lists.flatMap((l) => l.engrams ?? []).map((t) => ({ ...t, title: t.properties?.display_title ?? t.title ?? t.id }))
  }

  const heldWaitTasks = (): Array<{ taskId: string; count: number }> => {
    try {
      const held = JSON.parse(fs.readFileSync(deps.heldWaitsFile, 'utf8')) as Record<string, unknown>
      return Object.entries(held).filter(([, v]) => Array.isArray(v) && v.length > 0).map(([taskId, v]) => ({ taskId, count: (v as unknown[]).length }))
    } catch {
      return []
    }
  }

  const plan = async (spaceId: string): Promise<DryRun | Refusal> => {
    const space = deps.space(spaceId)
    if (!space) return { ok: false, refusal: 'unknown_space' }
    const brain = deps.brain(space)
    if (!brain) return { ok: false, refusal: 'no_brain' }
    const at = new Date(deps.now()).toISOString()
    const jobs = deps.jobs().filter((j) => inSpace(j, space) && !j.endedAt)
    const timed = jobs.filter((j) => scheduleOfJob(j) !== null)
    const migration = planTaskStateMigration({
      tasks: await tasksOf(brain),
      scheduledTaskIds: new Set(timed.flatMap((j) => (j.taskId ? [j.taskId] : []))),
      snoozes: deps.snoozes(),
      taskless: timed.filter((j) => !j.taskId).map((j) => ({ id: j.id, name: j.name })),
      jobsOnTasks: timed.filter((j) => j.taskId).map((j) => ({ id: j.id, name: j.name, taskId: j.taskId! })),
      heldWaitTasks: heldWaitTasks(),
      liveSessions: deps.liveSessions(space.id),
      viewer: deps.viewer,
      now: at,
    })
    return { ok: true, plan: migration, report: migrationReport(migration, { space: space.name, at }), at }
  }

  return {
    /** The dry run: what the migration would write, nothing written. */
    dryRun: plan,

    /** The run: plans again (the brain may have moved since the dry run) and writes it. */
    async run(spaceId: string): Promise<{ ok: true; written: number; failed: string[]; tasksMade: number; report: string } | Refusal> {
      const planned = await plan(spaceId)
      if (!planned.ok) return planned
      const space = deps.space(spaceId)!
      const brain = deps.brain(space)!
      const failed: string[] = []
      let written = 0
      for (const change of planned.plan.changes) {
        try {
          await brain.post(`/task/${change.taskId}/track`, { ...change.patch, text: `Task state migration (schema 23): ${change.lines.join('; ')}.` })
          written++
        } catch (err) {
          failed.push(`${change.taskId.slice(0, 8)}: ${(err as Error).message}`)
        }
      }
      // The snoozes now on the tasks' waits leave this cockpit's store.
      const moved = new Set(planned.plan.changes.filter((c) => c.rules.includes('snooze') && !failed.some((f) => f.startsWith(c.taskId.slice(0, 8)))).map((c) => c.taskId))
      deps.setSnoozes(deps.snoozes().filter((s) => !moved.has(/^task:([^@]+)@/.exec(s.key)?.[1] ?? '')))
      // A job without a task gets one, with the job's schedule (application/schedule-mirror.ts keeps it in step).
      let tasksMade = 0
      for (const { id } of planned.plan.elsewhere.jobsToTasks) {
        const job = deps.jobs().find((j) => j.id === id)
        if (!job || job.taskId) continue
        const projectId = job.target.type === 'session' ? null : job.target.projectId
        const brainProject = projectId ? brainIdFromProjectId(projectId) : null
        try {
          const made = await brain.post('/engram/task', {
            title: `routine-${job.name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80),
            display_title: job.name.slice(0, 80),
            content: job.prompt.slice(0, 2000),
            scope: brainProject ? `project.${brainProject}` : 'global',
            status: 'active',
            assignee_ids: [deps.viewer],
          }) as { id: string }
          deps.setJobTask(job.id, made.id)
          tasksMade++
        } catch (err) {
          failed.push(`job ${job.id.slice(0, 8)}: ${(err as Error).message}`)
        }
      }
      deps.log(`[migration] ${space.name}: ${written} task(s) changed, ${tasksMade} task(s) made for jobs, ${failed.length} failed`)
      return { ok: true, written, failed, tasksMade, report: planned.report }
    },
  }
}

export type TaskStateMigration = ReturnType<typeof createTaskStateMigration>
