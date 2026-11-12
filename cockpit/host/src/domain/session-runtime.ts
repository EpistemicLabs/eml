import type { WorkerStatus } from './session-attention.js'
/**
 * A session driven through a structured harness instead of a terminal: the port
 * the chat view runs on. It says nothing about any one agent: an adapter
 * (infrastructure/providers/<id>/) maps its harness onto these events, which are
 * modelled on ACP's session/update.
 *
 * Domain layer: types only, no I/O.
 */
import type { SessionAgentRuntime } from './agent-provider.js'

/** Which of a session's two ways of running holds it. Not a provider: both are the same conversation. */
export type SessionRuntimeKind = 'terminal' | 'sdk'

export type ToolKind = 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'agent' | 'other'

/** `launched`: the call returned but its work goes on in the background. */
export type ToolStatus = 'running' | 'completed' | 'failed' | 'launched'

export type AgentActivity = 'idle' | 'working' | 'waiting'

export interface QuestionOption {
  label: string
  description: string
}

export interface Question {
  question: string
  header: string
  multiSelect: boolean
  options: QuestionOption[]
}

/** A command the agent takes as a message, written `/name`. */
export interface CommandInfo {
  name: string
  description: string
  argumentHint: string
  aliases: string[]
}

export interface ModelOption {
  id: string
  label: string
  description: string
  /** The model id this option stands for now (an alias resolves to one). */
  resolved: string | null
}

export interface ModeOption {
  id: string
  label: string
  description: string
}

/** An image going into a message: base64. */
export interface ImageInput {
  mediaType: string
  data: string
}

export type AgentTaskStatus = 'running' | 'completed' | 'failed' | 'stopped'

/** A tool server the session has, as the user manages it. Holds no address or credentials. */
export interface ToolServer {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  error: string | null
  scope: string | null
  /** How the server is reached: over the web, or as a process on this machine. */
  transport: 'web' | 'process' | null
  toolCount: number
}

export type RuntimeEvent =
  /** What the session runs with now; a field left out did not change. */
  | { kind: 'settings'; model?: string | null; mode?: string }
  /** What can be chosen in this session. */
  | { kind: 'capabilities'; models: ModelOption[]; modes: ModeOption[] }
  /** Replaces the command list. */
  | { kind: 'commands'; commands: CommandInfo[] }
  | { kind: 'context'; usedTokens: number; maxTokens: number }
  /** A subagent, started or changed: a field left out did not change. `toolId` is the call that started it. */
  | {
    kind: 'agent_task'
    taskId: string
    toolId?: string | null
    description?: string
    agentType?: string | null
    status?: AgentTaskStatus
    background?: boolean
    /** One line on what it is doing now. */
    activity?: string
    tokens?: number
    toolUses?: number
    durationMs?: number
  }
  /** A shell running in the background, started or changed: a field left out did not change. */
  | { kind: 'shell_task'; taskId: string; toolId?: string | null; description?: string; status?: AgentTaskStatus }
  /** A tool call inside a subagent; `title` and `toolKind` come with the call, a later `status` updates it. */
  | { kind: 'agent_tool'; parentToolId: string; toolId: string; toolKind?: ToolKind; title?: string; status: ToolStatus }
  /** The agent dropped the conversation and goes on in a new one under this id (`/clear`). */
  | { kind: 'conversation_reset'; conversationId: string }
  /** `images`: what came with it; `url` null for one that can only be counted (a stored conversation). */
  | { kind: 'user_message'; id: string; text: string; queued: boolean; images?: Array<{ url: string | null }> }
  /** Streamed text of a block; a later `text` with the same blockId replaces it. */
  | { kind: 'text_delta'; blockId: string; delta: string }
  | { kind: 'text'; blockId: string; text: string }
  | { kind: 'thinking_delta'; blockId: string; delta: string }
  | { kind: 'thinking'; blockId: string; text: string }
  | { kind: 'tool_call'; toolId: string; name: string; toolKind: ToolKind; title: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; toolId: string; status: Exclude<ToolStatus, 'running'>; output: string }
  | {
    kind: 'permission_request'
    requestId: string
    toolId: string | null
    toolName: string
    title: string
    input: Record<string, unknown>
    reason: string | null
    /** What "Always" would allow, in words; null when the agent offers no such grant. */
    alwaysScope: string | null
  }
  | { kind: 'question'; requestId: string; questions: Question[] }
  /** A permission or question is over. `cancelled`: the runtime took it back (its turn ended, the session closed). */
  | { kind: 'request_settled'; requestId: string; outcome: 'allowed' | 'always' | 'denied' | 'answered' | 'cancelled' }
  | { kind: 'activity'; state: AgentActivity }
  | { kind: 'usage'; inputTokens: number; outputTokens: number }
  | { kind: 'turn_end'; reason: 'success' | 'interrupted' | 'error' }
  | { kind: 'compaction' }
  /** The stored conversation is in; everything after it is live. */
  | { kind: 'history_end' }
  /** Whether a process runs the session: none yet (a read-only view), or one just starting. `capabilities` says it is ready. */
  | { kind: 'process'; state: 'stopped' | 'starting' }
  /** Something the user should know that is not the agent's output (a handoff, a lost grant). */
  | { kind: 'notice'; text: string }
  | { kind: 'error'; message: string }
  /** The runtime's process ended. `expected` false: it crashed, and the next message resumes it. */
  | { kind: 'runtime_exit'; expected: boolean }

export type PermissionAnswer =
  | { decision: 'allow' }
  | { decision: 'always' }
  | { decision: 'deny'; message?: string }
  /** For a question: the chosen label(s) per question text. */
  | { decision: 'answer'; answers: Record<string, string> }

/** One live run of a session. Its events arrive through the `onEvent` it was started with. */
export interface SessionRuntime {
  send(id: string, text: string, images?: ImageInput[]): void
  /** Stop the running turn. Messages already queued still run, so they must not be sent again. */
  interrupt(): Promise<void>
  /** Idempotent per request: an answer to a settled or unknown request does nothing. */
  answerPermission(requestId: string, answer: PermissionAnswer): void
  /** Rejects when the agent refuses it; a change shows up as a `settings` event. */
  setMode(mode: string): Promise<void>
  setModel(model: string): Promise<void>
  stopAgent(taskId: string): Promise<void>
  toolServers(): Promise<ToolServer[]>
  setToolServerEnabled(name: string, enabled: boolean): Promise<void>
  reconnectToolServer(name: string): Promise<void>
  /** Ends the run; resolves once its process has exited. Open requests settle as cancelled. */
  close(): Promise<void>
}

export interface SessionRuntimeStart {
  sessionId: string
  /** Continue the stored conversation instead of starting one under `sessionId`. */
  resume: boolean
  /** The stored conversation's own id, when it is not `sessionId` any more. */
  conversationId: string | null
  /** The mode and model the session last ran with; null: the agent's default. */
  mode: string | null
  model: string | null
  cwd: string
  /** The session's complete environment; a runtime inherits nothing else. */
  env: Record<string, string>
  /** The session's address for cross-session messaging. */
  address: string
  /** The session's brain space, as the agent CLI takes it. */
  files: { mcpConfig: string; settings: string }
  /** Exactly the servers of `files.mcpConfig`, nothing else the agent CLI knows of: a space with a runtime of its own. */
  strictMcp: boolean
  /** Browser control for a strict session: only a runtime that is given it. */
  chrome?: boolean
  /** Built-in tools this session may not use (its tool profile). */
  deniedTools?: string[]
  onEvent: (event: RuntimeEvent) => void
  /** The agent CLI's process started: the host puts it under the session's memory ceiling (session-memory.ts). */
  onSpawn?: (pid: number) => void
  /** The session reports how it stands. Only a worker is sent back when it stays silent. */
  worker?: {
    /** Added to the next prompt, unseen in the chat; null: nothing. */
    onPrompt?: () => string | null
    report(status: WorkerStatus, reason: string | null): void
    /** Its turn is about to end: what to tell it instead of letting it stop; null lets it stop. */
    onTurnEnding(): string | null
  }
  /** The schedule tool's actions for this session (application/jobs.ts); the answer is what the agent reads. */
  jobs?: (input: Record<string, unknown>) => Promise<string>
}

export interface SessionRuntimeFactory {
  start(request: SessionRuntimeStart): SessionRuntime
  /** The stored conversation as events, oldest first; `runtime`: it is in that runtime's folder. */
  history(conversationId: string, cwd: string, runtime?: SessionAgentRuntime | null): Promise<RuntimeEvent[]>
}

export interface StoredEvent {
  seq: number
  event: RuntimeEvent
}

/**
 * The events of one session, numbered so a reconnecting client asks for
 * "everything after n". A persisted log can replace the in-memory one behind this.
 */
export interface EventStore {
  append(sessionId: string, event: RuntimeEvent): StoredEvent
  after(sessionId: string, seq: number): StoredEvent[]
  /** Starts the session over under a new epoch: a client holding older numbers rebuilds its view. */
  reset(sessionId: string): number
  epoch(sessionId: string): number
  forget(sessionId: string): void
}
