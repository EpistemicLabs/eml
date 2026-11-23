import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { SpawnRequest } from './domain/spawn-request.js'

export type { SpawnRequest }

/**
 * Worker-session requests from running sessions (`cockpit-spawn`, skill
 * spawn-session). A request waits here and goes to every open tab over
 * /api/events; the first tab that claims it opens the pane next to the
 * requesting session with the prompt as the session's first message. A
 * request from a session that no tab claims in time is started by the host
 * itself, without a pane (worker-start.ts). The host's own requests (sign-in,
 * getting started, brain hygiene) wait for a tab. In memory only: a host
 * restart drops unclaimed requests (the requester is gone with it anyway).
 */

const MAX_AGE_MS = 24 * 60 * 60 * 1000

export class SpawnQueue extends EventEmitter {
  private pending = new Map<string, SpawnRequest>()
  private tabs = 0

  /** An open tab follows the requests (/api/events); call the returned function when it leaves. */
  watch(): () => void {
    this.tabs += 1
    let left = false
    return () => {
      if (left) return
      left = true
      this.tabs -= 1
    }
  }

  /** How many tabs follow the requests right now. */
  watchers(): number {
    return this.tabs
  }

  /** `id`: chosen by the caller when it has to know the worker's session id first (a job's run). */
  add(input: Omit<SpawnRequest, 'id' | 'createdAt'> & { id?: string }): SpawnRequest {
    this.prune()
    const request: SpawnRequest = { ...input, id: input.id ?? randomUUID(), createdAt: new Date().toISOString() }
    this.pending.set(request.id, request)
    this.emit('spawn', request)
    return request
  }

  list(): SpawnRequest[] {
    this.prune()
    return [...this.pending.values()]
  }

  /** First claim wins; later claims (another tab) get false. */
  claim(id: string): SpawnRequest | null {
    const request = this.pending.get(id)
    if (!request) return null
    this.pending.delete(id)
    this.emit('claimed', id)
    return request
  }

  private prune(): void {
    const cutoff = Date.now() - MAX_AGE_MS
    for (const [id, request] of this.pending) {
      if (Date.parse(request.createdAt) < cutoff) this.pending.delete(id)
    }
  }
}
