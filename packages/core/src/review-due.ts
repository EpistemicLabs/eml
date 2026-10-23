import type Database from 'better-sqlite3'
import { Engram, EngramType, TASK_INACTIVITY_DAYS, TYPE_REVIEW_DEFAULTS } from './types'

/**
 * v0.13: engram types that are reviewed by date = the keys of
 * TYPE_REVIEW_DEFAULTS. Single source of truth — adding a reviewable type there
 * makes review_due pick it up, no SQL edit.
 */
export const REVIEWABLE_TYPES = Object.keys(TYPE_REVIEW_DEFAULTS) as EngramType[]

/**
 * v0.20: the one definition of "review due", computed at read time (decision
 * drop-labels-axis; no sweep writes it). An engram `alias` is due when it is
 *  - an active, standing decision/rule/profile whose review_due_at has passed
 *    (a task-bound decision is not reviewed; its task covers it), or
 *  - an active task whose last movement (the later of its own update and its
 *    newest entry) is older than TASK_INACTIVITY_DAYS. A planned task is not
 *    reviewed: idle, it is backlog (open-tasks.ts).
 * datetime() normalizes stored values and the cutoff, so SQLite-format and ISO
 * timestamps compare correctly. Bind `now` (the read's clock) twice, in order.
 */
export function reviewDueSql(alias: string): string {
  const types = REVIEWABLE_TYPES.map(t => `'${t}'`).join(', ')
  return `(${alias}.status = 'active' AND (
    (${alias}.type IN (${types})
      AND json_extract(${alias}.properties, '$.review_due_at') IS NOT NULL
      AND datetime(json_extract(${alias}.properties, '$.review_due_at')) < datetime(?)
      AND coalesce(json_extract(${alias}.properties, '$.binding'), 'standing') = 'standing')
    OR
    (${alias}.type = 'task'
      AND MAX(
        datetime(${alias}.updated_at),
        COALESCE(datetime((SELECT MAX(te.at) FROM entries te WHERE te.engram_id = ${alias}.id)), datetime(${alias}.updated_at))
      ) < datetime(?, '-${TASK_INACTIVITY_DAYS} days'))
  ))`
}

/** The bound values for one reviewDueSql expression. */
export function reviewDueParams(now: string): string[] {
  return [now, now]
}

/**
 * v0.20: set review_due on a set of engrams IN PLACE — one query per chunk for
 * the whole array, not one per engram. Called at every read boundary next to
 * the facet hydration, so every read path carries the field.
 */
export function hydrateReviewDue(db: Database.Database, engrams: Engram[], now: string): void {
  if (engrams.length === 0) return
  const CHUNK = 800
  const due = new Set<string>()
  for (let i = 0; i < engrams.length; i += CHUNK) {
    const batch = engrams.slice(i, i + CHUNK)
    const rows = db.prepare(
      `SELECT c.id FROM engrams c WHERE c.id IN (${batch.map(() => '?').join(',')}) AND ${reviewDueSql('c')}`,
    ).all(...batch.map(e => e.id), ...reviewDueParams(now)) as Array<{ id: string }>
    for (const r of rows) due.add(r.id)
  }
  for (const e of engrams) e.review_due = due.has(e.id)
}
