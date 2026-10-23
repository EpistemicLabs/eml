import Database from 'better-sqlite3'
import { Entity, EntityKind, EntityStatus } from './types'

// v0.8 C6: first-class entities table for external parties (people, orgs,
// assets). Replaces the free-form `external.<x>` scope convention with
// a typed existence check.

export class EntityStore {
  constructor(private db: Database.Database) {}

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

  exists(id: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM entities WHERE id = ?').get(id)
    return !!row
  }

  rowToEntity(row: any): Entity {
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
