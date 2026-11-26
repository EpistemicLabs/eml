import type { EndTurn, TurnContext } from '../domain/turn-end.js'
import type { SessionLedger } from '../session-ledger.js'
import { saidReason, type SaidTurn } from './record-end-turn.js'

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

export interface TerminalTurnEndDeps {
  turns: TerminalTurns
  ledger: Pick<SessionLedger, 'setAttention' | 'setUnrouted'>
  /** The turn's end as the task system takes it (index.ts turnEnded); without `turn`, the reply's Handoff block is read. */
  turnEnded(sessionId: string, text: string, turn?: { call: EndTurn; ctx: TurnContext; reminded: boolean; said: boolean }): void
}

/**
 * A terminal session's Stop hook arrived with its last reply: the turn ends with the call it made, if it made one.
 * The call's flag and the call itself go into the ledger here and not when the tool was called: every later tool
 * of the turn reports the session as working (Codex and Qwen: PostToolUse), which clears a flag and what is kept
 * to route (application/apply-session-hook.ts). The hook's own handling is through by now, so nothing clears them
 * before the next prompt. In the chat's order (chat-bridge.ts): the flag, what is left to route, then the turn's end.
 * A turn without a call ends as it always did.
 */
export function terminalTurnEnded(deps: TerminalTurnEndDeps, sessionId: string, text: string): void {
  const said = deps.turns.take(sessionId)
  if (!said) return deps.turnEnded(sessionId, text)
  // The flag says what the user is asked; the turn still ended as done (decision desk-dot-until-seen).
  deps.ledger.setAttention(sessionId, { kind: said.derived.status, reason: saidReason(said.call) })
  // Kept until the router wrote it into the task, so a host going down right after loses nothing.
  deps.ledger.setUnrouted(sessionId, { call: said.call, ctx: said.ctx })
  deps.turnEnded(sessionId, text, { call: said.call, ctx: said.ctx, reminded: false, said: true })
}
