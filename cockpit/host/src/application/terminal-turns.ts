import type { SaidTurn } from './record-end-turn.js'

/**
 * What a terminal session said with end_turn, between the call and the Stop
 * hook that ends its turn: the hook takes it and hands it on as the turn's
 * call. In memory only: a host that goes down in between loses it, and the
 * turn ends as one without a call.
 */
export class TerminalTurns {
  private turns = new Map<string, SaidTurn>()

  /** The session's call of this turn; a later call in the same turn replaces it. */
  said(sessionId: string, turn: SaidTurn): void {
    this.turns.set(sessionId, turn)
  }

  /** The session's call, once: null when it made none since the last take. */
  take(sessionId: string): SaidTurn | null {
    const turn = this.turns.get(sessionId) ?? null
    this.turns.delete(sessionId)
    return turn
  }

  /** A new turn started, or the session is gone: what it said before no longer stands. */
  forget(sessionId: string): void {
    this.turns.delete(sessionId)
  }
}
