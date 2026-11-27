import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { CODEX_CONFIG_DIR } from '../../../paths.js'
import type {
  ImageInput, ModelOption, ModeOption, PermissionAnswer, RuntimeEvent, RuntimeFeature, SessionRuntime, SessionRuntimeFactory, SessionRuntimeStart, ToolServer,
  ToolServerSignIn,
} from '../../../domain/session-runtime.js'
import type { SessionRef } from '../../../domain/agent-provider.js'
import { AppServerClient, AppServerError, type AppServerProcess } from './app-server-client.js'
import { hooksSourcePath } from './hook-trust.js'
import { CodexEventMapper, HIDDEN_INPUT_CLOSE, HIDDEN_INPUT_OPEN, historyEvents } from './event-mapper.js'
import {
  METHOD_NOT_FOUND, type ApprovalsReviewer, type AskForApproval, type InitializeParams, type McpServerStatus, type Model, type SandboxMode, type SandboxPolicy,
  type ThreadStartParams, type ThreadStartResponse,
  type ThreadTurnsListResponse,
  type Turn, type TurnStartParams, type UserInput,
} from './protocol.js'
import { codexRuntime } from './runtime.js'
import { CODEX_PERMISSION_MODES, DEFAULT_EFFORT, readCodexSettings, type CodexPermissionMode } from './settings.js'

/**
 * Codex through `codex app-server` as a SessionRuntime: one app-server process per
 * session, the same binary, CODEX_HOME, hooks and MCP servers as a terminal session,
 * and the same stored conversation (a thread is a rollout file).
 *
 * The cockpit's own tools (end_turn, schedule, send_message, …) are not served from
 * here: the session's app-server reaches them as the MCP server `cockpit` of
 * config.toml, the host's endpoint (cockpit-mcp.ts), like a terminal session does.
 */

// The mode a worker runs in, as in the terminal (index.ts launch, unattended).
const WORKER_MODE: CodexPermissionMode = 'auto'

const MODES: ModeOption[] = [
  { id: 'auto', label: 'Auto', description: 'Works in the sandbox; a reviewer model answers requests to go beyond it' },
  { id: 'ask', label: 'Ask first', description: 'Works in the sandbox; asks you before going beyond it' },
  // Picked on purpose only: Shift+Tab does not land on it.
  { id: 'off', label: 'No sandbox', description: 'No sandbox and no questions', cycle: false },
]

/**
 * What a Codex session offers in the chat (domain RuntimeFeature). No commands: it takes a message as it is.
 * No switching a tool server on or off: app-server has no call for it short of rewriting config.toml, which
 * the cockpit owns. Reconnecting reloads every server's configuration (config/mcpServer/reload).
 */
const FEATURES: RuntimeFeature[] = ['stopAgent', 'toolServerReconnect', 'toolServerSignIn', 'reasoningEffort']

const CLIENT: InitializeParams['clientInfo'] = { name: 'eml_cockpit', title: 'EML Cockpit', version: '1' }
const HISTORY_PAGE = 50
const NO_TOGGLE = 'Codex sessions take their tool servers from the cockpit\'s settings; they cannot be switched on or off from the chat.'

/** A model as the chat lists it, with the efforts it takes. */
export function modelOption(model: Model): ModelOption {
  const efforts = (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [])
    .filter((one) => typeof one?.reasoningEffort === 'string' && one.reasoningEffort)
    .map((one) => ({ id: one.reasoningEffort, label: one.reasoningEffort.charAt(0).toUpperCase() + one.reasoningEffort.slice(1), description: typeof one.description === 'string' ? one.description : '' }))
  return {
    id: model.id, label: model.displayName, description: model.description, resolved: model.model ?? null,
    ...(efforts.length > 0 ? { efforts, defaultEffort: typeof model.defaultReasoningEffort === 'string' ? model.defaultReasoningEffort : null } : {}),
  }
}

/** A tool server as the panel shows it: no address, no credentials. */
export function toolServerOf(server: McpServerStatus): ToolServer {
  const toolCount = server.tools && typeof server.tools === 'object' ? Object.keys(server.tools).length : 0
  const error = typeof server.toolsError === 'string' && server.toolsError ? server.toolsError : null
  // Signed in since the thread connected: it connects anew at the next turn (config/mcpServer/reload).
  const signedIn = server.authStatus === 'oAuth' || server.authStatus === 'bearerToken'
  const status = ((): ToolServer['status'] => {
    switch (server.runtimeStatus) {
      case 'connected': return 'connected'
      case 'authenticationRequired': return signedIn ? 'pending' : 'needs-auth'
      case 'failed': case 'cancelled': return server.authStatus === 'notLoggedIn' ? 'needs-auth' : 'failed'
      case 'disabled': return 'disabled'
      case 'starting': case 'notStarted': return 'pending'
      // Not known (the configuration changed): what its catalog says.
      default: return server.authStatus === 'notLoggedIn' ? 'needs-auth' : error ? 'failed' : toolCount > 0 ? 'connected' : 'pending'
    }
  })()
  return {
    name: server.name, status, error, scope: server.pluginId ? 'plugin' : null, transport: server.httpOrigin ? 'web' : 'process', toolCount,
  }
}

/** What a session process is started with. */
export interface AppServerSpawn {
  bin: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export type SpawnAppServer = (options: AppServerSpawn) => AppServerProcess

/** `codex app-server` speaks over its stdio by default. */
const APP_SERVER_ARGS = ['app-server']

const spawnAppServer: SpawnAppServer = ({ bin, args, cwd, env }) => spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })

/** What the runtime reads from the provider around it (index.ts). */
export interface CodexChatHost {
  /** The plugin servers switched on for a space's sessions, by their names in config.toml. */
  pluginServers?: (spaceId: string) => string[]
  /** The cockpit's folders a sandboxed session may write to beside its project (config.toml, sandbox_workspace_write). */
  writableDirs?: () => string[]
}

const isMode = (value: unknown): value is CodexPermissionMode => (CODEX_PERMISSION_MODES as readonly unknown[]).includes(value)

/** What a mode means for a thread: the terminal's arguments for the same mode (index.ts launch), in the protocol's words. */
export function threadPermissions(mode: CodexPermissionMode): { approvalPolicy: AskForApproval; sandbox: SandboxMode; approvalsReviewer?: ApprovalsReviewer } {
  if (mode === 'off') return { approvalPolicy: 'never', sandbox: 'danger-full-access' }
  return { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user' }
}

/** The mode a run starts in: the session's own choice, else what terminal sessions start in (Settings › Models › Codex). */
export function startingMode(chosen: string | null, setting: CodexPermissionMode): CodexPermissionMode {
  return isMode(chosen) ? chosen : setting
}

/** Text the agent reads and the conversation does not show (event-mapper.ts leaves it out of a stored thread). */
function hidden(text: string): UserInput {
  return { type: 'text', text: `${HIDDEN_INPUT_OPEN}\n${text}\n${HIDDEN_INPUT_CLOSE}`, text_elements: [] }
}

interface Queued {
  /** Null: the cockpit's own follow-up, which no view shows. */
  id: string | null
  input: UserInput[]
}

class CodexChatRuntime implements SessionRuntime {
  private client: AppServerClient | null = null
  private mapper = new CodexEventMapper()
  private threadId: string | null = null
  private mode: CodexPermissionMode
  private model: string | null
  // Null: the model's default.
  private effort: string | null
  private models: ModelOption[] = []
  // The model a thread runs with when none is named.
  private defaultModel: string | null = null
  // What the thread runs with differs from these until the next turn carries them: an override stays for the turns after it.
  private modeChanged = false
  private modelChanged = false
  private effortChanged = false
  // What the user wrote with a refusal the answer could not carry: goes with their next message.
  private notes: string[] = []
  // The sandbox the thread reported at its start, when that is the workspace one: roots and network as config.toml has them.
  private workspace: SandboxPolicy | null = null
  private queue: Queued[] = []
  private ready = false
  // A turn runs, is being started, or its end is being settled: the next message waits.
  private busy = false
  private turnId: string | null = null
  private starting: Promise<void> | null = null
  private closing = false
  private exitReported = false

  constructor(private request: SessionRuntimeStart, spawnProcess: SpawnAppServer, private host: CodexChatHost) {
    const settings = readCodexSettings()
    this.mode = startingMode(request.mode, settings.permissionMode)
    this.model = request.model
    this.effort = request.effort ?? (settings.reasoningEffort === DEFAULT_EFFORT ? null : settings.reasoningEffort)
    try {
      this.client = new AppServerClient(() => spawnProcess({ bin: codexRuntime.bin, args: APP_SERVER_ARGS, cwd: request.cwd, env: request.env }))
    } catch (error) {
      this.emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      this.reportExit(false)
      return
    }
    const client = this.client
    // At once, before the server starts its MCP servers: they and every tool inherit the group.
    if (client.pid !== undefined) request.onSpawn?.(client.pid)
    client.onNotification((method, params) => this.onNotification(method, params))
    client.onRequest((id, method, params) => {
      const events = this.mapper.request(id, method, params)
      if (events) this.emitAll(events)
      // Nothing it could ask: no answers, and the agent goes on.
      else if (method === 'item/tool/requestUserInput') client.respond(id, { answers: {} })
      else client.respondError(id, METHOD_NOT_FOUND, `The cockpit does not answer ${method}`)
    })
    client.onExit(() => {
      if (!this.closing) {
        const detail = client.stderrTail().trim().split('\n').pop()
        if (detail) this.emit({ kind: 'error', message: detail })
      }
      this.emitAll(this.mapper.cancelOpenRequests())
      this.reportExit(this.closing)
    })
    void this.boot(client)
  }

  private emit(event: RuntimeEvent): void {
    this.request.onEvent(event)
  }

  private emitAll(events: RuntimeEvent[]): void {
    for (const event of events) this.emit(event)
  }

  private reportExit(expected: boolean): void {
    if (this.exitReported) return
    this.exitReported = true
    this.emit({ kind: 'runtime_exit', expected })
  }

  /** The settings a thread starts or resumes with. A space's plugin servers and the network are config overrides, as on the terminal's command line. */
  private threadSettings(): ThreadStartParams {
    const settings = readCodexSettings()
    const permissions = threadPermissions(this.mode)
    const config: Record<string, unknown> = {
      ...(this.mode !== 'off' && settings.sandboxNetwork ? { 'sandbox_workspace_write.network_access': true } : {}),
      ...Object.fromEntries((this.host.pluginServers?.(this.request.space.id) ?? []).map((name) => [`mcp_servers.${name}.enabled`, true])),
    }
    return {
      cwd: this.request.cwd,
      ...permissions,
      ...(this.model ? { model: this.model } : {}),
      // A thread takes no effort of its own, but the configuration's default.
      ...(this.effort ? { config: { ...config, model_reasoning_effort: this.effort } } : Object.keys(config).length > 0 ? { config } : {}),
    }
  }

  private async boot(client: AppServerClient): Promise<void> {
    try {
      await client.request('initialize', { clientInfo: CLIENT })
      client.notify('initialized')
      // Before the thread: an effort its model does not take is not passed on.
      const models = await client.request('model/list', {}).catch(() => ({ data: [] as Model[] }))
      const listed = Array.isArray(models.data) ? models.data : []
      this.models = listed.filter((model) => !model.hidden).map(modelOption)
      this.defaultModel = listed.find((model) => model.isDefault)?.id ?? null
      const starting = this.modelOf(this.model ?? this.defaultModel)
      if (this.effort && starting && !starting.efforts?.some((one) => one.id === this.effort)) this.effort = null
      const thread = await this.openThread(client)
      this.threadId = thread.thread.id
      this.mapper.setThread(thread.thread.id)
      if (thread.sandbox?.type === 'workspaceWrite') this.workspace = thread.sandbox
      // The ledger learns the thread's id here: resume and the stored conversation go by it.
      this.emit({ kind: 'conversation', conversationId: thread.thread.id })
      this.emit({ kind: 'capabilities', modes: MODES, models: this.models, features: FEATURES })
      // Codex takes a message as it is: it has no commands of its own here.
      this.emit({ kind: 'commands', commands: [] })
      this.emit({ kind: 'settings', model: thread.model ?? this.model, mode: this.mode, effort: thread.reasoningEffort ?? this.effort })
      this.ready = true
      this.pump()
      void this.checkHookTrust(client, thread.thread.id)
    } catch (error) {
      // A closing session has no answers, and a process that died says so itself.
      if (this.closing || this.exitReported) return
      this.emit({ kind: 'error', message: `Codex did not start: ${error instanceof Error ? error.message : String(error)}` })
      await client.close()
    }
  }

  /**
   * The stored thread, or a new one when nothing is stored under its id, as a terminal session starts fresh then.
   * Any other refusal ends the start: a thread another process still writes to (a terminal pane, a second
   * app-server) must not be forked into a new conversation behind the user's back.
   */
  private async openThread(client: AppServerClient): Promise<ThreadStartResponse> {
    const { resume, conversationId } = this.request
    if (resume && conversationId) {
      try {
        return await client.request('thread/resume', { threadId: conversationId, ...this.threadSettings(), excludeTurns: true })
      } catch (error) {
        if (!(error instanceof AppServerError)) throw error
        if (ACTIVE_WRITER.test(error.message)) throw new Error(OPEN_ELSEWHERE)
        if (!notStored(error)) throw error
        this.emit({ kind: 'notice', text: `Codex could not continue the earlier conversation (${error.message}). This is a new one.` })
      }
    }
    return client.request('thread/start', this.threadSettings())
  }

  /**
   * app-server runs the cockpit's hooks (index.ts hooks.json) only once they are trusted, and never asks. The cockpit
   * trusts them itself at boot (hook-trust.ts), so this is the fallback for when that did not hold — a Codex that
   * hashes hooks differently, a config.toml the cockpit could not write: the session then goes without its brain
   * boot, project block, task context and reminder. Said once in the conversation, with what to do. A server that
   * cannot tell says nothing.
   */
  private async checkHookTrust(client: AppServerClient, threadId: string): Promise<void> {
    const listed = await client.request('hooks/list', { threadId }).catch(() => null)
    if (!listed || this.closing || this.exitReported) return
    const own = hooksSourcePath(CODEX_CONFIG_DIR)
    const hooks = (Array.isArray(listed.data) ? listed.data : []).flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []))
    const untrusted = hooks.filter((hook) => hook?.sourcePath === own && hook.trustStatus !== 'trusted' && hook.trustStatus !== 'managed')
    if (untrusted.length > 0) this.emit({ kind: 'notice', text: HOOKS_UNTRUSTED })
  }

  /** A model the chat lists, by its id or the model it stands for. */
  private modelOf(id: string | null): ModelOption | null {
    return id ? this.models.find((model) => model.id === id || model.resolved === id) ?? null : null
  }

  private onNotification(method: string, params: unknown): void {
    // A subagent's thread has turns of its own: they are not the session's.
    const threadId = (params as { threadId?: unknown } | null)?.threadId
    const own = typeof threadId !== 'string' || !this.threadId || threadId === this.threadId
    if (method === 'turn/started' && own) {
      const id = (params as { turn?: { id?: unknown } } | null)?.turn?.id
      if (typeof id === 'string') this.turnId = id
    }
    // Signed in: the thread's servers connect anew at its next turn.
    if (method === 'mcpServer/oauthLogin/completed' && (params as { success?: unknown } | null)?.success === true) {
      void this.client?.request('config/mcpServer/reload', undefined).catch(() => {})
    }
    const events = this.mapper.notification(method, params)
    if (method !== 'turn/completed' || !own) return this.emitAll(events)
    const end = events.find((event) => event.kind === 'turn_end')
    this.emitAll(events.filter((event) => event !== end))
    if (end?.kind === 'turn_end') void this.turnEnded(end)
  }

  /**
   * A turn is over. Before a successful one counts as the session's stop, the bridge may send it
   * back (onTurnEnding): that text starts another turn, and this end is not said, as a Stop hook
   * that blocks leaves no end either. Then the next message that waited runs.
   */
  private async turnEnded(end: Extract<RuntimeEvent, { kind: 'turn_end' }>): Promise<void> {
    this.turnId = null
    const worker = this.request.worker
    const back = end.reason === 'success' && worker && !this.closing
      ? await Promise.resolve().then(() => worker.onTurnEnding()).catch(() => null)
      : null
    if (back && !this.closing && !this.exitReported) {
      this.queue.unshift({ id: null, input: [hidden(back)] })
    } else {
      this.emit(end)
    }
    this.busy = false
    this.pump()
  }

  /** Starts the next message's turn, once the thread is there and no turn runs. */
  private pump(): void {
    const client = this.client
    if (!client || !this.ready || this.busy || this.closing || this.exitReported || !this.threadId) return
    const next = this.queue.shift()
    if (!next) return
    this.busy = true
    const params: TurnStartParams = {
      threadId: this.threadId,
      input: next.input,
      ...(next.id ? { clientUserMessageId: next.id } : {}),
      ...this.overrides(),
    }
    // Carried by this turn: the next one names them again only if this one is refused.
    const carried = { mode: this.modeChanged, model: this.modelChanged, effort: this.effortChanged }
    this.modeChanged = false
    this.modelChanged = false
    this.effortChanged = false
    // The turn's id comes with turn/started, right after the answer.
    this.starting = client.request('turn/start', params).then(() => {}, (error: unknown) => {
      if (this.closing || this.exitReported) return
      this.modeChanged ||= carried.mode
      this.modelChanged ||= carried.model
      this.effortChanged ||= carried.effort
      this.emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      this.emit({ kind: 'turn_end', reason: 'error' })
      this.emit({ kind: 'activity', state: 'idle' })
      this.busy = false
      this.pump()
    }).finally(() => { this.starting = null })
  }

  /** What changed since the thread's last turn, for the next one. A turn takes the sandbox as a whole policy. */
  private overrides(): Partial<TurnStartParams> {
    const overrides: Partial<TurnStartParams> = {}
    if (this.modelChanged && this.model) overrides.model = this.model
    if (this.effortChanged && this.effort) overrides.effort = this.effort
    if (this.modeChanged) {
      const { approvalPolicy, approvalsReviewer } = threadPermissions(this.mode)
      overrides.approvalPolicy = approvalPolicy
      if (approvalsReviewer) overrides.approvalsReviewer = approvalsReviewer
      overrides.sandboxPolicy = this.mode === 'off' ? { type: 'dangerFullAccess' } : this.workspace ?? {
        type: 'workspaceWrite',
        writableRoots: this.host.writableDirs?.() ?? [],
        networkAccess: readCodexSettings().sandboxNetwork,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      }
    }
    return overrides
  }

  send(id: string, text: string, images: ImageInput[] = []): void {
    // What the cockpit adds to a prompt, unseen in the chat: before the user's words, as its own item.
    const added = this.request.worker?.onPrompt?.() ?? null
    const notes = this.notes.splice(0)
    this.queue.push({
      id,
      input: [
        ...(added ? [hidden(added)] : []),
        ...notes.map(hidden),
        ...images.map(({ mediaType, data }): UserInput => ({ type: 'image', url: `data:${mediaType};base64,${data}` })),
        ...(text.trim() || images.length === 0 ? [{ type: 'text', text, text_elements: [] } as UserInput] : []),
      ],
    })
    this.pump()
  }

  async interrupt(): Promise<void> {
    // A turn that is just being started has no id yet.
    await this.starting
    if (!this.client || !this.threadId || !this.turnId) return
    await this.client.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
  }

  answerPermission(requestId: string, answer: PermissionAnswer): void {
    const answered = this.mapper.answer(requestId, answer)
    if (!answered) return
    this.client?.respond(answered.id, answered.result)
    this.emitAll(answered.events)
    // Into the running turn only when it goes on: a refusal that ends it (a request without "decline") would lose it.
    if (answered.note) this.pass(answered.note, !answered.endsTurn && !answered.stopTurn)
    if (answered.stopTurn) void this.interrupt().catch((error: unknown) => this.emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) }))
  }

  /**
   * What the user said with a refusal, which Codex's answer cannot carry: into the running turn when it goes on
   * (turn/steer), else with their next message. A stopped turn is not started again for it.
   */
  private pass(note: string, steer: boolean): void {
    const client = this.client
    if (!steer || !client || !this.threadId || !this.turnId) {
      this.notes.push(note)
      return
    }
    client.request('turn/steer', { threadId: this.threadId, input: [hidden(note)], expectedTurnId: this.turnId })
      .catch(() => { this.notes.push(note) })
  }

  async setMode(mode: string): Promise<void> {
    if (!isMode(mode)) throw new Error(`Codex has no mode "${mode}".`)
    if (mode !== this.mode) {
      this.mode = mode
      this.modeChanged = true
    }
    this.emit({ kind: 'settings', mode })
  }

  async setModel(model: string): Promise<void> {
    this.model = model
    this.modelChanged = true
    // An effort the new model does not take gives way to its default; a turn cannot unset one, so it names that.
    const option = this.modelOf(model)
    if (this.effort && option && !option.efforts?.some((one) => one.id === this.effort)) {
      this.effort = option.defaultEffort ?? null
      this.effortChanged = !!this.effort
      this.emit({ kind: 'settings', model, effort: this.effort })
      return
    }
    this.emit({ kind: 'settings', model })
  }

  async setEffort(effort: string): Promise<void> {
    const option = this.modelOf(this.model ?? this.defaultModel)
    const known = this.models.length === 0 || !option?.efforts || option.efforts.some((one) => one.id === effort)
    if (!known) throw new Error(`${option?.label ?? 'This model'} takes no reasoning effort "${effort}".`)
    if (effort !== this.effort) {
      this.effort = effort
      this.effortChanged = true
    }
    this.emit({ kind: 'settings', effort })
  }

  /** A subagent is a thread of its own: its running turn is interrupted like the session's. */
  async stopAgent(taskId: string): Promise<void> {
    const child = this.mapper.runningChild(taskId)
    if (!child || !this.client) return
    await this.client.request('turn/interrupt', child)
  }

  async toolServers(): Promise<ToolServer[]> {
    const client = this.client
    if (!client || !this.threadId) return []
    const servers: ToolServer[] = []
    let cursor: string | null = null
    do {
      const page: { data?: McpServerStatus[]; nextCursor?: string | null } = await client.request('mcpServerStatus/list', {
        threadId: this.threadId, detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}),
      })
      servers.push(...(Array.isArray(page.data) ? page.data : []).filter((server) => typeof server?.name === 'string').map(toolServerOf))
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null
    } while (cursor)
    return servers
  }

  async setToolServerEnabled(): Promise<void> {
    throw new Error(NO_TOGGLE)
  }

  /** app-server reloads every server's configuration at once; the thread connects anew at its next turn. */
  async reconnectToolServer(): Promise<void> {
    if (!this.client) throw new Error('This session is not running.')
    await this.client.request('config/mcpServer/reload', undefined)
  }

  /** Only a server over the web signs in this way; app-server's refusal says so for any other. */
  async signInToolServer(name: string): Promise<ToolServerSignIn> {
    if (!this.client) throw new Error('This session is not running.')
    const { authorizationUrl } = await this.client.request('mcpServer/oauth/login', { name, ...(this.threadId ? { threadId: this.threadId } : {}) })
    if (typeof authorizationUrl !== 'string' || !/^https?:\/\//.test(authorizationUrl)) throw new Error('Codex gave no page to sign in on.')
    return { url: authorizationUrl }
  }

  /** Codex finishes a sign-in on its own page; it takes nothing back. */
  async finishToolServerSignIn(): Promise<void> {
    throw new Error('Codex finishes this sign-in on its own page.')
  }

  async close(): Promise<void> {
    if (this.closing) return this.client?.exited
    this.closing = true
    this.queue = []
    if (this.exitReported) return
    this.emitAll(this.mapper.cancelOpenRequests())
    if (!this.client) return this.reportExit(true)
    await this.client.close()
    // The client's exit listener has said it; this is for a process that was gone before.
    this.reportExit(true)
  }
}

/** The stored thread's turns, oldest first, read by a process of its own: the thread need not be loaded for it. */
async function readTurns(spawnProcess: SpawnAppServer, codexHome: string, threadId: string): Promise<Turn[] | null> {
  const client = new AppServerClient(() => spawnProcess({
    bin: codexRuntime.bin,
    args: APP_SERVER_ARGS,
    cwd: codexHome,
    // Reads files only: no session, so none of a session's environment.
    env: { CODEX_HOME: codexHome, PATH: [codexRuntime.binDir, process.env.PATH].filter(Boolean).join(path.delimiter), ...(process.env.HOME ? { HOME: process.env.HOME } : {}) },
  }))
  try {
    await client.request('initialize', { clientInfo: CLIENT })
    client.notify('initialized')
    const turns: Turn[] = []
    let cursor: string | null = null
    do {
      const page: ThreadTurnsListResponse = await client.request('thread/turns/list', { threadId, itemsView: 'full', sortDirection: 'asc', limit: HISTORY_PAGE, ...(cursor ? { cursor } : {}) })
      turns.push(...(Array.isArray(page.data) ? page.data : []))
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null
    } while (cursor)
    return turns
  } catch (error) {
    // Nothing was stored under this id; any other failure is one, not an empty conversation.
    if (error instanceof AppServerError && notStored(error)) return null
    throw error
  } finally {
    await client.close()
  }
}

/**
 * How app-server says a thread id has nothing stored under it (codex-cli 0.172.0; all with code -32600):
 * "no rollout found for thread id …" (thread/resume), "thread not loaded: …" (thread/turns/list),
 * "invalid thread id: …". Matched narrowly: anything else is a real failure.
 */
const NOT_STORED = /no rollout found for thread id|thread not loaded|invalid thread id/i
const notStored = (error: AppServerError) => NOT_STORED.test(error.message)

/** Another process writes to the thread: "thread … already has an active writer". */
const ACTIVE_WRITER = /already has an active writer/i

export const HOOKS_UNTRUSTED = 'Codex skips the cockpit\'s hooks until you trust them, so this session started without its brain boot, project and task context. Open a Codex session in a terminal once and choose "Trust all"; sessions started after that get them.'
export const OPEN_ELSEWHERE = 'this conversation is still open in another process (a terminal pane of this session, or a Codex that did not exit). Close it there, then send your message again.'

export function createCodexChatRuntimes(spawnProcess: SpawnAppServer = spawnAppServer, host: CodexChatHost = {}): SessionRuntimeFactory {
  return {
    workerMode: WORKER_MODE,
    // app-server runs the cockpit's hooks only once they are trusted (hooks.state in config.toml, hook-trust.ts), and
    // they may not be: its own turns say when the session works.
    reportsTurns: true,
    start: (request) => new CodexChatRuntime(request, spawnProcess, host),
    // Every Codex session keeps its conversation in the one Codex home (index.ts launch).
    async history({ providerSessionId }: SessionRef) {
      if (!providerSessionId) return [{ kind: 'history_end' }]
      return historyEvents(await readTurns(spawnProcess, CODEX_CONFIG_DIR, providerSessionId) ?? [])
    },
  }
}
