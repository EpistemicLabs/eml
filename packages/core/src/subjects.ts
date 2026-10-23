import Database from 'better-sqlite3'
import { Subject, SubjectStatus, Engram } from './types'
import { slugifyTag } from './tags'

/**
 * v0.14: batch-load subject ids onto a set of engrams IN PLACE. Mirror of
 * hydrateEngramTags; called at every read boundary so all read paths expose
 * `engram.subjects` without an N+1. Chunked under SQLite's variable limit.
 */
export function hydrateEngramSubjects(db: Database.Database, engrams: Engram[]): void {
  if (engrams.length === 0) return
  const CHUNK = 800
  const byId = new Map<string, string[]>()
  for (let i = 0; i < engrams.length; i += CHUNK) {
    const batch = engrams.slice(i, i + CHUNK)
    const placeholders = batch.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT engram_id, subject_id FROM engram_subjects WHERE engram_id IN (${placeholders}) ORDER BY subject_id`
    ).all(...batch.map(e => e.id)) as Array<{ engram_id: string, subject_id: string }>
    for (const r of rows) {
      const arr = byId.get(r.engram_id)
      if (arr) arr.push(r.subject_id)
      else byId.set(r.engram_id, [r.subject_id])
    }
  }
  for (const e of engrams) e.subjects = byId.get(e.id) ?? []
}

/**
 * v0.14: Subject registry — the "heavy facet" (spec §B.3).
 *
 * A subject is a concrete, bounded strand with a lifecycle (`v0.14-planning`,
 * `norway-trip`) — what an engram BELONGS TO, across scopes. Structurally a
 * twin of the tag registry (slug id, register-before-use, junction table), but
 * it carries a `description` and a `status` (active | closed). The lifecycle is
 * what makes a subject structurally not-a-tag: a tag can never be "done".
 *
 * Membership (engram ↔ subject) lives in the `engram_subjects` junction, written by
 * EngramStore — NOT here, and deliberately separate from the `relations` table.
 * Closing a subject leaves its memberships untouched (a closed strand still renders).
 */
export function slugifySubject(name: string): string {
  return slugifyTag(name)
}

export class SubjectStore {
  constructor(private db: Database.Database) {}

  get(id: string): Subject | null {
    const row = this.db.prepare(`
      SELECT t.*, (SELECT COUNT(*) FROM engram_subjects et WHERE et.subject_id = t.id) AS engram_count
      FROM subjects t WHERE t.id = ?
    `).get(slugifySubject(id)) as any
    return row ? this.rowToSubject(row) : null
  }

  /** All subjects (optionally one status), active first, then by id. */
  list(status?: SubjectStatus): Subject[] {
    const rows = this.db.prepare(`
      SELECT t.*, (SELECT COUNT(*) FROM engram_subjects et WHERE et.subject_id = t.id) AS engram_count
      FROM subjects t
      ${status ? 'WHERE t.status = ?' : ''}
      ORDER BY CASE t.status WHEN 'active' THEN 0 ELSE 1 END, t.id ASC
    `).all(...(status ? [status] : [])) as any[]
    return rows.map(r => this.rowToSubject(r))
  }

  exists(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM subjects WHERE id = ?').get(id)
  }

  /** Status of each registered id among the given ones — one query, for batch write-validation. */
  statusByIds(ids: string[]): Map<string, SubjectStatus> {
    const uniq = [...new Set(ids)]
    if (uniq.length === 0) return new Map()
    const placeholders = uniq.map(() => '?').join(',')
    const rows = this.db.prepare(
      `SELECT id, status FROM subjects WHERE id IN (${placeholders})`
    ).all(...uniq) as Array<{ id: string, status: SubjectStatus }>
    return new Map(rows.map(r => [r.id, r.status]))
  }

  rowToSubject(row: any): Subject {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      status: row.status,
      engram_count: row.engram_count ?? 0,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }
}
