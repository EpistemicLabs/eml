import type { Entry } from './entries'

// --- Learning (v0.19) ------------------------------------------------------------
//
// A learning is a lesson about how the agent should work, backed by incidents
// (evidence entries). It is never binding and never loaded at boot; it becomes a
// rule only when it is ripe and the user agrees (eml_rule from_learning). One
// learning per topic: a new incident is added to the existing learning.
//
// Ripe = all three:
//   1. ≥ 2 supporting pieces of evidence from different sessions (several in one
//      session count as one incident; evidence without a session id cannot be
//      told apart, so it counts toward nothing but is reported);
//   2. ≥ 1 of them with source user (observed or self evidence alone never
//      makes a learning ripe);
//   3. no open contradiction — contradicting evidence makes the learning
//      unclear until its content is sharpened (or it is invalidated).
// A declined promotion (stance declined) pauses the question until two more
// supporting pieces of evidence from different sessions arrive.

export type LearningStateName = 'collecting' | 'ripe' | 'unclear' | 'paused'

export interface LearningState {
  state: LearningStateName
  /** Distinct sessions with supporting evidence. */
  supporting_sessions: number
  /** Supporting evidence written without a session id (REST / CLI without the session header) — it does not count toward the sessions. */
  unsessioned_evidence: number
  /** At least one supporting piece of evidence comes from the user. */
  from_user: boolean
  /** Contradicting evidence after the last sharpening of the content. */
  open_contradiction: boolean
  /** When the user last declined to make it a rule. */
  declined_at: string | null
}

/** The change entry the server writes when a learning's content is sharpened. */
export const LEARNING_SHARPENED = 'content sharpened'

export const LEARNING_RIPE_SESSIONS = 2

export function learningState(entries: readonly Entry[]): LearningState {
  const evidence = entries.filter(e => e.kind === 'evidence')
  const sharpenedAt = entries.filter(e => e.kind === 'change' && e.text.startsWith(LEARNING_SHARPENED)).map(e => e.at).pop() ?? ''
  const supporting = evidence.filter(e => (e.stance ?? 'supports') === 'supports')
  const sessionsOf = (entries: readonly Entry[]) => new Set(entries.map(e => e.session_id).filter((s): s is string => !!s))
  const sessions = sessionsOf(supporting)
  const unsessioned = supporting.filter(e => !e.session_id).length
  const fromUser = supporting.some(e => e.source === 'user')
  const openContradiction = evidence.some(e => e.stance === 'contradicts' && e.at > sharpenedAt)
  const declined = evidence.filter(e => e.stance === 'declined').pop() ?? null

  const base = {
    supporting_sessions: sessions.size,
    unsessioned_evidence: unsessioned,
    from_user: fromUser,
    open_contradiction: openContradiction,
    declined_at: declined?.at ?? null,
  }
  if (openContradiction) return { state: 'unclear', ...base }
  if (declined) {
    const after = sessionsOf(supporting.filter(e => e.at > declined.at))
    if (after.size < LEARNING_RIPE_SESSIONS) return { state: 'paused', ...base }
  }
  const ripe = sessions.size >= LEARNING_RIPE_SESSIONS && fromUser
  return { state: ripe ? 'ripe' : 'collecting', ...base }
}
