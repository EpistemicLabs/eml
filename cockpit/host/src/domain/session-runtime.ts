import type { WorkerStatus } from './session-attention.js'
import type { CheckFix, CheckTime, DerivedTurn, EndTurn, Missing } from './turn-end.js'
/**
 * A session driven through a structured harness instead of a terminal: the port
 * the chat view runs on. It says nothing about any one agent: an adapter
 * (infrastructure/providers/<id>/) maps its harness onto these events, which are
 * modelled on ACP's session/update.
 *
 * Domain layer: types only, no I/O.
 */
import type { LaunchSpec, SessionRef, SessionSpace } from './agent-provider.js'

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
  /** Empty: the answer is free text. */
  options: QuestionOption[]
  /** The answer is a secret (a password, a key): the view does not show it as typed. Absent: false. */
  secret?: boolean
}

/** A command the agent takes as a message, written `/name`. */
export interface CommandInfo {
  name: string
  description: string
  argumentHint: string
  aliases: string[]
}

/** How hard a model thinks before it answers ("low", "high", …): the runtime's own ids. */
export interface EffortOption {
  id: string
  label: string
  description: string
}

export interface ModelOption {
  id: string
  label: string
  description: string
  /** The model id this option stands for now (an alias resolves to one). */
  resolved: string | null
  /** The reasoning efforts it takes, for a runtime with the `reasoningEffort` feature. Absent: none to choose. */
  efforts?: EffortOption[]
  /** The effort it runs with when none is chosen. */
  defaultEffort?: string | null
}

export interface ModeOption {
  id: string
  label: string
  description: string
  /** False: Shift+Tab passes over it, it can only be picked from the list (a mode without a safety net). Absent: true. */
  cycle?: boolean
}

/**
 * Something a runtime may or may not offer; a view shows a control only for what its runtime lists in
 * `capabilities.features`, instead of showing it and failing.
 *
 *   commands              the agent takes `/name` commands of its own (the `commands` event lists them)
 *   stopAgent             a running subagent can be stopped on its own (stopAgent)
 *   toolServerToggle      a tool server can be switched on and off (setToolServerEnabled)
 *   toolServerReconnect   a tool server can be connected again (reconnectToolServer)
 *   toolServerSignIn      a tool server that needs a sign-in can be signed in to from the view (signInToolServer)
 *   reasoningEffort       the effort can be chosen per session (setEffort; the models list theirs)
 */
export type RuntimeFeature =
  | 'commands'
  | 'stopAgent'
  | 'toolServerToggle'
  | 'toolServerReconnect'
  | 'toolServerSignIn'
  | 'reasoningEffort'

/** Where to sign in to a tool server: a page the user opens; the runtime notices when it is done. */
export interface ToolServerSignIn {
  url: string
  /**
   * The page sends the browser back to an address on the cockpit's own machine. A browser on another
   * computer cannot open it; the user pastes that address (or the code in it) back instead
   * (finishToolServerSignIn).
   */
  takesCode?: boolean
}

/** An image going into a message: base64. */
export interface ImageInput {
  mediaType: string
  data: string
}

export type AgentTaskStatus = 'running' | 'completed' | 'failed' | 'stopped'

/** A background shell command a session started, as its views show it: what it does and since when it runs. */
export interface RunningCommand {
  description: string
  since: string
}

/** A workflow run in the background, as a session waiting on it shows it: its agents started dynamically, so no total. */
export interface WorkflowWait {
  name: string
  running: number
  done: number
}

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
  | { kind: 'settings'; model?: string | null; mode?: string; effort?: string | null }
  /**
   * What can be chosen in this session, and what the runtime can do (`features`). An event without
   * `features` comes from before they were named, when every runtime in the chat was Claude Code: it
   * means what Claude Code offers (commands, stopAgent, toolServerToggle, toolServerReconnect), so
   * nothing a view showed then disappears.
   */
  | { kind: 'capabilities'; models: ModelOption[]; modes: ModeOption[]; features?: RuntimeFeature[] }
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
  /**
   * A workflow run (the Workflow tool) in the background, started, ended, or how far its agents are
   * (`running`, `done`, and the phase of the latest one started): a field left out did not change.
   */
  | {
    kind: 'workflow_task'
    taskId: string
    toolId?: string | null
    name?: string
    status?: AgentTaskStatus
    running?: number
    done?: number
    phase?: string | null
  }
  /** A shell running in the background, started or changed: a field left out did not change. */
  | { kind: 'shell_task'; taskId: string; toolId?: string | null; description?: string; status?: AgentTaskStatus }
  /** A tool call inside a subagent; `title` and `toolKind` come with the call, a later `status` updates it. */
  | { kind: 'agent_tool'; parentToolId: string; toolId: string; toolKind?: ToolKind; title?: string; status: ToolStatus }
  /**
   * The id the agent itself knows the conversation by, for a runtime whose agent assigns it (AgentProvider.adoptsSessionId
   * false). For the ledger alone: the bridge binds it and passes nothing on, so no view sees this event.
   */
  | { kind: 'conversation'; conversationId: string }
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
  /** Output of a running call as it comes (a shell command's lines); its `tool_result` replaces all of it. */
  | { kind: 'tool_output_delta'; toolId: string; delta: string }
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
    /** Refusing this call also ends the turn: the agent offers no refusal it could go on after. Absent: false. */
    denyStopsTurn?: boolean
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
  /**
   * `message`: why, for the agent. `interrupt`: the turn stops as well; without it the agent goes on
   * without this call.
   */
  | { decision: 'deny'; message?: string; interrupt?: boolean }
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
  /** Feature `reasoningEffort`; a change shows up as a `settings` event. */
  setEffort(effort: string): Promise<void>
  /** Feature `stopAgent`. */
  stopAgent(taskId: string): Promise<void>
  toolServers(): Promise<ToolServer[]>
  /** Feature `toolServerToggle`. */
  setToolServerEnabled(name: string, enabled: boolean): Promise<void>
  /** Feature `toolServerReconnect`. */
  reconnectToolServer(name: string): Promise<void>
  /**
   * Feature `toolServerSignIn`: starts a sign-in to a server in status needs-auth. Resolves with the page to
   * open, or null when there is nothing to open (it was signed in already); a `notice` says when it is done,
   * and the server's status changes then. Rejects where unsupported.
   */
  signInToolServer(name: string): Promise<ToolServerSignIn | null>
  /**
   * Feature `toolServerSignIn`, for a sign-in that `takesCode`: the address its page ended on, or the code
   * in it. Resolves once the server is signed in. The value is a secret: never logged or kept.
   */
  finishToolServerSignIn(name: string, code: string): Promise<void>
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
  /** The reasoning effort the session last ran with; null: the runtime's default. */
  effort?: string | null
  cwd: string
  /** The session's complete environment; a runtime inherits nothing else. */
  env: Record<string, string>
  /** The session's address for cross-session messaging. */
  address: string
  /**
   * What the provider's launch() made of this session. A runtime reads from it what its agent CLI takes
   * beside `env`: the session's limits from its tool profile, browser control.
   */
  launch: LaunchSpec
  /** The brain space the session runs in: its files, and the runtime of a space that has its own. */
  space: SessionSpace
  onEvent: (event: RuntimeEvent) => void
  /** The agent CLI's process started: the host puts it under the session's memory ceiling (session-memory.ts). */
  onSpawn?: (pid: number) => void
  /** The session reports how it stands. Only a worker is sent back when it stays silent. */
  worker?: {
    /** Added to the next prompt, unseen in the chat; null: nothing. */
    onPrompt?: () => string | null
    /** An end_turn call (domain/turn-end.ts): recorded, and what its answer has to say. Rejects with the reason when nothing was recorded. */
    endTurn(call: EndTurn): Promise<EndTurnRecorded>
    /** The older session_status call: the status as given, its reason as the result. */
    report(status: WorkerStatus, reason: string | null): void
    /** Its turn is about to end: what to tell it instead of letting it stop; null lets it stop. */
    onTurnEnding(): string | null | Promise<string | null>
  }
  /** The schedule tool's actions for this session (application/jobs.ts); the answer is what the agent reads. */
  jobs?: (input: Record<string, unknown>) => Promise<string>
  /** The user's time zone as the session's tools name it, "Asia/Bangkok (UTC+7)" (domain/schedule.ts zoneLabel). */
  timeZone?: string
}

/** What the cockpit made of an end_turn call, for the tool's answer. */
export interface EndTurnRecorded {
  derived: DerivedTurn
  /** What the call still lacks (missingOf). */
  missing: readonly Missing[]
  /** Why the check at next.when could not be set; the rest of the call is recorded. */
  checkProblem?: string
  /** What helps then: another time, the same call again, or nothing the agent can do. */
  checkFix?: CheckFix
  /** The zone next.when was read in and the instant the task's wake-up was saved for. */
  checkTime?: CheckTime
  /** The task has a next run from its schedule: it needs no time from the agent. */
  nextRun?: boolean
}

export interface SessionRuntimeFactory {
  /** The mode a worker runs in, one of those its `capabilities` offer: nobody is there to answer. */
  readonly workerMode: string
  start(request: SessionRuntimeStart): SessionRuntime
  /** The session's stored conversation as events, oldest first, ending with `history_end`. */
  history(session: SessionRef): Promise<RuntimeEvent[]>
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
