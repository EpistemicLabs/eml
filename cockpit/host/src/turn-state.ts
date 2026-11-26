import { EventEmitter } from 'node:events'
import type { TurnState } from './domain/agent-provider.js'
import type { RunningCommand, WorkflowWait } from './domain/session-runtime.js'

/**
 * Per-session turn state, fed by the session hooks of the agent provider
 * (delivered to POST /api/hook, read by the provider's turnSignal):
 *
 *   working   the user sent a prompt, the agent is on it
 *   done      the assistant turn finished, or the user stopped it
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
  /** Working, but its own turn is over: it waits for this many subagents it started (chat-bridge.ts). */
  helpers?: number
  /** And for these workflow runs it started, with how far their agents are. Absent when none. */
  workflows?: WorkflowWait[]
  /**
   * The background shells it started that still run, in any state: its turn may be over while they
   * do. Display only, they hold nothing. Absent when none.
   */
  commands?: RunningCommand[]
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

  /**
   * A working session's own turn ended and it waits for this many of its subagents and these
   * workflow runs; 0 and none: no longer. Its state and `since` stay, and a change about to take
   * effect (`settleMs`) still does. Any other change ends the wait.
   */
  waitOn(sessionId: string, helpers: number, workflows: WorkflowWait[] = []): void {
    const info = this.turns.get(sessionId)
    if (!info || info.state !== 'working') return
    if ((info.helpers ?? 0) === helpers && JSON.stringify(info.workflows ?? []) === JSON.stringify(workflows)) return
    const next: TurnInfo = {
      state: info.state, since: info.since,
      ...(helpers > 0 ? { helpers } : {}),
      ...(workflows.length > 0 ? { workflows: workflows.map(({ name, running, done }) => ({ name, running, done })) } : {}),
      ...(info.commands ? { commands: info.commands } : {}),
    }
    this.turns.set(sessionId, next)
    this.emit('turn', { sessionId, ...next } satisfies TurnEvent)
  }

  /**
   * The background shells the session started that run now; none: no longer. Its state, `since` and
   * what it waits on stay; the commands stay through later changes of its state until they end.
   */
  commandsOn(sessionId: string, commands: RunningCommand[]): void {
    const info = this.turns.get(sessionId)
    if (!info) return
    if (JSON.stringify(info.commands ?? []) === JSON.stringify(commands)) return
    const next: TurnInfo = { ...info }
    if (commands.length > 0) next.commands = commands.map(({ description, since }) => ({ description, since }))
    else delete next.commands
    this.turns.set(sessionId, next)
    this.emit('turn', { sessionId, ...next } satisfies TurnEvent)
  }

  private cancelPending(sessionId: string): void {
    const timer = this.pending.get(sessionId)
    if (!timer) return
    clearTimeout(timer)
    this.pending.delete(sessionId)
  }

  private set(sessionId: string, state: Exclude<TurnState, 'idle'>): TurnEvent {
    const change = { sessionId, state }
    const commands = this.turns.get(sessionId)?.commands
    const info: TurnInfo = { state: change.state, since: new Date().toISOString(), ...(commands ? { commands } : {}) }
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
