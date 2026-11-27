import type { EndTurnRecorded } from '../domain/session-runtime.js'
import { stateEcho } from '../domain/turn-state-echo.js'
import { deriveTurn, missingOf, passedWhen, storedDue, type DerivedTurn, type EndTurn, type TurnContext, type WakeEdit } from '../domain/turn-end.js'
import type { SessionTurn } from './turn-context.js'
import type { WakeSettled } from './turn-wake.js'

/**
 * Records one end_turn call of a session (domain/turn-end.ts): reads it
 * against the session's turn context, refuses a time that has passed, keeps
 * it where the chat keeps what a session said (on its entry and in the ledger,
 * chat-bridge.ts; a terminal fallback session's is not kept), brings the wake-up of the session's task in line with
 * the call (application/turn-wake.ts) and says what the tool's answer has to name, ending with what the task holds
 * after the call (domain/turn-state-echo.ts).
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
  /** The moment a call is read and the zone its check.when is read in (the user's); absent: now, in this machine's zone. */
  callTime?: () => { now: number; zone: string }
  /**
   * Where the recorded call is kept. Called before the wake-up is settled, so a host going down in between loses
   * nothing; called once more when the task turns out to have a next run, with the context that says so.
   */
  keep(sessionId: string, said: SaidTurn): void
  /**
   * A call's check sets the wake-up of the session's task, check "none" removes it, a call without one keeps it
   * (application/turn-wake.ts settle). Also says what the task's schedule and waits are then, and whether it has a
   * next run from its schedule.
   */
  turnWake?: (sessionId: string, wake: { edit: WakeEdit; call: EndTurn; turn: SessionTurn }) => Promise<WakeSettled>
}

/** What the lists show under the session: the question it waits on, why it failed, else where the task stands. */
export const saidReason = (call: EndTurn): string => call.failed ?? call.questions?.[0] ?? call.result

/** Rejects with the reason when nothing was recorded. */
export async function recordEndTurn(deps: RecordEndTurnDeps, sessionId: string, written: EndTurn): Promise<EndTurnRecorded> {
  const turn = await deps.turnOf(sessionId)
  // The moment the call is read, and the zone its check.when and a due with a time are read in.
  const time = deps.callTime?.() ?? { now: Date.now(), zone: Intl.DateTimeFormat().resolvedOptions().timeZone }
  const call: EndTurn = written.ask?.due ? { ...written, ask: { ...written.ask, due: storedDue(written.ask.due, time.zone) } } : written
  const derived = deriveTurn(call, turn.ctx)
  // A check at a time that has passed wakes nobody: the call is refused whole, so the agent names another.
  const passed = derived.wake.kind === 'set' ? passedWhen(call, time, turn.ctx) : null
  if (passed) throw new Error(passed)
  deps.keep(sessionId, { call, ctx: turn.ctx, derived })
  const wake = await deps.turnWake?.(sessionId, { edit: derived.wake, call, turn }) ?? null
  const taskOpen = turn.task?.open ?? false
  const check = {
    ...(wake?.problem && derived.wake.kind !== 'keep' ? { checkProblem: wake.problem, ...(wake.fix ? { checkFix: wake.fix } : {}) } : {}),
    ...(wake?.saved ? { checkTime: wake.saved } : {}),
  }
  let ctx = turn.ctx
  let final = derived
  if (wake?.nextRun) {
    // The task has a next run from its schedule: an ask for someone else counts without a check, and none is missing.
    ctx = { ...turn.ctx, nextRun: true }
    final = deriveTurn(call, ctx)
    deps.keep(sessionId, { call, ctx, derived: final })
  }
  const state = wake?.task && wake.outcome && wake.zone
    ? stateEcho({
      status: wake.task.status,
      // The task's other waits, and the one this call puts on it (the router writes it as the turn ends).
      waits: [...wake.task.waits.filter((w) => (w.session_id ?? w.id) !== sessionId), ...(final.wait ? [final.wait] : [])],
      schedule: wake.after ?? null, outcome: wake.outcome, zone: wake.zone, now: time.now, people: { me: ctx.owner, owners: wake.task.owners },
    })
    : null
  return {
    derived: final,
    missing: missingOf(call, { taskOpen, ctx, ...(wake?.nextRun ? { nextRun: true } : {}) }),
    ...check,
    ...(wake?.nextRun ? { nextRun: true } : {}),
    ...(state ? { state } : {}),
  }
}
