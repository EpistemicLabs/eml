import type { SpawnQueue, SpawnRequest } from './spawn-queue.js'
import type { WorkerTurnOf } from './pty-bridge.js'

/**
 * Workers start without a cockpit tab. A worker a session asked for goes to the
 * open tabs first (spawn-queue.ts); when no tab follows the requests, or none
 * claims it within GRACE_MS, the host claims it and starts it without a pane
 * (PtyBridge.startWorker). It shows in the sidebar like any session, and with
 * Remote Control in the Claude app; a pane opened later takes it over.
 *
 * Two limits keep pane-less workers from piling up:
 *   - at most MAX_UNATTENDED run without a client. A further request makes room:
 *     the worker quiet the longest (no turn, no client) is ended once it has
 *     been quiet for MIN_QUIET_MS, a done one before one waiting for a
 *     permission, a working one never. Otherwise the request waits in the queue.
 *     MIN_QUIET_MS leaves time for a reply, which only reaches a running session.
 *   - one that is not working and has been quiet for IDLE_MS is ended.
 * An ended worker stays in the sidebar, resumable with a click.
 * The host's own requests (no requesting session) always wait for a tab.
 */

export const GRACE_MS = 15_000
export const MAX_UNATTENDED = 3
export const IDLE_MS = 24 * 60 * 60 * 1000
export const MIN_QUIET_MS = 60 * 60 * 1000
const SWEEP_MS = 60_000

export interface WorkerBridge {
  startWorker(request: SpawnRequest): string | null
  unattendedWorkers(): number
  sweepIdleWorkers(idleMs: number, turnOf: WorkerTurnOf): number
  evictQuietWorker(minQuietMs: number, turnOf: WorkerTurnOf): boolean
}

export interface WorkerStartDeps {
  spawns: SpawnQueue
  bridge: WorkerBridge
  /** The turn state of a session (turn-state.ts) and since when it holds. */
  turnOf: WorkerTurnOf
  log: (line: string) => void
  graceMs?: number
  maxUnattended?: number
  idleMs?: number
  minQuietMs?: number
  sweepMs?: number
  now?: () => number
}

export class WorkerStarter {
  private timer: NodeJS.Timeout | null = null
  private readonly graceMs: number
  private readonly maxUnattended: number
  private readonly idleMs: number
  private readonly minQuietMs: number
  private readonly now: () => number

  constructor(private deps: WorkerStartDeps) {
    this.graceMs = deps.graceMs ?? GRACE_MS
    this.maxUnattended = deps.maxUnattended ?? MAX_UNATTENDED
    this.idleMs = deps.idleMs ?? IDLE_MS
    this.minQuietMs = deps.minQuietMs ?? MIN_QUIET_MS
    this.now = deps.now ?? Date.now
  }

  /** Follow new requests and check the queue and idle workers every SWEEP_MS. */
  start(): void {
    this.deps.spawns.on('spawn', (request: SpawnRequest) => {
      if (!request.fromSessionId) return
      if (this.deps.spawns.watchers() === 0) this.tick()
      else setTimeout(() => this.tick(), this.graceMs).unref()
    })
    this.timer = setInterval(() => this.tick(), this.deps.sweepMs ?? SWEEP_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** End idle workers, then start the requests that are due, oldest first, up to the cap. */
  tick(): void {
    const ended = this.deps.bridge.sweepIdleWorkers(this.idleMs, this.deps.turnOf)
    if (ended > 0) this.deps.log(`[worker] ended ${ended} idle worker(s) without a client`)
    const noTabs = this.deps.spawns.watchers() === 0
    const due = this.deps.spawns.list()
      .filter((request) => request.fromSessionId)
      .filter((request) => noTabs || this.now() - Date.parse(request.createdAt) >= this.graceMs)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const request of due) {
      if (this.deps.bridge.unattendedWorkers() >= this.maxUnattended && !this.deps.bridge.evictQuietWorker(this.minQuietMs, this.deps.turnOf)) {
        this.deps.log(`[worker] ${this.deps.bridge.unattendedWorkers()} workers run without a client, none quiet long enough; ${request.id} waits`)
        return
      }
      if (!this.deps.spawns.claim(request.id)) continue
      const problem = this.deps.bridge.startWorker(request)
      if (problem) this.deps.log(`[worker] could not start ${request.id}: ${problem}`)
      else this.deps.log(`[worker] started ${request.id} without a pane (no tab took it)`)
    }
  }
}
