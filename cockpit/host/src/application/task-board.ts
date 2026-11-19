import type { EmlApi } from '@engramprotocol/mcp-server'
import { taskSystemOn, type BrainSpace } from '../brain-space.js'
import { planHandOver } from '../domain/hand-over.js'
import { inboxItems, type InboxItem, type PendingTask, type Snooze } from '../domain/inbox.js'
import {
  coverageOf, isImportant, turnOf, urgencyOf,
  type Coverage, type LiveFacts, type NobodyReason, type TaskFacts, type Turn, type TurnGroup, type WaitingOn,
} from '../domain/task-turn.js'
import type { TaskCommand } from './task-commands.js'

/**
 * The task board's read model (decision whose-turn-derived-in-cockpit-host): the open tasks of every
 * space with their turn, coverage and urgency, the Inbox, and what changed. The brain holds the
 * tasks, the host what runs on them; this joins both once, so Inbox, Now, Plan, the sidebar and the
 * header all count the same thing.
 *
 * On the board (Inbox, Now, the counts): the spaces with the task system on. Plan also reads the other
 * spaces, read-only. The brain publishes no changes, so the board refreshes on a timer, after every
 * command and after a turn ended, and compares turns to report what moved.
 */

export interface BoardTask {
  id: string
  spaceId: string
  spaceName: string
  project: string | null
  title: string
  status: string
  owner?: string
  delegate?: string
  checkpoint?: string
  priority?: string
  due?: string
  parentId: string | null
  waitingOn?: WaitingOn
  updatedAt: string | null
  turn: Turn | null
  group?: TurnGroup
  reason?: NobodyReason
  coverage: Coverage
  urgency: number
  important: boolean
  /** In a space with the task system on: on the board and in the counts. */
  onBoard: boolean
  sessionIds: string[]
  working: boolean
  nextRunAt: string | null
  /** A command on it still in its undo window. */
  pending?: { opId: string; kind: TaskCommand['kind']; undoUntil: string }
}

export interface BoardEvent {
  at: string
  taskId: string
  spaceId: string
  from: Turn | null
  to: Turn | null
}

export interface Board {
  at: string
  viewer: string
  spaces: Array<{ id: string; name: string; taskSystem: boolean; agents: string[] }>
  projects: Array<{ spaceId: string; id: string; name: string; goal: string | null }>
  tasks: BoardTask[]
  inbox: InboxItem[]
  snoozed: InboxItem[]
  events: BoardEvent[]
  counts: { needsYou: number; inbox: number }
}

export interface TaskBoardDeps {
  spaces(): BrainSpace[]
  brain(space: BrainSpace): Pick<EmlApi, 'get'> | null
  /** The person looking: whose turn "Needs you" means. */
  viewer: string
  /** The sessions on a task that are not put away. */
  sessionsOn(taskId: string): Array<{ sessionId: string; working: boolean }>
  /** The next run of a job of the task, if any. */
  nextRunOf(taskId: string): string | null
  /** Tasks sessions proposed that wait for triage, per space. */
  pendingTriage(spaceId: string): Array<Pick<PendingTask, 'id' | 'title' | 'createdAt'> & { sessionId?: string }>
  /** The triage of a proposed task is decided and waits out its undo window. */
  triagePending(pendingId: string): boolean
  snoozes(): Snooze[]
  pendingCommands(): TaskCommand[]
  now(): number
  log(line: string): void
}

const MAX_EVENTS = 40
const OPEN_LIMIT = 500
const RESOLVED_LIMIT = 50

interface Row {
  id: string
  title: string | null
  status: string
  scope: string
  parent_id?: string | null
  updated_at?: string
  properties?: {
    assignee_ids?: string[]
    delegate?: string
    checkpoint?: string
    priority?: string
    due_date?: string
    depends_on?: string[]
    waiting_on?: WaitingOn
  }
}

export function createTaskBoard(deps: TaskBoardDeps) {
  let current: Board | null = null
  let refreshing: Promise<Board> | null = null
  let askedAt = -Infinity
  const turns = new Map<string, Turn | null>()
  let events: BoardEvent[] = []
  const listeners = new Set<(events: BoardEvent[]) => void>()

  const list = async (brain: Pick<EmlApi, 'get'>, status: string, extra: Record<string, string | number> = {}) =>
    ((await brain.get('/list', { type: 'task', status, with_parent: 'true', limit: OPEN_LIMIT, ...extra }).catch(() => ({ engrams: [] }))) as { engrams?: Row[] }).engrams ?? []

  const objects = async (brain: Pick<EmlApi, 'get'>, object: string) =>
    ((await brain.get(`/object/${object}`).catch(() => ({ objects: [] }))) as { objects?: Array<Record<string, unknown>> }).objects ?? []

  /** A pending command's effect on the task, shown before it is applied. */
  const overlay = (row: Row, command: TaskCommand | undefined, agents: string[], runner: boolean): Row => {
    if (!command || command.state !== 'pending') return row
    if (command.kind === 'review') return { ...row, status: 'resolved', updated_at: command.createdAt || row.updated_at }
    if (command.kind === 'hand_over' && command.handOver) {
      const props = row.properties ?? {}
      const planned = planHandOver({ id: row.id, status: row.status, owner: props.assignee_ids?.[0], delegate: props.delegate, checkpoint: props.checkpoint, waitingOn: props.waiting_on }, command.handOver, { agents, runner })
      if (!planned.ok) return row
      const { status, waiting_on, ...fields } = planned.plan.patch
      const next: Row['properties'] = { ...props, ...fields } as Row['properties']
      if (waiting_on === null) delete next!.waiting_on
      return { ...row, ...(status ? { status } : {}), properties: next }
    }
    return row
  }

  const build = async (): Promise<Board> => {
    const now = deps.now()
    const pending = deps.pendingCommands()
    const commandOf = (taskId: string) => pending.filter((c) => c.taskId === taskId).at(-1)
    const board: Board = { at: new Date(now).toISOString(), viewer: deps.viewer, spaces: [], projects: [], tasks: [], inbox: [], snoozed: [], events: [], counts: { needsYou: 0, inbox: 0 } }
    const inboxTasks: Parameters<typeof inboxItems>[0] = []
    const proposed: PendingTask[] = []

    for (const space of deps.spaces()) {
      const brain = deps.brain(space)
      const onBoard = taskSystemOn(space)
      const agents = brain ? (await objects(brain, 'agent')).map((a) => String(a.id)) : []
      board.spaces.push({ id: space.id, name: space.name, taskSystem: onBoard, agents })
      if (!brain) continue
      for (const p of await objects(brain, 'project')) {
        board.projects.push({ spaceId: space.id, id: String(p.id), name: String(p.name ?? p.id), goal: typeof p.goal === 'string' ? p.goal : null })
      }
      const [planned, active, resolved] = await Promise.all([
        list(brain, 'planned'), list(brain, 'active'), list(brain, 'resolved', { order_by: 'updated_at', limit: RESOLVED_LIMIT }),
      ])
      const rows = [...planned, ...active, ...resolved].map((row) => overlay(row, commandOf(row.id), agents, onBoard))
      const statusOf = new Map(rows.map((r) => [r.id, r.status]))

      for (const row of rows) {
        const props = row.properties ?? {}
        const sessions = deps.sessionsOn(row.id)
        const facts: TaskFacts = {
          status: row.status,
          owner: props.assignee_ids?.[0],
          delegate: props.delegate,
          checkpoint: props.checkpoint,
          waitingOn: props.waiting_on,
          priority: props.priority,
          due: props.due_date,
          closedAt: row.status === 'resolved' ? row.updated_at : undefined,
          parentActive: row.parent_id ? (statusOf.has(row.parent_id) ? statusOf.get(row.parent_id) === 'active' : null) : null,
          depsResolved: (props.depends_on ?? []).every((id) => !statusOf.has(id) || statusOf.get(id) === 'resolved'),
        }
        const live: LiveFacts = { working: sessions.some((s) => s.working), nextRunAt: deps.nextRunOf(row.id), runner: onBoard }
        const turn = turnOf(facts, live, deps.viewer, now)
        if (row.status === 'resolved' && turn === null) continue
        const stepsWaiting = rows.filter((r) => r.parent_id === row.id && r.status === 'planned').length
        const command = commandOf(row.id)
        board.tasks.push({
          id: row.id,
          spaceId: space.id,
          spaceName: space.name,
          project: row.scope.startsWith('project.') ? row.scope.slice('project.'.length) : null,
          title: row.title ?? row.id,
          status: row.status,
          parentId: row.parent_id ?? null,
          updatedAt: row.updated_at ?? null,
          ...(facts.owner ? { owner: facts.owner } : {}),
          ...(facts.delegate ? { delegate: facts.delegate } : {}),
          ...(facts.checkpoint ? { checkpoint: facts.checkpoint } : {}),
          ...(facts.priority ? { priority: facts.priority } : {}),
          ...(facts.due ? { due: facts.due } : {}),
          ...(facts.waitingOn ? { waitingOn: facts.waitingOn } : {}),
          turn: turn?.turn ?? null,
          ...(turn?.group ? { group: turn.group } : {}),
          ...(turn?.reason ? { reason: turn.reason } : {}),
          coverage: coverageOf(facts, live, deps.viewer, now, stepsWaiting),
          urgency: urgencyOf(facts, live, deps.viewer, now),
          important: isImportant(facts, live, deps.viewer, now),
          onBoard,
          sessionIds: sessions.map((s) => s.sessionId),
          working: live.working,
          nextRunAt: live.nextRunAt,
          ...(command && Date.parse(command.undoUntil) >= now ? { pending: { opId: command.opId, kind: command.kind, undoUntil: command.undoUntil } } : {}),
        })
        if (onBoard && row.status !== 'resolved') inboxTasks.push({ id: row.id, space: space.id, title: row.title ?? row.id, waitingOn: props.waiting_on })
      }
      if (onBoard) {
        for (const p of deps.pendingTriage(space.id)) if (!deps.triagePending(p.id)) proposed.push({ ...p, space: space.id })
      }
    }

    const inbox = inboxItems(inboxTasks, proposed, deps.viewer, deps.snoozes(), now)
    board.inbox = inbox.live
    board.snoozed = inbox.snoozed
    board.counts = { needsYou: board.tasks.filter((t) => t.onBoard && t.turn === 'needs_you').length, inbox: inbox.live.length }

    // What moved since the last refresh; the first build only records where everything stands.
    const changes: BoardEvent[] = []
    const seen = new Set<string>()
    for (const t of board.tasks) {
      const key = `${t.spaceId}/${t.id}`
      seen.add(key)
      if (turns.has(key) && turns.get(key) !== t.turn && t.onBoard) changes.push({ at: board.at, taskId: t.id, spaceId: t.spaceId, from: turns.get(key) ?? null, to: t.turn })
      turns.set(key, t.turn)
    }
    for (const key of [...turns.keys()]) if (!seen.has(key)) turns.delete(key)
    events = [...changes, ...events].slice(0, MAX_EVENTS)
    board.events = events
    if (changes.length > 0) for (const listener of listeners) listener(changes)
    return board
  }

  return {
    /** Build the board now; parallel callers share one build. */
    refresh(): Promise<Board> {
      if (refreshing) return refreshing
      const run = build().then((board) => { current = board; return board })
      const shared = run.finally(() => { if (refreshing === shared) refreshing = null })
      refreshing = shared
      return shared
    },

    /** The board, rebuilt when it is older than `maxAgeMs`. */
    async get(maxAgeMs: number): Promise<Board> {
      askedAt = deps.now()
      if (current && deps.now() - Date.parse(current.at) <= maxAgeMs) return current
      return this.refresh()
    },

    onChange(listener: (events: BoardEvent[]) => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    /** Refresh every `ms` while a page asked for the board within `viewedMs`. */
    every(ms: number, viewedMs: number): () => void {
      const timer = setInterval(() => {
        if (deps.now() - askedAt > viewedMs) return
        this.refresh().catch((err) => deps.log(`[board] refresh failed: ${(err as Error).message}`))
      }, ms)
      timer.unref?.()
      return () => clearInterval(timer)
    },
  }
}

export type TaskBoard = ReturnType<typeof createTaskBoard>
