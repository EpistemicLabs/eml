import type { EndTurnRecorded } from '../domain/session-runtime.js'
import { deriveTurn, missingOf, passedWhen, type CheckTime, type DerivedTurn, type EndTurn, type TurnContext } from '../domain/turn-end.js'
import type { SessionTurn } from './turn-context.js'

/**
 * Records one end_turn call of a session (domain/turn-end.ts): reads it
 * against the session's turn context, refuses a time that has passed, keeps
 * it where the session's kind keeps what it said (a chat on its entry and in
 * the ledger, chat-bridge.ts; a terminal until its Stop hook,
 * terminal-turns.ts), brings the check at next.when in line and says what the
 * tool's answer has to name.
 */

/** A call as it is kept: with the context it was read against and what the cockpit derived from it. */
export interface SaidTurn {
  call: EndTurn
  ctx: TurnContext
  derived: DerivedTurn
}

export interface RecordEndTurnDeps {
  /** Whom the session's call is read against, and its task. */
  turnOf(sessionId: string): Promise<SessionTurn>
  /** The moment a call is read and the zone its next.when is read in (the user's); absent: now, in this machine's zone. */
  callTime?: () => { now: number; zone: string }
  /** Where the recorded call is kept. Called once per recorded call, before the check is set. */
  keep(sessionId: string, said: SaidTurn): void
  /** The check a call's next.when asks for (application/turn-check.ts). Answers why it could not be set, or null. */
  turnCheck?: (sessionId: string, check: { at: string | null; call: EndTurn; turn: SessionTurn }) => Promise<string | null>
  /** The session's check as the schedule saved it (application/turn-check.ts saved). */
  checkSaved?: (sessionId: string) => CheckTime | null
}

/** What the lists show under the session: the question it waits on, why it failed, else where the task stands. */
export const saidReason = (call: EndTurn): string => call.failed ?? call.questions?.[0] ?? call.result

/** Rejects with the reason when nothing was recorded. */
export async function recordEndTurn(deps: RecordEndTurnDeps, sessionId: string, call: EndTurn): Promise<EndTurnRecorded> {
  const turn = await deps.turnOf(sessionId)
  const derived = deriveTurn(call, turn.ctx)
  // A check at a time that has passed wakes nobody: the call is refused whole, so the agent names another.
  // A time that sets no check (a step for the user) is not looked at.
  const time = deps.callTime?.() ?? { now: Date.now(), zone: Intl.DateTimeFormat().resolvedOptions().timeZone }
  const passed = derived.checkAt ? passedWhen(call, time) : null
  if (passed) throw new Error(passed)
  deps.keep(sessionId, { call, ctx: turn.ctx, derived })
  const problem = await deps.turnCheck?.(sessionId, { at: derived.checkAt, call, turn }) ?? null
  const saved = derived.checkAt && !problem ? deps.checkSaved?.(sessionId) ?? null : null
  return {
    derived,
    missing: missingOf(call, { taskOpen: turn.task?.open ?? false, ctx: turn.ctx }),
    ...(problem && derived.checkAt ? { checkProblem: problem } : {}),
    ...(saved ? { checkTime: saved } : {}),
  }
}
