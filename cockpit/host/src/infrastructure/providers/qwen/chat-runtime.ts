import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as readline from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { Query, type CanUseTool, type PermissionMode, type PermissionResult, type SDKMessage, type SDKUserMessage, type Transport } from '@qwen-code/sdk'
import type {
  ImageInput, ModelOption, ModeOption, PermissionAnswer, Question, RuntimeEvent, RuntimeFeature, SessionRuntime, SessionRuntimeFactory, SessionRuntimeStart, ToolKind,
  ToolServer, ToolServerSignIn,
} from '../../../domain/session-runtime.js'
import type { SessionRef } from '../../../domain/agent-provider.js'
import { findChat, readChatRecords } from './chats.js'
import { qwenRuntime } from './runtime.js'
import { readQwenSettings, type QwenPermissionMode } from './settings.js'

/**
 * Qwen Code through its TypeScript SDK (@qwen-code/sdk) as a SessionRuntime: the SDK's
 * Query speaks Qwen Code's stream-json protocol (`--input-format stream-json`), one CLI
 * process per session, with the same QWEN_HOME, settings.json, hooks and MCP servers as a
 * terminal session, and the same stored conversation (QWEN_HOME/projects/…/chats/<id>.jsonl).
 * The only file that imports the SDK.
 *
 * The process is the cockpit's own (QwenProcessTransport), not the SDK's: the SDK's
 * transport merges the host's environment into the session's, and a session gets exactly
 * its own (chat-bridge.ts startRuntime).
 *
 * The cockpit's own tools (end_turn, schedule, …) are not served from here: the session
 * reaches them as the MCP server `cockpit` of settings.json, the host's endpoint
 * (cockpit-mcp.ts), as a terminal session does. The SDK has no hook callbacks (its
 * initialize sends none), so what the cockpit adds to a worker's prompt and the check
 * before its turn ends are done here, around the turns, as Codex's runtime does.
 */

// Qwen Code's own approval modes, as the chat offers them. The worker's: nobody is there to answer.
const WORKER_MODE: PermissionMode = 'auto'

const MODES: ModeOption[] = [
  { id: 'auto', label: 'Auto', description: 'A classifier allows safe actions; risky ones come to you' },
  { id: 'default', label: 'Ask first', description: 'Asks before edits and commands' },
  { id: 'auto-edit', label: 'Accept edits', description: 'Edits go through, commands still ask' },
  { id: 'plan', label: 'Plan', description: 'Reads and plans, changes nothing' },
  // Picked on purpose only: Shift+Tab does not land on it.
  { id: 'yolo', label: 'No questions', description: 'Runs every edit and command without asking', cycle: false },
]

/** Nothing beyond the basics yet: no commands list (Qwen names its commands without descriptions), no per-server controls. */
const FEATURES: RuntimeFeature[] = []

// Terminal settings (Settings › Models › Qwen Code) as the chat's modes.
const MODE_OF_SETTING: Record<QwenPermissionMode, PermissionMode> = { auto: 'auto', ask: 'default', off: 'yolo' }

// A card may wait until the user comes back; the SDK denies after 60 s unless told otherwise.
const PERMISSION_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000
// close() ends the input and asks the process to stop; this is the bound for one that ignores both.
const EXIT_TIMEOUT_MS = 8_000
const MAX_TOOL_OUTPUT = 20_000
const STDERR_TAIL = 2_000

/** Text the agent reads and the conversation does not show: left out of the history. */
export const HIDDEN_OPEN = '<cockpit-context>'
export const HIDDEN_CLOSE = '</cockpit-context>'
const HIDDEN_BLOCK = new RegExp(`${HIDDEN_OPEN}[\\s\\S]*?${HIDDEN_CLOSE}\\s*`, 'g')

const hidden = (text: string) => `${HIDDEN_OPEN}\n${text}\n${HIDDEN_CLOSE}`

const TOOL_KINDS: Record<string, ToolKind> = {
  read_file: 'read', read_many_files: 'read', read_mcp_resource: 'read', zoom_image: 'read',
  edit: 'edit', write_file: 'edit', notebook_edit: 'edit', replace: 'edit',
  run_shell_command: 'execute', monitor: 'execute',
  grep_search: 'search', glob: 'search', list_directory: 'search', tool_search: 'search', search_memory: 'search',
  web_fetch: 'fetch', web_search: 'fetch',
  agent: 'agent', task: 'agent',
}

const VERBS: Record<ToolKind, string> = {
  read: 'Read', edit: 'Edit', execute: 'Run', search: 'Search', fetch: 'Fetch', agent: 'Agent', other: '',
}

const toolKind = (name: string): ToolKind => TOOL_KINDS[name] ?? 'other'

/** One line for a tool row: verb and target. */
export function toolTitle(name: string, input: Record<string, unknown>): string {
  const kind = toolKind(name)
  let target = ''
  for (const key of ['file_path', 'absolute_path', 'path', 'command', 'pattern', 'query', 'url', 'description', 'prompt']) {
    const value = input[key]
    if (typeof value === 'string' && value) { target = value.split('\n')[0]; break }
  }
  if (kind === 'other') return target ? `${name} ${target}` : name
  return target ? `${VERBS[kind]} ${target}` : VERBS[kind]
}

function clip(text: string): string {
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n… (cut off)` : text
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return clip(content)
  if (!Array.isArray(content)) return ''
  return clip(content.map((block: { type?: string; text?: string }) => (block.type === 'text' ? block.text ?? '' : `[${block.type ?? 'content'}]`)).join('\n'))
}

/** The user's own words: without what the cockpit added, and without Qwen Code's own reminders. */
export function userWords(text: string): string | null {
  const words = text.replace(HIDDEN_BLOCK, '')
  const trimmed = words.trim()
  if (!trimmed || trimmed.startsWith('<system-reminder>')) return null
  return words
}

interface Block {
  type: string
  id?: string
  name?: string
  input?: unknown
  text?: string
  thinking?: string
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

const inputOf = (block: Block): Record<string, unknown> =>
  block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input as Record<string, unknown> : {}

function toolCallEvent(id: string, name: string, input: Record<string, unknown>): RuntimeEvent {
  return { kind: 'tool_call', toolId: id, name, toolKind: toolKind(name), title: toolTitle(name, input), input }
}

/**
 * Maps the SDK's messages onto RuntimeEvents: Qwen Code sends Claude Code's shapes (a block's deltas
 * as stream events, then the block whole as an assistant message under the stream's message id). Of a
 * subagent, its tool calls come through; its text does not.
 */
export class QwenEventMapper {
  private messageId: string | null = null
  private open: Array<{ blockId: string; type: string; messageId: string }> = []
  private counter = 0
  private interrupted = false
  private working = false
  private conversationId: string | null = null

  noteInterrupt(): void {
    this.interrupted = true
  }

  map(message: SDKMessage): RuntimeEvent[] {
    switch (message.type) {
      case 'system': return this.system(message)
      case 'stream_event': return this.stream(message)
      case 'assistant': return this.assistant(message)
      case 'user': return this.user(message)
      case 'result': return this.result(message)
      default: return []
    }
  }

  /** The start of a turn's output: the session works from here on. */
  private busy(): RuntimeEvent[] {
    if (this.working) return []
    this.working = true
    return [{ kind: 'activity', state: 'working' }]
  }

  private system(message: Extract<SDKMessage, { type: 'system' }>): RuntimeEvent[] {
    // Every turn starts with an init; a new session id in it is a conversation started over (`/clear`).
    if (message.subtype === 'init') {
      const reset = this.conversationId !== null && this.conversationId !== message.session_id
      this.conversationId = message.session_id
      return [
        ...(reset ? [{ kind: 'conversation_reset', conversationId: message.session_id } as const] : []),
        { kind: 'settings', ...(message.model ? { model: message.model } : {}), ...(message.permission_mode ? { mode: message.permission_mode } : {}) },
      ]
    }
    if (message.subtype === 'compact_boundary') return [{ kind: 'compaction' }]
    return []
  }

  private stream(message: Extract<SDKMessage, { type: 'stream_event' }>): RuntimeEvent[] {
    if (message.parent_tool_use_id) return []
    const event = message.event as { type: string; index?: number; message?: { id?: string }; content_block?: { type?: string }; delta?: { type?: string; text?: string; thinking?: string } }
    if (event.type === 'message_start') {
      this.messageId = event.message?.id ?? `m${++this.counter}`
      return this.busy()
    }
    if (event.type === 'content_block_start') {
      const type = event.content_block?.type
      if ((type === 'text' || type === 'thinking') && this.messageId) {
        this.open.push({ blockId: `${this.messageId}:${event.index ?? this.open.length}:${++this.counter}`, type, messageId: this.messageId })
      }
      return []
    }
    if (event.type === 'content_block_delta' && this.messageId) {
      const type = event.delta?.type === 'text_delta' ? 'text' : event.delta?.type === 'thinking_delta' ? 'thinking' : null
      const block = type ? [...this.open].reverse().find((one) => one.messageId === this.messageId && one.type === type) : undefined
      if (!block) return []
      if (type === 'text' && event.delta?.text) return [{ kind: 'text_delta', blockId: block.blockId, delta: event.delta.text }]
      if (type === 'thinking' && event.delta?.thinking) return [{ kind: 'thinking_delta', blockId: block.blockId, delta: event.delta.thinking }]
    }
    return []
  }

  /**
   * The id a complete block takes: the oldest streamed block of its type in its message, else the
   * oldest of its type in the turn, else a new one (no deltas came). Qwen Code starts a new message
   * when the block type changes (thinking → text) without a `message_start` for it, so that
   * message's blocks were streamed under the id of the one before.
   */
  private claim(messageId: string, type: string): string {
    let index = this.open.findIndex((block) => block.messageId === messageId && block.type === type)
    if (index < 0) index = this.open.findIndex((block) => block.type === type)
    if (index < 0) return `${messageId}:final:${++this.counter}`
    const [block] = this.open.splice(index, 1)
    return block.blockId
  }

  private assistant(message: Extract<SDKMessage, { type: 'assistant' }>): RuntimeEvent[] {
    const content = (Array.isArray(message.message.content) ? message.message.content : []) as Block[]
    if (message.parent_tool_use_id) {
      const parentToolId = message.parent_tool_use_id
      return content.filter((block) => block.type === 'tool_use').map((block) => {
        const name = block.name ?? 'Tool'
        return { kind: 'agent_tool', parentToolId, toolId: block.id ?? '', toolKind: toolKind(name), title: toolTitle(name, inputOf(block)), status: 'running' }
      })
    }
    const events: RuntimeEvent[] = [...this.busy()]
    const messageId = message.message.id ?? message.uuid
    for (const block of content) {
      if (block.type === 'text' && block.text) events.push({ kind: 'text', blockId: this.claim(messageId, 'text'), text: block.text })
      else if (block.type === 'thinking') events.push({ kind: 'thinking', blockId: this.claim(messageId, 'thinking'), text: block.thinking ?? '' })
      else if (block.type === 'tool_use') events.push(toolCallEvent(block.id ?? '', block.name ?? 'Tool', inputOf(block)))
    }
    return events
  }

  private user(message: Extract<SDKMessage, { type: 'user' }>): RuntimeEvent[] {
    const content = message.message.content
    if (!Array.isArray(content)) return []
    const results = (content as Block[]).filter((block) => block.type === 'tool_result')
    const parentToolId = message.parent_tool_use_id
    if (parentToolId) {
      return results.map((block) => ({ kind: 'agent_tool', parentToolId, toolId: block.tool_use_id ?? '', status: block.is_error ? 'failed' : 'completed' }))
    }
    return results.map((block) => ({ kind: 'tool_result', toolId: block.tool_use_id ?? '', status: block.is_error ? 'failed' : 'completed', output: resultText(block.content) }))
  }

  private result(message: Extract<SDKMessage, { type: 'result' }>): RuntimeEvent[] {
    const interrupted = this.interrupted
    this.interrupted = false
    this.open = []
    this.working = false
    const events: RuntimeEvent[] = [{ kind: 'usage', inputTokens: message.usage?.input_tokens ?? 0, outputTokens: message.usage?.output_tokens ?? 0 }]
    if (interrupted) events.push({ kind: 'turn_end', reason: 'interrupted' })
    else if (message.subtype === 'success' && !message.is_error) events.push({ kind: 'turn_end', reason: 'success' })
    else {
      const detail = message.is_error ? message.error?.message : (message as { result?: string }).result
      events.push({ kind: 'error', message: detail || `The turn failed (${message.subtype})` })
      events.push({ kind: 'turn_end', reason: 'error' })
    }
    events.push({ kind: 'activity', state: 'idle' })
    return events
  }
}

/** A stored conversation (the chat file's records) as events. */
export function historyEvents(records: Array<Record<string, unknown>>): RuntimeEvent[] {
  const events: RuntimeEvent[] = []
  let counter = 0
  for (const record of records) {
    const parts = ((record.message as { parts?: unknown } | undefined)?.parts)
    if (!Array.isArray(parts)) continue
    const uuid = typeof record.uuid === 'string' ? record.uuid : `r${counter}`
    if (record.type === 'user') {
      const text = parts.map((part: { text?: unknown }) => (typeof part?.text === 'string' ? part.text : '')).join('')
      const words = userWords(text)
      if (words !== null) events.push({ kind: 'user_message', id: uuid, text: words, queued: false })
    } else if (record.type === 'assistant') {
      for (const part of parts as Array<{ text?: unknown; thought?: unknown; functionCall?: { id?: unknown; name?: unknown; args?: unknown } }>) {
        if (typeof part?.text === 'string' && part.text && part.thought !== true) {
          events.push({ kind: 'text', blockId: `${uuid}:${counter++}`, text: part.text })
        } else if (part?.functionCall) {
          const call = part.functionCall
          const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args as Record<string, unknown> : {}
          events.push(toolCallEvent(typeof call.id === 'string' ? call.id : '', typeof call.name === 'string' ? call.name : 'Tool', args))
        }
      }
    } else if (record.type === 'tool_result') {
      const status = (record.toolCallResult as { status?: unknown } | undefined)?.status
      for (const part of parts as Array<{ functionResponse?: { id?: unknown; response?: unknown } }>) {
        const response = part?.functionResponse
        if (!response) continue
        const body = response.response as { output?: unknown; error?: unknown } | undefined
        const output = typeof body?.output === 'string' ? body.output : typeof body?.error === 'string' ? body.error : JSON.stringify(body ?? '')
        events.push({ kind: 'tool_result', toolId: typeof response.id === 'string' ? response.id : '', status: status === 'success' || status === undefined ? 'completed' : 'failed', output: clip(output) })
      }
    }
    counter++
  }
  events.push({ kind: 'history_end' })
  return events
}

/** What the runtime needs of a CLI process; a test hands in one of its own. */
export interface QwenProcess {
  readonly pid?: number
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(event: 'error', listener: (error: Error) => void): this
}

export interface QwenSpawn {
  bin: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export type SpawnQwen = (options: QwenSpawn) => QwenProcess

const spawnQwen: SpawnQwen = ({ bin, args, cwd, env }) => spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })

/** The SDK's Transport over the cockpit's own process: exactly the session's environment, its pid, its stderr. */
export class QwenProcessTransport implements Transport {
  isReady = true
  exitError: Error | null = null
  private exited: Promise<void>
  private tail = ''

  constructor(readonly child: QwenProcess) {
    this.exited = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        this.isReady = false
        if (code) this.exitError = new Error(`Qwen Code exited with code ${code}`)
        else if (signal && signal !== 'SIGTERM') this.exitError = new Error(`Qwen Code ended by ${signal}`)
        resolve()
      })
      child.once('error', (error) => {
        this.isReady = false
        this.exitError = error
        resolve()
      })
    })
    child.stderr?.on('data', (chunk: Buffer) => { this.tail = (this.tail + chunk.toString()).slice(-STDERR_TAIL) })
  }

  /** The last line Qwen Code wrote to stderr, for an error worth showing. */
  stderrLine(): string {
    return this.tail.trim().split('\n').pop() ?? ''
  }

  write(message: string): void {
    if (!this.isReady || !this.child.stdin || this.child.stdin.writableEnded) throw new Error('Qwen Code is not running.')
    this.child.stdin.write(message)
  }

  endInput(): void {
    this.child.stdin?.end()
  }

  async close(): Promise<void> {
    this.child.stdin?.end()
    if (this.isReady) this.child.kill('SIGTERM')
  }

  waitForExit(): Promise<void> {
    return this.exited
  }

  async *readMessages(): AsyncGenerator<unknown, void, unknown> {
    if (!this.child.stdout) return
    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.trim()) continue
      try { yield JSON.parse(line) as unknown } catch { /* a line that is not the protocol's: Qwen Code's own output */ }
    }
  }
}

/** Input for one streaming query: messages wait here until the CLI takes them. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private ended = false

  push(item: SDKUserMessage): void {
    this.items.push(item)
    this.wake?.()
    this.wake = null
  }

  end(): void {
    this.ended = true
    this.wake?.()
    this.wake = null
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      while (this.items.length > 0) yield this.items.shift() as SDKUserMessage
      if (this.ended) return
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }
}

function questionsOf(input: Record<string, unknown>): Question[] {
  const raw = Array.isArray(input.questions) ? input.questions as Array<Record<string, unknown>> : []
  return raw.map((q) => ({
    question: String(q.question ?? ''),
    header: String(q.header ?? ''),
    multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options as Array<Record<string, unknown>> : [])
      .map((option) => ({ label: String(option.label ?? ''), description: String(option.description ?? '') })),
  }))
}

/**
 * The chosen labels as Qwen Code reads them: keyed by the question's index ("0", "1", …), where the
 * chat keys them by the question's text (ask_user_question, parseAnswerQuestionIndex in Qwen Code 0.28).
 */
export function answersByIndex(input: Record<string, unknown>, byText: Record<string, string>): Record<string, string> {
  const answers: Record<string, string> = {}
  questionsOf(input).forEach((question, index) => {
    const answer = byText[question.question]
    if (typeof answer === 'string') answers[String(index)] = answer
  })
  return answers
}

const isMode = (value: unknown): value is PermissionMode => MODES.some((mode) => mode.id === value)

/** The mode a run starts in: the session's own choice, else what terminal sessions start in (Settings › Models › Qwen Code). */
export function startingMode(chosen: string | null, setting: QwenPermissionMode): PermissionMode {
  return isMode(chosen) ? chosen : MODE_OF_SETTING[setting]
}

/** What the runtime reads from the provider around it (index.ts). */
export interface QwenChatHost {
  /** Arguments that put the CLI in a sandbox for `mode`; empty where the cockpit runs it without one (Linux). */
  sandboxArgs?: (mode: PermissionMode, space: SessionRuntimeStart['space']) => string[]
  /** The model the user set for Qwen Code (Settings › Models), listed when the endpoint lists none. */
  configuredModel?: () => string
}

/** The CLI's arguments for a session in the chat. */
export function cliArgs(request: Pick<SessionRuntimeStart, 'sessionId' | 'resume' | 'conversationId' | 'model'>, mode: PermissionMode, sandbox: string[]): string[] {
  return [
    qwenRuntime.bin,
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--channel=SDK',
    '--include-partial-messages',
    '--approval-mode', mode,
    ...sandbox,
    ...(request.model ? ['--model', request.model] : []),
    ...(request.resume ? ['--resume', request.conversationId ?? request.sessionId] : ['--session-id', request.sessionId]),
  ]
}

interface OpenRequest {
  resolve: (result: PermissionResult) => void
  input: Record<string, unknown>
}

class QwenChatRuntime implements SessionRuntime {
  private input = new InputQueue()
  private mapper = new QwenEventMapper()
  private requests = new Map<string, OpenRequest>()
  private query: Query | null = null
  private transport: QwenProcessTransport | null = null
  private mode: PermissionMode
  // Started in `yolo` where the other modes need a sandbox (macOS): only a new process gets one.
  private unsandboxed: boolean
  private models: ModelOption[] = []
  // The servers and tools the latest system/init named: Qwen Code's status call knows only the SDK's own servers.
  private init: { servers: unknown; tools: unknown } | null = null
  private requestCounter = 0
  // A turn runs: an interrupt has something to stop.
  private turns = 0
  private closing = false
  private exitReported = false

  constructor(private request: SessionRuntimeStart, spawnProcess: SpawnQwen, private host: QwenChatHost) {
    this.mode = startingMode(request.mode, readQwenSettings().permissionMode)
    const sandbox = host.sandboxArgs?.(this.mode, request.space) ?? []
    this.unsandboxed = sandbox.length === 0 && (host.sandboxArgs?.('auto', request.space).length ?? 0) > 0
    try {
      const child = spawnProcess({ bin: process.execPath, args: cliArgs(request, this.mode, sandbox), cwd: request.cwd, env: request.env })
      this.transport = new QwenProcessTransport(child)
      // At once, before the CLI starts its MCP servers: they and every tool inherit the group.
      if (child.pid !== undefined) request.onSpawn?.(child.pid)
      this.query = new Query(this.transport, {
        sessionId: request.resume ? request.conversationId ?? request.sessionId : request.sessionId,
        timeout: { canUseTool: PERMISSION_TIMEOUT_MS },
        canUseTool: (toolName, input, options) => this.canUseTool(toolName, input, options),
      }, false)
    } catch (error) {
      this.emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      this.reportExit(false)
      return
    }
    this.query.streamInput(this.input).catch(() => { /* the process ended: pump says how */ })
    void this.pump()
    void this.announce()
  }

  private emit(event: RuntimeEvent): void {
    this.request.onEvent(event)
  }

  private reportExit(expected: boolean): void {
    if (this.exitReported) return
    this.exitReported = true
    this.emit({ kind: 'runtime_exit', expected })
  }

  /** What the session offers, once the CLI has answered the SDK's initialize. */
  private async announce(): Promise<void> {
    const query = this.query
    if (!query) return
    try {
      await query.initialized
    } catch {
      // The process did not come up: pump reports it.
      return
    }
    if (this.closing || this.exitReported) return
    const listed = await query.getAvailableModels().catch(() => null)
    this.models = modelsOf(listed, this.host.configuredModel?.() ?? '')
    this.emit({ kind: 'capabilities', modes: MODES, models: this.models, features: FEATURES })
    this.emit({ kind: 'settings', mode: this.mode, ...(this.request.model ? { model: this.request.model } : {}) })
    await this.refreshContext()
  }

  private async refreshContext(): Promise<void> {
    if (this.closing || !this.query) return
    const usage = await this.query.getContextUsage().catch(() => null) as { totalTokens?: unknown; contextWindowSize?: unknown } | null
    if (typeof usage?.totalTokens === 'number' && typeof usage.contextWindowSize === 'number') {
      this.emit({ kind: 'context', usedTokens: usage.totalTokens, maxTokens: usage.contextWindowSize })
    }
  }

  private async pump(): Promise<void> {
    const query = this.query
    if (!query) return
    try {
      for await (const message of query) {
        if (message.type === 'result') {
          this.turns = Math.max(0, this.turns - 1)
          await this.turnEnded(message)
          continue
        }
        if (message.type === 'system' && message.subtype === 'init') this.init = { servers: message.mcp_servers, tools: message.tools }
        for (const event of this.mapper.map(message)) this.emit(event)
      }
    } catch (error) {
      if (!this.closing) {
        const detail = this.transport?.stderrLine()
        this.emit({ kind: 'error', message: detail || (error instanceof Error ? error.message : String(error)) })
      }
    }
    if (!this.closing && !this.exitReported) {
      const detail = this.transport?.exitError ? this.transport.stderrLine() : ''
      if (detail) this.emit({ kind: 'error', message: detail })
    }
    this.cancelOpenRequests()
    this.reportExit(this.closing)
  }

  /**
   * A turn is over. Before a successful one counts as the session's stop, the bridge may send it back
   * (onTurnEnding): that text goes in as the next message, unseen, and this end is not said, as a Stop
   * hook that blocks leaves no end either.
   */
  private async turnEnded(message: Extract<SDKMessage, { type: 'result' }>): Promise<void> {
    const events = this.mapper.map(message)
    const end = events.find((event) => event.kind === 'turn_end')
    const worker = this.request.worker
    const back = end?.kind === 'turn_end' && end.reason === 'success' && worker && !this.closing
      ? await Promise.resolve().then(() => worker.onTurnEnding()).catch(() => null)
      : null
    if (back && !this.closing && !this.exitReported) {
      for (const event of events) if (event !== end && event.kind !== 'activity') this.emit(event)
      this.push(hidden(back))
    } else {
      for (const event of events) this.emit(event)
    }
    void this.refreshContext()
  }

  private cancelOpenRequests(): void {
    for (const [requestId, open] of this.requests) {
      this.requests.delete(requestId)
      open.resolve({ behavior: 'deny', message: 'The session closed before this was answered.' })
      this.emit({ kind: 'request_settled', requestId, outcome: 'cancelled' })
    }
  }

  // No timeout of the cockpit's: a card may wait until the user comes back.
  private canUseTool: CanUseTool = (toolName, input, options) => new Promise((resolve) => {
    const requestId = `req-${++this.requestCounter}`
    this.requests.set(requestId, { resolve, input })
    options.signal.addEventListener('abort', () => {
      if (!this.requests.delete(requestId)) return
      resolve({ behavior: 'deny', message: 'Cancelled.' })
      this.emit({ kind: 'request_settled', requestId, outcome: 'cancelled' })
    }, { once: true })
    if (toolName === 'ask_user_question') {
      this.emit({ kind: 'question', requestId, questions: questionsOf(input) })
      return
    }
    this.emit({
      kind: 'permission_request',
      requestId,
      // The SDK passes the call's id on to nobody.
      toolId: null,
      toolName,
      title: toolTitle(toolName, input),
      input,
      reason: null,
      // Qwen Code keeps an "always" in its settings files, where a later session would load it: not offered.
      alwaysScope: null,
    })
  })

  private push(text: string, id?: string, images: ImageInput[] = []): void {
    const content = images.length === 0 ? text : [
      ...images.map(({ mediaType, data }) => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data } })),
      ...(text.trim() ? [{ type: 'text', text }] : []),
    ]
    this.turns++
    this.input.push({
      type: 'user',
      ...(id ? { uuid: id } : {}),
      session_id: this.request.sessionId,
      message: { role: 'user', content: content as SDKUserMessage['message']['content'] },
      parent_tool_use_id: null,
    })
  }

  send(id: string, text: string, images: ImageInput[] = []): void {
    // What the cockpit adds to a prompt, unseen in the chat: before the user's words.
    const added = this.request.worker?.onPrompt?.() ?? null
    this.push(added ? `${hidden(added)}\n\n${text}` : text, id, images)
  }

  async interrupt(): Promise<void> {
    if (!this.query || this.turns === 0) return
    this.mapper.noteInterrupt()
    await this.query.interrupt()
  }

  answerPermission(requestId: string, answer: PermissionAnswer): void {
    const open = this.requests.get(requestId)
    if (!open) return
    this.requests.delete(requestId)
    if (answer.decision === 'deny') {
      open.resolve({ behavior: 'deny', message: answer.message ?? 'The user declined this.', ...(answer.interrupt ? { interrupt: true } : {}) })
      this.emit({ kind: 'request_settled', requestId, outcome: 'denied' })
    } else if (answer.decision === 'answer') {
      open.resolve({ behavior: 'allow', updatedInput: { ...open.input, answers: answersByIndex(open.input, answer.answers) } })
      this.emit({ kind: 'request_settled', requestId, outcome: 'answered' })
    } else {
      // "Always" is not offered (alwaysScope null): one that comes anyway allows this call.
      open.resolve({ behavior: 'allow', updatedInput: open.input })
      this.emit({ kind: 'request_settled', requestId, outcome: answer.decision === 'always' ? 'always' : 'allowed' })
    }
  }

  async setMode(mode: string): Promise<void> {
    if (!isMode(mode)) throw new Error(`Qwen Code has no mode "${mode}".`)
    if (mode !== 'yolo' && this.unsandboxed) throw new Error('This session runs without a sandbox. Close it and open it again to run it in this mode.')
    if (!this.query) throw new Error('This session is not running.')
    await this.query.setPermissionMode(mode)
    this.mode = mode
    this.emit({ kind: 'settings', mode })
  }

  async setModel(model: string): Promise<void> {
    if (!this.query) throw new Error('This session is not running.')
    await this.query.setModel(model)
    this.emit({ kind: 'settings', model })
    await this.refreshContext()
  }

  async setEffort(): Promise<void> {
    throw new Error('Qwen Code sessions in the chat take no reasoning effort.')
  }

  async stopAgent(): Promise<void> {
    throw new Error('A Qwen Code subagent cannot be stopped on its own; stop the turn instead.')
  }

  /** As the latest turn's init named them; before the first turn none are known. */
  async toolServers(): Promise<ToolServer[]> {
    return toolServersOf(this.init?.servers, this.init?.tools)
  }

  async setToolServerEnabled(): Promise<void> {
    throw new Error('Qwen Code sessions take their tool servers from the cockpit\'s settings; they cannot be switched on or off from the chat.')
  }

  async reconnectToolServer(): Promise<void> {
    throw new Error('Qwen Code cannot connect a tool server again from the chat. Close the session and open it again.')
  }

  async signInToolServer(): Promise<ToolServerSignIn | null> {
    throw new Error('Qwen Code cannot sign in to a tool server from the chat.')
  }

  async finishToolServerSignIn(): Promise<void> {
    throw new Error('Qwen Code cannot sign in to a tool server from the chat.')
  }

  async close(): Promise<void> {
    if (this.closing) {
      await this.transport?.waitForExit()
      return
    }
    this.closing = true
    this.input.end()
    this.cancelOpenRequests()
    if (!this.query || !this.transport) return this.reportExit(true)
    const transport = this.transport
    await this.query.close().catch(() => {})
    const timer = setTimeout(() => { try { transport.child.kill('SIGKILL') } catch { /* gone */ } }, EXIT_TIMEOUT_MS)
    await transport.waitForExit()
    clearTimeout(timer)
    // pump says it once the stream ends; this is for one that ended before.
    this.reportExit(true)
  }
}

/** The models the endpoint lists, else the one set in the settings. */
export function modelsOf(listed: unknown, configured: string): ModelOption[] {
  const raw = (listed as { models?: unknown } | null)?.models
  const models: ModelOption[] = (Array.isArray(raw) ? raw : []).flatMap((model: unknown) => {
    const id = typeof model === 'string' ? model : (model as { id?: unknown; name?: unknown } | null)?.id ?? (model as { name?: unknown } | null)?.name
    if (typeof id !== 'string' || !id) return []
    const label = (model as { label?: unknown; displayName?: unknown } | null)
    return [{ id, label: typeof label?.label === 'string' ? label.label : typeof label?.displayName === 'string' ? label.displayName : id, description: '', resolved: id }]
  })
  if (configured && !models.some((model) => model.id === configured)) models.unshift({ id: configured, label: configured, description: 'Set in Settings › Models › Qwen Code', resolved: configured })
  return models
}

/**
 * Qwen Code's server status ({name: status} or init's [{name, status}]) as the panel shows it: no address, no
 * credentials. A server's tools are counted from init's tool names (mcp__<server>__<tool>).
 */
export function toolServersOf(status: unknown, tools?: unknown): ToolServer[] {
  const names = Array.isArray(tools) ? tools.filter((tool): tool is string => typeof tool === 'string') : []
  const entries: Array<[string, unknown]> = Array.isArray(status)
    ? status.flatMap((one: { name?: unknown; status?: unknown }) => (typeof one?.name === 'string' ? [[one.name, one.status] as [string, unknown]] : []))
    : status && typeof status === 'object' ? Object.entries(status as Record<string, unknown>) : []
  return entries.map(([name, value]) => {
    const state = typeof value === 'string' ? value : (value as { status?: unknown } | null)?.status
    const mapped: ToolServer['status'] = state === 'connected' ? 'connected' : state === 'disconnected' || state === 'failed' ? 'failed' : 'pending'
    return { name, status: mapped, error: null, scope: null, transport: null, toolCount: names.filter((tool) => tool.startsWith(`mcp__${name}__`)).length }
  })
}

export function createQwenChatRuntimes(spawnProcess: SpawnQwen = spawnQwen, host: QwenChatHost = {}, qwenHome?: string): SessionRuntimeFactory {
  return {
    workerMode: WORKER_MODE,
    // The runtime knows when a turn starts and ends; the hooks' turn signals are left out for it.
    reportsTurns: true,
    start: (request) => new QwenChatRuntime(request, spawnProcess, host),
    // Every Qwen Code session keeps its conversation in the one Qwen home (index.ts launch).
    async history({ providerSessionId, sessionId }: SessionRef) {
      const file = findChat(providerSessionId ?? sessionId, qwenHome)
      if (!file || !fs.existsSync(file)) return [{ kind: 'history_end' }]
      return historyEvents(readChatRecords(file))
    },
  }
}
