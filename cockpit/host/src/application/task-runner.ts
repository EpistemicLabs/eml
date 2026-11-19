import type { EmlApi } from '@engramprotocol/mcp-server'
import { taskSystemOn, type BrainSpace } from '../brain-space.js'
import { projectIdForBrain } from '../project-registry.js'

/**
 * The runner (note task-system-phase-1-build-plan, M3): in a space with the
 * task system on, it starts the plan steps that are ready, each in a session
 * of its own.
 *
 * A task is ready when:
 *   - it is planned, has a delegate (the agent that works on it) and a
 *     checkpoint (before · after · none), so plain tasks and legacy tasks are
 *     never started (decision task-assignee-owner-and-agent-delegate);
 *   - as a step (a sub-task), its parent task is active (a parked plan does
 *     not run); a standalone task with a checkpoint needs no parent;
 *   - every task in its depends_on is resolved;
 *   - nobody is waited on (waiting_on), its hand-over can no longer be undone,
 *     and no job of its own will start it at a set time;
 *   - no session works on it already (a worker someone started on it);
 *   - its parent has fewer than MAX_RUNNING steps active; standalone tasks
 *     run at most MAX_RUNNING at a time per space.
 * Starting it marks it active, so it starts once. Its session gets the task
 * from its first hook: checkpoint before prepares and asks before it acts,
 * after acts and hands the result over for review, none runs to the end.
 * Ticks every interval and when a turn ended.
 */

export const MAX_RUNNING = 3
/** The cap group of the standalone tasks with a checkpoint (steps count per parent). */
const STANDALONE = '(standalone)'

export interface TaskRunnerDeps {
  spaces: { list(): BrainSpace[] }
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post'> | null
  /** A session works on this task already (a worker started on it by hand or by a session). */
  busy?(taskId: string): boolean
  /** Its hand-over can still be undone: nothing starts until the undo window is over. */
  held?(taskId: string): boolean
  /** A job of the task will start it at a set time. */
  scheduled?(taskId: string): boolean
  /** What the delegate reads first, e.g. an open question carried over in the hand-over. */
  brief?(taskId: string): string | undefined
  /** Start a session on the step; an error text when it cannot. */
  start(space: BrainSpace, step: { id: string; title: string; content: string; projectId: string; checkpoint: string; brief?: string }): string | null
  log(line: string): void
}

interface Task {
  id: string
  title: string | null
  content: string
  status: string
  scope: string
  properties?: { checkpoint?: string; depends_on?: string[]; assignee_ids?: string[]; delegate?: string; waiting_on?: Record<string, string> }
  relations?: Array<{ source_id: string; target_id: string; relation: string }>
}

const parentOf = (task: Task) => task.relations?.find((r) => r.relation === 'part_of' && r.source_id === task.id)?.target_id ?? null
const childrenOf = (task: Task) => (task.relations ?? []).filter((r) => r.relation === 'part_of' && r.target_id === task.id).map((r) => r.source_id)

/** The prompt a step's session starts with; its task and the rules come with its start hook. */
export function stepPrompt(step: { id: string; title: string; content: string; brief?: string }, checkpoint: string): string {
  const how = checkpoint === 'before'
    ? 'Checkpoint before: prepare everything the step needs, but do not act yet (nothing sent, deployed, published or changed outside drafts). End with a handoff that asks the user for the go as a [lasse] question. Once he gave it and the work is done, close the task.'
    : checkpoint === 'after'
      ? 'Checkpoint after: do the step, then end with a handoff that hands the result over for review, with a [lasse] question asking him to review it. Do NOT close the task yourself: it stays open until the user has reviewed the result and told you it is done; then close it.'
      : 'No checkpoint: do the step to the end on your own and close it; ask only when you cannot go on.'
  return [
    `The task runner started you for "${step.title}" (task ${step.id}).`,
    ...(step.brief ? [step.brief] : []),
    step.content,
    '',
    how,
    'Until the task is done, every wake-up checks its goal: reached, hand the result over; not reached, schedule your next check (schedule tool, task_id of this task) and stop quietly.',
    'Closing means eml_track_task with status resolved and the outcome; end every stop with the handoff.',
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
    const candidates = (listed.engrams ?? []).filter((t) => t.properties?.checkpoint && t.properties.delegate)
    const started = new Map<string, number>()
    for (const candidate of candidates) {
      const step = await get(candidate.id)
      if (!step || step.status !== 'planned') continue
      if (!step.properties?.delegate || step.properties.waiting_on?.who) continue
      if (deps.busy?.(step.id) || deps.held?.(step.id) || deps.scheduled?.(step.id)) continue
      const parentId = parentOf(step)
      // A standalone task with a checkpoint runs on its own; its cap is per space.
      const group = parentId ?? STANDALONE
      if (parentId) {
        const parent = await get(parentId)
        if (!parent || parent.status !== 'active') continue
        if (!started.has(group)) {
          const siblings = await Promise.all(childrenOf(parent).map(get))
          started.set(group, siblings.filter((s) => s?.status === 'active').length)
        }
      } else if (!started.has(group)) {
        const running = await brain.get('/list', { type: 'task', status: 'active', with_parent: 'true', limit: 500 }).catch(() => ({ engrams: [] })) as { engrams?: Array<Task & { parent_id?: string | null }> }
        started.set(group, (running.engrams ?? []).filter((t) => t.properties?.checkpoint && t.properties.delegate && !t.parent_id).length)
      }
      const deps_ = await Promise.all((step.properties?.depends_on ?? []).map(get))
      if (deps_.some((d) => !d || d.status !== 'resolved')) continue
      if (started.get(group)! >= MAX_RUNNING) continue
      const brainProject = step.scope.startsWith('project.') ? step.scope.slice('project.'.length) : null
      if (!brainProject) {
        deps.log(`[runner] step ${step.id.slice(0, 8)} has no project to run in (scope ${step.scope})`)
        continue
      }
      const title = step.title ?? step.id
      const brief = deps.brief?.(step.id)
      const problem = deps.start(space, { id: step.id, title, content: step.content, projectId: projectIdForBrain(brainProject), checkpoint: step.properties!.checkpoint!, ...(brief ? { brief } : {}) })
      if (problem) {
        deps.log(`[runner] step ${step.id.slice(0, 8)} not started: ${problem}`)
        continue
      }
      await brain.post(`/task/${step.id}/track`, { status: 'active', text: 'Started by the task runner.' })
      started.set(group, started.get(group)! + 1)
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
