import * as fs from 'node:fs'
import * as path from 'node:path'
import { COCKPIT_HOME } from './paths.js'
import { PROVIDER_IDS, type ProviderId, type SessionAgent, type SessionRef } from './domain/agent-provider.js'
import type { SessionRuntimeKind } from './domain/session-runtime.js'

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
