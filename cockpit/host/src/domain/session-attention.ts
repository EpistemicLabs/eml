/** Why a session waits for someone. Saved, unlike its turn state: it outlives the process. */
export type Attention = 'question' | 'review' | 'failed'

/** What a worker says when it ends a turn. */
export type WorkerStatus = 'done' | Attention

export const WORKER_STATUSES: readonly [WorkerStatus, ...WorkerStatus[]] = ['done', 'question', 'review', 'failed']

/** Only these hold a turn open for someone: review and done are finished work, waiting to be looked at. */
export function needsAnswer(kind: WorkerStatus): boolean {
  return kind === 'question' || kind === 'failed'
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

/**
 * After the status, the reply has to show it: what the person reads in the
 * chat is the closing summary, not the status call. A question has to be
 * asked there too. Sent back once, for whichever is missing.
 */
export function missingSummary(facts: { status: WorkerStatus | null; textAfter: string; asked: boolean }): 'summary' | 'questions' | null {
  if (!facts.status || facts.asked) return null
  const text = facts.textAfter.trim()
  if (text === '') return 'summary'
  if (facts.status === 'question' && !/\?|^\s*\d+[.)]\s/m.test(text)) return 'questions'
  return null
}

/** A turn ended: what it leaves when the worker still said nothing. Unclear means someone should look. */
export function attentionAfterTurn(facts: TurnFacts & { reason: 'success' | 'error' | 'interrupted' }): Attention | null {
  if (!facts.worker || facts.clients > 0 || facts.declared || facts.reason === 'interrupted') return null
  return facts.reason === 'error' ? 'failed' : 'review'
}
