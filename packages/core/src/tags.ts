import Database from 'better-sqlite3'
import { Tag, TagInput, TagUpdate, Engram } from './types'

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
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export class TagStore {
  constructor(private db: Database.Database) {}

  /**
   * Register a tag. The slug id is derived from `name`. Re-creating an existing
   * slug is a no-op that returns the existing tag (reuse, not duplicate) — this
   * is what lets the write-side recall-first discipline stay cheap.
   */
  create(input: TagInput): Tag {
    const id = slugifyTag(input.name)
    if (!id) {
      throw new Error(
        `invalid tag name "${input.name}" — must contain at least one letter or digit`
      )
    }
    const existing = this.get(id)
    if (existing) return existing
    this.db.prepare(
      `INSERT INTO tags (id, name, description) VALUES (?, ?, ?)`
    ).run(id, input.name.trim(), input.description ?? null)
    return this.get(id)!
  }

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

  /**
   * v0.19: rename (the id stays), describe, archive or restore. An archived tag
   * stays on the engrams that carry it but cannot be assigned anew.
   */
  update(id: string, patch: TagUpdate): Tag | null {
    if (!this.exists(id)) return null
    const fields: string[] = []
    const params: unknown[] = []
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new Error('invalid tag name — must not be empty')
      fields.push('name = ?'); params.push(patch.name.trim())
    }
    if (patch.description !== undefined) { fields.push('description = ?'); params.push(patch.description) }
    if (patch.status !== undefined) {
      if (patch.status !== 'active' && patch.status !== 'archived') throw new Error('invalid tag status — active or archived')
      fields.push('status = ?'); params.push(patch.status)
    }
    if (fields.length > 0) this.db.prepare(`UPDATE tags SET ${fields.join(', ')} WHERE id = ?`).run(...params, id)
    return this.get(id)
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

  private rowToTag(row: any): Tag {
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
