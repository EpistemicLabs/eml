import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace } from '../brain-space.js'
import type { OwnSessionView } from './continue-session.js'
import { planHandOver } from '../domain/hand-over.js'
import { holdsSlot, isStandaloneRunnerTask, newestStart, runnerBlock, type GateTask, type RunnerBlock } from '../domain/runner-gate.js'
import { isStale, liveFactsOf, openRunsByTask, runsOf, sessionOfRun, type RunFacts } from '../domain/runs.js'
import { lastStartsOf, requestOpen, type DelegationFields, type ScheduleFields } from '../domain/delegation.js'
import { runComingAt, scheduleOf, type ScheduleFacts } from '../domain/task-schedule.js'
import { JOB_LIMITS } from '../domain/job.js'
import { reviewsOn, urgentWaitOf, waitsOf, withoutWaits } from '../domain/task-waits.js'
import { inboxItems, type InboxItem, type Snooze, type StallTask } from '../domain/inbox.js'
import { stepsSummary, type StepCover, type StepFacts, type StepsSummary } from '../domain/step-cover.js'
import { statusLine, type StatusLine } from '../domain/status-line.js'
import { taskNameOf } from '../domain/task-title.js'
import type { TaskWaitsSeen } from '../domain/session-attention.js'
import type { RunningCommand } from '../domain/session-runtime.js'
import {
  coverageOf, isImportant, turnOf, urgencyOf,
  type Coverage, type LiveFacts, type NobodyReason, type TaskFacts, type Turn, type TurnGroup, type WaitingOn,
} from '../domain/task-turn.js'
import type { ReopenItem, TaskCommand } from './task-commands.js'
import { namedReplacement, replacingIds, type ReplaceableTask } from '../domain/task-replacement.js'

/**
 * The task board's read model (decision whose-turn-derived-in-cockpit-host): the open tasks of every
 * space with their turn, coverage and urgency, the Inbox, and what changed. The brain holds the
 * tasks, the host what runs on them; this joins both once, so Inbox, Now, Plan, the sidebar and the
 * header all count the same thing.
 *
 * The board covers every space. It refreshes when a brain's log head moves (watch: a long poll on each space's
 * GET /head; decision task-board-live-updates-via-brain-log-head), after every command and after a turn ended, and
 * on a slow timer as a safety net. Whenever the board comes out different, onChange tells the pages (the SSE
 * `tasks` event), with the turns that moved.
 *
 * A space whose brain does not answer a build (a timeout, no connection, a server error) keeps what its brain gave
 * last and is marked stale: a brain that is slow or restarting must not read as a space without tasks.
 */

export interface BoardTask {
  /**
   * Its schedule (the task's schedule field, domain/task-schedule.ts): repeating times, a wake-up with who it is for
   * (by), paused or not. Only on an open task.
   */
  schedule?: ScheduleFields
  /** Its ended sessions, newest first, at most EARLIER_RUNS, on every member's cockpit. */
  earlierRuns?: EarlierRun[]
  /** What has to be true for it to be done (the task's goal). */
  goal?: string
  runs?: BoardRun[]
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
  /**
   * A planned delegated task the runner does not start: why (domain/runner-gate.ts, the runner's own checks). A wait
   * on a step names where that step stands, so the card can say "waits for your review of …".
   */
  runner?: BoardRunnerBlock
  coverage: Coverage
  urgency: number
  important: boolean
  sessionIds: string[]
  working: boolean
  nextRunAt: string | null
  /**
   * It has a schedule (domain/task-schedule.ts hasSchedule), also a paused one. With repeating times Looks good approves
   * one run, and it closes with End schedule; a wake-up alone ends with the task. Not the runner's `scheduled`, which
   * is a run coming up.
   */
  hasSchedule: boolean
  /**
   * New channel addresses of the task wait for the user's OK on this cockpit (its record's pendingApproval): until
   * then the channel does not wake it. The card and the Plan row say so; the OK is given in the panel's Schedule section.
   */
  needsOk?: true
  /** Work on it now ended and released this agent: the board offers "Hand to <agent>". Only while nobody is delegated. */
  handTo?: string
  /**
   * The task's own open session (domain/own-session.ts): Take over opens it, and Delegate continues it when `continues`
   * (else, or with Start fresh, a new session starts).
   */
  ownSession?: OwnSessionView
  /** A command on it still in its undo window. */
  pending?: { opId: string; kind: TaskCommand['kind']; undoUntil: string }
  /** Reopened on the board: the decisions and notes that closed with it, which come back only through the chat. */
  reopenedWith?: ReopenItem[]
  /** Background shells its sessions here started that still run, oldest first: their session goes on when they end. */
  commands?: RunningCommand[]
  /**
   * Its open steps (domain/step-cover.ts): each with what covers it, covered first. With all of them covered it waits on
   * its steps (group steps); while any is open, Looks good is not offered and a review asked of it is held back.
   */
  steps?: { open: StepCover[]; covered: boolean }
}

/** Where a step another task waits for stands, as the board shows it. */
export interface StepState {
  turn: Turn | null
  group?: TurnGroup
  reason?: NobodyReason
  owner?: string
  delegate?: string
  waitingOn?: WaitingOn
}

export type BoardRunnerBlock = Exclude<RunnerBlock, { kind: 'depends' }> | (Extract<RunnerBlock, { kind: 'depends' }> & { step?: StepState })

/**
 * A closed task (resolved, dropped or replaced) for the panel's Reopen and ⌘K: the latest CLOSED_LIMIT of each
 * status. `blocked` says up front why Reopen would be refused, as far as the lists show it; the host checks again.
 */
export interface ClosedTask {
  id: string
  spaceId: string
  spaceName: string
  project: string | null
  title: string
  displayTitle?: string
  status: string
  closedAt: string | null
  outcome?: string
  owner?: string
  delegate?: string
  checkpoint?: string
  stage?: string
  parentId: string | null
  originId: string | null
  sessionIds: string[]
  blocked?: 'superseded' | 'parent_closed'
  /** A replaced task: the task that replaced it (an open one when there is one), where its work and sessions went on. */
  replacedBy?: string
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

/** One page of a project's closed tasks, newest first, for the tasks card's Show done (GET /api/v1/tasks/closed); `more` when older ones are left. */
export interface ClosedPage {
  tasks: ClosedTask[]
  more: boolean
}

/** Why closed() has no page: no such space, its brain is not there right now, or the brain did not answer. */
export type ClosedAnswer = { ok: true; page: ClosedPage } | { ok: false; refusal: 'unknown_space' | 'no_brain' | 'brain_unavailable' }

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
  /** `stale`: the space's brain did not answer the last build; what the board shows of it is its last state. */
  spaces: Array<{ id: string; name: string; agents: string[]; stale?: true }>
  projects: Array<{ spaceId: string; id: string; name: string; goal: string | null }>
  tasks: BoardTask[]
  /** Closed tasks, newest first per space: what the panel can reopen and ⌘K finds. */
  closed: ClosedTask[]
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
  /** The sessions on a task that are not put away, and the background shells each started that still run. */
  sessionsOn(taskId: string): Array<{ sessionId: string; working: boolean; commands?: RunningCommand[] }>
  snoozes(): Snooze[]
  pendingCommands(): TaskCommand[]
  /** The agent released when Work on it now on the task ended (application/task-commands.ts releasedAgent). */
  releasedAgent?(taskId: string): string | null
  /** The task's own open session, and whether a delegation would continue it (domain/own-session.ts). */
  ownSessionOf?(taskId: string): OwnSessionView | null
  /** The items the task's latest board reopen listed for the chat (application/task-commands.ts reopenedWith). */
  reopenedWith?(taskId: string): ReopenItem[]
  /** The runner's busy check: a session works on the task already, here or in another member's run (index.ts shares it with the runner). */
  runnerBusy?(taskId: string, runs?: readonly RunFacts[]): boolean
  /** The runner's held check: an undoable hand-over, the owner works on it with the agent, or a worker is about to start on it. */
  runnerHeld?(taskId: string, requestedAt?: string | null): boolean
  /** When the runner last started the task (application/task-runner.ts startedAt), before its run is in the brain. */
  runnerStartedAt?(taskId: string): number | null
  /** Every session the ledger links to the task, put away or not: a closed task's chat shows its last one. */
  ledgerSessionsOn?(taskId: string): string[]
  /** The replaced tasks a build read: their live sessions go on at the replacement (application/follow-replacement.ts). */
  replaced?(taskIds: string[]): void
  /**
   * What this cockpit's record of the task says of its schedule (domain/job.ts): the cursor, the wake-up it fired, a
   * run that waits to start. Without it the next run is the schedule's next time ahead.
   */
  scheduleFacts?(taskId: string): ScheduleFacts
  now(): number
  log(line: string): void
  /**
   * The newest seq of the space's op log (brain GET /head): at once when `after` is null, else once it differs
   * from `after` or `waitMs` ran out. A brain without /head answers 404 (a server from before it) or 501 with
   * body.code NO_LOG; any other error is worth another try.
   */
  head?(space: BrainSpace, after: number | null, waitMs: number): Promise<number>
}

/** How the watch runs (watch()). */
export interface WatchOptions {
  /** Watch only while a page asked for the board within this long. */
  viewedMs: number
  /** How often a brain without /head is asked for its newest task instead. */
  probeMs?: number
  /** How long a space checks its newest task before it tries /head again (the brain may have been updated). */
  headRetryMs?: number
  /** How long the watch rests while nobody looks, or after a failed call (doubling up to WATCH_REST_MAX_MS). */
  restMs?: number
  /** Writes that arrive within this long make one refresh. */
  settleMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** How long one long poll on a brain's /head waits. */
const HEAD_WAIT_MS = 25_000
/** The longest the watch rests between two tries on a brain that does not answer: it is back within seconds of the brain. */
const WATCH_REST_MAX_MS = 10_000
const MAX_EVENTS = 40
const OPEN_LIMIT = 500
const RESOLVED_LIMIT = 50
/** How many dropped (invalidated) and replaced (superseded) tasks per space the board keeps for Reopen and ⌘K. */
const CLOSED_LIMIT = 50
const CLOSED_STATUSES = new Set(['resolved', 'invalidated', 'superseded'])
const OPEN_STATUSES = new Set(['planned', 'active'])

/** The newest of a task's last update and its open runs' last activity: when something last happened on it. */
function lastActivityOf(updatedAt: string | undefined, runs: readonly RunFacts[]): string | null {
  const times = [updatedAt, ...runs.map((r) => r.last_activity_at ?? r.started_at)].filter((t): t is string => typeof t === 'string' && Number.isFinite(Date.parse(t)))
  return times.length ? times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : null
}
/** The most closed tasks of one project a page may ask for at once. */
const CLOSED_MAX = 500
/** How far up a tree the board follows closed ancestors that its lists leave out. */
const LINEAGE_DEPTH = 8

interface Row {
  id: string
  title: string | null
  status: string
  scope: string
  ingested_by?: string | null
  parent_id?: string | null
  origin_task_id?: string | null
  updated_at?: string
  latest_note?: { text: string; at: string } | null
  properties?: {
    display_title?: string
    assignee_ids?: string[]
    delegate?: string
    checkpoint?: string
    delegation?: DelegationFields; schedule?: ScheduleFields | null
    goal?: string
    priority?: string
    due_date?: string
    depends_on?: string[]
    waits?: unknown
    waiting_on?: WaitingOn
    outcome?: string
    stage?: string
  }
}

/** A run as the board shows it: whose, its state, when it was last active, and whether it is this cockpit's. */
export interface BoardRun {
  /** The session's id (a later run of the same session has an id of its own, domain/runs.ts). */
  id: string
  member: string
  agent: string | null
  state: 'running' | 'idle' | 'stale'
  lastActivityAt: string | null
  here: boolean
}

/** How many ended sessions of a task the board sends. */
export const EARLIER_RUNS = 10

/** An ended session on a task: whose, when, how it ended and its last result line; this member's can be reopened here. */
export interface EarlierRun {
  /** The session's id. */
  id: string
  member: string
  agent: string | null
  startedAt: string | null
  endedAt: string | null
  endReason: string | null
  result: string | null
  here: boolean
}

/**
 * The ended sessions per task from the newest runs the brain listed (newest first per task), by session: a session
 * counts by its newest run (domain/runs.ts sessionOfRun), so one whose newest run is still open is not an earlier one.
 */
function earlierRunsByTask(objects: ReadonlyArray<Record<string, unknown>>, viewer: string): Map<string, EarlierRun[]> {
  const byTask = new Map<string, EarlierRun[]>()
  const seen = new Set<string>()
  for (const r of runsOf(objects)) {
    const sessionId = sessionOfRun(r.id)
    if (seen.has(`${r.task_id}:${sessionId}`)) continue
    seen.add(`${r.task_id}:${sessionId}`)
    if (r.state !== 'ended') continue
    const o = r as RunFacts & { ended_at?: string | null; end_reason?: string | null }
    const list = byTask.get(r.task_id) ?? []
    if (list.length >= EARLIER_RUNS) continue
    list.push({ id: sessionId, member: r.member, agent: r.agent ?? null, startedAt: r.started_at ?? null, endedAt: o.ended_at ?? null, endReason: o.end_reason ?? null, result: r.result ?? null, here: r.member === viewer })
    byTask.set(r.task_id, list)
  }
  return byTask
}

/** The task's open runs for the board, running first, then by last activity (the panel orders its tabs by attention). */
function boardRuns(runs: readonly RunFacts[], local: ReadonlyArray<{ sessionId: string }>, viewer: string, now: number): BoardRun[] {
  const localIds = new Set(local.map((s) => s.sessionId))
  return runs
    .filter((r) => r.state !== 'ended')
    .map((r) => ({
      id: sessionOfRun(r.id), member: r.member, agent: r.agent ?? null,
      state: isStale(r, now) ? 'stale' as const : r.state === 'running' ? 'running' as const : 'idle' as const,
      lastActivityAt: r.last_activity_at ?? null,
      here: localIds.has(sessionOfRun(r.id)) || r.member === viewer,
    }))
    .sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))
}

/** What the board holds of one space: built as one, so a brain that does not answer leaves the space as it was. */
interface SpaceSlice {
  space: Board['spaces'][number]
  projects: Board['projects']
  tasks: BoardTask[]
  closed: ClosedTask[]
  lineage: LineageTask[]
  inboxTasks: Parameters<typeof inboxItems>[0]
  /** Main tasks with stalled steps, for their owners' Inbox. */
  stallTasks: StallTask[]
  /** Per task it read, open or closed: whether it is open and the sessions its waits came from (TaskBoard.waitsSeen). */
  waits: Map<string, { open: boolean; sessions: ReadonlySet<string> }>
  /** When the build that read `waits` started (ISO): a wait written later may be missing from it. */
  readAt: string
}

/** A read of a space's brain that got no answer (a timeout, no connection, a server error): the space keeps its last state. */
class BrainUnreachable extends Error {}

/**
 * True when the brain answered and refused the read (a 4xx): an older server without the route or the parameter, or
 * an engram that is not there. Anything else — a timeout, no connection, a 5xx — is a brain that did not answer.
 */
const refused = (err: unknown): boolean => {
  const status = (err as { status?: unknown } | null)?.status
  return typeof status === 'number' && status >= 400 && status < 500
}

/** The read's answer, `fallback` when the brain refused it; a brain that did not answer is BrainUnreachable. */
const orWhenRefused = <T, F>(read: Promise<T>, fallback: F): Promise<T | F> =>
  read.catch((err) => {
    if (refused(err)) return fallback
    throw new BrainUnreachable((err as Error)?.message ?? String(err))
  })

export function createTaskBoard(deps: TaskBoardDeps) {
  let current: Board | null = null
  let refreshing: Promise<Board> | null = null
  /** A refresh asked for while one ran: it starts when that one ends, so it sees writes the running one may miss. */
  let queued: Promise<Board> | null = null
  /** What the pages saw last (signature()); a build that differs tells them. */
  let shown: string | null = null
  let askedAt = -Infinity
  /** Each space as its brain gave it last: what the board shows while that brain does not answer. */
  const slices = new Map<string, SpaceSlice>()
  /** The spaces whose brain did not answer the last build: said once when it starts, once when it ends. */
  const unreachable = new Set<string>()
  const turns = new Map<string, Turn | null>()
  let events: BoardEvent[] = []
  const listeners = new Set<(events: BoardEvent[]) => void>()

  /**
   * The tasks that replaced a task (the sources of its `supersedes` relations), read once per task: a replaced task stays
   * replaced, so its first answer holds until the host restarts. A read that fails is tried again next build.
   */
  const replacing = new Map<string, Promise<string[]>>()
  const replacingOf = (brain: Pick<EmlApi, 'get'>, id: string): Promise<string[]> => {
    const known = replacing.get(id)
    if (known) return known
    const read = (brain.get(`/engram/${encodeURIComponent(id)}`, { with_relations: 'true' }) as Promise<ReplaceableTask>)
      .then((task) => replacingIds({ ...task, id }))
      .catch(() => { replacing.delete(id); return [] as string[] })
    replacing.set(id, read)
    return read
  }

  /** What replaced each of these replaced rows, as the panel names it. */
  const replacedByOf = async (brain: Pick<EmlApi, 'get'>, rows: readonly Row[], isOpen: (id: string) => boolean) =>
    new Map(await Promise.all(rows.filter((r) => r.status === 'superseded').map(async (r) => [r.id, namedReplacement(await replacingOf(brain, r.id), isOpen)] as const)))

  const list = async (brain: Pick<EmlApi, 'get'>, status: string, extra: Record<string, string | number> = {}) => {
    const query: Record<string, string | number> = { type: 'task', status, with_parent: 'true', with_latest_note: 'true', limit: OPEN_LIMIT, ...extra }
    try {
      return ((await brain.get('/list', query)) as { engrams?: Row[] }).engrams ?? []
    } catch (err) {
      // Only a refusal is worth a second try: a brain that did not answer the first would not answer it either.
      if (!refused(err)) throw new BrainUnreachable((err as Error)?.message ?? String(err))
      // A brain server from before with_origin / with_latest_note refuses the parameter: the tasks still
      // count, without origins and status lines.
      deps.log(`[board] /list with_origin/with_latest_note failed (${(err as Error).message}); listing without them`)
      const { with_origin: _origin, with_latest_note: _note, ...plain } = query
      return ((await orWhenRefused(brain.get('/list', plain), { engrams: [] })) as { engrams?: Row[] }).engrams ?? []
    }
  }

  const projectOf = (scope: string) => scope.startsWith('project.') ? scope.slice('project.'.length) : null

  /** One task by id with its parent and origin read from its relations; null when it can't be read. */
  const fetchLineage = async (brain: Pick<EmlApi, 'get'>, spaceId: string, id: string): Promise<LineageTask | null> => {
    const row = await orWhenRefused(brain.get(`/engram/${encodeURIComponent(id)}`, { with_relations: 'true' }), null) as
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
    ((await orWhenRefused(brain.get(`/object/${object}`), { objects: [] })) as { objects?: Array<Record<string, unknown>> }).objects ?? []

  /** The task's schedule, whoever's cockpit fires it. A closed task has none: nothing fires there, so it shows no next run. */
  const scheduleOfRow = (row: Row) => (row.status === 'planned' || row.status === 'active' ? scheduleOf(row) : null)
  /**
   * The task's next run: its schedule's, read with what this cockpit's record knows (domain/task-schedule.ts
   * runComingAt). A time that is due and not fired yet, and a run that waits for room, still count: the time shown is
   * then the one it was due at.
   */
  const nextRunOfRow = (row: Row, now: number) => {
    const open = row.status === 'planned' || row.status === 'active'
    return open ? runComingAt(scheduleOfRow(row), deps.scheduleFacts?.(row.id) ?? {}, now, JOB_LIMITS.lateLimitMs) : null
  }

  /** A pending command's effect on the task, shown before it is applied. */
  const overlay = (row: Row, command: TaskCommand | undefined, agents: string[]): Row => {
    if (!command || command.state !== 'pending') return row
    if (command.kind === 'review' && (command.runOnly || (scheduleOf(row)?.crons?.length ?? 0) > 0)) {
      // A routine: the review approves that run and the task stays open, without the reviews it answers.
      const props = row.properties ?? {}
      const all = waitsOf(props)
      const waits = withoutWaits(all, command.approves ?? reviewsOn(all, deps.viewer))
      return { ...row, properties: { ...props, waits: waits.length > 0 ? waits : undefined, waiting_on: urgentWaitOf({ waits }) } }
    }
    if (command.kind === 'review' || command.kind === 'end_schedule') return { ...row, status: 'resolved', updated_at: command.createdAt || row.updated_at }
    if (command.kind === 'close') return { ...row, status: 'invalidated' }
    if (command.kind === 'reopen') {
      const { waiting_on: _wait, outcome: _outcome, ...props } = row.properties ?? {}
      return { ...row, status: 'active', properties: props }
    }
    if (command.kind === 'hand_over' && command.handOver) {
      const props = row.properties ?? {}
      // Planned as the command will be applied (application/task-commands.ts): with the task's name and goal.
      const planned = planHandOver({
        id: row.id, status: row.status, title: row.title, ...(props.display_title ? { displayTitle: props.display_title } : {}), ...(props.goal ? { goal: props.goal } : {}),
        owner: props.assignee_ids?.[0], delegate: props.delegate, checkpoint: props.checkpoint, waits: waitsOf(props), ...(props.delegation ? { delegation: props.delegation } : {}),
        ...(props.schedule ? { schedule: props.schedule } : {}),
      }, command.handOver, { agents, now: command.createdAt || new Date(deps.now()).toISOString() })
      if (!planned.ok) return row
      const { status, waits, delegation, schedule } = planned.plan.patch
      const next = { ...props } as NonNullable<Row['properties']>
      if (schedule !== undefined) next.schedule = schedule
      // The flat fields follow the delegation, as core keeps them (packages/core task-state.ts).
      if (delegation === null) { delete next.delegation; delete next.delegate; delete next.checkpoint }
      if (delegation) { next.delegation = delegation; next.delegate = delegation.agent; if (delegation.checkpoint) next.checkpoint = delegation.checkpoint; else delete next.checkpoint }
      if (waits !== undefined) {
        next.waits = waits ?? undefined
        next.waiting_on = urgentWaitOf({ waits: waits ?? [] })
      }
      return { ...row, ...(status ? { status } : {}), properties: next }
    }
    return row
  }

  /** A closed row as the panel's Reopen and ⌘K read it; `isOpen` says whether its parent is open (the host checks again). */
  const closedTaskOf = (row: Row, space: BrainSpace, isOpen: (id: string) => boolean, command: TaskCommand | undefined, now: number, replacedBy: string | null): ClosedTask => {
    const props = row.properties ?? {}
    const blocked = row.status === 'superseded' ? 'superseded' as const : row.parent_id && !isOpen(row.parent_id) ? 'parent_closed' as const : undefined
    return {
      id: row.id, spaceId: space.id, spaceName: space.name, project: projectOf(row.scope), title: row.title ?? row.id,
      ...(props.display_title ? { displayTitle: props.display_title } : {}),
      status: row.status, closedAt: row.updated_at ?? null,
      ...(props.outcome ? { outcome: props.outcome } : {}),
      ...(props.assignee_ids?.[0] ? { owner: props.assignee_ids[0] } : {}),
      ...(props.delegate ? { delegate: props.delegate } : {}),
      ...(props.checkpoint ? { checkpoint: props.checkpoint } : {}),
      ...(props.stage ? { stage: props.stage } : {}),
      parentId: row.parent_id ?? null, originId: row.origin_task_id ?? null,
      sessionIds: deps.ledgerSessionsOn?.(row.id) ?? deps.sessionsOn(row.id).map((s) => s.sessionId),
      ...(blocked ? { blocked } : {}),
      ...(replacedBy ? { replacedBy } : {}),
      ...(command && Date.parse(command.undoUntil) >= now ? { pending: { opId: command.opId, kind: command.kind, undoUntil: command.undoUntil } } : {}),
    }
  }

  const build = async (): Promise<Board> => {
    const now = deps.now()
    const pending = deps.pendingCommands()
    const commandOf = (taskId: string) => pending.filter((c) => c.taskId === taskId).at(-1)
    const board: Board = { at: new Date(now).toISOString(), viewer: deps.viewer, spaces: [], projects: [], tasks: [], closed: [], lineage: [], inbox: [], snoozed: [], events: [], counts: { needsYou: 0, inbox: 0 } }
    const inboxTasks: Parameters<typeof inboxItems>[0] = []
    const stallTasks: StallTask[] = []

    /** One space from its brain. Throws BrainUnreachable when a read got no answer: half a space would read as tasks gone. */
    const buildSpace = async (space: BrainSpace, brain: Pick<EmlApi, 'get'>): Promise<SpaceSlice> => {
      const agents = (await objects(brain, 'agent')).map((a) => String(a.id))
      const slice: SpaceSlice = { space: { id: space.id, name: space.name, agents }, projects: [], tasks: [], closed: [], lineage: [], inboxTasks: [], stallTasks: [], waits: new Map(), readAt: new Date(now).toISOString() }
      for (const p of await objects(brain, 'project')) {
        slice.projects.push({ spaceId: space.id, id: String(p.id), name: String(p.name ?? p.id), goal: typeof p.goal === 'string' ? p.goal : null })
      }
      const origins = { with_origin: 'true' }
      const latest = { order_by: 'updated_at', ...origins }
      const [planned, active, resolved, invalidated, superseded] = await Promise.all([
        list(brain, 'planned', origins), list(brain, 'active', origins), list(brain, 'resolved', { ...latest, limit: RESOLVED_LIMIT }),
        list(brain, 'invalidated', { ...latest, limit: CLOSED_LIMIT }), list(brain, 'superseded', { ...latest, limit: CLOSED_LIMIT }),
      ])
      const rows = [...planned, ...active, ...resolved, ...invalidated, ...superseded].map((row) => overlay(row, commandOf(row.id), agents))
      // What a task's facts read of the others: open and resolved ones, as before closed tasks were listed.
      const statusOf = new Map(rows.filter((r) => r.status === 'planned' || r.status === 'active' || r.status === 'resolved').map((r) => [r.id, r.status]))
      const isOpen = (id: string) => { const status = statusOf.get(id); return status === 'planned' || status === 'active' }
      for (const r of rows) {
        const sessions = new Set(waitsOf(r.properties).map((w) => w.session_id || w.id))
        slice.waits.set(r.id, { open: isOpen(r.id), sessions })
      }
      // Replaced tasks: what replaced each (an open one first), and their live sessions go on there.
      const replacedBy = await replacedByOf(brain, superseded, isOpen)
      if (superseded.length > 0) deps.replaced?.(superseded.map((r) => r.id))
      // Synced runs that are not ended: sessions on other members' cockpits too (domain/runs.ts).
      const runs = openRunsByTask(runsOf(await objects(brain, 'run')))
      // When each task's newest run started: a delegation request is open while none started after it (domain/delegation.ts).
      // The newest runs of each task: the first is what a delegation request is checked against, the ended ones are its earlier sessions.
      const latestRuns = ((await orWhenRefused(brain.get('/object/run', { latest: String(EARLIER_RUNS + 1) }), { objects: [] })) as { objects?: Array<Record<string, unknown>> }).objects ?? []
      const lastStarts = lastStartsOf(latestRuns)
      const earlier = earlierRunsByTask(latestRuns, deps.viewer)

      // What the runner's checks read: the space's tasks, and any the lists left out fetched once by id.
      const byId = new Map(rows.map((r) => [r.id, r as GateTask]))
      const fetched = new Map<string, Promise<GateTask | null>>()
      const gateTask = (id: string): Promise<GateTask | null> => {
        const known = byId.get(id)
        if (known) return Promise.resolve(known)
        if (!fetched.has(id)) fetched.set(id, orWhenRefused(brain.get(`/engram/${encodeURIComponent(id)}`) as Promise<GateTask & { type?: string }>, null).then((t) => t ?? null))
        return fetched.get(id)!
      }
      // The runner's cap groups: a parent's steps, and the space's standalone delegated tasks, that hold a slot, counted as
      // the runner counts them (domain/runner-gate.ts holdsSlot).
      // Counted once per space: per parent, and under null for the standalone group.
      const slots = new Map<string | null, number>()
      for (const r of rows) {
        const group = r.parent_id ?? (isStandaloneRunnerTask(r) ? null : undefined)
        if (group === undefined || r.status !== 'active') continue
        const held = holdsSlot(r, {
          working: liveFactsOf(deps.sessionsOn(r.id), runs.get(r.id) ?? [], null, now).working,
          startedAt: newestStart(deps.runnerStartedAt?.(r.id), lastStarts.get(r.id)),
        }, { shared: space.shared, me: deps.viewer, now })
        if (held) slots.set(group, (slots.get(group) ?? 0) + 1)
      }
      const runningIn = (parentId: string | null) => slots.get(parentId) ?? 0
      const blockOf = async (row: Row): Promise<RunnerBlock | null> => {
        const parentId = row.parent_id ?? null
        return runnerBlock({
          task: row as GateTask,
          ...(parentId ? { parent: { id: parentId, task: await gateTask(parentId) } } : {}),
          deps: await Promise.all((row.properties?.depends_on ?? []).map(async (id) => ({ id, task: await gateTask(id) }))),
          running: runningIn(parentId),
          shared: space.shared, me: deps.viewer,
          busy: deps.runnerBusy?.(row.id, runs.get(row.id) ?? []) ?? false, lastRunStartedAt: lastStarts.get(row.id) ?? null, held: deps.runnerHeld?.(row.id, row.properties?.delegation?.requested_at ?? null) ?? false, scheduled: Boolean(nextRunOfRow(row, now)),
        })
      }

      // A main task's turn reads its open steps' turns (domain/step-cover.ts): each row is worked out once, its steps
      // before it. A loop in the parent links (bad data) ends at the step already on the path: it counts as not covered.
      const openSteps = new Map<string, Row[]>()
      for (const r of rows) {
        if (!r.parent_id || !OPEN_STATUSES.has(r.status)) continue
        openSteps.set(r.parent_id, [...(openSteps.get(r.parent_id) ?? []), r])
      }
      interface Evaluated { facts: TaskFacts; live: LiveFacts; schedule: ScheduleFields | null; turn: ReturnType<typeof turnOf>; steps: StepsSummary | null }
      const evaluated = new Map<string, Promise<Evaluated>>()
      const evaluate = (row: Row, path: ReadonlySet<string> = new Set()): Promise<Evaluated> => {
        const known = evaluated.get(row.id)
        if (known) return known
        const work = evaluateRow(row, new Set([...path, row.id]))
        evaluated.set(row.id, work)
        return work
      }
      const evaluateRow = async (row: Row, path: ReadonlySet<string>): Promise<Evaluated> => {
        const props = row.properties ?? {}
        const sessions = deps.sessionsOn(row.id)
        const facts: TaskFacts = {
          status: row.status,
          owner: props.assignee_ids?.[0],
          delegate: props.delegate,
          checkpoint: props.checkpoint,
          waitingOn: urgentWaitOf(props),
          priority: props.priority,
          due: props.due_date,
          closedAt: row.status === 'resolved' ? row.updated_at : undefined,
          // The board loads every open task, so a parent it does not hold is closed.
          parentActive: row.parent_id ? statusOf.get(row.parent_id) === 'active' : null,
        }
        if (requestOpen(row, lastStarts.get(row.id) ?? null)) {
          facts.requested = true
          facts.runner = await blockOf(row)
        }
        const children = OPEN_STATUSES.has(row.status) ? openSteps.get(row.id) ?? [] : []
        const stepFacts: StepFacts[] = []
        for (const child of children) {
          // A step already on the path (a loop in the links) is not covered.
          const step = path.has(child.id) ? null : await evaluate(child, path)
          stepFacts.push({
            id: child.id, name: child.properties?.display_title ?? child.title ?? child.id,
            turn: step?.turn ?? { turn: 'needs_you', group: 'nobody' },
            ...(child.properties?.delegate ? { delegate: child.properties.delegate } : {}),
            ...(step?.facts.waitingOn ? { waitingOn: step.facts.waitingOn } : {}),
            nextRunAt: step?.live.nextRunAt ?? null,
            ...(child.properties?.due_date ? { due: child.properties.due_date } : {}),
            lastActivity: lastActivityOf(child.updated_at, runs.get(child.id) ?? []),
          })
        }
        const steps = stepsSummary(stepFacts, now)
        if (steps) facts.steps = { open: steps.open.length, covered: steps.covered }
        const schedule = scheduleOfRow(row)
        const live: LiveFacts = { ...liveFactsOf(sessions, runs.get(row.id) ?? [], nextRunOfRow(row, now), now), schedule }
        return { facts, live, schedule, steps, turn: turnOf(facts, live, deps.viewer, now) }
      }

      const spaceTasks: BoardTask[] = []
      for (const row of rows) {
        const props = row.properties ?? {}
        const sessions = deps.sessionsOn(row.id)
        if (CLOSED_STATUSES.has(row.status)) {
          slice.closed.push(closedTaskOf(row, space, isOpen, commandOf(row.id), now, replacedBy.get(row.id) ?? null))
          if (row.status === 'superseded') continue
        }
        const { facts, live, schedule, turn, steps } = await evaluate(row)
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
          // A wait on someone or a job's next run already put it in its turn; the card needs the other reasons.
          ...(facts.runner && !['not_runner_work', 'waiting', 'scheduled'].includes(facts.runner.kind) ? { runner: facts.runner } : {}),
          coverage: coverageOf(facts, live, deps.viewer, now, stepsWaiting),
          urgency: urgencyOf(facts, live, deps.viewer, now),
          important: isImportant(facts, live, deps.viewer, now),
          // A closed task's sessions are put away (the router archives them as it closes): its chat still shows.
          sessionIds: CLOSED_STATUSES.has(row.status) ? deps.ledgerSessionsOn?.(row.id) ?? sessions.map((s) => s.sessionId) : sessions.map((s) => s.sessionId),
          working: live.working,
          nextRunAt: live.nextRunAt,
          hasSchedule: schedule !== null,
          ...(schedule ? { schedule } : {}),
          ...(!CLOSED_STATUSES.has(row.status) && deps.scheduleFacts?.(row.id).needsOk ? { needsOk: true as const } : {}),
          ...(props.goal ? { goal: props.goal } : {}),
          // Its open runs, on this cockpit and the other members', for the panel and the card (domain/runs.ts).
          ...(() => {
            const list = boardRuns(runs.get(row.id) ?? [], sessions, deps.viewer, now)
            return list.length ? { runs: list } : {}
          })(),
          ...(earlier.get(row.id)?.length ? { earlierRuns: earlier.get(row.id) } : {}),
          ...(() => {
            // Work on it now released an agent, or a delegation was never handed over (v0.23: no request, no schedule).
            const agent = !facts.delegate && row.status !== 'resolved' ? deps.releasedAgent?.(row.id)
              : turn.reason === 'not_handed_over' ? facts.delegate : null
            return agent ? { handTo: agent } : {}
          })(),
          ...(() => {
            const own = CLOSED_STATUSES.has(row.status) ? null : deps.ownSessionOf?.(row.id) ?? null
            return own ? { ownSession: own } : {}
          })(),
          ...(command && Date.parse(command.undoUntil) >= now ? { pending: { opId: command.opId, kind: command.kind, undoUntil: command.undoUntil } } : {}),
          ...(() => {
            const items = row.status === 'active' ? deps.reopenedWith?.(row.id) ?? [] : []
            return items.length ? { reopenedWith: items } : {}
          })(),
          ...(() => {
            const commands = CLOSED_STATUSES.has(row.status) ? [] : sessions.flatMap((s) => s.commands ?? []).sort((a, b) => a.since.localeCompare(b.since))
            return commands.length ? { commands } : {}
          })(),
          ...(steps ? { steps: { open: steps.open, covered: steps.covered } } : {}),
        })
        if (row.status !== 'resolved') {
          slice.inboxTasks.push({
            id: row.id, space: space.id, title: props.display_title ?? row.title ?? row.id, waits: waitsOf(props),
            ...(schedule?.at ? { wake: { at: schedule.at, by: schedule.by ?? null } } : {}),
            ...(schedule?.crons?.length ? { repeating: true } : {}),
            ...(steps ? { holdReviews: true } : {}),
          })
          if (steps?.stalls.length) slice.stallTasks.push({ id: row.id, space: space.id, ...(facts.owner ? { owner: facts.owner } : {}), stalls: steps.stalls })
        }
      }
      // A wait on a step names where that step stands, read from the step's own card.
      for (const t of spaceTasks) {
        if (t.runner?.kind !== 'depends') continue
        const step = spaceTasks.find((s) => s.id === (t.runner as { stepId: string }).stepId)
        if (step) {
          t.runner = { ...t.runner, step: {
            turn: step.turn,
            ...(step.group ? { group: step.group } : {}), ...(step.reason ? { reason: step.reason } : {}),
            ...(step.owner ? { owner: step.owner } : {}), ...(step.delegate ? { delegate: step.delegate } : {}),
            ...(step.waitingOn ? { waitingOn: step.waitingOn } : {}),
          } }
        }
      }
      slice.tasks = spaceTasks
      slice.lineage = await missingAncestors(brain, space.id, spaceTasks)
      return slice
    }

    for (const space of deps.spaces()) {
      const brain = deps.brain(space)
      let slice: SpaceSlice = { space: { id: space.id, name: space.name, agents: [] }, projects: [], tasks: [], closed: [], lineage: [], inboxTasks: [], stallTasks: [], waits: new Map(), readAt: new Date(now).toISOString() }
      if (brain) {
        try {
          slice = await buildSpace(space, brain)
          slices.set(space.id, slice)
          if (unreachable.delete(space.id)) deps.log(`[board] ${space.name}: its brain answers again`)
        } catch (err) {
          if (!(err instanceof BrainUnreachable)) throw err
          // A brain that does not answer is not a space without tasks: the space stays as its brain gave it last.
          if (!unreachable.has(space.id)) deps.log(`[board] ${space.name}: its brain did not answer (${err.message}); showing its last state`)
          unreachable.add(space.id)
          const last = slices.get(space.id)
          slice = { ...(last ?? slice), space: { ...(last ?? slice).space, name: space.name, stale: true } }
        }
      }
      board.spaces.push(slice.space)
      board.projects.push(...slice.projects)
      board.tasks.push(...slice.tasks)
      board.closed.push(...slice.closed)
      board.lineage.push(...slice.lineage)
      inboxTasks.push(...slice.inboxTasks)
      stallTasks.push(...(slice.stallTasks ?? []))
    }
    for (const id of [...slices.keys()]) if (!board.spaces.some((sp) => sp.id === id)) slices.delete(id)

    const inbox = inboxItems(inboxTasks, deps.viewer, deps.snoozes(), now, stallTasks)
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
    // Any difference counts — a new task, one that left, a new title or status line — not only a turn that moved.
    const looks = signature(board)
    const differs = shown !== null && looks !== shown
    shown = looks
    if (differs || changes.length > 0) for (const listener of listeners) listener(changes)
    return board
  }

  /**
   * Build the board now. A build that already runs may have read the brain before the write that asks for this
   * refresh, so the callers that come while it runs share one more build after it.
   */
  const refresh = (): Promise<Board> => {
    if (refreshing) {
      queued ??= refreshing.catch(() => null).then(() => { queued = null; return refresh() })
      return queued
    }
    const run = build().then((board) => { current = board; return board })
    const shared = run.finally(() => { if (refreshing === shared) refreshing = null })
    refreshing = shared
    return shared
  }

  // Writes come in bursts (a split creates a task, links it and starts a session): one refresh after they settle.
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  const refreshSoon = (settleMs: number) => {
    if (settleTimer) return
    settleTimer = setTimeout(() => {
      settleTimer = null
      refresh().catch((err) => deps.log(`[board] refresh failed: ${(err as Error).message}`))
    }, settleMs)
    settleTimer.unref?.()
  }

  /**
   * A project's newest closed tasks (done, dropped and replaced) up to `limit`, shaped like the board's `closed`, so
   * the panel can open one the board's lists leave out. Unlike the board's build, the answer is nothing but these
   * lists, so a brain that does not answer fails it instead of reading as "nothing closed".
   */
  const closed = async (spaceId: string, project: string, limit: number): Promise<ClosedAnswer> => {
    const space = deps.spaces().find((s) => s.id === spaceId)
    if (!space) return { ok: false, refusal: 'unknown_space' }
    const brain = deps.brain(space)
    if (!brain) return { ok: false, refusal: 'no_brain' }
    const want = Math.max(1, Math.min(CLOSED_MAX, Math.floor(limit)))
    // One more than asked, from each list: a list that has it says older ones are left.
    const query = { type: 'task', scope: `project.${project}`, order_by: 'updated_at', limit: want + 1, with_origin: 'true' }
    const strictList = async (status: string): Promise<Row[]> => {
      const rows = (q: Record<string, string | number>) => brain.get('/list', { ...q, status }).then((r) => (r as { engrams?: Row[] }).engrams ?? [])
      // A brain server from before with_origin refuses it: the tasks still list, without origins.
      return rows(query).catch(() => { const { with_origin: _origin, ...plain } = query; return rows(plain) })
    }
    let listed: Row[][]
    try {
      listed = await Promise.all([...CLOSED_STATUSES].map(strictList))
    } catch (err) {
      deps.log(`[board] closed tasks of ${spaceId}/${project} did not load: ${(err as Error).message}`)
      return { ok: false, refusal: 'brain_unavailable' }
    }
    const now = deps.now()
    const pending = deps.pendingCommands()
    const commandOf = (taskId: string) => pending.filter((c) => c.taskId === taskId).at(-1)
    // A Reopen still in its Undo window reads as open, as on the board.
    const rows = listed.flat().map((row) => overlay(row, commandOf(row.id), [])).filter((row) => CLOSED_STATUSES.has(row.status))
      .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
    // The board holds every open task: a parent it doesn't list as open is closed.
    const open = new Set((current?.tasks ?? []).filter((t) => t.spaceId === spaceId && (t.status === 'planned' || t.status === 'active')).map((t) => t.id))
    const page = rows.slice(0, want)
    const replacedBy = await replacedByOf(brain, page, (id) => open.has(id))
    const tasks = page.map((row) => closedTaskOf(row, space, (id) => open.has(id), commandOf(row.id), now, replacedBy.get(row.id) ?? null))
    return { ok: true, page: { tasks, more: rows.length > want } }
  }

  return {
    refresh,
    closed,

    /** The name a person reads for the task (domain/task-title.ts taskNameOf), from the last board; null when it holds none. */
    nameOf(taskId: string): string | null {
      // No board yet (no page asked since the start): build one, the page reloads its sessions once it is there.
      if (!current) {
        if (!refreshing) refresh().catch((err) => deps.log(`[board] refresh failed: ${(err as Error).message}`))
        return null
      }
      const task = current.tasks.find((t) => t.id === taskId) ?? current.closed.find((t) => t.id === taskId) ?? current.lineage.find((t) => t.id === taskId)
      return task ? taskNameOf(task) : null
    },

    /** The board, rebuilt when it is older than `maxAgeMs`; a build under way is waited for, not skipped. */
    async get(maxAgeMs: number): Promise<Board> {
      askedAt = deps.now()
      if (queued || refreshing) return (queued ?? refreshing)!
      if (current && deps.now() - Date.parse(current.at) <= maxAgeMs) return current
      return refresh()
    },

    /**
     * Where the board last read the task (domain/session-attention.ts attentionShown): open or not, and the sessions
     * its waits came from. `spaceId` null is the main space. Null when no build read the task (or its space).
     */
    waitsSeen(spaceId: string | null, taskId: string): TaskWaitsSeen | null {
      const space = deps.spaces().find((s) => (spaceId ? s.id === spaceId : s.main))
      const slice = space ? slices.get(space.id) : undefined
      const task = slice?.waits.get(taskId)
      return slice && task ? { ...task, at: slice.readAt } : null
    },

    /**
     * The task's open steps and whether every one is covered, from the last board; null when it has none or the board
     * holds no such task. An end_turn call reads it: a turn that waits on covered steps needs no check.
     */
    stepsOf(taskId: string): { open: number; covered: boolean } | null {
      const steps = current?.tasks.find((t) => t.id === taskId)?.steps
      return steps ? { open: steps.open.length, covered: steps.covered } : null
    },

    /** Whether the task is handed to an agent (it names a delegate), from the last board; null when it holds no such task. */
    delegated(taskId: string): boolean | null {
      const task = current?.tasks.find((t) => t.id === taskId) ?? current?.closed.find((t) => t.id === taskId)
      return task ? Boolean(task.delegate) : null
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

    /**
     * Watch every space's log head while a page looks, and refresh soon after it moves: one long poll per space on
     * GET /head, or — for a brain without it — its newest task every probeMs. Each space has its own loop, so a
     * slow or unreachable one holds up no other. Spaces that come and go are picked up within a few seconds.
     * A brain that stops answering is asked again every few seconds, and the board refreshes once when it is back.
     */
    watch(opts: WatchOptions): () => void {
      const probeMs = opts.probeMs ?? 2_000
      const headRetryMs = opts.headRetryMs ?? 5 * 60_000
      const restMs = opts.restMs ?? 2_000
      const settleMs = opts.settleMs ?? 150
      const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.() }))
      let stopped = false
      const running = new Set<string>()
      const viewed = () => deps.now() - askedAt <= opts.viewedMs

      const newestTask = async (space: BrainSpace): Promise<string> => {
        const brain = deps.brain(space)
        if (!brain) return ''
        const found = await brain.get('/list', { type: 'task', order_by: 'updated_at', limit: 1 }) as { engrams?: Array<{ id: string; updated_at?: string }> }
        const top = found.engrams?.[0]
        return top ? `${top.id}@${top.updated_at ?? ''}` : ''
      }

      const loop = async (spaceId: string) => {
        let after: number | null = null
        let probed: string | null = null
        let useHead = !!deps.head
        let probingSince = 0
        let rest = restMs
        /** When the calls started to fail; null while the brain answers. Said once when it starts and once when it ends. */
        let failingSince: number | null = null
        while (!stopped) {
          const space = deps.spaces().find((s) => s.id === spaceId)
          if (!space) break
          if (!viewed()) { await sleep(restMs); continue }
          try {
            if (useHead) {
              const asked = deps.now()
              // After a failed call the head is only asked for, not waited on: the answer says at once that the brain is back.
              const seq = await deps.head!(space, after, after === null || failingSince !== null ? 0 : HEAD_WAIT_MS)
              const quick = deps.now() - asked < 1_000
              if (after !== null && seq !== after) refreshSoon(settleMs)
              // A brain that answers at once without a change does not hold the request: rest, don't spin.
              else if (after !== null && quick) await sleep(restMs)
              after = seq
            } else {
              const top = await newestTask(space)
              if (probed !== null && top !== probed) refreshSoon(settleMs)
              probed = top
              await sleep(probeMs)
              if (deps.head && deps.now() - probingSince >= headRetryMs) { useHead = true; after = null }
            }
            rest = restMs
            if (failingSince !== null) {
              deps.log(`[board] watching ${space.name}: its brain answers again after ${Math.round((deps.now() - failingSince) / 1000)} s`)
              failingSince = null
              // Whatever was written while nobody watched: one refresh, whether or not the head says so.
              refreshSoon(settleMs)
            }
          } catch (err) {
            const { status, body } = err as { status?: number; body?: { code?: string } }
            if (useHead && (status === 404 || body?.code === 'NO_LOG')) {
              useHead = false
              probingSince = deps.now()
              deps.log(`[board] ${space.name}: its brain has no /head; checking its newest task every ${probeMs} ms instead`)
              continue
            }
            if (failingSince === null) {
              failingSince = deps.now()
              deps.log(`[board] watching ${space.name} failed: ${(err as Error).message}; trying again every ${Math.round(restMs / 1000)} to ${Math.round(WATCH_REST_MAX_MS / 1000)} s`)
            }
            await sleep(rest)
            rest = Math.min(rest * 2, WATCH_REST_MAX_MS)
          }
        }
        running.delete(spaceId)
      }

      const startNew = () => {
        if (stopped) return
        for (const space of deps.spaces()) {
          if (running.has(space.id)) continue
          running.add(space.id)
          void loop(space.id)
        }
      }
      startNew()
      const timer = setInterval(startNew, 5_000)
      timer.unref?.()
      return () => { stopped = true; clearInterval(timer) }
    },
  }
}

/** What a page shows of the board, as one string: two boards that show the same give the same one. */
function signature(board: Board): string {
  const { at: _at, events: _events, ...shown } = board
  return JSON.stringify(shown)
}

export type TaskBoard = ReturnType<typeof createTaskBoard>
