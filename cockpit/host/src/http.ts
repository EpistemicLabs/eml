import { COCKPIT_HOME } from './paths.js'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { attachSpawnEvents, handleSpawnApi, type SpawnDeps } from './spawn-api.js'
import { handleJobsApi, type JobsApiDeps } from './jobs-api.js'
import { handleTasksApi, type TasksApiDeps } from './tasks-api.js'
import { handlePushApi, type PushApiDeps } from './push-api.js'
import { handleBridgeApi, type BridgeApiDeps } from './channel-bridge-api.js'
import { handleJobContract, type JobContractDeps } from './job-contract-api.js'
import type { StartWorker } from './application/start-worker.js'
import { renameRefusal, type SessionTask } from './application/session-task.js'
import { cycleOf, plannerPrompt, type Cycles } from './application/cycles.js'
import { leadDay, leadPrompt } from './domain/project-lead.js'
import { planArchive } from './application/archive-session.js'
import { attentionShown, needsAnswer, wasSpawned, worksAlone } from './domain/session-attention.js'
import { listAgentsContext, searchResult, searchSessions, type DirectoryEntry } from './domain/session-directory.js'
import { sessionName } from './domain/session-name.js'
import { sessionAddress } from './session-address.js'
import type { SpawnQueue } from './spawn-queue.js'
import { CONFIG_DIR, FRONTEND_DIST, HOST_ROOT, COCKPIT_FOLDERS_DIR } from './paths.js'
import type { PtyBridge } from './pty-bridge.js'
import type { ChatBridge } from './chat-bridge.js'
import { spaceView, openBrainSpace, type BrainSpace, type BrainSpaces, sessionSpaceOf } from './brain-space.js'
import { isSpaceColor } from './domain/space-color.js'
import { homeHuman, provisionSpace, type AgentNames, type Human } from './provision.js'
import { cancelInvite, confirmInvite, createInvite, createTeamSpace, joinTeamSpace, brainOfInviteLink, nameOfInviteLink, removeLocalSpace, removeTeamSpace, spacesBehindRelay, teamSnapshot } from './team-space.js'
import {
  ProjectPathError,
  isCockpitOwnFolder,
  browseFolders,
  createFolder,
  brainIdFromProjectId,
  projectIdForBrain,
  type ProjectEntry,
  type ProjectRegistry,
} from './project-registry.js'
import { brainProjectOf, moveProject, planProjectMove } from './project-move.js'
import { BrainRenameError, type BrainProject } from './brain-projects.js'
import { HOOK_SESSION_HEADER, HOOK_TOKEN_HEADER } from './domain/agent-provider.js'
import type { ProviderRegistry } from './infrastructure/providers/registry.js'
import { applySessionHook } from './application/apply-session-hook.js'
import { directoryQueryOf } from './application/session-tools.js'
import { isProviderId, writeDefaultProvider } from './provider-settings.js'
import { readLimits, writeLimits } from './session-limits.js'
// Settings › Models › Claude sign-in and About still speak Claude Code's own
// shapes (login modes, its version); everything else about an agent CLI goes
// through /api/providers.
import { claudeVersion } from './infrastructure/providers/claude/isolation.js'
import type { TurnEvent, TurnTracker } from './turn-state.js'
import { isLocalRequest, requestGate } from './remote-access.js'
import { claudeLoginStatus, clearClaudeLogin, invalidateAccountCache, writeAgentPatch, writeClaudeLogin } from './infrastructure/providers/claude/login.js'
import { createBackup, listBackups, readBrainInfo, revealBrainFile } from './brain-info.js'
import { PasteImageError, pastedImageFile, savePastedImage } from './paste-images.js'
import { createRecentFiles, handleFilesApi, type FilesDeps } from './files-api.js'
import { acknowledgeUpdateStatus, readUpdateStatus } from './update-status.js'
import { applyUpdate, changesBrainSchema, checkForUpdate, readAppUpdateStatus, releaseNotesBetween, rollbackUpdate, setUpdateChannel, writeGithubToken } from './app-update.js'
import { handleAccountApi } from './account.js'
import { handleNotesApi, type NotesChange } from './notes-api.js'
import { projectKey, type TimeTracker } from './time-tracking.js'
import { handlePluginsApi, mcpRelay, spacePlugins, type PluginsApiDeps, type TimeNames, type PortSession } from './plugins-api.js'
import { OutsideServers } from './infrastructure/plugins/outside-servers.js'
import { CLAUDE_BIN } from './infrastructure/providers/claude/runtime.js'
import { queueSignInSession } from './onboarding.js'
import { readCockpitConfig } from './config.js'
import type { BrainHygiene } from './brain-hygiene.js'
import { HOOKS_PATH, MCP_PATH, sessionModel } from './brain-mcp.js'
import { COCKPIT_MCP_PATH } from './cockpit-mcp.js'
import { RELAY_PATH } from './infrastructure/plugins/mcp-relay.js'
import type { AgentBrains } from './agents.js'
import { handleAgentsApi } from './agents-api.js'
import { isPageRoute, NOT_PASSED, SPACE_BRAIN_ROUTES } from './page-brain-routes.js'
import { sendJson } from './json-response.js'

/**
 * The host's public surface (loopback only): static Vite assets, the /api/brain
 * proxy (Bearer injected host-side — the browser never sees the token), the
 * project + session control-plane API the sidebar reads, the POST /api/pty nonce-mint, and the guarded /ws/shell
 * upgrade.
 */


// Settings › About: versions + the isolated config dir. Read once — none
// of it changes while the host runs, except the cockpit's Claude Code version
// (it updates itself; read per request). runMode is 'dev' when the host runs
// from source via `pnpm cockpit:dev` (EML_COCKPIT_DEV=1) — the header shows a
// DEV badge so a dev cockpit is never mistaken for the production one.
export const ABOUT = (() => {
  let version = '0.0.0'
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HOST_ROOT, 'package.json'), 'utf8')) as { version?: string }
    if (typeof pkg.version === 'string') version = pkg.version
  } catch { /* keep the fallback */ }
  const runMode: 'dev' | 'prod' = process.env.EML_COCKPIT_DEV === '1' ? 'dev' : 'prod'
  return { version, runMode, configDir: CONFIG_DIR, node: process.version }
})()

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.map': 'application/json',
}

export interface HostDeps {
  /**
   * The brain spaces (brain-space.ts). A request names its space in the
   * `x-cockpit-space` header; without one it means the main space.
   */
  spaces: BrainSpaces
  bridge: PtyBridge
  turns: TurnTracker
  /** The Time plugin's clocks (time-tracking.ts). */
  time?: TimeTracker
  /** Why sessions run without a memory ceiling here; null when they get one (session-memory.ts). */
  memoryUnavailable?: string | null
  /** The agent CLIs sessions run with. */
  providers: ProviderRegistry
  /** Per-boot secret the session hooks send (HOOK_TOKEN_HEADER) — POST /api/hook requires it. */
  hookToken: string
  /** The turn-state hook's config of this boot — a new space's session files name it. */
  turnHookConfig: string
  /** Worker-session requests from sessions (spawn-api.ts). */
  spawns: SpawnQueue
  workers: StartWorker
  /** Per-boot secret sessions send with POST /api/spawn. */
  spawnToken: string
  /** What an outside service sends with a message for a session (message-token.ts). */
  outsideToken: string
  deliver: SpawnDeps['deliver']
  /** The brain-hygiene offer of the open space (brain-hygiene.ts). */
  hygiene: BrainHygiene
  /** The home's agent brains (agents.ts); a new space binds the main space's. */
  agents: AgentBrains
  /** The brain MCP endpoint and the hook routes (brain-mcp.ts), and their URLs, which a new space's session files name. */
  brainMcp: { handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>; handleHooks(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> }
  mcpUrl: string
  hooksUrl: string
  /** The cockpit's own session tools for terminal sessions (cockpit-mcp.ts), at COCKPIT_MCP_PATH; absent: not served. */
  cockpitMcp?: { handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> }
  /** A session's process was stopped here, or the session archived or deleted: what the host kept for its running process goes (index.ts). */
  sessionGone?: (sessionId: string) => void
  /** The chat view's sessions (chat-bridge.ts), next to the terminal's `bridge`. */
  chat: ChatBridge
  /** Task system: a session's task at start, and its name (application/session-task.ts). */
  sessionTask?: SessionTask
  sessionNamed?: SpawnDeps['sessionNamed']
  createTask?: SpawnDeps['createTask']
  /** The user's time zone (jobs): a project lead's day. */
  timeZone?: () => string
  /** Weekly cycles (application/cycles.ts). */
  cycles?: Cycles
  /** Task system: a terminal session's turn ended with this reply — the router and the runner take it (application/task-router.ts). */
  turnEnded?: (sessionId: string, text: string) => void
  /** Task system: the user answered a session, or it was archived — its wait on the task is over. */
  answered?: (sessionId: string) => void
  /** Task system: the user typed a prompt into a session's terminal — a closed task it works on reopens first. */
  userWrote?: (sessionId: string) => void
  /** Jobs and their runs (jobs-api.ts); absent: no scheduler. */
  jobs?: JobsApiDeps
  /** The task board and its commands (tasks-api.ts); absent: no task system. */
  tasks?: TasksApiDeps
  /** Web push devices, the test and what the user is looking at (push-api.ts). */
  push?: PushApiDeps
  /** The channel bridge's /v1 routes (job-contract-api.ts). */
  jobContract?: JobContractDeps
  /** The channel bridge's draft routes for the page; absent, /api/bridge is not served. */
  channelBridge?: BridgeApiDeps
  /** The agent's reply texts in a session's transcript, for the files ⌘K finds (files-api.ts); absent, none are found. */
  replyTexts?: (sessionId: string) => Promise<string[] | null>
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req)
  if (!body.length) return {}
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** JSON answers of the host's own routes, gzipped for a client that takes it (json-response.ts). */
function json(res: http.ServerResponse, status: number, payload: unknown): void {
  sendJson(res, status, payload)
}

function fail(res: http.ServerResponse, err: unknown): void {
  if (err instanceof ProjectPathError) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'FOLDER_TAKEN' ? 409 : 400
    json(res, status, { error: { code: err.code, message: err.message } })
    return
  }
  json(res, 500, { error: { code: 'INTERNAL', message: (err as Error).message } })
}

/** Settings › Models: every provider with its runtime, sign-in and settings. */
async function providerViews(deps: HostDeps) {
  const preferred = deps.providers.default().id
  return Promise.all(deps.providers.all().map(async (provider) => ({
    id: provider.id,
    label: provider.label,
    version: provider.runtime.version(),
    problem: provider.runtime.problem(),
    problemHint: provider.runtime.problemHint,
    runtime: provider.runtime.state(),
    signedIn: await provider.auth.signedIn().catch(() => false),
    isDefault: provider.id === preferred,
    settings: provider.settings?.read() ?? null,
    capabilities: provider.capabilities,
  })))
}

/** A project folder is opened by sessions of any provider — none of them should ask about trust. */
function trustProject(deps: HostDeps, space: BrainSpace, projectPath: string): void {
  const sessionSpace = sessionSpaceOf(space)
  for (const provider of deps.providers.all()) {
    // A runtime's project stays out of the configs of the CLIs it does not run with.
    if (space.runtime && !space.runtime.configDirs[provider.id]) continue
    provider.trustProject(projectPath, sessionSpace)
  }
}

// ── Project + session views ───────────────────────
/** What the sidebar and the review pane do to a session. All are the page's own: the same-origin guard holds them. */
async function handleSessionActions(req: http.IncomingMessage, res: http.ServerResponse, deps: HostDeps, resource: string | undefined, id: string | undefined, action: string | undefined, method: string): Promise<boolean> {
  if (resource !== 'sessions' || method !== 'POST' || !id) return false
  const ledger = deps.bridge.ledger
  const stop = async (sessionId: string, reason: string) => {
    deps.bridge.killSession(sessionId)
    await deps.chat.end(sessionId, reason)
    // A terminal process takes no hook with it: its turn would count as cut off on the next start.
    ledger.setTurnInFlight(sessionId, false)
    deps.turns.forget(sessionId)
    deps.sessionGone?.(sessionId)
  }

  // Start a session by hand from the sidebar: on the host, so it needs no pane.
  if (id === 'start' && !action) {
    const body = await readJson(req)
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    const projectId = typeof body.projectId === 'string' ? body.projectId : ''
    if (!prompt || !projectId) { json(res, 400, { error: { code: 'INVALID', message: 'A project and a prompt are required' } }); return true }
    const sessionId = randomUUID()
    const problem = deps.chat.startWorker({
      id: sessionId, projectId, prompt, fromSessionId: null, createdAt: new Date().toISOString(),
      // It names itself; until then the list shows its first prompt.
      title: null,
      ...(typeof body.spaceId === 'string' && body.spaceId ? { spaceId: body.spaceId } : {}),
    })
    if (problem) json(res, 409, { error: { code: 'NOT_STARTED', message: problem } })
    else json(res, 200, { id: sessionId, runtime: 'sdk' })
    return true
  }

  const entry = ledger.get(id)
  if (!action || !['read', 'unread', 'clear', 'archive', 'stop', 'answer', 'desk-main'].includes(action)) return false
  if (!entry) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'Session not found' } }); return true }

  if (action === 'read') {
    ledger.markRead(id)
  } else if (action === 'unread') {
    // Undo of Mark all read: the read state the page saw before it marked the session read.
    const body = await readJson(req)
    const stamp = (value: unknown) => value === null || (typeof value === 'string' && !Number.isNaN(Date.parse(value)))
    if (!('readAt' in body) || !('resultAt' in body) || !stamp(body.readAt) || !stamp(body.resultAt)) {
      json(res, 400, { error: { code: 'INVALID', message: 'readAt and resultAt must each be an ISO timestamp or null' } })
      return true
    }
    if (!ledger.restoreRead(id, { readAt: body.readAt as string | null, resultAt: body.resultAt as string | null })) {
      json(res, 409, { error: { code: 'CHANGED', message: 'That session answered again since. It stays unread.' } })
      return true
    }
  } else if (action === 'desk-main') {
    const body = await readJson(req)
    ledger.setDeskMain(id, body.main === true)
  } else if (action === 'clear') {
    ledger.setAttention(id, null)
    ledger.setResult(id, false)
    if (deps.turns.get(id)?.state === 'waiting') deps.turns.apply({ sessionId: id, state: 'done' })
  } else if (action === 'stop') {
    await stop(id, 'stopped')
  } else if (action === 'archive') {
    const plan = planArchive(id, ledger.list().map((session) => {
      const shown = shownAttention(deps, session)
      return {
        sessionId: session.sessionId, parentSessionId: session.parentSessionId,
        working: deps.turns.get(session.sessionId)?.state === 'working',
        background: deps.chat.backgroundTasks(session.sessionId) > 0,
        // A mark its task no longer holds asks nothing; a session without one may still wait in its turn.
        needsAnswer: session.attention ? Boolean(shown && needsAnswer(shown.kind)) : deps.turns.get(session.sessionId)?.state === 'waiting',
      }
    }))
    if ('blockedBy' in plan) {
      const message = plan.reason === 'working' ? 'Still working. Stop it or wait until it finishes.'
        : plan.reason === 'background' ? 'A background task is still running. Stop it or wait until it finishes.'
        : 'A worker of this session still needs an answer.'
      json(res, 409, { error: { code: 'BUSY', message, sessionId: plan.blockedBy } })
      return true
    }
    for (const sessionId of plan.archive) {
      await stop(sessionId, 'archived')
      ledger.archive(sessionId)
      deps.answered?.(sessionId)
    }
    json(res, 200, { success: true, archived: plan.archive })
    return true
  } else {
    const body = await readJson(req)
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) { json(res, 400, { error: { code: 'INVALID_TEXT', message: 'text is required' } }); return true }
    const outcome = await deps.deliver({ target: id, text, from: null, caller: 'session' })
    json(res, outcome === 'delivered' || outcome === 'resumed' ? 200 : 409, { outcome })
    return true
  }
  json(res, 200, { success: true })
  return true
}

/**
 * A new lead or planner: started here in the chat runtime when the page asks for chat (the user's new
 * sessions open there), the pane then only joins; else the page starts it in a terminal with the prompt.
 */
function startLead(deps: HostDeps, space: BrainSpace, lead: { sessionId: string; projectId: string; title: string; prompt: string; chat: boolean }) {
  const answer = { sessionId: lead.sessionId, existing: false, title: lead.title, projectId: lead.projectId }
  if (lead.chat) {
    const problem = deps.chat.startWorker({
      id: lead.sessionId, projectId: lead.projectId, prompt: lead.prompt, title: lead.title, fromSessionId: null,
      createdAt: new Date().toISOString(), ...(space.main ? {} : { spaceId: space.id }),
    })
    if (!problem) {
      deps.bridge.ledger.claimLead(lead.sessionId)
      return { ...answer, runtime: 'sdk' }
    }
  }
  return { ...answer, runtime: 'terminal', prompt: lead.prompt }
}

type LedgerEntry = ReturnType<PtyBridge['ledger']['list']>[number]

/** Why the session waits, as every list shows it: its task decides once the board read it (domain/session-attention.ts attentionShown). */
function shownAttention(deps: HostDeps, entry: LedgerEntry): LedgerEntry['attention'] {
  const task = entry.taskId ? deps.tasks?.board.waitsSeen(entry.spaceId, entry.taskId) ?? null : null
  return attentionShown(entry.attention, { unrouted: Boolean(entry.unrouted), task, sessionId: entry.sessionId })
}

function sessionView(deps: HostDeps, project: ProjectEntry | undefined, entry: ReturnType<PtyBridge['ledger']['list']>[number]) {
  const summary = deps.providers.forSession(entry.sessionId).summary(deps.bridge.sessionRef(entry.sessionId, project?.path ?? null))
  // The last real message, not the last reattach: a reload or a click on a
  // pane bumps lastAttached and would show every open session as "<1m".
  const lastActivity = summary.lastMessageAt ?? summary.lastActivity ?? entry.createdAt
  return {
    id: entry.sessionId,
    projectId: entry.projectId,
    // `summary` is the display name (domain/session-name.ts): the task's name when the session has a named task,
    // else the title the user chose, the one the agent gave, Claude Code's own session title, the first prompt.
    summary: sessionName(entry, entry.taskId ? deps.tasks?.board.nameOf(entry.taskId) ?? null : null, summary.aiTitle ?? summary.summary ?? ''),
    title: entry.title,
    createdAt: entry.createdAt,
    lastActivity,
    messageCount: summary.messageCount,
    lastMessageAt: summary.lastMessageAt,
    lastReply: summary.lastReply,
    model: summary.model,
    contextTokens: summary.contextTokens,
    isPinned: entry.pinned,
    paneId: entry.paneId,
    taskId: entry.taskId,
    jobId: entry.jobId ?? null,
    state: deps.chat.isRunning(entry.sessionId) ? deps.chat.sessionState(entry.sessionId) : deps.bridge.sessionState(entry.sessionId),
    runtime: entry.runtime,
    attention: shownAttention(deps, entry),
    worker: entry.worker,
    // It works on its own (domain/session-attention.ts worksAlone). The Unread fold leaves out a worker that does: its answer goes to its task or its starter.
    alone: worksAlone({ delegated: entry.taskId ? deps.tasks?.board.delegated(entry.taskId) ?? null : null, worker: entry.worker, spawned: wasSpawned(entry) }),
    deskMain: entry.deskMain,
    parentSessionId: entry.parentSessionId,
    readAt: entry.readAt,
    snoozedUntil: entry.snoozedUntil ?? null,
    resultAt: entry.resultAt,
    archivedAt: entry.archivedAt,
    workdir: entry.workdir,
    backgroundTasks: deps.chat.backgroundTasks(entry.sessionId),
    turnState: deps.turns.get(entry.sessionId)?.state ?? 'idle',
    turnSince: deps.turns.get(entry.sessionId)?.since ?? null,
    __provider: deps.providers.forSession(entry.sessionId).id,
    __projectId: entry.projectId ?? undefined,
  }
}

/**
 * The sessions a session can message (domain/session-directory.ts): the ones
 * SendMessage reaches, so those of its own agent, without itself. Also what
 * the send_message and list_sessions tools go by (cockpit-mcp.ts).
 */
export function directoryEntries(deps: HostDeps, callerId: string): DirectoryEntry[] {
  const ledger = deps.bridge.ledger
  const agentOf = (spaceId: string | null) => deps.spaces.resolve(spaceId).agent
  const caller = ledger.get(callerId)
  if (!caller) return []
  const addressOf = (sessionId: string) => {
    const entry = ledger.get(sessionId)
    return entry ? sessionAddress(sessionId, entry.projectId) : null
  }
  return ledger.list()
    .filter((entry) => entry.sessionId !== callerId && agentOf(entry.spaceId) === agentOf(caller.spaceId))
    // A session of a provider without messaging has no address to send to.
    .filter((entry) => deps.providers.forSession(entry.sessionId).capabilities.messaging.supported)
    .map((entry) => {
      const project = entry.projectId ? deps.spaces.resolve(entry.spaceId).registry.get(entry.projectId) : undefined
      const view = sessionView(deps, project, entry)
      const asked = deps.providers.forSession(entry.sessionId).summary(deps.bridge.sessionRef(entry.sessionId, project?.path ?? null)).summary
      return {
        address: sessionAddress(entry.sessionId, entry.projectId),
        name: view.summary,
        outcome: entry.lastStatus?.reason ?? null,
        asked,
        project: project ? project.customName ?? project.displayName : null,
        state: entry.archivedAt ? 'archived' : view.state === 'ended' ? 'stopped' : 'running',
        lastActive: view.lastActivity,
        parent: entry.parentSessionId ? addressOf(entry.parentSessionId) : null,
        main: entry.pinned || entry.deskMain,
      }
    })
}

/** GET /api/session-directory: search (`q`, `state`, `project`, `archived`, `limit`), or `list=recent` for what ListAgents adds. */
function directoryAnswer(deps: HostDeps, callerId: string, url: URL): string {
  const entries = directoryEntries(deps, callerId)
  if (url.searchParams.get('list') === 'recent') return listAgentsContext(entries)
  // Read as the list_sessions tool's input is: one place for the bounds (application/session-tools.ts).
  const query = directoryQueryOf({
    words: url.searchParams.get('q') ?? '',
    state: url.searchParams.get('state'),
    project: url.searchParams.get('project'),
    archived: url.searchParams.get('archived') === '1',
    limit: url.searchParams.get('limit') ?? undefined,
  })
  return searchResult(searchSessions(entries, query), query)
}

/** What the cockpit's own plugins read from the host (plugins-api.ts). */
/** The claude.ai connectors and Claude Code plugin servers of the cockpit's Claude config (names only). */
const outsideServers = new OutsideServers({ bin: CLAUDE_BIN, configDir: CONFIG_DIR })

function pluginsDeps(deps: HostDeps, space: BrainSpace): PluginsApiDeps {
  return {
    projectFolder: (projectId) => space.registry.get(projectId)?.path ?? null,
    sessionProcesses: () => {
      const owners = new Map<number, PortSession>()
      for (const [pid, sessionId] of [...deps.bridge.processes(), ...deps.chat.processes()]) {
        const entry = deps.bridge.ledger.get(sessionId)
        const project = entry?.projectId ? deps.spaces.resolve(entry.spaceId).registry.get(entry.projectId) : undefined
        // The name the sidebar shows (sessionView's summary).
        const name = entry ? sessionView(deps, project, { ...entry, sessionId }).summary || null : null
        owners.set(pid, { id: sessionId, name, projectId: entry?.projectId ?? null })
      }
      return owners
    },
    ownPorts: () => new Map(deps.spaces.list().flatMap((s) => {
      const port = Number(new URL(s.url).port)
      return port ? [[port, 'EML brain server'] as const] : []
    })),
    endShell: (id) => deps.bridge.endShell(id),
    endShells: () => deps.bridge.endShells(),
    spaceIds: () => deps.spaces.list().map((s) => s.id),
    outside: outsideServers,
    time: deps.time,
    sessionName: (sessionId) => {
      const entry = deps.bridge.ledger.get(sessionId)
      if (!entry) return null
      const project = entry.projectId ? deps.spaces.resolve(entry.spaceId).registry.get(entry.projectId) : undefined
      return sessionView(deps, project, { ...entry, sessionId }).summary || null
    },
    timeNames: (refs) => timeNames(deps, refs),
  }
}

/** Where a project's folder comes from: linked by the user, made by the cockpit, or none yet. */
function folderKind(project: ProjectEntry): 'user' | 'cockpit' | 'none' {
  if (!project.path) return 'none'
  const rel = path.relative(COCKPIT_FOLDERS_DIR, project.path)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? 'cockpit' : 'user'
}

function projectView(deps: HostDeps, space: BrainSpace, project: ProjectEntry, brain: BrainProject | null = null) {
  const sessions = deps.bridge.ledger.list(project.projectId, space.ledgerKey)
    .filter((entry) => !entry.archivedAt)
    .map((entry) => sessionView(deps, project, entry))
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
  return {
    projectId: project.projectId,
    kind: project.kind,
    brainProjectId: project.brainProjectId,
    brainStatus: brain?.status ?? null,
    goal: brain?.goal ?? null,
    // The registry's displayName is a copy that only refreshes on session
    // start (ensureBrain) — the live brain name wins unless the user renamed.
    displayName: project.customName ?? brain?.name ?? project.displayName,
    customName: project.customName,
    fullPath: project.path,
    path: project.path,
    folderKind: folderKind(project),
    // A folder-only project of the user's: it is linked to a brain project or removed (decision cockpit-brain-project-model).
    linkable: project.kind === 'folder' && !isCockpitOwnFolder(project),
    isStarred: project.starred,
    hidden: project.hidden,
    createdAt: project.createdAt,
    sessions,
    sessionMeta: { total: sessions.length, hasMore: false },
  }
}

/**
 * The Time view's names (plugins-api.ts), each in its own space: a project as
 * the sidebar names it (renamed, else the brain's name, else the registry's),
 * a task by its brain title. One brain read per space; what can't be read stays null.
 */
async function timeNames(
  deps: HostDeps,
  refs: { projects: Array<{ spaceId: string | null; projectId: string | null }>; tasks: Array<{ spaceId: string | null; taskId: string }> },
): Promise<TimeNames> {
  const names: TimeNames = { spaces: {}, projects: {}, tasks: {} }
  const spaceIds = new Set([...refs.projects, ...refs.tasks].map((ref) => ref.spaceId ?? ''))
  await Promise.all([...spaceIds].map(async (spaceId) => {
    const space = deps.spaces.resolve(spaceId || null)
    names.spaces[spaceId] = space.name
    const inSpace = <T extends { spaceId: string | null }>(list: T[]) => list.filter((ref) => (ref.spaceId ?? '') === spaceId)
    const projects = inSpace(refs.projects).filter((ref) => ref.projectId)
    const brain: BrainProject[] = projects.length > 0 ? await space.projects.list().catch(() => []) : []
    for (const ref of projects) {
      const entry = space.registry.get(ref.projectId!)
      const live = brain.find((bp) => projectIdForBrain(bp.id) === ref.projectId)
      names.projects[projectKey(ref)] = entry?.customName ?? live?.name ?? entry?.displayName ?? null
    }
    await Promise.all(inSpace(refs.tasks).map(async ({ taskId }) => {
      try {
        const res = await fetch(`${space.url}/engram/${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${space.token}`, Accept: 'application/json' } })
        names.tasks[taskId] = res.ok ? ((await res.json()) as { title?: string }).title ?? null : null
      } catch {
        names.tasks[taskId] = null
      }
    }))
  }))
  return names
}

/** A brain project the registry hasn't touched yet: listed, not persisted. */
function virtualBrainEntry(brain: BrainProject): ProjectEntry {
  return {
    projectId: projectIdForBrain(brain.id),
    kind: 'brain',
    brainProjectId: brain.id,
    path: null,
    displayName: brain.name,
    customName: null,
    starred: false,
    hidden: false,
    createdAt: '',
  }
}

/**
 * The merged project list (decision cockpit-brain-project-model): every brain
 * project (with its local state, if any) + folder-only projects. When the
 * brain can't be read, the registry alone is served so the sidebar degrades
 * instead of emptying.
 */
async function listProjects(deps: HostDeps, space: BrainSpace) {
  let brain: BrainProject[] = []
  try { brain = await space.projects.list() } catch (err) {
    process.stderr.write(`[projects] brain list unavailable: ${(err as Error).message}\n`)
  }
  const byBrainId = new Map(brain.map((p) => [p.id, p]))
  const views = []
  const seen = new Set<string>()
  for (const bp of brain) {
    const entry = space.registry.get(projectIdForBrain(bp.id)) ?? virtualBrainEntry(bp)
    seen.add(entry.projectId)
    views.push(projectView(deps, space, entry, bp))
  }
  for (const entry of space.registry.list()) {
    if (seen.has(entry.projectId)) continue
    // Brain entries whose project is gone from the brain stay listed only if
    // they hold a folder (sessions may live there); folder projects always.
    if (entry.kind === 'brain' && !entry.path) continue
    views.push(projectView(deps, space, entry, entry.brainProjectId ? byBrainId.get(entry.brainProjectId) ?? null : null))
  }
  return views
}

/** Resolve a project id for PATCH: brain projects get their local entry on first touch. */
async function resolveEntry(space: BrainSpace, projectId: string): Promise<{ entry: ProjectEntry | undefined; brain: BrainProject | null }> {
  const existing = space.registry.get(projectId)
  const brainId = brainIdFromProjectId(projectId)
  if (!brainId) return { entry: existing, brain: null }
  let brain: BrainProject | null = null
  try { brain = (await space.projects.list()).find((p) => p.id === brainId) ?? null } catch { /* registry only */ }
  if (existing) return { entry: existing, brain }
  if (!brain) return { entry: undefined, brain: null }
  return { entry: space.registry.ensureBrain(brain.id, brain.name), brain }
}

const SPACE_NAME_MAX = 40

type SpaceError = { error: { code: string; message: string } }

/** A space name as the UI may set it: present, short, unique among the spaces (except `self`). */
function validSpaceName(deps: HostDeps, name: string, self?: BrainSpace): { name: string } | SpaceError {
  const trimmed = name.trim()
  if (!trimmed) return { error: { code: 'NAME_REQUIRED', message: 'A space needs a name.' } }
  if (trimmed.length > SPACE_NAME_MAX) return { error: { code: 'NAME_TOO_LONG', message: `At most ${SPACE_NAME_MAX} characters.` } }
  if (deps.spaces.list().some((s) => s !== self && s.name.toLowerCase() === trimmed.toLowerCase())) {
    return { error: { code: 'NAME_TAKEN', message: 'A space with this name exists.' } }
  }
  return { name: trimmed }
}

/** `name`, cut to the limit, with a number when a space has it already: the name an invite link brought. */
function freeSpaceName(deps: HostDeps, name: string): string {
  const taken = (candidate: string) => deps.spaces.list().some((s) => s.name.toLowerCase() === candidate.toLowerCase())
  const base = name.trim().slice(0, SPACE_NAME_MAX - 3)
  if (!taken(base)) return base
  let n = 2
  while (taken(`${base} ${n}`)) n += 1
  return `${base} ${n}`
}

/**
 * The binding every new space gets: the main space's agent and the home's
 * handle (the agent picker per space comes with Settings › Agents), with
 * the display names as the agent brain knows them.
 */
async function newSpaceBinding(deps: HostDeps): Promise<{ agent: AgentNames; human: Human } | SpaceError> {
  const agent = deps.agents.get(deps.spaces.main.agent)
  const human = homeHuman(await readCockpitConfig())
  if (!agent || !human) return { error: { code: 'NO_AGENT', message: 'The main space has no agent bound; a new space needs one.' } }
  const info = readBrainInfo(agent.token)
  return {
    agent: { id: agent.id, name: info.agents.find((a) => a.id === agent.id)?.name ?? agent.id },
    human,
  }
}

/** A space made just now joins the registry with its session files. */
function openNewSpace(deps: HostDeps, opts: { id: string; name: string; agent: string; token: string; shared: boolean }): BrainSpace {
  const space = openBrainSpace({
    id: opts.id, name: opts.name, agent: opts.agent, main: false, shared: opts.shared, url: deps.spaces.main.url, token: opts.token, ownRuntime: deps.agents.expectsRuntime(opts.agent),
    turnHookConfig: deps.turnHookConfig, mcpUrl: deps.mcpUrl, hooksUrl: deps.hooksUrl,
  })
  deps.spaces.add(space)
  // It starts with the main space's panes; servers only once switched on for it.
  void spacePlugins.adoptSpace(space.id, deps.spaces.main.id).catch(() => undefined)
  return space
}

/**
 * Settings › Spaces › New space: a further local brain, bound to the main
 * space's agent. The space gets no identity of its own — that is the agent
 * brain's — only the agent and user objects, so engrams in their scopes can
 * be written there.
 */
async function createSpace(deps: HostDeps, name: string): Promise<{ space: BrainSpace } | SpaceError> {
  const valid = validSpaceName(deps, name)
  if ('error' in valid) return valid
  const binding = await newSpaceBinding(deps)
  if ('error' in binding) return binding
  const { brainId, token } = await provisionSpace(valid.name, binding.agent, binding.human)
  return { space: openNewSpace(deps, { id: brainId, name: valid.name, agent: binding.agent.id, token, shared: false }) }
}

/** What POST /api/spaces answers for a shared space: the space it made (201), the space it re-joined (200), or what refused it, passed through. */
type SharedSpaceResult = { status: number; body: Record<string, unknown> }

/**
 * v0.21: POST /api/spaces {name, shared: {handle?}} — a new shared brain —
 * and {name?, join: {link, handle?}} — joining one with an invite link, under
 * the name the link brings unless one is given
 * (team-space.ts). Bound like a local space: the main space's agent, the
 * member handle defaulting to the home's handle. A join whose link names a
 * brain this cockpit has already (a new link after a stopped join) goes to
 * that space; the space's name stays.
 */
async function createSharedSpace(deps: HostDeps, body: Record<string, unknown>): Promise<SharedSpaceResult> {
  const variant = body.shared ?? body.join
  const given = variant && typeof variant === 'object' ? (variant as Record<string, unknown>) : {}
  const link = typeof given.link === 'string' ? given.link : ''
  const existing = body.join ? deps.spaces.list().find((s) => s.id === brainOfInviteLink(link)) : undefined
  const asked = typeof body.name === 'string' ? body.name : ''
  const name = body.join && !asked.trim() ? freeSpaceName(deps, nameOfInviteLink(link) ?? 'Shared space') : asked
  const valid = existing ? { name: existing.name } : validSpaceName(deps, name)
  if ('error' in valid) return { status: 400, body: valid }
  const binding = await newSpaceBinding(deps)
  if ('error' in binding) return { status: 400, body: binding }
  const handle = typeof given.handle === 'string' && given.handle.trim() ? given.handle.trim() : binding.human.handle
  const ctx = { url: deps.spaces.main.url, agent: binding.agent, handle }
  const result = body.join ? await joinTeamSpace(ctx, valid.name, link, existing) : await createTeamSpace(ctx, valid.name)
  if ('refused' in result) return result.refused
  const space = existing ?? openNewSpace(deps, { id: result.brainId, name: valid.name, agent: binding.agent.id, token: result.token, shared: true })
  return { status: existing ? 200 : 201, body: { space: spaceView(space), team: result.answer.body } }
}

// The media viewer's files (files-api.ts): one per host, so the recent-files cache lives as long as it.
const filesApis = new WeakMap<HostDeps, { deps: FilesDeps; recent: ReturnType<typeof createRecentFiles> }>()
function filesApiOf(deps: HostDeps): { deps: FilesDeps; recent: ReturnType<typeof createRecentFiles> } {
  const known = filesApis.get(deps)
  if (known) return known
  const files: FilesDeps = {
    cwdOf: (sessionId) => {
      const entry = deps.bridge.ledger.get(sessionId)
      if (!entry) return null
      const project = entry.projectId ? deps.spaces.resolve(entry.spaceId).registry.get(entry.projectId) : undefined
      return entry.workdir ?? project?.path ?? null
    },
    recentSessions: () => deps.bridge.ledger.list()
      .map((entry) => {
        const owner = deps.spaces.resolve(entry.spaceId)
        const view = sessionView(deps, entry.projectId ? owner.registry.get(entry.projectId) : undefined, entry)
        return { sessionId: entry.sessionId, title: view.summary || 'Session', projectId: entry.projectId, spaceId: owner.id, lastActivity: view.lastActivity }
      })
      .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)),
    replyTexts: (sessionId) => deps.replyTexts?.(sessionId) ?? Promise.resolve(null),
  }
  const api = { deps: files, recent: createRecentFiles(files) }
  filesApis.set(deps, api)
  return api
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, deps: HostDeps): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const method = req.method ?? 'GET'
  const parts = url.pathname.split('/').filter(Boolean) // ['api', ...]
  if (parts[0] !== 'api') return false
  const [, resource, id] = parts
  if (await handleSpawnApi(req, res, { workers: deps.workers, outsideToken: deps.outsideToken, deliver: deps.deliver, spawns: deps.spawns, spawnToken: deps.spawnToken, spaces: deps.spaces, ledger: deps.bridge.ledger, providers: deps.providers, sessionNamed: deps.sessionNamed, createTask: deps.createTask }, url.pathname, method, json, readJson)) return true
  // The home's agents and the agent upgrade's leftovers (agents-api.ts).
  if (await handleAgentsApi(req, res, { agents: deps.agents, spaces: deps.spaces }, url.pathname, method, json, readJson)) return true
  if (deps.jobs && await handleJobsApi(req, res, deps.jobs, url.pathname, method, json, readJson)) return true
  if (deps.tasks && await handleTasksApi(req, res, deps.tasks, url.pathname, method, json, readJson)) return true
  if (deps.push && await handlePushApi(req, res, deps.push, url, method, json, readJson)) return true
  if (url.pathname === '/api/file' || url.pathname.startsWith('/api/files/')) {
    const files = filesApiOf(deps)
    if (await handleFilesApi(req, res, files.deps, files.recent, url, method, json, readJson)) return true
  }

  // v0.19: the model a cockpit session runs on, for the EML MCP server's
  // provenance stamp (it calls this per write, /model can switch mid-session).
  // Same token as spawning: only sessions of this cockpit carry it.
  if (resource === 'session-model' && id && method === 'GET') {
    if (req.headers['x-cockpit-token'] !== deps.spawnToken) {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'Only a cockpit session can ask for its model' } })
      return true
    }
    const entry = deps.bridge.ledger.get(id)
    if (!entry) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'Session not found' } }); return true }
    const model = sessionModel({ spaces: deps.spaces, ledger: deps.bridge.ledger, providers: deps.providers }, id)
    json(res, 200, { model, provider: entry.provider })
    return true
  }

  // The EML account (Settings › Account): sign-in by email code, the account
  // and its team brains, sign-out. The session stays in the host (account.ts).
  if (resource === 'account' && await handleAccountApi(req, res, url, method, json, readJson)) return true

  // Spaces: the list in the user's order, the order itself (dragged in the
  // header), and a new local one (Settings › Spaces).
  if (resource === 'spaces' && !id && method === 'GET') {
    json(res, 200, { spaces: deps.spaces.ordered().map(spaceView) })
    return true
  }
  if (resource === 'spaces' && id === 'order' && parts.length === 3 && method === 'PUT') {
    const { ids } = await readJson(req)
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) {
      json(res, 400, { error: { code: 'BAD_ORDER', message: 'ids must be a list of space ids' } })
      return true
    }
    try {
      await deps.spaces.setOrder(ids)
      json(res, 200, { spaces: deps.spaces.ordered().map(spaceView) })
    } catch (err) {
      json(res, 500, { error: { code: 'SPACE_ORDER_FAILED', message: (err as Error).message } })
    }
    return true
  }
  if (resource === 'spaces' && !id && method === 'POST') {
    const body = await readJson(req)
    try {
      if (body.shared || body.join) {
        const answer = await createSharedSpace(deps, body)
        json(res, answer.status, answer.body)
        return true
      }
      const result = await createSpace(deps, typeof body.name === 'string' ? body.name : '')
      if ('error' in result) json(res, 400, { error: result.error })
      else json(res, 201, { space: spaceView(result.space) })
    } catch (err) {
      json(res, 500, { error: { code: 'SPACE_CREATE_FAILED', message: (err as Error).message } })
    }
    return true
  }

  // v0.21: a shared space's team — the brain server's view (team-space.ts),
  // the invites an owner makes and confirms, and the removal of a space: a
  // shared one that never came to life, a local one with its name typed. The
  // server's answers pass through.
  if (resource === 'spaces' && id && (method === 'DELETE' || parts[3] === 'team' || parts[3] === 'invites')) {
    const target = deps.spaces.get(id)
    if (!target) { json(res, 404, { error: { code: 'NO_SUCH_SPACE', message: 'No such brain space' } }); return true }
    const [, , , sub, inviteId, action] = parts
    let answer: { status: number; body: unknown } | null = null
    try {
      if (method === 'DELETE' && parts.length === 3) {
        if (target.main) { json(res, 409, { error: { code: 'MAIN_SPACE', message: 'The main space cannot be deleted.' } }); return true }
        if (target.shared === null) { json(res, 409, { error: { code: 'SPACE_UNKNOWN', message: 'The brain server did not say what this space is. Try again.' } }); return true }
        if (target.shared) answer = await removeTeamSpace(target, (space) => deps.spaces.remove(space))
        else {
          if (deps.spaces.isAgentMain(target)) { json(res, 409, { error: { code: 'AGENT_MAIN', message: "This is its agent's main space and cannot be deleted." } }); return true }
          if ((await readJson(req)).confirm !== target.name) { json(res, 400, { error: { code: 'CONFIRM_NAME', message: 'Type the name of the space to delete it.' } }); return true }
          const sessions = deps.bridge.ledger.list(undefined, target.ledgerKey)
          if (sessions.some((s) => deps.bridge.isRunning(s.sessionId) || deps.chat.isRunning(s.sessionId))) {
            json(res, 409, { error: { code: 'SESSIONS_RUNNING', message: 'Sessions are running in this space. Stop them first.' } })
            return true
          }
          answer = await removeLocalSpace(target, createBackup, (space) => deps.spaces.remove(space))
          if (answer.status === 200) for (const s of sessions) deps.bridge.ledger.remove(s.sessionId)
        }
      } else if (sub === 'team' && parts.length === 4 && method === 'GET') {
        answer = await teamSnapshot(target)
      } else if (sub === 'invites' && parts.length === 4 && method === 'POST') {
        answer = await createInvite(target, (await readJson(req)).role, target.name)
      } else if (sub === 'invites' && parts.length === 6 && inviteId && method === 'POST' && (action === 'accept' || action === 'cancel')) {
        answer = action === 'accept' ? await confirmInvite(target, inviteId) : await cancelInvite(target, inviteId)
      }
    } catch (err) {
      json(res, 500, { error: { code: 'TEAM_FAILED', message: (err as Error).message } })
      return true
    }
    if (!answer) return false
    if (answer.status === 204) { res.writeHead(204); res.end(); return true }
    json(res, answer.status, answer.body)
    return true
  }

  if (resource === 'spaces' && id && method === 'PATCH') {
    const target = deps.spaces.get(id)
    if (!target) { json(res, 404, { error: { code: 'NO_SUCH_SPACE', message: 'No such brain space' } }); return true }
    const body = await readJson(req)
    if (body.color !== undefined) {
      if (!isSpaceColor(body.color)) { json(res, 400, { error: { code: 'NO_SUCH_COLOR', message: 'No such space colour' } }); return true }
      try {
        await deps.spaces.setColor(target, body.color)
        json(res, 200, { space: spaceView(target) })
      } catch (err) {
        json(res, 500, { error: { code: 'SPACE_COLOR_FAILED', message: (err as Error).message } })
      }
      return true
    }
    const valid = validSpaceName(deps, typeof body.name === 'string' ? body.name : '', target)
    if ('error' in valid) { json(res, 400, valid); return true }
    try {
      await deps.spaces.rename(target, valid.name)
      json(res, 200, { space: spaceView(target) })
    } catch (err) {
      json(res, 500, { error: { code: 'SPACE_RENAME_FAILED', message: (err as Error).message } })
    }
    return true
  }

  // The sessions of every space (the sidebar's All view), each resolved in its own space.
  if (resource === 'sessions' && id === 'all' && method === 'GET') {
    const sessions = deps.bridge.ledger.list()
      .map((entry) => {
        const owner = deps.spaces.resolve(entry.spaceId)
        return { ...sessionView(deps, entry.projectId ? owner.registry.get(entry.projectId) : undefined, entry), spaceId: owner.id }
      })
      .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
    // Workers waiting for free memory have no entry yet: their parents count them.
    const queued = deps.spawns.list().flatMap((request) => (request.fromSessionId && !request.open ? [{ id: request.id, parentSessionId: request.fromSessionId }] : []))
    json(res, 200, { sessions, queued })
    return true
  }

  // What a session reads to find another one by what its user calls it: its CLI and ListAgents hook.
  if (resource === 'session-directory' && !id && method === 'GET') {
    const caller = req.headers['x-cockpit-session']
    if (req.headers['x-cockpit-token'] !== deps.spawnToken || typeof caller !== 'string') {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'Only a cockpit session can list the sessions' } })
      return true
    }
    json(res, 200, { text: directoryAnswer(deps, caller, url) })
    return true
  }

  // Inbox snooze: the session leaves the Inbox until then ({ until: ISO } or null). Page Origin only.
  if (resource === 'sessions' && id && parts[3] === 'snooze' && method === 'POST') {
    const body = await readJson(req)
    const until = typeof body.until === 'string' && !Number.isNaN(Date.parse(body.until)) ? body.until : null
    if (!deps.bridge.ledger.get(id)) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'No such session' } }); return true }
    deps.bridge.ledger.setSnooze(id, until)
    json(res, 200, { snoozedUntil: until })
    return true
  }

  // Cycles (application/cycles.ts): this week's and next week's cycle; the planner session for them.
  if (resource === 'cycles' && deps.cycles) {
    if (!id && method === 'GET') {
      json(res, 200, { current: deps.cycles.current(), next: deps.cycles.next() })
      return true
    }
    if (id === 'planner' && method === 'POST') {
      // The planner works across projects, in the main space, from a folder of its own (made once, hidden).
      const space = deps.spaces.resolve(null)
      const dir = path.join(COCKPIT_HOME, 'planning')
      fs.mkdirSync(dir, { recursive: true })
      const made = space.registry.create(dir, 'Cycle planning')
      if (made.created) space.registry.update(made.project.projectId, { hidden: true })
      const projectId = made.project.projectId
      const ledger = deps.bridge.ledger
      const current = deps.cycles.current()
      const key = `cycle:${current.id}`
      const existing = ledger.leadFor(key, current.id, space.ledgerKey)
      if (existing) { json(res, 200, { sessionId: existing, existing: true, title: `Planner · ${current.id}`, projectId, runtime: ledger.get(existing)?.runtime ?? 'terminal' }); return true }
      const sessionId = randomUUID()
      ledger.expectLead(sessionId, { projectId: key, day: current.id })
      const body = await readJson(req)
      const prompt = plannerPrompt(current, deps.cycles.next(), cycleOf(new Date(), deps.timeZone?.() ?? 'UTC', -1))
      json(res, 200, startLead(deps, space, { sessionId, projectId, title: `Planner · ${current.id}`, prompt, chat: body.chat === true }))
      return true
    }
  }

  // The project lead of today (domain/project-lead.ts): the one of today if there is one, else the id and
  // first message of a new one, which the page opens on the project's desk. Page Origin only.
  if (resource === 'projects' && id === 'lead' && method === 'POST') {
    const space = deps.spaces.fromHeader(req.headers['x-cockpit-space'])
    const body = await readJson(req)
    const projectId = typeof body.projectId === 'string' ? body.projectId : ''
    const project = space?.registry.get(projectId)
    if (!space || !project) { json(res, 404, { error: { code: 'NO_SUCH_PROJECT', message: 'This project has no folder in the cockpit, so a lead cannot run in it' } }); return true }
    const ledger = deps.bridge.ledger
    const day = leadDay(new Date(), deps.timeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
    const name = project.customName ?? project.displayName
    const existing = ledger.leadFor(projectId, day, space.ledgerKey)
    if (existing) { json(res, 200, { sessionId: existing, existing: true, title: `Lead · ${name}`, day, runtime: ledger.get(existing)?.runtime ?? 'terminal' }); return true }
    const sessionId = randomUUID()
    ledger.expectLead(sessionId, { projectId, day })
    json(res, 200, startLead(deps, space, { sessionId, projectId, title: `Lead · ${name}`, prompt: leadPrompt({ name, brainId: brainIdFromProjectId(projectId) }, day), chat: body.chat === true }))
    return true
  }

  // A task run without a desk (task-run.tsx, "No desk"): the page asks, the host starts it unattended
  // like a runner step; it shows next to its task and in Your turn when it asks. Page Origin only.
  if (resource === 'tasks' && id === 'run' && method === 'POST') {
    const space = deps.spaces.fromHeader(req.headers['x-cockpit-space'])
    const body = await readJson(req)
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
    const projectId = str(body.projectId), prompt = str(body.prompt), taskId = str(body.taskId)
    if (!space || !projectId || !prompt || !taskId) { json(res, 400, { error: { code: 'INVALID_RUN', message: 'projectId, prompt and taskId are required' } }); return true }
    if (!space.registry.get(projectId)) { json(res, 404, { error: { code: 'NO_SUCH_PROJECT', message: `No project ${projectId} in this space` } }); return true }
    const request = deps.spawns.add({
      projectId, prompt, title: str(body.title), fromSessionId: null, origin: 'runner', taskId,
      ...(space.main ? {} : { spaceId: space.id }),
    })
    json(res, 202, { id: request.id })
    return true
  }

  // A session's task at start, from its task hook (task-hook.ts).
  if (resource === 'session-task' && !id && method === 'POST') {
    const caller = req.headers['x-cockpit-session']
    if (req.headers['x-cockpit-token'] !== deps.spawnToken || typeof caller !== 'string') {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'Only a cockpit session can ask for its task' } })
      return true
    }
    try {
      json(res, 200, { text: deps.sessionTask ? await deps.sessionTask.context(caller) : '' })
    } catch (err) {
      json(res, 502, { error: { code: 'TASK_FAILED', message: (err as Error).message } })
    }
    return true
  }

  if (await handleSessionActions(req, res, deps, resource, id, parts[3], method)) return true

  // Every other route works in one space.
  const space = deps.spaces.fromHeader(req.headers['x-cockpit-space'])
  if (!space) { json(res, 404, { error: { code: 'NO_SUCH_SPACE', message: 'No such brain space' } }); return true }

  try {
    // The cockpit's own plugins: their switches, Worktrees' reads, and Notes refused while off (plugins-api.ts).
    if (await handlePluginsApi(req, res, pluginsDeps(deps, space), url, method, json, readJson)) return true
    if (await handleNotesApi(req, res, { loopbackUrl: space.url, brainToken: space.token }, url, method, json, readJson, space.notes)) return true

    // The first-run setup server answers { needed: true } (setup.ts). Here:
    // signIn = right after the setup, before Claude is signed in — the page
    // then shows its sign-in card (onboarding.ts).
    if (resource === 'setup' && !id && method === 'GET') {
      const pending = (await readCockpitConfig())?.onboarding === 'pending'
      json(res, 200, { needed: false, signIn: pending && !(await deps.providers.get('claude')?.auth.signedIn().catch(() => false)) })
      return true
    }

    // Brain hygiene of this space: GET = the banner's offer (null = none),
    // POST start = findings.json + a session. The banner stays until started.
    if (resource === 'brain-hygiene') {
      if (!id && method === 'GET') {
        json(res, 200, { offer: await deps.hygiene.view(space) })
        return true
      }
      if (id === 'start' && method === 'POST') {
        json(res, 200, await deps.hygiene.start(space))
        return true
      }
    }

    if (resource === 'about' && !id && method === 'GET') {
      json(res, 200, { ...ABOUT, claudeVersion: claudeVersion() })
      return true
    }

    // Settings › Spaces: the local brain (file, id, schema, identity) and its
    // backups. Paths are display-only; the token never leaves the host.
    if (resource === 'brain-info' && !id && method === 'GET') {
      json(res, 200, readBrainInfo(space.token))
      return true
    }
    if (resource === 'brain-info' && id === 'reveal' && method === 'POST') {
      const file = readBrainInfo(space.token).brainFile
      if (!file) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'No local brain file' } }); return true }
      await revealBrainFile(file)
      json(res, 200, { success: true })
      return true
    }
    if (resource === 'brain-backups' && !id && method === 'GET') {
      // This space's backups only: manual and pre-migration copies both start with the brain id.
      json(res, 200, { backups: listBackups(space.id) })
      return true
    }
    if (resource === 'brain-backups' && !id && method === 'POST') {
      json(res, 200, { backup: await createBackup(space.token) })
      return true
    }

    // Terminal image paste: store the clipboard image, hand back its path.
    if (resource === 'paste-image' && !id && method === 'POST') {
      try {
        json(res, 200, { path: await savePastedImage(req) })
      } catch (error) {
        if (!(error instanceof PasteImageError)) throw error
        json(res, error.status, { error: { code: 'BAD_IMAGE', message: error.message } })
      }
      return true
    }

    // A pasted image as the chat view shows it.
    if (resource === 'paste-image' && id && method === 'GET') {
      const image = pastedImageFile(id)
      if (!image) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'Image not found' } }); return true }
      res.writeHead(200, { 'Content-Type': image.mediaType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' })
      fs.createReadStream(image.file).pipe(res)
      return true
    }

    // Settings › Preferences › Sessions: memory ceiling, idle stop, running cap (session-limits.ts).
    if (resource === 'limits' && !id && method === 'GET') {
      json(res, 200, { limits: readLimits(), ceilingUnavailable: deps.memoryUnavailable ?? null })
      return true
    }
    if (resource === 'limits' && !id && method === 'PATCH') {
      const body = (await readJson(req)) as unknown
      const result = body && typeof body === 'object' && !Array.isArray(body) ? writeLimits(body as Record<string, unknown>) : 'expected an object'
      if (typeof result === 'string') json(res, 400, { error: { code: 'INVALID_INPUT', message: result } })
      else json(res, 200, { limits: result, ceilingUnavailable: deps.memoryUnavailable ?? null })
      return true
    }

    // Update banner (v0.14 Cluster 0): per brain the newest migration report,
    // and the in-app update this host runs. The page shows the active space's
    // brain; dismissing and revealing act on the requesting space's brain.
    // Dismissing a failure is refused until the brain has caught up.
    if (resource === 'update-status' && !id && method === 'GET') {
      json(res, 200, readUpdateStatus((brainId) => deps.spaces.get(brainId)?.name))
      return true
    }
    if (resource === 'update-status' && id === 'ack' && method === 'POST') {
      const result = acknowledgeUpdateStatus(space.id)
      if (result.ok) json(res, 200, { success: true })
      else json(res, 409, { error: { code: 'NOT_RESOLVED', message: result.reason } })
      return true
    }
    if (resource === 'update-status' && id === 'reveal-backup' && method === 'POST') {
      const backup = readUpdateStatus().brains[space.id]?.report.backupPath
      if (!backup || !fs.existsSync(backup)) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'No backup for this report' } }); return true }
      await revealBrainFile(backup)
      json(res, 200, { success: true })
      return true
    }

    // App updates (Settings › About › Updates, the update banner): status, a
    // check against GitHub Releases, install + restart, go back, the update
    // channel (stable | alpha, checked again right away), and the GitHub
    // token — write-only from the browser (GET reports only its source). The
    // banner after an update reads the "What's new" of the releases it brought.
    if (resource === 'app-update') {
      if (!id && method === 'GET') { json(res, 200, readAppUpdateStatus()); return true }
      if (id === 'notes' && method === 'GET') {
        try {
          json(res, 200, await releaseNotesBetween(url.searchParams.get('from') ?? '', url.searchParams.get('to') ?? ''))
        } catch (err) {
          json(res, 502, { error: { code: 'NOTES_UNAVAILABLE', message: (err as Error).message } })
        }
        return true
      }
      if (id === 'check' && method === 'POST') { json(res, 200, await checkForUpdate()); return true }
      if ((id === 'apply' || id === 'rollback') && method === 'POST') {
        try {
          const body = id === 'apply' ? ((await readJson(req)) as { version?: unknown }) : {}
          // a shared brain takes every entry of the older schema before the update migrates it
          if (id === 'apply' && changesBrainSchema(body?.version)) {
            const behind = await spacesBehindRelay(deps.spaces.list())
            if (behind.length > 0) throw new Error(`This update changes the brain format, and ${behind.length === 1 ? `the shared space "${behind[0]}" is` : `the shared spaces ${behind.map(n => `"${n}"`).join(', ')} are`} not in sync with the relay yet. Update once ${behind.length === 1 ? 'it is' : 'they are'} connected and caught up.`)
          }
          json(res, 200, id === 'apply' ? await applyUpdate(body?.version) : await rollbackUpdate())
        } catch (err) {
          json(res, 409, { error: { code: 'UPDATE_FAILED', message: (err as Error).message } })
        }
        return true
      }
      if (id === 'channel' && method === 'PUT') {
        const body = (await readJson(req)) as { channel?: unknown }
        const error = setUpdateChannel(body?.channel)
        if (error) { json(res, 400, { error: { code: 'INVALID_INPUT', message: error } }); return true }
        json(res, 200, await checkForUpdate())
        return true
      }
      if (id === 'token' && (method === 'PUT' || method === 'DELETE')) {
        const body = method === 'PUT' ? ((await readJson(req)) as { token?: unknown }) : { token: null }
        const error = writeGithubToken(body?.token ?? null)
        if (error) { json(res, 400, { error: { code: 'INVALID_INPUT', message: error } }); return true }
        json(res, 200, method === 'PUT' ? await checkForUpdate() : readAppUpdateStatus())
        return true
      }
    }

    // Claude sign-in (Settings › Models): mode (Claude Code login | setup-token),
    // the account Claude Code reports, the optional token. The token is
    // write-only from the browser: GET returns set/prefix, never the value.
    // Settings › Models › Sign in: a session that starts with /login, in the
    // active pane's project or the Getting started project (onboarding.ts).
    if (resource === 'agents' && id === 'login' && parts[3] === 'session' && method === 'POST') {
      const body = await readJson(req)
      const requested = typeof body.projectId === 'string' ? body.projectId : null
      const known = requested && (space.registry.get(requested) || brainIdFromProjectId(requested)) ? requested : null
      json(res, 202, { id: queueSignInSession(space.registry, deps.spawns, known) })
      return true
    }

    // Settings › Models: the agent CLIs sessions can run with — which one new
    // sessions start with, each one's cockpit-owned runtime (version, background
    // updates, check now, roll back) and its own settings.
    if (resource === 'providers') {
      const provider = id ? deps.providers.get(id) : undefined
      if (id && !provider) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown provider' } }); return true }
      const [, , , section, action] = parts
      let handled = false
      if (!id && method === 'GET') {
        // Settings › Models asks for a fresh look at the sign-ins (?refresh=1); the menus take the cached answer.
        if (url.searchParams.get('refresh') === '1') for (const p of deps.providers.all()) p.auth.invalidate()
        handled = true
      }
      if (!id && method === 'PATCH') {
        const body = (await readJson(req)) as { default?: unknown }
        if (!isProviderId(body.default) || !deps.providers.get(body.default)) {
          json(res, 400, { error: { code: 'INVALID_INPUT', message: 'default must be a known provider id' } })
          return true
        }
        writeDefaultProvider(body.default)
        handled = true
      }
      if (provider && section === 'runtime' && !action && method === 'PATCH') {
        const body = (await readJson(req)) as { autoUpdate?: unknown }
        if (typeof body?.autoUpdate !== 'boolean') {
          json(res, 400, { error: { code: 'INVALID_INPUT', message: 'autoUpdate must be true or false' } })
          return true
        }
        provider.runtime.setAutoUpdate(body.autoUpdate)
        handled = true
      }
      if (provider && section === 'runtime' && action === 'check' && method === 'POST') {
        await provider.runtime.check()
        handled = true
      }
      if (provider && section === 'runtime' && action === 'rollback' && method === 'POST') {
        try {
          await provider.runtime.rollback()
        } catch (e) {
          json(res, 409, { error: { code: 'NO_PREVIOUS', message: (e as Error).message } })
          return true
        }
        handled = true
      }
      if (provider && section === 'settings' && !action && method === 'PATCH') {
        const error = provider.settings
          ? provider.settings.write(await readJson(req))
          : `${provider.label} has no settings here`
        if (error) { json(res, 400, { error: { code: 'INVALID_INPUT', message: error } }); return true }
        handled = true
      }
      if (handled) {
        json(res, 200, { providers: await providerViews(deps) })
        return true
      }
    }

    if (resource === 'agents' && id === 'login' && !parts[3]) {
      if (method === 'GET') {
        if (url.searchParams.has('refresh')) invalidateAccountCache()
        json(res, 200, await claudeLoginStatus())
        return true
      }
      if (method === 'PUT' || method === 'PATCH') {
        const body = (await readJson(req)) as { token?: unknown; mode?: unknown; permissionMode?: unknown; renderer?: unknown; remoteControl?: unknown; chatView?: unknown }
        const error = method === 'PUT' ? writeClaudeLogin(body?.token) : writeAgentPatch(body)
        if (error) { json(res, 400, { error: { code: 'INVALID_INPUT', message: error } }); return true }
        invalidateAccountCache()
        json(res, 200, await claudeLoginStatus())
        return true
      }
      if (method === 'DELETE') {
        clearClaudeLogin()
        invalidateAccountCache()
        json(res, 200, await claudeLoginStatus())
        return true
      }
    }

    // Session hook → turn state (see turn-state.ts). turn-hook.ts from the agent CLI,
    // no Origin; the per-boot token in the hook header is the guard.
    if (resource === 'hook' && !id && method === 'POST') {
      if (req.headers[HOOK_TOKEN_HEADER] !== deps.hookToken) {
        json(res, 403, { error: { code: 'FORBIDDEN', message: 'Bad hook token' } })
        return true
      }
      // The hook names the cockpit session it runs in; the payload carries the
      // provider's own id, which the ledger keeps for resume and transcripts.
      const named = req.headers[HOOK_SESSION_HEADER]
      applySessionHook(
        {
          providers: deps.providers, ledger: deps.bridge.ledger, turns: deps.turns,
          waitsOnHelpers: (sessionId: string) => deps.chat.holdTurnOpen(sessionId),
          ...(deps.turnEnded ? { turnDone: (sessionId: string, payload: Record<string, unknown>) => deps.turnEnded!(sessionId, deps.providers.forSession(sessionId).lastReply(payload)) } : {}),
          ...(deps.answered ? { answered: deps.answered } : {}),
          ...(deps.userWrote ? { userWrote: deps.userWrote } : {}),
        },
        typeof named === 'string' && named ? named : null,
        await readJson(req),
      )
      json(res, 200, { ok: true })
      return true
    }

    // Server-sent turn events for the UI: a full snapshot on (re)connect,
    // then one `turn` event per change; keep-alive comment every 25s.
    if (resource === 'events' && !id && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      res.write('retry: 2000\n\n')
      send('snapshot', deps.turns.snapshot())
      const onTurn = (event: TurnEvent) => send('turn', event)
      deps.turns.on('turn', onTurn)
      const detachSpawns = attachSpawnEvents(deps.spawns, send)
      // Note changes of every space, each tagged with its space (null = main,
      // as the pane store keys it) — including spaces added while connected.
      const detachNotes: Array<() => void> = []
      const followNotes = (s: BrainSpace) => {
        detachNotes.push(s.notes.subscribe((change: NotesChange) => send('notes', { ...change, spaceId: s.ledgerKey })))
      }
      for (const s of deps.spaces.list()) followNotes(s)
      detachNotes.push(deps.spaces.onAdd(followNotes))
      // The task board moved: which tasks changed whose turn (application/task-board.ts).
      if (deps.tasks) detachNotes.push(deps.tasks.board.onChange((changes) => send('tasks', { changes })))
      const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000)
      req.on('close', () => {
        clearInterval(keepAlive)
        deps.turns.off('turn', onTurn)
        detachSpawns()
        for (const detach of detachNotes) detach()
      })
      return true
    }

    // Projects
    if (resource === 'projects' && !id && method === 'GET') {
      json(res, 200, { projects: await listProjects(deps, space) })
      return true
    }
    // Every project is a brain project (decision cockpit-brain-project-model): a folder is added as a brain
    // project's folder (PATCH path), no longer on its own.
    if (resource === 'projects' && !id && method === 'POST') {
      json(res, 410, { error: { code: 'FOLDER_PROJECTS_GONE', message: 'A folder is added as the folder of a brain project: create the brain project, then set its folder.' } })
      return true
    }
    // A folder-only project joins a brain project of this space: the brain project takes the folder and its sessions.
    if (resource === 'projects' && id && parts[3] === 'link' && method === 'POST') {
      const body = await readJson(req)
      const brainId = typeof body.project === 'string' ? body.project.trim() : ''
      let brain: BrainProject | undefined
      try { brain = (await space.projects.list()).find((p) => p.id === brainId && p.status !== 'archived') } catch {
        json(res, 502, { error: { code: 'BRAIN_UNAVAILABLE', message: 'The brain did not answer. Nothing was changed; try again.' } })
        return true
      }
      if (!brain) { json(res, 404, { error: { code: 'NO_SUCH_PROJECT', message: `No open brain project "${brainId}" in this space.` } }); return true }
      const project = space.registry.link(id, brain.id, brain.name)
      deps.bridge.ledger.reassignProject(id, project.projectId, space.ledgerKey)
      if (project.path) trustProject(deps, space, project.path)
      json(res, 200, { success: true, project: projectView(deps, space, project, brain) })
      return true
    }
    // Moving a project into a shared space (project-move.ts): the plan, then
    // the run against the plan's hash. The source is this space, the target a
    // space of this cockpit; the brain server does the move and its refusals.
    if (resource === 'projects' && id && parts[3] === 'move-plan' && method === 'GET') {
      const target = deps.spaces.get(url.searchParams.get('target') ?? '')
      if (!target) { json(res, 404, { error: { code: 'NO_SUCH_SPACE', message: 'No such brain space' } }); return true }
      const answer = await planProjectMove(space, target, brainProjectOf(id))
      json(res, answer.status, answer.body)
      return true
    }
    if (resource === 'projects' && id && parts[3] === 'move' && method === 'POST') {
      const body = await readJson(req)
      const target = deps.spaces.get(typeof body.target === 'string' ? body.target : '')
      if (!target) { json(res, 404, { error: { code: 'NO_SUCH_SPACE', message: 'No such brain space' } }); return true }
      const answer = await moveProject(space, target, brainProjectOf(id), typeof body.plan_hash === 'string' ? body.plan_hash : '')
      json(res, answer.status, answer.body)
      return true
    }
    if (resource === 'projects' && id && method === 'PATCH') {
      const body = await readJson(req)
      const { entry, brain } = await resolveEntry(space, id)
      if (!entry) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'Project not found' } }); return true }
      // A session started without a folder gets its cockpit folder at spawn
      // (pty-bridge), not through this route.
      const requestedPath: string | null | undefined =
        typeof body.path === 'string' ? body.path : body.path === null ? null : undefined
      // Renaming a brain project renames it in the brain, not in the local
      // registry: a local name would drift from the one agents see. The local
      // name stays for folder projects, and for a brain entry whose project is
      // gone from the brain (404).
      let displayName: string | null | undefined = typeof body.displayName === 'string' ? body.displayName : undefined
      let renamedBrain: BrainProject | null = brain
      let brainName: string | null = null
      if (displayName !== undefined && entry.kind === 'brain' && entry.brainProjectId) {
        const name = (displayName ?? '').trim()
        if (!name) {
          json(res, 400, { error: { code: 'NAME_REQUIRED', message: 'A brain project needs a name.' } })
          return true
        }
        try {
          await space.projects.rename(entry.brainProjectId, name)
          renamedBrain = brain ? { ...brain, name } : null
          brainName = name
          displayName = null
        } catch (err) {
          if (!(err instanceof BrainRenameError) || err.status !== 404) {
            json(res, 502, { error: { code: 'BRAIN_UNAVAILABLE', message: 'The brain did not take the new name — nothing was changed.' } })
            return true
          }
        }
      }
      let project = space.registry.update(id, {
        displayName,
        starred: typeof body.isStarred === 'boolean' ? body.isStarred : undefined,
        hidden: typeof body.hidden === 'boolean' ? body.hidden : undefined,
        path: requestedPath,
        brainName: renamedBrain?.name,
      })
      // The registry keeps a copy of the brain name for when the brain is unreachable.
      if (brainName !== null && entry.brainProjectId) project = space.registry.ensureBrain(entry.brainProjectId, brainName)
      if (typeof requestedPath === 'string' && project.path) trustProject(deps, space, project.path)
      json(res, 200, { success: true, project: projectView(deps, space, project, renamedBrain) })
      return true
    }
    if (resource === 'projects' && id && method === 'DELETE') {
      const project = space.registry.get(id)
      if (!project) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'Project not found' } }); return true }
      const deleteData = url.searchParams.get('deleteData') === '1'
      deps.bridge.killProjectSessions(id, space.ledgerKey)
      deps.chat.killProjectSessions(id, space.ledgerKey)
      for (const entry of deps.bridge.ledger.list(id, space.ledgerKey)) {
        if (deleteData) deps.providers.forSession(entry.sessionId).deleteTranscript(deps.bridge.sessionRef(entry.sessionId, project.path))
        deps.bridge.ledger.remove(entry.sessionId)
      }
      space.registry.remove(id)
      json(res, 200, { success: true })
      return true
    }

    // Sessions
    if (resource === 'sessions' && !id && method === 'GET') {
      const projectId = url.searchParams.get('projectId') ?? undefined
      const sessions = deps.bridge.ledger.list(projectId, space.ledgerKey)
        .filter((entry) => !entry.archivedAt)
        .map((entry) => sessionView(deps, entry.projectId ? space.registry.get(entry.projectId) : undefined, entry))
        .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
      json(res, 200, { sessions })
      return true
    }
    if (resource === 'sessions' && id && method === 'PATCH') {
      const body = await readJson(req)
      // A session with a task is called by its task: renaming the session renames the task.
      // A brain that refuses the name leaves both as they were.
      // The task is then the only one holding the name: the session's own title is cleared, not kept as a second copy.
      const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : ''
      let taskNamed = false
      if (title && deps.bridge.ledger.get(id)?.taskId && deps.sessionTask) {
        try {
          taskNamed = await deps.sessionTask.renamed(id, title)
        } catch (err) {
          const refusal = renameRefusal(err)
          json(res, refusal.status, { error: { code: refusal.code, message: refusal.message } })
          return true
        }
        if (taskNamed) await deps.tasks?.board.refresh().catch(() => {})
      }
      const entry = deps.bridge.ledger.update(id, {
        title: taskNamed ? null : typeof body.title === 'string' ? body.title : undefined,
        pinned: typeof body.isPinned === 'boolean' ? body.isPinned : undefined,
      })
      if (!entry) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'Session not found' } }); return true }
      // The session's own space, not the shown one: the All view acts on any space's sessions.
      const project = entry.projectId ? deps.spaces.resolve(entry.spaceId).registry.get(entry.projectId) : undefined
      json(res, 200, { success: true, session: sessionView(deps, project, { sessionId: id, ...entry }) })
      return true
    }
    // The user closed a pane (×): a session kept running for Remote Control is
    // no longer kept; like any detached session it ends after the timeout.
    if (resource === 'sessions' && id && parts[3] === 'release' && method === 'POST') {
      if (!deps.bridge.ledger.get(id)) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'Session not found' } }); return true }
      const body = await readJson(req)
      const paneId = typeof body.paneId === 'string' && body.paneId ? body.paneId : null
      json(res, 200, { success: true, released: deps.bridge.releasePane(id, paneId) })
      return true
    }
    if (resource === 'sessions' && id && method === 'DELETE') {
      const entry = deps.bridge.ledger.get(id)
      if (!entry) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'Session not found' } }); return true }
      deps.bridge.killSession(id)
      await deps.chat.kill(id)
      deps.turns.forget(id)
      deps.sessionGone?.(id)
      const project = entry.projectId ? deps.spaces.resolve(entry.spaceId).registry.get(entry.projectId) : undefined
      deps.providers.forSession(id).deleteTranscript(deps.bridge.sessionRef(id, project?.path ?? null))
      deps.bridge.ledger.remove(id)
      json(res, 200, { success: true })
      return true
    }

    // Folder listing + creation for the add-project and set-folder dialogs (directories only)
    if (resource === 'folders' && !id && method === 'GET') {
      json(res, 200, browseFolders(url.searchParams.get('path') ?? '~'))
      return true
    }
    if (resource === 'folders' && !id && method === 'POST') {
      const body = await readJson(req)
      const created = createFolder(typeof body.path === 'string' ? body.path : '')
      json(res, 200, { success: true, path: created })
      return true
    }

    // PTY attach handshake
    if (resource === 'pty' && method === 'POST') {
      json(res, 200, deps.bridge.mintNonce())
      return true
    }

    // Chat view attach handshake
    if (resource === 'chat' && method === 'POST') {
      json(res, 200, deps.chat.mintNonce())
      return true
    }
  } catch (err) {
    fail(res, err)
    return true
  }
  return false
}

async function proxyBrain(req: http.IncomingMessage, res: http.ServerResponse, deps: HostDeps) {
  const space = deps.spaces.fromHeader(req.headers['x-cockpit-space'])
  if (!space) { json(res, 404, { error: { code: 'NO_SUCH_SPACE', message: 'No such brain space' } }); return }
  const rel = (req.url ?? '').slice('/api/brain'.length) || '/'
  const method = req.method ?? 'GET'
  // Only the routes the page uses pass (page-brain-routes.ts); a query only on a read.
  if (!isPageRoute(SPACE_BRAIN_ROUTES, method, rel.split('?')[0]) || (method !== 'GET' && rel.includes('?'))) {
    json(res, 403, { error: NOT_PASSED })
    return
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${space.token}`,
    Accept: 'application/json',
  }
  let body: Buffer | undefined
  if (method !== 'GET' && method !== 'HEAD') {
    body = await readBody(req)
    if (body.length) headers['Content-Type'] = req.headers['content-type'] ?? 'application/json'
  }
  try {
    const upstream = await fetch(`${space.url}${rel}`, {
      method, headers, body: body ? new Uint8Array(body) : undefined,
    })
    const text = await upstream.text()
    // A project created/patched through the proxy must show up in the next
    // GET /api/projects, not after the 5s cache lapses (a new project used to
    // appear only after a reload). v0.19: the wizard creates and the detail
    // updates through /object/project (POST, PUT /object/project/:id) — those
    // invalidate too.
    if (upstream.ok && method !== 'GET' && method !== 'HEAD' && /^\/(object\/)?projects?(\/|\?|$)/.test(rel)) {
      space.projects.invalidate()
    }
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
    })
    res.end(text)
  } catch {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Failed to reach the brain API.' }))
  }
}

// A reply can name any image URL, and an image loads with no click: only the page's own
// images may load (pasted ones, data: and blob: previews). The chat view turns the others
// into links (reply-markdown.ts); this holds for every view. Images only for now: a full
// policy would have to list what the terminal, the notes editor and the Brain views need.
export const CONTENT_SECURITY_POLICY = "img-src 'self' data: blob:"

export function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  const urlPath = (req.url ?? '/').split('?')[0]
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  const filePath = path.join(FRONTEND_DIST, rel)
  // Prevent path traversal outside dist.
  if (!filePath.startsWith(FRONTEND_DIST)) { res.writeHead(403); res.end(); return }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' })
    fs.createReadStream(filePath).pipe(res)
    return
  }
  // SPA fallback → index.html
  const indexPath = path.join(FRONTEND_DIST, 'index.html')
  if (fs.existsSync(indexPath)) {
    res.writeHead(200, { 'Content-Type': MIME['.html'] })
    fs.createReadStream(indexPath).pipe(res)
    return
  }
  // No frontend built yet (host-only milestones): placeholder.
  res.writeHead(200, { 'Content-Type': MIME['.html'] })
  res.end('<!doctype html><meta charset=utf-8><title>EML Cockpit</title>' +
    '<body style="font-family:monospace;padding:2rem"><h1>EML Cockpit host</h1>' +
    '<p>Host is up. Frontend not built yet — run the frontend build.</p>')
}

/**
 * The write routes a session reaches with its own per-boot token instead of
 * the page's Origin: /api/hook, /api/spawn, /api/jobs (a session scheduling),
 * /api/session-task, /api/session-title/<id>, /api/sessions/<target>/message. Every
 * other write — a project's move into a shared space among them — needs the
 * cockpit page's Origin.
 */
export function isTokenEndpoint(url: string): boolean {
  return /^\/api\/(hook|spawn|jobs|session-task|session-title\/[0-9a-f-]{36}|sessions\/[a-zA-Z0-9_.:-]+\/message)(\?|$)/.test(url)
}

export function createHostServer(deps: HostDeps, allowedOrigins: string[]): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/health') {
      json(res, 200, { status: 'ok' })
      return
    }
    // Who may reach the cockpit at all: this machine, or a tailnet user remote
    // access lets in (remote-access.ts) — and from which origins they may write.
    const gate = requestGate(req, allowedOrigins)
    if (!gate.allowed) {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'Not allowed from here' } })
      return
    }
    // The brain MCP endpoint (brain-mcp.ts): local agent sessions only, no
    // Origin; the space's MCP token and a known session are its guard.
    if (url === MCP_PATH || url.startsWith(`${MCP_PATH}?`)) { void deps.brainMcp.handle(req, res); return }
    // The cockpit MCP endpoint (cockpit-mcp.ts): the cockpit's own tools for terminal sessions, behind the same guard.
    if (deps.cockpitMcp && (url === COCKPIT_MCP_PATH || url.startsWith(`${COCKPIT_MCP_PATH}?`))) { void deps.cockpitMcp.handle(req, res); return }
    // The hook routes (brain-mcp.ts HOOKS_PATH): the session hooks' reads, the space's MCP token as the bearer.
    if (url.startsWith(`${HOOKS_PATH}/`)) { void deps.brainMcp.handleHooks(req, res); return }
    // The relay to remote MCP servers the user signed in to here (mcp-relay.ts): sessions on this
    // machine, no Origin; the sign-in's own key in its header is the guard.
    if (url.startsWith(`${RELAY_PATH}/`)) { void mcpRelay.handle(req, res).catch((err) => fail(res, err)); return }
    // CSRF guard for the whole API surface, including the brain proxy (the host
    // injects the brain token, so a cross-origin write would otherwise reach the
    // real brain): every state-changing /api/* call must carry an allowlisted
    // Origin — the cockpit's own page. The token-authenticated machine endpoints
    // carry no Origin and are exempt: /api/hook (session hooks, per-boot token in
    // the x-cockpit-hook header), /api/spawn (worker spawn),
    // /api/session-title/<id> (a session naming itself) and
    // /api/sessions/<target>/message and /api/jobs (a session scheduling), all X-Cockpit-Token. Reads
    // (GET/HEAD) are open; a cross-origin page still can't read the response.
    if (url.startsWith('/api/')) {
      const method = req.method ?? 'GET'
      const write = method !== 'GET' && method !== 'HEAD'
      if (write && !isTokenEndpoint(url) && !gate.origins.includes(req.headers.origin ?? '')) {
        json(res, 403, { error: { code: 'FORBIDDEN', message: 'Cross-origin request refused' } })
        return
      }
    }
    // The channel bridge, with a space's token (job-contract-api.ts); no page calls these.
    if (url.startsWith('/v1/') && deps.jobContract) {
      void handleJobContract(req, res, deps.jobContract, json, readJson).catch((err) => fail(res, err))
      return
    }
    // A job's drafts in the channel bridge, for the review card (channel-bridge-api.ts).
    if (/^\/api\/bridge(\/|\?|$)/.test(url) && deps.channelBridge) {
      void handleBridgeApi(req, res, deps.channelBridge).catch((err) => fail(res, err))
      return
    }
    // Only /api/brain and /api/brain/… — not host routes like /api/brain-info.
    if (/^\/api\/brain(\/|\?|$)/.test(url)) { void proxyBrain(req, res, deps); return }
    if (url.startsWith('/api/')) {
      void handleApi(req, res, deps).then((handled) => {
        if (!handled) json(res, 404, { error: { code: 'NOT_FOUND', message: 'No such endpoint' } })
      })
      return
    }
    serveStatic(req, res)
  })

  // Guarded WS upgrade on /ws/shell?nonce= — the session identity travels in
  // the `init` frame so a pane can reattach to its running PTY.
  // perMessageDeflate off: loopback (or the tailnet), compression is pure CPU waste.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  server.on('upgrade', (req, socket, head) => {
    const { pathname, searchParams } = new URL(req.url ?? '', 'http://127.0.0.1')
    if (pathname !== '/ws/shell' && pathname !== '/ws/chat') { socket.destroy(); return }
    const gate = requestGate(req, allowedOrigins)
    const origin = req.headers.origin
    if (!gate.allowed || !origin || !gate.origins.includes(origin)) { socket.destroy(); return }
    const nonce = searchParams.get('nonce') ?? ''
    const side = pathname === '/ws/chat' ? deps.chat : deps.bridge
    if (!side.consumeNonce(nonce)) { socket.destroy(); return }
    // Whether the client is on this machine: the Shell plugin's terminal opens for it alone, unless remote access allows more.
    const local = isLocalRequest(req)
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Disable Nagle on loopback — it only delays small frames.
      const tcp = (ws as unknown as { _socket?: { setNoDelay?: (f: boolean) => void } })._socket
      tcp?.setNoDelay?.(true)
      if (side === deps.bridge) deps.bridge.attach(ws, local)
      else deps.chat.attach(ws)
    })
  })

  return server
}
