import { EventEmitter } from 'node:events'
import type { TurnState } from './domain/agent-provider.js'

/**
 * Per-session turn state, fed by the session hooks of the agent provider
 * (delivered to POST /api/hook, read by the provider's turnSignal):
 *
 *   working   the user sent a prompt, the agent is on it
 *   done      the assistant turn finished
 *   waiting   the agent stopped and needs the human (permission, question)
 *
 * The PTY registry only knows whether the process lives; this is what the
 * header badges, the sidebar dot and browser notifications hang on.
 * In-memory: a host restart resets everything to idle, which is correct —
 * nothing is running then.
 */

export type { TurnState }

export interface TurnInfo {
  state: TurnState
  since: string
}

export interface TurnEvent extends TurnInfo {
  sessionId: string
}

export class TurnTracker extends EventEmitter {
  private turns = new Map<string, TurnInfo>()
  private pending = new Map<string, NodeJS.Timeout>()

  get(sessionId: string): TurnInfo | undefined {
    return this.turns.get(sessionId)
  }

  snapshot(): TurnEvent[] {
    return [...this.turns].map(([sessionId, info]) => ({ sessionId, ...info }))
  }

  /**
   * A session changed turn state (a provider's hook signal, resolved to the
   * cockpit's session id). With `settleMs` the change only takes effect if the
   * session sends nothing else for that long — for a state that often resolves
   * by itself within moments and would otherwise flicker (and notify).
   */
  apply(change: { sessionId: string; state: Exclude<TurnState, 'idle'>; settleMs?: number }): void {
    this.cancelPending(change.sessionId)
    if (!change.settleMs) {
      this.set(change.sessionId, change.state)
      return
    }
    const timer = setTimeout(() => {
      this.pending.delete(change.sessionId)
      this.set(change.sessionId, change.state)
    }, change.settleMs)
    timer.unref()
    this.pending.set(change.sessionId, timer)
  }

  private cancelPending(sessionId: string): void {
    const timer = this.pending.get(sessionId)
    if (!timer) return
    clearTimeout(timer)
    this.pending.delete(sessionId)
  }

  private set(sessionId: string, state: Exclude<TurnState, 'idle'>): TurnEvent {
    const change = { sessionId, state }
    const info: TurnInfo = { state: change.state, since: new Date().toISOString() }
    this.turns.set(change.sessionId, info)
    const event: TurnEvent = { sessionId: change.sessionId, ...info }
    this.emit('turn', event)
    return event
  }

  /** A hook the host has no state for — listeners log it so new ones can be classified. */
  note(label: string): void {
    this.emit('notification', label)
  }

  /** Session gone (deleted / PTY killed): back to idle. */
  forget(sessionId: string): void {
    this.cancelPending(sessionId)
    if (!this.turns.delete(sessionId)) return
    this.emit('turn', { sessionId, state: 'idle', since: new Date().toISOString() } satisfies TurnEvent)
  }
}
