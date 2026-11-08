import type { SpawnQueue, SpawnRequest } from './spawn-queue.js'
import { unattended } from './domain/spawn-request.js'
import type { WorkerTurnOf } from './pty-bridge.js'
import { IDLE_MS } from './domain/session-lifecycle.js'

/**
 * Workers start without a cockpit tab. A worker a session asked for starts right
 * away without a pane and shows in the sidebar under its parent; a pane opened
 * later joins it. One asked for with `open` goes to the open tabs first
 * (spawn-queue.ts); when no tab follows the requests, or none claims it within
 * GRACE_MS, the host starts that one without a pane too.
 *
 * A terminal worker that is not working and has been quiet for the idle time
 * (Settings › Preferences › Sessions) is ended, and a chat session whose time is up
 * (chatSessionShouldStop) too; a working one never. New workers wait in the
 * queue while the machine has little free memory, or as many sessions run as
 * the cap allows and none is quiet enough to make room.
 * An ended worker stays in the sidebar, resumable with a click.
 * The host's own requests (no requesting session) always wait for a tab.
 */

export const GRACE_MS = 15_000
const SWEEP_MS = 60_000

export interface WorkerBridge {
  startWorker(request: SpawnRequest): string | null
  sweepIdleWorkers(idleMs: number, turnOf: WorkerTurnOf): number
  /** Whether the machine has room for another worker; a request waits while it has not. */
  hasRoom(): boolean
}

export interface WorkerStartDeps {
  spawns: SpawnQueue
  bridge: WorkerBridge
  /** The turn state of a session (turn-state.ts) and since when it holds. */
  turnOf: WorkerTurnOf
  log: (line: string) => void
  graceMs?: number
  /** How long a quiet worker keeps its process; read at every sweep. */
  idleMs?: () => number
  sweepMs?: number
  now?: () => number
}

export class WorkerStarter {
  private timer: NodeJS.Timeout | null = null
  private readonly graceMs: number
  private readonly now: () => number

  constructor(private deps: WorkerStartDeps) {
    this.graceMs = deps.graceMs ?? GRACE_MS
    this.now = deps.now ?? Date.now
  }

  /** Follow new requests and check the queue and idle workers every SWEEP_MS. */
  start(): void {
    this.deps.spawns.on('spawn', (request: SpawnRequest) => {
      if (!unattended(request)) return
      if (!request.open || this.deps.spawns.watchers() === 0) this.tick()
      else setTimeout(() => this.tick(), this.graceMs).unref()
    })
    this.timer = setInterval(() => this.tick(), this.deps.sweepMs ?? SWEEP_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** End idle workers, then start the requests that are due, oldest first, while there is room. */
  tick(): void {
    const ended = this.deps.bridge.sweepIdleWorkers(this.deps.idleMs?.() ?? IDLE_MS, this.deps.turnOf)
    if (ended > 0) this.deps.log(`[worker] stopped ${ended} idle session(s)`)
    const noTabs = this.deps.spawns.watchers() === 0
    const due = this.deps.spawns.list()
      .filter((request) => unattended(request))
      .filter((request) => !request.open || noTabs || this.now() - Date.parse(request.createdAt) >= this.graceMs)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const request of due) {
      if (!this.deps.bridge.hasRoom()) {
        this.deps.log(`[worker] no room (little free memory, or the running cap with every session busy); ${request.id} waits`)
        return
      }
      if (!this.deps.spawns.claim(request.id)) continue
      const problem = this.deps.bridge.startWorker(request)
      if (problem) this.deps.log(`[worker] could not start ${request.id}: ${problem}`)
      else this.deps.log(`[worker] started ${request.id} without a pane (no tab took it)`)
    }
  }
}
