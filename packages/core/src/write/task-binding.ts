import { TYPE_REVIEW_DEFAULTS, TASK_OPEN_STATUSES, type EngramType, type OpenSubtask, type BoundItem } from '../types'
import { appendEntry, bumpRev, type Entry } from '../entries'
import { addDays } from '../env'
import { CLOSED_WITH_TASK } from '../engrams'
import { propsOf, type WriteContext } from './context'
import { dropWikilinkEcho } from './wikilinks'
import { liveSuccessorOf } from './supersede'

/** The task a decision or note is tied to (task_id at creation: a refines / derived_from edge). */
export function boundTaskOf(ctx: WriteContext, id: string): { id: string, status: string } | undefined {
  return ctx.db.prepare(`SELECT t.id, t.status FROM relations r JOIN engrams t ON t.id = r.target_id WHERE r.source_id = ? AND t.type = 'task' AND r.relation IN ('derived_from', 'refines') ORDER BY r.created_at ASC, r.rowid ASC LIMIT 1`).get(id) as { id: string, status: string } | undefined
}

/** A task-bound decision or note needs a task that is still open. */
export function assertTaskOpenForBinding(ctx: WriteContext, taskId: string, type: string): void {
  const t = ctx.db.prepare('SELECT status FROM engrams WHERE id = ?').get(taskId) as { status: string } | undefined
  if (t && !(TASK_OPEN_STATUSES as readonly string[]).includes(t.status)) {
    throw new Error(`Invalid engram: task ${taskId} is ${t.status} — a ${type} bound to it would close with it; use binding standing, or reopen the task first.`)
  }
}

// === v0.15: task hierarchy (part_of) ===

/**
 * The part_of rules (the DB guards only the verb): both ends are tasks, no
 * cycles, at most one parent per task. Re-drawing the existing edge is fine
 * (idempotent). Errors start with `Invalid engram:`.
 */
export function assertPartOf(ctx: WriteContext, childId: string, parentId: string, opts: { reparent?: boolean } = {}): void {
  const typeOf = (id: string) =>
    (ctx.db.prepare('SELECT type FROM engrams WHERE id = ?').get(id) as { type: string } | undefined)?.type
  if (typeOf(childId) !== 'task' || typeOf(parentId) !== 'task') {
    throw new Error('Invalid engram: part_of needs two tasks.')
  }
  if (childId === parentId) throw new Error('Invalid engram: part_of would create a cycle.')
  const parentOf = (id: string) =>
    (ctx.db.prepare(
      `SELECT target_id FROM relations WHERE source_id = ? AND relation = 'part_of'`,
    ).get(id) as { target_id: string } | undefined)?.target_id
  const current = parentOf(childId)
  if (current !== undefined && current !== parentId && !opts.reparent) {
    throw new Error(`Invalid engram: task ${childId} already has a parent.`)
  }
  // Walk up from the new parent: reaching the child means the edge closes a loop.
  const seen = new Set<string>()
  for (let p: string | undefined = parentId; p !== undefined; p = parentOf(p)) {
    if (p === childId) throw new Error('Invalid engram: part_of would create a cycle.')
    if (seen.has(p)) break
    seen.add(p)
  }
}

/** Validate + draw child → parent. Returns true if the edge is new. */
export function linkPartOf(ctx: WriteContext, childId: string, parentId: string): boolean {
  assertPartOf(ctx, childId, parentId)
  const info = ctx.db.prepare(`
    INSERT INTO relations (id, source_id, target_id, relation, detection_method, strength, created_at)
    VALUES (?, ?, ?, 'part_of', 'agent_declared', 1.0, ?)
    ON CONFLICT(source_id, target_id, relation) DO NOTHING
  `).run(ctx.stamp.newId(), childId, parentId, ctx.stamp.at)
  dropWikilinkEcho(ctx, childId, parentId)
  return info.changes > 0
}

export function parentOf(ctx: WriteContext, id: string): string | undefined {
  return (ctx.db.prepare(`SELECT target_id FROM relations WHERE source_id = ? AND relation = 'part_of'`).get(id) as { target_id: string } | undefined)?.target_id
}

/** The parent, grandparent, … of a task (part_of upwards). */
export function ancestorsOf(ctx: WriteContext, id: string): string[] {
  return (ctx.db.prepare(`
    WITH RECURSIVE up(id) AS (
      SELECT target_id FROM relations WHERE source_id = ? AND relation = 'part_of'
      UNION SELECT r.target_id FROM relations r JOIN up u ON r.source_id = u.id WHERE r.relation = 'part_of'
    ) SELECT id FROM up
  `).all(id) as Array<{ id: string }>).map(r => r.id)
}

/** Open (planned/active) direct sub-tasks of a task. */
export function openSubtasksOf(ctx: WriteContext, parentId: string): OpenSubtask[] {
  const rows = ctx.db.prepare(`
    SELECT e.id, e.title FROM relations r
    JOIN engrams e ON e.id = r.source_id
    WHERE r.target_id = ? AND r.relation = 'part_of'
      AND e.type = 'task' AND e.status IN (${TASK_OPEN_STATUSES.map(() => '?').join(', ')})
    ORDER BY e.created_at ASC
  `).all(parentId, ...TASK_OPEN_STATUSES) as Array<{ id: string, title: string | null }>
  return rows.map(r => ({ parent_id: parentId, id: r.id, title: r.title }))
}

// === v0.19: the task lifecycle (eml_track_task) ===

/** A server-written change entry in a task's journal (at the task's current stage). */
export function appendTaskChange(ctx: WriteContext, taskId: string, text: string): Entry {
  const row = ctx.db.prepare('SELECT properties FROM engrams WHERE id = ?').get(taskId) as { properties: string | null } | undefined
  const stage = row?.properties ? JSON.parse(row.properties).stage ?? null : null
  const entry = appendEntry(ctx.db, taskId, { kind: 'change', text, stage }, ctx.stamp)
  return entry
}

/** A task superseded by a new one hands its bound items over (S2). Only the edge moves: no field of the item changes, so its rev stays. */
export function moveBoundItems(ctx: WriteContext, oldTaskId: string, newTaskId: string): void {
  const items = ctx.store.boundItems(oldTaskId)
  for (const item of items) {
    const rel = item.type === 'decision' ? 'derived_from' : 'refines'
    ctx.db.prepare(`DELETE FROM relations WHERE source_id = ? AND target_id = ? AND relation = ?`).run(item.id, oldTaskId, rel)
    ctx.db.prepare(`
      INSERT INTO relations (id, source_id, target_id, relation, detection_method, strength, created_at)
      VALUES (?, ?, ?, ?, 'agent_declared', 1.0, ?)
      ON CONFLICT(source_id, target_id, relation) DO NOTHING
    `).run(ctx.stamp.newId(), item.id, newTaskId, rel, ctx.stamp.at)
    appendTaskChange(ctx, newTaskId, `${item.type} moved here from ${oldTaskId}: ${item.title ?? item.id} (${item.id})`)
  }
}

/** Close the bound items of a task with it (decisions follow the task's outcome, notes are invalidated). */
export function closeBoundItems(ctx: WriteContext, taskId: string, taskStatus: 'resolved' | 'invalidated', keep: readonly string[]): { closed: BoundItem[], kept: BoundItem[], entries: Entry[] } {
  const { db, stamp } = ctx
  const closed: BoundItem[] = []
  const kept: BoundItem[] = []
  const entries: Entry[] = []
  for (const item of ctx.store.boundItems(taskId)) {
    const props = propsOf(ctx, item.id)
    if (keep.includes(item.id)) {
      props.binding = 'standing'
      // a task-bound decision is not reviewed; as standing it starts its review clock now
      const reviewDays = TYPE_REVIEW_DEFAULTS[item.type as EngramType]
      if (reviewDays !== undefined) props.review_due_at = addDays(stamp.at, reviewDays)
      db.prepare(`UPDATE engrams SET properties = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(props), stamp.at, item.id)
      bumpRev(db, stamp, item.id)
      entries.push(appendTaskChange(ctx, taskId, `kept as standing: ${item.type} ${item.title ?? item.id} (${item.id})`))
      kept.push({ ...item })
    } else {
      const status = item.type === 'decision' ? taskStatus : 'invalidated'
      db.prepare(`UPDATE engrams SET status = ?, updated_at = ? WHERE id = ?`).run(status, stamp.at, item.id)
      bumpRev(db, stamp, item.id)
      // the item's own journal says why it closed; a reopen of the task offers it back by this entry
      appendEntry(db, item.id, { kind: 'change', text: `${CLOSED_WITH_TASK} ${taskId}` }, stamp)
      entries.push(appendTaskChange(ctx, taskId, `closed with the task: ${item.type} ${item.title ?? item.id} (${item.id})`))
      closed.push({ ...item, status })
    }
  }
  return { closed, kept, entries }
}

/**
 * The bound items that closed with this task and stayed closed since: their
 * last change entry is that close. One closed by hand never carries it.
 */
export function closedWithTask(ctx: WriteContext, taskId: string): BoundItem[] {
  const marker = `${CLOSED_WITH_TASK} ${taskId}`
  return ctx.store.boundItems(taskId, ['resolved', 'invalidated']).filter(item => {
    if (liveSuccessorOf(ctx, item.id) !== undefined) return false  // replaced since: its successor holds
    const changes = ctx.store.entries(item.id, ['change'])
    return changes[changes.length - 1]?.text === marker
  })
}
