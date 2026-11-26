import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { CODEX_CONFIG_DIR } from '../../../paths.js'
import type {
  ImageInput, ModeOption, PermissionAnswer, RuntimeEvent, SessionRuntime, SessionRuntimeFactory, SessionRuntimeStart, ToolServer,
} from '../../../domain/session-runtime.js'
import type { SessionRef } from '../../../domain/agent-provider.js'
import { AppServerClient, AppServerError, type AppServerProcess } from './app-server-client.js'
import { CodexEventMapper, HIDDEN_INPUT_CLOSE, HIDDEN_INPUT_OPEN, historyEvents } from './event-mapper.js'
import {
  METHOD_NOT_FOUND, type ApprovalsReviewer, type AskForApproval, type InitializeParams, type SandboxMode, type SandboxPolicy, type ThreadStartParams, type ThreadStartResponse,
  type ThreadTurnsListResponse,
  type Turn, type TurnStartParams, type UserInput,
} from './protocol.js'
import { codexRuntime } from './runtime.js'
import { CODEX_PERMISSION_MODES, readCodexSettings, type CodexPermissionMode } from './settings.js'

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
  { id: 'off', label: 'No sandbox', description: 'No sandbox and no questions' },
]

const CLIENT: InitializeParams['clientInfo'] = { name: 'eml_cockpit', title: 'EML Cockpit', version: '1' }
const HISTORY_PAGE = 50
const NO_TOOL_SERVERS = 'Codex sessions take their tool servers from the cockpit\'s settings; they cannot be changed from the chat yet.'

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
  // What the thread runs with differs from these until the next turn carries them: an override stays for the turns after it.
  private modeChanged = false
  private modelChanged = false
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
      ...(Object.keys(config).length > 0 ? { config } : {}),
    }
  }

  private async boot(client: AppServerClient): Promise<void> {
    try {
      await client.request('initialize', { clientInfo: CLIENT })
      client.notify('initialized')
      const thread = await this.openThread(client)
      this.threadId = thread.thread.id
      if (thread.sandbox?.type === 'workspaceWrite') this.workspace = thread.sandbox
      // The ledger learns the thread's id here: resume and the stored conversation go by it.
      this.emit({ kind: 'conversation', conversationId: thread.thread.id })
      const models = await client.request('model/list', {}).catch(() => ({ data: [] }))
      this.emit({
        kind: 'capabilities',
        modes: MODES,
        models: (models.data ?? []).filter((model) => !model.hidden).map((model) => ({
          id: model.id, label: model.displayName, description: model.description, resolved: model.model ?? null,
        })),
      })
      // Codex takes a message as it is: it has no commands of its own here.
      this.emit({ kind: 'commands', commands: [] })
      this.emit({ kind: 'settings', model: thread.model ?? this.model, mode: this.mode })
      this.ready = true
      this.pump()
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

  private onNotification(method: string, params: unknown): void {
    if (method === 'turn/started') {
      const id = (params as { turn?: { id?: unknown } } | null)?.turn?.id
      if (typeof id === 'string') this.turnId = id
    }
    const events = this.mapper.notification(method, params)
    if (method !== 'turn/completed') return this.emitAll(events)
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
    const carried = { mode: this.modeChanged, model: this.modelChanged }
    this.modeChanged = false
    this.modelChanged = false
    // The turn's id comes with turn/started, right after the answer.
    this.starting = client.request('turn/start', params).then(() => {}, (error: unknown) => {
      if (this.closing || this.exitReported) return
      this.modeChanged ||= carried.mode
      this.modelChanged ||= carried.model
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
    this.queue.push({
      id,
      input: [
        ...(added ? [hidden(added)] : []),
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
    this.emit({ kind: 'settings', model })
  }

  async stopAgent(): Promise<void> {
    throw new Error('Codex sessions in the chat run no subagents the cockpit could stop.')
  }

  async toolServers(): Promise<ToolServer[]> {
    return []
  }

  async setToolServerEnabled(): Promise<void> {
    throw new Error(NO_TOOL_SERVERS)
  }

  async reconnectToolServer(): Promise<void> {
    throw new Error(NO_TOOL_SERVERS)
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
export const OPEN_ELSEWHERE = 'this conversation is still open in another process (a terminal pane of this session, or a Codex that did not exit). Close it there, then send your message again.'

export function createCodexChatRuntimes(spawnProcess: SpawnAppServer = spawnAppServer, host: CodexChatHost = {}): SessionRuntimeFactory {
  return {
    workerMode: WORKER_MODE,
    start: (request) => new CodexChatRuntime(request, spawnProcess, host),
    // Every Codex session keeps its conversation in the one Codex home (index.ts launch).
    async history({ providerSessionId }: SessionRef) {
      if (!providerSessionId) return [{ kind: 'history_end' }]
      return historyEvents(await readTurns(spawnProcess, CODEX_CONFIG_DIR, providerSessionId) ?? [])
    },
  }
}
