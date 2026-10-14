import Database from 'better-sqlite3'
import { Label, LabelInput, Engram } from './types'

/**
 * v0.13: batch-load registered label ids onto a set of engrams IN PLACE — ONE
 * query for the whole array (chunked under SQLite's variable limit), not one per
 * engram. Mirror of hydrateEngramTags; called at every read boundary so all read
 * paths expose labels without an N+1.
 */
export function hydrateEngramLabels(db: Database.Database, engrams: Engram[]): void {
  if (engrams.length === 0) return
  const CHUNK = 800
  const byId = new Map<string, string[]>()
  for (let i = 0; i < engrams.length; i += CHUNK) {
    const batch = engrams.slice(i, i + CHUNK)
    const placeholders = batch.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT engram_id, label_id FROM engram_labels WHERE engram_id IN (${placeholders}) ORDER BY label_id`
    ).all(...batch.map(e => e.id)) as Array<{ engram_id: string, label_id: string }>
    for (const r of rows) {
      const arr = byId.get(r.engram_id)
      if (arr) arr.push(r.label_id)
      else byId.set(r.engram_id, [r.label_id])
    }
  }
  for (const e of engrams) e.labels = byId.get(e.id) ?? []
}

/**
 * v0.13: Label registry — a controlled WORKFLOW/ROLE facet on engrams, parallel
 * to tags but orthogonal in meaning: a label marks what function an engram serves
 * right now (e.g. `review`), not its subject. `id` is the normalized slug of `name`.
 *
 * Membership (engram ↔ label) lives in the `engram_labels` junction. In the MVP
 * the ONLY writer is the server's nightly review-sweep — there is no create-tool
 * and no manual write path; the vocabulary is fixed (seeded in v0.13_migrate.sql).
 * The store below is the read/registry surface (+ create for future use).
 */
export function slugifyLabel(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export class LabelStore {
  constructor(private db: Database.Database) {}

  /**
   * Register a label. The slug id is derived from `name`. Re-creating an existing
   * slug returns the existing label (reuse, not duplicate). Not exposed as a tool
   * in the MVP — kept for parity with TagStore and future label vocab growth.
   */
  create(input: LabelInput): Label {
    const id = slugifyLabel(input.name)
    if (!id) {
      throw new Error(
        `invalid label name "${input.name}" — must contain at least one letter or digit`
      )
    }
    const existing = this.get(id)
    if (existing) return existing
    this.db.prepare(
      `INSERT INTO labels (id, name, description) VALUES (?, ?, ?)`
    ).run(id, input.name.trim(), input.description ?? null)
    return this.get(id)!
  }

  get(id: string): Label | null {
    const row = this.db.prepare('SELECT * FROM labels WHERE id = ?').get(id) as any
    return row ? this.rowToLabel(row) : null
  }

  list(): Label[] {
    const rows = this.db.prepare('SELECT * FROM labels ORDER BY id ASC').all() as any[]
    return rows.map(r => this.rowToLabel(r))
  }

  exists(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM labels WHERE id = ?').get(id)
  }

  private rowToLabel(row: any): Label {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      created_at: row.created_at,
    }
  }
}
