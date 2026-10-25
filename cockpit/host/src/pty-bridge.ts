import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket, type RawData } from 'ws'
import type { IPty } from 'node-pty'
import type { ITerminalAddon as IHeadlessAddon, Terminal as HeadlessTerminalType } from '@xterm/headless'
import type { SerializeAddon as SerializeAddonType } from '@xterm/addon-serialize'
import { ensurePtyHelperExecutable } from './pty-helper.js'
import { platform } from './infrastructure/platform/index.js'
import type { Platform } from './domain/platform.js'
import type { ProviderRegistry } from './infrastructure/providers/registry.js'
import type { AgentProvider, TurnState } from './domain/agent-provider.js'
import type { SessionLedger } from './session-ledger.js'
import { brainIdFromProjectId } from './project-registry.js'
import { sessionAddress } from './session-address.js'
import type { BrainSpace, BrainSpaces } from './brain-space.js'
import { greetingFor } from './session-greeting.js'
import type { ProjectEntry } from './project-registry.js'
import type { SpawnRequest } from './spawn-queue.js'

/**
 * PTY ↔ browser bridge with a persistent session registry.
 *
 * Headless-xterm snapshot replay on reattach, supersede of a prior socket,
 * resize coalescing + SIGWINCH wiggle, first-chunk size resend, output
 * coalescing, WS backpressure, detached-session timeout (not for sessions kept
 * running for Remote Control until their pane is closed; a host start brings
 * those back). Sessions are spawned
 * directly and isolated: the session's agent provider (domain/agent-provider.ts) supplies binary,
 * arguments and its isolated config — for Claude Code the cockpit's own `claude`
 * with the app's CLAUDE_CONFIG_DIR + --mcp-config (brain) + --settings —,
 * cwd = the pane's PROJECT path (decision cockpit-isolation-scope-clarified),
 * session id from the pane (decision cockpit-session-resume-strategy).
 *
 * Wire protocol:
 *   client → { type:'init', paneId, projectId, sessionId, cols, rows, initialCommand?, greet?, isDarkMode?, provider? }
 *   client → { type:'input', data }
 *   client → { type:'resize', cols, rows }
 *   host   → binary frame [0x01, ...utf8]           (pty output, hot path)
 *   host   → { type:'output', data }                (snapshot replay, notices)
 *   host   → { type:'error', message }
 *
 * Attach handshake: POST /api/pty mints a one-time nonce; the WS upgrade must
 * present it (+ same-origin) — loopback binding alone is not enough, any local
 * page can reach the port. The session identity travels in `init`, not the
 * URL, so the same pane reattaches to its running PTY across reconnects.
 */

const require = createRequire(import.meta.url)
// @xterm/headless and @xterm/addon-serialize publish UMD-style CJS bundles
// without an `exports` field; only CJS require resolves their constructors
// reliably under NodeNext ESM. Typings stay via type-only imports.
const { Terminal: HeadlessTerminal } = require('@xterm/headless') as typeof import('@xterm/headless')
const { SerializeAddon } = require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize')

type ShellIncomingMessage = {
  type?: string
  data?: string
  cols?: number
  rows?: number
  paneId?: string
  projectId?: string
  sessionId?: string
  initialCommand?: string
  /** The agent CLI of a new session (a provider id); a known session keeps its own. */
  provider?: string
  isDarkMode?: boolean
  /** v0.17: the brain task a task run advances (recorded in the ledger). */
  taskId?: string
  /** The pane's brain space (brain-space.ts); absent = main. */
  spaceId?: string
  /** Settings › Preferences › Sessions: open a fresh session with a greeting. */
  greet?: boolean
}

type PendingResize = {
  cols: number
  rows: number
  timeoutId: NodeJS.Timeout
}

type PtySessionEntry = {
  pty: IPty
  ws: WebSocket | null
  sessionId: string
  paneId: string | null
  projectId: string
  projectPath: string
  /** The brain space the session runs in. */
  spaceId: string
  /** Reachable outside the cockpit (LaunchSpec.keepRunning): no detached timeout. */
  keepRunning: boolean
  /** A worker the host started without a pane (worker-start.ts): ends after a long idle time without a client. */
  hostStarted: boolean
  /** When a client last attached or left (ms); the idle time of a host-started worker counts from here too. */
  lastClientAt: number
  // Server-side xterm that parses every PTY byte and holds the rendered
  // terminal state (grid, cursor, scrollback, alt-buffer). On reconnect we
  // serialize this and replay it as a single frame instead of dispatching
  // the raw chunk stream — no ANSI artifacts, instant resume.
  headless: HeadlessTerminalType
  serializeAddon: SerializeAddonType
  // Flow-control state. When the WS send buffer crosses HIGH watermark we
  // pause the pty so the upstream process blocks on write() instead of
  // growing our server-side buffer unboundedly. Resume below LOW watermark.
  ptyPaused: boolean
  drainInterval: NodeJS.Timeout | null
  timeoutId: NodeJS.Timeout | null
  pendingResize: PendingResize | null
  // Output coalescing: pty.onData accumulates here, a timer flushes the lot
  // as one WS frame. headless.write still runs synchronously per chunk so the
  // snapshot stays current.
  pendingOutput: string
  flushTimer: NodeJS.Timeout | null
  // SIGWINCH safety-net (Hermes IDE pattern, PR #114). If the process hasn't
  // installed its SIGWINCH handler before an in-flight resize lands, the
  // signal is silently lost. On the first chunk it emits we re-send the
  // latest known dimensions so process + xterm agree.
  lastReportedSize: { cols: number; rows: number }
  hasResentInitialSize: boolean
  // Resume fallback (decision cockpit-session-resume-strategy): a known
  // session is spawned with --resume; if claude exits 1 right away ("No
  // conversation found" — the session never ran a turn, or its file is gone)
  // and the user hasn't typed yet, respawn the same entry with --session-id.
  spawnedWithResume: boolean
  spawnedAt: number
  inputSeen: boolean
  // Output of the first RESUME_FALLBACK_WINDOW_MS — tells a missing
  // conversation apart from any other early exit.
  earlyOutput: string
  // Reattach replay in flight: output is buffered, not sent, until the
  // snapshot is on the wire. The token tells a superseded replay to stand down.
  replayToken: object | null
  // Reattach wiggle: restores the real rows once the TUI answered the shrink.
  wiggleRestore: (() => void) | null
}

const PTY_SESSION_TIMEOUT = 30 * 60 * 1000

/**
 * Which quiet worker makes room for a new one: quiet for at least `minQuietMs`,
 * a done one before one waiting for a permission, then the one quiet the longest.
 */
export function pickQuietWorker(candidates: Array<{ key: string; quietMs: number; state: TurnState }>, minQuietMs: number): string | null {
  const eligible = candidates
    .filter((c) => c.state !== 'working' && c.quietMs >= minQuietMs)
    .sort((a, b) => Number(a.state === 'waiting') - Number(b.state === 'waiting') || b.quietMs - a.quietMs)
  return eligible[0]?.key ?? null
}

/** A session's turn state for the worker limits (turn-state.ts): the state and since when it holds (ms). */
export type WorkerTurnOf = (sessionId: string) => { state: TurnState; since: number | null }
// Terminal size of a kept session started without a client (host start);
// the first pane that attaches resizes it to its own.
const RESUME_COLS = 120
const RESUME_ROWS = 40

/** The ledger entries a host start brings back: kept running, and not a worker. */
export function keptSessions<E extends { keepRunning: boolean; worker: boolean }>(entries: E[]): E[] {
  return entries.filter((entry) => entry.keepRunning && !entry.worker)
}

/**
 * The live PTY of a conversation in a space, under whichever pane started it:
 * a session closed with × keeps running until its timeout, and reopening it
 * from the sidebar lands in a new pane. One conversation runs in one process.
 */
export function runningEntry<E extends { sessionId: string; spaceId: string }>(
  sessions: Map<string, E>, spaceId: string, sessionId: string,
): [string, E] | null {
  for (const [key, entry] of sessions) {
    if (entry.sessionId === sessionId && entry.spaceId === spaceId) return [key, entry]
  }
  return null
}
// Coalesce rapid resize messages (one per ResizeObserver tick during pane
// layout animations) into a single SIGWINCH. 120ms covers typical layout
// animations without adding perceivable lag on intentional drag-resize.
const RESIZE_COALESCE_MS = 120
// Delay between the two halves of the reattach SIGWINCH wiggle (rows−1, then
// back). Long enough for the TUI to receive the first signal and start its
// repaint, short enough to be imperceptible.
const RESIZE_WIGGLE_MS = 60
// Upper bound for holding the wiggle's shrunk geometry when the TUI doesn't
// answer the shrink with output (idle, or it ignored the SIGWINCH).
const RESIZE_WIGGLE_MAX_MS = 500
// Lower bound for holding it: output right after the shrink may still be a
// busy TUI's earlier frame (streaming), not its answer to the SIGWINCH.
const RESIZE_WIGGLE_MIN_MS = 200
// Server-side scrollback for the headless xterm. Matches the frontend xterm
// scrollback so reconnect replay covers everything the user can scroll to.
const HEADLESS_SCROLLBACK = 10000
// Backpressure watermarks for the WebSocket send buffer (hysteresis).
const WS_HIGH_WATERMARK = 1 * 1024 * 1024
const WS_LOW_WATERMARK = 256 * 1024
const DRAIN_POLL_MS = 50
// Binary frame protocol for the PTY-output hot path: single type byte at
// offset 0, raw UTF-8 after. Control messages stay JSON.
const OUTPUT_FRAME_TYPE = 0x01
// Trailing-edge coalesce window for pty.onData bursts. The FIRST chunk in an
// idle period is flushed synchronously (echo latency stays at network+parse),
// then a window of this length holds for follow-up chunks.
const OUTPUT_COALESCE_MS = 8
// Flush immediately when the buffered output exceeds this size.
const OUTPUT_FLUSH_THRESHOLD = 64 * 1024
// A --resume that fails exits within well under a second; anything past this
// window is a real session exit, not a missing-session probe.
const RESUME_FALLBACK_WINDOW_MS = 5000

// xterm answers the TUI's startup queries through onData, so they arrive as
// `input` although nobody typed: device attributes (CSI ? … c / CSI > … c),
// cursor/status reports (CSI … R / CSI … n), kitty keyboard flags (CSI ? … u),
// mode reports (CSI ? … $ y), focus in/out (CSI I / CSI O) and OSC colour
// replies. A chunk made only of these must not block the resume fallback.
const TERMINAL_REPLY = /^(?:\x1b\[[?>]?[\d;]*[cRn]|\x1b\[\?\d*u|\x1b\[\?[\d;]*\$y|\x1b\[[IO]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/

function isTerminalReply(input: string): boolean {
  return TERMINAL_REPLY.test(input)
}

// The agent's environment is built from an allowlist, not from the host's
// process.env: isolation is env + argv (decision cockpit-spawn-pty-and-
// isolation-scope), so nothing the host happened to inherit may reach the
// session — no ANTHROPIC_*/CLAUDE_* overrides, no TMUX markers, and
// specifically no CLAUDE_CODE_CHILD_SESSION (inherited from a Claude Code
// shell it silently turns transcript saving OFF, which made every resume
// find no conversation).
const AGENT_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TZ',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
] as const

// A host started without a login shell (launchd login service, a bare node)
// has no locale. The session then runs in the C locale, and macOS pbcopy —
// which Claude Code copies through — reads its UTF-8 input as Mac Roman:
// "ä" lands in the clipboard as "√§". Without any locale variable the session
// gets a UTF-8 LANG; one the user set always wins.

export function baseAgentEnv(source: NodeJS.ProcessEnv = process.env, os: Platform = platform): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of [...AGENT_ENV_ALLOWLIST, ...os.sessionEnvKeys]) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE && os.fallbackLang) env.LANG = os.fallbackLang
  return env
}

const SAFE_SESSION_ID = /^[a-zA-Z0-9_.\-:]+$/
const SAFE_PANE_ID = /^[a-zA-Z0-9_.\-:]+$/
const SAFE_PROJECT_ID = /^[a-zA-Z0-9_.\-:]+$/

export type SessionState = 'running' | 'detached' | 'ended'

function sendOutputBinary(ws: WebSocket, text: string): void {
  const payload = Buffer.from(text, 'utf8')
  const frame = Buffer.allocUnsafe(payload.length + 1)
  frame[0] = OUTPUT_FRAME_TYPE
  payload.copy(frame, 1)
  ws.send(frame, { binary: true })
}

function sendJson(ws: WebSocket | null, message: Record<string, unknown>): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  try { ws.send(JSON.stringify(message)) } catch { /* closing */ }
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function parseShellMessage(raw: RawData, isBinary: boolean): ShellIncomingMessage | null {
  if (isBinary) return null // client control frames are JSON text only
  try {
    const parsed: unknown = JSON.parse(raw.toString())
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as ShellIncomingMessage
  } catch {
    return null
  }
}

export interface SpawnContext {
  ledger: SessionLedger
  /** The agent CLIs sessions run with; each has written its isolated config (prepare) before the first spawn. */
  providers: ProviderRegistry
  /** The brain spaces; a session starts with the brain and files of its space (the `init` frame names it). */
  spaces: BrainSpaces
  /** Cockpit env for every session (COCKPIT_URL, spawn token, spawn CLI) — see index.ts. */
  sessionEnv: Record<string, string>
}

interface PendingNonce {
  createdAt: number
}

export class PtyBridge {
  private nonces = new Map<string, PendingNonce>()
  private sessions = new Map<string, PtySessionEntry>()
  readonly ledger: SessionLedger
  private log = (s: string) => process.stderr.write(`[pty] ${s}\n`)

  constructor(private ctx: SpawnContext) {
    this.ledger = ctx.ledger
    ensurePtyHelperExecutable()
  }

  // ── Attach handshake ─────────────────────────────────────────────────
  /** Mint a one-time nonce for the WS upgrade. */
  mintNonce(): { nonce: string } {
    const nonce = randomBytes(24).toString('hex')
    this.nonces.set(nonce, { createdAt: Date.now() })
    // Expire unclaimed nonces after 30s.
    setTimeout(() => this.nonces.delete(nonce), 30_000).unref?.()
    return { nonce }
  }

  /** Validate + consume the nonce (single-use). */
  consumeNonce(nonce: string): boolean {
    if (!nonce || !this.nonces.has(nonce)) return false
    this.nonces.delete(nonce)
    return true
  }

  /** Kill every live PTY (host shutdown). Sessions stay resumable via the ledger. */
  dispose(): void {
    for (const [key, session] of this.sessions) {
      this.teardown(key, session)
      try { session.pty.kill() } catch { /* already gone */ }
    }
    this.sessions.clear()
  }

  /** Live state of a session across all panes: running (client attached) / detached / ended. */
  sessionState(sessionId: string): SessionState {
    let state: SessionState = 'ended'
    for (const session of this.sessions.values()) {
      if (session.sessionId !== sessionId) continue
      if (session.ws && session.ws.readyState === WebSocket.OPEN) return 'running'
      state = 'detached'
    }
    return state
  }

  /** Kill every PTY of a session (sidebar delete). The ledger entry is the caller's business. */
  killSession(sessionId: string): number {
    let killed = 0
    for (const [key, session] of [...this.sessions]) {
      if (session.sessionId !== sessionId) continue
      try { session.ws?.close(1000, 'deleted') } catch { /* closing */ }
      this.teardown(key, session)
      try { session.pty.kill() } catch { /* already gone */ }
      this.sessions.delete(key)
      killed += 1
    }
    return killed
  }

  /** Kill every PTY running in a project of a space (project removal); `spaceKey` as the ledger keys it (null = main). */
  killProjectSessions(projectId: string, spaceKey: string | null): string[] {
    const ids = new Set<string>()
    for (const session of this.sessions.values()) {
      if (session.projectId === projectId && this.ctx.spaces.resolve(session.spaceId).ledgerKey === spaceKey) ids.add(session.sessionId)
    }
    for (const id of ids) this.killSession(id)
    return [...ids]
  }

  // ── Spawn ────────────────────────────────────────────────────────────
  /** Whether the session's provider has a stored conversation for it — only after the first turn. */
  private hasTranscript(sessionId: string): boolean {
    return this.ctx.providers.forSession(sessionId).canResume(this.ledger.ref(sessionId, null))
  }

  /**
   * A session that never ran a turn has nothing to resume (no transcript), so
   * once its last process is gone it is dropped from the ledger instead of
   * piling up in the sidebar's History (0.15.1). Kept when the user named or
   * pinned it. A pane still holding the id just starts it fresh on its next
   * attach (unknown id → `--session-id`).
   */
  private forgetIfEmpty(sessionId: string): boolean {
    const entry = this.ledger.get(sessionId)
    if (!entry || entry.title || entry.pinned) return false
    if (this.sessionState(sessionId) !== 'ended' || this.hasTranscript(sessionId)) return false
    this.ledger.remove(sessionId)
    this.log(`session ${sessionId} ended without a turn → forgotten`)
    return true
  }

  /** Host start: drop ledger entries of sessions that never ran a turn. */
  sweepEmptySessions(): number {
    return this.ledger.list().filter(({ sessionId }) => this.forgetIfEmpty(sessionId)).length
  }

  private spawnAgent(
    provider: AgentProvider,
    sessionId: string,
    resume: boolean,
    initialPrompt: string | null,
    greeting: string | null,
    cwd: string,
    cols: number,
    rows: number,
    isDarkMode: boolean,
    projectId: string,
    space: BrainSpace,
    reachable = false,
  ): { pty: IPty; keepRunning: boolean } {
    const pty = require('node-pty') as typeof import('node-pty')
    provider.trustProject(cwd)
    // Workers — opened by another session, nobody watching — run unattended.
    // An externally queued command maps to the agent's initial prompt (the
    // cockpit spawns agents, not shells). The greeting is a first prompt too,
    // but the user is watching: it leaves the session attended.
    const unattended = this.ledger.get(sessionId)?.worker === true || initialPrompt !== null
    const { providerSessionId } = this.ledger.ref(sessionId, null)
    // The session gets its own space's brain and nothing else (brain-space.ts).
    const launch = provider.launch({
      sessionId, address: sessionAddress(sessionId, projectId), providerSessionId, resume, initialPrompt: initialPrompt ?? greeting, unattended, reachable,
      space: { id: space.id, url: space.url, token: space.token, files: space.files },
    })
    // The brain scope the session works in — the UserPromptSubmit hook shows
    // note edits of this scope only (decision cockpit-notes-pane).
    const brainId = brainIdFromProjectId(projectId)
    const proc = pty.spawn(launch.bin, launch.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...baseAgentEnv(),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        FORCE_COLOR: '3',
        // COLORFGBG signals dark/light to CLIs that don't query OSC 11 —
        // claude-code's `auto` theme among them. "15;0" = white-on-black.
        COLORFGBG: isDarkMode ? '15;0' : '0;15',
        ...launch.env,
        ...this.ctx.sessionEnv,
        COCKPIT_SESSION_ID: sessionId,
        ...(brainId ? { EML_PROJECT_SCOPE: `project.${brainId}` } : {}),
      },
    })
    return { pty: proc, keepRunning: launch.keepRunning }
  }

  // ── Per-entry plumbing ───────────────────────────────────────────────
  private flushPendingOutput(key: string): void {
    const session = this.sessions.get(key)
    if (!session) return

    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }

    const buffered = session.pendingOutput
    session.pendingOutput = ''

    if (!buffered) return
    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
      // No live client — the headless mirror already has the bytes; dropping
      // here avoids a stale send on reconnect (snapshot replay is canonical).
      return
    }

    sendOutputBinary(session.ws, buffered)

    // Flow control: if the WS send buffer is filling faster than the client
    // can drain it, pause the pty. The OS pipe backs up, the upstream process
    // blocks on write(), and we avoid unbounded memory growth.
    if (!session.ptyPaused && session.ws.bufferedAmount > WS_HIGH_WATERMARK) {
      try { session.pty.pause() } catch { /* pty may have exited */ }
      session.ptyPaused = true
      if (session.drainInterval) clearInterval(session.drainInterval)
      session.drainInterval = setInterval(() => {
        const current = this.sessions.get(key)
        if (!current) return
        const wsRef = current.ws
        // No client or socket closing → release the pty so it can keep
        // producing output for headless replay later.
        if (!wsRef || wsRef.readyState !== WebSocket.OPEN || wsRef.bufferedAmount < WS_LOW_WATERMARK) {
          try { current.pty.resume() } catch { /* exited */ }
          current.ptyPaused = false
          if (current.drainInterval) {
            clearInterval(current.drainInterval)
            current.drainInterval = null
          }
        }
      }, DRAIN_POLL_MS)
    }
  }

  /** Wire pty.onData / onExit for the entry under `key`. */
  private wireProcess(key: string, proc: IPty): void {
    proc.onData((chunk) => {
      const session = this.sessions.get(key)
      if (!session || session.pty !== proc) return

      // SIGWINCH safety-net: first chunk means the process is alive with the
      // PTY open, so its handler is installed. Re-send the dimensions we were
      // told in case the spawn-time TIOCSWINSZ raced the handler install.
      if (!session.hasResentInitialSize) {
        session.hasResentInitialSize = true
        try {
          session.pty.resize(session.lastReportedSize.cols, session.lastReportedSize.rows)
          session.headless.resize(session.lastReportedSize.cols, session.lastReportedSize.rows)
        } catch { /* best-effort */ }
      }

      // Always feed the headless terminal — canonical server-side state, even
      // when no client is attached. Bounded by HEADLESS_SCROLLBACK.
      session.headless.write(chunk)
      if (Date.now() - session.spawnedAt < RESUME_FALLBACK_WINDOW_MS && session.earlyOutput.length < 16_384) {
        session.earlyOutput += chunk
      }

      // The TUI answered the wiggle's shrink — it has its own repaint under
      // way, so restoring now gives it a second, real size change.
      if (session.wiggleRestore) {
        const restore = session.wiggleRestore
        session.wiggleRestore = null
        setTimeout(restore, RESIZE_WIGGLE_MS)
      }

      if (!session.ws || session.ws.readyState !== WebSocket.OPEN) return

      session.pendingOutput += chunk
      // Mid-replay: hold everything; the replay flushes it after the snapshot.
      if (session.replayToken) return

      // Trailing-edge debounce: first chunk in an idle period ships
      // immediately; while a window is open, chunks accumulate and ride out
      // together at the tail. A burst over the threshold force-flushes.
      if (!session.flushTimer) {
        this.flushPendingOutput(key)
      } else if (session.pendingOutput.length >= OUTPUT_FLUSH_THRESHOLD) {
        this.flushPendingOutput(key)
      }

      if (!session.flushTimer && session.ws && session.ws.readyState === WebSocket.OPEN) {
        session.flushTimer = setTimeout(() => this.flushPendingOutput(key), OUTPUT_COALESCE_MS)
      }
    })

    proc.onExit(({ exitCode, signal }) => {
      const session = this.sessions.get(key)
      if (!session || session.pty !== proc) return
      // A sign-in happens inside a session: the provider's cached answer may be stale now.
      this.ctx.providers.forSession(session.sessionId).auth.invalidate()

      // Resume fallback: resuming a session the provider doesn't know exits 1
      // immediately (claude: "No conversation found"). Respawn as a new session under
      // the same id, same entry. Any other early exit (a broken binary, a bad
      // flag) is shown as it is — starting fresh would hide it and open an empty
      // session over a real one.
      const quickExit = Date.now() - session.spawnedAt < RESUME_FALLBACK_WINDOW_MS
      const noConversation = this.ctx.providers.forSession(session.sessionId).resumeNotFound(session.earlyOutput)
      if (session.spawnedWithResume && exitCode === 1 && quickExit && noConversation && !session.inputSeen) {
        this.log(`resume of ${session.sessionId} found no conversation → starting it fresh`)
        session.pendingOutput = ''
        if (session.flushTimer) { clearTimeout(session.flushTimer); session.flushTimer = null }
        session.headless.reset()
        sendJson(session.ws, { type: 'output', data: '\x1bc' })
        const space = this.ctx.spaces.resolve(session.spaceId)
        const provider = this.ctx.providers.forSession(session.sessionId)
        const { pty: fresh } = this.spawnAgent(
          provider,
          session.sessionId, false, null, null, session.projectPath,
          session.lastReportedSize.cols, session.lastReportedSize.rows, true, session.projectId, space, session.hostStarted,
        )
        session.pty = fresh
        session.spawnedWithResume = false
        session.spawnedAt = Date.now()
        session.earlyOutput = ''
        session.hasResentInitialSize = false
        this.ledger.recordSpawn(session.sessionId, session.paneId, session.projectId, provider.id, false, null, space.ledgerKey)
        this.wireProcess(key, fresh)
        return
      }

      // Flush any tail buffered for coalescing before the exit notice.
      if (session.flushTimer) { clearTimeout(session.flushTimer); session.flushTimer = null }
      if (session.pendingOutput && session.ws && session.ws.readyState === WebSocket.OPEN) {
        try { sendOutputBinary(session.ws, session.pendingOutput) } catch { /* mid-close */ }
        session.pendingOutput = ''
      }
      sendJson(session.ws, {
        type: 'output',
        data: `\r\n\x1b[33mProcess exited with code ${exitCode}${signal != null ? ` (${signal})` : ''}\x1b[0m\r\n`,
      })
      this.teardown(key, session)
      this.sessions.delete(key)
      // The process ended on its own (/exit, a crash): nothing to bring back
      // on the next host start. A host shutdown removes the entry first.
      this.ledger.setKeepRunning(session.sessionId, false)
      this.forgetIfEmpty(session.sessionId)
    })
  }

  private teardown(key: string, session: PtySessionEntry): void {
    if (session.timeoutId) clearTimeout(session.timeoutId)
    if (session.drainInterval) clearInterval(session.drainInterval)
    if (session.flushTimer) clearTimeout(session.flushTimer)
    if (session.pendingResize) clearTimeout(session.pendingResize.timeoutId)
    try {
      session.serializeAddon.dispose()
      session.headless.dispose()
    } catch { /* already disposed */ }
    void key
  }

  /** Spawn a session's process and register its entry; `ws` null starts it without a client (host start). */
  private startSession(opts: {
    key: string
    sessionId: string
    paneId: string | null
    projectId: string
    projectPath: string
    space: BrainSpace
    provider: AgentProvider
    resume: boolean
    initialPrompt: string | null
    greeting: string | null
    cols: number
    rows: number
    isDarkMode: boolean
    taskId: string | null
    hostStarted?: boolean
  }, ws: WebSocket | null): void {
    const { key, sessionId, paneId, projectId, projectPath, space, provider, resume, initialPrompt, greeting, cols, rows } = opts
    const { pty: proc, keepRunning } = this.spawnAgent(
      provider, sessionId, resume, initialPrompt, greeting, projectPath, cols, rows, opts.isDarkMode, projectId, space,
      opts.hostStarted === true,
    )

    const headless = new HeadlessTerminal({
      cols, rows, scrollback: HEADLESS_SCROLLBACK, allowProposedApi: true,
    })
    const serializeAddon = new SerializeAddon()
    // SerializeAddon is typed against the DOM xterm, but only touches
    // buffer state which @xterm/headless exposes identically.
    headless.loadAddon(serializeAddon as unknown as IHeadlessAddon)

    this.sessions.set(key, {
      pty: proc,
      ws,
      sessionId,
      paneId,
      projectId,
      projectPath,
      spaceId: space.id,
      keepRunning,
      hostStarted: opts.hostStarted === true,
      lastClientAt: Date.now(),
      headless,
      serializeAddon,
      ptyPaused: false,
      drainInterval: null,
      timeoutId: null,
      pendingResize: null,
      pendingOutput: '',
      flushTimer: null,
      lastReportedSize: { cols, rows },
      hasResentInitialSize: false,
      spawnedWithResume: resume,
      spawnedAt: Date.now(),
      inputSeen: false,
      earlyOutput: '',
      replayToken: null,
      wiggleRestore: null,
    })
    this.ledger.recordSpawn(sessionId, paneId, projectId, provider.id, initialPrompt !== null, opts.taskId, space.ledgerKey, greeting !== null)
    this.ledger.setKeepRunning(sessionId, keepRunning)
    this.wireProcess(key, proc)
    this.log(`${resume ? 'resuming' : 'starting'} session ${sessionId} in ${projectPath} (pane ${paneId ?? '-'})${keepRunning ? ', kept running' : ''}`)
  }

  /**
   * A detached session ends after PTY_SESSION_TIMEOUT unless a client comes
   * back (reattach clears the timer). It stays resumable via the ledger.
   */
  private scheduleDetachTimeout(key: string, session: PtySessionEntry): void {
    if (session.timeoutId) clearTimeout(session.timeoutId)
    session.timeoutId = setTimeout(() => {
      const current = this.sessions.get(key)
      if (!current || current.ws) return
      this.log(`detached session ${current.sessionId} timed out → killing pty (resumable via ledger)`)
      this.teardown(key, current)
      try { current.pty.kill() } catch { /* already gone */ }
      this.sessions.delete(key)
      this.forgetIfEmpty(current.sessionId)
    }, PTY_SESSION_TIMEOUT)
  }

  /**
   * The user closed the pane (×): the session is no longer kept running. Like
   * any detached session it then ends PTY_SESSION_TIMEOUT after its last
   * client left, and stays resumable. Whether the pane's socket closes before
   * or after this call, the timer starts once both have happened.
   */
  releasePane(sessionId: string, paneId: string | null): number {
    let released = 0
    for (const [key, session] of this.sessions) {
      if (session.sessionId !== sessionId || (paneId && session.paneId !== paneId)) continue
      session.keepRunning = false
      if (!session.ws) this.scheduleDetachTimeout(key, session)
      released += 1
    }
    this.ledger.setKeepRunning(sessionId, false)
    return released
  }

  /**
   * Host start: bring back the sessions that were kept running when the host
   * went down (an update, a reboot), so they are reachable from the Claude app
   * again without a browser. They start resumed and without a client; a pane
   * that opens later reattaches to them.
   */
  resumeKeptSessions(): number {
    let resumed = 0
    for (const entry of keptSessions(this.ledger.list())) {
      const space = entry.spaceId ? this.ctx.spaces.get(entry.spaceId) : this.ctx.spaces.main
      const project = entry.projectId ? space?.registry.get(entry.projectId) : undefined
      const provider = this.ctx.providers.forSession(entry.sessionId)
      if (!space || !project?.path || !entry.projectId || !this.hasTranscript(entry.sessionId) || provider.runtime.problem()) {
        this.log(`kept session ${entry.sessionId} can't be resumed (space, folder, transcript or agent CLI missing) → no longer kept`)
        this.ledger.setKeepRunning(entry.sessionId, false)
        continue
      }
      const key = `${space.id}_${entry.projectId}_${entry.sessionId}${entry.paneId ? `_pane_${entry.paneId}` : ''}`
      if (this.sessions.has(key)) continue
      this.startSession({
        key, sessionId: entry.sessionId, paneId: entry.paneId, projectId: entry.projectId, projectPath: project.path,
        space, provider, resume: true, initialPrompt: null, greeting: null,
        cols: RESUME_COLS, rows: RESUME_ROWS, isDarkMode: true, taskId: null,
      }, null)
      resumed += 1
    }
    return resumed
  }

  /**
   * Start a worker a session asked for that no cockpit tab took (worker-start.ts):
   * without a pane, under the request id as its session id (the address the
   * requester already has), with the prompt as its first message. A pane opened
   * later from the sidebar takes it over (runningEntry). Returns why it could
   * not start, or null.
   */
  startWorker(request: SpawnRequest): string | null {
    const space = this.ctx.spaces.resolve(request.spaceId ?? null)
    const project = this.projectFor(space, request.projectId)
    if (!project?.path) return `project ${request.projectId} has no folder`
    const provider = this.ctx.providers.get(request.provider ?? '') ?? this.ctx.providers.default()
    const problem = provider.runtime.problem()
    if (problem) return problem
    if (runningEntry(this.sessions, space.id, request.id)) return 'already running'
    this.startSession({
      key: `${space.id}_${project.projectId}_${request.id}`,
      sessionId: request.id, paneId: null, projectId: project.projectId, projectPath: project.path,
      space, provider, resume: false, initialPrompt: request.prompt, greeting: null,
      cols: RESUME_COLS, rows: RESUME_ROWS, isDarkMode: true, taskId: null, hostStarted: true,
    }, null)
    if (request.title) this.ledger.setAgentTitle(request.id, request.title)
    return null
  }

  /** Host-started workers no client is attached to — the ones the cap in worker-start.ts counts. */
  unattendedWorkers(): number {
    let count = 0
    for (const session of this.sessions.values()) if (session.hostStarted && !session.ws) count += 1
    return count
  }

  /**
   * End the host-started workers that no client is attached to, that are not
   * working, and that have been quiet (no turn, no client) for `idleMs`. They
   * stay in the sidebar, resumable. Returns how many ended.
   */
  sweepIdleWorkers(idleMs: number, turnOf: WorkerTurnOf, now = Date.now()): number {
    let ended = 0
    for (const [key, session, quietMs] of this.quietWorkers(turnOf, now)) {
      if (quietMs < idleMs) continue
      this.endWorker(key, session, 'idle without a client')
      ended += 1
    }
    return ended
  }

  /**
   * Make room for a new worker: end the host-started worker without a client
   * that has been quiet the longest, once it has been quiet for `minQuietMs`
   * (time for a reply to reach it). One whose turn is done goes before one
   * waiting for a permission; a working one never. False when none qualifies.
   */
  evictQuietWorker(minQuietMs: number, turnOf: WorkerTurnOf, now = Date.now()): boolean {
    const quiet = this.quietWorkers(turnOf, now)
    const pick = pickQuietWorker(quiet.map(([key, , quietMs, state]) => ({ key, quietMs, state })), minQuietMs)
    const entry = quiet.find(([key]) => key === pick)
    if (!entry) return false
    this.endWorker(entry[0], entry[1], 'quiet the longest, making room for a new worker')
    return true
  }

  /** Host-started workers without a client that are not working: key, entry, quiet time (ms), turn state. */
  private quietWorkers(turnOf: WorkerTurnOf, now: number): Array<[string, PtySessionEntry, number, TurnState]> {
    const quiet: Array<[string, PtySessionEntry, number, TurnState]> = []
    for (const [key, session] of this.sessions) {
      if (!session.hostStarted || session.ws) continue
      const turn = turnOf(session.sessionId)
      if (turn.state === 'working') continue
      const lastActive = Math.max(session.spawnedAt, session.lastClientAt, turn.since ?? 0)
      quiet.push([key, session, now - lastActive, turn.state])
    }
    return quiet
  }

  private endWorker(key: string, session: PtySessionEntry, why: string): void {
    this.log(`worker ${session.sessionId} ${why} → ending it (resumable)`)
    this.teardown(key, session)
    try { session.pty.kill() } catch { /* already gone */ }
    this.sessions.delete(key)
    this.ledger.setKeepRunning(session.sessionId, false)
  }

  /**
   * The registry entry of a project as a session runs in it. A brain project
   * the registry hasn't touched yet gets its local entry here (name from the
   * cached brain list, else the id — fixed up on the next touch). A project
   * without a folder gets a cockpit folder, so a session starts without a dialog.
   */
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
    // Trusted at spawn (spawnAgent), by the session's provider.
    if (!project.path) project = space.registry.ensureCockpitFolder(project.projectId)
    return project
  }

  // ── Connection handling ──────────────────────────────────────────────
  /** Attach a nonce-validated WS; the `init` frame binds it to a session. */
  attach(ws: WebSocket): void {
    let key: string | null = null

    ws.on('message', (raw: RawData, isBinary: boolean) => {
      const data = parseShellMessage(raw, isBinary)
      if (!data?.type) return

      try {
        if (data.type === 'init') {
          if (key) return // one init per socket
          const sessionId = readString(data.sessionId)
          const paneId = readString(data.paneId) || null
          const projectId = readString(data.projectId)
          // The pane's brain space; panes from before spaces name none → main.
          // A space the host does not know is refused — never another brain's token.
          const spaceId = readString(data.spaceId) || null
          const space = spaceId ? this.ctx.spaces.get(spaceId) : this.ctx.spaces.main
          if (!space) {
            sendJson(ws, { type: 'error', message: 'This desk belongs to a brain space this cockpit no longer has' })
            return
          }
          if (!SAFE_SESSION_ID.test(sessionId)) {
            sendJson(ws, { type: 'error', message: 'Invalid session ID' })
            return
          }
          if (paneId && !SAFE_PANE_ID.test(paneId)) {
            sendJson(ws, { type: 'error', message: 'Invalid pane ID' })
            return
          }
          if (!SAFE_PROJECT_ID.test(projectId)) {
            sendJson(ws, { type: 'error', message: 'Invalid project ID' })
            return
          }
          const project = this.projectFor(space, projectId)
          if (!project) {
            sendJson(ws, { type: 'error', message: 'Unknown project — add it in the sidebar first' })
            return
          }
          const projectPath = project.path
          if (!projectPath) {
            sendJson(ws, { type: 'error', message: 'This project has no folder and none could be created' })
            return
          }
          // The key names the pane that started the PTY. It's stable across
          // reloads (persisted in the pane store), so the same pane reattaches.
          // The space is part of the key: two spaces may both know project
          // `bp-eml`, and a session id is minted per pane anyway.
          key = `${space.id}_${projectId}_${sessionId}${paneId ? `_pane_${paneId}` : ''}`
          const cols = readNumber(data.cols, 80)
          const rows = readNumber(data.rows, 24)

          // A conversation already running under another pane (closed with ×,
          // reopened into a new one) is taken over, not started a second time:
          // two processes on one transcript would both write to it. The pane
          // that had it gets `superseded` and does not reconnect.
          const running = this.sessions.has(key) ? null : runningEntry(this.sessions, space.id, sessionId)
          if (running) {
            key = running[0]
            running[1].paneId = paneId
          }
          const existing = this.sessions.get(key)
          if (existing) {
            this.reattach(key, existing, ws, cols, rows)
            this.ledger.touch(sessionId, paneId)
            return
          }

          // The ledger alone isn't enough: a session that never ran a turn has
          // no transcript, and `--resume` on it exits 1 ("No conversation found").
          const resume = this.ledger.has(sessionId) && this.hasTranscript(sessionId)
          // A session keeps the provider it started with; a new one takes the
          // pane's choice, or the default.
          const provider = this.ledger.has(sessionId)
            ? this.ctx.providers.forSession(sessionId)
            : this.ctx.providers.get(readString(data.provider)) ?? this.ctx.providers.default()
          // Preflight: without a working agent CLI the spawn would exit at once
          // with a cryptic message — say what's wrong instead.
          const problem = provider.runtime.problem()
          if (problem) {
            sendJson(ws, {
              type: 'output',
              data: `\r\n\x1b[31m${problem}\x1b[0m\r\n${provider.runtime.problemHint}\r\n`,
            })
            this.log(`not starting session ${sessionId}: ${problem}`)
            return
          }
          // The first message belongs to a fresh session only. The pane keeps it
          // and resends it on every reconnect; on a resume (after a host restart)
          // it would land as a new user message in the running conversation.
          const initialPrompt = resume ? null : readString(data.initialCommand) || null
          const greeting = greetingFor({
            resume, initialPrompt, greet: data.greet === true, worker: this.ledger.get(sessionId)?.worker === true,
          })
          this.startSession({
            key, sessionId, paneId, projectId, projectPath, space, provider, resume, initialPrompt, greeting,
            cols, rows, isDarkMode: readBoolean(data.isDarkMode, true), taskId: readString(data.taskId) || null,
          }, ws)
          return
        }

        if (!key) return
        const session = this.sessions.get(key)
        if (!session) return

        if (data.type === 'input') {
          const input = readString(data.data)
          if (!isTerminalReply(input)) session.inputSeen = true
          session.pty.write(input)
          return
        }

        if (data.type === 'resize') {
          const cols = readNumber(data.cols, 80)
          const rows = readNumber(data.rows, 24)
          // Track the latest dimensions so the first-chunk safety-net uses
          // the up-to-date size, not the spawn-time size.
          session.lastReportedSize = { cols, rows }
          // Coalesce bursts of resize messages into a single SIGWINCH; the
          // TUI reflows each resize and tears output mid-render.
          if (session.pendingResize) clearTimeout(session.pendingResize.timeoutId)
          const timeoutId = setTimeout(() => {
            const current = this.sessions.get(key as string)
            if (!current || !current.pendingResize) return
            const { cols: finalCols, rows: finalRows } = current.pendingResize
            current.pendingResize = null
            try {
              current.pty.resize(finalCols, finalRows)
              // Keep the headless mirror in sync so the serialized snapshot
              // matches the actual client geometry on reconnect.
              current.headless.resize(finalCols, finalRows)
            } catch { /* exited between scheduling and firing */ }
          }, RESIZE_COALESCE_MS)
          session.pendingResize = { cols, rows, timeoutId }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.log(`error: ${message}`)
        sendJson(ws, { type: 'output', data: `\r\n\x1b[31mError: ${message}\x1b[0m\r\n` })
      }
    })

    ws.on('close', () => {
      if (!key) return
      const session = this.sessions.get(key)
      if (!session) return
      // If a newer ws has already taken ownership (supersede path), our close
      // is expected and must NOT tear down state.
      if (session.ws !== ws) return

      session.ws = null
      session.lastClientAt = Date.now()
      if (session.pendingResize) {
        clearTimeout(session.pendingResize.timeoutId)
        session.pendingResize = null
      }
      // If we were paused for backpressure when the client went away, let the
      // pty run again so the headless mirror keeps recording.
      if (session.drainInterval) {
        clearInterval(session.drainInterval)
        session.drainInterval = null
      }
      if (session.ptyPaused) {
        try { session.pty.resume() } catch { /* pty may have exited */ }
        session.ptyPaused = false
      }
      if (session.flushTimer) {
        clearTimeout(session.flushTimer)
        session.flushTimer = null
      }
      session.pendingOutput = ''
      // Reachable from the Claude app: runs on without a browser, until × or /exit.
      if (session.keepRunning) return
      this.scheduleDetachTimeout(key, session)
    })

    ws.on('error', (error) => {
      this.log(`ws error: ${error.message}`)
    })
  }

  /** A client reconnects to a running PTY: take ownership, replay the snapshot. */
  private reattach(key: string, session: PtySessionEntry, ws: WebSocket, cols: number, rows: number): void {
    if (session.timeoutId) {
      clearTimeout(session.timeoutId)
      session.timeoutId = null
    }

    // Supersede any prior websocket on this session before taking ownership:
    // a leftover WS would otherwise keep receiving pty output in parallel.
    // 1000 = normal close, with a reason so the old client's onclose can tell
    // this apart from a true disconnect (and not auto-reconnect into a flap).
    const oldWs = session.ws
    if (oldWs && oldWs !== ws && oldWs.readyState === WebSocket.OPEN) {
      try { oldWs.close(1000, 'superseded') } catch { /* already closing */ }
    }
    session.ws = ws
    session.lastClientAt = Date.now()

    // Clear backpressure state left by the previous owner — the fresh ws has
    // zero bufferedAmount and the drain poll would check the wrong target.
    if (session.drainInterval) {
      clearInterval(session.drainInterval)
      session.drainInterval = null
    }
    if (session.ptyPaused) {
      try { session.pty.resume() } catch { /* pty may have exited */ }
      session.ptyPaused = false
    }

    // Buffered output for the OLD ws is already in the headless mirror, so the
    // snapshot contains it. Dropping the buffer prevents a duplicate emission.
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    session.pendingOutput = ''
    session.wiggleRestore = null

    // Reattach with the NEW client's geometry. Serializing at the old width
    // and replaying into a different-width xterm would re-wrap every line.
    const geometryChanged =
      cols !== session.lastReportedSize.cols || rows !== session.lastReportedSize.rows
    if (session.pendingResize) {
      clearTimeout(session.pendingResize.timeoutId)
      session.pendingResize = null
    }
    session.lastReportedSize = { cols, rows }
    try {
      session.pty.resize(cols, rows)
    } catch { /* PTY may have exited; the snapshot replay below still works */ }

    // headless.write parses asynchronously (xterm slices it on timers), so a
    // snapshot taken right now would miss bytes still queued — and the TUI,
    // believing they're on screen, only sends diffs afterwards. An empty write
    // queues behind them; its callback runs once everything before it is
    // parsed. Output arriving meanwhile is held (replayToken) and flushed
    // right after the snapshot, so the client sees it in order.
    const token = {}
    session.replayToken = token
    session.headless.write('', () => {
      const current = this.sessions.get(key)
      if (!current || current.replayToken !== token) return
      current.replayToken = null
      try { current.headless.resize(cols, rows) } catch { /* exited */ }

      // Replay the rendered terminal state as a single frame. Prepend a hard
      // reset so the client xterm starts from a known baseline.
      const snapshot = current.serializeAddon.serialize()
      sendJson(ws, { type: 'output', data: `\x1bc${snapshot}` })
      this.flushPendingOutput(key)

      // SIGWINCH wiggle (tmux's client-attach trick): a full-screen TUI only
      // repaints diffs against the frame it believes is on screen. A geometry
      // change already forced a full repaint; otherwise shrink rows by one and
      // restore once the TUI answered the shrink (see onData) — a fixed short
      // delay let a busy TUI read the size only after the restore, see no
      // change, and skip the repaint.
      if (!geometryChanged) {
        let fallback: ReturnType<typeof setTimeout> | null = null
        const shrunkAt = Date.now()
        const restore = () => {
          if (fallback) { clearTimeout(fallback); fallback = null }
          const held = Date.now() - shrunkAt
          if (held < RESIZE_WIGGLE_MIN_MS) {
            fallback = setTimeout(restore, RESIZE_WIGGLE_MIN_MS - held)
            return
          }
          const live = this.sessions.get(key)
          if (!live || live !== current) return
          if (live.wiggleRestore === restore) live.wiggleRestore = null
          try {
            live.pty.resize(live.lastReportedSize.cols, live.lastReportedSize.rows)
          } catch { /* best-effort */ }
        }
        try { current.pty.resize(cols, Math.max(1, rows - 1)) } catch { /* best-effort */ }
        current.wiggleRestore = restore
        fallback = setTimeout(restore, RESIZE_WIGGLE_MAX_MS)
      }
    })
    this.log(`reattached session ${session.sessionId} (pane ${session.paneId ?? '-'})`)
  }
}
