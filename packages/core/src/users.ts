import Database from 'better-sqlite3'
import { type Env, DEFAULT_ENV } from './env'
import { User, UserInput, UserUpdate } from './types'

// v0.9 Cluster 1: reserved-IDs list removed (master/global conflicts no longer
// exist) and the default_namespace column removed from the code layer
// (multi-caller artifact). The default_namespace DB column was dropped in
// v0.9_migrate.sql.

export class UserStore {
  constructor(private db: Database.Database, private env: Env = DEFAULT_ENV) {}

  get(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any
    if (!row) return null
    return this.rowToUser(row)
  }

  list(): User[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY created_at DESC').all() as any[])
      .map(r => this.rowToUser(r))
  }

  exists(id: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)
    return !!row
  }

  rowToUser(row: any): User {
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
