import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { ProviderId } from './domain/agent-provider.js'

/**
 * Worker-session requests from running sessions (`cockpit-spawn`, skill
 * spawn-session). The host cannot open a pane itself — a PTY belongs to a
 * browser pane — so a request waits here, goes to every open tab over
 * /api/events, and the first tab that claims it opens the pane next to the
 * requesting session with the prompt as the session's first message. With no
 * tab open it simply waits until one connects. In memory only: a host restart
 * drops unclaimed requests (the requester is gone with it anyway).
 */

export interface SpawnRequest {
  /** Also the worker's session id: the page opens the pane under it (spawn-api.ts returns the worker's address from it). */
  id: string
  /** Registry project id the worker runs in (`bp-<brain id>` or a folder id). */
  projectId: string
  prompt: string
  title: string | null
  /** The agent CLI the worker runs with (a provider id); unset → the user's default. */
  provider?: ProviderId
  /** The requesting session — the worker opens on its desk, next to its pane. */
  fromSessionId: string | null
  /** The brain space the worker runs in (the requester's). Absent = main (the host's own spawns, onboarding.ts). */
  spaceId?: string
  /**
   * 'replace-empty-desk' (first run, onboarding.ts): if the active desk holds
   * only its untouched starting terminal, the pane takes its place and the
   * cockpit switches to the desk. Default: added next to the requester.
   */
  placement?: 'append' | 'replace-empty-desk'
  createdAt: string
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000

export class SpawnQueue extends EventEmitter {
  private pending = new Map<string, SpawnRequest>()

  add(input: Omit<SpawnRequest, 'id' | 'createdAt'>): SpawnRequest {
    this.prune()
    const request: SpawnRequest = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }
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
