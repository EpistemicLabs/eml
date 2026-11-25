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

/**
 * A turn ended while subagents it started in the background still run, and it
 * asks nobody anything: its run goes on, this is no stop. They wake it with a
 * new turn when they come back, and that turn is judged on its own. A turn
 * that asks the user (question, review, failed) is a stop, subagents or not.
 */
export function stillRunning(facts: { agents: number; status: WorkerStatus | null }): boolean {
  return facts.agents > 0 && (facts.status === null || facts.status === 'done')
}

/**
 * A worker about to end its turn without saying how it stands is sent back.
 * `asked`: the turn already had its one reminder.
 */
export function shouldAskForStatus(facts: TurnFacts & { asked: boolean }): boolean {
  return facts.worker && facts.clients === 0 && !facts.declared && !facts.asked
}

/**
 * What the reply lacks once the turn said how it stands: the person reads the
 * reply, not the call, so it has to be there, and a question has to be asked in
 * it. `reply` is the visible text written around the call.
 */
export function missingReply(facts: { called: boolean; questions: boolean; reply: string }): Array<'reply' | 'questions'> {
  if (!facts.called) return []
  const text = facts.reply.trim()
  const unasked = facts.questions && !/\?|^\s*\d+[.)]\s/m.test(text)
  return [...(text === '' ? ['reply' as const] : []), ...(unasked ? ['questions' as const] : [])]
}

/** A turn ended: what it leaves when the worker still said nothing. Unclear means someone should look. */
export function attentionAfterTurn(facts: TurnFacts & { reason: 'success' | 'error' | 'interrupted' }): Attention | null {
  if (!facts.worker || facts.clients > 0 || facts.declared || facts.reason === 'interrupted') return null
  return facts.reason === 'error' ? 'failed' : 'review'
}
