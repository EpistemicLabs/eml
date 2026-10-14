/**
 * The agent CLI a cockpit session runs, as the host sees it (ARCHITECTURE.md,
 * "First step: agent providers"). The host owns panes, the ledger, turn state
 * and the brain; everything that differs per CLI — binary, sign-in, isolated
 * config, command line, hooks, transcripts — sits behind this port.
 *
 * Domain layer: types and constants, no I/O. Adapters live in infrastructure/providers/.
 */

export const PROVIDER_IDS = ['claude', 'codex'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

/** Header a session hook sends next to its payload: the cockpit's id of the session it runs in. */
export const HOOK_SESSION_HEADER = 'x-cockpit-session'

export type TurnState = 'idle' | 'working' | 'done' | 'waiting'

/** Header that carries the per-boot hook token to the host's POST /api/hook. */
export const HOOK_TOKEN_HEADER = 'x-cockpit-hook'

/**
 * What the host knows when it writes a provider's isolated config (once per
 * boot). The brain is not part of it: a session's brain is its space's
 * (SessionSpace), and a cockpit has several.
 */
export interface IsolationContext {
  /** POST target for the provider's session hooks, and the per-boot token they send as HOOK_TOKEN_HEADER. */
  hookUrl: string
  hookToken: string
  /**
   * Folders outside a session's project that it must be able to write to
   * (worker requests, task files) — for providers that confine writes.
   */
  writableDirs: string[]
}

/**
 * The brain space a session runs in (brain-space.ts): the brain it talks to
 * and the files the host wrote for the space. A session only ever gets its own
 * space's brain — the token reaches the agent CLI through its config files or
 * the session's environment, never argv.
 */
export interface SessionSpace {
  id: string
  /** Base URL and token of the space's brain. */
  url: string
  token: string
  files: {
    /** The brain MCP server for this space, as Claude Code's --mcp-config takes it. */
    mcpConfig: string
    /** The session hooks for this space, as Claude Code's --settings takes them. */
    settings: string
    /** The EML client config (URL + token) the EML hooks of this space read. */
    emlConfig: string
  }
}

export interface LaunchRequest {
  /** The cockpit's id of the session; a provider that takes its ids from the caller starts under it. */
  sessionId: string
  /** The brain space the session runs in. */
  space: SessionSpace
  /** The provider's own id of the conversation, once known (see SessionRef). */
  providerSessionId: string | null
  /** Continue the provider's stored conversation instead of starting a new one. */
  resume: boolean
  /** First message of a new session (worker spawns, onboarding); null for an empty prompt. */
  initialPrompt: string | null
  /** Nobody is watching this session (a worker): it must not stop to ask for permission. */
  unattended: boolean
}

/** Binary, arguments and the provider's own environment for one session process. */
export interface LaunchSpec {
  bin: string
  args: string[]
  env: Record<string, string>
}

export interface SessionRef {
  /** The cockpit's id: panes, ledger, turn state and the API use this one. */
  sessionId: string
  /**
   * The id the provider itself knows the conversation by, learned from its
   * first hook; null until then. A provider that starts under the cockpit's
   * id reports that same id.
   */
  providerSessionId: string | null
  /** The session's project folder; null for a project without one. */
  projectPath: string | null
}

/** Best-effort display data for the sidebar, read from the provider's transcript. */
export interface SessionSummary {
  /** The first user prompt, shortened. */
  summary: string | null
  /** The title the provider generates for the session itself; null when it has none. */
  aiTitle: string | null
  lastActivity: string | null
  messageCount: number
  /** Timestamp of the last user/assistant message (null before the first turn). */
  lastMessageAt: string | null
  /** Model id of the last assistant message. */
  model: string | null
  /** What the model had in context at the last assistant turn, in tokens. */
  contextTokens: number | null
}

/** A session hook, read by the provider that sent it. */
export type TurnSignal =
  /**
   * The session changed turn state; the id is the provider's own. `settleMs`:
   * the state often resolves by itself within moments — apply it only if the
   * session sends nothing else for that long.
   */
  | { kind: 'turn'; providerSessionId: string; state: Exclude<TurnState, 'idle'>; settleMs?: number }
  /** A hook the host has no state for — logged so new ones can be classified. */
  | { kind: 'unclassified'; label: string }

export interface RuntimeResult {
  at: string
  outcome: 'installed' | 'updated' | 'up_to_date' | 'rolled_back' | 'failed'
  from?: string | null
  to?: string | null
  error?: string
}

/** A cockpit-owned CLI: which version runs, what the last check did. */
export interface RuntimeState {
  channel: string
  autoUpdate: boolean
  current: string | null
  previous: string | null
  /** A version the user rolled back from — the updater won't install it (or older) again. */
  skipVersion: string | null
  lastCheckAt: string | null
  lastResult: RuntimeResult | null
}

/** The provider's CLI, owned by the cockpit: installed into the app home, verified, kept up to date. */
export interface AgentRuntime {
  /** The usable version, or null when sessions cannot start. */
  version(): string | null
  /** Why sessions can't start right now, or null when the runtime is ready. */
  problem(): string | null
  /** What the user does about a problem — shown under it in the pane. */
  readonly problemHint: string
  /** Host start: make the runtime usable if it is not and installs unasked. Never rejects — see lastError(). */
  install(): Promise<void>
  /** The error of the last failed install or update, if that is the current state. */
  lastError(): string | null
  scheduleUpdates(): void
  state(): RuntimeState
  /** Install it, or look for a newer version (Settings › Models › "Check now" / "Set up now"). */
  check(): Promise<RuntimeState>
  /** Back to the previous version; rejects when there is none. */
  rollback(): Promise<RuntimeState>
  setAutoUpdate(autoUpdate: boolean): RuntimeState
}

/** A provider's own user settings (Settings › Models), as a flat record. */
export interface AgentSettings {
  read(): Record<string, boolean | string>
  /** Returns an error message for the UI, or null on success. */
  write(patch: Record<string, unknown>): string | null
}

export interface AgentAuth {
  /**
   * Whether sessions of this provider can talk to their model right now. May
   * answer from a cache: the UI asks often, the answer changes when a session
   * of the provider ends (a sign-in happens inside one) — see invalidate.
   */
  signedIn(): Promise<boolean>
  /** Forget the cached answer: a session of this provider ended, or the user asked for a fresh look. */
  invalidate(): void
}

export interface AgentProvider {
  readonly id: ProviderId
  /** Product name for logs and messages, e.g. "Claude Code". */
  readonly label: string
  /**
   * Whether a new session starts under the cockpit's session id (true), or the
   * provider assigns its own and reports it with the session's first hook (false).
   */
  readonly adoptsSessionId: boolean
  readonly runtime: AgentRuntime
  readonly auth: AgentAuth
  /** Settings of this provider the generic settings UI can show; absent when it has none there. */
  readonly settings?: AgentSettings
  /** Write the isolated config: brain MCP, session hooks, EML hooks, skills. Once per boot, before any launch. */
  prepare(ctx: IsolationContext): void
  /** Let sessions open this folder without the provider's trust prompt. Idempotent. */
  trustProject(projectPath: string): void
  launch(req: LaunchRequest): LaunchSpec
  /** Whether the provider has a stored conversation for this session. */
  canResume(session: SessionRef): boolean
  /** Whether a resumed process that exited at once said it has no such conversation (the host then starts it fresh). */
  resumeNotFound(earlyOutput: string): boolean
  /** Read a hook payload the provider's sessions posted; null when it means nothing to the host. */
  turnSignal(payload: Record<string, unknown>): TurnSignal | null
  summary(session: SessionRef): SessionSummary
  /** Delete the stored conversation (best-effort). */
  deleteTranscript(session: SessionRef): void
}
