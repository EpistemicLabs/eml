import Database from 'better-sqlite3'
import { type Env, DEFAULT_ENV } from './env'
import { User, UserInput, UserUpdate } from './types'

// v0.9 Cluster 1: reserved-IDs list removed (master/global conflicts no longer
// exist) and the default_namespace column removed from the code layer
// (multi-caller artifact). The default_namespace DB column was dropped in
// v0.9_migrate.sql.

export class UserStore {
  constructor(private db: Database.Database, private env: Env = DEFAULT_ENV) {}

  create(input: UserInput, env: Env = this.env): User {
    const at = env.now()
    this.db.prepare(`
      INSERT INTO users (
        id, name, email, description, metadata,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.name,
      input.email ?? null,
      input.description ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      at, at,
    )
    return this.get(input.id)!
  }

  get(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any
    if (!row) return null
    return this.rowToUser(row)
  }

  list(): User[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY created_at DESC').all() as any[])
      .map(r => this.rowToUser(r))
  }

  update(id: string, patch: UserUpdate, env: Env = this.env): User | null {
    const at = env.now()
    const existing = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any
    if (!existing) return null

    const fields: string[] = []
    const params: any[] = []

    if (patch.name !== undefined)              { fields.push('name = ?');              params.push(patch.name) }
    if (patch.email !== undefined)             { fields.push('email = ?');             params.push(patch.email) }
    if (patch.description !== undefined)       { fields.push('description = ?');       params.push(patch.description) }
    if (patch.metadata !== undefined)          { fields.push('metadata = ?');          params.push(JSON.stringify(patch.metadata)) }

    if (fields.length === 0) return this.rowToUser(existing)

    fields.push('updated_at = ?')
    params.push(at, id)
    this.db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...params)
    return this.get(id)
  }

  exists(id: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)
    return !!row
  }

  private rowToUser(row: any): User {
    return {
      id: row.id,
      name: row.name,
      email: row.email ?? null,
      description: row.description ?? null,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }
}
