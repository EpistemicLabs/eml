import { spawn, type ChildProcess } from 'node:child_process'
import { query, getSessionMessages, type CanUseTool, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage, type SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { CONFIG_DIR } from '../../../paths.js'
import type {
  PermissionAnswer, Question, RuntimeEvent, SessionRuntime, SessionRuntimeFactory, SessionRuntimeStart, ToolKind,
} from '../../../domain/session-runtime.js'
import { CLAUDE_BIN } from './runtime.js'

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

/** A placeholder the CLI writes as the assistant ("No response requested."); no model said it. */
function isSynthetic(message: unknown): boolean {
  return (message as { model?: string } | null)?.model === '<synthetic>'
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
  const launched = (toolUseResult as { status?: string } | null | undefined)?.status === 'async_launched'
  return {
    kind: 'tool_result',
    toolId: block.tool_use_id ?? '',
    status: block.is_error ? 'failed' : launched ? 'launched' : 'completed',
    output: resultText(block.content),
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
 * ran under. A subagent's own stream stays out (no subagent trees in this view).
 */
export class ClaudeEventMapper {
  private messageId: string | null = null
  private open: Array<{ blockId: string; type: string; messageId: string }> = []
  private blockCounter = 0
  private sawSessionState = false
  private interrupted = false

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
    if (message.subtype === 'init') return [{ kind: 'ready', model: message.model ?? null }]
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
    if (message.parent_tool_use_id || isSynthetic(message.message)) return []
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

  private user(message: Extract<SDKMessage, { type: 'user' }>): RuntimeEvent[] {
    if (message.parent_tool_use_id) return []
    const content = message.message.content
    if (!Array.isArray(content)) return []
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
      if (words !== null) events.push({ kind: 'user_message', id: stored.uuid, text: words, queued: false })
      if (Array.isArray(content)) {
        for (const block of content as ContentBlock[]) {
          if (block.type === 'tool_result') events.push(toolResultEvent(block, null))
        }
      }
    } else if (stored.type === 'assistant' && Array.isArray(content) && !isSynthetic(stored.message)) {
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

  constructor(private request: SessionRuntimeStart) {
    this.exited = new Promise((resolve) => { this.markExited = resolve })
    this.query = query({
      prompt: this.input,
      options: {
        cwd: request.cwd,
        env: request.env,
        pathToClaudeCodeExecutable: CLAUDE_BIN,
        // Left out, the session can start in auto and the cards would never be asked.
        permissionMode: 'default',
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        includePartialMessages: true,
        settings: request.files.settings,
        // Paths, not the servers themselves: the brain token stays in the file.
        extraArgs: { 'mcp-config': request.files.mcpConfig, name: request.address },
        ...(request.resume ? { resume: request.sessionId } : { sessionId: request.sessionId }),
        canUseTool: (toolName, input, options) => this.canUseTool(toolName, input, options),
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
  }

  private emit(event: RuntimeEvent): void {
    this.request.onEvent(event)
  }

  private async pump(): Promise<void> {
    try {
      for await (const message of this.query) {
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

  send(id: string, text: string): void {
    this.input.push({
      type: 'user',
      uuid: id as SDKUserMessage['uuid'],
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this.request.sessionId,
    })
  }

  async interrupt(): Promise<void> {
    this.mapper.noteInterrupt()
    await this.query.interrupt()
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
  return {
    start: (request) => new ClaudeSdkRuntime(request),
    async history(sessionId, cwd) {
      // getSessionMessages takes the config dir only from this process's
      // environment. No session inherits it (baseAgentEnv), and the host has only
      // this one, so it stays set: unset, the call looks in ~/.claude.
      process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR
      return historyEvents(await getSessionMessages(sessionId, { dir: cwd }))
    },
  }
}
