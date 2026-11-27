import type { LeaseHolder } from './task-lease.js'
import { replacingIds, type TaskRelations } from './task-relations.js'

/**
 * A session follows its task when another task replaces it (decision session-follows-replacing-task).
 *
 * A task is replaced when the brain closes it as superseded: the replacing task holds a `supersedes` relation onto it
 * (eml_create_task supersedes, or eml_track_task supersedes on an open task). A session that keeps working on the
 * replaced task would otherwise stay bound to a closed task: its chat can't be written to from any open task and its
 * hand-over lands nowhere. So every live session on a replaced task goes on where the work went:
 *
 *   - the replacement is the open task at the end of the `supersedes` chain (a replacing task may be replaced in turn).
 *     None, or several open ones (the work was split), and nothing moves: there is no one place to go on;
 *   - nobody holds the replacement (domain/task-lease.ts), or the session holds it itself: the session moves there;
 *   - another session or a starting request holds it: that one wins (one live session per task). The session is not
 *     moved beside it; when its turn ends, its hand-over goes to the replacing task and to the holder.
 *
 * A merge (one task replacing several) follows the same rule for each replaced task's sessions.
 */

/** How far the cockpit follows a chain of replacements. */
const REPLACEMENT_DEPTH = 8

/** A task as the replacement search reads it: the brain's GET /engram/:id?with_relations=true. */
export type ReplaceableTask = TaskRelations & { status: string }

const isOpen = (status: string) => status === 'planned' || status === 'active'

export { replacingIds }

/** The task to name as a task's replacement: an open one first, else the first. */
export const namedReplacement = (ids: readonly string[], open: (id: string) => boolean): string | null =>
  ids.find(open) ?? ids[0] ?? null

/** Where a replaced task's work goes on: one open task, none, or several (then nothing moves). */
export type Replacement =
  | { kind: 'open'; taskId: string }
  | { kind: 'none' }
  | { kind: 'several'; taskIds: string[] }

/**
 * The open task that replaced this one, following replacements of replacements. A replacing task that is closed some
 * other way (done or dropped) ends that branch: its work is over, not moved on. A read that fails throws: a brain that
 * did not answer must not read as "nothing replaced it".
 */
export async function findReplacement(read: (id: string) => Promise<ReplaceableTask | null>, task: ReplaceableTask): Promise<Replacement> {
  const seen = new Set([task.id])
  const open: string[] = []
  let frontier: ReplaceableTask[] = [task]
  for (let level = 0; level < REPLACEMENT_DEPTH && frontier.length > 0; level++) {
    const ids = [...new Set(frontier.flatMap(replacingIds))].filter((id) => !seen.has(id))
    for (const id of ids) seen.add(id)
    const found = (await Promise.all(ids.map(read))).filter((t): t is ReplaceableTask => t !== null)
    open.push(...found.filter((t) => isOpen(t.status)).map((t) => t.id))
    frontier = found.filter((t) => t.status === 'superseded')
  }
  if (open.length === 1) return { kind: 'open', taskId: open[0]! }
  return open.length === 0 ? { kind: 'none' } : { kind: 'several', taskIds: open }
}

/** What a session on a replaced task does: move onto the replacement, or leave it to the one that holds it. */
export type FollowDecision =
  | { kind: 'move' }
  | { kind: 'held'; holder: { kind: 'session'; sessionId: string } | { kind: 'request'; requestId: string } }

export function followDecision(sessionId: string, holder: LeaseHolder<{ id: string }, { sessionId: string }> | null): FollowDecision {
  if (!holder) return { kind: 'move' }
  if (holder.kind === 'request') return { kind: 'held', holder: { kind: 'request', requestId: holder.request.id } }
  if (holder.session.sessionId === sessionId) return { kind: 'move' }
  return { kind: 'held', holder: { kind: 'session', sessionId: holder.session.sessionId } }
}

/** The journal line on the task the session moved to. */
export const movedHereText = (session: string, from: string) =>
  `Session ${session} moved here from task ${from}, which this task replaced; it goes on here.`

/** The journal line on the replaced task. */
export const movedAwayText = (session: string, to: string) =>
  `Its session ${session} moved to task ${to}, which replaced this one.`

/** What a session that moved reads, in the turn it is in. */
export const movedNotice = (from: string, to: string, title: string | null) =>
  `[Cockpit] Task ${from} was replaced by task ${title ? `"${title}" (${to})` : to}. This session now works on ${to}: its progress, hand-over and results go there (eml_track_task ${to}).`

/** The hand-over of a session on a replaced task, as the replacing task's journal and its holder read it. */
export const handedOverText = (session: string, from: string, block: string) =>
  `Hand-over from session ${session}, which worked on task ${from} (replaced by this task):\n\n${block}`
