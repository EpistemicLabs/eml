import type Database from 'better-sqlite3'
import { TASK_OPEN_STATUSES, type EngramType, type DetectionMethod, type OpenSubtask } from '../types'
import { bumpRev } from '../entries'
import type { WriteContext } from './context'
import { dropWikilinkEcho } from './wikilinks'
import { ancestorsOf, appendTaskChange, moveBoundItems, openSubtasksOf } from './task-binding'
import { insertRelation } from './insert'

/**
 * The supersede rules, one check for every write path (decision
 * supersede-rules): only a live engram (active, an open task) supersedes; an
 * engram has one successor and the chain has no loop; the type table
 * (assertSupersedeTypes); a task does not replace a task of its own part_of
 * line. Per target it returns 'replace' — the target is open (active, a
 * planned task) and is set to superseded — or 'edge' — the target is closed
 * already and keeps its status, the call only records its successor.
 * `next.id` is null on create; `next.parentId` is the parent the call sets
 * (create or track_task), undefined keeps the current one.
 */
export function planSupersedes(ctx: WriteContext, oldIds: readonly string[], next: { id: string | null, type: EngramType, status: string, parentId?: string | null }): Map<string, 'replace' | 'edge'> {
  const plan = new Map<string, 'replace' | 'edge'>()
  if (oldIds.length === 0) return plan
  if (next.type === 'status') throw new Error('Invalid engram: a status supersedes the previous one by itself — no supersedes.')
  if (next.type === 'event' || next.type === 'log') throw new Error(`Invalid engram: ${next.type === 'event' ? 'an event' : 'a log'} does not supersede — no supersedes.`)
  if (!(next.type === 'task' ? (TASK_OPEN_STATUSES as readonly string[]).includes(next.status) : next.status === 'active')) {
    throw new Error(next.type === 'task'
      ? 'Invalid engram: only an open task replaces another — reopen this one first, or close the old task with eml_track_task.'
      : `Invalid engram: ${next.id} is ${next.status} — only an active engram supersedes another; reactivate it first (status=active) or write a new one.`)
  }
  const parentLine = next.parentId === null ? [] : next.parentId !== undefined ? [next.parentId, ...ancestorsOf(ctx, next.parentId)] : next.id ? ancestorsOf(ctx, next.id) : []
  for (const oldId of oldIds) {
    if (oldId === next.id) throw new Error('Invalid engram: an engram cannot supersede itself.')
    const old = ctx.db.prepare('SELECT type, status FROM engrams WHERE id = ?').get(oldId) as { type: string, status: string } | undefined
    if (!old) throw new Error(`Invalid engram: supersedes ${oldId} — no such engram.`)
    // one successor that holds: an invalidated one (an undone supersede) is history
    const by = liveSuccessorOf(ctx, oldId)
    if (by) throw new Error(`Invalid engram: ${oldId} is already superseded by ${by} — continue on that one.`)
    if (next.id && isOlderThan(ctx, next.id, oldId)) {
      throw new Error(`Invalid engram: ${next.id} is already in the supersedes chain of ${oldId} — superseding it would close a loop.`)
    }
    if (parentLine.includes(oldId)) {
      throw new Error(`Invalid engram: ${oldId} is a parent of this task — a sub-task does not replace its parent; close the parent with eml_track_task.`)
    }
    if (next.id && ancestorsOf(ctx, oldId).includes(next.id)) {
      throw new Error(`Invalid engram: ${oldId} is a sub-task of this task — a task does not replace its own sub-task; close it with eml_track_task.`)
    }
    assertSupersedeTypes(oldId, old.type, next.type)
    plan.set(oldId, old.status === 'active' || old.status === 'planned' ? 'replace' : 'edge')
  }
  return plan
}

/** Which type replaces which: a status, event or log never by hand, a task only by a task, a learning only a rule or learning. */
function assertSupersedeTypes(oldId: string, oldType: string, newType: EngramType): void {
  if (oldType === 'event') throw new Error(`Invalid engram: ${oldId} is an event — an event is corrected, never superseded.`)
  if (oldType === 'log') throw new Error(`Invalid engram: ${oldId} is a log — a log is corrected with eml_update, never superseded.`)
  if (oldType === 'status') {
    throw new Error(`Invalid engram: ${oldId} is a status — a status is superseded by the next eml_set_status in its scope.`)
  }
  if (oldType === 'task' && newType !== 'task') {
    throw new Error(`Invalid engram: ${oldId} is a task — a task is replaced by a task (eml_create_task(supersedes=[id]) or eml_track_task(<new task id>, supersedes=[id])) or closed with eml_track_task.`)
  }
  if (newType === 'task' && oldType !== 'task') {
    throw new Error(`Invalid engram: supersedes ${oldId} is a ${oldType} — a task replaces a task; a ${oldType} is superseded by eml_update(<new id>, supersedes=[…]) on its successor.`)
  }
  if (newType === 'learning' && oldType !== 'rule' && oldType !== 'learning') {
    throw new Error('Invalid engram: a learning supersedes only a rule (demoted on the user\'s word) or another learning.')
  }
}

/** True if `id` is already superseded, directly or down the chain, by `newer`. */
function isOlderThan(ctx: WriteContext, id: string, newer: string): boolean {
  return !!ctx.db.prepare(`
    WITH RECURSIVE older(id) AS (
      SELECT target_id FROM relations WHERE source_id = ? AND relation = 'supersedes'
      UNION SELECT r.target_id FROM relations r JOIN older o ON r.source_id = o.id WHERE r.relation = 'supersedes'
    ) SELECT 1 FROM older WHERE id = ?
  `).get(newer, id)
}

/** The engram that superseded this one (its supersedes edge), if any. */
export function successorOf(ctx: WriteContext, id: string): string | undefined {
  return (ctx.db.prepare(`SELECT source_id FROM relations WHERE target_id = ? AND relation = 'supersedes' ORDER BY created_at ASC, ord ASC LIMIT 1`).get(id) as { source_id: string } | undefined)?.source_id
}

/** A successor of `id` that still holds (any status but invalidated). */
export function liveSuccessorOf(ctx: WriteContext, id: string): string | undefined {
  return (ctx.db.prepare(`
    SELECT r.source_id FROM relations r JOIN engrams e ON e.id = r.source_id
    WHERE r.target_id = ? AND r.relation = 'supersedes' AND e.status != 'invalidated'
    ORDER BY r.created_at ASC, r.ord ASC LIMIT 1
  `).get(id) as { source_id: string } | undefined)?.source_id
}

/** Reactivating or reopening `id` needs every successor invalidated. */
export function assertNoLiveSuccessor(ctx: WriteContext, id: string): void {
  const successor = liveSuccessorOf(ctx, id)
  if (successor !== undefined) {
    throw new Error(`Invalid engram: ${id} is replaced by ${successor} — it is reactivated only once its successor is invalidated; until then the successor holds.`)
  }
}

/**
 * Carry out a plan of planSupersedes inside the caller's transaction. An
 * open task replaced by a task hands over its bound items and reports its
 * open sub-tasks; a closed target only gets the edge. Journal entries on
 * the tasks of both sides.
 */
export function applySupersedes(ctx: WriteContext, newId: string, plan: Map<string, 'replace' | 'edge'>): { superseded: string[], openSubtasks: OpenSubtask[] } {
  const typeOf = (id: string) => (ctx.db.prepare('SELECT type FROM engrams WHERE id = ?').get(id) as { type: string }).type
  const newIsTask = typeOf(newId) === 'task'
  const openSubtasks: OpenSubtask[] = []
  for (const [oldId, mode] of plan) {
    const oldIsTask = typeOf(oldId) === 'task'
    if (mode === 'replace') supersede(ctx, newId, oldId)
    else {
      linkSupersede(ctx, newId, oldId, 'agent_declared')
      if (oldIsTask) appendTaskChange(ctx, oldId, `superseded by ${newId}`)
    }
    if (newIsTask) appendTaskChange(ctx, newId, `supersedes ${oldId}`)
    if (mode === 'replace' && oldIsTask) {
      moveBoundItems(ctx, oldId, newId)
      openSubtasks.push(...openSubtasksOf(ctx, oldId))
    }
  }
  return { superseded: [...plan.keys()], openSubtasks }
}

/** Supersede one engram by another: status flip + edge. Inside the caller's transaction. */
export function supersede(ctx: WriteContext, newId: string, oldId: string): void {
  linkSupersede(ctx, newId, oldId, 'agent_declared')
  if ((ctx.db.prepare('SELECT type FROM engrams WHERE id = ?').get(oldId) as { type: string }).type === 'task') {
    appendTaskChange(ctx, oldId, `superseded by ${newId}`)
  }
}

/**
 * v0.13: flip one prior engram to `superseded` and materialize the
 * `supersedes` edge (newId → oldId). Shared by the status-type auto-supersede
 * (Match-Key = scope) and the explicit `properties.supersedes` path (any type,
 * declared at write time). Only an open engram (active, a planned task) is
 * flipped: a closed one keeps how it ended and only gets the edge (decision
 * supersede-rules); the edge INSERT is idempotent via ON CONFLICT. MUST run inside
 * store()'s transaction so the flip + edge commit atomically with the new row.
 */
export function linkSupersede(ctx: WriteContext, newId: string, oldId: string, detection: DetectionMethod): void {
  const { db, stamp } = ctx
  db.prepare(`
    UPDATE engrams SET status = 'superseded', updated_at = ?
    WHERE id = ? AND status IN ('active', 'planned')
  `).run(stamp.at, oldId)
  bumpRev(db, stamp, oldId)
  insertRelation(ctx, { source_id: newId, target_id: oldId, relation: 'supersedes', detection_method: detection })
  dropWikilinkEcho(ctx, newId, oldId)
}

/** The scope's latest active status other than `exceptId`, if any. */
export function activeStatusIn(db: Database.Database, scope: string, exceptId: string): { id: string, properties: string | null } | undefined {
  return db.prepare(
    `SELECT id, properties FROM engrams WHERE scope = ? AND type = 'status' AND status = 'active' AND id != ? ORDER BY updated_at DESC, ord DESC LIMIT 1`,
  ).get(scope, exceptId) as { id: string, properties: string | null } | undefined
}

/** The state of the scope's active status before `exceptId` was written. */
export function activeStatusState(ctx: WriteContext, scope: string, exceptId: string): string | null {
  const row = activeStatusIn(ctx.db, scope, exceptId)
  if (!row) return null
  const p = row.properties ? JSON.parse(row.properties) : {}
  return typeof p.state === 'string' ? p.state : null
}

/**
 * v0.8 C1: auto-supersede.
 * v0.9.1 Cluster 1: match key is just (scope) now, namespace is gone.
 */
export function autoSupersedeStatusEngrams(ctx: WriteContext, newId: string, scope: string): string[] {
  const oldRows = ctx.db.prepare(`
    SELECT id FROM engrams
    WHERE scope = ?
      AND type = 'status' AND status = 'active'
      AND id != ?
    ORDER BY ord
  `).all(scope, newId) as { id: string }[]

  for (const old of oldRows) linkSupersede(ctx, newId, old.id, 'manual')
  return oldRows.map(r => r.id)
}

/** The scope's active core profile other than `exceptId`, if any. */
export function activeCoreProfileIn(db: Database.Database, scope: string, exceptId: string): string | null {
  const row = db.prepare(`
    SELECT id FROM engrams
    WHERE scope = ? AND type = 'profile' AND status = 'active' AND id != ?
      AND json_extract(properties, '$.core') = 1
  `).get(scope, exceptId) as { id: string } | undefined
  return row?.id ?? null
}

/** A new core profile supersedes the scope's previous one (one core per scope). */
export function autoSupersedeCoreProfile(ctx: WriteContext, newId: string, scope: string): string[] {
  const rows = ctx.db.prepare(`
    SELECT id FROM engrams
    WHERE scope = ? AND type = 'profile' AND status = 'active' AND id != ?
      AND json_extract(properties, '$.core') = 1
    ORDER BY ord
  `).all(scope, newId) as { id: string }[]
  for (const r of rows) linkSupersede(ctx, newId, r.id, 'manual')
  return rows.map(r => r.id)
}
