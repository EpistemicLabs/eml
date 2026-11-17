import type { EmlApi } from '@engramprotocol/mcp-server'
import { taskSystemOn, type BrainSpace } from '../brain-space.js'
import { projectIdForBrain } from '../project-registry.js'

/**
 * The runner (note task-system-phase-1-build-plan, M3): in a space with the
 * task system on, it starts the plan steps that are ready, each in a session
 * of its own.
 *
 * A step is ready when:
 *   - it is a planned sub-task with a checkpoint (before · after · none), so
 *     plain sub-tasks and legacy tasks are never started;
 *   - its parent task is active (a parked plan does not run);
 *   - every task in its depends_on is resolved;
 *   - nobody is assigned to it as a person (a person's step waits for them);
 *   - its parent has fewer than MAX_RUNNING steps active.
 * Starting it marks it active, so it starts once. Its session gets the task
 * from its first hook: checkpoint before prepares and asks before it acts,
 * after acts and hands the result over for review, none runs to the end.
 * Ticks every interval and when a turn ended.
 */

export const MAX_RUNNING = 3

export interface TaskRunnerDeps {
  spaces: { list(): BrainSpace[] }
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post'> | null
  /** Handles of people: a step assigned to one of them is theirs, not a session's. */
  people(space: BrainSpace): string[]
  /** Start a session on the step; an error text when it cannot. */
  start(space: BrainSpace, step: { id: string; title: string; content: string; projectId: string; checkpoint: string }): string | null
  log(line: string): void
}

interface Task {
  id: string
  title: string | null
  content: string
  status: string
  scope: string
  properties?: { checkpoint?: string; depends_on?: string[]; assignee_ids?: string[] }
  relations?: Array<{ source_id: string; target_id: string; relation: string }>
}

const parentOf = (task: Task) => task.relations?.find((r) => r.relation === 'part_of' && r.source_id === task.id)?.target_id ?? null
const childrenOf = (task: Task) => (task.relations ?? []).filter((r) => r.relation === 'part_of' && r.target_id === task.id).map((r) => r.source_id)

/** The prompt a step's session starts with; its task and the rules come with its start hook. */
export function stepPrompt(step: { id: string; title: string; content: string }, checkpoint: string): string {
  const how = checkpoint === 'before'
    ? 'Checkpoint before: prepare everything the step needs, but do not act yet (nothing sent, deployed, published or changed outside drafts). End with a handoff that asks the user for the go as a [lasse] question.'
    : checkpoint === 'after'
      ? 'Checkpoint after: do the step, then end with a handoff that hands the result over for review.'
      : 'No checkpoint: do the step to the end on your own; ask only when you cannot go on.'
  return [
    `The task runner started you for the step "${step.title}" (task ${step.id}).`,
    step.content,
    '',
    how,
    `When the step is done, close it with eml_track_task (status resolved, outcome) and end with the handoff.`,
  ].join('\n')
}

export interface TaskRunner {
  tick(): Promise<void>
  /** Ticks every `ms`; returns the stop. */
  every(ms: number): () => void
}

export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  let running: Promise<void> | null = null

  const runSpace = async (space: BrainSpace, brain: Pick<EmlApi, 'get' | 'post'>) => {
    const tasks = new Map<string, Promise<Task | null>>()
    const get = (id: string) => {
      if (!tasks.has(id)) tasks.set(id, (brain.get(`/engram/${id}`, { with_relations: 'true' }) as Promise<Task>).catch(() => null))
      return tasks.get(id)!
    }
    const listed = await brain.get('/list', { type: 'task', status: 'planned', limit: 200 }) as { engrams?: Task[] }
    const candidates = (listed.engrams ?? []).filter((t) => t.properties?.checkpoint)
    const people = new Set(deps.people(space))
    const started = new Map<string, number>()
    for (const candidate of candidates) {
      const step = await get(candidate.id)
      if (!step || step.status !== 'planned') continue
      if ((step.properties?.assignee_ids ?? []).some((who) => people.has(who))) continue
      const parentId = parentOf(step)
      if (!parentId) continue
      const parent = await get(parentId)
      if (!parent || parent.status !== 'active') continue
      const deps_ = await Promise.all((step.properties?.depends_on ?? []).map(get))
      if (deps_.some((d) => !d || d.status !== 'resolved')) continue
      if (!started.has(parentId)) {
        const siblings = await Promise.all(childrenOf(parent).map(get))
        started.set(parentId, siblings.filter((s) => s?.status === 'active').length)
      }
      if (started.get(parentId)! >= MAX_RUNNING) continue
      const brainProject = step.scope.startsWith('project.') ? step.scope.slice('project.'.length) : null
      if (!brainProject) {
        deps.log(`[runner] step ${step.id.slice(0, 8)} has no project to run in (scope ${step.scope})`)
        continue
      }
      const title = step.title ?? step.id
      const problem = deps.start(space, { id: step.id, title, content: step.content, projectId: projectIdForBrain(brainProject), checkpoint: step.properties!.checkpoint! })
      if (problem) {
        deps.log(`[runner] step ${step.id.slice(0, 8)} not started: ${problem}`)
        continue
      }
      await brain.post(`/task/${step.id}/track`, { status: 'active', text: 'Started by the task runner.' })
      started.set(parentId, started.get(parentId)! + 1)
      deps.log(`[runner] started step ${step.id.slice(0, 8)} ${title} (checkpoint ${step.properties?.checkpoint})`)
    }
  }

  const tickOnce = async () => {
    for (const space of deps.spaces.list()) {
      if (!taskSystemOn(space)) continue
      const brain = deps.brain(space)
      if (!brain) continue
      try {
        await runSpace(space, brain)
      } catch (err) {
        deps.log(`[runner] ${space.name}: ${(err as Error).message}`)
      }
    }
  }

  const runner: TaskRunner = {
    // One tick at a time: a tick asked for while one runs waits for it, then runs once.
    async tick() {
      while (running) await running
      running = tickOnce().finally(() => { running = null })
      return running
    },
    every(ms) {
      const timer = setInterval(() => { void runner.tick() }, ms)
      timer.unref?.()
      return () => clearInterval(timer)
    },
  }
  return runner
}
