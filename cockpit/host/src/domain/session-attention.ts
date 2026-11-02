/** Why a session waits for someone. Saved, unlike its turn state: it outlives the process. */
export type Attention = 'question' | 'review' | 'failed'

/** What a worker says when it ends a turn. */
export type WorkerStatus = 'done' | Attention

export const WORKER_STATUSES: readonly [WorkerStatus, ...WorkerStatus[]] = ['done', 'question', 'review', 'failed']

/** Only these hold a turn open for someone: review and done are finished work, waiting to be looked at. */
export function needsAnswer(kind: WorkerStatus): boolean {
  return kind === 'question' || kind === 'failed'
}

/** How long a worker that reported done stays around after someone opened it. */
export const READ_DONE_KEEP_MS = 3 * 24 * 60 * 60 * 1000

/** A worker that said nobody needs to act, and that someone has looked at, leaves by itself. Nothing else does. */
export function shouldAutoArchive(facts: {
  worker: boolean
  pinned: boolean
  archived: boolean
  busy: boolean
  kind: WorkerStatus | null
  /** Since when it counts as read (ms); null: nobody has opened it since it reported. */
  readAt: number | null
  now: number
}): boolean {
  if (!facts.worker || facts.pinned || facts.archived || facts.busy) return false
  if (facts.kind !== 'done' || facts.readAt === null) return false
  return facts.now - facts.readAt >= READ_DONE_KEEP_MS
}

interface TurnFacts {
  worker: boolean
  /** Someone has the session open and sees for themselves. */
  clients: number
  /** It said done or why it needs someone during this turn. */
  declared: boolean
}

/** A worker about to end its turn without saying how it stands is sent back, once. */
export function shouldAskForStatus(facts: TurnFacts & { asked: boolean }): boolean {
  return facts.worker && facts.clients === 0 && !facts.declared && !facts.asked
}

/** A turn ended: what it leaves when the worker still said nothing. Unclear means someone should look. */
export function attentionAfterTurn(facts: TurnFacts & { reason: 'success' | 'error' | 'interrupted' }): Attention | null {
  if (!facts.worker || facts.clients > 0 || facts.declared || facts.reason === 'interrupted') return null
  return facts.reason === 'error' ? 'failed' : 'review'
}
