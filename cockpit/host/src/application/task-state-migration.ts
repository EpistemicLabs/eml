import * as fs from 'node:fs'
import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace } from '../brain-space.js'
import { brainIdFromProjectId } from '../project-registry.js'
import { migrationReport, planTaskStateMigration, type MigrationPlan, type MigrationTask } from '../domain/task-state-migration.js'

/**
 * The task state migration of one space (domain/task-state-migration.ts): a dry run that lists every change, and the
 * run that writes them. The run writes only after its owner has seen the dry run (decision task-state-migration-rules:
 * never against the shared brain without it). Each task changes in one track call with one journal line; the snoozes
 * it moved leave this cockpit's store.
 *
 * makeRoutineTask is the one way a schedule without a task gets one: the migration of the jobs of before brain
 * schema 24 uses it (application/job-migration.ts), and the schedule tool for a schedule made without a task.
 */

export interface TaskStateMigrationDeps {
  space(spaceId: string): BrainSpace | undefined
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post'> | null
  viewer: string
  snoozes(): Array<{ key: string; until: string }>
  setSnoozes(snoozes: Array<{ key: string; until: string }>): void
  /** held-waits.json, if a cockpit before 23 left one. */
  heldWaitsFile: string
  liveSessions(spaceId: string): Array<{ sessionId: string; taskId: string }>
  now(): number
  log(line: string): void
}

export interface DryRun { ok: true; plan: MigrationPlan; report: string; at: string; ranBefore: string | null }
export type Refusal = { ok: false; refusal: 'unknown_space' | 'no_brain' | 'in_flight'; message?: string }

/** What a routine's task is made from: a name people read, what a run does, and an id that tells two of one name apart. */
export interface Routine { id: string; name: string; prompt: string }

/** The task a schedule without one gets: its title names it, so a run that is retried finds the task it made before. */
export const routineTitle = (routine: Pick<Routine, 'id' | 'name'>) =>
  `routine-${routine.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}-${routine.id.slice(0, 8)}`

/** The task of a routine as the brain gets it; null when `projectId` is no project of the brain (a task belongs to one). */
export function routineTask(routine: Routine, projectId: string | null, owner: string): { title: string; display_title: string; content: string; scope: string; status: 'active'; assignee_ids: string[] } | null {
  const brainProject = projectId ? brainIdFromProjectId(projectId) : null
  if (!brainProject) return null
  return {
    title: routineTitle(routine),
    display_title: routine.name.slice(0, 80),
    content: routine.prompt.slice(0, 2000),
    scope: `project.${brainProject}`,
    status: 'active',
    assignee_ids: [owner],
  }
}

/** Make the routine's task, or find the one an earlier try made (by its title); `made` says which. */
export async function makeRoutineTask(brain: Pick<EmlApi, 'get' | 'post'>, task: NonNullable<ReturnType<typeof routineTask>>): Promise<{ id: string; made: boolean }> {
  const before = await brain.get('/list', { type: 'task', title: task.title, limit: 1 }) as { engrams?: Array<{ id: string }> }
  if (before.engrams?.[0]) return { id: before.engrams[0].id, made: false }
  const made = await brain.post('/engram/task', task) as { id: string }
  return { id: made.id, made: true }
}

/**
 * The note the first run leaves in the space's brain. A second run (a retry, another member's cockpit on a shared
 * space) reads it and gives no start requests: by then the tasks the migration gave a checkpoint look like ones the
 * runner used to start.
 */
export const MIGRATION_MARKER = 'task-state-migration-v23'

export function createTaskStateMigration(deps: TaskStateMigrationDeps) {
  /** Spaces a run is writing to now: a second run waits for it (409 in_flight), it never runs beside it. */
  const running = new Set<string>()

  const tasksOf = async (brain: Pick<EmlApi, 'get'>): Promise<MigrationTask[]> => {
    const lists = await Promise.all(['planned', 'active'].map((status) => brain.get('/list', { type: 'task', status, limit: 500 }) as Promise<{ engrams?: Array<MigrationTask & { title: string | null; properties?: MigrationTask['properties'] & { display_title?: string } }> }>))
    return lists.flatMap((l) => l.engrams ?? []).map((t) => ({ ...t, title: t.properties?.display_title ?? t.title ?? t.id }))
  }

  /** When the migration ran in this space before, from its marker; null when it has not. */
  const ranBefore = async (brain: Pick<EmlApi, 'get'>): Promise<string | null> => {
    const found = await brain.get('/list', { type: 'note', title: MIGRATION_MARKER, limit: 1 }) as { engrams?: Array<{ created_at?: string }> }
    const marker = found.engrams?.[0]
    return marker ? (marker.created_at ?? 'an earlier date') : null
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
    const before = await ranBefore(brain)
    const migration = planTaskStateMigration({
      tasks: await tasksOf(brain),
      snoozes: deps.snoozes(),
      heldWaitTasks: heldWaitTasks(),
      liveSessions: deps.liveSessions(space.id),
      viewer: deps.viewer,
      now: at,
      ranBefore: before,
    })
    return { ok: true, plan: migration, report: migrationReport(migration, { space: space.name, at, ranBefore: before }), at, ranBefore: before }
  }

  return {
    /** The dry run: what the migration would write, nothing written. */
    dryRun: plan,

    /** The run: plans again (the brain may have moved since the dry run) and writes it. */
    async run(spaceId: string): Promise<{ ok: true; written: number; failed: string[]; report: string } | Refusal> {
      if (running.has(spaceId)) return { ok: false, refusal: 'in_flight', message: 'A migration of this space is running; try again when it is done.' }
      running.add(spaceId)
      try {
        return await runOnce(spaceId)
      } finally {
        running.delete(spaceId)
      }
    },
  }

  /**
   * One run. Safe to retry: it plans again from the brain, so a change already written is not planned twice.
   */
  async function runOnce(spaceId: string): Promise<{ ok: true; written: number; failed: string[]; report: string } | Refusal> {
      const planned = await plan(spaceId)
      if (!planned.ok) return planned
      const space = deps.space(spaceId)!
      const brain = deps.brain(space)!
      // The marker first: a retry after a failure part-way plans without requests, so it never starts a task this
      // run gave a checkpoint. A task whose request failed shows "Hand to <agent>" on the board instead.
      if (!planned.ranBefore) {
        await brain.post('/engram/note', {
          title: MIGRATION_MARKER,
          scope: 'global',
          content: `The cockpit's task state migration (brain schema 23) ran in this space on ${planned.at}, by ${deps.viewer}. A second run gives no start requests.`,
        })
      }
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
      deps.log(`[migration] ${space.name}: ${written} task(s) changed, ${failed.length} failed`)
      return { ok: true, written, failed, report: planned.report }
  }
}

export type TaskStateMigration = ReturnType<typeof createTaskStateMigration>
