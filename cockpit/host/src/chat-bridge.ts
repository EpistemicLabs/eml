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
import type { SpawnRequest } from './domain/spawn-request.js'
import { chatSessionShouldStop } from './domain/session-lifecycle.js'
import type { DeliveryOutcome } from './domain/session-delivery.js'
import { attentionAfterTurn, missingSummary, needsAnswer, shouldAskForStatus, type WorkerStatus } from './domain/session-attention.js'

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
 *   client → { type:'tool_servers' }
 *   client → { type:'tool_server', name, action:'enable'|'disable'|'reconnect' }
 *   client → { type:'set_mode', mode }
 *   client → { type:'set_model', model }
 *   client → { type:'stop_agent', taskId }
 *   host   → { type:'terminal_busy', state }        (init with whenIdle refused: send it again later)
 *   host   → { type:'switching', reason }           (the handoff is under way)
 *   host   → { type:'joined' }                      (the session takes messages from this socket now)
 *   host   → { type:'reset', epoch }                (drop the view, numbers start over)
 *   host   → { type:'event', seq, event }
 *   host   → { type:'tool_servers', servers, error }  (a snapshot, not part of the event log)
 *   host   → { type:'error', message }
 *
 * Attach handshake as for the terminal: POST /api/chat mints a one-time nonce, the
 * WS upgrade presents it (+ same-origin); the session identity travels in `init`.
 */

// How long a switch lets an interrupted turn finish on its own before closing it.
const INTERRUPT_WAIT_MS = 3_000
// The one reason a closed turn counts as cut off: the next host start carries it on.
export const HOST_SHUTDOWN = 'host shutdown'
// Socket buffer above which a client is too far behind to keep streaming to; it
// reconnects and asks for what it missed.
const WS_MAX_BUFFERED = 16 * 1024 * 1024

const MAX_IMAGES = 10
const SAFE_ID = /^[a-zA-Z0-9_.\-:]+$/
// A model id may carry a variant: `opus[1m]`.
const SAFE_MODEL = /^[a-zA-Z0-9_.\-:[\]]+$/

// The mode a worker runs in, as in the terminal: nobody is there to answer.
const WORKER_MODE = 'auto'

// Without this a session started by hand stays nameless: the greeting that used to ask has gone.
const NAME_YOURSELF = 'Once this exchange shows what the session is about, name it in a few words, in the background of your work and without mentioning it: node "$COCKPIT_TITLE_JS" \'<title>\'. The title goes in single quotes.'

const STATUS_REMINDER = 'You have not said how you stand. Call session_status with done, question, review or failed, and a reason of one line: the result, or what you need. Then write your closing summary as visible text.'

// What the person reads is the reply after the status, never the status call or thinking.
const SUMMARY_SHAPE = 'In a few lines: what was asked, what you did, what changed (files, links); then, for a question, the questions as a numbered list, for review what to check, for failed what went wrong.'
const SUMMARY_REMINDER = `Your turn ends without a visible reply. Write your closing summary now, as text, not in thinking. ${SUMMARY_SHAPE}`
const QUESTIONS_REMINDER = `You said you have a question, but your reply does not ask it. Write the questions as visible text, as a numbered list, each one answerable on its own. ${SUMMARY_SHAPE}`

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
  lastActivity: number
  /** Being closed: a message now would go down with the process. */
  closing: boolean
  /** Resolves once a closing entry is gone. */
  closed: Promise<void> | null
  /** This turn the worker said how it stands, or was asked to. */
  declared: boolean
  askedStatus: boolean
  /** The status said this turn, and the visible text written after it: the closing summary. */
  status: WorkerStatus | null
  textAfterStatus: string
  askedSummary: boolean
}

export interface ChatContext {
  ledger: SessionLedger
  providers: ProviderRegistry
  spaces: BrainSpaces
  sessionEnv: Record<string, string>
  runtimes: SessionRuntimeFactory
  events: EventStore
  /** Report a session's turn state where hooks can't: a permission card brings no Notification hook. */
  onTurn: (sessionId: string, state: Exclude<TurnState, 'idle'>) => void
  /** The session's process died on its own: whatever its turn state said no longer holds. */
  onExit?: (sessionId: string) => void
  /** Whether a terminal process holds this session: a read-only view can't take it from there. */
  terminalRuns?: (sessionId: string) => boolean
  /** What the session's terminal process is in the middle of, if anything: a takeover would cut it off. */
  terminalBusy?: (sessionId: string) => 'working' | 'waiting' | null
}

type ClientMessage = {
  id?: unknown
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

  // ── The chat side of the handoff ─────────────────────────────────────
  isRunning(sessionId: string): boolean {
    return this.entries.get(sessionId)?.runtime != null
  }

  /** Background tasks (shell or agent) of its own still running: ending the process would kill them. */
  backgroundTasks(sessionId: string): number {
    return this.entries.get(sessionId)?.backgroundTasks.size ?? 0
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
    }
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
    for (const entry of [...this.entries.values()]) {
      const stop = chatSessionShouldStop({
        clients: entry.clients.size,
        running: entry.runtime !== null,
        turnActive: entry.active,
        backgroundTasks: entry.backgroundTasks.size,
        openRequests: entry.openRequests.size,
        worker: this.ctx.ledger.get(entry.sessionId)?.worker === true,
        quietMs: now - entry.lastActivity,
      })
      if (!stop) continue
      void this.end(entry.sessionId, 'timed out')
      ended += 1
    }
    return ended
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
        else if (data.type === 'send') this.sendMessage(entry, text(data.text), parseImageNames(data.images), text(data.id))
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
        } else if (data.type === 'tool_servers') void this.sendToolServers(entry, ws)
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
    const project = this.projectFor(space, projectId)
    if (!project?.path) return refuse('Unknown project, or it has no folder')
    const provider = this.ctx.ledger.has(sessionId) ? this.ctx.providers.forSession(sessionId) : this.ctx.providers.get('claude')
    if (!provider || provider.id !== 'claude') return refuse('The chat view runs Claude Code sessions only. This session stays in the terminal.')
    const problem = provider.runtime.problem()
    if (problem) return refuse(`${problem} ${provider.runtime.problemHint}`)
    // A space with its own agent never falls back to the shared config.
    const agentProblem = space.agent?.problem(provider.id)
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
    const handoff = this.handoff()
    if (handoff.switching(sessionId)) send(ws, { type: 'switching', reason: 'Waiting for the terminal session to end…' })
    const entered = handoff.enter('sdk', sessionId, () => this.open(ws, {
      sessionId, paneId, projectId, projectPath: path, space, provider, epoch, after,
      readOnly,
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
    const resume = this.ctx.ledger.has(sessionId) && provider.canResume(this.ctx.ledger.ref(sessionId, null, space.agent))
    const entry: ChatEntry = {
      sessionId, spaceId: space.id, projectId, projectPath, runtime: null, clients: new Set([ws]), active: false,
      openRequests: new Set(), turnEnded: null, backgroundTasks: new Set(), lastActivity: Date.now(), closing: false, closed: null, declared: false, askedStatus: false, status: null, textAfterStatus: '', askedSummary: false,
    }
    this.entries.set(sessionId, entry)
    const epoch = this.ctx.events.reset(sessionId)
    send(ws, { type: 'reset', epoch })
    // The view is rebuilt from the transcript, which holds what the terminal added
    // and was never streamed; from here on it renders from this one log.
    if (resume) {
      const conversationId = this.ctx.ledger.ref(sessionId, null).providerSessionId ?? sessionId
      for (const event of await this.ctx.runtimes.history(conversationId, projectPath, space.agent)) this.emit(entry, event)
      if (fromTerminal) this.emit(entry, { kind: 'notice', text: CARRY_OVER_NOTICE })
    }
    if (opts.readOnly) {
      if (!entry.runtime) this.emit(entry, { kind: 'process', state: 'stopped' })
    } else this.startEntry(entry, provider, space, paneId, resume)
    send(ws, { type: 'joined' })
  }

  /** The session gets its process here, once someone uses it. */
  private startEntry(entry: ChatEntry, provider: AgentProvider, space: BrainSpace, paneId: string | null, resume: boolean): void {
    // A message can arrive while the view still loads, and it starts the session first.
    if (entry.runtime) return
    const { sessionId, projectId, projectPath } = entry
    provider.trustProject(projectPath, sessionSpaceOf(space))
    this.ctx.ledger.recordSpawn(sessionId, paneId, projectId, provider.id, false, null, space.ledgerKey)
    this.ctx.ledger.setRuntime(sessionId, 'sdk')
    // A worker runs unattended in the terminal too, whatever Settings says for other sessions.
    const stored = this.ctx.ledger.get(sessionId)
    if (stored?.worker && !stored.chatMode) this.ctx.ledger.setChatSettings(sessionId, { mode: WORKER_MODE })
    // A terminal session kept for Remote Control is not one any more.
    this.ctx.ledger.setKeepRunning(sessionId, false)
    this.startRuntime(entry, provider, space, resume)
    this.log(`${resume ? 'resuming' : 'starting'} chat session ${sessionId} in ${projectPath}`)
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
    this.startEntry(entry, provider, space, this.ctx.ledger.get(sessionId)?.paneId ?? null, known && provider.canResume(this.ctx.ledger.ref(sessionId, null, space.agent)))
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
    const problem = provider.runtime.problem() ?? space.agent?.problem(provider.id)
    if (problem) return problem
    if (this.entries.has(sessionId)) return 'already running'
    const { projectId, path } = project
    let failure: string | null = null
    // A new id has no other side to wait for, so this runs right away.
    void this.handoff().enter('sdk', sessionId, () => {
      const entry: ChatEntry = {
        sessionId, spaceId: space.id, projectId, projectPath: path, runtime: null, clients: new Set(), active: false,
        openRequests: new Set(), turnEnded: null, backgroundTasks: new Set(), lastActivity: Date.now(), closing: false, closed: null, declared: false, askedStatus: false, status: null, textAfterStatus: '', askedSummary: false,
      }
      this.entries.set(sessionId, entry)
      this.ctx.events.reset(sessionId)
      try {
        provider.trustProject(path, sessionSpaceOf(space))
        // Started by hand it is the user's own session, in the mode they use: only a session's worker runs unattended.
        const worker = request.fromSessionId !== null
        this.ctx.ledger.recordSpawn(sessionId, null, projectId, provider.id, worker, null, space.ledgerKey)
        this.ctx.ledger.setRuntime(sessionId, 'sdk')
        if (worker) this.ctx.ledger.setChatSettings(sessionId, { mode: WORKER_MODE })
        if (request.title) this.ctx.ledger.setAgentTitle(sessionId, request.title)
        if (request.wakeable) this.ctx.ledger.setWakeable(sessionId)
        if (request.toolProfile) this.ctx.ledger.setToolProfile(sessionId, request.toolProfile)
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
   */
  async deliver(sessionId: string, text: string): Promise<DeliveryOutcome> {
    if (this.handoff().switching(sessionId)) return 'busy'
    const running = this.entries.get(sessionId)
    if (running) {
      if (running.closing) return 'busy'
      this.sendMessage(running, text)
      return 'delivered'
    }
    const stored = this.ctx.ledger.get(sessionId)
    if (!stored?.projectId) return 'unknown'
    const projectId = stored.projectId
    const space = this.ctx.spaces.resolve(stored.spaceId)
    const path = this.projectFor(space, projectId)?.path
    const provider = this.ctx.providers.forSession(sessionId)
    if (!path || provider.runtime.problem() || space.agent?.problem(provider.id)) return 'refused'
    await this.handoff().enter('sdk', sessionId, async () => {
      const entry: ChatEntry = {
        sessionId, spaceId: space.id, projectId, projectPath: path, runtime: null, clients: new Set(), active: false,
        openRequests: new Set(), turnEnded: null, backgroundTasks: new Set(), lastActivity: Date.now(), closing: false, closed: null, declared: false, askedStatus: false, status: null, textAfterStatus: '', askedSummary: false,
      }
      this.entries.set(sessionId, entry)
      this.ctx.events.reset(sessionId)
      const resume = provider.canResume(this.ctx.ledger.ref(sessionId, null, space.agent))
      if (resume) {
        const conversationId = this.ctx.ledger.ref(sessionId, null).providerSessionId ?? sessionId
        for (const event of await this.ctx.runtimes.history(conversationId, path, space.agent)) this.emit(entry, event)
      }
      provider.trustProject(path, sessionSpaceOf(space))
      this.ctx.ledger.recordSpawn(sessionId, stored.paneId, projectId, provider.id, false, null, space.ledgerKey)
      this.ctx.ledger.setRuntime(sessionId, 'sdk')
      if (stored.worker && !stored.chatMode) this.ctx.ledger.setChatSettings(sessionId, { mode: WORKER_MODE })
      this.startRuntime(entry, provider, space, resume)
      this.sendMessage(entry, text)
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
    const env = {
      ...baseAgentEnv(),
      ...launchEnv,
      ...this.ctx.sessionEnv,
      COCKPIT_SESSION_ID: sessionId,
      ...(brainId ? { EML_PROJECT_SCOPE: `project.${brainId}` } : {}),
    }
    const stored = this.ctx.ledger.get(sessionId)
    this.emit(entry, { kind: 'process', state: 'starting' })
    entry.runtime = this.ctx.runtimes.start({
      sessionId, resume, conversationId: providerSessionId, mode: stored?.chatMode ?? null, model: stored?.chatModel ?? null,
      cwd: projectPath, env, address,
      files: { mcpConfig: launch.limits?.mcpConfig ?? space.files.mcpConfig, settings: space.files.settings },
      strictMcp: !!space.agent || !!launch.limits?.mcpConfig,
      ...(space.agent?.chrome && !launch.limits?.mcpConfig ? { chrome: true } : {}),
      ...(launch.limits?.deniedTools.length ? { deniedTools: launch.limits.deniedTools } : {}),
      worker: this.reporting(entry),
      onEvent: (event) => this.onRuntimeEvent(entry, event),
    })
  }

  private reporting(entry: ChatEntry): NonNullable<SessionRuntimeStart['worker']> {
    return {
      onPrompt: () => {
        const stored = this.ctx.ledger.get(entry.sessionId)
        return stored && !stored.worker && !stored.title && !stored.agentTitle ? NAME_YOURSELF : null
      },
      report: (status, reason) => {
        entry.declared = true
        entry.status = status
        entry.textAfterStatus = ''
        this.ctx.ledger.setAttention(entry.sessionId, { kind: status, reason })
        if (needsAnswer(status)) this.ctx.onTurn(entry.sessionId, 'waiting')
      },
      onTurnEnding: () => {
        const ask = shouldAskForStatus({ worker: this.ctx.ledger.get(entry.sessionId)?.worker === true, clients: entry.clients.size, declared: entry.declared, asked: entry.askedStatus })
        if (ask) {
          entry.askedStatus = true
          return STATUS_REMINDER
        }
        const missing = missingSummary({ status: entry.status, textAfter: entry.textAfterStatus, asked: entry.askedSummary })
        if (!missing) return null
        entry.askedSummary = true
        return missing === 'questions' ? QUESTIONS_REMINDER : SUMMARY_REMINDER
      },
    }
  }

  private onRuntimeEvent(entry: ChatEntry, event: RuntimeEvent): void {
    entry.lastActivity = Date.now()
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
        break
      case 'text':
        if (entry.status) entry.textAfterStatus += event.text
        break
      case 'turn_end': {
        entry.active = false
        entry.turnEnded?.()
        // A closing session's turn is settled by close(): cut off by a host going down, over otherwise.
        if (!entry.closing) this.ctx.ledger.setTurnInFlight(entry.sessionId, false)
        const attention = attentionAfterTurn({
          worker: this.ctx.ledger.get(entry.sessionId)?.worker === true, clients: entry.clients.size, declared: entry.declared, reason: event.reason,
        })
        if (attention) {
          this.ctx.ledger.setAttention(entry.sessionId, { kind: attention, reason: null })
          if (needsAnswer(attention)) this.ctx.onTurn(entry.sessionId, 'waiting')
        }
        // An interrupted turn left nothing to look at, and a host going down is not its end.
        if (!entry.closing && event.reason !== 'interrupted') this.ctx.ledger.setResult(entry.sessionId, true)
        break
      }
      case 'runtime_exit':
        entry.runtime = null
        entry.active = false
        entry.openRequests.clear()
        entry.backgroundTasks.clear()
        entry.turnEnded?.()
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

  private sendMessage(entry: ChatEntry, message: string, imageNames: string[] = [], clientId = ''): void {
    if (!message.trim() && imageNames.length === 0) return
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
    entry.declared = false
    entry.askedStatus = false
    entry.status = null
    entry.textAfterStatus = ''
    entry.askedSummary = false
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

