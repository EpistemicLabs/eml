import * as fs from 'node:fs'
import * as path from 'node:path'
import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace } from '../brain-space.js'
import { planHandOver, planUndo, type HandOverRefusal, type HandOverRequest, type HandOverTask, type ScheduleSpec } from '../domain/hand-over.js'
import type { Snooze } from '../domain/inbox.js'
import type { WaitingOn } from '../domain/task-turn.js'
import type { DelegationFields } from '../domain/delegation.js'
import { waitsOf } from '../domain/task-waits.js'
import { ownerOf, ownersFor } from '../domain/task-owner.js'
import { COCKPIT_HOME } from '../paths.js'
import type { SplitRelation, SplitWhen } from '../domain/split.js'
import { stepPrompt } from './task-runner.js'
import { trackWaits } from './task-waits.js'
import { SNOOZED_OPEN, waitsBody } from '../domain/task-waits.js'

/**
 * The task board's direct actions (decision cockpit-views-read-only-changes-via-ai, 1b): Hand over,
 * Looks good, Snooze, Close and Reopen (decision task-board-reopen-action), and from a closed task's chat Send
 * (Reopen with the message for its newest session) and As follow-up (a new task spun off from it). Everything
 * else stays in the chat.
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
/** Work on it now whose session never opened (the page failed): the agent is released after this. */
export const TOGETHER_GRACE_MS = 10 * 60 * 1000

/** 'split' and 'sort' are a session's, not the board's: application/split-session.ts and sort-session.ts carry them out. */
export type CommandKind = 'hand_over' | 'review' | 'snooze' | 'close' | 'reopen' | 'follow_up' | 'split' | 'sort'

/** The longest message a closed task's chat takes for Send or As follow-up. */
export const MESSAGE_MAX = 20_000
const MESSAGE_RULE = `Write a message of at most ${MESSAGE_MAX} characters.`

export interface CommandInput {
  opId: string
  kind: CommandKind
  spaceId: string
  taskId?: string
  handOver?: HandOverRequest
  snooze?: Snooze
  /** Reopen: the owner's reason, for the journal (optional). */
  reason?: string
  /** Reopen from the task's chat: the message its newest session gets once the task is open. Follow-up: its brief. */
  message?: string
}

/** A decision or note that closed with the task: a reopen lists it for the chat, which brings it back on the owner's yes. */
export interface ReopenItem { id: string; type: string; title: string | null }

export interface TaskCommand extends CommandInput {
  createdAt: string
  undoUntil: string
  state: 'pending' | 'applied' | 'undone' | 'failed'
  /** The task as it was, for Undo after Work on it now. */
  before?: HandOverTask
  carriedQuestion?: string
  brief?: string
  effects?: { jobId?: string }
  /** Work on it now ended (its sessions were put away): the delegate was released, and the board offers to hand it over. */
  released?: { at: string; agent: string }
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
  /** A reopen that was applied: what closed with the task and comes back only through the chat, and the steps that stay closed. */
  reopened?: { items: ReopenItem[]; closedSteps: number }
  /** Where a reopen's message went: the session that got it, or the one started with it. */
  continued?: { sessionId: string | null; how: 'delivered' | 'started' | 'failed' }
  /** The task a follow-up made, and whether it is linked to the one it follows (a retry skips what is done). */
  followUp?: { taskId: string; linked?: boolean; journaled?: boolean }
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
  | 'task_open'
  | 'not_owner'
  | 'superseded'
  | 'parent_closed'
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
    // Work on it now that has not ended stays however long it runs: it keeps the runner off its task.
    const keep = (c: TaskCommand) => c.state === 'pending' || isOpenTogether(c) || now - Date.parse(c.createdAt) < KEEP_MS
    this.data.commands = [...this.data.commands.filter((c) => c.opId !== command.opId && keep(c)), command]
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

const isOpenTogether = (c: TaskCommand) => c.kind === 'hand_over' && c.handOver?.mode === 'together' && c.state === 'applied' && !c.released

interface BrainTask {
  id: string
  title: string | null
  content?: string
  status: string
  scope: string
  properties?: { assignee_ids?: string[]; delegate?: string; checkpoint?: string; delegation?: DelegationFields; waits?: unknown; waiting_on?: WaitingOn; display_title?: string; goal?: string }
}

/**
 * v0.23: a reopened task starts nothing on its own: a delegation keeps its agent and checkpoint but loses a request
 * that never ran, so only a new Delegate now starts it. The fields a reopen writes besides its status.
 */
const reopenPatch = (task: BrainTask): Record<string, unknown> => {
  const d = task.properties?.delegation
  if (!d?.requested_at) return {}
  const { requested_at: _request, ...rest } = d
  return { delegation: rest }
}

type Relation = { source_id: string; target_id: string; relation: string }
type BrainTaskWithRelations = BrainTask & { relations?: Relation[] }

const OPEN = new Set(['planned', 'active'])
/** A message's first line for a journal: flat, at most 120 characters. */
export const firstLine = (text: string) => {
  const line = text.trim().split('\n')[0].replace(/\s+/g, ' ')
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}
const nameOf = (t: BrainTask) => t.properties?.display_title ?? t.title ?? t.id

export interface TaskCommandsDeps {
  store: TaskCommandStore
  /** The person at the page: only a task's owner may reopen it. Unset: not checked. */
  viewer?: string
  space(spaceId: string): BrainSpace | undefined
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post'> | null
  agentsOf(space: BrainSpace): Promise<string[]>
  createJob(space: BrainSpace, task: BrainTask, spec: ScheduleSpec, prompt: string): Promise<{ jobId: string } | { error: string }>
  /**
   * The sessions on the task that started at or after `since`, and how many of them are not put away.
   * Without it Work on it now never ends on its own.
   */
  sessionsSince?(taskId: string, since: string): { total: number; open: number }
  /** The task's newest session, archived or not: where a reopen's message goes. */
  newestSessionOn?(taskId: string): string | null
  /** Give a session the user's message, resuming it when stopped; true once it has it. */
  deliver?(sessionId: string, text: string): Promise<boolean>
  /** Start a session of the owner's own on the task with this prompt (a task without a session to wake). */
  startOnTask?(spaceId: string, taskId: string, prompt: string): Promise<string | null>
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
  waits: waitsOf(t.properties),
  ...(t.properties?.delegation ? { delegation: t.properties.delegation } : {}),
  ...(t.properties?.goal ? { goal: t.properties.goal } : {}),
})

/** A snooze's until that brings a parked wait back now. */
export const UNPARK = 'now'

/** The task and the moment its wait began, from an Inbox key (domain/inbox.ts itemKey: task:<id>@<since>). */
export function parkTarget(key: string): { taskId: string; since: string } | null {
  const m = /^task:([^@]+)@(.*)$/.exec(key)
  return m ? { taskId: m[1], since: m[2] } : null
}

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

  /** The task's latest hand-over that was not undone or failed: the one that says what the owner wants now. */
  const latestHandOver = (taskId: string) =>
    // By when it was chosen: saving a command again moves it to the end of the store.
    deps.store.commands().filter((c) => c.kind === 'hand_over' && c.taskId === taskId && (c.state === 'pending' || c.state === 'applied'))
      .reduce<TaskCommand | undefined>((latest, c) => (!latest || Date.parse(c.createdAt) >= Date.parse(latest.createdAt) ? c : latest), undefined)

  /**
   * Work on it now ended once every session opened on the task since is put away (or none opened
   * within TOGETHER_GRACE_MS). The agent was there to work with the owner, not alone, and Work on it now
   * wrote no delegation (v0.23), so this only records the release: the board offers "Hand to <agent>".
   * A delegate still on the task (set by an older cockpit) is released with a journal line. A later
   * hand-over replaced it: nothing to release.
   */
  const releaseTogether = async (now: number) => {
    if (!deps.sessionsSince) return
    for (const command of deps.store.commands().filter(isOpenTogether)) {
      if (latestHandOver(command.taskId!) !== command) {
        save({ ...command, released: { at: new Date(now).toISOString(), agent: command.handOver!.delegate } })
        continue
      }
      const sessions = deps.sessionsSince(command.taskId!, command.createdAt)
      const ended = sessions.total > 0 ? sessions.open === 0 : now - Date.parse(command.createdAt) > TOGETHER_GRACE_MS
      if (!ended) continue
      const space = deps.space(command.spaceId)
      const brain = space ? deps.brain(space) : null
      if (!brain) continue
      const agent = command.handOver!.delegate
      try {
        const task = await taskOf(brain, command.taskId!)
        if (task && (task.status === 'planned' || task.status === 'active') && task.properties?.delegate === agent) {
          await track(brain, task.id, { delegate: null, checkpoint: null },
            `Worked on it together with ${agent}; the session was put away, so ${agent} is released and does not go on alone. Hand it to ${agent} to let it go on.`)
        }
        save({ ...command, released: { at: new Date(now).toISOString(), agent } })
        deps.log(`[commands] ${command.opId.slice(0, 8)} together ended: ${agent} released from task ${command.taskId!.slice(0, 8)}`)
      } catch (err) {
        deps.log(`[commands] ${command.opId.slice(0, 8)} together release failed: ${(err as Error).message}`)
      }
    }
  }

  /**
   * Park the waits on the viewer that began at `since` (every wait on the viewer when since is empty): snoozed_until is
   * the date they come back, or "open"; null unparks them. False when the task is gone or has no such wait.
   */
  const park = async (brain: Pick<EmlApi, 'get' | 'post'>, target: { taskId: string; since: string }, until: string | null): Promise<boolean> => {
    let found = false
    try {
      await trackWaits(brain, target.taskId, (task) => {
        const waits = waitsOf(task.properties)
        const hit = (w: { who: string; since?: string }) => (!deps.viewer || w.who === deps.viewer) && (target.since === '' || (w.since ?? '') === target.since)
        found = waits.some(hit)
        if (!found) return null
        const next = waits.map((w) => {
          if (!hit(w)) return w
          const { snoozed_until: _was, ...rest } = w
          return until ? { ...rest, snoozed_until: until } : rest
        })
        const how = until === null ? 'Unparked by the owner.' : until === SNOOZED_OPEN ? 'Parked by the owner until further notice.' : `Parked by the owner until ${until}.`
        return { ...waitsBody(next), text: how }
      })
    } catch (err) {
      deps.log(`[commands] parking ${target.taskId.slice(0, 8)} failed: ${(err as Error).message}`)
      return false
    }
    return found
  }

  /** Only a task's owner may reopen it or start a follow-up of it; null when the viewer may. */
  const ownerRefusal = (task: BrainTask, action: string): { ok: false; refusal: CommandRefusal; message: string } | null => {
    const owner = task.properties?.assignee_ids?.[0]
    return deps.viewer && owner && owner !== deps.viewer ? { ok: false, refusal: 'not_owner', message: `Only its owner (${owner}) can ${action}.` } : null
  }

  /** Check a hand-over against the task as it is now and plan it. */
  const plan = async (space: BrainSpace, brain: Pick<EmlApi, 'get'>, taskId: string, req: HandOverRequest) => {
    const task = await taskOf(brain, taskId)
    if (!task) return { ok: false as const, refusal: 'unknown_task' as const }
    const planned = planHandOver(asHandOverTask(task), req, { agents: await deps.agentsOf(space), now: iso(deps.now()) })
    return planned.ok ? { ok: true as const, task, plan: planned.plan } : planned
  }

  /**
   * Whether a closed task may be reopened from the board, by the rules of note reopen-closed-task-cause-and-proposal:
   * the owner only; not an open task; not one another task replaced (the refusal names it); not under a closed parent.
   * Closed steps stay closed: their count goes into the journal.
   */
  const checkReopen = async (brain: Pick<EmlApi, 'get'>, taskId: string): Promise<{ ok: true; task: BrainTask; closedSteps: number } | { ok: false; refusal: CommandRefusal; message?: string }> => {
    const task = await brain.get(`/engram/${taskId}`, { with_relations: 'true' }).catch(() => null) as BrainTaskWithRelations | null
    if (!task) return { ok: false, refusal: 'unknown_task' }
    if (OPEN.has(task.status)) return { ok: false, refusal: 'task_open' }
    const refused = ownerRefusal(task, 'reopen this task')
    if (refused) return refused
    const relations = task.relations ?? []
    for (const r of relations.filter((r) => r.relation === 'supersedes' && r.target_id === task.id)) {
      const successor = await taskOf(brain, r.source_id)
      if (successor && successor.status !== 'invalidated') return { ok: false, refusal: 'superseded', message: `"${nameOf(successor)}" replaced this task: go on there.` }
    }
    if (task.status === 'superseded') return { ok: false, refusal: 'superseded', message: 'Another task replaced this one: go on there.' }
    const parentId = relations.find((r) => r.relation === 'part_of' && r.source_id === task.id)?.target_id
    const parent = parentId ? await taskOf(brain, parentId) : null
    if (parent && !OPEN.has(parent.status)) return { ok: false, refusal: 'parent_closed', message: `Its parent "${nameOf(parent)}" is closed: reopen the parent first.` }
    let closedSteps = 0
    for (const r of relations.filter((r) => r.relation === 'part_of' && r.target_id === task.id)) {
      const step = await taskOf(brain, r.source_id)
      if (step && !OPEN.has(step.status)) closedSteps++
    }
    return { ok: true, task, closedSteps }
  }

  /** Why a task cannot be closed from the board: it has open steps, or decisions and notes bound to it; null when it can. */
  const closeRefusal = async (brain: Pick<EmlApi, 'get'>, task: BrainTaskWithRelations): Promise<{ ok: false; refusal: CommandRefusal; message: string } | null> => {
    const steps = (task.relations ?? []).filter((r) => r.relation === 'part_of' && r.target_id === task.id).map((r) => r.source_id)
    for (const id of steps) {
      const step = await taskOf(brain, id)
      if (step && OPEN.has(step.status)) return { ok: false, refusal: 'open_steps', message: 'This task still has open steps: close or move them first.' }
    }
    const bound = await brain.get('/list', { task_id: task.id, binding: 'task', status: 'active', limit: 1 }).catch(() => null) as { engrams?: unknown[] } | null
    if ((bound?.engrams ?? []).length > 0) return { ok: false, refusal: 'bound_items', message: 'Decisions or notes are bound to this task: close it in the chat, which asks which of them stay.' }
    return null
  }

  /**
   * Closed → active by the board's reopen rules, with `text` in the journal. 'open' when it is not closed; a refusal
   * (replaced, gone, under a closed parent, another owner's) leaves it as it is and comes back with its code and, for
   * the task's journal, its words.
   */
  const reopenClosed = async (brain: Pick<EmlApi, 'get' | 'post'>, taskId: string, text: string): Promise<'reopened' | 'open' | { refused: CommandRefusal; message: string }> => {
    const task = await taskOf(brain, taskId)
    if (!task) return { refused: 'unknown_task', message: 'unknown_task' }
    if (OPEN.has(task.status)) return 'open'
    const checked = await checkReopen(brain, taskId)
    if (!checked.ok) return { refused: checked.refusal, message: checked.message ?? checked.refusal }
    await track(brain, taskId, { status: 'active', waits: null, ...reopenPatch(checked.task) }, text)
    return 'reopened'
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
      // Parking (decision task-parking-is-a-snoozed-wait): the snooze goes on the task's wait in the brain, so the
      // task shows as Parked on every device and for every member, and comes back by itself at the date.
      const snooze = input.snooze
      // until "now" brings a parked wait back (the Inbox's "Bring back now").
      if (!snooze || (snooze.until !== SNOOZED_OPEN && snooze.until !== UNPARK && !Number.isFinite(Date.parse(snooze.until)))) return { ok: false, refusal: 'invalid' }
      const target = parkTarget(snooze.key)
      if (!target) return { ok: false, refusal: 'invalid' }
      if (snooze.until === UNPARK) deps.store.setSnoozes(deps.store.snoozes(now).filter((s) => s.key !== snooze.key))
      const parked = await park(brain, target, snooze.until === UNPARK ? null : snooze.until)
      if (!parked) return { ok: false, refusal: 'unknown_task' }
      return { ok: true, command: save({ ...base, taskId: target.taskId, state: 'applied' }) }
    }

    if (input.kind === 'close') {
      if (!input.taskId) return { ok: false, refusal: 'invalid' }
      const task = await brain.get(`/engram/${input.taskId}`, { with_relations: 'true' }).catch(() => null) as BrainTaskWithRelations | null
      if (!task) return { ok: false, refusal: 'unknown_task' }
      if (task.status !== 'planned' && task.status !== 'active') return { ok: false, refusal: 'task_closed' }
      const refused = await closeRefusal(brain, task)
      if (refused) return refused
      return { ok: true, command: save(base) }
    }

    if (input.kind === 'reopen') {
      if (!input.taskId) return { ok: false, refusal: 'invalid' }
      if (input.message !== undefined && (!input.message.trim() || input.message.length > MESSAGE_MAX)) return { ok: false, refusal: 'invalid', message: MESSAGE_RULE }
      const checked = await checkReopen(brain, input.taskId)
      if (!checked.ok) return checked
      return { ok: true, command: save(base) }
    }

    if (input.kind === 'follow_up') {
      if (!input.taskId) return { ok: false, refusal: 'invalid' }
      if (!input.message?.trim() || input.message.length > MESSAGE_MAX) return { ok: false, refusal: 'invalid', message: MESSAGE_RULE }
      const task = await taskOf(brain, input.taskId)
      if (!task) return { ok: false, refusal: 'unknown_task' }
      const refused = ownerRefusal(task, 'start a follow-up of this task')
      if (refused) return refused
      return { ok: true, command: save(base) }
    }
    return { ok: false, refusal: 'invalid' }
  }

  /** A reopened task's message: to its newest session (resumed when stopped), or a new session started with it. */
  const continueIn = async (spaceId: string, taskId: string, message: string): Promise<NonNullable<TaskCommand['continued']>> => {
    const newest = deps.newestSessionOn?.(taskId) ?? null
    if (newest && deps.deliver && await deps.deliver(newest, message).catch(() => false)) return { sessionId: newest, how: 'delivered' }
    const started = deps.startOnTask ? await deps.startOnTask(spaceId, taskId, message).catch(() => null) : null
    if (started) return { sessionId: started, how: 'started' }
    deps.log(`[commands] task ${taskId.slice(0, 8)} reopened, but its message reached no session`)
    return { sessionId: newest, how: 'failed' }
  }

  /**
   * A follow-up: a new task in the same project with the same owner, delegate and checkpoint, the message as its
   * brief, linked to the task it follows (derived_from, the board's origin). Planned, so the runner starts its
   * delegate as with any new step. Each part is recorded, so a retry after a failure part-way does it once.
   */
  const makeFollowUp = async (brain: Pick<EmlApi, 'get' | 'post'>, command: TaskCommand): Promise<NonNullable<TaskCommand['followUp']> | null> => {
    const from = await taskOf(brain, command.taskId!)
    if (!from) return null
    const record = (followUp: NonNullable<TaskCommand['followUp']>) => { save({ ...command, followUp }); return followUp }
    let done = command.followUp
    if (!done) {
      const props = from.properties ?? {}
      const name = nameOf(from)
      const created = await brain.post('/engram/task', {
        title: `follow-up-${from.title ?? from.id}`.slice(0, 80),
        display_title: `Follow-up: ${name}`.slice(0, 80),
        content: command.message!.trim(),
        scope: from.scope,
        status: 'planned',
        // the same owners; a task that names none gets the person at the page, else its author (domain/task-owner.ts)
        assignee_ids: ownersFor(from, deps.viewer ?? ownerOf(from) ?? ''),
        ...(props.delegate ? { delegate: props.delegate } : {}),
        ...(props.checkpoint ? { checkpoint: props.checkpoint } : {}),
      }) as { id: string }
      done = record({ taskId: created.id })
    }
    if (!done.linked) {
      await brain.post('/relate', { source_id: done.taskId, target_id: from.id, relation: 'derived_from', detection_method: 'manual', explanation: 'follow-up of' })
      done = record({ ...done, linked: true })
    }
    if (!done.journaled) {
      await track(brain, done.taskId, {}, `Follow-up of ${nameOf(from)}, started from its chat by the owner.`)
      await track(brain, from.id, {}, `A follow-up was started from its chat: Follow-up: ${nameOf(from)} (${done.taskId}).`)
      done = record({ ...done, journaled: true })
    }
    return done
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
          await track(brain, task.id, { status: 'resolved', outcome: 'Reviewed and closed by the owner', waits: null }, 'Looks good: the owner reviewed the result and closed the task.')
        }
        save({ ...command, state: 'applied' })
      } else if (command.kind === 'close') {
        const task = await taskOf(brain, command.taskId!)
        if (task && (task.status === 'planned' || task.status === 'active')) {
          await track(brain, task.id, { status: 'invalidated', outcome: 'Closed by the owner on the task board', waits: null }, 'Closed on the task board by the owner: not needed.')
        }
        save({ ...command, state: 'applied' })
      } else if (command.kind === 'reopen') {
        // Each part is recorded as it is done, so a retry after a crash goes on where it stopped: the message
        // is keyed on the reopened task, not on this run making the change (service-design, retries).
        let current = command
        if (!current.reopened) {
          const checked = await checkReopen(brain, current.taskId!)
          if (!checked.ok) return fail(checked.message ?? checked.refusal)
          const steps = checked.closedSteps ? ` ${checked.closedSteps} closed step${checked.closedSteps === 1 ? '' : 's'} stay closed.` : ''
          const reason = current.reason ? ` Why: ${current.reason}` : ''
          // Active, not planned: the runner starts planned tasks with a delegate, and a reopen starts nothing.
          const how = current.message ? `Reopened by writing in its chat: "${firstLine(current.message)}".` : 'Reopened on the task board by the owner.'
          const answer = await track(brain, checked.task.id, { status: 'active', waits: null, ...reopenPatch(checked.task) }, `${how}${reason}${steps}`) as { reopen_candidates?: ReopenItem[] } | null
          const items = (answer?.reopen_candidates ?? []).map((i) => ({ id: i.id, type: i.type, title: i.title ?? null }))
          current = save({ ...current, reopened: { items, closedSteps: checked.closedSteps } })
          if (items.length > 0) {
            const list = items.map((i) => `${i.type} ${i.title ?? i.id} (${i.id})`).join('; ')
            await track(brain, checked.task.id, {}, `Closed with the task and not back yet: ${list}. They come back through the chat on the owner's yes (eml_update status active).`)
              .catch((err: Error) => deps.log(`[commands] ${current.opId.slice(0, 8)} reopen: listing what closed with it failed: ${err.message}`))
          }
        }
        const continued = current.message && !current.continued ? await continueIn(current.spaceId, current.taskId!, current.message) : current.continued
        save({ ...current, state: 'applied', ...(continued ? { continued } : {}) })
      } else if (command.kind === 'follow_up') {
        const followUp = await makeFollowUp(brain, command)
        if (!followUp) return fail('its task is gone')
        save({ ...command, state: 'applied', followUp })
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
        // A snooze from before parking lived in the local store; one since then is on the wait.
        deps.store.setSnoozes(deps.store.snoozes(now).filter((s) => s.key !== command.snooze!.key))
        const space = deps.space(command.spaceId)
        const brain = space ? deps.brain(space) : null
        const target = parkTarget(command.snooze!.key)
        if (brain && target) await park(brain, target, null)
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

    /**
     * The owner wrote in a session of a closed task (on a desk, outside the board): the task reopens first, by
     * the board's reopen rules, so its work never runs while it shows as closed. A task that can't be reopened
     * stays closed and its journal says why. Never throws.
     */
    async reopenByWriting(spaceId: string, taskId: string): Promise<'reopened' | 'open' | 'refused'> {
      const space = deps.space(spaceId)
      const brain = space ? deps.brain(space) : null
      if (!brain) return 'refused'
      try {
        const result = await reopenClosed(brain, taskId, 'Reopened by writing in its chat.')
        if (result === 'open') return 'open'
        if (result !== 'reopened') {
          if (result.refused !== 'unknown_task') await track(brain, taskId, {}, `Its chat got a message, but the task stays closed: ${result.message}`).catch(() => {})
          return 'refused'
        }
        deps.changed(spaceId)
        deps.log(`[commands] task ${taskId.slice(0, 8)} reopened by writing in its chat`)
        return 'reopened'
      } catch (err) {
        deps.log(`[commands] task ${taskId.slice(0, 8)} reopen by writing failed: ${(err as Error).message}`)
        return 'refused'
      }
    },

    /** Apply the commands whose undo window is over. */
    tick(): Promise<void> {
      if (ticking) return ticking
      const run = async () => {
        const now = deps.now()
        // A session's split or sort pending here is one that failed part-way: its retry resumes it, not the tick.
        for (const command of deps.store.commands().filter((c) => c.state === 'pending' && c.kind !== 'split' && c.kind !== 'sort' && Date.parse(c.undoUntil) < now)) await apply(command)
        await releaseTogether(now)
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

    /** The owner works on the task with its delegate (Work on it now): the runner must not start the delegate alone. */
    together(taskId: string): boolean {
      const latest = latestHandOver(taskId)
      return latest !== undefined && isOpenTogether(latest)
    },

    /** When the task's latest hand-over, a Delegate now, was chosen; null when the latest is another kind or there is none. */
    delegatedAt(taskId: string): string | null {
      const latest = latestHandOver(taskId)
      return latest?.handOver?.mode === 'now' ? latest.createdAt : null
    },

    /** The agent released when Work on it now ended, while that is still the task's latest hand-over: the board offers "Hand to <agent>". */
    releasedAgent(taskId: string): string | null {
      const latest = latestHandOver(taskId)
      return latest?.handOver?.mode === 'together' && latest.released ? latest.released.agent : null
    },

    /** The decisions and notes the task's latest board reopen listed for the chat (they closed with it). */
    reopenedWith(taskId: string): ReopenItem[] {
      return deps.store.commands().filter((c) => c.kind === 'reopen' && c.state === 'applied' && c.taskId === taskId).at(-1)?.reopened?.items ?? []
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
