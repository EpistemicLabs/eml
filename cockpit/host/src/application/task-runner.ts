import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace } from '../brain-space.js'
import { MAX_RUNNING, holdsSlot, isStandaloneRunnerTask, newestStart, runnerBlock } from '../domain/runner-gate.js'
import { openRunsByTask, runsOf, type RunFacts } from '../domain/runs.js'
import { lastStartsOf, requestOpen, type DelegationFields } from '../domain/delegation.js'
import { nextRunOfSchedule } from '../domain/task-schedule.js'
import { childrenOf, parentOf } from '../domain/task-relations.js'
import { projectIdForBrain } from '../project-registry.js'
import { CHECKPOINT_STOP } from '../domain/turn-end.js'
import type { ResumeOutcome } from './continue-session.js'

/**
 * The runner (note task-system-phase-1-build-plan, M3): in every space it
 * starts the plan steps that are ready, each in a session of its own.
 *
 * A task is ready when:
 *   - it has a delegation with a checkpoint (before · after · none) and an
 *     open request: no run on it started after delegation.requested_at
 *     (domain/delegation.ts). Its status is planned or active: it never goes
 *     back to planned to start again;
 *   - as a step (a sub-task), its parent task is active (a parked plan does
 *     not run); a standalone task with a checkpoint needs no parent;
 *   - every task in its depends_on is resolved;
 *   - nobody is waited on (waiting_on), its hand-over can no longer be undone,
 *     and no job of its own will start it at a set time;
 *   - no session works on it already (a worker someone started on it);
 *   - in a shared space, this cockpit's member owns it (domain/task-owner.ts):
 *     each member's cockpit starts its own member's steps;
 *   - its parent has fewer than MAX_RUNNING steps that hold a slot; standalone
 *     tasks hold at most MAX_RUNNING per space. A slot is held by a task this
 *     cockpit runs with a session working on it, or one it just started
 *     (domain/runner-gate.ts holdsSlot).
 * The checks live in domain/runner-gate.ts, which the task board asks too, so the board names the same reason.
 * Starting it marks a planned one active; the request counts as started here
 * at once and in the brain once the session's run is written. A task with an
 * own open session (domain/own-session.ts) is not started in a new one: that
 * session gets the start prompt and a run of its own from then
 * (application/run-records.ts), which closes the request the same way. Its session gets the task
 * from its first hook: checkpoint before prepares and asks before it acts,
 * after acts and hands the result over for review, none runs to the end.
 * Ticks every interval and when a turn ended.
 */

export { MAX_RUNNING }
/** The cap group of the standalone tasks with a checkpoint (steps count per parent). */
const STANDALONE = '(standalone)'

export interface TaskRunnerDeps {
  spaces: { list(): BrainSpace[] }
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post'> | null
  /** This cockpit's member (the config handle): in a shared space it starts only their steps. */
  me: string
  /** A session works on this task already (a worker started on it by hand or by a session), here or in another member's run. */
  busy?(taskId: string, runs: readonly RunFacts[]): boolean
  /** A session works on this task right now: one of this cockpit's sessions is in a turn, or another cockpit's run on it is working. */
  working?(taskId: string, runs: readonly RunFacts[]): boolean
  /**
   * Its hand-over can still be undone (nothing starts until the undo window is over), or a worker is about to start on
   * it (application/worker-task.ts, keyed on its request's time until its id is known).
   */
  held?(taskId: string, requestedAt?: string | null): boolean
  /** A job of the task will start it at a set time. */
  scheduled?(taskId: string): boolean
  /** What the delegate reads first, e.g. an open question carried over in the hand-over. */
  brief?(taskId: string): string | undefined
  /** The open question the hand-over carried, for a continued session's own brief. */
  question?(taskId: string): string | undefined
  /** Start a session on the step; an error text when it cannot. */
  start(space: BrainSpace, step: RunnerStep): string | null
  /**
   * The task's own session that the step's start prompt goes to instead of a new session (domain/own-session.ts
   * sessionToContinue), or null to start one.
   */
  ownSession?(taskId: string): string | null
  /** A session of the task was continued for this request already (application/continue-session.ts continuedFor). */
  continuedFor?(taskId: string, requestedAt: string): boolean
  /**
   * Give that session the step's start prompt and start its run for this request: continued, retry next tick (it is
   * busy: nothing starts beside it), or fall back to a new session (it cannot be reached).
   */
  resume?(sessionId: string, step: RunnerStep): Promise<ResumeOutcome>
  log(line: string): void
}

/** `question`: an open question the hand-over carried; a continued session reads its own brief about it (application/continue-session.ts). */
export interface RunnerStep { id: string; title: string; content: string; projectId: string; checkpoint: string; brief?: string; question?: string }

interface Task {
  id: string
  title: string | null
  content: string
  status: string
  scope: string
  ingested_by?: string | null
  properties?: { checkpoint?: string; depends_on?: string[]; assignee_ids?: string[]; delegate?: string; delegation?: DelegationFields; waiting_on?: Record<string, string> }
  relations?: Array<{ source_id: string; target_id: string; relation: string }>
}

/**
 * Decision task-closing-and-continuation-rules: an agent hands finished work over for review and
 * closes a task with a checkpoint only on its owner's explicit word. Code is ready for review only
 * once it runs in the owner's cockpit, not when its PR is open or merged.
 */
export const CLOSING_RULE = 'Never close the task yourself: its owner reviews the result and closes it. Close it only when the owner explicitly tells you in this chat to close it. Code work is ready for review only once it runs in the user\'s cockpit (merged, released and installed), not when its PR is open or merged.'

/**
 * The prompt a step's session starts with (or, `continued`, the one its own session carries on with); its task, the rules, how a turn ends and what happens until it is done come
 * with its start hook. A job's prompt (ofJob) never tells the run to close the task: its run header carries the rule
 * (domain/job.ts JOB_TASK_RULE).
 */
export function stepPrompt(step: { id: string; title: string; content: string; brief?: string; startedBy?: string; ofJob?: boolean; continued?: boolean }, checkpoint: string): string {
  const how = checkpoint === 'before'
    ? `Checkpoint before: prepare everything the step needs, but do not act yet (nothing sent, deployed, published or changed outside drafts). ${CHECKPOINT_STOP.before}`
    : checkpoint === 'after'
      ? `Checkpoint after: ${CHECKPOINT_STOP.after[0].toLowerCase()}${CHECKPOINT_STOP.after.slice(1)}`
      : step.ofJob
        ? 'No checkpoint: do this run to the end on your own; ask only when you cannot go on.'
        : 'No checkpoint: do the step to the end on your own and close it; ask only when you cannot go on.'
  const reviewed = checkpoint === 'before' || checkpoint === 'after'
  return [
    // A session that already works on the task (domain/own-session.ts) carries on; any other one starts on it.
    step.continued
      ? `The owner delegated "${step.title}" (task ${step.id}) to you: carry on with it on your own from where this conversation stands.`
      : `${step.startedBy ?? 'The task runner'} started you for "${step.title}" (task ${step.id}).`,
    ...(step.brief ? [step.brief] : []),
    step.content,
    '',
    how,
    ...(reviewed ? [CLOSING_RULE] : []),
    ...(reviewed
      ? ['Closing, once the owner told you to: eml_track_task with status resolved and the outcome.']
      : step.ofJob ? [] : ['Closing means eml_track_task with status resolved and the outcome.']),
  ].join('\n')
}

export interface TaskRunner {
  tick(): Promise<void>
  /** When this runner last started the task (epoch ms), or null: its slot counts from then, before its run is in the brain. */
  startedAt(taskId: string): number | null
  /** Ticks every `ms`; returns the stop. */
  every(ms: number): () => void
}

export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  let running: Promise<void> | null = null
  /** Per task, the request this runner started a session for: once, even before the session's run is in the brain. */
  const startedFor = new Map<string, string>()
  /** Per task, when this runner started its session. */
  const startedAt = new Map<string, number>()
  const requestOf = (t: Task) => t.properties?.delegation?.requested_at ?? `planned:${t.id}`

  const runSpace = async (space: BrainSpace, brain: Pick<EmlApi, 'get' | 'post'>) => {
    const tasks = new Map<string, Promise<Task | null>>()
    const get = (id: string) => {
      if (!tasks.has(id)) tasks.set(id, (brain.get(`/engram/${id}`, { with_relations: 'true' }) as Promise<Task>).catch(() => null))
      return tasks.get(id)!
    }
    // A delegation's request starts a task whatever its status (domain/delegation.ts): planned and active ones are candidates.
    const [planned, active] = await Promise.all(['planned', 'active'].map((status) => brain.get('/list', { type: 'task', status, limit: 200 }) as Promise<{ engrams?: Task[] }>))
    const listed = { engrams: [...(planned.engrams ?? []), ...(active.engrams ?? [])] }
    const lastStarts = lastStartsOf(((await brain.get('/object/run', { latest: 'true' }).catch(() => ({ objects: [] }))) as { objects?: Array<Record<string, unknown>> }).objects ?? [])
    // The space's open runs, read once per tick: a working run of another member's session holds its task (domain/runs.ts).
    const runs = openRunsByTask(runsOf(((await brain.get('/object/run').catch(() => ({ objects: [] }))) as { objects?: Array<Record<string, unknown>> }).objects ?? []))
    // A request counts as started once a session was continued for it, as the ledger keeps it, before its run is written.
    const continued = (t: Task) => Boolean(t.properties?.delegation?.requested_at && deps.continuedFor?.(t.id, t.properties.delegation.requested_at))
    const candidates = (listed.engrams ?? []).filter((t) => requestOpen(t, lastStarts.get(t.id) ?? null) && startedFor.get(t.id) !== requestOf(t) && !continued(t))
    const started = new Map<string, number>()
    const now = Date.now()
    // A task holds a slot while an agent works on it for this cockpit (domain/runner-gate.ts), as the board counts it.
    const slotHeld = (t: Task) => holdsSlot(t, {
      working: deps.working?.(t.id, runs.get(t.id) ?? []) ?? false,
      startedAt: newestStart(startedAt.get(t.id), lastStarts.get(t.id)),
    }, { shared: space.shared, me: deps.me, now })
    for (const candidate of candidates) {
      const step = await get(candidate.id)
      if (!step || !requestOpen(step, lastStarts.get(step.id) ?? null)) continue
      const parentId = parentOf(step)
      // A standalone task with a checkpoint runs on its own; its cap is per space.
      const group = parentId ?? STANDALONE
      const parent = parentId ? await get(parentId) : undefined
      if (!started.has(group)) {
        if (parent) {
          const siblings = await Promise.all(childrenOf(parent).map(get))
          started.set(group, siblings.filter((s): s is Task => s !== null && slotHeld(s)).length)
        } else if (!parentId) {
          const running = await brain.get('/list', { type: 'task', status: 'active', with_parent: 'true', limit: 500 }).catch(() => ({ engrams: [] })) as { engrams?: Array<Task & { parent_id?: string | null }> }
          started.set(group, (running.engrams ?? []).filter((t) => isStandaloneRunnerTask(t) && slotHeld(t)).length)
        }
      }
      const dependsOn = step.properties?.depends_on ?? []
      const block = runnerBlock({
        task: step,
        ...(parentId ? { parent: { id: parentId, task: parent ?? null } } : {}),
        deps: await Promise.all(dependsOn.map(async (id) => ({ id, task: await get(id) }))),
        running: started.get(group) ?? 0,
        shared: space.shared, me: deps.me,
        lastRunStartedAt: lastStarts.get(step.id) ?? null,
        busy: deps.busy?.(step.id, runs.get(step.id) ?? []), held: deps.held?.(step.id, step.properties?.delegation?.requested_at ?? null),
        // A job here, or a schedule in its delegation, starts it at its time (domain/task-schedule.ts).
        scheduled: deps.scheduled?.(step.id) || Boolean(nextRunOfSchedule(step.properties?.delegation?.schedule, Date.now())),
      })
      if (block?.kind === 'no_project') deps.log(`[runner] step ${step.id.slice(0, 8)} has no project to run in (scope ${step.scope})`)
      if (block) continue
      const brainProject = step.scope.slice('project.'.length)
      const title = step.title ?? step.id
      const brief = deps.brief?.(step.id)
      const question = deps.question?.(step.id)
      const runnerStep: RunnerStep = { id: step.id, title, content: step.content, projectId: projectIdForBrain(brainProject), checkpoint: step.properties!.checkpoint!, ...(brief ? { brief } : {}), ...(question ? { question } : {}) }
      // The task's own session carries on with the start prompt; one that does not take it falls back to a new session.
      const own = deps.resume ? deps.ownSession?.(step.id) ?? null : null
      let resumed: ResumeOutcome | null = null
      try {
        resumed = own ? await deps.resume!(own, runnerStep) : null
      } catch (err) {
        // A delivery that throws leaves this task for the next tick; the other candidates still run.
        deps.log(`[runner] step ${step.id.slice(0, 8)} not continued in session ${own!.slice(0, 8)}: ${(err as Error).message}`)
        continue
      }
      if (resumed && resumed.kind !== 'continued') deps.log(`[runner] step ${step.id.slice(0, 8)} not continued in session ${own!.slice(0, 8)}: ${resumed.why}`)
      if (resumed?.kind === 'retry') continue
      const continued = resumed?.kind === 'continued'
      const problem = continued ? null : deps.start(space, runnerStep)
      if (problem) {
        deps.log(`[runner] step ${step.id.slice(0, 8)} not started: ${problem}`)
        continue
      }
      // Its run is written once the session runs (application/run-records.ts); until then this request counts as started here.
      startedFor.set(step.id, requestOf(step))
      startedAt.set(step.id, Date.now())
      await brain.post(`/task/${step.id}/track`, { ...(step.status === 'planned' ? { status: 'active' } : {}), text: continued ? 'Continued in its own session by the task runner.' : 'Started by the task runner.' })
      started.set(group, started.get(group)! + 1)
      deps.log(`[runner] ${continued ? `continued step ${step.id.slice(0, 8)} in session ${own!.slice(0, 8)}` : `started step ${step.id.slice(0, 8)}`} ${title} (checkpoint ${step.properties?.checkpoint})`)
    }
  }

  const tickOnce = async () => {
    for (const space of deps.spaces.list()) {
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
    startedAt: (taskId) => startedAt.get(taskId) ?? null,
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
