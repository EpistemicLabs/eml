import Database from 'better-sqlite3'
import { Tag, Engram } from './types'

/**
 * v0.12: batch-load registered tag ids onto a set of engrams IN PLACE — ONE query
 * for the whole array (chunked under SQLite's variable limit), not one per engram.
 * Shared by EngramStore and ProjectStore so tag hydration lives in ONE place across
 * every read path (query/get/getRaw + the project brain-state snapshot).
 */
export function hydrateEngramTags(db: Database.Database, engrams: Engram[]): void {
  if (engrams.length === 0) return
  const CHUNK = 800
  const byId = new Map<string, string[]>()
  for (let i = 0; i < engrams.length; i += CHUNK) {
    const batch = engrams.slice(i, i + CHUNK)
    const placeholders = batch.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT engram_id, tag_id FROM engram_tags WHERE engram_id IN (${placeholders}) ORDER BY tag_id`
    ).all(...batch.map(e => e.id)) as Array<{ engram_id: string, tag_id: string }>
    for (const r of rows) {
      const arr = byId.get(r.engram_id)
      if (arr) arr.push(r.tag_id)
      else byId.set(r.engram_id, [r.tag_id])
    }
  }
  for (const e of engrams) e.tags = byId.get(e.id) ?? []
}

/**
 * v0.12: Tag registry — a controlled facet axis on engrams.
 *
 * Tags are a first-class, per-brain vocabulary (parallel to projects): a tag
 * must be REGISTERED before an engram may carry it (the engram write path
 * validates against this store). `id` is the normalized slug of `name`, so a
 * tag is a stable, referenceable node id in the cockpit graph.
 *
 * Membership (engram ↔ tag) lives in the `engram_tags` junction, written by
 * EngramStore — NOT here, and deliberately separate from the `relations` table.
 */
export function slugifyTag(name: string): string {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join('-')
}

export class TagStore {
  constructor(private db: Database.Database) {}

  get(id: string): Tag | null {
    const row = this.db.prepare(`
      SELECT t.*, (SELECT COUNT(*) FROM engram_tags et WHERE et.tag_id = t.id) AS engram_count
      FROM tags t WHERE t.id = ?
    `).get(id) as any
    return row ? this.rowToTag(row) : null
  }

  /** The registered tags (v0.19: active only unless a status is asked for), with their usage. */
  list(status?: 'active' | 'archived'): Tag[] {
    const rows = this.db.prepare(`
      SELECT t.*, (SELECT COUNT(*) FROM engram_tags et WHERE et.tag_id = t.id) AS engram_count
      FROM tags t ${status ? 'WHERE t.status = ?' : ''} ORDER BY t.id ASC
    `).all(...(status ? [status] : [])) as any[]
    return rows.map(r => this.rowToTag(r))
  }

  /** The archived ones among the given ids. */
  archivedIds(ids: string[]): Set<string> {
    const uniq = [...new Set(ids)]
    if (uniq.length === 0) return new Set()
    const rows = this.db.prepare(
      `SELECT id FROM tags WHERE status = 'archived' AND id IN (${uniq.map(() => '?').join(',')})`,
    ).all(...uniq) as Array<{ id: string }>
    return new Set(rows.map(r => r.id))
  }

  exists(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM tags WHERE id = ?').get(id)
  }

  /** Which of the given ids are registered — one query, for batch write-validation. */
  existingIds(ids: string[]): Set<string> {
    const uniq = [...new Set(ids)]
    if (uniq.length === 0) return new Set()
    const placeholders = uniq.map(() => '?').join(',')
    const rows = this.db.prepare(
      `SELECT id FROM tags WHERE id IN (${placeholders})`
    ).all(...uniq) as Array<{ id: string }>
    return new Set(rows.map(r => r.id))
  }

  rowToTag(row: any): Tag {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      status: row.status ?? 'active',
      engram_count: row.engram_count ?? 0,
      created_at: row.created_at,
    }
  }
}
