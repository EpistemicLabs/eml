import Database from 'better-sqlite3'
import { Agent } from './types'

// v0.9 Cluster 1: reserved-IDs list removed (master/global conflicts no longer
// exist) and the default_namespace column removed from the code layer
// (multi-caller artifact). The default_namespace DB column was dropped in
// v0.9_migrate.sql.

export class AgentStore {
  constructor(private db: Database.Database) {}

  get(id: string): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any
    if (!row) return null
    return this.rowToAgent(row)
  }

  list(): Agent[] {
    return (this.db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all() as any[])
      .map(r => this.rowToAgent(r))
  }

  exists(id: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(id)
    return !!row
  }

  rowToAgent(row: any): Agent {
    return {
      id: row.id,
      name: row.name,
      parent_id: row.parent_id ?? null,
      domains: row.domains ? JSON.parse(row.domains) : null,
      description: row.description ?? null,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      created_at: row.created_at,
    }
  }
}
