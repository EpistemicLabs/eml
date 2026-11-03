import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { createSdkMcpServer, query, getSessionMessages, tool, type CanUseTool, type PermissionMode, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage, type SessionMessage, type SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import { CONFIG_DIR } from '../../../paths.js'
import type {
  ImageInput, CommandInfo, ModeOption, PermissionAnswer, Question, RuntimeEvent, SessionRuntime, SessionRuntimeFactory, SessionRuntimeStart, ToolKind, ToolServer,
} from '../../../domain/session-runtime.js'
import { readPermissionMode } from './login.js'
import { CLAUDE_BIN } from './runtime.js'
import { WORKER_STATUSES } from '../../../domain/session-attention.js'

/**
 * Claude Code through the Agent SDK as a SessionRuntime: the same binary, config
 * dir, hooks and brain MCP as a terminal session, and the same transcript. The
 * only file that imports the SDK.
 */

// close() lets the CLI finish on stdin EOF (about 2 s), then ends it; this is the
// bound for a process that ignores all of that.
const EXIT_TIMEOUT_MS = 8_000
const MAX_TOOL_OUTPUT = 20_000
const STDERR_TAIL = 2_000

const TOOL_KINDS: Record<string, ToolKind> = {
  Read: 'read', NotebookRead: 'read',
  Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Bash: 'execute', BashOutput: 'execute', KillShell: 'execute',
  Grep: 'search', Glob: 'search', LS: 'search', ToolSearch: 'search',
  WebFetch: 'fetch', WebSearch: 'fetch',
  Task: 'agent', Agent: 'agent',
}

const MODES: ModeOption[] = [
  { id: 'default', label: 'Ask first', description: 'Asks before edits and commands' },
  { id: 'acceptEdits', label: 'Accept edits', description: 'Edits go through, commands still ask' },
  { id: 'plan', label: 'Plan', description: 'Reads and plans, changes nothing' },
  { id: 'auto', label: 'Auto', description: 'A classifier approves or stops each action' },
]

/**
 * The terminal follows Chrome's "Enabled by default" setting; an SDK session ignores
 * it and needs the flag. An agent keeps to its MCP allowlist, so it gets no browser
 * unless its record gives it one.
 */
function chromeForChat(request: SessionRuntimeStart): boolean {
  if (request.strictMcp) return request.chrome === true
  try {
    const configDir = request.env.CLAUDE_CONFIG_DIR ?? CONFIG_DIR
    const config = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8')) as { claudeInChromeDefaultEnabled?: unknown }
    return config.claudeInChromeDefaultEnabled === true
  } catch {
    return false
  }
}

// A subagent's own bookkeeping, nothing it did.
const HIDDEN_AGENT_TOOLS = new Set(['SubagentHandback'])

// The text the CLI writes as the assistant when a turn has nothing to say.
const NO_RESPONSE = 'No response requested.'

const VERBS: Record<ToolKind, string> = {
  read: 'Read', edit: 'Edit', execute: 'Run', search: 'Search', fetch: 'Fetch', agent: 'Agent', other: '',
}

function stringField(input: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value) return value
  }
  return null
}

function toolKind(name: string): ToolKind {
  return TOOL_KINDS[name] ?? 'other'
}

/** One line for a tool row: verb and target. */
export function toolTitle(name: string, input: Record<string, unknown>): string {
  const kind = toolKind(name)
  const target = stringField(input, 'file_path', 'notebook_path', 'command', 'pattern', 'query', 'url', 'description', 'path')
  const firstLine = target?.split('\n')[0] ?? ''
  if (kind === 'other') return firstLine ? `${name} ${firstLine}` : name
  return firstLine ? `${VERBS[kind]} ${firstLine}` : VERBS[kind]
}

function resultText(content: unknown): string {
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content.map((block: { type?: string; text?: string }) => (block.type === 'text' ? block.text ?? '' : `[${block.type ?? 'content'}]`)).join('\n')
  }
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n… (cut off)` : text
}

/** The user's own words in a stored message; null for what the CLI itself wrote into the user role. */
function userWords(content: unknown): string | null {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((block: { type?: string }) => block.type === 'text').map((block: { text?: string }) => block.text ?? '').join('\n')
      : ''
  const trimmed = text.trim()
  if (!trimmed || /^(<(command-|local-command|system-reminder|task-notification)|\[Request interrupted)/.test(trimmed)) return null
  return text
}

/**
 * What the CLI itself wrote as the assistant and nobody should read: its placeholder
 * for an empty turn. A local command's answer (`/context`) comes the same way and stays.
 */
function isPlaceholder(message: unknown): boolean {
  const { model, content } = (message ?? {}) as { model?: string; content?: unknown }
  if (model !== '<synthetic>') return false
  return Array.isArray(content) && content.every((block: { text?: string }) => block.text === NO_RESPONSE)
}

function transportOf(type: string | undefined): ToolServer['transport'] {
  if (!type) return null
  return type === 'stdio' || type === 'sdk' ? 'process' : 'web'
}

interface ContentBlock {
  type: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  text?: string
  thinking?: string
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

function toolResultEvent(block: ContentBlock, toolUseResult: unknown): RuntimeEvent {
  const result = toolUseResult as { status?: string; handbackReport?: { text?: string } } | null | undefined
  const launched = result?.status === 'async_launched'
  return {
    kind: 'tool_result',
    toolId: block.tool_use_id ?? '',
    status: block.is_error ? 'failed' : launched ? 'launched' : 'completed',
    // A subagent's report: the result block only says it was delivered.
    output: result?.handbackReport?.text ?? resultText(block.content),
  }
}

function toolCallEvent(block: ContentBlock): RuntimeEvent {
  const name = block.name ?? 'Tool'
  const input = block.input ?? {}
  return { kind: 'tool_call', toolId: block.id ?? '', name, toolKind: toolKind(name), title: toolTitle(name, input), input }
}

/**
 * Maps the SDK's stream onto RuntimeEvents. A message arrives once per block with
 * a shared id, after its deltas: the complete block takes over the id its deltas
 * ran under. Of a subagent, its task state and tool calls come through; its text does not.
 */
export class ClaudeEventMapper {
  private messageId: string | null = null
  private open: Array<{ blockId: string; type: string; messageId: string }> = []
  private blockCounter = 0
  private sawSessionState = false
  private interrupted = false
  private agentTasks = new Set<string>()
  // Every shell task; only one running in the background is shown (`shown`).
  private shellTasks = new Map<string, { toolId: string | null; description: string; shown: boolean }>()
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

  private system(message: Extract<SDKMessage, { type: 'system' }>): RuntimeEvent[] {
    if (message.subtype === 'init') {
      // `/clear` goes on under a new session id, and only init names it: the
      // conversation_reset message's new_conversation_id is not the transcript's.
      const reset = this.conversationId !== null && this.conversationId !== message.session_id
      this.conversationId = message.session_id
      return [
        ...(reset ? [{ kind: 'conversation_reset', conversationId: message.session_id } as const] : []),
        { kind: 'settings', model: message.model ?? null, mode: message.permissionMode },
      ]
    }
    if (message.subtype === 'status' && message.permissionMode) return [{ kind: 'settings', mode: message.permissionMode }]
    if (message.subtype === 'task_started' && message.task_type === 'local_bash') {
      const shell = { toolId: message.tool_use_id ?? null, description: message.description, shown: message.is_backgrounded === true }
      this.shellTasks.set(message.task_id, shell)
      return shell.shown ? [{ kind: 'shell_task', taskId: message.task_id, toolId: shell.toolId, description: shell.description, status: 'running' }] : []
    }
    const shell = 'task_id' in message ? this.shellTasks.get(message.task_id as string) : undefined
    if (shell && (message.subtype === 'task_updated' || message.subtype === 'task_notification')) {
      const status = message.subtype === 'task_notification' ? message.status : message.patch.status
      const ended = status === 'completed' || status === 'failed' ? status : status === 'killed' || status === 'stopped' ? 'stopped' : undefined
      const start = !shell.shown && message.subtype === 'task_updated' && message.patch.is_backgrounded === true
      if (start) shell.shown = true
      if (ended) this.shellTasks.delete(message.task_id)
      if (!shell.shown) return []
      if (start) return [{ kind: 'shell_task', taskId: message.task_id, toolId: shell.toolId, description: shell.description, status: ended ?? 'running' }]
      return ended ? [{ kind: 'shell_task', taskId: message.task_id, status: ended }] : []
    }
    if (message.subtype === 'task_started') {
      if (message.task_type !== 'local_agent' || message.skip_transcript || message.ambient) return []
      this.agentTasks.add(message.task_id)
      return [{
        kind: 'agent_task', taskId: message.task_id, toolId: message.tool_use_id ?? null, description: message.description,
        agentType: message.subagent_type ?? null, status: 'running', background: message.is_backgrounded === true,
      }]
    }
    if (message.subtype === 'task_progress') {
      if (!this.agentTasks.has(message.task_id)) return []
      return [{
        kind: 'agent_task', taskId: message.task_id, activity: message.summary ?? message.description,
        tokens: message.usage.total_tokens, toolUses: message.usage.tool_uses, durationMs: message.usage.duration_ms,
      }]
    }
    if (message.subtype === 'task_updated') {
      if (!this.agentTasks.has(message.task_id)) return []
      const { status, is_backgrounded: background } = message.patch
      const ended = status === 'completed' || status === 'failed' ? status : status === 'killed' ? 'stopped' : undefined
      if (!ended && background === undefined) return []
      return [{ kind: 'agent_task', taskId: message.task_id, ...(ended ? { status: ended } : {}), ...(background !== undefined ? { background } : {}) }]
    }
    if (message.subtype === 'task_notification') {
      if (!this.agentTasks.has(message.task_id)) return []
      return [{
        kind: 'agent_task', taskId: message.task_id, status: message.status,
        ...(message.usage ? { tokens: message.usage.total_tokens, toolUses: message.usage.tool_uses, durationMs: message.usage.duration_ms } : {}),
      }]
    }
    if (message.subtype === 'compact_boundary') return [{ kind: 'compaction' }]
    if (message.subtype === 'session_state_changed') {
      this.sawSessionState = true
      const state = message.state === 'idle' ? 'idle' : message.state === 'requires_action' ? 'waiting' : 'working'
      return [{ kind: 'activity', state }]
    }
    return []
  }

  private stream(message: Extract<SDKMessage, { type: 'stream_event' }>): RuntimeEvent[] {
    if (message.parent_tool_use_id) return []
    const event = message.event as {
      type: string
      index?: number
      message?: { id?: string }
      content_block?: { type?: string }
      delta?: { type?: string; text?: string; thinking?: string }
    }
    if (event.type === 'message_start') {
      this.messageId = event.message?.id ?? `m${++this.blockCounter}`
      return []
    }
    if (event.type === 'content_block_start') {
      const type = event.content_block?.type
      if ((type === 'text' || type === 'thinking') && this.messageId) {
        this.open.push({ blockId: `${this.messageId}:${event.index ?? this.open.length}`, type, messageId: this.messageId })
      }
      return []
    }
    if (event.type === 'content_block_delta' && this.messageId) {
      const blockId = `${this.messageId}:${event.index ?? 0}`
      if (event.delta?.type === 'text_delta' && event.delta.text) return [{ kind: 'text_delta', blockId, delta: event.delta.text }]
      if (event.delta?.type === 'thinking_delta' && event.delta.thinking) return [{ kind: 'thinking_delta', blockId, delta: event.delta.thinking }]
    }
    return []
  }

  /** The id a complete block takes: the oldest streamed block of its type, else a new one (no deltas came). */
  private claim(messageId: string, type: string): string {
    const index = this.open.findIndex((block) => block.messageId === messageId && block.type === type)
    if (index < 0) return `${messageId}:final:${++this.blockCounter}`
    const [block] = this.open.splice(index, 1)
    return block.blockId
  }

  private assistant(message: Extract<SDKMessage, { type: 'assistant' }>): RuntimeEvent[] {
    if (message.parent_tool_use_id) return this.agentCalls(message.parent_tool_use_id, message.message.content as ContentBlock[])
    if (isPlaceholder(message.message)) return []
    const events: RuntimeEvent[] = []
    const messageId = (message.message as { id?: string }).id ?? message.uuid
    for (const block of message.message.content as ContentBlock[]) {
      if (block.type === 'text' && block.text) events.push({ kind: 'text', blockId: this.claim(messageId, 'text'), text: block.text })
      else if (block.type === 'thinking') events.push({ kind: 'thinking', blockId: this.claim(messageId, 'thinking'), text: block.thinking ?? '' })
      else if (block.type === 'tool_use') events.push(toolCallEvent(block))
    }
    // Without session-state messages this is how a queued message's turn shows up.
    if (!this.sawSessionState) events.unshift({ kind: 'activity', state: 'working' })
    if (message.error) events.push({ kind: 'error', message: `The model call failed: ${message.error}` })
    return events
  }

  private agentCalls(parentToolId: string, content: ContentBlock[]): RuntimeEvent[] {
    return content
      .filter((block) => block.type === 'tool_use' && !HIDDEN_AGENT_TOOLS.has(block.name ?? ''))
      .map((block) => {
        const name = block.name ?? 'Tool'
        return { kind: 'agent_tool', parentToolId, toolId: block.id ?? '', toolKind: toolKind(name), title: toolTitle(name, block.input ?? {}), status: 'running' }
      })
  }

  private user(message: Extract<SDKMessage, { type: 'user' }>): RuntimeEvent[] {
    const content = message.message.content
    if (!Array.isArray(content)) return []
    const parentToolId = message.parent_tool_use_id
    if (parentToolId) {
      return (content as ContentBlock[])
        .filter((block) => block.type === 'tool_result')
        .map((block) => ({ kind: 'agent_tool', parentToolId, toolId: block.tool_use_id ?? '', status: block.is_error ? 'failed' : 'completed' }))
    }
    return (content as ContentBlock[])
      .filter((block) => block.type === 'tool_result')
      .map((block) => toolResultEvent(block, message.tool_use_result))
  }

  private result(message: Extract<SDKMessage, { type: 'result' }>): RuntimeEvent[] {
    const interrupted = this.interrupted
    this.interrupted = false
    this.open = []
    const events: RuntimeEvent[] = [
      { kind: 'usage', inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
    ]
    if (interrupted) events.push({ kind: 'turn_end', reason: 'interrupted' })
    else if (message.subtype === 'success' && !message.is_error) events.push({ kind: 'turn_end', reason: 'success' })
    else {
      const detail = message.subtype === 'success' ? message.result : message.errors?.join('; ')
      events.push({ kind: 'error', message: detail || `The turn failed (${message.subtype})` })
      events.push({ kind: 'turn_end', reason: 'error' })
    }
    if (!this.sawSessionState) events.push({ kind: 'activity', state: 'idle' })
    return events
  }
}

/** A stored conversation as events. Rendered from this alone, never merged with live data. */
export function historyEvents(messages: Array<Pick<SessionMessage, 'type' | 'uuid' | 'message' | 'parent_tool_use_id'>>): RuntimeEvent[] {
  const events: RuntimeEvent[] = []
  let counter = 0
  for (const stored of messages) {
    if (stored.parent_tool_use_id) continue
    const content = (stored.message as { content?: unknown } | null)?.content
    if (stored.type === 'user') {
      const words = userWords(content)
      const images = Array.isArray(content) ? (content as ContentBlock[]).filter((block) => block.type === 'image').map(() => ({ url: null })) : []
      if (words !== null || images.length > 0) {
        events.push({ kind: 'user_message', id: stored.uuid, text: words ?? '', queued: false, ...(images.length > 0 ? { images } : {}) })
      }
      if (Array.isArray(content)) {
        for (const block of content as ContentBlock[]) {
          if (block.type === 'tool_result') events.push(toolResultEvent(block, null))
        }
      }
    } else if (stored.type === 'assistant' && Array.isArray(content) && !isPlaceholder(stored.message)) {
      for (const block of content as ContentBlock[]) {
        if (block.type === 'text' && block.text) events.push({ kind: 'text', blockId: `${stored.uuid}:${counter++}`, text: block.text })
        else if (block.type === 'tool_use') events.push(toolCallEvent(block))
      }
    }
  }
  events.push({ kind: 'history_end' })
  return events
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

interface OpenRequest {
  resolve: (result: PermissionResult) => void
  input: Record<string, unknown>
  suggestions: Parameters<CanUseTool>[2]['suggestions']
}

/** The mode a run starts in: the session's own choice, else what terminal sessions start in (Settings › Models). */
export function startingMode(chosen: string | null, setting: string): string {
  return chosen ?? setting
}

const STATUS_TOOL = 'session_status'
const STATUS_TOOL_DESCRIPTION = 'Say how you stand at the end of your turn, whenever someone has to act; this is how people learn you need them. '
  + 'Call it first, then write your closing reply: the person reads that reply, never this call or your thinking. '
  + 'done: finished, nobody needs to act. question: only a person can decide. '
  + 'review: finished, and someone should look at the result. failed: you could not do it. '
  + 'Reason: one line that stands alone, because it is what the person reads in the list: the result, the question, or what went wrong.'

// The result is what the model reads next: it asks for the closing summary right there.
const NEXT_STEP: Record<string, string> = {
  done: 'Now write your closing summary as visible text: what was asked, what you did, what changed (files, links).',
  question: 'Now write your closing summary as visible text: what was asked, what you did, then the questions as a numbered list.',
  review: 'Now write your closing summary as visible text: what was asked, what you did, what changed, then what to check.',
  failed: 'Now write your closing summary as visible text: what was asked, what you tried, what went wrong.',
}

/** The status tool and the check before a worker's turn ends, in this process: no extra server per worker. */
function workerOptions(worker: NonNullable<SessionRuntimeStart['worker']>) {
  const server = createSdkMcpServer({
    name: 'cockpit',
    tools: [tool(STATUS_TOOL, STATUS_TOOL_DESCRIPTION, { status: z.enum(WORKER_STATUSES), reason: z.string().optional() }, async ({ status, reason }) => {
      worker.report(status, reason ?? null)
      return { content: [{ type: 'text', text: `Recorded: ${status}. ${NEXT_STEP[status] ?? ''}`.trim() }] }
      // In the tool list from the start: a worker that has to search for it only finds it once it is sent back.
    }, { alwaysLoad: true })],
  })
  return {
    mcpServers: { cockpit: server },
    // Nobody may be there to answer a card about the tool that says so.
    allowedTools: [`mcp__cockpit__${STATUS_TOOL}`],
    hooks: {
      UserPromptSubmit: [{
        hooks: [async () => {
          const additionalContext = worker.onPrompt?.()
          return additionalContext ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit' as const, additionalContext } } : {}
        }],
      }],
      Stop: [{
        hooks: [async () => {
          const reason = worker.onTurnEnding()
          return reason ? { decision: 'block' as const, reason } : {}
        }],
      }],
    },
  }
}

class ClaudeSdkRuntime implements SessionRuntime {
  private input = new InputQueue()
  private mapper = new ClaudeEventMapper()
  private requests = new Map<string, OpenRequest>()
  private query: Query
  private child: ChildProcess | null = null
  private exited: Promise<void>
  private markExited: () => void = () => {}
  private closing = false
  private exitReported = false
  private requestCounter = 0
  private stderrTail = ''
  private commands: SlashCommand[] = []
  private terminalCommands = new Set<string>()
  private models: Array<{ value: string; resolvedModel?: string }> = []

  constructor(private request: SessionRuntimeStart) {
    this.exited = new Promise((resolve) => { this.markExited = resolve })
    this.query = query({
      prompt: this.input,
      options: {
        cwd: request.cwd,
        // Artifact is off by default in the SDK. A value already set wins, so 0 turns it off.
        env: { CLAUDE_CODE_ARTIFACT: '1', ...request.env },
        pathToClaudeCodeExecutable: CLAUDE_BIN,
        // Always named: left out, the CLI picks one itself.
        permissionMode: startingMode(request.mode, readPermissionMode()) as PermissionMode,
        ...(request.model ? { model: request.model } : {}),
        agentProgressSummaries: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        includePartialMessages: true,
        settings: request.files.settings,
        // Paths, not the servers themselves: the brain token stays in the file.
        extraArgs: {
          'mcp-config': request.files.mcpConfig,
          // A flag without a value.
          ...(request.strictMcp ? { 'strict-mcp-config': null } : {}),
          ...(chromeForChat(request) ? { chrome: null } : {}),
          name: request.address,
        },
        ...(request.resume ? { resume: request.conversationId ?? request.sessionId } : { sessionId: request.sessionId }),
        canUseTool: (toolName, input, options) => this.canUseTool(toolName, input, options),
        ...(request.worker ? workerOptions(request.worker) : {}),
        ...(request.deniedTools?.length ? { disallowedTools: request.deniedTools } : {}),
        // Our own spawn: the only way to know when the process has really exited.
        spawnClaudeCodeProcess: (options) => {
          const child = spawn(options.command, options.args, {
            cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'],
          })
          this.child = child
          child.stderr?.on('data', (chunk: Buffer) => { this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL) })
          child.on('error', () => { /* reported through the query */ })
          child.once('exit', () => this.markExited())
          return child as unknown as ReturnType<NonNullable<Parameters<typeof query>[0]['options']>['spawnClaudeCodeProcess'] & object>
        },
      },
    })
    void this.pump()
    void this.announce()
  }

  /** What the session offers, without waiting for a first message. */
  private async announce(): Promise<void> {
    try {
      const init = await this.query.initializationResult()
      this.models = init.models
      this.commands = init.commands
      this.emit({
        kind: 'capabilities',
        modes: MODES,
        models: init.models.map((model) => ({
          id: model.value, label: model.displayName, description: model.description, resolved: model.resolvedModel ?? null,
        })),
      })
      this.emitCommands()
      this.emit({ kind: 'settings', mode: startingMode(this.request.mode, readPermissionMode()) })
      await this.refreshContext()
    } catch { /* the session works without them; a closing one has no answers */ }
  }

  /** The list without what only a terminal can do, or the CLI keeps to itself. */
  private emitCommands(): void {
    const commands: CommandInfo[] = this.commands
      .filter((command) => !this.terminalCommands.has(command.name) && !command.name.startsWith('__'))
      .map((command) => ({
        name: command.name, description: command.description, argumentHint: command.argumentHint, aliases: command.aliases ?? [],
      }))
    this.emit({ kind: 'commands', commands })
  }

  private async refreshContext(): Promise<void> {
    if (this.closing) return
    try {
      const usage = await this.query.getContextUsage({ detail: 'summary' })
      this.emit({ kind: 'context', usedTokens: usage.totalTokens, maxTokens: usage.maxTokens })
    } catch { /* the status bar keeps its last number */ }
  }

  /** What the view needs from a message beyond its mapping. */
  private observe(message: SDKMessage): void {
    if (message.type === 'result') void this.refreshContext()
    if (message.type !== 'system') return
    if (message.subtype === 'compact_boundary') void this.refreshContext()
    else if (message.subtype === 'init') {
      this.terminalCommands = new Set(message.terminal_slash_commands ?? [])
      if (this.commands.length > 0) this.emitCommands()
    } else if (message.subtype === 'commands_changed') {
      this.commands = message.commands
      this.emitCommands()
    }
  }

  private emit(event: RuntimeEvent): void {
    this.request.onEvent(event)
  }

  private async pump(): Promise<void> {
    try {
      for await (const message of this.query) {
        this.observe(message)
        for (const event of this.mapper.map(message)) this.emit(event)
      }
    } catch (error) {
      // The generator's errors surface as a misleading abort; a close is no failure at all.
      if (!this.closing) {
        const detail = this.stderrTail.trim().split('\n').pop()
        this.emit({ kind: 'error', message: detail || (error instanceof Error ? error.message : String(error)) })
      }
    }
    this.cancelOpenRequests()
    if (!this.exitReported) {
      this.exitReported = true
      this.emit({ kind: 'runtime_exit', expected: this.closing })
    }
  }

  private cancelOpenRequests(): void {
    for (const [requestId, open] of this.requests) {
      this.requests.delete(requestId)
      open.resolve({ behavior: 'deny', message: 'The session closed before this was answered.' })
      this.emit({ kind: 'request_settled', requestId, outcome: 'cancelled' })
    }
  }

  // No timeout on purpose: it may stay pending until the user comes back, and a
  // reconnecting browser gets the card again from the event log.
  private canUseTool: CanUseTool = (toolName, input, options) => new Promise((resolve) => {
    const requestId = `req-${++this.requestCounter}-${options.toolUseID}`
    this.requests.set(requestId, { resolve, input, suggestions: options.suggestions })
    options.signal.addEventListener('abort', () => {
      if (!this.requests.delete(requestId)) return
      resolve({ behavior: 'deny', message: 'Cancelled.' })
      this.emit({ kind: 'request_settled', requestId, outcome: 'cancelled' })
    }, { once: true })
    if (toolName === 'AskUserQuestion') {
      this.emit({ kind: 'question', requestId, questions: questionsOf(input) })
      return
    }
    const hasAlways = (options.suggestions?.length ?? 0) > 0
    this.emit({
      kind: 'permission_request',
      requestId,
      toolId: options.toolUseID,
      toolName,
      title: options.title ?? toolTitle(toolName, input),
      input,
      reason: options.decisionReason ?? null,
      alwaysScope: hasAlways ? `${options.displayName ?? toolName} for this project or session, as Claude Code suggests it` : null,
    })
  })

  send(id: string, text: string, images: ImageInput[] = []): void {
    const content = images.length === 0 ? text : [
      ...images.map(({ mediaType, data }) => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data } })),
      ...(text.trim() ? [{ type: 'text', text }] : []),
    ]
    this.input.push({
      type: 'user',
      uuid: id as SDKUserMessage['uuid'],
      message: { role: 'user', content: content as SDKUserMessage['message']['content'] },
      parent_tool_use_id: null,
      session_id: this.request.sessionId,
    })
  }

  async interrupt(): Promise<void> {
    this.mapper.noteInterrupt()
    await this.query.interrupt()
  }

  async setMode(mode: string): Promise<void> {
    await this.query.setPermissionMode(mode as PermissionMode)
    this.emit({ kind: 'settings', mode })
  }

  async setModel(model: string): Promise<void> {
    await this.query.setModel(model)
    this.emit({ kind: 'settings', model: this.models.find((known) => known.value === model)?.resolvedModel ?? model })
    await this.refreshContext()
  }

  async stopAgent(taskId: string): Promise<void> {
    await this.query.stopTask(taskId)
  }

  answerPermission(requestId: string, answer: PermissionAnswer): void {
    const open = this.requests.get(requestId)
    if (!open) return
    this.requests.delete(requestId)
    if (answer.decision === 'deny') {
      open.resolve({ behavior: 'deny', message: answer.message ?? 'The user declined this.' })
      this.emit({ kind: 'request_settled', requestId, outcome: 'denied' })
    } else if (answer.decision === 'answer') {
      open.resolve({ behavior: 'allow', updatedInput: { questions: open.input.questions, answers: answer.answers } })
      this.emit({ kind: 'request_settled', requestId, outcome: 'answered' })
    } else if (answer.decision === 'always') {
      open.resolve({ behavior: 'allow', updatedInput: open.input, updatedPermissions: open.suggestions ?? [] })
      this.emit({ kind: 'request_settled', requestId, outcome: 'always' })
    } else {
      open.resolve({ behavior: 'allow', updatedInput: open.input })
      this.emit({ kind: 'request_settled', requestId, outcome: 'allowed' })
    }
  }

  async toolServers(): Promise<ToolServer[]> {
    // Not the server's config: it can carry URLs and headers, and the view needs neither.
    return (await this.query.mcpServerStatus()).map((server) => ({
      name: server.name,
      status: server.status,
      error: server.error ?? null,
      scope: server.scope ?? null,
      transport: transportOf(server.config?.type),
      toolCount: server.tools?.length ?? 0,
    }))
  }

  setToolServerEnabled(name: string, enabled: boolean): Promise<void> {
    return this.query.toggleMcpServer(name, enabled)
  }

  reconnectToolServer(name: string): Promise<void> {
    return this.query.reconnectMcpServer(name)
  }

  async close(): Promise<void> {
    this.closing = true
    this.input.end()
    this.query.close()
    this.cancelOpenRequests()
    if (!this.child) return
    const timer = setTimeout(() => { try { this.child?.kill('SIGKILL') } catch { /* gone */ } }, EXIT_TIMEOUT_MS)
    await this.exited
    clearTimeout(timer)
  }
}

export function createClaudeSdkRuntimes(): SessionRuntimeFactory {
  // getSessionMessages takes the config dir only from this process's environment,
  // and agents have folders of their own: one read at a time, each under its own
  // folder. No session inherits the variable (baseAgentEnv).
  let reads: Promise<unknown> = Promise.resolve()
  return {
    start: (request) => new ClaudeSdkRuntime(request),
    history(conversationId, cwd, agent) {
      const configDir = agent ? agent.configDirs.claude : CONFIG_DIR
      if (!configDir) return Promise.reject(new Error(`Agent "${agent?.id}" has no config folder for Claude Code.`))
      const read = reads.then(async () => {
        process.env.CLAUDE_CONFIG_DIR = configDir
        return historyEvents(await getSessionMessages(conversationId, { dir: cwd }))
      })
      reads = read.catch(() => { /* the caller gets it */ })
      return read
    },
  }
}
