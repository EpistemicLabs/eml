import type { SessionLedger } from '../session-ledger.js'
import type { TurnEvent, TurnTracker } from '../turn-state.js'

export interface TurnNotice {
  title: string | null
  /** Others of the worker's batch still work: nothing to tell yet. */
  silent?: true
  /** The size of the batch the last finished worker closes. */
  batch?: number
}

/** What a notification about this change says: a batch of workers speaks up once, when its last one finishes. */
export function turnNotice(deps: { ledger: Pick<SessionLedger, 'get' | 'list'>; turns: Pick<TurnTracker, 'get'> }, event: TurnEvent): TurnNotice {
  const entry = deps.ledger.get(event.sessionId)
  const title = entry?.title ?? entry?.agentTitle ?? null
  if (event.state !== 'done' || !entry?.parentSessionId) return { title }
  const batch = deps.ledger.list().filter((other) => other.parentSessionId === entry.parentSessionId && !other.archivedAt)
  if (batch.some((other) => other.sessionId !== event.sessionId && deps.turns.get(other.sessionId)?.state === 'working')) return { title, silent: true }
  return { title, batch: batch.length }
}
