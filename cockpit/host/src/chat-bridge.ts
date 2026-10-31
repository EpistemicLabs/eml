import { randomBytes, randomUUID } from 'node:crypto'
import { WebSocket, type RawData } from 'ws'
import type { AgentProvider, TurnState } from './domain/agent-provider.js'
import type {
  EventStore, PermissionAnswer, RuntimeEvent, SessionRuntime, SessionRuntimeFactory,
} from './domain/session-runtime.js'
import type { SessionHandoff } from './application/session-handoff.js'
import type { ProviderRegistry } from './infrastructure/providers/registry.js'
import { sessionSpaceOf, type BrainSpace, type BrainSpaces } from './brain-space.js'
import type { ProjectEntry } from './project-registry.js'
import type { SessionLedger } from './session-ledger.js'
import { brainIdFromProjectId } from './project-registry.js'
import { baseAgentEnv, type SessionState } from './pty-bridge.js'
import { sessionAddress } from './session-address.js'

/**
 * Chat view ↔ session runtime, beside pty-bridge.ts for the terminal: one running
 * runtime per session, the session's events numbered in an EventStore, and at
 * most one client on a session.
 *
 * Wire protocol:
 *   client → { type:'init', paneId, projectId, sessionId, spaceId?, epoch?, after? }
 *   client → { type:'send', text }
 *   client → { type:'interrupt' }
 *   client → { type:'answer', requestId, answer }
 *   host   → { type:'switching', reason }           (the handoff is under way)
 *   host   → { type:'reset', epoch }                (drop the view, numbers start over)
 *   host   → { type:'event', seq, event }
 *   host   → { type:'error', message }
 *
 * Attach handshake as for the terminal: POST /api/chat mints a one-time nonce, the
 * WS upgrade presents it (+ same-origin); the session identity travels in `init`.
 */

// As for a terminal: the session outlives its client for this long, so a reload or
// a lost connection never costs a running turn.
const DETACHED_TIMEOUT_MS = 30 * 60 * 1000
// How long a switch lets an interrupted turn finish on its own before closing it.
const INTERRUPT_WAIT_MS = 3_000
// Socket buffer above which a client is too far behind to keep streaming to; it
// reconnects and asks for what it missed.
const WS_MAX_BUFFERED = 16 * 1024 * 1024

const SAFE_ID = /^[a-zA-Z0-9_.\-:]+$/

const CARRY_OVER_NOTICE = 'This chat continues the terminal session. "Allow for this session" grants from there do not carry over.'

interface ChatEntry {
  sessionId: string
  spaceId: string
  projectId: string
  projectPath: string
  runtime: SessionRuntime | null
  ws: WebSocket | null
  active: boolean
  openRequests: Set<string>
  timeoutId: NodeJS.Timeout | null
  turnEnded: (() => void) | null
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
}

type ClientMessage = {
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

  sessionState(sessionId: string): SessionState {
    const entry = this.entries.get(sessionId)
    if (!entry?.runtime) return 'ended'
    return entry.ws?.readyState === WebSocket.OPEN ? 'running' : 'detached'
  }

  /** Close the session's runtime, and resolve once its process has exited. The client is told not to reconnect. */
  async end(sessionId: string, reason = 'superseded'): Promise<void> {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    if (entry.timeoutId) { clearTimeout(entry.timeoutId); entry.timeoutId = null }
    const runtime = entry.runtime
    if (runtime) {
      if (entry.active && entry.openRequests.size === 0) await this.interruptAndWait(entry, runtime)
      await runtime.close()
      entry.runtime = null
    }
    try { entry.ws?.close(1000, reason) } catch { /* closing */ }
    entry.ws = null
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
    await Promise.all([...this.entries.keys()].map((id) => this.end(id, 'host shutdown').catch(() => { /* best-effort */ })))
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
        if (!entry || entry.ws !== ws) return
        if (data.type === 'send') this.sendMessage(entry, text(data.text))
        else if (data.type === 'interrupt') void entry.runtime?.interrupt().catch((error: Error) => this.emit(entry, { kind: 'error', message: error.message }))
        else if (data.type === 'answer') {
          const answer = parseAnswer(data.answer)
          if (answer) entry.runtime?.answerPermission(text(data.requestId), answer)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.log(`error: ${message}`)
        send(ws, { type: 'error', message })
      }
    })

    ws.on('close', () => {
      if (!sessionId) return
      const entry = this.entries.get(sessionId)
      if (!entry || entry.ws !== ws) return
      entry.ws = null
      // A grace period, not an abort: a reload must not cost the running turn or an open card.
      entry.timeoutId = setTimeout(() => {
        const current = this.entries.get(entry.sessionId)
        if (!current || current.ws) return
        this.log(`detached session ${entry.sessionId} timed out → closing (resumable via ledger)`)
        void this.end(entry.sessionId, 'timed out')
      }, DETACHED_TIMEOUT_MS)
      entry.timeoutId.unref?.()
    })

    ws.on('error', (error) => this.log(`ws error: ${error.message}`))
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

    const after = typeof data.after === 'number' ? data.after : 0
    const epoch = typeof data.epoch === 'number' ? data.epoch : null
    const path = project.path
    const handoff = this.handoff()
    if (handoff.switching(sessionId)) send(ws, { type: 'switching', reason: 'Waiting for the terminal session to end…' })
    const entered = handoff.enter('sdk', sessionId, () => this.open(ws, {
      sessionId, paneId, projectId, projectPath: path, space, provider, epoch, after,
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
    onSwitch: () => void
  }): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN) return
    const { sessionId, paneId, projectId, projectPath, space, provider } = opts
    const existing = this.entries.get(sessionId)
    if (existing) {
      this.takeOver(existing, ws, opts.epoch, opts.after)
      this.ctx.ledger.touch(sessionId, paneId)
      return
    }

    opts.onSwitch()
    const fromTerminal = this.ctx.ledger.get(sessionId)?.runtime === 'terminal'
    const resume = this.ctx.ledger.has(sessionId) && provider.canResume(this.ctx.ledger.ref(sessionId, null, space.agent))
    const entry: ChatEntry = {
      sessionId, spaceId: space.id, projectId, projectPath, runtime: null, ws, active: false,
      openRequests: new Set(), timeoutId: null, turnEnded: null,
    }
    this.entries.set(sessionId, entry)
    const epoch = this.ctx.events.reset(sessionId)
    send(ws, { type: 'reset', epoch })
    // The view is rebuilt from the transcript, which holds what the terminal added
    // and was never streamed; from here on it renders from this one log.
    if (resume) {
      for (const event of await this.ctx.runtimes.history(sessionId, projectPath, space.agent)) this.emit(entry, event)
      if (fromTerminal) this.emit(entry, { kind: 'notice', text: CARRY_OVER_NOTICE })
    }
    provider.trustProject(projectPath, sessionSpaceOf(space))
    this.ctx.ledger.recordSpawn(sessionId, paneId, projectId, provider.id, false, null, space.ledgerKey)
    this.ctx.ledger.setRuntime(sessionId, 'sdk')
    // A terminal session kept for Remote Control is not one any more.
    this.ctx.ledger.setKeepRunning(sessionId, false)
    this.startRuntime(entry, provider, space, resume)
    this.log(`${resume ? 'resuming' : 'starting'} chat session ${sessionId} in ${projectPath}`)
  }

  private startRuntime(entry: ChatEntry, provider: AgentProvider, space: BrainSpace, resume: boolean): void {
    const { sessionId, projectId, projectPath } = entry
    const address = sessionAddress(sessionId, projectId)
    const { providerSessionId } = this.ctx.ledger.ref(sessionId, null)
    const launch = provider.launch({
      sessionId, address, providerSessionId, resume, initialPrompt: null, unattended: false,
      space: sessionSpaceOf(space),
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
    entry.runtime = this.ctx.runtimes.start({
      sessionId, resume, cwd: projectPath, env, address,
      files: { mcpConfig: space.files.mcpConfig, settings: space.files.settings },
      strictMcp: !!space.agent,
      onEvent: (event) => this.onRuntimeEvent(entry, event),
    })
  }

  private onRuntimeEvent(entry: ChatEntry, event: RuntimeEvent): void {
    switch (event.kind) {
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
      case 'turn_end':
        entry.active = false
        entry.turnEnded?.()
        break
      case 'runtime_exit':
        entry.runtime = null
        entry.active = false
        entry.openRequests.clear()
        entry.turnEnded?.()
        if (!event.expected) this.log(`runtime of ${entry.sessionId} ended unexpectedly; the next message resumes it`)
        break
      default:
    }
    this.emit(entry, event)
  }

  private emit(entry: ChatEntry, event: RuntimeEvent): void {
    const stored = this.ctx.events.append(entry.sessionId, event)
    const ws = entry.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    // Too far behind: drop the socket, its client asks for what it missed.
    if (ws.bufferedAmount > WS_MAX_BUFFERED) { try { ws.close(1013, 'behind') } catch { /* closing */ } return }
    send(ws, { type: 'event', seq: stored.seq, event: stored.event })
  }

  private sendMessage(entry: ChatEntry, message: string): void {
    if (!message.trim()) return
    // A crash leaves the entry without a runtime; the conversation goes on.
    if (!entry.runtime) {
      const space = this.ctx.spaces.get(entry.spaceId)
      const provider = this.ctx.providers.forSession(entry.sessionId)
      if (!space) throw new Error('This session\'s brain space is gone')
      this.startRuntime(entry, provider, space, provider.canResume(this.ctx.ledger.ref(entry.sessionId, null, space.agent)))
    }
    const id = randomUUID()
    this.emit(entry, { kind: 'user_message', id, text: message, queued: entry.active })
    if (!entry.active) {
      entry.active = true
      this.emit(entry, { kind: 'activity', state: 'working' })
    }
    entry.runtime?.send(id, message)
  }

  /** A client on a running session: it takes the session over and gets what it does not have. */
  private takeOver(entry: ChatEntry, ws: WebSocket, epoch: number | null, after: number): void {
    if (entry.timeoutId) { clearTimeout(entry.timeoutId); entry.timeoutId = null }
    const old = entry.ws
    if (old && old !== ws && old.readyState === WebSocket.OPEN) {
      try { old.close(1000, 'superseded') } catch { /* closing */ }
    }
    entry.ws = ws
    const current = this.ctx.events.epoch(entry.sessionId)
    const from = epoch === current ? after : 0
    if (epoch !== current) send(ws, { type: 'reset', epoch: current })
    for (const stored of this.ctx.events.after(entry.sessionId, from)) send(ws, { type: 'event', seq: stored.seq, event: stored.event })
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

