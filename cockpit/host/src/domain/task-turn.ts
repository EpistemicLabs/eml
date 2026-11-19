/**
 * Whose turn a task is, derived and never stored (decision whose-turn-derived-in-cockpit-host).
 * The brain holds the inputs (status, owner in assignee_ids, delegate, checkpoint, waiting_on);
 * the host knows the rest (a session working on it, a job's next run, the runner). Every view
 * and count reads turnOf, so "Needs you" means the same thing everywhere.
 *
 * Also here: coverage, which tells Plan whether an important task has a concrete next trigger,
 * and urgency, which orders Plan.
 */

export type Turn = 'needs_you' | 'review' | 'agent_working' | 'agent_scheduled' | 'waiting_on_others' | 'done'
export const TURNS: readonly Turn[] = ['needs_you', 'review', 'agent_working', 'agent_scheduled', 'waiting_on_others', 'done']

export type WaitKind = 'question' | 'go' | 'review' | 'stopped' | 'outside'
export const WAIT_KINDS: readonly WaitKind[] = ['question', 'go', 'review', 'stopped', 'outside']

/** Groups inside Needs you and Agent scheduled, in the order the board shows them. */
export type TurnGroup = 'asked' | 'own' | 'parent' | 'nobody' | 'at_time' | 'runner'

export type NobodyReason = 'stopped' | 'no_checkpoint' | 'no_runner' | 'no_owner'

export interface WaitingOn {
  who: string
  kind?: string
  why?: string
  since?: string
  session_id?: string
}

/** What the brain says about a task, read tolerantly. */
export interface TaskFacts {
  status: string
  /** The person who owns it: the first person in assignee_ids. */
  owner?: string
  delegate?: string
  checkpoint?: string
  waitingOn?: WaitingOn
  priority?: string
  due?: string
  /** When it was resolved (its last update), for Done · 24 h. */
  closedAt?: string
  /** null: no parent. false: its parent is not active, so the runner won't start it. */
  parentActive: boolean | null
  /** Every depends_on is resolved. */
  depsResolved: boolean
}

/** What the host knows about a task right now. */
export interface LiveFacts {
  /** A session on the task is working. */
  working: boolean
  /** The next run of one of its jobs, if any. */
  nextRunAt: string | null
  /** The task's space has a runner (the task system is on there). */
  runner: boolean
}

export interface TurnResult {
  turn: Turn
  group?: TurnGroup
  reason?: NobodyReason
}

export const DONE_WINDOW_MS = 24 * 60 * 60 * 1000

/** A waiting_on without a kind (written before kinds existed) reads as a review when its why says so. */
export function waitKind(w: WaitingOn): WaitKind {
  if (w.kind && (WAIT_KINDS as readonly string[]).includes(w.kind)) return w.kind as WaitKind
  return /^review\b/i.test(w.why ?? '') ? 'review' : 'question'
}

/**
 * The task's turn for `viewer` (the person looking), or null when it is off the board: closed
 * longer than a day ago, or dropped.
 */
export function turnOf(task: TaskFacts, live: LiveFacts, viewer: string, now: number): TurnResult | null {
  if (task.status === 'invalidated') return null
  if (task.status === 'resolved') {
    const at = task.closedAt ? Date.parse(task.closedAt) : NaN
    return Number.isFinite(at) && now - at <= DONE_WINDOW_MS ? { turn: 'done' } : null
  }
  const w = task.waitingOn
  const kind = w ? waitKind(w) : null
  if (w && w.who === viewer && kind === 'review') return { turn: 'review' }
  if (live.working) return { turn: 'agent_working' }
  if (w && w.who === viewer) return kind === 'stopped' ? { turn: 'needs_you', group: 'nobody', reason: 'stopped' } : { turn: 'needs_you', group: 'asked' }
  if (w && w.who) return { turn: 'waiting_on_others' }
  if (task.delegate) {
    if (live.nextRunAt) return { turn: 'agent_scheduled', group: 'at_time' }
    if (!live.runner) return { turn: 'needs_you', group: 'nobody', reason: 'no_runner' }
    if (!task.checkpoint) return { turn: 'needs_you', group: 'nobody', reason: 'no_checkpoint' }
    if (task.parentActive === false) return { turn: 'needs_you', group: 'parent' }
    return { turn: 'agent_scheduled', group: 'runner' }
  }
  if (task.parentActive === false) return { turn: 'needs_you', group: 'parent' }
  if (!task.owner) return { turn: 'needs_you', group: 'nobody', reason: 'no_owner' }
  if (task.owner !== viewer) return { turn: 'waiting_on_others' }
  return { turn: 'needs_you', group: 'own' }
}

// ---- Plan: coverage and urgency ----

export type CoverageGroup = 'ask' | 'due' | 'high' | 'blocked' | 'idle' | 'nofollow' | 'stopped' | 'owner' | 'mine'
/** The order Plan's "Stuck until you act" box shows its groups in. */
export const COVERAGE_GROUPS: readonly CoverageGroup[] = ['ask', 'due', 'high', 'blocked', 'idle', 'nofollow', 'stopped', 'owner', 'mine']

export type Coverage =
  | { ok: true; how: 'working' | 'at_time' | 'checks_back' | 'runner'; at?: string }
  | { ok: false; group: CoverageGroup; reason?: NobodyReason | 'parent' | 'steps_wait'; steps?: number }

export const DUE_SOON_DAYS = 14

const DAY_MS = 24 * 60 * 60 * 1000
export const daysUntil = (due: string, now: number) => Math.floor((Date.parse(`${due.slice(0, 10)}T00:00:00Z`) - now) / DAY_MS)

/**
 * Whether something will move the task without the viewer: a session working, a job's next run,
 * or the runner would start it. Otherwise the group says what has to happen.
 */
export function coverageOf(task: TaskFacts, live: LiveFacts, viewer: string, now: number, stepsWaiting = 0): Coverage {
  const t = turnOf(task, live, viewer, now)
  if (live.working) return { ok: true, how: 'working' }
  if (t?.group === 'asked') return { ok: false, group: 'ask' }
  if (t?.reason === 'stopped') return { ok: false, group: 'stopped', reason: 'stopped' }
  if (t?.group === 'parent') return { ok: false, group: 'blocked', reason: 'parent' }
  if (stepsWaiting > 0 && task.status !== 'active') return { ok: false, group: 'blocked', reason: 'steps_wait', steps: stepsWaiting }
  if (live.nextRunAt) return task.waitingOn?.who && task.waitingOn.who !== viewer
    ? { ok: true, how: 'checks_back', at: live.nextRunAt }
    : { ok: true, how: 'at_time', at: live.nextRunAt }
  if (task.waitingOn?.who) return { ok: false, group: 'nofollow' }
  if (task.delegate) {
    if (t?.group === 'nobody') return { ok: false, group: 'idle', reason: t.reason }
    return { ok: true, how: 'runner' }
  }
  if (!task.owner) return { ok: false, group: 'owner', reason: 'no_owner' }
  if (task.due && daysUntil(task.due, now) <= DUE_SOON_DAYS) return { ok: false, group: 'due' }
  if (task.priority === 'high') return { ok: false, group: 'high' }
  return { ok: false, group: 'mine' }
}

/** An important task for Plan's two boxes: asked, stopped, the viewer's own, due within two weeks, or high. */
export function isImportant(task: TaskFacts, live: LiveFacts, viewer: string, now: number): boolean {
  const t = turnOf(task, live, viewer, now)
  return t?.group === 'asked' || t?.reason === 'stopped' || t?.group === 'own'
    || (Boolean(task.due) && daysUntil(task.due!, now) <= DUE_SOON_DAYS) || task.priority === 'high'
}

export const URGENCY = {
  asked: 1000,
  needsYou: 300,
  dueBase: 400,
  duePerDay: 20,
  high: 150,
  normal: 20,
  active: 10,
} as const

/** How urgent a task is for Plan's order: a question first, then the viewer's turn, a near due date, priority. */
export function urgencyOf(task: TaskFacts, live: LiveFacts, viewer: string, now: number): number {
  const t = turnOf(task, live, viewer, now)
  return (t?.group === 'asked' ? URGENCY.asked : 0)
    + (t?.turn === 'needs_you' ? URGENCY.needsYou : 0)
    + (task.due ? Math.max(0, URGENCY.dueBase - daysUntil(task.due, now) * URGENCY.duePerDay) : 0)
    + (task.priority === 'high' ? URGENCY.high : task.priority === 'normal' ? URGENCY.normal : 0)
    + (task.status === 'active' ? URGENCY.active : 0)
}
