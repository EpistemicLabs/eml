import type Database from 'better-sqlite3'
import type { Stamp } from '../env'
import type { EngramStore } from '../engrams'
import type { ProjectStore } from '../projects'
import type { UserStore } from '../users'
import type { AgentStore } from '../agents'
import type { EntityStore } from '../entities'
import type { TagStore } from '../tags'
import type { SubjectStore } from '../subjects'

// --- Write helpers (v0.20) -------------------------------------------------------
//
// The pieces the write commands share (supersede, tags and subjects,
// wikilinks, task binding, conflict search, scope, object rows) as plain
// functions over one write context. They run inside apply()'s transaction and
// take the time and ids from the write's one Stamp.

/** What a write helper works with: the connection, the write's Stamp and the reads it needs. */
export interface WriteContext {
  db: Database.Database
  stamp: Stamp
  store: EngramStore
  projects: ProjectStore
  users: UserStore
  agents: AgentStore
  entities: EntityStore
  tags: TagStore
  subjects: SubjectStore
}

/** An engram's properties as stored (an unknown id has none). */
export function propsOf(ctx: WriteContext, id: string): Record<string, unknown> {
  const row = ctx.db.prepare('SELECT properties FROM engrams WHERE id = ?').get(id) as { properties: string | null } | undefined
  return row?.properties ? JSON.parse(row.properties) : {}
}
