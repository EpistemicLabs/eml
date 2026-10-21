import Database from 'better-sqlite3'
import { Entity, EntityInput, EntityKind, EntityStatus, EntityUpdate } from './types'

// v0.8 C6: first-class entities table for external parties (people, orgs,
// assets). Replaces the free-form `external.<x>` scope convention with
// a typed existence check.

export class EntityStore {
  constructor(private db: Database.Database) {}

  create(input: EntityInput): Entity {
    this.db.prepare(`
      INSERT INTO entities (id, name, kind, status, description, metadata, status_tracks, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      input.id,
      input.name,
      input.kind,
      input.status ?? 'active',
      input.description ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.status_tracks ?? null,
    )
    return this.get(input.id)!
  }

  get(id: string): Entity | null {
    const row = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as any
    if (!row) return null
    return this.rowToEntity(row)
  }

  list(filter?: { kind?: EntityKind, status?: EntityStatus }): Entity[] {
    const where: string[] = []
    const params: string[] = []
    if (filter?.kind) { where.push('kind = ?'); params.push(filter.kind) }
    if (filter?.status) { where.push('status = ?'); params.push(filter.status) }
    return (this.db.prepare(
      `SELECT * FROM entities ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`,
    ).all(...params) as any[]).map(r => this.rowToEntity(r))
  }

  update(id: string, patch: EntityUpdate): Entity | null {
    const existing = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as any
    if (!existing) return null

    const fields: string[] = []
    const params: any[] = []

    if (patch.name !== undefined)        { fields.push('name = ?');        params.push(patch.name) }
    if (patch.kind !== undefined)        { fields.push('kind = ?');        params.push(patch.kind) }
    if (patch.description !== undefined) { fields.push('description = ?'); params.push(patch.description) }
    if (patch.status !== undefined)      { fields.push('status = ?');      params.push(patch.status) }
    if (patch.metadata !== undefined)    { fields.push('metadata = ?');    params.push(patch.metadata === null ? null : JSON.stringify(patch.metadata)) }
    if (patch.status_tracks !== undefined) { fields.push('status_tracks = ?'); params.push(patch.status_tracks) }

    if (fields.length === 0) return this.rowToEntity(existing)

    fields.push("updated_at = datetime('now')")
    params.push(id)
    this.db.prepare(`UPDATE entities SET ${fields.join(', ')} WHERE id = ?`).run(...params)
    return this.get(id)
  }

  exists(id: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM entities WHERE id = ?').get(id)
    return !!row
  }

  private rowToEntity(row: any): Entity {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      status: row.status ?? 'active',
      description: row.description ?? null,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      status_tracks: row.status_tracks ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }
}
