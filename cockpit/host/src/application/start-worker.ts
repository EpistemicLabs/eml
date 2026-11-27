import type { AgentProvider } from '../domain/agent-provider.js'
import type { SpawnRequest } from '../domain/spawn-request.js'

/** One way of running workers. Starts one under the request's id; returns why it could not, or null. */
export interface WorkerRunner {
  startWorker(request: SpawnRequest): string | null
}

// A session takes about 420 MB (the agent CLI and its MCP servers). Below this, new workers wait rather than push the machine out of memory.
export const MIN_FREE_MEMORY = 1024 * 1024 * 1024

/**
 * Whether the provider runs this worker through its chat runtime: every worker runs there, one with tool limits only
 * where its chat holds them (capability toolLimits). A worker with limits that does not run in chat does not start at
 * all (StartWorker): a terminal would lose them.
 */
export function workerInChat(provider: Pick<AgentProvider, 'capabilities'>, request: Pick<SpawnRequest, 'toolProfile'>): boolean {
  return !request.toolProfile || provider.capabilities.toolLimits.supported
}

export interface StartWorkerDeps {
  chat: WorkerRunner
  /** Whether the request's provider can run this worker through the chat runtime (workerInChat). */
  runsInChat: (request: SpawnRequest) => boolean
  /** Free memory in bytes; null where the system's number means nothing. */
  freeMemory: () => number | null
  /** As many sessions run as the cap allows (session-limits.ts). */
  atCap?: () => boolean
  /** Stop the quietest session at rest; false when every one is busy (sessionToStopForRoom). */
  makeRoom?: () => boolean
  log: (line: string) => void
}

/** Why a worker with tool limits whose provider's chat cannot hold them does not start. */
export const TOOL_PROFILE_NEEDS_CHAT = 'a tool profile needs the chat runtime'

/**
 * Starts the workers and sessions the cockpit queues: a session's worker, a job's or task's run, a split, the host's
 * own (getting started, brain hygiene). Each runs in the chat on the host from its first moment, and a pane only
 * attaches, so its prompt never depends on a browser. There is no terminal fallback: a chat start that fails is
 * refused with its reason, which reaches the tab that claimed it (spawn-api.ts claim) or the host log.
 */
export class StartWorker {
  constructor(private deps: StartWorkerDeps) {}

  /** Whether the machine has room for another worker: enough free memory, and below the cap or a quiet session made room. */
  hasRoom(): boolean {
    const free = this.deps.freeMemory()
    if (free !== null && free < MIN_FREE_MEMORY) return false
    return !this.deps.atCap?.() || this.deps.makeRoom?.() === true
  }

  /** Starts it in the chat, with a tab that took it or without one. Returns why it could not start, or null. */
  start(request: SpawnRequest): string | null {
    const problem = this.deps.runsInChat(request) ? this.deps.chat.startWorker(request) : TOOL_PROFILE_NEEDS_CHAT
    if (problem) this.deps.log(`[worker] ${request.id} could not start: ${problem}`)
    return problem
  }
}
