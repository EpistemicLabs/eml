import { randomBytes, randomUUID } from 'node:crypto'
import { WebSocket, type RawData } from 'ws'
import type { AgentProvider, TurnState } from './domain/agent-provider.js'
import type {
  EventStore, PermissionAnswer, RuntimeEvent, SessionRuntime, SessionRuntimeFactory, SessionRuntimeStart,
} from './domain/session-runtime.js'
import type { SessionHandoff } from './application/session-handoff.js'
import type { ProviderRegistry } from './infrastructure/providers/registry.js'
import { sessionSpaceOf, type BrainSpace, type BrainSpaces } from './brain-space.js'
import type { ProjectEntry } from './project-registry.js'
import type { SessionLedger } from './session-ledger.js'
import { brainIdFromProjectId } from './project-registry.js'
import { baseAgentEnv, type SessionState } from './pty-bridge.js'
import { sessionAddress } from './session-address.js'
import { readPastedImage } from './paste-images.js'
import { unattended, type SpawnRequest } from './domain/spawn-request.js'
import { chatSessionShouldStop, IDLE_MS, sessionToStopForRoom } from './domain/session-lifecycle.js'
import { ceilingNotice, heapCapEnv, type SessionLimits, type SessionMemory } from './domain/session-memory.js'
import type { DeliveryOutcome } from './domain/session-delivery.js'
import { attentionAfterTurn, missingReply, shouldAskForStatus, stillRunning, type WorkerStatus } from './domain/session-attention.js'
import { deriveTurn, END_TURN_TOOL, LEGACY_STATUS_TOOL, missingOf, passedWhen, reminder, type EndTurn, type Missing, type TurnContext } from './domain/turn-end.js'
import { turnContextOf, type SessionTurn } from './application/turn-context.js'
import { greetingFor } from './session-greeting.js'
import { toolLabel } from './domain/tool-label.js'

/**
 * Chat view ↔ session runtime, beside pty-bridge.ts for the terminal: one running
 * runtime per session, the session's events numbered in an EventStore, and any
 * number of clients on a session: each catches up from its own number, then gets
 * every event. A conversation has one writer process, not one reader.
 *
 * Wire protocol:
 *   client → { type:'init', paneId, projectId, sessionId, spaceId?, epoch?, after?, whenIdle?, readOnly? }
 *   client → { type:'start' }                        (a read-only view is about to be used)
 *   client → { type:'send', text, id? }              (`id`: the one the view already shows it under)
 *   client → { type:'interrupt' }
 *   client → { type:'answer', requestId, answer }
 *   client → { type:'restart', unlimited?, forJob? } (a new process for the same conversation; `unlimited`: the user lifts its limits first)
 *   client → { type:'tool_servers' }
 *   client → { type:'tool_server', name, action:'enable'|'disable'|'reconnect' }
 *   client → { type:'set_mode', mode }
 *   client → { type:'set_model', model }
 *   client → { type:'stop_agent', taskId }
 *   host   → { type:'terminal_busy', state }        (init with whenIdle refused: send it again later)
 *   host   → { type:'switching', reason }           (the handoff is under way)
 *   host   → { type:'limits', deniedTools, mcpServers, job, liftable }  (what the session may not use; after joined and on change)
 *   host   → { type:'joined' }                      (the session takes messages from this socket now)
 *   host   → { type:'reset', epoch }                (drop the view, numbers start over)
 *   host   → { type:'event', seq, event }
 *   host   → { type:'tool_servers', servers, error }  (a snapshot, not part of the event log)
 *   host   → { type:'error', message }
 *
 * Attach handshake as for the terminal: POST /api/chat mints a one-time nonce, the
 * WS upgrade presents it (+ same-origin); the session identity travels in `init`.
 */

// How long the done of a session whose last subagent came back waits for the turn that wakes it.
export const HELPERS_BACK_SETTLE_MS = 5_000
// How long a switch lets an interrupted turn finish on its own before closing it.
const INTERRUPT_WAIT_MS = 3_000
// The one reason a closed turn counts as cut off: the next host start carries it on.
export const HOST_SHUTDOWN = 'host shutdown'
// Stopped to free memory, quiet for long or to make room: a client shows it asleep, and sending wakes it.
export const IDLE_STOP = 'stopped while idle'
// Socket buffer above which a client is too far behind to keep streaming to; it
// reconnects and asks for what it missed.
const WS_MAX_BUFFERED = 16 * 1024 * 1024

const MAX_IMAGES = 10
const SAFE_ID = /^[a-zA-Z0-9_.\-:]+$/
// A model id may carry a variant: `opus[1m]`.
const SAFE_MODEL = /^[a-zA-Z0-9_.\-:[\]]+$/

// The mode a worker runs in, as in the terminal: nobody is there to answer.
const WORKER_MODE = 'auto'
// The calls that say how a turn ends: the reply is what is written after them.
const END_OF_TURN_TOOLS = [END_TURN_TOOL, LEGACY_STATUS_TOOL]

// A session started by hand without the greeting (it is off, or the session predates it) names itself this way.
const NAME_YOURSELF = 'Once this exchange shows what the session is about, name it in a few words, in the background of your work and without mentioning it: node "$COCKPIT_TITLE_JS" \'<title>\'. The title goes in single quotes.'

/** What a turn's end carries besides its text. */
export interface TurnEndFacts {
  /** The end_turn call made in the turn; null when it made none. */
  call: EndTurn | null
  /** Whom that call was read against for its answer: its wait is derived from the same. */
  ctx: TurnContext | null
  /** The turn was sent back once already (onTurnEnding): it gets no second reminder. */
  reminded: boolean
  /** The session said how it stands in this turn (end_turn, or the older session_status); false: a flag on it is the cockpit's own (attentionAfterTurn). */
  said: boolean
}

/** A session's limits as its views get them. */
export interface SessionLimitsView {
  deniedTools: string[]
  /** The only MCP servers it gets besides the brain; null: all its space has. */
  mcpServers: string[] | null
  job: { id: string; name: string } | null
  /** The user can lift them from the chat view. */
  liftable: boolean
}

/** What the user lifting limits is told as: readable names for the conversation (`label`), the exact ones for the agent. */
export function liftNotice(limits: Pick<SessionLimitsView, 'deniedTools' | 'mcpServers'>, jobName: string | null, label: (tool: string) => string = (tool) => tool): string {
  const parts = [
    ...(limits.deniedTools.length ? [`the blocked tools (${limits.deniedTools.map(label).join(', ')})`] : []),
    ...(limits.mcpServers !== null ? ['the limit to some MCP servers'] : []),
  ]
  const forJob = jobName ? ` Future runs of the job "${jobName}" start without them too.` : ''
  return `The user lifted this session's limits: ${parts.join(' and ')}. From this restart it may use all tools its space has.${forJob}`
}

export const RESTART_NOTICE = 'Restarted. MCP servers, settings and skills were loaded fresh.'
const CARRY_OVER_NOTICE = 'This chat continues the terminal session. "Allow for this session" grants from there do not carry over.'

interface ChatEntry {
  sessionId: string
  spaceId: string
  projectId: string
  projectPath: string
  runtime: SessionRuntime | null
  clients: Set<WebSocket>
  active: boolean
  openRequests: Set<string>
  turnEnded: (() => void) | null
  /** Background shells and subagents still running: they end with the process. */
  backgroundTasks: Set<string>
  /** Of those, the subagents: a turn that ends while they run is not the session's stop (stillRunning). */
  runningAgents: Set<string>
  /** A done signal came while its subagents ran and its turn state was kept at working: the bridge owes the done. */
  held: boolean
  /** Its own turn is over and it waits for its subagents: the turn they wake shows as working again. */
  parked: boolean
  lastActivity: number
  /** Being closed: a message now would go down with the process. */
  closing: boolean
  /** Resolves once a closing entry is gone. */
  closed: Promise<void> | null
  /** This turn the session said how it stands (end_turn, or the older session_status). */
  declared: boolean
  /** How it stands as said this turn, and the end_turn call that said it (null for session_status). */
  status: WorkerStatus | null
  call: EndTurn | null
  callCtx: TurnContext | null
  /** The call asks the user something: the reply has to ask it too. */
  asks: boolean
  /** The reply: the visible text written after the call. */
  replyText: string
  /** The turn was sent back once: it is not sent back again. */
  reminded: boolean
  /** The session works on its own (domain/session-attention.ts worksAlone), as read when this turn was about to end; null: not read yet. */
  alone: boolean | null
  /** Everything the agent wrote this turn: the task router reads the handoff at its end. */
  turnText: string
  /** A turn finished since the session last handed off (or started): there is something to hand off. */
  worked: boolean
  /** It was asked for its handoff before an idle stop: it stops once that turn is over. */
  stopAfterTurn: boolean
  /** The memory ceiling its process started with, and the kills at it already reported; null: none. */
  ceiling: { limits: SessionLimits; kills: number } | null
  /** A ceiling notice the agent has not seen yet: it goes with its next prompt. */
  ceilingNote: string | null
  /** The agent's process; null until it started. */
  pid: number | null
  /** Limits the user lifted that the agent has not been told of yet: it goes with its next prompt. */
  liftNote?: string | null
}

export interface ChatContext {
  ledger: SessionLedger
  providers: ProviderRegistry
  spaces: BrainSpaces
  sessionEnv: Record<string, string>
  runtimes: SessionRuntimeFactory
  events: EventStore
  /** Report a session's turn state where hooks can't: a permission card brings no Notification hook. */
  onTurn: (sessionId: string, state: Exclude<TurnState, 'idle'>, settleMs?: number) => void
  /** Its own turn ended and it waits for this many of its subagents; 0: no longer. The turn state stays working. */
  onHelpers?: (sessionId: string, helpers: number) => void
  /** A turn finished with this text: the task router reads its end_turn call, else its handoff (application/task-router.ts). */
  turnDone?: (sessionId: string, text: string, turn: TurnEndFacts) => void
  /** Whether the session works on its own, by its task as the brain has it now (domain/session-attention.ts worksAlone). */
  worksAlone?: (sessionId: string) => Promise<boolean>
  /** Whom an end_turn call is read against, and the session's task (application/turn-context.ts); absent: the space's agent and no task. */
  turnContext?: (sessionId: string) => Promise<SessionTurn>
  /** The moment a call is read and the zone its next.when is read in (the user's); absent: now, in this machine's zone. */
  callTime?: () => { now: number; zone: string }
  /**
   * The check a call's next.when asks for: set, moved, or removed when the call has none
   * (application/turn-check.ts). Answers why it could not be set, or null.
   */
  turnCheck?: (sessionId: string, check: { at: string | null; call: EndTurn; turn: SessionTurn }) => Promise<string | null>
  /** Someone wrote to the session while it waited: the wait it set on its task is over (task router). */
  answered?: (sessionId: string) => void
  /** The user wrote to the session from a client: a closed task it works on reopens first (task-commands.ts). */
  userWrote?: (sessionId: string) => void
  /**
   * Before an idle stop: the prompt that asks this session for its handoff
   * (application/session-task.ts), or null when it needs none. Asked once per
   * stretch of work; the session stops when that turn is over.
   */
  handoffBeforeStop?: (sessionId: string) => string | null
  /** The session's process died on its own: whatever its turn state said no longer holds. */
  onExit?: (sessionId: string) => void
  /** Whether a terminal process holds this session: a read-only view can't take it from there. */
  terminalRuns?: (sessionId: string) => boolean
  /** What the session's terminal process is in the middle of, if anything: a takeover would cut it off. */
  terminalBusy?: (sessionId: string) => 'working' | 'waiting' | null
  /** Memory ceilings per session (session-memory.ts); absent: none. */
  memory?: SessionMemory
  /** The ceiling a session starts with, and how long a quiet one keeps its process (session-limits.ts). */
  limits?: () => { session: SessionLimits; idleMs: number }
  /** More sessions run than the cap allows (session-limits.ts). */
  overCap?: () => boolean
  /** The job a session works for; `limited`: a channel job the user limited, whose limits are its own. */
  jobOf?: (sessionId: string) => { id: string; name: string; limited: boolean } | null
  /** The user lifted a job's limits for its future runs too. */
  clearJobProfile?: (jobId: string) => void
  /** The schedule tool's actions, for the session that calls it (application/jobs.ts); absent: no tool. */
  jobs?: (sessionId: string, input: Record<string, unknown>) => Promise<string>
}

type ClientMessage = {
  id?: unknown
  /** Settings › Preferences › Sessions: a plain new chat opens with the greeting (session-greeting.ts). */
  greet?: unknown
  /** A new chat started from the empty pane's launcher: its first message, sent once the session starts. */
  prompt?: unknown
  readOnly?: unknown
  whenIdle?: unknown
  images?: unknown
  type?: string
  paneId?: unknown
  projectId?: unknown
  sessionId?: unknown
  spaceId?: unknown
  epoch?: unknown
  after?: unknown
  text?: unknown
  requestId?: unknown
  answer?: unknown
  mode?: unknown
  model?: unknown
  taskId?: unknown
  name?: unknown
  action?: unknown
  /** restart: the user lifts the session's limits first; forJob: its job's future runs too. */
  unlimited?: unknown
  forJob?: unknown
}

function send(ws: WebSocket | null, message: Record<string, unknown>): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  try { ws.send(JSON.stringify(message)) } catch { /* closing */ }
}

function parseMessage(raw: RawData, isBinary: boolean): ClientMessage | null {
  if (isBinary) return null
  try {
    const parsed: unknown = JSON.parse(raw.toString())
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ClientMessage : null
  } catch {
    return null
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

function parseImageNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((name): name is string => typeof name === 'string').slice(0, MAX_IMAGES)
}

export function parseAnswer(value: unknown): PermissionAnswer | null {
  if (!value || typeof value !== 'object') return null
  const answer = value as { decision?: unknown; message?: unknown; answers?: unknown }
  if (answer.decision === 'allow') return { decision: 'allow' }
  if (answer.decision === 'always') return { decision: 'always' }
  if (answer.decision === 'deny') return { decision: 'deny', ...(typeof answer.message === 'string' ? { message: answer.message } : {}) }
  if (answer.decision === 'answer' && answer.answers && typeof answer.answers === 'object') {
    const answers: Record<string, string> = {}
    for (const [question, chosen] of Object.entries(answer.answers)) {
      if (typeof chosen === 'string') answers[question] = chosen
    }
    return { decision: 'answer', answers }
  }
  return null
}

export class ChatBridge {
  private nonces = new Set<string>()
  private entries = new Map<string, ChatEntry>()
  private log = (s: string) => process.stderr.write(`[chat] ${s}\n`)

  constructor(private ctx: ChatContext, private handoff: () => SessionHandoff) {}

  mintNonce(): { nonce: string } {
    const nonce = randomBytes(24).toString('hex')
    this.nonces.add(nonce)
    setTimeout(() => this.nonces.delete(nonce), 30_000).unref?.()
    return { nonce }
  }

  consumeNonce(nonce: string): boolean {
    return this.nonces.delete(nonce)
  }

  /** The running sessions' agent processes, pid → session id (the Worktrees plugin: who started a port). */
  processes(): Map<number, string> {
    return new Map([...this.entries.values()].flatMap((entry) => (entry.pid ? [[entry.pid, entry.sessionId] as const] : [])))
  }

  // ── The chat side of the handoff ─────────────────────────────────────
  isRunning(sessionId: string): boolean {
    return this.entries.get(sessionId)?.runtime != null
  }

  /** Background tasks (shell or agent) of its own still running: ending the process would kill them. */
  backgroundTasks(sessionId: string): number {
    return this.entries.get(sessionId)?.backgroundTasks.size ?? 0
  }

  /**
   * Its turn asks nobody anything and subagents it started still run (stillRunning): they wake it
   * again, so its run is not over. False for a session the bridge does not run.
   */
  waitsOnHelpers(sessionId: string): boolean {
    const entry = this.entries.get(sessionId)
    return entry !== undefined && !entry.closing && stillRunning({ agents: entry.runningAgents.size, status: entry.status })
  }

  /**
   * A done signal came for the session (its Stop hook). True while it waits on its helpers: the
   * signal is then not to be applied, and the bridge ends the turn state itself once they are back
   * and no turn follows, or the session stops.
   */
  holdTurnOpen(sessionId: string): boolean {
    const entry = this.entries.get(sessionId)
    if (!entry || !this.waitsOnHelpers(sessionId)) return false
    entry.held = true
    return true
  }

  sessionState(sessionId: string): SessionState {
    const entry = this.entries.get(sessionId)
    if (!entry?.runtime) return 'ended'
    return [...entry.clients].some((ws) => ws.readyState === WebSocket.OPEN) ? 'running' : 'detached'
  }

  /** Close the session's runtime, and resolve once its process has exited. The client is told not to reconnect. */
  async end(sessionId: string, reason = 'superseded'): Promise<void> {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    if (entry.closed) return entry.closed
    entry.closing = true
    entry.closed = this.close(entry, sessionId, reason)
    return entry.closed
  }

  private async close(entry: ChatEntry, sessionId: string, reason: string): Promise<void> {
    const runtime = entry.runtime
    if (runtime) {
      if (entry.active && entry.openRequests.size === 0) await this.interruptAndWait(entry, runtime)
      await runtime.close()
      entry.runtime = null
      // Its subagents went with the process (runtime_exit says so too; this holds for a runtime that does not).
      this.releaseHeld(entry)
    }
    this.ctx.memory?.release(sessionId)
    // Stopped, archived, timed out, deleted or taken over: its turn is over, not cut off.
    if (reason !== HOST_SHUTDOWN) this.ctx.ledger.setTurnInFlight(sessionId, false)
    for (const ws of entry.clients) {
      try { ws.close(1000, reason) } catch { /* closing */ }
    }
    entry.clients.clear()
    this.entries.delete(sessionId)
    this.ctx.events.forget(sessionId)
    this.log(`session ${sessionId} left the chat runtime (${reason})`)
  }

  private async interruptAndWait(entry: ChatEntry, runtime: SessionRuntime): Promise<void> {
    const turnEnded = new Promise<void>((resolve) => { entry.turnEnded = resolve })
    const bound = new Promise<void>((resolve) => { setTimeout(resolve, INTERRUPT_WAIT_MS).unref?.() })
    await runtime.interrupt().catch(() => { /* close() below ends it either way */ })
    await Promise.race([turnEnded, bound])
    entry.turnEnded = null
  }

  /** Host shutdown. Sessions resume from the ledger when a client comes back. */
  async dispose(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.end(id, HOST_SHUTDOWN).catch(() => { /* best-effort */ })))
  }

  /** End the sessions the lifecycle rule says should stop. They stay resumable; returns how many ended. */
  sweepIdle(now = Date.now()): number {
    let ended = 0
    const idleMs = this.ctx.limits?.().idleMs ?? IDLE_MS
    for (const entry of [...this.entries.values()]) {
      this.reportCeilingKills(entry)
      if (!chatSessionShouldStop({ ...this.facts(entry, now), idleMs })) continue
      if (entry.stopAfterTurn && entry.active) continue
      const prompt = entry.worked && !entry.stopAfterTurn && !entry.closing ? this.ctx.handoffBeforeStop?.(entry.sessionId) ?? null : null
      if (prompt) {
        this.sendMessage(entry, prompt)
        entry.worked = false
        entry.stopAfterTurn = true
        continue
      }
      void this.end(entry.sessionId, IDLE_STOP)
      ended += 1
    }
    return ended
  }

  private facts(entry: ChatEntry, now: number) {
    return {
      sessionId: entry.sessionId,
      clients: entry.clients.size,
      running: entry.runtime !== null,
      turnActive: entry.active,
      backgroundTasks: entry.backgroundTasks.size,
      openRequests: entry.openRequests.size,
      quietMs: now - entry.lastActivity,
    }
  }

  /** Sessions whose process runs now. */
  runningCount(): number {
    let running = 0
    for (const entry of this.entries.values()) if (entry.runtime && !entry.closing) running += 1
    return running
  }

  /** Over the running cap: stop the quietest session at rest (sessionToStopForRoom). False: all are busy. */
  stopOneForRoom(except: string | null = null, now = Date.now()): boolean {
    const sessions = [...this.entries.values()].filter((e) => !e.closing && e.sessionId !== except).map((e) => this.facts(e, now))
    const sessionId = sessionToStopForRoom(sessions)
    if (!sessionId) return false
    this.log(`stopping ${sessionId} to make room for another session`)
    void this.end(sessionId, IDLE_STOP)
    return true
  }

  /** The kernel stopped processes of the session at its ceiling since the last look: say so in the session. */
  private reportCeilingKills(entry: ChatEntry, ended = false): void {
    const { ceiling } = entry
    if (!ceiling || !this.ctx.memory) return
    const kills = this.ctx.memory.oomKills(entry.sessionId)
    if (kills <= ceiling.kills) return
    const text = ceilingNotice(kills - ceiling.kills, ceiling.limits) + (ended ? ' The session stopped; sending a message resumes it.' : '')
    ceiling.kills = kills
    entry.ceilingNote = text
    this.log(`session ${entry.sessionId}: ${text}`)
    this.emit(entry, { kind: 'notice', text })
  }

  /** The session is being deleted. */
  kill(sessionId: string): Promise<void> {
    return this.end(sessionId, 'deleted')
  }

  killProjectSessions(projectId: string, spaceKey: string | null): void {
    for (const entry of this.entries.values()) {
      if (entry.projectId === projectId && this.ctx.spaces.resolve(entry.spaceId).ledgerKey === spaceKey) void this.kill(entry.sessionId)
    }
  }

  // ── Connection handling ──────────────────────────────────────────────
  attach(ws: WebSocket): void {
    let sessionId: string | null = null

    ws.on('message', (raw: RawData, isBinary: boolean) => {
      const data = parseMessage(raw, isBinary)
      if (!data?.type) return
      try {
        if (data.type === 'init') {
          if (sessionId) return // one init per socket
          sessionId = this.init(ws, data)
          return
        }
        if (!sessionId) return
        const entry = this.entries.get(sessionId)
        if (!entry?.clients.has(ws)) return
        if (data.type === 'start') this.ensureStarted(entry)
        else if (data.type === 'send') {
          this.sendMessage(entry, text(data.text), parseImageNames(data.images), text(data.id))
          this.ctx.userWrote?.(entry.sessionId)
        }
        else if (data.type === 'interrupt') void entry.runtime?.interrupt().catch((error: Error) => this.emit(entry, { kind: 'error', message: error.message }))
        else if (data.type === 'answer') {
          const answer = parseAnswer(data.answer)
          if (answer) entry.runtime?.answerPermission(text(data.requestId), answer)
        } else if (data.type === 'set_mode' && SAFE_ID.test(text(data.mode))) {
          this.control(entry, (runtime) => runtime.setMode(text(data.mode)))
        } else if (data.type === 'set_model' && SAFE_MODEL.test(text(data.model))) {
          const model = text(data.model)
          this.control(entry, async (runtime) => {
            await runtime.setModel(model)
            this.ctx.ledger.setChatSettings(entry.sessionId, { model })
          })
        } else if (data.type === 'stop_agent' && SAFE_ID.test(text(data.taskId))) {
          this.control(entry, (runtime) => runtime.stopAgent(text(data.taskId)))
        } else if (data.type === 'restart') {
          if (data.unlimited === true) this.lift(entry, data.forJob === true)
          void this.restart(entry).catch((error: Error) => this.emit(entry, { kind: 'error', message: error.message }))
        }
        else if (data.type === 'tool_servers') void this.sendToolServers(entry, ws)
        else if (data.type === 'tool_server') void this.changeToolServer(entry, ws, text(data.name), text(data.action))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.log(`error: ${message}`)
        send(ws, { type: 'error', message })
      }
    })

    ws.on('close', () => {
      if (!sessionId) return
      const entry = this.entries.get(sessionId)
      // No abort: a reload must not cost the running turn or an open card (sweepIdle).
      if (entry?.clients.delete(ws)) entry.lastActivity = Date.now()
    })

    ws.on('error', (error) => this.log(`ws error: ${error.message}`))
  }

  /** A change to the running session; what goes wrong shows in the conversation. */
  private control(entry: ChatEntry, action: (runtime: SessionRuntime) => Promise<void>): void {
    if (!entry.runtime) throw new Error('This session is not running. Send a message to resume it first.')
    void action(entry.runtime).catch((error: Error) => this.emit(entry, { kind: 'error', message: error.message }))
  }

  /** Validates the frame and starts the session's way in; returns its id, or null when refused. */
  private init(ws: WebSocket, data: ClientMessage): string | null {
    const sessionId = text(data.sessionId)
    const projectId = text(data.projectId)
    const paneId = text(data.paneId) || null
    const spaceId = text(data.spaceId) || null
    const space = spaceId ? this.ctx.spaces.get(spaceId) : this.ctx.spaces.main
    const refuse = (message: string) => { send(ws, { type: 'error', message }); return null }
    if (!space) return refuse('This desk belongs to a brain space this cockpit no longer has')
    if (!SAFE_ID.test(sessionId) || !SAFE_ID.test(projectId) || (paneId && !SAFE_ID.test(paneId))) return refuse('Invalid session')
    const moved = this.ctx.spaces.movedAway(this.ctx.ledger.get(sessionId)?.spaceId, space)
    if (moved) return refuse(moved)
    const project = this.projectFor(space, projectId)
    if (!project?.path) return refuse('Unknown project, or it has no folder')
    const provider = this.ctx.ledger.has(sessionId) ? this.ctx.providers.forSession(sessionId) : this.ctx.providers.get('claude')
    if (!provider || provider.id !== 'claude') return refuse('The chat view runs Claude Code sessions only. This session stays in the terminal.')
    const problem = provider.runtime.problem()
    if (problem) return refuse(`${problem} ${provider.runtime.problemHint}`)
    // A space with its own agent never falls back to the shared config.
    const agentProblem = space.runtime?.problem(provider.id)
    if (agentProblem) return refuse(agentProblem)

    // Asked to wait: no session yet, so the same socket can send its init again.
    const busy = data.whenIdle === true ? this.ctx.terminalBusy?.(sessionId) ?? null : null
    if (busy) {
      send(ws, { type: 'terminal_busy', state: busy })
      return null
    }

    // Decided here: by the time the session enters this side, the terminal has let go.
    const readOnly = data.readOnly === true && !this.ctx.terminalRuns?.(sessionId)
    const after = typeof data.after === 'number' ? data.after : 0
    const epoch = typeof data.epoch === 'number' ? data.epoch : null
    const path = project.path
    // As in the terminal: only a plain new session greets. One the ledger knows is a resume or a worker
    // (spawned work is recorded before its view opens), and a chat never brings a first prompt of its own.
    const isNew = !this.ctx.ledger.has(sessionId)
    // A new chat from the launcher brings its first message (and model); a known session never does.
    const prompt = isNew ? text(data.prompt).trim() || null : null
    const model = isNew && SAFE_MODEL.test(text(data.model)) ? text(data.model) : null
    const greeting = greetingFor({ resume: !isNew, initialPrompt: prompt, greet: data.greet === true, worker: false })
    const handoff = this.handoff()
    if (handoff.switching(sessionId)) send(ws, { type: 'switching', reason: 'Waiting for the terminal session to end…' })
    const entered = handoff.enter('sdk', sessionId, () => this.open(ws, {
      sessionId, paneId, projectId, projectPath: path, space, provider, epoch, after,
      readOnly, greeting, firstPrompt: prompt, model,
      onSwitch: () => send(ws, { type: 'switching', reason: 'Loading the conversation…' }),
    }))
    entered.catch((error: Error) => {
      this.log(`could not open ${sessionId}: ${error.message}`)
      send(ws, { type: 'error', message: `Could not open this session: ${error.message}` })
    })
    return sessionId
  }

  private async open(ws: WebSocket, opts: {
    sessionId: string
    paneId: string | null
    projectId: string
    projectPath: string
    space: BrainSpace
    provider: AgentProvider
    epoch: number | null
    after: number
    /** Show the conversation and start no process until it is used. */
    readOnly: boolean
    /** A plain new chat's first prompt (session-greeting.ts): the session starts at once and sends it. */
    greeting: string | null
    /** A new chat's own first message (the launcher): sent like the greeting, which it replaces. */
    firstPrompt: string | null
    /** The model a new chat starts with. */
    model: string | null
    onSwitch: () => void
  }): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN) return
    const { sessionId, paneId, projectId, projectPath, space, provider } = opts
    // Being closed: wait it out and start over. Joining would go down with it.
    const closing = this.entries.get(sessionId)
    if (closing?.closed) await closing.closed
    if (ws.readyState !== WebSocket.OPEN) return
    const existing = this.entries.get(sessionId)
    if (existing) {
      this.join(existing, ws, opts.epoch, opts.after)
      this.ctx.ledger.touch(sessionId, paneId)
      return
    }

    opts.onSwitch()
    const fromTerminal = this.ctx.ledger.get(sessionId)?.runtime === 'terminal'
    const resume = this.ctx.ledger.has(sessionId) && provider.canResume(this.ctx.ledger.ref(sessionId, null, space.runtime))
    const entry: ChatEntry = {
      sessionId, spaceId: space.id, projectId, projectPath, runtime: null, clients: new Set([ws]), active: false,
      openRequests: new Set(), turnEnded: null, backgroundTasks: new Set(), runningAgents: new Set(), held: false, parked: false, lastActivity: Date.now(), closing: false, closed: null, declared: false, status: null, call: null, callCtx: null, asks: false, replyText: '', reminded: false, alone: null, turnText: '', worked: false, stopAfterTurn: false, ceiling: null, ceilingNote: null, pid: null,
    }
    this.entries.set(sessionId, entry)
    const epoch = this.ctx.events.reset(sessionId)
    send(ws, { type: 'reset', epoch })
    // The view is rebuilt from the transcript, which holds what the terminal added
    // and was never streamed; from here on it renders from this one log.
    if (resume) {
      const conversationId = this.ctx.ledger.ref(sessionId, null).providerSessionId ?? sessionId
      for (const event of await this.ctx.runtimes.history(conversationId, projectPath, space.runtime)) this.emit(entry, event)
      if (fromTerminal) this.emit(entry, { kind: 'notice', text: CARRY_OVER_NOTICE })
    }
    const first = resume ? null : opts.firstPrompt ?? opts.greeting
    if (first) {
      if (opts.model) {
        this.ctx.ledger.recordSpawn(sessionId, paneId, projectId, provider.id, false, null, space.ledgerKey, first === opts.greeting)
        this.ctx.ledger.setChatSettings(sessionId, { model: opts.model })
      }
      this.startEntry(entry, provider, space, paneId, false, first === opts.greeting)
      this.sendMessage(entry, first)
    } else if (opts.readOnly) {
      if (!entry.runtime) this.emit(entry, { kind: 'process', state: 'stopped' })
    } else this.startEntry(entry, provider, space, paneId, resume)
    send(ws, { type: 'limits', ...this.limitsOf(entry.sessionId) })
    send(ws, { type: 'joined' })
  }

  /** The session gets its process here, once someone uses it. */
  private startEntry(entry: ChatEntry, provider: AgentProvider, space: BrainSpace, paneId: string | null, resume: boolean, greeted = false): void {
    // A message can arrive while the view still loads, and it starts the session first.
    if (entry.runtime) return
    const { sessionId, projectId, projectPath } = entry
    provider.trustProject(projectPath, sessionSpaceOf(space))
    // greeted: the title and summary logic skip the greeting as a first prompt, as in the terminal.
    this.ctx.ledger.recordSpawn(sessionId, paneId, projectId, provider.id, false, null, space.ledgerKey, greeted)
    this.ctx.ledger.setRuntime(sessionId, 'sdk')
    // A worker runs unattended in the terminal too, whatever Settings says for other sessions.
    const stored = this.ctx.ledger.get(sessionId)
    if (stored?.worker && !stored.chatMode) this.ctx.ledger.setChatSettings(sessionId, { mode: WORKER_MODE })
    // A terminal session kept for Remote Control is not one any more.
    this.ctx.ledger.setKeepRunning(sessionId, false)
    this.startRuntime(entry, provider, space, resume)
    this.log(`${resume ? 'resuming' : 'starting'} chat session ${sessionId} in ${projectPath}`)
  }

  /** What the session may not use, as its views show it: from the ledger, so what holds at its next start. */
  private limitsOf(sessionId: string): SessionLimitsView {
    const profile = this.ctx.ledger.get(sessionId)?.toolProfile ?? null
    const job = this.ctx.jobOf?.(sessionId) ?? null
    const deniedTools = profile?.deniedTools ?? []
    const mcpServers = profile?.mcpServers ?? null
    return {
      deniedTools, mcpServers,
      job: job ? { id: job.id, name: job.name } : null,
      // A limited channel job's limits are worked out at each start; the user lends it tools in the Jobs view.
      liftable: (deniedTools.length > 0 || mcpServers !== null) && !job?.limited,
    }
  }

  /**
   * The user lifts the session's limits, and with forJob those of its job's future runs. Only the
   * page asks for it, over this socket; no agent tool reaches it. The restart that follows applies it.
   */
  private lift(entry: ChatEntry, forJob: boolean): void {
    const limits = this.limitsOf(entry.sessionId)
    if (!limits.liftable) throw new Error('This session has no limits that can be lifted here.')
    this.ctx.ledger.clearToolProfile(entry.sessionId)
    const job = forJob && limits.job && this.ctx.clearJobProfile ? limits.job : null
    if (job) this.ctx.clearJobProfile!(job.id)
    entry.liftNote = liftNotice(limits, job?.name ?? null)
    this.emit(entry, { kind: 'notice', text: liftNotice(limits, job?.name ?? null, toolLabel) })
    this.log(`limits of ${entry.sessionId} lifted by the user${job ? `, and of job ${job.id}` : ''}`)
    const frame = { type: 'limits', ...this.limitsOf(entry.sessionId) }
    for (const ws of entry.clients) send(ws, frame)
  }

  /**
   * A new process for the same conversation, the views staying on it: a running turn is
   * stopped first, then it resumes under the same id and reads its MCP servers, settings and
   * skills fresh. What it may use stays as it started (the ledger's tool profile).
   */
  private async restart(entry: ChatEntry): Promise<void> {
    if (entry.closing) return
    const runtime = entry.runtime
    if (runtime) {
      // Closing for the moment: a message now is refused rather than lost with the old process.
      entry.closing = true
      try {
        if (entry.active && entry.openRequests.size === 0) await this.interruptAndWait(entry, runtime)
        await runtime.close()
      } finally {
        entry.runtime = null
        entry.closing = false
      }
      this.ctx.memory?.release(entry.sessionId)
      this.ctx.ledger.setTurnInFlight(entry.sessionId, false)
    }
    // Ended or deleted meanwhile: nothing to bring back.
    if (entry.closed || this.entries.get(entry.sessionId) !== entry) return
    this.emit(entry, { kind: 'notice', text: RESTART_NOTICE })
    this.ensureStarted(entry)
    this.log(`restarted chat session ${entry.sessionId}`)
  }

  /** A read-only view is being used, or a crash left the entry without a process: the conversation goes on. */
  private ensureStarted(entry: ChatEntry): void {
    if (entry.runtime || entry.closing) return
    const { sessionId } = entry
    if (this.ctx.terminalRuns?.(sessionId)) throw new Error('This session runs in the terminal now. Reopen it here to move it over.')
    const space = this.ctx.spaces.get(entry.spaceId)
    if (!space) throw new Error('This session\'s brain space is gone')
    const known = this.ctx.ledger.has(sessionId)
    const provider = known ? this.ctx.providers.forSession(sessionId) : this.ctx.providers.get('claude')
    if (!provider) throw new Error('This session\'s agent is gone')
    this.startEntry(entry, provider, space, this.ctx.ledger.get(sessionId)?.paneId ?? null, known && provider.canResume(this.ctx.ledger.ref(sessionId, null, space.runtime)))
  }

  /**
   * Start a worker a session asked for, with no client: under the request id (the
   * address the requester already has), its prompt as the first message. A pane
   * joins it like any client. Returns why it could not start, or null.
   */
  startWorker(request: SpawnRequest): string | null {
    const sessionId = request.id
    const space = this.ctx.spaces.resolve(request.spaceId ?? null)
    const project = this.projectFor(space, request.projectId)
    if (!project?.path) return `project ${request.projectId} has no folder`
    const provider = this.ctx.providers.get(request.provider ?? '') ?? this.ctx.providers.default()
    const problem = provider.runtime.problem() ?? space.runtime?.problem(provider.id)
    if (problem) return problem
    if (this.entries.has(sessionId)) return 'already running'
    const { projectId, path } = project
    let failure: string | null = null
    // A new id has no other side to wait for, so this runs right away.
    void this.handoff().enter('sdk', sessionId, () => {
      const entry: ChatEntry = {
        sessionId, spaceId: space.id, projectId, projectPath: path, runtime: null, clients: new Set(), active: false,
        openRequests: new Set(), turnEnded: null, backgroundTasks: new Set(), runningAgents: new Set(), held: false, parked: false, lastActivity: Date.now(), closing: false, closed: null, declared: false, status: null, call: null, callCtx: null, asks: false, replyText: '', reminded: false, alone: null, turnText: '', worked: false, stopAfterTurn: false, ceiling: null, ceilingNote: null, pid: null,
      }
      this.entries.set(sessionId, entry)
      this.ctx.events.reset(sessionId)
      try {
        provider.trustProject(path, sessionSpaceOf(space))
        // Started by hand it is the user's own session, in the mode they use: only a session's worker runs unattended.
        const worker = unattended(request)
        this.ctx.ledger.recordSpawn(sessionId, null, projectId, provider.id, worker, request.taskId ?? null, space.ledgerKey)
        this.ctx.ledger.setRuntime(sessionId, 'sdk')
        if (worker) this.ctx.ledger.setChatSettings(sessionId, { mode: WORKER_MODE })
        if (request.title) this.ctx.ledger.setAgentTitle(sessionId, request.title)
        if (request.wakeable) this.ctx.ledger.setWakeable(sessionId)
        if (request.toolProfile) this.ctx.ledger.setToolProfile(sessionId, request.toolProfile)
        if (request.jobId) this.ctx.ledger.setJobId(sessionId, request.jobId)
        this.startRuntime(entry, provider, space, false)
        // Working from here on: its first hook comes only once the agent CLI has booted.
        this.ctx.onTurn(sessionId, 'working')
        this.sendMessage(entry, request.prompt)
        this.log(`starting worker ${sessionId} in ${path}`)
      } catch (error) {
        this.entries.delete(sessionId)
        this.ctx.events.forget(sessionId)
        // This text reaches an HTTP response: the message only, never the raw value.
        failure = error instanceof Error ? error.message : 'the worker could not start'
        this.log(`worker ${sessionId} did not start: ${failure}`)
      }
    })
    return failure
  }

  /**
   * A message from outside any client: to the running session, or to a stopped one,
   * which resumes first. Only reports success once the session has it.
   * `reminder`: the text is the one reminder of a stop (application/next-step.ts), so the turn it starts is not sent back again.
   */
  async deliver(sessionId: string, text: string, opts: { reminder?: boolean } = {}): Promise<DeliveryOutcome> {
    if (this.handoff().switching(sessionId)) return 'busy'
    const running = this.entries.get(sessionId)
    if (running) {
      if (running.closing) return 'busy'
      this.sendMessage(running, text, [], '', opts.reminder === true)
      return 'delivered'
    }
    const stored = this.ctx.ledger.get(sessionId)
    if (!stored?.projectId) return 'unknown'
    const projectId = stored.projectId
    const space = this.ctx.spaces.resolve(stored.spaceId)
    const path = this.projectFor(space, projectId)?.path
    const provider = this.ctx.providers.forSession(sessionId)
    if (!path || provider.runtime.problem() || space.runtime?.problem(provider.id)) return 'refused'
    await this.handoff().enter('sdk', sessionId, async () => {
      const entry: ChatEntry = {
        sessionId, spaceId: space.id, projectId, projectPath: path, runtime: null, clients: new Set(), active: false,
        openRequests: new Set(), turnEnded: null, backgroundTasks: new Set(), runningAgents: new Set(), held: false, parked: false, lastActivity: Date.now(), closing: false, closed: null, declared: false, status: null, call: null, callCtx: null, asks: false, replyText: '', reminded: false, alone: null, turnText: '', worked: false, stopAfterTurn: false, ceiling: null, ceilingNote: null, pid: null,
      }
      this.entries.set(sessionId, entry)
      this.ctx.events.reset(sessionId)
      const resume = provider.canResume(this.ctx.ledger.ref(sessionId, null, space.runtime))
      if (resume) {
        const conversationId = this.ctx.ledger.ref(sessionId, null).providerSessionId ?? sessionId
        for (const event of await this.ctx.runtimes.history(conversationId, path, space.runtime)) this.emit(entry, event)
      }
      provider.trustProject(path, sessionSpaceOf(space))
      this.ctx.ledger.recordSpawn(sessionId, stored.paneId, projectId, provider.id, false, null, space.ledgerKey)
      this.ctx.ledger.setRuntime(sessionId, 'sdk')
      if (stored.worker && !stored.chatMode) this.ctx.ledger.setChatSettings(sessionId, { mode: WORKER_MODE })
      this.startRuntime(entry, provider, space, resume)
      this.sendMessage(entry, text, [], '', opts.reminder === true)
      this.log(`resumed ${sessionId} for a message`)
    })
    return 'resumed'
  }

  private startRuntime(entry: ChatEntry, provider: AgentProvider, space: BrainSpace, resume: boolean): void {
    const { sessionId, projectId, projectPath } = entry
    const address = sessionAddress(sessionId, projectId)
    const { providerSessionId } = this.ctx.ledger.ref(sessionId, null)
    const launch = provider.launch({
      sessionId, address, providerSessionId, resume, initialPrompt: null, unattended: false,
      space: sessionSpaceOf(space),
      toolProfile: this.ctx.ledger.get(sessionId)?.toolProfile ?? null,
    })
    const brainId = brainIdFromProjectId(projectId)
    // The same environment a terminal session gets. The SDK replaces the
    // environment rather than merging, and it never carries a login token.
    const { CLAUDE_CODE_OAUTH_TOKEN: _token, ...launchEnv } = launch.env
    const merged: Record<string, string> = {
      ...baseAgentEnv(),
      ...launchEnv,
      ...this.ctx.sessionEnv,
    }
    const env = {
      ...merged,
      ...(this.ctx.limits && this.ctx.memory?.unavailable === null ? heapCapEnv(this.ctx.limits().session, merged.NODE_OPTIONS) : {}),
      COCKPIT_SESSION_ID: sessionId,
      ...(brainId ? { EML_PROJECT_SCOPE: `project.${brainId}` } : {}),
    }
    const stored = this.ctx.ledger.get(sessionId)
    this.emit(entry, { kind: 'process', state: 'starting' })
    entry.runtime = this.ctx.runtimes.start({
      sessionId, resume, conversationId: providerSessionId, mode: stored?.chatMode ?? null, model: stored?.chatModel ?? null,
      cwd: projectPath, env, address,
      files: { mcpConfig: launch.limits?.mcpConfig ?? space.files.mcpConfig, settings: space.files.settings },
      strictMcp: !!space.runtime || !!launch.limits?.mcpConfig,
      // The provider decides: a runtime's own browser control, or Chrome lent to a limited job.
      ...(launch.chrome ? { chrome: true } : {}),
      ...(launch.limits?.deniedTools.length ? { deniedTools: launch.limits.deniedTools } : {}),
      worker: this.reporting(entry),
      ...(this.ctx.jobs ? { jobs: (input: Record<string, unknown>) => this.ctx.jobs!(entry.sessionId, input) } : {}),
      onEvent: (event) => this.onRuntimeEvent(entry, event),
      onSpawn: (pid) => { entry.pid = pid; this.placeInCeiling(entry, pid) },
    })
    // Over the cap: a session someone opens starts anyway, and the quietest one at rest makes room.
    if (this.ctx.overCap?.()) this.stopOneForRoom(sessionId)
  }

  private placeInCeiling(entry: ChatEntry, pid: number): void {
    const { memory, limits } = this.ctx
    if (!memory || !limits) return
    const session = limits().session
    entry.ceiling = memory.place(entry.sessionId, pid, session) ? { limits: session, kills: memory.oomKills(entry.sessionId) } : null
  }

  /** A new turn starts with nothing said yet: how it stands, and whether it was sent back. */
  private resetTurnStatus(entry: ChatEntry): void {
    entry.declared = false
    entry.status = null
    entry.call = null
    entry.callCtx = null
    entry.asks = false
    entry.replyText = ''
    entry.reminded = false
    entry.alone = null
  }

  /** Whom the session's call is read against. Without the host's word on it: the space's agent, and nobody else known. */
  private async turnOf(entry: ChatEntry): Promise<SessionTurn> {
    const known = await this.ctx.turnContext?.(entry.sessionId).catch((error: unknown) => {
      this.log(`turn context of ${entry.sessionId} not read: ${error instanceof Error ? error.message : 'unknown error'}`)
      return null
    })
    if (known) return known
    const agent = this.ctx.spaces.resolve(this.ctx.ledger.get(entry.sessionId)?.spaceId ?? null).agent
    return { ctx: turnContextOf({ owner: 'user', agent }), task: null }
  }

  private reporting(entry: ChatEntry): NonNullable<SessionRuntimeStart['worker']> {
    return {
      onPrompt: () => {
        const stored = this.ctx.ledger.get(entry.sessionId)
        // A greeted session was already told to name itself once the user's reply shows the topic; a session with a
        // task is called by its task, which its task context asks it to name.
        const name = stored && !stored.worker && !stored.greeted && !stored.taskId && !stored.title && !stored.agentTitle ? NAME_YOURSELF : null
        // The agent saw a tool die (exit 137) without a reason: this is the reason.
        const ceiling = entry.ceilingNote ? `The cockpit: ${entry.ceilingNote}` : null
        entry.ceilingNote = null
        const lifted = entry.liftNote ? `The cockpit: ${entry.liftNote}` : null
        entry.liftNote = null
        return [ceiling, lifted, name].filter(Boolean).join('\n\n') || null
      },
      endTurn: async (call) => {
        const turn = await this.turnOf(entry)
        const derived = deriveTurn(call, turn.ctx)
        // A check at a time that has passed wakes nobody: the call is refused whole, so the agent names another.
        // A time that sets no check (a step for the user) is not looked at.
        const passed = derived.checkAt ? passedWhen(call, this.ctx.callTime?.() ?? { now: Date.now(), zone: Intl.DateTimeFormat().resolvedOptions().timeZone }) : null
        if (passed) throw new Error(passed)
        entry.declared = true
        entry.replyText = ''
        entry.status = derived.status
        entry.call = call
        entry.callCtx = turn.ctx
        entry.asks = (call.questions?.length ?? 0) > 0
        // What the lists show under the session: the question it waits on, why it failed, else where the task stands.
        const reason = call.failed ?? call.questions?.[0] ?? call.result
        // The flag says what the user is asked; the turn still ends as done (decision desk-dot-until-seen).
        this.ctx.ledger.setAttention(entry.sessionId, { kind: derived.status, reason })
        const problem = await this.ctx.turnCheck?.(entry.sessionId, { at: derived.checkAt, call, turn }) ?? null
        return {
          derived,
          missing: missingOf(call, { taskOpen: turn.task?.open ?? false, ctx: turn.ctx }),
          ...(problem && derived.checkAt ? { checkProblem: problem } : {}),
        }
      },
      report: (status, reason) => {
        entry.declared = true
        entry.replyText = ''
        entry.status = status
        entry.call = null
        entry.callCtx = null
        entry.asks = status === 'question'
        this.ctx.ledger.setAttention(entry.sessionId, { kind: status, reason })
      },
      onTurnEnding: async () => {
        // Read now: its task may have been handed over or taken back during the turn. The turn's end reads it from here.
        entry.alone = await this.worksAlone(entry.sessionId)
        // Its subagents still run: they wake it again, and that turn says how it stands.
        if (stillRunning({ agents: entry.runningAgents.size, status: entry.status })) return null
        const ask = shouldAskForStatus({ alone: entry.alone, clients: entry.clients.size, declared: entry.declared, asked: entry.reminded })
        const missing: Missing[] = ask ? ['call'] : missingReply({ called: entry.status !== null, questions: entry.asks, reply: entry.replyText, clients: entry.clients.size })
        // One reminder per turn, naming everything it lacks: no call and unasked questions only while nobody has the session open, no reply always.
        if (entry.reminded || missing.length === 0) return null
        entry.reminded = true
        return reminder(missing)
      },
    }
  }

  /** Whether the session works on its own now; without the reader (tests), by how it was started. */
  private async worksAlone(sessionId: string): Promise<boolean> {
    const started = () => this.ctx.ledger.get(sessionId)?.worker === true
    return this.ctx.worksAlone ? this.ctx.worksAlone(sessionId).catch(started) : started()
  }

  /** The turn its subagents woke has started: working again, which also takes back a done about to show. */
  private wake(entry: ChatEntry): void {
    if (!entry.parked) return
    entry.parked = false
    entry.held = false
    this.ctx.onTurn(entry.sessionId, 'working')
  }

  /** The done that was held back is due now: the session's run is over, or cut off. */
  private releaseHeld(entry: ChatEntry): void {
    entry.parked = false
    if (!entry.held) return
    entry.held = false
    this.ctx.onTurn(entry.sessionId, 'done')
  }

  private onRuntimeEvent(entry: ChatEntry, event: RuntimeEvent): void {
    entry.lastActivity = Date.now()
    if (startsTurn(event)) this.wake(entry)
    switch (event.kind) {
      case 'settings':
        if (event.mode) this.ctx.ledger.setChatSettings(entry.sessionId, { mode: event.mode })
        break
      case 'conversation_reset':
        this.ctx.ledger.bindProviderSession(entry.sessionId, event.conversationId)
        break
      case 'activity':
        entry.active = event.state !== 'idle'
        break
      case 'permission_request':
      case 'question':
        entry.openRequests.add(event.requestId)
        this.ctx.onTurn(entry.sessionId, 'waiting')
        break
      case 'request_settled':
        entry.openRequests.delete(event.requestId)
        if (event.outcome !== 'cancelled' && entry.openRequests.size === 0) this.ctx.onTurn(entry.sessionId, 'working')
        break
      case 'shell_task':
      case 'agent_task':
        if (event.status === 'running') entry.backgroundTasks.add(event.taskId)
        else if (event.status) entry.backgroundTasks.delete(event.taskId)
        if (event.kind === 'agent_task' && event.status === 'running') entry.runningAgents.add(event.taskId)
        else if (event.status) entry.runningAgents.delete(event.taskId)
        if (event.kind === 'agent_task' && event.status && entry.parked) {
          this.ctx.onHelpers?.(entry.sessionId, entry.runningAgents.size)
          // The last one is back: done, unless the turn it wakes starts within a moment (wake).
          if (entry.runningAgents.size === 0 && entry.held) {
            entry.held = false
            this.ctx.onTurn(entry.sessionId, 'done', HELPERS_BACK_SETTLE_MS)
          }
        }
        break
      case 'tool_call':
        // The reply comes after the call: what was written before it is not it.
        if (END_OF_TURN_TOOLS.some((name) => event.name === name || event.name.endsWith(`__${name}`))) entry.replyText = ''
        break
      case 'text':
        entry.replyText += event.text
        entry.turnText += event.text
        break
      case 'turn_end': {
        entry.active = false
        entry.turnEnded?.()
        // A closing session's turn is settled by close(): cut off by a host going down, over otherwise.
        if (!entry.closing) this.ctx.ledger.setTurnInFlight(entry.sessionId, false)
        // Its subagents still run: no stop yet. No flag, no result, no handoff to route,
        // no next-step check, nothing archived; the turn they wake starts over.
        if (event.reason !== 'interrupted' && !entry.closing && stillRunning({ agents: entry.runningAgents.size, status: entry.status })) {
          entry.turnText = ''
          this.resetTurnStatus(entry)
          // Its turn state stays working (holdTurnOpen kept the Stop hook's done back), and says what it waits for.
          entry.held = true
          entry.parked = true
          this.ctx.onHelpers?.(entry.sessionId, entry.runningAgents.size)
          break
        }
        // The last subagent came back between the Stop hook and here, or the user stopped the turn: nothing follows.
        if (!entry.closing) this.releaseHeld(entry)
        const attention = attentionAfterTurn({
          // A turn that ended without its Stop hook (an error) goes by how the session was started.
          alone: entry.alone ?? this.ctx.ledger.get(entry.sessionId)?.worker === true, clients: entry.clients.size, declared: entry.declared, reason: event.reason,
        })
        if (attention) {
          this.ctx.ledger.setAttention(entry.sessionId, { kind: attention, reason: null })
        }
        // An interrupted turn left nothing to look at, and a host going down is not its end.
        if (!entry.closing && event.reason !== 'interrupted') {
          this.ctx.ledger.setResult(entry.sessionId, true)
          this.ctx.turnDone?.(entry.sessionId, entry.turnText, { call: entry.call, ctx: entry.callCtx, reminded: entry.reminded, said: entry.declared })
          if (!entry.stopAfterTurn) entry.worked = true
        }
        entry.turnText = ''
        // Its handoff before an idle stop is written: now it stops.
        if (entry.stopAfterTurn && !entry.closing) {
          entry.stopAfterTurn = false
          void this.end(entry.sessionId, IDLE_STOP)
        }
        break
      }
      case 'runtime_exit':
        // Before the exit shows: the session may have been the process the kernel stopped.
        this.reportCeilingKills(entry, !event.expected)
        if (!event.expected) this.ctx.memory?.release(entry.sessionId)
        entry.runtime = null
        entry.active = false
        entry.openRequests.clear()
        entry.backgroundTasks.clear()
        entry.runningAgents.clear()
        entry.turnEnded?.()
        // Its subagents went with the process: nothing wakes it any more. After a crash onExit clears the state.
        if (event.expected) this.releaseHeld(entry)
        else { entry.held = false; entry.parked = false }
        // No Stop hook comes after a crash, so nothing else would end its turn state.
        if (!event.expected) {
          this.ctx.onExit?.(entry.sessionId)
          this.log(`runtime of ${entry.sessionId} ended unexpectedly; the next message resumes it`)
        }
        break
      default:
    }
    this.emit(entry, event)
  }

  private emit(entry: ChatEntry, event: RuntimeEvent): void {
    const stored = this.ctx.events.append(entry.sessionId, event)
    for (const ws of entry.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue
      // Too far behind: drop the socket, its client asks for what it missed.
      if (ws.bufferedAmount > WS_MAX_BUFFERED) { try { ws.close(1013, 'behind') } catch { /* closing */ } continue }
      send(ws, { type: 'event', seq: stored.seq, event: stored.event })
    }
  }

  private sendMessage(entry: ChatEntry, message: string, imageNames: string[] = [], clientId = '', reminder = false): void {
    if (!message.trim() && imageNames.length === 0) return
    // Someone wrote to it: an idle stop it was about to make is off.
    entry.stopAfterTurn = false
    if (entry.closing) throw new Error('This session is closing. Send that again in a moment.')
    // First: an image that can't be read must not leave half a message behind.
    const images = imageNames.map(readPastedImage)
    this.ensureStarted(entry)
    const id = SAFE_ID.test(clientId) ? clientId : randomUUID()
    this.emit(entry, {
      kind: 'user_message', id, text: message, queued: entry.active,
      ...(images.length > 0 ? { images: images.map(({ url }) => ({ url })) } : {}),
    })
    entry.lastActivity = Date.now()
    // A new turn: whoever it waited for has answered.
    this.resetTurnStatus(entry)
    this.wake(entry)
    // The turn a reminder starts is the stop's second chance: it had its reminder.
    if (reminder) entry.reminded = true
    const asked = this.ctx.ledger.get(entry.sessionId)
    if (asked?.attention || asked?.taskId) this.ctx.answered?.(entry.sessionId)
    this.ctx.ledger.setAttention(entry.sessionId, null)
    this.ctx.ledger.setResult(entry.sessionId, false)
    this.ctx.ledger.unarchive(entry.sessionId)
    this.ctx.ledger.setTurnInFlight(entry.sessionId, true)
    if (!entry.active) {
      entry.active = true
      this.emit(entry, { kind: 'activity', state: 'working' })
    }
    entry.runtime?.send(id, message, images.map(({ mediaType, data }) => ({ mediaType, data })))
  }

  private async sendToolServers(entry: ChatEntry, ws: WebSocket, failure: string | null = null): Promise<void> {
    if (!entry.runtime) {
      send(ws, { type: 'tool_servers', servers: [], error: failure ?? 'The session is not running right now. It starts with the next message.' })
      return
    }
    try {
      send(ws, { type: 'tool_servers', servers: await entry.runtime.toolServers(), error: failure })
    } catch (error) {
      send(ws, { type: 'tool_servers', servers: [], error: failure ?? (error instanceof Error ? error.message : String(error)) })
    }
  }

  /** Whatever comes of it, the client gets the servers as they are now. */
  private async changeToolServer(entry: ChatEntry, ws: WebSocket, name: string, action: string): Promise<void> {
    let failure: string | null = null
    try {
      if (action === 'enable' || action === 'disable') await entry.runtime?.setToolServerEnabled(name, action === 'enable')
      else if (action === 'reconnect') await entry.runtime?.reconnectToolServer(name)
    } catch (error) {
      // A server that wants a sign-in throws here though it did what was asked; the
      // list says so and the panel says where to sign in. Anything else is a failure.
      const message = error instanceof Error ? error.message : String(error)
      if (!/needs-auth/.test(message)) failure = `${name}: ${message}`
    }
    await this.sendToolServers(entry, ws, failure)
  }

  /** A client on a running session: it joins the others and gets what it does not have. */
  private join(entry: ChatEntry, ws: WebSocket, epoch: number | null, after: number): void {
    entry.clients.add(ws)
    entry.lastActivity = Date.now()
    const current = this.ctx.events.epoch(entry.sessionId)
    const from = epoch === current ? after : 0
    if (epoch !== current) send(ws, { type: 'reset', epoch: current })
    for (const stored of this.ctx.events.after(entry.sessionId, from)) send(ws, { type: 'event', seq: stored.seq, event: stored.event })
    send(ws, { type: 'limits', ...this.limitsOf(entry.sessionId) })
    send(ws, { type: 'joined' })
  }

  private projectFor(space: BrainSpace, projectId: string): ProjectEntry | null {
    let project = space.registry.get(projectId)
    if (!project) {
      const brainId = brainIdFromProjectId(projectId)
      if (brainId) {
        const brain = space.projects.cached()?.find((p) => p.id === brainId)
        project = space.registry.ensureBrain(brainId, brain?.name ?? brainId)
      }
    }
    if (!project) return null
    if (!project.path) project = space.registry.ensureCockpitFolder(project.projectId)
    return project
  }
}

/** What only a turn of the session's own agent sends: its subagents' events are of other kinds. */
function startsTurn(event: RuntimeEvent): boolean {
  switch (event.kind) {
    case 'activity': return event.state !== 'idle'
    case 'text_delta': case 'text': case 'thinking_delta': case 'thinking': case 'tool_call': return true
    default: return false
  }
}
