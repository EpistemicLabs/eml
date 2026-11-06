import type { SessionRuntimeKind } from '../domain/session-runtime.js'
import type { SpawnRequest } from '../domain/spawn-request.js'

/** One way of running workers. Starts one under the request's id; returns why it could not, or null. */
export interface WorkerRunner {
  startWorker(request: SpawnRequest): string | null
}

// A session takes about 420 MB (the agent CLI and its MCP servers). Below this, new workers wait rather than push the machine out of memory.
export const MIN_FREE_MEMORY = 1024 * 1024 * 1024

export interface StartWorkerDeps {
  chat: WorkerRunner
  terminal: WorkerRunner
  /** Whether the request's provider runs this worker through the chat runtime. */
  runsInChat: (request: SpawnRequest) => boolean
  /** Free memory in bytes; null where the system's number means nothing. */
  freeMemory: () => number | null
  /** As many sessions run as the cap allows (session-limits.ts). */
  atCap?: () => boolean
  /** Stop the quietest session at rest; false when every one is busy (sessionToStopForRoom). */
  makeRoom?: () => boolean
  log: (line: string) => void
}

/**
 * Starts the workers sessions ask for. A chat worker runs on the host from its first
 * moment and a pane only attaches, so its prompt never depends on a browser. The
 * host's own requests (sign-in, getting started, hygiene) need a person at a
 * terminal and stay there.
 */
export class StartWorker {
  constructor(private deps: StartWorkerDeps) {}

  private inChat(request: SpawnRequest): boolean {
    return request.fromSessionId !== null && this.deps.runsInChat(request)
  }

  /** Whether the machine has room for another worker: enough free memory, and below the cap or a quiet session made room. */
  hasRoom(): boolean {
    const free = this.deps.freeMemory()
    if (free !== null && free < MIN_FREE_MEMORY) return false
    return !this.deps.atCap?.() || this.deps.makeRoom?.() === true
  }

  /**
   * A tab took the request. `terminal`: the pane starts the worker itself, with the
   * prompt. Null: it could not start. A worker with a tool profile has no fallback:
   * a pane's start would lose its limits.
   */
  forPane(request: SpawnRequest): SessionRuntimeKind | null {
    if (!this.inChat(request)) return request.toolProfile ? null : 'terminal'
    const problem = this.deps.chat.startWorker(request)
    if (!problem) return 'sdk'
    if (request.toolProfile) {
      this.deps.log(`[worker] ${request.id} could not start: ${problem}`)
      return null
    }
    this.deps.log(`[worker] ${request.id} stays in the terminal: ${problem}`)
    return 'terminal'
  }

  /** No tab took it: the host runs it without a pane. Returns why it could not start, or null. */
  withoutPane(request: SpawnRequest): string | null {
    if (!this.inChat(request)) return request.toolProfile ? 'a tool profile needs the chat runtime' : this.deps.terminal.startWorker(request)
    const problem = this.deps.chat.startWorker(request)
    if (!problem || request.toolProfile) return problem
    this.deps.log(`[worker] ${request.id} goes to the terminal: ${problem}`)
    return this.deps.terminal.startWorker(request)
  }
}
