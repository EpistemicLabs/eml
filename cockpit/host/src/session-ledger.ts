import * as fs from 'node:fs'
import * as path from 'node:path'
import { COCKPIT_HOME } from './paths.js'
import { PROVIDER_IDS, type ProviderId, type SessionAgent, type SessionRef } from './domain/agent-provider.js'
import type { SessionRuntimeKind } from './domain/session-runtime.js'
import type { WorkerStatus } from './domain/session-attention.js'
import type { ToolProfile } from './domain/tool-profile.js'

/**
 * Host-owned session ledger (decision cockpit-session-resume-strategy).
 *
 * The host is the control-plane and knows which agent sessions it has
 * started — it does not probe a provider's undocumented transcript layout
 * to decide how to spawn. A pane pre-mints its session UUID; on spawn the
 * bridge asks the ledger whether that id was ever started here: unknown →
 * a new session, known → a resume (with the bridge's exit-1 fallback
 * covering the case of a session that never ran a turn).
 *
 * A session has two ids (ARCHITECTURE.md, "Session identity"): the cockpit's,
 * which keys this ledger, and the provider's own, learned from the session's
 * first hook. A provider that starts under the cockpit's id reports the same.
 *
 * The ledger also carries what the sidebar shows per session: the owning
 * project, a user-chosen title, the title the agent gave the session, the
 * pinned flag. Persisted as
 * ~/.eml-cockpit/sessions.json (ids + metadata only, no content), chmod
 * 600 like the rest of the cockpit home.
 */

const LEDGER_FILE = path.join(COCKPIT_HOME, 'sessions.json')

export interface LedgerEntry {
  /** The agent CLI this session runs with — fixed for its lifetime. */
  provider: ProviderId
  /** The provider's own id of the conversation; null until its first hook. */
  providerSessionId: string | null
  projectId: string | null
  createdAt: string
  lastAttached: string
  paneId: string | null
  spawnCount: number
  title: string | null
  /** The title the agent gave the session itself (session-title-cli.ts); a user-chosen title wins. */
  agentTitle: string | null
  /**
   * The session opened with the cockpit's greeting as its first prompt
   * (session-greeting.ts); null for an entry from before this was recorded.
   */
  greeted: boolean | null
  pinned: boolean
  /** Opened by another session (spawn-session) — always runs in auto mode. */
  worker: boolean
  /** v0.17: a task run — the brain task this session advances (skill task-run). */
  taskId: string | null
  /** The brain space the session runs in (brain-space.ts); null = the main space (pre-spaces entries). */
  spaceId: string | null
  /**
   * The session is reachable outside the cockpit (Remote Control): it keeps
   * running without a browser attached, and the host starts it again after
   * a restart, until the user closes it (pty-bridge.ts).
   */
  keepRunning: boolean
  /** How the session last ran: in a terminal, or through the chat view. The conversation is the same either way. */
  runtime: SessionRuntimeKind
  /** The permission mode and model chosen in the chat view; a resume starts with them. */
  chatMode: string | null
  chatModel: string | null
  /** An outside service may send it messages (cockpit message endpoint). */
  wakeable: boolean
  /** How it stands for someone, why, and since when; null when nobody has anything to do. */
  attention: { kind: WorkerStatus; reason: string | null; at: string } | null
  /** The last status it gave with a reason, kept after nobody has anything to do: what came of it (session-directory.ts). */
  lastStatus: { kind: WorkerStatus; reason: string; at: string } | null
  /** It is the main pane of a desk. Saved here, beside the pin, so every device lists it as a main session. */
  deskMain: boolean
  /** The session that started this one; null for one started by hand or from before this was recorded. */
  parentSessionId: string | null
  /** When someone last saw it, on any device. */
  readAt: string | null
  /** A turn ended and nobody has seen the result; null once someone has. */
  resultAt: string | null
  /** Out of the lists since then; the conversation stays and a new message brings it back. */
  archivedAt: string | null
  /** What the session may use, for its whole life; null: no limits. */
  toolProfile: ToolProfile | null
  /** A worker's turn is running: a host restart cuts it off (recover-workers.ts). `retried`: it already got its one retry. */
  turnInFlight: { retried: boolean } | null
  /** The job whose run started it (domain/job.ts): its channel tools act for that job on every resume. */
  jobId: string | null
}

interface LedgerFile {
  version: 1
  sessions: Record<string, LedgerEntry>
}

const isEntry = (v: unknown): v is LedgerEntry =>
  !!v && typeof v === 'object' &&
  typeof (v as LedgerEntry).createdAt === 'string' &&
  typeof (v as LedgerEntry).lastAttached === 'string'

function load(): LedgerFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')) as Partial<LedgerFile>
    const sessions: Record<string, LedgerEntry> = {}
    for (const [id, entry] of Object.entries(parsed.sessions ?? {})) {
      if (isEntry(entry)) {
        sessions[id] = {
          // Entries from before providers existed are Claude Code sessions.
          provider: PROVIDER_IDS.find((known) => known === entry.provider) ?? 'claude',
          providerSessionId: typeof entry.providerSessionId === 'string' && entry.providerSessionId ? entry.providerSessionId : null,
          projectId: typeof entry.projectId === 'string' ? entry.projectId : null,
          createdAt: entry.createdAt,
          lastAttached: entry.lastAttached,
          paneId: typeof entry.paneId === 'string' ? entry.paneId : null,
          spawnCount: typeof entry.spawnCount === 'number' ? entry.spawnCount : 1,
          title: typeof entry.title === 'string' && entry.title ? entry.title : null,
          agentTitle: typeof entry.agentTitle === 'string' && entry.agentTitle ? entry.agentTitle : null,
          greeted: typeof entry.greeted === 'boolean' ? entry.greeted : null,
          pinned: entry.pinned === true,
          worker: entry.worker === true,
          taskId: typeof entry.taskId === 'string' && entry.taskId ? entry.taskId : null,
          spaceId: typeof entry.spaceId === 'string' && entry.spaceId ? entry.spaceId : null,
          keepRunning: entry.keepRunning === true,
          runtime: entry.runtime === 'sdk' ? 'sdk' : 'terminal',
          chatMode: typeof entry.chatMode === 'string' && entry.chatMode ? entry.chatMode : null,
          chatModel: typeof entry.chatModel === 'string' && entry.chatModel ? entry.chatModel : null,
          wakeable: entry.wakeable === true,
          attention: entry.attention && typeof entry.attention.kind === 'string'
            ? { kind: entry.attention.kind, reason: typeof entry.attention.reason === 'string' ? entry.attention.reason : null, at: typeof entry.attention.at === 'string' ? entry.attention.at : entry.lastAttached }
            : null,
          lastStatus: entry.lastStatus && typeof entry.lastStatus.kind === 'string' && typeof entry.lastStatus.reason === 'string'
            ? { kind: entry.lastStatus.kind, reason: entry.lastStatus.reason, at: typeof entry.lastStatus.at === 'string' ? entry.lastStatus.at : entry.lastAttached }
            : null,
          deskMain: entry.deskMain === true,
          parentSessionId: typeof entry.parentSessionId === 'string' && entry.parentSessionId ? entry.parentSessionId : null,
          readAt: typeof entry.readAt === 'string' ? entry.readAt : null,
          resultAt: typeof entry.resultAt === 'string' ? entry.resultAt : null,
          archivedAt: typeof entry.archivedAt === 'string' ? entry.archivedAt : null,
          toolProfile: entry.toolProfile && Array.isArray(entry.toolProfile.deniedTools) ? entry.toolProfile : null,
          turnInFlight: entry.turnInFlight ? { retried: entry.turnInFlight.retried === true } : null,
          jobId: typeof entry.jobId === 'string' && entry.jobId ? entry.jobId : null,
        }
      }
    }
    return { version: 1, sessions }
  } catch {
    return { version: 1, sessions: {} }
  }
}

export class SessionLedger {
  private data: LedgerFile = load()
  /** Who asked for a worker that has no entry yet: its first spawn takes it. */
  private expectedParents = new Map<string, string>()

  has(sessionId: string): boolean {
    return sessionId in this.data.sessions
  }

  get(sessionId: string): LedgerEntry | undefined {
    return this.data.sessions[sessionId]
  }

  /** What a provider needs to find this session's conversation. */
  ref(sessionId: string, projectPath: string | null, agent?: SessionAgent | null): SessionRef {
    const entry = this.data.sessions[sessionId]
    return { sessionId, providerSessionId: entry?.providerSessionId ?? null, projectPath, greeted: entry?.greeted ?? null, ...(agent ? { agent } : {}) }
  }

  /**
   * Record a spawn (new or resumed) for `sessionId` bound to `paneId` in
   * `projectId` of `spaceId` (null = main). `provider` and `greeted` apply
   * to a session's first spawn only.
   */
  recordSpawn(
    sessionId: string,
    paneId: string | null,
    projectId: string | null,
    provider: ProviderId,
    worker = false,
    taskId: string | null = null,
    spaceId: string | null = null,
    greeted = false,
  ): void {
    const now = new Date().toISOString()
    const prev = this.data.sessions[sessionId]
    this.data.sessions[sessionId] = {
      provider: prev?.provider ?? provider,
      providerSessionId: prev?.providerSessionId ?? null,
      projectId: projectId ?? prev?.projectId ?? null,
      createdAt: prev?.createdAt ?? now,
      lastAttached: now,
      paneId,
      spawnCount: (prev?.spawnCount ?? 0) + 1,
      title: prev?.title ?? null,
      agentTitle: prev?.agentTitle ?? null,
      greeted: prev ? prev.greeted : greeted,
      pinned: prev?.pinned ?? false,
      worker: worker || prev?.worker === true,
      taskId: taskId ?? prev?.taskId ?? null,
      spaceId: spaceId ?? prev?.spaceId ?? null,
      keepRunning: prev?.keepRunning ?? false,
      runtime: prev?.runtime ?? 'terminal',
      chatMode: prev?.chatMode ?? null,
      chatModel: prev?.chatModel ?? null,
      wakeable: prev?.wakeable ?? false,
      attention: prev?.attention ?? null,
      lastStatus: prev?.lastStatus ?? null,
      deskMain: prev?.deskMain ?? false,
      parentSessionId: prev?.parentSessionId ?? this.expectedParents.get(sessionId) ?? null,
      readAt: prev?.readAt ?? null,
      resultAt: prev?.resultAt ?? null,
      archivedAt: prev?.archivedAt ?? null,
      toolProfile: prev?.toolProfile ?? null,
      jobId: prev?.jobId ?? null,
      turnInFlight: prev?.turnInFlight ?? null,
    }
    this.persist()
  }

  /** Mark a session as kept running (or not); see LedgerEntry.keepRunning. */
  setKeepRunning(sessionId: string, keepRunning: boolean): void {
    const entry = this.data.sessions[sessionId]
    if (!entry || entry.keepRunning === keepRunning) return
    entry.keepRunning = keepRunning
    this.persist()
  }

  /** Record how the session runs now (chat-bridge.ts, pty-bridge.ts). */
  setRuntime(sessionId: string, runtime: SessionRuntimeKind): void {
    const entry = this.data.sessions[sessionId]
    if (!entry || entry.runtime === runtime) return
    entry.runtime = runtime
    this.persist()
  }

  /** Record how the session stands for someone, or that nobody has anything to do. */
  setAttention(sessionId: string, attention: { kind: WorkerStatus; reason: string | null } | null): void {
    const entry = this.data.sessions[sessionId]
    if (!entry || (entry.attention === null && attention === null)) return
    entry.attention = attention && { ...attention, at: new Date().toISOString() }
    if (attention?.reason) entry.lastStatus = { kind: attention.kind, reason: attention.reason, at: entry.attention!.at }
    this.persist()
  }

  /** A worker was asked for by this session; recorded when it starts, however it starts. */
  expectParent(sessionId: string, parentSessionId: string): void {
    this.expectedParents.set(sessionId, parentSessionId)
  }

  markRead(sessionId: string): void {
    const entry = this.data.sessions[sessionId]
    if (!entry) return
    entry.readAt = new Date().toISOString()
    entry.resultAt = null
    this.persist()
  }

  /** A turn ended, or a new one started and whatever it left no longer waits. */
  setResult(sessionId: string, waiting: boolean): void {
    const entry = this.data.sessions[sessionId]
    if (!entry || (entry.resultAt === null && !waiting)) return
    entry.resultAt = waiting ? new Date().toISOString() : null
    this.persist()
  }

  /** Out of the lists: nothing is left to do for it and it no longer holds a pin. */
  archive(sessionId: string): void {
    const entry = this.data.sessions[sessionId]
    if (!entry) return
    entry.archivedAt = new Date().toISOString()
    entry.attention = null
    entry.resultAt = null
    entry.pinned = false
    entry.deskMain = false
    this.persist()
  }

  setDeskMain(sessionId: string, deskMain: boolean): void {
    const entry = this.data.sessions[sessionId]
    if (!entry || entry.deskMain === deskMain) return
    entry.deskMain = deskMain
    this.persist()
  }

  unarchive(sessionId: string): void {
    const entry = this.data.sessions[sessionId]
    if (!entry || entry.archivedAt === null) return
    entry.archivedAt = null
    this.persist()
  }

  /** Set when the session starts; it holds on every resume, in either view. */
  setToolProfile(sessionId: string, toolProfile: ToolProfile): void {
    const entry = this.data.sessions[sessionId]
    if (!entry) return
    entry.toolProfile = toolProfile
    this.persist()
  }

  /** Set when a job's run starts the session; it holds on every resume. */
  setJobId(sessionId: string, jobId: string): void {
    const entry = this.data.sessions[sessionId]
    if (!entry || entry.jobId === jobId) return
    entry.jobId = jobId
    this.persist()
  }

  /** A worker's turn started (keeps a retry already used) or ended. */
  setTurnInFlight(sessionId: string, inFlight: boolean): void {
    const entry = this.data.sessions[sessionId]
    if (!entry?.worker || (!!entry.turnInFlight === inFlight)) return
    entry.turnInFlight = inFlight ? { retried: false } : null
    this.persist()
  }

  markTurnRetried(sessionId: string): void {
    const entry = this.data.sessions[sessionId]
    if (!entry?.turnInFlight) return
    entry.turnInFlight.retried = true
    this.persist()
  }

  /** Let an outside service send this session messages. */
  setWakeable(sessionId: string): void {
    const entry = this.data.sessions[sessionId]
    if (!entry || entry.wakeable) return
    entry.wakeable = true
    this.persist()
  }

  /** Remember what the chat view runs with. */
  setChatSettings(sessionId: string, patch: { mode?: string; model?: string }): void {
    const entry = this.data.sessions[sessionId]
    if (!entry) return
    const chatMode = patch.mode ?? entry.chatMode
    const chatModel = patch.model ?? entry.chatModel
    if (entry.chatMode === chatMode && entry.chatModel === chatModel) return
    entry.chatMode = chatMode
    entry.chatModel = chatModel
    this.persist()
  }

  /** Remember the provider's own id for a session (from its hooks). Returns true when it changed. */
  bindProviderSession(sessionId: string, providerSessionId: string): boolean {
    const entry = this.data.sessions[sessionId]
    if (!entry || entry.providerSessionId === providerSessionId) return false
    entry.providerSessionId = providerSessionId
    this.persist()
    return true
  }

  /** Bump lastAttached on a client reattach (no new process). */
  touch(sessionId: string, paneId: string | null): void {
    const entry = this.data.sessions[sessionId]
    if (!entry) return
    entry.lastAttached = new Date().toISOString()
    if (paneId) entry.paneId = paneId
    this.persist()
  }

  update(sessionId: string, patch: { title?: string | null; pinned?: boolean }): LedgerEntry | undefined {
    const entry = this.data.sessions[sessionId]
    if (!entry) return undefined
    if (patch.title !== undefined) {
      const trimmed = (patch.title ?? '').trim()
      entry.title = trimmed || null
    }
    if (patch.pinned !== undefined) entry.pinned = patch.pinned
    this.persist()
    return entry
  }

  /** The agent names its session (session-title-cli.ts); an empty title clears it. */
  setAgentTitle(sessionId: string, title: string): LedgerEntry | undefined {
    const entry = this.data.sessions[sessionId]
    if (!entry) return undefined
    entry.agentTitle = title.trim() || null
    this.persist()
    return entry
  }

  remove(sessionId: string): boolean {
    if (!this.data.sessions[sessionId]) return false
    delete this.data.sessions[sessionId]
    this.persist()
    return true
  }

  /**
   * Sessions, optionally of one project and/or one space. `spaceId` null
   * means the main space, whose pre-spaces entries carry no space.
   */
  list(projectId?: string, spaceId?: string | null): Array<{ sessionId: string } & LedgerEntry> {
    return Object.entries(this.data.sessions)
      .filter(([, e]) => projectId === undefined || e.projectId === projectId)
      .filter(([, e]) => spaceId === undefined || (e.spaceId ?? null) === spaceId)
      .map(([sessionId, e]) => ({ sessionId, ...e }))
  }

  private persist(): void {
    try {
      fs.mkdirSync(COCKPIT_HOME, { recursive: true, mode: 0o700 })
      const tmp = `${LEDGER_FILE}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, LEDGER_FILE)
      fs.chmodSync(LEDGER_FILE, 0o600)
    } catch (err) {
      process.stderr.write(`[ledger] persist failed: ${(err as Error).message}\n`)
    }
  }
}
