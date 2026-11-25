import type { DeliveryOutcome } from '../domain/session-delivery.js'
import { newSessionReason, ownSessionOf, type SessionOnTaskFacts } from '../domain/own-session.js'
import type { SessionLedger } from '../session-ledger.js'
import { stepPrompt, type RunnerStep } from './task-runner.js'

/**
 * Handovers keep the task's own session (decision session-kind-follows-task-delegate, domain/own-session.ts):
 * which session that is, whether a delegation continues it, and giving it the start prompt.
 *
 * Continuing a session starts a new run of it (application/run-records.ts): the ledger records when, from just before
 * the prompt went out, so the run's start is after the delegation's request and closes it.
 */

export interface ContinueSessionDeps {
  ledger: Pick<SessionLedger, 'list' | 'get' | 'startRun'>
  /** How full the session's context is, from its provider's summary; null when unknown. */
  contextTokensOf(sessionId: string): number | null
  /** The owner chose Start fresh in the task's latest Delegate now (application/task-commands.ts startFresh). */
  startFresh(taskId: string): boolean
  /** Give the session a message, resuming it when stopped (application/deliver-message.ts). */
  deliver(sessionId: string, text: string): Promise<DeliveryOutcome>
  /** A run started: the run records write it soon. */
  runStarted(): void
  now(): number
}

export interface ContinueSession {
  /** The task's own open session, with its context read for that one session only; null when it has none. */
  ownSession(taskId: string): SessionOnTaskFacts | null
  /** The session a delegation of the task continues, or null to start a new one. */
  toContinue(taskId: string): string | null
  /** For the board: the task's own session, and whether a delegation would continue it. */
  boardView(taskId: string): { sessionId: string; continues: boolean } | null
  /** Give the session the step's start prompt and start its new run; an error text when it did not take it. */
  resume(sessionId: string, step: RunnerStep): Promise<string | null>
}

export function createContinueSession(deps: ContinueSessionDeps): ContinueSession {
  const ownSession = (taskId: string): SessionOnTaskFacts | null => {
    const own = ownSessionOf(deps.ledger.list().map((e) => ({
      sessionId: e.sessionId, taskId: e.taskId, createdAt: e.createdAt, archived: Boolean(e.archivedAt),
      parentSessionId: e.parentSessionId, jobId: e.jobId, runtime: e.runtime, contextTokens: null,
    })), taskId)
    return own ? { ...own, contextTokens: deps.contextTokensOf(own.sessionId) } : null
  }
  return {
    ownSession,
    toContinue(taskId) {
      const own = ownSession(taskId)
      return own && newSessionReason(own, deps.startFresh(taskId)) === null ? own.sessionId : null
    },
    boardView(taskId) {
      const own = ownSession(taskId)
      if (!own) return null
      return { sessionId: own.sessionId, continues: newSessionReason(own, false) === null }
    },
    async resume(sessionId, step) {
      const at = new Date(deps.now()).toISOString()
      const outcome = await deps.deliver(sessionId, stepPrompt({ ...step, continued: true }, step.checkpoint))
      if (outcome !== 'delivered' && outcome !== 'resumed') return `the session did not take the start prompt (${outcome})`
      deps.ledger.startRun(sessionId, at)
      deps.runStarted()
      return null
    },
  }
}
