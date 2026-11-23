import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace } from '../brain-space.js'
import { planHandOver } from '../domain/hand-over.js'
import { inboxItems, type InboxItem, type Snooze } from '../domain/inbox.js'
import { statusLine, type StatusLine } from '../domain/status-line.js'
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
 * The board covers every space. The brain publishes no changes, so the board refreshes on a timer, after every
 * command and after a turn ended, and compares turns to report what moved.
 */

export interface BoardTask {
  id: string
  spaceId: string
  spaceName: string
  project: string | null
  title: string
  /** The name a person reads (display_title); the cockpit falls back to the title as words. */
  displayTitle?: string
  /** Where it stands: the first sentence of its newest handoff's Result, else of its newest note. */
  statusLine?: StatusLine
  status: string
  owner?: string
  delegate?: string
  checkpoint?: string
  priority?: string
  due?: string
  parentId: string | null
  /** The task it was spun off from (a derived_from link); null when none. */
  originId: string | null
  /** How it hangs in its tree: a sub-task under parentId, spun off from originId, or a root. */
  rel: 'sub' | 'spun' | null
  waitingOn?: WaitingOn
  updatedAt: string | null
  turn: Turn | null
  group?: TurnGroup
  reason?: NobodyReason
  coverage: Coverage
  urgency: number
  important: boolean
  sessionIds: string[]
  working: boolean
  nextRunAt: string | null
  /** Work on it now ended and released this agent: the board offers "Hand to <agent>". Only while nobody is delegated. */
  handTo?: string
  /** A command on it still in its undo window. */
  pending?: { opId: string; kind: TaskCommand['kind']; undoUntil: string }
}

/** A closed task the board leaves out that a tree still needs: an ancestor of a task with a session. */
export interface LineageTask {
  id: string
  spaceId: string
  project: string | null
  title: string
  displayTitle?: string
  status: string
  parentId: string | null
  originId: string | null
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
  spaces: Array<{ id: string; name: string; agents: string[] }>
  projects: Array<{ spaceId: string; id: string; name: string; goal: string | null }>
  tasks: BoardTask[]
  lineage: LineageTask[]
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
  snoozes(): Snooze[]
  pendingCommands(): TaskCommand[]
  /** The agent released when Work on it now on the task ended (application/task-commands.ts releasedAgent). */
  releasedAgent?(taskId: string): string | null
  now(): number
  log(line: string): void
}

const MAX_EVENTS = 40
const OPEN_LIMIT = 500
const RESOLVED_LIMIT = 50
/** How far up a tree the board follows closed ancestors that its lists leave out. */
const LINEAGE_DEPTH = 8

interface Row {
  id: string
  title: string | null
  status: string
  scope: string
  parent_id?: string | null
  origin_task_id?: string | null
  updated_at?: string
  latest_note?: { text: string; at: string } | null
  properties?: {
    display_title?: string
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

  const list = async (brain: Pick<EmlApi, 'get'>, status: string, extra: Record<string, string | number> = {}) => {
    const query: Record<string, string | number> = { type: 'task', status, with_parent: 'true', with_latest_note: 'true', limit: OPEN_LIMIT, ...extra }
    try {
      return ((await brain.get('/list', query)) as { engrams?: Row[] }).engrams ?? []
    } catch (err) {
      // A brain server from before with_origin / with_latest_note refuses the parameter: the tasks still
      // count, without origins and status lines.
      deps.log(`[board] /list with_origin/with_latest_note failed (${(err as Error).message}); listing without them`)
      const { with_origin: _origin, with_latest_note: _note, ...plain } = query
      return ((await brain.get('/list', plain).catch(() => ({ engrams: [] }))) as { engrams?: Row[] }).engrams ?? []
    }
  }

  const projectOf = (scope: string) => scope.startsWith('project.') ? scope.slice('project.'.length) : null

  /** One task by id with its parent and origin read from its relations; null when it can't be read. */
  const fetchLineage = async (brain: Pick<EmlApi, 'get'>, spaceId: string, id: string): Promise<LineageTask | null> => {
    const row = await brain.get(`/engram/${encodeURIComponent(id)}`, { with_relations: 'true' }).catch(() => null) as
      | (Row & { type?: string; relations?: Array<{ relation: string; source_id: string; target_id: string; target_engram?: { type?: string } }> })
      | null
    if (!row || row.type !== 'task') return null
    const outgoing = (row.relations ?? []).filter((r) => r.source_id === id)
    return {
      id,
      spaceId,
      project: projectOf(row.scope),
      title: row.title ?? id,
      ...(row.properties?.display_title ? { displayTitle: row.properties.display_title } : {}),
      status: row.status,
      parentId: outgoing.find((r) => r.relation === 'part_of')?.target_id ?? null,
      originId: outgoing.find((r) => r.relation === 'derived_from' && r.target_engram?.type === 'task')?.target_id ?? null,
    }
  }

  /** The closed ancestors of the space's tasks with a session that the lists left out, up to LINEAGE_DEPTH. */
  const missingAncestors = async (brain: Pick<EmlApi, 'get'>, spaceId: string, tasks: BoardTask[]): Promise<LineageTask[]> => {
    const known = new Set(tasks.map((t) => t.id))
    const found: LineageTask[] = []
    let wanted = tasks.filter((t) => t.sessionIds.length > 0).flatMap((t) => [t.parentId, t.originId])
    for (let depth = 0; depth < LINEAGE_DEPTH; depth++) {
      const ids = [...new Set(wanted.filter((id): id is string => !!id && !known.has(id)))]
      if (ids.length === 0) break
      ids.forEach((id) => known.add(id))
      const next = (await Promise.all(ids.map((id) => fetchLineage(brain, spaceId, id)))).filter((t): t is LineageTask => t !== null)
      found.push(...next)
      wanted = next.flatMap((t) => [t.parentId, t.originId])
    }
    return found
  }

  const objects = async (brain: Pick<EmlApi, 'get'>, object: string) =>
    ((await brain.get(`/object/${object}`).catch(() => ({ objects: [] }))) as { objects?: Array<Record<string, unknown>> }).objects ?? []

  /** A pending command's effect on the task, shown before it is applied. */
  const overlay = (row: Row, command: TaskCommand | undefined, agents: string[]): Row => {
    if (!command || command.state !== 'pending') return row
    if (command.kind === 'review') return { ...row, status: 'resolved', updated_at: command.createdAt || row.updated_at }
    if (command.kind === 'close') return { ...row, status: 'invalidated' }
    if (command.kind === 'hand_over' && command.handOver) {
      const props = row.properties ?? {}
      const planned = planHandOver({ id: row.id, status: row.status, owner: props.assignee_ids?.[0], delegate: props.delegate, checkpoint: props.checkpoint, waitingOn: props.waiting_on }, command.handOver, { agents })
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
    const board: Board = { at: new Date(now).toISOString(), viewer: deps.viewer, spaces: [], projects: [], tasks: [], lineage: [], inbox: [], snoozed: [], events: [], counts: { needsYou: 0, inbox: 0 } }
    const inboxTasks: Parameters<typeof inboxItems>[0] = []

    for (const space of deps.spaces()) {
      const brain = deps.brain(space)
      const agents = brain ? (await objects(brain, 'agent')).map((a) => String(a.id)) : []
      board.spaces.push({ id: space.id, name: space.name, agents })
      if (!brain) continue
      for (const p of await objects(brain, 'project')) {
        board.projects.push({ spaceId: space.id, id: String(p.id), name: String(p.name ?? p.id), goal: typeof p.goal === 'string' ? p.goal : null })
      }
      const origins = { with_origin: 'true' }
      const [planned, active, resolved] = await Promise.all([
        list(brain, 'planned', origins), list(brain, 'active', origins), list(brain, 'resolved', { order_by: 'updated_at', limit: RESOLVED_LIMIT, ...origins }),
      ])
      const rows = [...planned, ...active, ...resolved].map((row) => overlay(row, commandOf(row.id), agents))
      const statusOf = new Map(rows.map((r) => [r.id, r.status]))

      const spaceTasks: BoardTask[] = []
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
        const live: LiveFacts = { working: sessions.some((s) => s.working), sessions: sessions.length, nextRunAt: deps.nextRunOf(row.id) }
        const turn = turnOf(facts, live, deps.viewer, now)
        if (turn === null) continue
        const stepsWaiting = rows.filter((r) => r.parent_id === row.id && r.status === 'planned').length
        const command = commandOf(row.id)
        const parentId = row.parent_id ?? null
        const originId = row.origin_task_id ?? null
        spaceTasks.push({
          id: row.id,
          spaceId: space.id,
          spaceName: space.name,
          project: projectOf(row.scope),
          title: row.title ?? row.id,
          ...(props.display_title ? { displayTitle: props.display_title } : {}),
          ...(() => { const line = statusLine(row.latest_note); return line ? { statusLine: line } : {} })(),
          status: row.status,
          parentId,
          originId,
          rel: parentId ? 'sub' : originId ? 'spun' : null,
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
          sessionIds: sessions.map((s) => s.sessionId),
          working: live.working,
          nextRunAt: live.nextRunAt,
          ...(() => {
            const agent = !facts.delegate && row.status !== 'resolved' ? deps.releasedAgent?.(row.id) : null
            return agent ? { handTo: agent } : {}
          })(),
          ...(command && Date.parse(command.undoUntil) >= now ? { pending: { opId: command.opId, kind: command.kind, undoUntil: command.undoUntil } } : {}),
        })
        if (row.status !== 'resolved') inboxTasks.push({ id: row.id, space: space.id, title: props.display_title ?? row.title ?? row.id, waitingOn: props.waiting_on })
      }
      board.tasks.push(...spaceTasks)
      board.lineage.push(...await missingAncestors(brain, space.id, spaceTasks))
    }

    const inbox = inboxItems(inboxTasks, deps.viewer, deps.snoozes(), now)
    board.inbox = inbox.live
    board.snoozed = inbox.snoozed
    board.counts = { needsYou: board.tasks.filter((t) => t.turn === 'needs_you').length, inbox: inbox.live.length }

    // What moved since the last refresh; the first build only records where everything stands.
    const changes: BoardEvent[] = []
    const seen = new Set<string>()
    for (const t of board.tasks) {
      const key = `${t.spaceId}/${t.id}`
      seen.add(key)
      if (turns.has(key) && turns.get(key) !== t.turn) changes.push({ at: board.at, taskId: t.id, spaceId: t.spaceId, from: turns.get(key) ?? null, to: t.turn })
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
