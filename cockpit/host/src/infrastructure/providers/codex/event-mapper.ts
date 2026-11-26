import type { AgentActivity, PermissionAnswer, RuntimeEvent, ToolKind } from '../../../domain/session-runtime.js'
import type {
  ApprovalResponse, CommandExecutionApprovalDecision, CommandExecutionItem, CommandExecutionRequestApprovalParams, FileChangeItem,
  FileChangeRequestApprovalParams, McpToolCallItem, PermissionsRequestApprovalParams, PermissionsRequestApprovalResponse, RequestId,
  ServerNotifications, ThreadItem, Turn, UserMessageItem, WebSearchItem,
} from './protocol.js'

/**
 * What `codex app-server` says, as RuntimeEvents: its notifications, its approval
 * requests and a stored thread. Pure: no process, no clock. The runtime feeds it what
 * the client receives and sends on what it returns.
 *
 * Everything is read as possibly missing (protocol.ts): a notification, an item kind
 * or a request this does not know gives no events, and never throws.
 */

const MAX_TOOL_OUTPUT = 20_000

/**
 * Around text the cockpit puts into a turn for the agent alone (chat-runtime.ts): what it adds to a
 * prompt, and the turn it sends a session back with. A stored thread keeps it as the user's input;
 * the conversation leaves it out.
 */
export const HIDDEN_INPUT_OPEN = '<cockpit-context>'
export const HIDDEN_INPUT_CLOSE = '</cockpit-context>'
const MAX_NOTICE_DETAIL = 300

// The names a tool row and a permission card show for Codex's built-in work.
const SHELL = 'Shell'
const EDIT = 'Edit'
const WEB_SEARCH = 'WebSearch'
const PERMISSIONS = 'Permissions'

const VERBS: Record<ToolKind, string> = {
  read: 'Read', edit: 'Edit', execute: 'Run', search: 'Search', fetch: 'Fetch', agent: 'Agent', other: '',
}

type Fields = Record<string, unknown>

/** Anything as an object whose fields may all be missing. */
function fields(value: unknown): Fields {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringField(input: Fields, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value) return value
  }
  return null
}

function cut(output: string): string {
  return output.length > MAX_TOOL_OUTPUT ? `${output.slice(0, MAX_TOOL_OUTPUT)}\n… (cut off)` : output
}

/** One line for a tool row: verb and target. */
export function toolTitle(name: string, kind: ToolKind, input: Record<string, unknown>): string {
  const target = stringField(input, 'file_path', 'command', 'pattern', 'query', 'url', 'description', 'path')
  const firstLine = target?.split('\n')[0] ?? ''
  if (kind === 'other') return firstLine ? `${name} ${firstLine}` : name
  return firstLine ? `${VERBS[kind]} ${firstLine}` : VERBS[kind]
}

/** A tool call as the chat shows it. */
interface ToolCall {
  name: string
  toolKind: ToolKind
  title: string
  input: Record<string, unknown>
}

type ToolItem = CommandExecutionItem | FileChangeItem | McpToolCallItem | WebSearchItem

/** The command without the shell around it, where the CLI read it as one. */
function commandLine(command: string, actions: unknown): string {
  const parts = list(actions).map((action) => text(fields(action).command)).filter(Boolean)
  return parts.length === 1 ? parts[0] : command
}

function commandCall(command: string, cwd: string, actions: unknown): ToolCall {
  return {
    name: SHELL,
    toolKind: 'execute',
    title: toolTitle(SHELL, 'execute', { command: commandLine(command, actions) }),
    input: { command, ...(cwd ? { cwd } : {}) },
  }
}

function fileChangeCall(changes: unknown[]): ToolCall {
  const paths = changes.map((change) => text(fields(change).path)).filter(Boolean)
  const title = paths.length > 1 ? `${VERBS.edit} ${paths[0]} and ${paths.length - 1} more` : toolTitle(EDIT, 'edit', { path: paths[0] })
  return { name: EDIT, toolKind: 'edit', title, input: changes.length > 0 ? { changes } : {} }
}

/** What a web search looks for: its query, or the page it opens. */
function searchTarget(item: Partial<WebSearchItem>): { query?: string; url?: string } {
  const action = fields(item.action)
  const query = text(item.query) || text(action.query)
  const url = text(action.url)
  return { ...(query ? { query } : {}), ...(url ? { url } : {}) }
}

function toolCall(item: Partial<ToolItem>): ToolCall {
  switch (item.type) {
    case 'commandExecution': return commandCall(text(item.command), text(item.cwd), item.commandActions)
    case 'fileChange': return fileChangeCall(list(item.changes))
    case 'mcpToolCall': {
      // The chat knows the cockpit's own tools by this name (`mcp__cockpit__end_turn`).
      const name = `mcp__${text(item.server)}__${text(item.tool)}`
      const input = fields(item.arguments)
      return { name, toolKind: 'other', title: toolTitle(name, 'other', input), input }
    }
    default: {
      const input = searchTarget(item as Partial<WebSearchItem>)
      return { name: WEB_SEARCH, toolKind: 'fetch', title: toolTitle(WEB_SEARCH, 'fetch', input), input }
    }
  }
}

function mcpOutput(item: Partial<McpToolCallItem>): string {
  const error = text(fields(item.error).message)
  if (error) return error
  const result = fields(item.result)
  const content = list(result.content).map((block) => {
    const { type, text: words } = fields(block)
    return type === 'text' ? text(words) : `[${text(type) || 'content'}]`
  })
  if (content.length > 0) return content.join('\n')
  return result.structuredContent === null || result.structuredContent === undefined ? '' : JSON.stringify(result.structuredContent)
}

/** How a tool item ended; null while it runs. */
function toolResult(item: Partial<ToolItem>): { status: 'completed' | 'failed'; output: string } | null {
  if (item.type === 'webSearch') {
    // The query is often only known once the search is done.
    const { query, url } = searchTarget(item)
    return { status: 'completed', output: query ?? url ?? '' }
  }
  const status = text((item as Fields).status)
  if (status !== 'completed' && status !== 'failed' && status !== 'declined') return null
  const declined = status === 'declined'
  if (item.type === 'commandExecution') {
    const failed = status !== 'completed' || (typeof item.exitCode === 'number' && item.exitCode !== 0)
    return { status: failed ? 'failed' : 'completed', output: cut(text(item.aggregatedOutput)) || (declined ? 'Declined.' : '') }
  }
  if (item.type === 'mcpToolCall') return { status: status === 'completed' ? 'completed' : 'failed', output: cut(mcpOutput(item)) }
  return { status: status === 'completed' ? 'completed' : 'failed', output: declined ? 'Declined.' : '' }
}

function isToolItem(item: Partial<ThreadItem>): item is Partial<ToolItem> {
  return item.type === 'commandExecution' || item.type === 'fileChange' || item.type === 'mcpToolCall' || item.type === 'webSearch'
}

function reasoningText(summary: unknown, content: unknown): string {
  const parts = (value: unknown) => list(value).map(text).filter(Boolean).join('\n\n')
  return parts(summary) || parts(content)
}

/** A stored user message. Its id is the one it was sent under, so the chat knows its own message again. */
function userMessage(item: Partial<UserMessageItem>): RuntimeEvent[] {
  const content = list(item.content).map(fields)
  const words = content
    .filter((part) => part.type === 'text' && !text(part.text).startsWith(HIDDEN_INPUT_OPEN))
    .map((part) => text(part.text)).join('\n')
  const images = content.filter((part) => part.type === 'image' || part.type === 'localImage').map(() => ({ url: null }))
  if (!words.trim() && images.length === 0) return []
  return [{ kind: 'user_message', id: text(item.clientId) || text(item.id), text: words, queued: false, ...(images.length > 0 ? { images } : {}) }]
}

function sameDecision(a: CommandExecutionApprovalDecision, b: CommandExecutionApprovalDecision): boolean {
  return typeof a === 'string' || typeof b === 'string' ? a === b : Object.keys(a)[0] === Object.keys(b)[0]
}

/** An approval the server waits on: its answers in the protocol's words. `always` null: no such grant is offered. */
interface OpenRequest {
  id: RequestId
  allow: ApprovalResponse
  always: ApprovalResponse | null
  deny: ApprovalResponse
}

/** The answer to an approval request: what to respond with under `id`, and what the chat is told. */
export interface ApprovalAnswer {
  id: RequestId
  result: ApprovalResponse
  events: RuntimeEvent[]
}

/**
 * Maps one app-server process's stream onto RuntimeEvents. An item is announced, may
 * stream, and comes again complete: a message's complete text takes the block its
 * deltas ran under (the item id), a tool item is a call when it starts and a result
 * when it ends. The user's own message is not repeated: the bridge wrote it when it
 * was sent.
 */
export class CodexEventMapper {
  private activity: AgentActivity | null = null
  // Tool items that were announced and have not ended, by item id.
  private running = new Map<string, Partial<ToolItem>>()
  // The part of a reasoning item its deltas are in.
  private reasoning = new Map<string, { source: 'summary' | 'content'; index: number }>()
  private requests = new Map<string, OpenRequest>()
  // Tool servers whose failed start was said already.
  private failedServers = new Set<string>()
  // The error reported for the running turn, for a turn that ends failed without naming one.
  private turnError: string | null = null

  /** A notification of the server. */
  notification(method: string, params: unknown): RuntimeEvent[] {
    const p = fields(params)
    switch (method) {
      case 'turn/started':
        this.turnError = null
        return this.activityEvents('working')
      case 'turn/completed': return this.turnCompleted(p as Partial<ServerNotifications['turn/completed']>)
      case 'thread/status/changed': return this.status(fields(p.status))
      case 'item/started': return this.itemStarted(fields(p.item) as Partial<ThreadItem>)
      case 'item/completed': return this.itemCompleted(fields(p.item) as Partial<ThreadItem>)
      case 'item/agentMessage/delta': {
        const { itemId, delta } = p as Partial<ServerNotifications['item/agentMessage/delta']>
        return typeof itemId === 'string' && typeof delta === 'string' && delta ? [{ kind: 'text_delta', blockId: itemId, delta }] : []
      }
      case 'item/reasoning/summaryTextDelta': return this.reasoningDelta('summary', text(p.itemId), p.summaryIndex, p.delta)
      case 'item/reasoning/textDelta': return this.reasoningDelta('content', text(p.itemId), p.contentIndex, p.delta)
      case 'thread/tokenUsage/updated': return this.tokenUsage(fields(p.tokenUsage))
      case 'error': {
        const message = text(fields(p.error).message)
        if (!message) return []
        if (p.willRetry === true) return [{ kind: 'notice', text: `Trying again: ${message}` }]
        // The turn's own end says it.
        this.turnError = message
        return []
      }
      case 'mcpServer/startupStatus/updated': return this.toolServer(p as Partial<ServerNotifications['mcpServer/startupStatus/updated']>)
      case 'serverRequest/resolved': return this.settle((open) => open.id === p.requestId)
      default: return []
    }
  }

  /**
   * A request of the server. Null: not one this knows, and the runtime refuses it.
   * Otherwise the card for the user; answer() says what to respond once they chose.
   */
  request(id: RequestId, method: string, params: unknown): RuntimeEvent[] | null {
    const p = fields(params)
    const itemId = text(p.itemId)
    const requestId = `req-${id}-${itemId}`
    const reason = text(p.reason) || null
    const ask = (open: Omit<OpenRequest, 'id'>, card: { toolName: string; title: string; input: Record<string, unknown>; alwaysScope: string | null }): RuntimeEvent[] => {
      this.requests.set(requestId, { id, ...open })
      return [{ kind: 'permission_request', requestId, toolId: itemId || null, ...card, reason }]
    }
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const request = p as Partial<CommandExecutionRequestApprovalParams>
        const item = this.running.get(itemId) as Partial<CommandExecutionItem> | undefined
        const call = commandCall(text(request.command) || text(item?.command), text(request.cwd) || text(item?.cwd), request.commandActions ?? item?.commandActions)
        const amendment = list(request.proposedExecpolicyAmendment).map(text)
        // An older server names no list: what the protocol always takes.
        const offered: CommandExecutionApprovalDecision[] = Array.isArray(request.availableDecisions)
          ? request.availableDecisions.filter((one) => typeof one === 'string' || (!!one && typeof one === 'object'))
          : ['accept', 'acceptForSession', 'decline', 'cancel']
        const offers = (decision: CommandExecutionApprovalDecision) => offered.find((one) => sameDecision(one, decision)) ?? null
        // The grant that ends with the session before the one that stays.
        const forSession = offers('acceptForSession')
        const always = forSession ?? offers({ acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } })
        const prefix = always && typeof always === 'object' && 'acceptWithExecpolicyAmendment' in always
          ? list(fields(always.acceptWithExecpolicyAmendment).execpolicy_amendment).map(text).join(' ')
          : ''
        return ask({
          allow: { decision: 'accept' },
          always: always ? { decision: always } : null,
          // Declined, the turn goes on without the command; a request that only offers "cancel" ends the turn.
          deny: { decision: offers('decline') ?? 'cancel' },
        }, {
          toolName: call.name,
          title: call.title,
          input: call.input,
          alwaysScope: !always ? null : forSession ? 'This command, for the rest of this session' : `Commands starting with \`${prefix}\`, from now on`,
        })
      }
      case 'item/fileChange/requestApproval': {
        const request = p as Partial<FileChangeRequestApprovalParams>
        const item = this.running.get(text(request.itemId)) as Partial<FileChangeItem> | undefined
        const call = fileChangeCall(list(item?.changes))
        return ask(
          { allow: { decision: 'accept' }, always: { decision: 'acceptForSession' }, deny: { decision: 'decline' } },
          { toolName: call.name, title: call.title, input: call.input, alwaysScope: 'These files, for the rest of this session' },
        )
      }
      case 'item/permissions/requestApproval': {
        const { network, fileSystem } = fields((p as Partial<PermissionsRequestApprovalParams>).permissions) as Partial<PermissionsRequestApprovalParams['permissions']>
        // Granted is what was asked for, as it was asked.
        const granted: PermissionsRequestApprovalResponse['permissions'] = { ...(network ? { network } : {}), ...(fileSystem ? { fileSystem } : {}) }
        const wanted = [
          ...(fields(network).enabled === true ? ['network access'] : []),
          ...list(fields(fileSystem).write).map((path) => `writing to ${text(path)}`),
          ...list(fields(fileSystem).read).map((path) => `reading ${text(path)}`),
        ]
        return ask({
          allow: { permissions: granted, scope: 'turn' },
          always: { permissions: granted, scope: 'session' },
          deny: { permissions: {}, scope: 'turn' },
        }, {
          toolName: PERMISSIONS,
          title: wanted.length > 0 ? `Allow ${wanted.join(', ')}` : 'Allow more access',
          input: { permissions: fields(p.permissions) },
          alwaysScope: 'The same access, for the rest of this session',
        })
      }
      default: return null
    }
  }

  /**
   * The user's answer to a request in the protocol's words. Null: the request is settled
   * or unknown, or the answer is none for a permission. "Always" where the request offers
   * no such grant allows this once.
   */
  answer(requestId: string, answer: PermissionAnswer): ApprovalAnswer | null {
    const open = this.requests.get(requestId)
    if (!open || answer.decision === 'answer') return null
    this.requests.delete(requestId)
    const settled = (result: ApprovalResponse, outcome: 'allowed' | 'always' | 'denied'): ApprovalAnswer => (
      { id: open.id, result, events: [{ kind: 'request_settled', requestId, outcome }] }
    )
    if (answer.decision === 'deny') return settled(open.deny, 'denied')
    if (answer.decision === 'always' && open.always) return settled(open.always, 'always')
    return settled(open.allow, 'allowed')
  }

  /** The process is closing or gone: nothing open will be answered. */
  cancelOpenRequests(): RuntimeEvent[] {
    return this.settle(() => true)
  }

  private settle(which: (open: OpenRequest) => boolean): RuntimeEvent[] {
    const events: RuntimeEvent[] = []
    for (const [requestId, open] of this.requests) {
      if (!which(open)) continue
      this.requests.delete(requestId)
      events.push({ kind: 'request_settled', requestId, outcome: 'cancelled' })
    }
    return events
  }

  /** A state the chat was told already is not said again: a turn's start and the thread's status both name it. */
  private activityEvents(state: AgentActivity): RuntimeEvent[] {
    if (this.activity === state) return []
    this.activity = state
    return [{ kind: 'activity', state }]
  }

  private status(status: Fields): RuntimeEvent[] {
    if (status.type === 'idle' || status.type === 'systemError') return this.activityEvents('idle')
    if (status.type !== 'active') return []
    return this.activityEvents(list(status.activeFlags).length > 0 ? 'waiting' : 'working')
  }

  private turnCompleted({ turn }: Partial<ServerNotifications['turn/completed']>): RuntimeEvent[] {
    const { status, error } = fields(turn) as Partial<Turn>
    if (typeof status !== 'string') return []
    const reported = this.turnError
    this.turnError = null
    this.running.clear()
    this.reasoning.clear()
    // What the turn still asked went with it.
    const events = this.cancelOpenRequests()
    if (status === 'interrupted') events.push({ kind: 'turn_end', reason: 'interrupted' })
    else if (status === 'failed') {
      events.push({ kind: 'error', message: text(fields(error).message) || reported || 'The turn failed.' })
      events.push({ kind: 'turn_end', reason: 'error' })
    } else events.push({ kind: 'turn_end', reason: 'success' })
    return events
  }

  private itemStarted(item: Partial<ThreadItem>): RuntimeEvent[] {
    if (!isToolItem(item) || typeof item.id !== 'string') return []
    this.running.set(item.id, item)
    return [{ kind: 'tool_call', toolId: item.id, ...toolCall(item) }]
  }

  private itemCompleted(item: Partial<ThreadItem>): RuntimeEvent[] {
    if (typeof item.id !== 'string') return []
    switch (item.type) {
      case 'agentMessage':
        // Commentary and the final answer are both the agent's text.
        return item.text ? [{ kind: 'text', blockId: item.id, text: item.text }] : []
      case 'reasoning': {
        this.reasoning.delete(item.id)
        const thought = reasoningText(item.summary, item.content)
        return thought ? [{ kind: 'thinking', blockId: item.id, text: thought }] : []
      }
      case 'contextCompaction': return [{ kind: 'compaction' }]
      default: {
        if (!isToolItem(item)) return []
        // Not announced (a stored turn): the call comes with its result.
        const events: RuntimeEvent[] = this.running.delete(item.id) ? [] : [{ kind: 'tool_call', toolId: item.id, ...toolCall(item) }]
        const result = toolResult(item)
        if (result) events.push({ kind: 'tool_result', toolId: item.id, ...result })
        return events
      }
    }
  }

  /** A summary's parts and the raw reasoning run in one block; whichever streams first is the one shown until the item is complete. */
  private reasoningDelta(source: 'summary' | 'content', itemId: string, index: unknown, delta: unknown): RuntimeEvent[] {
    if (!itemId || typeof delta !== 'string' || !delta) return []
    const part = typeof index === 'number' ? index : 0
    const at = this.reasoning.get(itemId)
    if (at && at.source !== source) return []
    this.reasoning.set(itemId, { source, index: part })
    return [{ kind: 'thinking_delta', blockId: itemId, delta: at && at.index !== part ? `\n\n${delta}` : delta }]
  }

  /** One per model request. The context is what that request held; the thread's total counts every request again. */
  private tokenUsage(usage: Fields): RuntimeEvent[] {
    const last = fields(usage.last)
    if (typeof last.inputTokens !== 'number' || typeof last.outputTokens !== 'number') return []
    const events: RuntimeEvent[] = [{ kind: 'usage', inputTokens: last.inputTokens, outputTokens: last.outputTokens }]
    const used = typeof last.totalTokens === 'number' ? last.totalTokens : last.inputTokens + last.outputTokens
    if (typeof usage.modelContextWindow === 'number') events.push({ kind: 'context', usedTokens: used, maxTokens: usage.modelContextWindow })
    return events
  }

  /** The server reports its tool servers at every turn: a failed one is said once, and again only after it had started. */
  private toolServer({ name, status, error, failureReason }: Partial<ServerNotifications['mcpServer/startupStatus/updated']>): RuntimeEvent[] {
    if (typeof name !== 'string' || !name) return []
    if (status === 'ready') this.failedServers.delete(name)
    if (status !== 'failed' || this.failedServers.has(name)) return []
    this.failedServers.add(name)
    if (failureReason === 'reauthenticationRequired') return [{ kind: 'notice', text: `The tool server "${name}" needs you to sign in again.` }]
    const detail = text(error)
    const shown = detail.length > MAX_NOTICE_DETAIL ? `${detail.slice(0, MAX_NOTICE_DETAIL)}…` : detail
    return [{ kind: 'notice', text: shown ? `The tool server "${name}" did not start: ${shown}` : `The tool server "${name}" did not start.` }]
  }

  /** A stored turn's items, as they would have run. */
  stored(turn: Partial<Turn>): RuntimeEvent[] {
    const events: RuntimeEvent[] = []
    for (const stored of list(turn.items)) {
      const item = fields(stored) as Partial<ThreadItem>
      events.push(...(item.type === 'userMessage' ? userMessage(item) : this.itemCompleted(item)))
    }
    const failure = turn.status === 'failed' ? text(fields(turn.error).message) : ''
    if (failure) events.push({ kind: 'error', message: failure })
    return events
  }
}

/**
 * A stored thread as events: the turns of `thread/turns/list` with `itemsView: "full"`,
 * oldest first (the server's default order is newest first). Rendered from this alone,
 * never merged with live data.
 */
export function historyEvents(turns: Turn[]): RuntimeEvent[] {
  const mapper = new CodexEventMapper()
  const events = list(turns).flatMap((turn) => mapper.stored(fields(turn) as Partial<Turn>))
  events.push({ kind: 'history_end' })
  return events
}
