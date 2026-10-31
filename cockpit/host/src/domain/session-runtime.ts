/**
 * A session driven through a structured harness instead of a terminal: the port
 * the chat view runs on. It says nothing about any one agent: an adapter
 * (infrastructure/providers/<id>/) maps its harness onto these events, which are
 * modelled on ACP's session/update.
 *
 * Domain layer: types only, no I/O.
 */
import type { SessionAgent } from './agent-provider.js'

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

export type RuntimeEvent =
  | { kind: 'ready'; model: string | null }
  | { kind: 'user_message'; id: string; text: string; queued: boolean }
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
  send(id: string, text: string): void
  /** Stop the running turn. Messages already queued still run, so they must not be sent again. */
  interrupt(): Promise<void>
  /** Idempotent per request: an answer to a settled or unknown request does nothing. */
  answerPermission(requestId: string, answer: PermissionAnswer): void
  /** Ends the run; resolves once its process has exited. Open requests settle as cancelled. */
  close(): Promise<void>
}

export interface SessionRuntimeStart {
  sessionId: string
  /** Continue the stored conversation instead of starting one under `sessionId`. */
  resume: boolean
  cwd: string
  /** The session's complete environment; a runtime inherits nothing else. */
  env: Record<string, string>
  /** The session's address for cross-session messaging. */
  address: string
  /** The session's brain space, as the agent CLI takes it. */
  files: { mcpConfig: string; settings: string }
  /** Exactly the servers of `files.mcpConfig`, nothing else the agent CLI knows of: a space with its own agent. */
  strictMcp: boolean
  onEvent: (event: RuntimeEvent) => void
}

export interface SessionRuntimeFactory {
  start(request: SessionRuntimeStart): SessionRuntime
  /** The stored conversation as events, oldest first; `agent`: it is in that agent's folder. */
  history(sessionId: string, cwd: string, agent?: SessionAgent | null): Promise<RuntimeEvent[]>
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
