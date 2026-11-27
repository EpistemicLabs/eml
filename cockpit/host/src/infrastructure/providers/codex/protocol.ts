/**
 * The part of `codex app-server`'s protocol the chat runtime speaks: JSON-RPC over
 * stdio, one JSON object per line, without the `"jsonrpc"` field on the wire.
 *
 * Copied in shape from the types codex-cli 0.172.0 generates
 * (`codex app-server generate-ts`, the stable surface: nothing here needs the
 * `experimentalApi` capability), cut down to the messages and fields in use. The
 * server sends more of both. A reader takes every field as possibly missing and
 * leaves out a notification or an item kind it does not know: a newer CLI must
 * not break a session.
 *
 * Types only, no I/O.
 */

// ── Wire ────────────────────────────────────────────────────────────────────

/** The client counts its requests up from 1; the server numbers its own separately, from 0. */
export type RequestId = number | string

export interface RpcRequest {
  id: RequestId
  method: string
  params?: unknown
}

export interface RpcNotification {
  method: string
  params?: unknown
  /** On the server's notifications only. */
  emittedAtMs?: number
}

export interface RpcError {
  code: number
  message: string
  data?: unknown
}

export type RpcResponse =
  | { id: RequestId; result: unknown }
  | { id: RequestId; error: RpcError }

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse

// ── initialize ──────────────────────────────────────────────────────────────

export interface InitializeParams {
  /** `name` becomes the `originator` of the threads this client starts. */
  clientInfo: { name: string; title: string | null; version: string }
  capabilities?: { experimentalApi?: boolean; optOutNotificationMethods?: string[] } | null
}

export interface InitializeResponse {
  userAgent: string
  codexHome: string
  platformFamily: string
  platformOs: string
}

// ── model/list ──────────────────────────────────────────────────────────────

export interface ModelListParams {
  modelProvider?: string | null
  cursor?: string | null
  limit?: number | null
  includeHidden?: boolean | null
}

export interface Model {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>
  defaultReasoningEffort: string
}

export interface ModelListResponse {
  data: Model[]
  nextCursor: string | null
}

// ── Threads ─────────────────────────────────────────────────────────────────

export type AskForApproval =
  | 'untrusted'
  | 'on-request'
  | 'never'
  | { granular: { sandbox_approval: boolean; rules: boolean; skill_approval: boolean; request_permissions: boolean; mcp_elicitations: boolean } }

export type ApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent'

/** A thread takes the sandbox as a mode; a turn takes the whole policy (SandboxPolicy). */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'externalSandbox'; networkAccess: boolean }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean }

export type ThreadActiveFlag = 'waitingOnApproval' | 'waitingOnUserInput'

export type ThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: ThreadActiveFlag[] }

export interface Thread {
  id: string
  sessionId: string
  preview: string
  modelProvider: string
  model: string
  reasoningEffort: string | null
  /** Seconds. */
  createdAt: number
  updatedAt: number
  status: ThreadStatus
  /** The rollout file. */
  path: string | null
  cwd: string
  cliVersion: string
  name: string | null
  turns: Turn[]
}

export interface ThreadStartParams {
  model?: string | null
  cwd?: string | null
  approvalPolicy?: AskForApproval | null
  approvalsReviewer?: ApprovalsReviewer | null
  sandbox?: SandboxMode | null
  config?: Record<string, unknown> | null
  baseInstructions?: string | null
  developerInstructions?: string | null
  ephemeral?: boolean | null
}

export interface ThreadStartResponse {
  thread: Thread
  model: string
  modelProvider: string
  cwd: string
  approvalPolicy: AskForApproval
  approvalsReviewer: ApprovalsReviewer
  sandbox: SandboxPolicy
  reasoningEffort: string | null
}

export interface ThreadResumeParams {
  threadId: string
  model?: string | null
  cwd?: string | null
  approvalPolicy?: AskForApproval | null
  approvalsReviewer?: ApprovalsReviewer | null
  sandbox?: SandboxMode | null
  config?: Record<string, unknown> | null
  baseInstructions?: string | null
  developerInstructions?: string | null
  /** Without it the answer carries every turn, and the server calls that deprecated. */
  excludeTurns?: boolean
}

export type ThreadResumeResponse = ThreadStartResponse

// ── Turns ───────────────────────────────────────────────────────────────────

export type ImageDetail = 'auto' | 'low' | 'high' | 'original'

export type UserInput =
  | { type: 'text'; text: string; text_elements: Array<{ byteRange: { start: number; end: number }; placeholder: string | null }> }
  | { type: 'image'; url?: string; fileId?: string; detail?: ImageDetail }
  | { type: 'localImage'; path: string; detail?: ImageDetail }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string }

export type TurnStatus = 'inProgress' | 'completed' | 'interrupted' | 'failed'

export interface TurnError {
  message: string
  /** A name ("usageLimitExceeded") or an object around one. */
  codexErrorInfo: unknown
  additionalDetails: string | null
}

export type TurnItemsView = 'notLoaded' | 'summary' | 'full'

export interface Turn {
  id: string
  items: ThreadItem[]
  itemsView: TurnItemsView
  status: TurnStatus
  error: TurnError | null
  /** Seconds. */
  startedAt: number | null
  completedAt: number | null
  durationMs: number | null
}

export interface TurnStartParams {
  threadId: string
  input: UserInput[]
  /** Comes back as the user message item's `clientId`. */
  clientUserMessageId?: string | null
  cwd?: string | null
  approvalPolicy?: AskForApproval | null
  approvalsReviewer?: ApprovalsReviewer | null
  sandboxPolicy?: SandboxPolicy | null
  /** A model or effort given here stays for the turns after it. */
  model?: string | null
  effort?: string | null
  summary?: 'auto' | 'concise' | 'detailed' | 'none' | null
}

export interface TurnStartResponse {
  turn: Turn
}

export interface TurnInterruptParams {
  threadId: string
  turnId: string
}

export type TurnInterruptResponse = Record<string, never>

// ── History ─────────────────────────────────────────────────────────────────

/** Works on a thread that is not loaded: no resume, no process state. */
export interface ThreadTurnsListParams {
  threadId: string
  cursor?: string | null
  limit?: number | null
  /** Left out: newest turn first. */
  sortDirection?: 'asc' | 'desc' | null
  /** Left out: "summary", the user's message and the final answer only. */
  itemsView?: TurnItemsView | null
}

export interface ThreadTurnsListResponse {
  data: Turn[]
  /** Null: no more turns. */
  nextCursor: string | null
  backwardsCursor: string | null
}

// ── Items ───────────────────────────────────────────────────────────────────

export type MessagePhase = 'commentary' | 'partial_answer' | 'final_answer'

/** How the CLI read a shell command: one entry per piped part. */
export interface CommandAction {
  type: 'read' | 'listFiles' | 'search' | 'unknown'
  command: string
}

export type CommandExecutionStatus = 'inProgress' | 'completed' | 'failed' | 'declined'
export type PatchApplyStatus = 'inProgress' | 'completed' | 'failed' | 'declined'
export type McpToolCallStatus = 'inProgress' | 'completed' | 'failed'

export interface FileUpdateChange {
  path: string
  kind: { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null }
  diff: string
}

export type WebSearchAction =
  | { type: 'search'; query: string | null; queries: string[] | null }
  | { type: 'openPage'; url: string | null }
  | { type: 'findInPage'; url: string | null; pattern: string | null }
  | { type: 'other' }

export interface UserMessageItem {
  type: 'userMessage'
  id: string
  /** The `clientUserMessageId` of the turn/start that sent it. */
  clientId: string | null
  content: UserInput[]
}

export interface AgentMessageItem {
  type: 'agentMessage'
  id: string
  text: string
  /** Null: the model does not say. */
  phase: MessagePhase | null
}

export interface ReasoningItem {
  type: 'reasoning'
  id: string
  summary: string[]
  content: string[]
}

export interface CommandExecutionItem {
  type: 'commandExecution'
  id: string
  command: string
  cwd: string
  status: CommandExecutionStatus
  commandActions: CommandAction[]
  /** stdout and stderr together. */
  aggregatedOutput: string | null
  exitCode: number | null
  durationMs: number | null
}

export interface FileChangeItem {
  type: 'fileChange'
  id: string
  changes: FileUpdateChange[]
  status: PatchApplyStatus
}

export interface McpToolCallItem {
  type: 'mcpToolCall'
  id: string
  server: string
  tool: string
  status: McpToolCallStatus
  arguments: unknown
  result: { content: unknown[]; structuredContent: unknown } | null
  error: { message: string } | null
  durationMs: number | null
}

export interface WebSearchItem {
  type: 'webSearch'
  id: string
  query: string
  action: WebSearchAction | null
}

export interface ContextCompactionItem {
  type: 'contextCompaction'
  id: string
}

export type CollabAgentTool =
  | 'spawnAgent' | 'sendInput' | 'resumeAgent' | 'wait' | 'closeAgent' | 'sendMessage' | 'followupTask' | 'interruptAgent' | 'listAgents'

export type CollabAgentStatus = 'pendingInit' | 'running' | 'interrupted' | 'completed' | 'errored' | 'shutdown' | 'notFound'

/** A call of one of the agent's tools for its subagents. A subagent is a thread of its own, its id in `receiverThreadIds`. */
export interface CollabAgentToolCallItem {
  type: 'collabAgentToolCall'
  id: string
  tool: CollabAgentTool
  status: 'inProgress' | 'completed' | 'failed' | 'interrupted'
  senderThreadId: string
  /** For spawnAgent: the new subagent's thread. */
  receiverThreadIds: string[]
  prompt: string | null
  model: string | null
  reasoningEffort: string | null
  agentsStates: Record<string, { status: CollabAgentStatus; message: string | null } | undefined>
}

/**
 * Something that happened to a subagent, in its parent's thread: started, interacted, interrupted, completed.
 * `agentPath` names it ("/root/list_entries"); its own work runs in the thread `agentThreadId`.
 */
export interface SubAgentActivityItem {
  type: 'subAgentActivity'
  id: string
  kind: 'started' | 'interacted' | 'interrupted' | 'completed'
  agentThreadId: string
  agentPath: string
  model: string | null
  reasoningEffort: string | null
}

/** The item kinds the runtime reads. Every item also carries `startedAtMs` and `completedAtMs`. */
export type ThreadItem =
  | UserMessageItem
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | WebSearchItem
  | ContextCompactionItem
  | CollabAgentToolCallItem
  | SubAgentActivityItem

// ── Notifications (server → client) ─────────────────────────────────────────

export interface TokenUsageBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export type McpServerStartupState = 'starting' | 'ready' | 'failed' | 'cancelled'

/** By method. All of a turn carry `threadId` and `turnId`. */
export interface ServerNotifications {
  'turn/started': { threadId: string; turn: Turn }
  /** `turn.items` is the summary view here: the final answer only. */
  'turn/completed': { threadId: string; turn: Turn }
  'item/started': { item: ThreadItem; threadId: string; turnId: string; startedAtMs: number }
  'item/completed': { item: ThreadItem; threadId: string; turnId: string; completedAtMs: number }
  'item/agentMessage/delta': { threadId: string; turnId: string; itemId: string; delta: string }
  'item/reasoning/summaryPartAdded': { threadId: string; turnId: string; itemId: string; summaryIndex: number }
  'item/reasoning/summaryTextDelta': { threadId: string; turnId: string; itemId: string; delta: string; summaryIndex: number }
  'item/reasoning/textDelta': { threadId: string; turnId: string; itemId: string; delta: string; contentIndex: number }
  /** One per model request: `last` is that request, `total` the thread so far. */
  'thread/tokenUsage/updated': {
    threadId: string
    turnId: string
    tokenUsage: { total: TokenUsageBreakdown; last: TokenUsageBreakdown; modelContextWindow: number | null }
  }
  'thread/status/changed': { threadId: string; status: ThreadStatus }
  error: { error: TurnError; willRetry: boolean; threadId: string; turnId: string }
  'mcpServer/startupStatus/updated': {
    threadId: string | null
    name: string
    status: McpServerStartupState
    error: string | null
    failureReason: string | null
  }
  /** A server request is over: answered by this client, or taken back. */
  'serverRequest/resolved': { threadId: string; requestId: RequestId }
  /** Output of a running command as it comes; the item's `aggregatedOutput` at its end holds all of it. */
  'item/commandExecution/outputDelta': { threadId: string; turnId: string; itemId: string; delta: string }
  /** A sign-in started with `mcpServer/oauth/login` is over. */
  'mcpServer/oauthLogin/completed': { name: string; threadId: string | null; loginId?: string | null; success: boolean; error?: string }
}

export type ServerNotificationMethod = keyof ServerNotifications

// ── Requests (server → client) and their answers ────────────────────────────

export type CommandExecutionApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: unknown } }

export interface CommandExecutionRequestApprovalParams {
  kind?: 'command' | 'humanCommand' | 'writeStdin'
  threadId: string
  turnId: string
  itemId: string
  /** Set when one item asks more than once. */
  approvalId?: string | null
  reason?: string | null
  networkApprovalContext?: { host: string; protocol: string } | null
  command?: string | null
  cwd?: string | null
  commandActions?: CommandAction[] | null
  /** The command prefix an "accept with amendment" would allow from now on. */
  proposedExecpolicyAmendment?: string[] | null
  /**
   * What the client may offer, in order. Only the experimental schema of 0.172.0 names
   * the field, but the server sends it without that capability.
   */
  availableDecisions?: CommandExecutionApprovalDecision[] | null
}

export interface CommandExecutionRequestApprovalResponse {
  decision: CommandExecutionApprovalDecision
}

export type FileChangeApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

export interface FileChangeRequestApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  reason?: string | null
  grantRoot?: string | null
}

export interface FileChangeRequestApprovalResponse {
  decision: FileChangeApprovalDecision
}

export interface AdditionalFileSystemPermissions {
  read: string[] | null
  write: string[] | null
}

export interface PermissionsRequestApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  cwd: string
  reason: string | null
  permissions: { network: { enabled: boolean | null } | null; fileSystem: AdditionalFileSystemPermissions | null }
}

/** `permissions`: the part of what was asked for that is granted; empty grants nothing. */
export interface PermissionsRequestApprovalResponse {
  permissions: { network?: { enabled: boolean | null }; fileSystem?: AdditionalFileSystemPermissions }
  scope: 'turn' | 'session'
}

/** One question of `item/tool/requestUserInput`. `options` null: the answer is free text. */
export interface ToolRequestUserInputQuestion {
  id: string
  header: string
  question: string
  /** An answer of the user's own words is welcome beside the options. */
  isOther: boolean
  isSecret: boolean
  options: Array<{ label: string; description: string }> | null
}

/** Marked experimental in the generated types, but part of the stable request list. */
export interface ToolRequestUserInputParams {
  threadId: string
  turnId: string
  itemId: string
  questions: ToolRequestUserInputQuestion[]
  isBlocking: boolean
}

/** The answers by question id. */
export interface ToolRequestUserInputResponse {
  answers: Record<string, { answers: string[] }>
}

/** By method. */
export interface ServerRequests {
  'item/commandExecution/requestApproval': { params: CommandExecutionRequestApprovalParams; result: CommandExecutionRequestApprovalResponse }
  'item/fileChange/requestApproval': { params: FileChangeRequestApprovalParams; result: FileChangeRequestApprovalResponse }
  'item/permissions/requestApproval': { params: PermissionsRequestApprovalParams; result: PermissionsRequestApprovalResponse }
  'item/tool/requestUserInput': { params: ToolRequestUserInputParams; result: ToolRequestUserInputResponse }
}

export type ServerRequestMethod = keyof ServerRequests

export type ApprovalResponse = ServerRequests[Exclude<ServerRequestMethod, 'item/tool/requestUserInput'>]['result']

export type ServerRequestResponse = ServerRequests[ServerRequestMethod]['result']

// ── Tool servers ────────────────────────────────────────────────────────────

/** `null`: not known (no thread named, or its configuration changed). */
export type McpServerConnectionStatus = 'notStarted' | 'starting' | 'connected' | 'authenticationRequired' | 'failed' | 'cancelled' | 'disabled'

export type McpAuthStatus = 'unknown' | 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth'

export interface ListMcpServerStatusParams {
  cursor?: string | null
  limit?: number | null
  /** Left out: "full", every resource and template as well. */
  detail?: 'full' | 'toolsAndAuthOnly' | null
  /** With it, the thread's own connections and their state. */
  threadId?: string | null
  serverName?: string | null
}

/** One tool server, as the server reports it: the parts read here. */
export interface McpServerStatus {
  name: string
  runtimeStatus: McpServerConnectionStatus | null
  pluginId: string | null
  /** The endpoint's origin, without credentials or path; null for a process on this machine. */
  httpOrigin: string | null
  tools: Record<string, unknown>
  /** Tool discovery failed; null when a catalog came back. */
  toolsError: string | null
  authStatus: McpAuthStatus
}

export interface ListMcpServerStatusResponse {
  data: McpServerStatus[]
  nextCursor: string | null
}

export interface McpServerOauthLoginParams {
  name: string
  threadId?: string | null
}

/** Completion comes as `mcpServer/oauthLogin/completed`, with the same `loginId`. */
export interface McpServerOauthLoginResponse {
  authorizationUrl: string
  loginId?: string
}

/** Adds input to the running turn; refused when `expectedTurnId` is not the one running. */
export interface TurnSteerParams {
  threadId: string
  input: UserInput[]
  expectedTurnId: string
}

// ── Requests (client → server) ──────────────────────────────────────────────

/** By method. After `initialize` the client sends the notification `initialized`. */
export interface ClientRequests {
  initialize: { params: InitializeParams; result: InitializeResponse }
  'model/list': { params: ModelListParams; result: ModelListResponse }
  'thread/start': { params: ThreadStartParams; result: ThreadStartResponse }
  'thread/resume': { params: ThreadResumeParams; result: ThreadResumeResponse }
  'thread/turns/list': { params: ThreadTurnsListParams; result: ThreadTurnsListResponse }
  'turn/start': { params: TurnStartParams; result: TurnStartResponse }
  'turn/interrupt': { params: TurnInterruptParams; result: TurnInterruptResponse }
  'turn/steer': { params: TurnSteerParams; result: { turnId: string } }
  'mcpServerStatus/list': { params: ListMcpServerStatusParams; result: ListMcpServerStatusResponse }
  /** Reads the tool servers' configuration again; a loaded thread connects anew at its next turn. */
  'config/mcpServer/reload': { params: undefined; result: Record<string, never> }
  /** Only for a server over streamable HTTP. */
  'mcpServer/oauth/login': { params: McpServerOauthLoginParams; result: McpServerOauthLoginResponse }
  /** The hooks a loaded thread runs, each with whether the user trusted it. */
  'hooks/list': { params: HooksListParams; result: HooksListResponse }
}

/**
 * Whether a hook runs: app-server runs a hook of the user's own files only once its current text was trusted
 * (`hooks.state."<key>".trusted_hash` in config.toml, which Codex's terminal writes on "Trust all" and the cockpit for
 * its own hooks, hook-trust.ts); it never asks.
 */
export type HookTrustStatus = 'managed' | 'untrusted' | 'trusted' | 'modified'

export interface HooksListParams {
  /** A loaded thread's hooks; without it, those of `cwds`. */
  threadId?: string | null
  cwds?: string[]
}

export interface HookMetadata {
  key: string
  eventName: string
  sourcePath: string
  enabled: boolean
  trustStatus: HookTrustStatus
}

export interface HooksListResponse {
  data: Array<{ cwd: string; hooks: HookMetadata[] }>
}

export type ClientRequestMethod = keyof ClientRequests

/** A request answered with an error the client has no handler for: JSON-RPC's "method not found". */
export const METHOD_NOT_FOUND = -32601
