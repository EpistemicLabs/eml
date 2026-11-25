import { waitKind, type WaitingOn } from './task-turn.js'

/**
 * A task's waits (brain schema 23): everyone the task waits on, one entry per
 * wait, each with its own id. Core keeps waiting_on as the most urgent entry for
 * older readers; the cockpit reads and writes the list.
 *
 * A session's wait has the session's id as its id, so a session holds at most
 * one wait per task: its next wait replaces its last, and an answer removes it.
 * The order is core's (packages/core/src/task-state.ts mostUrgentWait): a wait
 * that is not parked first, then question > go > stopped > review > outside (a
 * question blocks the agent, a review does not), an entry without a kind last,
 * then the oldest since, then list order.
 *
 * Parking (decision task-parking-is-a-snoozed-wait) sets snoozed_until on a wait:
 * an ISO date it comes back at, or "open". Core ranks a parked wait by the data
 * alone; whether its date has passed is the cockpit's call (isParked).
 */

export interface Wait extends WaitingOn {
  id: string
}

/** Most urgent first, as core orders them. */
const URGENCY = ['question', 'go', 'stopped', 'review', 'outside'] as const

/** A wait parked without an end date. */
export const SNOOZED_OPEN = 'open'

/** The wait is parked at `now`: snoozed open-ended, or until a time still ahead. */
export function isParked(w: { snoozed_until?: string }, now: number): boolean {
  if (!w.snoozed_until) return false
  if (w.snoozed_until === SNOOZED_OPEN) return true
  const until = Date.parse(w.snoozed_until)
  return Number.isFinite(until) && until > now
}

const urgency = (w: WaitingOn) => {
  const i = (URGENCY as readonly string[]).indexOf(w.kind ?? '')
  return i === -1 ? URGENCY.length : i
}

const isWait = (w: unknown): w is Wait =>
  !!w && typeof w === 'object' && typeof (w as Wait).id === 'string' && typeof (w as Wait).who === 'string' && (w as Wait).who.trim() !== ''

/**
 * The waits of a task's properties, read tolerantly: waits when it is a list,
 * else the one wait waiting_on stands for (a task no write of schema 23 has
 * touched yet), with core's id for it: its session_id, else "waiting_on".
 */
export function waitsOf(props: { waits?: unknown; waiting_on?: unknown } | undefined): Wait[] {
  if (Array.isArray(props?.waits)) return props.waits.filter(isWait)
  const w = props?.waiting_on as WaitingOn | undefined
  if (!w || typeof w !== 'object' || typeof w.who !== 'string' || w.who.trim() === '') return []
  return [{ ...w, id: w.session_id || 'waiting_on' }]
}

/** The most urgent of the waits, or undefined for none. */
export function mostUrgent<T extends WaitingOn>(waits: readonly T[]): T | undefined {
  let best: T | undefined
  const parked = (w: T) => (w.snoozed_until === undefined ? 0 : 1)
  for (const w of waits) {
    if (best === undefined) { best = w; continue }
    const p = parked(w) - parked(best)
    if (p !== 0) { if (p < 0) best = w; continue }
    const d = urgency(w) - urgency(best)
    if (d < 0 || (d === 0 && w.since !== undefined && (best.since === undefined || w.since < best.since))) best = w
  }
  return best
}

/** The task's most urgent wait without its id, or undefined. It keeps snoozed_until, which core's stored waiting_on leaves out: turnOf reads it. */
export function urgentWaitOf(props: { waits?: unknown; waiting_on?: unknown } | undefined): WaitingOn | undefined {
  const w = mostUrgent(waitsOf(props))
  if (!w) return undefined
  const { id: _id, ...rest } = w
  return rest
}

/** The session a wait belongs to: its session_id, else its id. */
const sessionOf = (w: Wait) => w.session_id ?? w.id

/** The waits without the one of `sessionId`. */
export function withoutSession(waits: readonly Wait[], sessionId: string): Wait[] {
  return waits.filter((w) => sessionOf(w) !== sessionId)
}

/**
 * The waits with `wait` as its session's one wait. A wait the session already
 * has with the same kind and why stays as it is (its since too), so a turn that
 * asks the same again changes nothing; otherwise the new one replaces it in place,
 * or comes last.
 */
export function withSessionWait(waits: readonly Wait[], wait: WaitingOn & { session_id: string }): Wait[] {
  const i = waits.findIndex((w) => sessionOf(w) === wait.session_id)
  if (i >= 0 && waits[i].kind === wait.kind && waits[i].why === wait.why && waits[i].who === wait.who) return [...waits]
  const entry: Wait = { id: wait.session_id, ...wait }
  if (i < 0) return [...waits, entry]
  return waits.map((w, j) => (j === i ? entry : w))
}

/** What names one wait across writes: its id and the moment it began (a session's next wait keeps the id, not the since). */
export interface WaitRef {
  id: string
  since?: string
}

/**
 * The reviews on `who` (everyone's reviews when nobody is named): what approving one run answers. A review is what
 * the board and the Inbox show as one (waitKind), so a wait from before kinds existed counts by its why.
 */
export function reviewsOn(waits: readonly Wait[], who: string | undefined): WaitRef[] {
  return waits.filter((w) => waitKind(w) === 'review' && (!who || w.who === who)).map((w) => ({ id: w.id, ...(w.since ? { since: w.since } : {}) }))
}

/** The waits without those `refs` name. */
export function withoutWaits(waits: readonly Wait[], refs: readonly WaitRef[]): Wait[] {
  return waits.filter((w) => !refs.some((r) => r.id === w.id && (r.since ?? '') === (w.since ?? '')))
}

/** The waits without the reviews on `who` (reviewsOn). */
export function withoutReviewsOn(waits: readonly Wait[], who: string | undefined): Wait[] {
  return withoutWaits(waits, reviewsOn(waits, who))
}

/** Whether two lists hold the same waits in the same order. */
export function sameWaits(a: readonly Wait[], b: readonly Wait[]): boolean {
  if (a.length !== b.length) return false
  const key = (w: Wait) => JSON.stringify([w.id, w.who, w.kind ?? null, w.why ?? null, w.since ?? null, w.session_id ?? null, w.snoozed_until ?? null])
  return a.every((w, i) => key(w) === key(b[i]))
}

/**
 * A wait as core accepts it: only its own keys, a kind core knows, a since that
 * is a date. A wait read from an older waiting_on can carry neither (core's
 * mirror leaves them out the same way).
 */
function storable(w: Wait): Wait {
  const out: Wait = { id: w.id, who: w.who }
  if (w.kind && (URGENCY as readonly string[]).includes(w.kind)) out.kind = w.kind
  if (typeof w.why === 'string') out.why = w.why
  if (typeof w.since === 'string' && /^\d{4}-\d{2}-\d{2}/.test(w.since) && !Number.isNaN(Date.parse(w.since))) out.since = w.since
  if (typeof w.session_id === 'string' && w.session_id) out.session_id = w.session_id
  if (typeof w.snoozed_until === 'string' && (w.snoozed_until === SNOOZED_OPEN || !Number.isNaN(Date.parse(w.snoozed_until)))) out.snoozed_until = w.snoozed_until
  return out
}

/** The track body that stores `waits`: the list, or null for none. */
export const waitsBody = (waits: readonly Wait[]) => ({ waits: waits.length > 0 ? waits.map(storable) : null })
