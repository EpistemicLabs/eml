import * as fs from 'node:fs'
import * as path from 'node:path'
import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace } from '../brain-space.js'
import { planHandOver, planUndo, type HandOverRefusal, type HandOverRequest, type HandOverTask, type ScheduleSpec } from '../domain/hand-over.js'
import type { Snooze } from '../domain/inbox.js'
import type { WaitingOn } from '../domain/task-turn.js'
import { COCKPIT_HOME } from '../paths.js'
import type { SplitRelation, SplitWhen } from '../domain/split.js'
import { stepPrompt } from './task-runner.js'

/**
 * The task board's direct actions (decision cockpit-views-read-only-changes-via-ai, 1b): Hand over,
 * Looks good, Snooze and Close. Everything else stays in the chat.
 *
 * Each action is a command with the page's operation id, so a retry does the work once. A command
 * waits out its undo window (UNDO_WINDOW_MS) before it touches the brain or a job; Undo
 * inside the window drops it, and the board shows its effect meanwhile. Two exceptions act at once:
 * Snooze (local, undone by removing it) and Work on it now (the owner is there): the page opens the
 * session in its desk with the brief this answers with, and Undo puts the task back (the page closes
 * the pane it opened). Pending commands are kept in a file, so a restart applies them instead of
 * losing them.
 */

export const UNDO_WINDOW_MS = 8000
const KEEP_MS = 7 * 24 * 60 * 60 * 1000

/** 'split' and 'sort' are a session's, not the board's: application/split-session.ts and sort-session.ts carry them out. */
export type CommandKind = 'hand_over' | 'review' | 'snooze' | 'close' | 'split' | 'sort'

export interface CommandInput {
  opId: string
  kind: CommandKind
  spaceId: string
  taskId?: string
  handOver?: HandOverRequest
  snooze?: Snooze
}

export interface TaskCommand extends CommandInput {
  createdAt: string
  undoUntil: string
  state: 'pending' | 'applied' | 'undone' | 'failed'
  /** The task as it was, for Undo after Work on it now. */
  before?: HandOverTask
  carriedQuestion?: string
  brief?: string
  effects?: { jobId?: string }
  /** A split off a session: what it made, for Undo. */
  split?: {
    sessionId: string
    title: string
    relation: SplitRelation
    when: SplitWhen
    sourceTaskId: string | null
    createdTaskId: string | null
    /** The open task the split went onto instead of making one. */
    existingTaskId?: string | null
    spawnedSessionId: string | null
    /** Steps done so far, so a retry after a failure part-way does each once. */
    linked?: boolean
    journaled?: { created?: boolean; source?: boolean; existing?: boolean }
  }
  /** A sort of a drifted session: what it did. */
  sort?: { linked: number; created: number; closed: number }
  /** A sort's progress: the next action to apply and the tasks its creates made, for a retry. */
  sortProgress?: { next: number; created: Record<string, string>; createdSteps?: Record<string, { linked?: boolean; journaled?: boolean }>; summed?: boolean }
  error?: string
}

export type CommandRefusal =
  | HandOverRefusal
  | 'invalid'
  | 'unknown_space'
  | 'unknown_task'
  | 'no_brain'
  | 'bound_items'
  | 'open_steps'
  | 'unknown_command'
  | 'undo_expired'

export type Submitted = { ok: true; command: TaskCommand } | { ok: false; refusal: CommandRefusal; message?: string }

interface CommandsFile {
  commands: TaskCommand[]
  snoozes: Snooze[]
}

/** task-commands.json: pending and recent commands, and the Inbox's snoozes. Rewritten whole, owner-only. */
export class TaskCommandStore {
  private data: CommandsFile = { commands: [], snoozes: [] }

  constructor(readonly file = path.join(COCKPIT_HOME, 'task-commands.json')) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CommandsFile>
      this.data = { commands: Array.isArray(parsed.commands) ? parsed.commands : [], snoozes: Array.isArray(parsed.snoozes) ? parsed.snoozes : [] }
    } catch { /* none yet */ }
  }

  commands(): TaskCommand[] {
    return this.data.commands
  }

  get(opId: string): TaskCommand | undefined {
    return this.data.commands.find((c) => c.opId === opId)
  }

  put(command: TaskCommand, now: number): void {
    this.data.commands = [...this.data.commands.filter((c) => c.opId !== command.opId && (c.state === 'pending' || now - Date.parse(c.createdAt) < KEEP_MS)), command]
    this.persist()
  }

  snoozes(now: number): Snooze[] {
    return this.data.snoozes.filter((s) => Date.parse(s.until) > now)
  }

  setSnoozes(snoozes: Snooze[]): void {
    this.data.snoozes = snoozes
    this.persist()
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
}

interface BrainTask {
  id: string
  title: string | null
  content?: string
  status: string
  scope: string
  properties?: { assignee_ids?: string[]; delegate?: string; checkpoint?: string; waiting_on?: WaitingOn }
}

export interface TaskCommandsDeps {
  store: TaskCommandStore
  space(spaceId: string): BrainSpace | undefined
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post'> | null
  agentsOf(space: BrainSpace): Promise<string[]>
  createJob(space: BrainSpace, task: BrainTask, spec: ScheduleSpec, prompt: string): Promise<{ jobId: string } | { error: string }>
  /** A space's board changed. */
  changed(spaceId: string): void
  now(): number
  log(line: string): void
}

const asHandOverTask = (t: BrainTask): HandOverTask => ({
  id: t.id,
  status: t.status,
  owner: t.properties?.assignee_ids?.[0],
  delegate: t.properties?.delegate,
  checkpoint: t.properties?.checkpoint,
  waitingOn: t.properties?.waiting_on,
})

export function createTaskCommands(deps: TaskCommandsDeps) {
  const iso = (ms: number) => new Date(ms).toISOString()
  let ticking: Promise<void> | null = null

  const taskOf = async (brain: Pick<EmlApi, 'get'>, id: string) => (await brain.get(`/engram/${id}`).catch(() => null)) as BrainTask | null

  const track = (brain: Pick<EmlApi, 'post'>, taskId: string, patch: Record<string, unknown>, text: string) =>
    brain.post(`/task/${taskId}/track`, { ...patch, text })

  const save = (command: TaskCommand) => {
    deps.store.put(command, deps.now())
    deps.changed(command.spaceId)
    return command
  }

  /** Check a hand-over against the task as it is now and plan it. */
  const plan = async (space: BrainSpace, brain: Pick<EmlApi, 'get'>, taskId: string, req: HandOverRequest) => {
    const task = await taskOf(brain, taskId)
    if (!task) return { ok: false as const, refusal: 'unknown_task' as const }
    const planned = planHandOver(asHandOverTask(task), req, { agents: await deps.agentsOf(space) })
    return planned.ok ? { ok: true as const, task, plan: planned.plan } : planned
  }

  const submit = async (input: CommandInput): Promise<Submitted> => {
    const existing = deps.store.get(input.opId)
    if (existing) return { ok: true, command: existing }
    const space = deps.space(input.spaceId)
    if (!space) return { ok: false, refusal: 'unknown_space' }
    const brain = deps.brain(space)
    if (!brain) return { ok: false, refusal: 'no_brain' }
    const now = deps.now()
    const base: TaskCommand = { ...input, createdAt: iso(now), undoUntil: iso(now + UNDO_WINDOW_MS), state: 'pending' }

    if (input.kind === 'hand_over') {
      if (!input.taskId || !input.handOver) return { ok: false, refusal: 'invalid' }
      const planned = await plan(space, brain, input.taskId, input.handOver)
      if (!planned.ok) return planned
      const command: TaskCommand = { ...base, before: asHandOverTask(planned.task), ...(planned.plan.carriedQuestion ? { carriedQuestion: planned.plan.carriedQuestion, brief: planned.plan.brief } : {}) }
      if (input.handOver.mode !== 'together') return { ok: true, command: save(command) }
      // Work on it now: the owner is there, so it happens at once; the page opens the session.
      await track(brain, planned.task.id, { ...planned.plan.patch }, planned.plan.journal)
      deps.log(`[commands] ${input.opId.slice(0, 8)} together: task ${planned.task.id.slice(0, 8)} in desk ${input.handOver.desk}`)
      return { ok: true, command: save({ ...command, state: 'applied', ...(planned.plan.brief ? { brief: planned.plan.brief } : {}) }) }
    }

    if (input.kind === 'review') {
      if (!input.taskId) return { ok: false, refusal: 'invalid' }
      const task = await taskOf(brain, input.taskId)
      if (!task) return { ok: false, refusal: 'unknown_task' }
      if (task.status !== 'planned' && task.status !== 'active') return { ok: false, refusal: 'task_closed' }
      const bound = await brain.get('/list', { task_id: task.id, binding: 'task', status: 'active', limit: 1 }).catch(() => null) as { engrams?: unknown[] } | null
      if ((bound?.engrams ?? []).length > 0) return { ok: false, refusal: 'bound_items', message: 'Decisions or notes are bound to this task: close it in the chat, which asks which of them stay.' }
      return { ok: true, command: save(base) }
    }

    if (input.kind === 'snooze') {
      if (!input.snooze || !Number.isFinite(Date.parse(input.snooze.until))) return { ok: false, refusal: 'invalid' }
      deps.store.setSnoozes([...deps.store.snoozes(now).filter((s) => s.key !== input.snooze!.key), input.snooze])
      return { ok: true, command: save({ ...base, state: 'applied' }) }
    }

    if (input.kind === 'close') {
      if (!input.taskId) return { ok: false, refusal: 'invalid' }
      const task = await brain.get(`/engram/${input.taskId}`, { with_relations: 'true' }).catch(() => null) as (BrainTask & { relations?: Array<{ source_id: string; target_id: string; relation: string }> }) | null
      if (!task) return { ok: false, refusal: 'unknown_task' }
      if (task.status !== 'planned' && task.status !== 'active') return { ok: false, refusal: 'task_closed' }
      const steps = (task.relations ?? []).filter((r) => r.relation === 'part_of' && r.target_id === task.id).map((r) => r.source_id)
      for (const id of steps) {
        const step = await taskOf(brain, id)
        if (step && (step.status === 'planned' || step.status === 'active')) return { ok: false, refusal: 'open_steps', message: 'This task still has open steps: close or move them first.' }
      }
      const bound = await brain.get('/list', { task_id: task.id, binding: 'task', status: 'active', limit: 1 }).catch(() => null) as { engrams?: unknown[] } | null
      if ((bound?.engrams ?? []).length > 0) return { ok: false, refusal: 'bound_items', message: 'Decisions or notes are bound to this task: close it in the chat, which asks which of them stay.' }
      return { ok: true, command: save(base) }
    }
    return { ok: false, refusal: 'invalid' }
  }

  const apply = async (command: TaskCommand) => {
    const space = deps.space(command.spaceId)
    const brain = space ? deps.brain(space) : null
    const fail = (error: string) => {
      deps.log(`[commands] ${command.opId.slice(0, 8)} ${command.kind} failed: ${error}`)
      save({ ...command, state: 'failed', error })
    }
    if (!space || !brain) return fail('its space or brain is gone')
    try {
      if (command.kind === 'hand_over') {
        const planned = await plan(space, brain, command.taskId!, command.handOver!)
        if (!planned.ok) return fail(planned.refusal)
        let effects: TaskCommand['effects']
        if (planned.plan.job) {
          const prompt = stepPrompt({ id: planned.task.id, title: planned.task.title ?? planned.task.id, content: planned.task.content ?? '', brief: planned.plan.brief, startedBy: 'A scheduled job' }, command.handOver!.checkpoint!)
          const job = await deps.createJob(space, planned.task, planned.plan.job, prompt)
          if ('error' in job) return fail(job.error)
          effects = { jobId: job.jobId }
        }
        await track(brain, planned.task.id, { ...planned.plan.patch }, planned.plan.journal)
        save({ ...command, state: 'applied', ...(effects ? { effects } : {}) })
      } else if (command.kind === 'review') {
        const task = await taskOf(brain, command.taskId!)
        if (task && (task.status === 'planned' || task.status === 'active')) {
          await track(brain, task.id, { status: 'resolved', outcome: 'Reviewed and closed by the owner', waiting_on: null }, 'Looks good: the owner reviewed the result and closed the task.')
        }
        save({ ...command, state: 'applied' })
      } else if (command.kind === 'close') {
        const task = await taskOf(brain, command.taskId!)
        if (task && (task.status === 'planned' || task.status === 'active')) {
          await track(brain, task.id, { status: 'invalidated', outcome: 'Closed by the owner on the task board', waiting_on: null }, 'Closed on the task board by the owner: not needed.')
        }
        save({ ...command, state: 'applied' })
      }
      deps.log(`[commands] ${command.opId.slice(0, 8)} ${command.kind} applied`)
    } catch (err) {
      fail((err as Error).message)
    }
  }

  return {
    submit,

    async undo(opId: string): Promise<{ ok: true } | { ok: false; refusal: CommandRefusal }> {
      const command = deps.store.get(opId)
      if (!command || command.state === 'undone') return { ok: false, refusal: 'unknown_command' }
      const now = deps.now()
      if (now > Date.parse(command.undoUntil) || command.state === 'failed') return { ok: false, refusal: 'undo_expired' }
      if (command.kind === 'snooze') {
        deps.store.setSnoozes(deps.store.snoozes(now).filter((s) => s.key !== command.snooze!.key))
      } else if (command.kind === 'hand_over' && command.state === 'applied') {
        const space = deps.space(command.spaceId)
        const brain = space ? deps.brain(space) : null
        if (!brain || !command.before) return { ok: false, refusal: 'no_brain' }
        const undo = planUndo(command.before)
        await track(brain, command.taskId!, { ...undo.patch }, undo.journal)
      }
      save({ ...command, state: 'undone' })
      deps.log(`[commands] ${opId.slice(0, 8)} ${command.kind} undone`)
      return { ok: true }
    },

    /** Apply the commands whose undo window is over. */
    tick(): Promise<void> {
      if (ticking) return ticking
      const run = async () => {
        const now = deps.now()
        // A session's split or sort pending here is one that failed part-way: its retry resumes it, not the tick.
        for (const command of deps.store.commands().filter((c) => c.state === 'pending' && c.kind !== 'split' && c.kind !== 'sort' && Date.parse(c.undoUntil) < now)) await apply(command)
      }
      const current = run().finally(() => { if (ticking === current) ticking = null })
      ticking = current
      return current
    },

    every(ms: number): () => void {
      const timer = setInterval(() => { void this.tick() }, ms)
      timer.unref?.()
      return () => clearInterval(timer)
    },

    /** A hand-over of the task can still be undone: nothing may start it yet. */
    held(taskId: string): boolean {
      return deps.store.commands().some((c) => c.kind === 'hand_over' && c.state === 'pending' && c.taskId === taskId)
    },

    /** What the delegate of a task handed over with an open question reads first. */
    briefOf(taskId: string): string | undefined {
      return deps.store.commands().filter((c) => c.kind === 'hand_over' && c.state === 'applied' && c.taskId === taskId && c.brief).at(-1)?.brief
    },

    /** The commands still in their undo window, for the board to show their effect. */
    pending(): TaskCommand[] {
      const now = deps.now()
      return deps.store.commands().filter((c) => c.state === 'pending' || (c.state === 'applied' && Date.parse(c.undoUntil) >= now))
    },

    snoozes(): Snooze[] {
      return deps.store.snoozes(deps.now())
    },
  }
}

export type TaskCommands = ReturnType<typeof createTaskCommands>
