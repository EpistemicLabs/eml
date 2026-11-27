import type { EndTurnRecorded } from '../domain/session-runtime.js'
import { deriveTurn, missingOf, passedWhen, wakeEditOf, type DerivedTurn, type EndTurn, type TurnContext, type WakeEdit } from '../domain/turn-end.js'
import type { SessionTurn } from './turn-context.js'
import type { WakeSettled } from './turn-wake.js'

/**
 * Records one end_turn call of a session (domain/turn-end.ts): reads it
 * against the session's turn context, refuses a time that has passed, keeps
 * it where the chat keeps what a session said (on its entry and in the ledger,
 * chat-bridge.ts; a terminal fallback session's is not kept), brings the wake-up of the session's task in line with
 * the call (application/turn-wake.ts) and says what the tool's answer has to name.
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
  /**
   * Where the recorded call is kept. Called before the wake-up is settled, so a host going down in between loses
   * nothing; called once more when the task turns out to have a next run, with the context that says so.
   */
  keep(sessionId: string, said: SaidTurn): void
  /**
   * A call's next.when sets the wake-up of the session's task; a call without one clears it, by the rule of whose
   * (application/turn-wake.ts settle). Also says whether the task has a next run from its schedule then.
   */
  turnWake?: (sessionId: string, wake: { edit: WakeEdit; call: EndTurn; turn: SessionTurn }) => Promise<WakeSettled>
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
  const wake = await deps.turnWake?.(sessionId, { edit: wakeEditOf(derived), call, turn }) ?? null
  const taskOpen = turn.task?.open ?? false
  const check = {
    ...(wake?.problem && derived.checkAt ? { checkProblem: wake.problem, ...(wake.fix ? { checkFix: wake.fix } : {}) } : {}),
    ...(wake?.saved ? { checkTime: wake.saved } : {}),
  }
  if (!wake?.nextRun) return { derived, missing: missingOf(call, { taskOpen, ctx: turn.ctx }), ...check }
  // The task has a next run from its schedule: a step for someone else counts without a time, and none is missing.
  const ctx: TurnContext = { ...turn.ctx, nextRun: true }
  const withRun = deriveTurn(call, ctx)
  deps.keep(sessionId, { call, ctx, derived: withRun })
  return { derived: withRun, missing: missingOf(call, { taskOpen, ctx, nextRun: true }), ...check, nextRun: true }
}
