import Database from 'better-sqlite3'
import { Agent, AgentInput, AgentUpdate } from './types'

// v0.9 Cluster 1: reserved-IDs list removed (master/global conflicts no longer
// exist) and the default_namespace column removed from the code layer
// (multi-caller artifact). The default_namespace DB column was dropped in
// v0.9_migrate.sql.

export class AgentStore {
  constructor(private db: Database.Database) {}

  store(input: AgentInput): Agent {
    this.db.prepare(`
      INSERT INTO agents (
        id, name, parent_id,
        domains, description, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      input.id,
      input.name,
      input.parent_id ?? null,
      input.domains ? JSON.stringify(input.domains) : null,
      input.description ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null
    )
    return this.get(input.id)!
  }

  get(id: string): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any
    if (!row) return null
    return this.rowToAgent(row)
  }

  list(): Agent[] {
    return (this.db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all() as any[])
      .map(r => this.rowToAgent(r))
  }

  update(id: string, patch: AgentUpdate): Agent | null {
    const existing = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any
    if (!existing) return null

    const fields: string[] = []
    const params: any[] = []

    if (patch.name !== undefined)              { fields.push('name = ?');              params.push(patch.name) }
    if (patch.parent_id !== undefined)         { fields.push('parent_id = ?');         params.push(patch.parent_id) }
    if (patch.domains !== undefined)           { fields.push('domains = ?');           params.push(JSON.stringify(patch.domains)) }
    if (patch.description !== undefined)       { fields.push('description = ?');       params.push(patch.description) }
    if (patch.metadata !== undefined)          { fields.push('metadata = ?');          params.push(JSON.stringify(patch.metadata)) }

    if (fields.length === 0) return this.rowToAgent(existing)

    params.push(id)
    this.db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...params)
    return this.get(id)
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM agents WHERE id = ?').run(id).changes > 0
  }

  exists(id: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(id)
    return !!row
  }

  private rowToAgent(row: any): Agent {
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
