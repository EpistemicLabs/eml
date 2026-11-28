import type { EmlApi } from '@engramprotocol/mcp-server'
import type { BrainSpace } from '../brain-space.js'
import { waitKind } from '../domain/task-turn.js'
import { waitsBody, waitsOf, withoutReviewsOn, type Wait } from '../domain/task-waits.js'

/**
 * All steps done: when the last open step of a main task
 * closes, the main task comes back once, as a review for its owner: "All steps done: looks good?". The owner still
 * closes it. While steps were open a review asked of it was held back (domain/task-turn.ts turnOf); that ask is folded
 * into this one, so the owner gets one row, not two.
 *
 * Derived from the brain alone, so a restart neither loses nor repeats it: a main task qualifies when it is active,
 * has steps, none of them open, and one closed within WINDOW_MS. It is skipped when, since the last step closed,
 * its journal already says ALL_DONE (written here before), or a review was asked of the owner (its agent asked
 * itself), or a session works on it right now (that session's turn end says where it stands). In a shared space only
 * the owner's cockpit writes it.
 */

/** The journal line, and the start of the ask's text. */
export const ALL_DONE = 'All steps done'
/** Only steps closed this recently bring their main task back: an old main task is not dug up. */
export const WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** The wait this writes: one per main task. */
export const STEPS_DONE_WAIT = 'steps-done'

interface Listed {
  id: string
  status: string
  parent_id?: string | null
  updated_at?: string
}

interface Parent {
  id: string
  status: string
  properties?: { assignee_ids?: string[]; waits?: unknown; waiting_on?: unknown }
  entries?: Array<{ kind?: string; at?: string; text?: string | null }>
}

export interface StepsDoneDeps {
  /** This cockpit's member. */
  me: string
  /** A session works on this task right now. */
  working(taskId: string): boolean
  now(): number
  log(line: string): void
}

export interface StepsDone {
  /** Bring back the main tasks of one space whose last step closed. */
  check(space: Pick<BrainSpace, 'id' | 'shared'>, brain: Pick<EmlApi, 'get' | 'post'>): Promise<void>
}

const list = async (brain: Pick<EmlApi, 'get'>, status: string, extra: Record<string, string> = {}): Promise<Listed[]> =>
  ((await brain.get('/list', { type: 'task', status, with_parent: 'true', limit: '200', ...extra }).catch(() => ({ engrams: [] }))) as { engrams?: Listed[] }).engrams ?? []

/** The ask that brings the main task back, with the review that was held back, if any. */
export function stepsDoneWait(owner: string, held: readonly Wait[], at: string): Wait {
  const asked = held.map((w) => w.why?.trim().replace(/^Review:\s*/i, '')).filter(Boolean).join(' · ')
  return { id: STEPS_DONE_WAIT, who: owner, kind: 'review', why: `${ALL_DONE}: ${asked ? `${asked.replace(/\.$/, '')}. Looks good?` : 'looks good?'}`, since: at }
}

export function createStepsDone(deps: StepsDoneDeps): StepsDone {
  /** Main tasks already settled for their newest step close, so a tick does not read them again. */
  const settled = new Map<string, string>()

  const check: StepsDone['check'] = async (space, brain) => {
    const now = deps.now()
    const after = new Date(now - WINDOW_MS).toISOString()
    const [planned, active, resolved, invalidated] = await Promise.all([
      list(brain, 'planned'), list(brain, 'active'),
      list(brain, 'resolved', { order_by: 'updated_at' }), list(brain, 'invalidated', { order_by: 'updated_at' }),
    ])
    const openParents = new Set([...planned, ...active].map((t) => t.parent_id).filter((id): id is string => !!id))
    const activeIds = new Set(active.map((t) => t.id))
    // Per main task, its newest step close in the window.
    const lastClose = new Map<string, string>()
    for (const step of [...resolved, ...invalidated]) {
      if (!step.parent_id || !step.updated_at || step.updated_at < after) continue
      if (!activeIds.has(step.parent_id) || openParents.has(step.parent_id)) continue
      if ((lastClose.get(step.parent_id) ?? '') < step.updated_at) lastClose.set(step.parent_id, step.updated_at)
    }
    for (const [parentId, closedAt] of lastClose) {
      if (settled.get(parentId) === closedAt) continue
      if (deps.working(parentId)) continue
      const parent = await brain.get(`/engram/${encodeURIComponent(parentId)}`).catch(() => null) as Parent | null
      if (!parent || parent.status !== 'active') continue
      const owner = parent.properties?.assignee_ids?.[0]
      if (!owner || (space.shared && owner !== deps.me)) { settled.set(parentId, closedAt); continue }
      const said = (parent.entries ?? []).some((e) => (e.at ?? '') >= closedAt && (e.text ?? '').startsWith(ALL_DONE))
      const waits = waitsOf(parent.properties)
      const held = waits.filter((w) => w.who === owner && waitKind(w) === 'review')
      const askedSince = held.some((w) => (w.since ?? '') >= closedAt)
      if (said || askedSince) { settled.set(parentId, closedAt); continue }
      const at = new Date(now).toISOString()
      await brain.post(`/task/${encodeURIComponent(parentId)}/track`, {
        ...waitsBody([...withoutReviewsOn(waits, owner), stepsDoneWait(owner, held, at)]),
        text: `${ALL_DONE}: its last step closed, so the task comes back to ${owner} for review.`,
      })
      settled.set(parentId, closedAt)
      deps.log(`[steps-done] task ${parentId.slice(0, 8)}: all steps done, back to ${owner} for review`)
    }
  }

  return { check }
}
