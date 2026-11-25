/**
 * A task's own session: the conversation a hand-over keeps (decision session-kind-follows-task-delegate).
 * Delegate gives it the task's start prompt instead of starting a new session; Take over opens it.
 *
 * A session is the task's own when it works on that task, is not put away, and is not a helper: a session or a job
 * started it for part of someone's work (it has a parent session or a job). Of several, the newest counts. The
 * conversation that created a task works on its own task, not on the new one, so it never counts.
 *
 * Delegate still starts a new session when there is no own session, when the own session runs in a terminal (typing
 * into a terminal is not safe, application/deliver-message.ts), when its context is very long, or when the owner
 * chose Start fresh.
 */

/** From this many tokens of context on, a session counts as very long: a delegation starts a new one. */
export const LONG_CONTEXT_TOKENS = 120_000

export interface SessionOnTaskFacts {
  sessionId: string
  taskId: string | null
  createdAt: string
  archived: boolean
  parentSessionId: string | null
  jobId: string | null
  runtime: 'terminal' | 'sdk'
  /** The context its conversation fills, from the provider's session summary; null when unknown. */
  contextTokens: number | null
}

/** The task's newest own open session, or null. */
export function ownSessionOf<S extends SessionOnTaskFacts>(sessions: readonly S[], taskId: string): S | null {
  const own = sessions.filter((s) => s.taskId === taskId && !s.archived && !s.parentSessionId && !s.jobId)
  return own.reduce<S | null>((newest, s) => (!newest || Date.parse(s.createdAt) > Date.parse(newest.createdAt) ? s : newest), null)
}

/** Why a delegation starts a new session instead of continuing the task's own one; null when it continues it. */
export type NewSessionReason = 'no_session' | 'terminal' | 'long_context' | 'fresh'

export function newSessionReason(own: SessionOnTaskFacts | null, fresh: boolean): NewSessionReason | null {
  if (fresh) return 'fresh'
  if (!own) return 'no_session'
  if (own.runtime !== 'sdk') return 'terminal'
  if (own.contextTokens !== null && own.contextTokens >= LONG_CONTEXT_TOKENS) return 'long_context'
  return null
}
