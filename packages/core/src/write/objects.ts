import {
  Project, ProjectInput, ProjectUpdate, Entity, EntityInput, EntityUpdate, User, UserInput, UserUpdate,
  Agent, AgentInput, AgentUpdate, Tag, TagInput, TagUpdate, Subject, SubjectInput, SubjectUpdate,
} from '../types'
import { slugifyTag } from '../tags'
import { slugifySubject } from '../subjects'
import type Database from 'better-sqlite3'
import type { WriteContext } from './context'

// The rows of the object stores (project, entity, user, agent, tag, subject):
// the object commands write them, with the write's one timestamp. The stores
// on EML keep the reads.
//
// v0.21: each table has one row writer that takes the row as stored — the one
// INSERT of that table. create* fill in the write's time and the defaults; the
// cross-brain import passes rows as they are.

export interface ProjectRow {
  id: string, name: string, status: string, goal: string | null, description: string | null, owner: string | null,
  parent_project: string | null, started_at: string | null, ended_at: string | null, metadata: string | null,
  status_tracks: string | null, created_at: string, updated_at: string,
}
export interface EntityRow {
  id: string, name: string, kind: string, status: string, description: string | null, metadata: string | null,
  status_tracks: string | null, created_at: string, updated_at: string,
}
export interface UserRow {
  id: string, name: string, email: string | null, description: string | null, metadata: string | null,
  created_at: string, updated_at: string,
}
export interface AgentRow {
  id: string, name: string, parent_id: string | null, domains: string | null, description: string | null,
  metadata: string | null, created_at: string,
}
export interface TagRow { id: string, name: string, description: string | null, status: string, created_at: string }
export interface SubjectRow { id: string, name: string, description: string | null, status: string, created_at: string, updated_at: string }

export function insertProjectRow(db: Database.Database, row: ProjectRow): void {
  db.prepare(`
    INSERT INTO projects (
      id, name, status, goal, description, owner,
      parent_project, started_at, ended_at, metadata, status_tracks,
      created_at, updated_at
    ) VALUES (@id, @name, @status, @goal, @description, @owner, @parent_project, @started_at, @ended_at, @metadata, @status_tracks, @created_at, @updated_at)
  `).run(row)
}

export function insertEntityRow(db: Database.Database, row: EntityRow): void {
  db.prepare(`
    INSERT INTO entities (id, name, kind, status, description, metadata, status_tracks, created_at, updated_at)
    VALUES (@id, @name, @kind, @status, @description, @metadata, @status_tracks, @created_at, @updated_at)
  `).run(row)
}

export function insertUserRow(db: Database.Database, row: UserRow): void {
  db.prepare(`
    INSERT INTO users (id, name, email, description, metadata, created_at, updated_at)
    VALUES (@id, @name, @email, @description, @metadata, @created_at, @updated_at)
  `).run(row)
}

export function insertAgentRow(db: Database.Database, row: AgentRow): void {
  db.prepare(`
    INSERT INTO agents (id, name, parent_id, domains, description, metadata, created_at)
    VALUES (@id, @name, @parent_id, @domains, @description, @metadata, @created_at)
  `).run(row)
}

export function insertTagRow(db: Database.Database, row: TagRow): void {
  db.prepare(`INSERT INTO tags (id, name, description, status, created_at) VALUES (@id, @name, @description, @status, @created_at)`).run(row)
}

export function insertSubjectRow(db: Database.Database, row: SubjectRow): void {
  db.prepare(`INSERT INTO subjects (id, name, description, status, created_at, updated_at) VALUES (@id, @name, @description, @status, @created_at, @updated_at)`).run(row)
}

export function createProject(ctx: WriteContext, input: ProjectInput): Project {
  const at = ctx.stamp.at
  if (input.parent_project) {
    ctx.projects.assertNoCycle(input.id, input.parent_project)
  }
  insertProjectRow(ctx.db, {
    id: input.id,
    name: input.name,
    status: input.status ?? 'active',
    goal: input.goal ?? null,
    description: input.description ?? null,
    owner: input.owner ?? null,
    parent_project: input.parent_project ?? null,
    started_at: input.started_at ?? null,
    ended_at: input.ended_at ?? null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    status_tracks: input.status_tracks ?? null,
    created_at: at, updated_at: at,
  })
  return ctx.projects.get(input.id)!
}

export function updateProject(ctx: WriteContext, id: string, patch: ProjectUpdate): Project | null {
  const at = ctx.stamp.at
  const existing = ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any
  if (!existing) return null

  if (patch.parent_project !== undefined && patch.parent_project !== null) {
    ctx.projects.assertNoCycle(id, patch.parent_project)
  }

  const fields: string[] = []
  const params: any[] = []

  if (patch.name !== undefined)           { fields.push('name = ?');           params.push(patch.name) }
  if (patch.status !== undefined)         { fields.push('status = ?');         params.push(patch.status) }
  if (patch.goal !== undefined)           { fields.push('goal = ?');           params.push(patch.goal) }
  if (patch.description !== undefined)    { fields.push('description = ?');    params.push(patch.description) }
  if (patch.owner !== undefined)          { fields.push('owner = ?');          params.push(patch.owner) }
  if (patch.parent_project !== undefined) { fields.push('parent_project = ?'); params.push(patch.parent_project) }
  if (patch.started_at !== undefined)     { fields.push('started_at = ?');     params.push(patch.started_at) }
  if (patch.ended_at !== undefined)       { fields.push('ended_at = ?');       params.push(patch.ended_at) }
  if (patch.metadata !== undefined)       { fields.push('metadata = ?');       params.push(patch.metadata === null ? null : JSON.stringify(patch.metadata)) }
  if (patch.status_tracks !== undefined)  { fields.push('status_tracks = ?');  params.push(patch.status_tracks) }

  if (fields.length === 0) return ctx.projects.rowToProject(existing)

  fields.push('updated_at = ?')
  params.push(at, id)
  ctx.db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...params)
  return ctx.projects.get(id)
}

export function createEntity(ctx: WriteContext, input: EntityInput): Entity {
  const at = ctx.stamp.at
  insertEntityRow(ctx.db, {
    id: input.id,
    name: input.name,
    kind: input.kind,
    status: input.status ?? 'active',
    description: input.description ?? null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    status_tracks: input.status_tracks ?? null,
    created_at: at, updated_at: at,
  })
  return ctx.entities.get(input.id)!
}

export function updateEntity(ctx: WriteContext, id: string, patch: EntityUpdate): Entity | null {
  const at = ctx.stamp.at
  const existing = ctx.db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as any
  if (!existing) return null

  const fields: string[] = []
  const params: any[] = []

  if (patch.name !== undefined)        { fields.push('name = ?');        params.push(patch.name) }
  if (patch.kind !== undefined)        { fields.push('kind = ?');        params.push(patch.kind) }
  if (patch.description !== undefined) { fields.push('description = ?'); params.push(patch.description) }
  if (patch.status !== undefined)      { fields.push('status = ?');      params.push(patch.status) }
  if (patch.metadata !== undefined)    { fields.push('metadata = ?');    params.push(patch.metadata === null ? null : JSON.stringify(patch.metadata)) }
  if (patch.status_tracks !== undefined) { fields.push('status_tracks = ?'); params.push(patch.status_tracks) }

  if (fields.length === 0) return ctx.entities.rowToEntity(existing)

  fields.push('updated_at = ?')
  params.push(at, id)
  ctx.db.prepare(`UPDATE entities SET ${fields.join(', ')} WHERE id = ?`).run(...params)
  return ctx.entities.get(id)
}

export function createUser(ctx: WriteContext, input: UserInput): User {
  const at = ctx.stamp.at
  insertUserRow(ctx.db, {
    id: input.id,
    name: input.name,
    email: input.email ?? null,
    description: input.description ?? null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    created_at: at, updated_at: at,
  })
  return ctx.users.get(input.id)!
}

export function updateUser(ctx: WriteContext, id: string, patch: UserUpdate): User | null {
  const at = ctx.stamp.at
  const existing = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any
  if (!existing) return null

  const fields: string[] = []
  const params: any[] = []

  if (patch.name !== undefined)              { fields.push('name = ?');              params.push(patch.name) }
  if (patch.email !== undefined)             { fields.push('email = ?');             params.push(patch.email) }
  if (patch.description !== undefined)       { fields.push('description = ?');       params.push(patch.description) }
  if (patch.metadata !== undefined)          { fields.push('metadata = ?');          params.push(JSON.stringify(patch.metadata)) }

  if (fields.length === 0) return ctx.users.rowToUser(existing)

  fields.push('updated_at = ?')
  params.push(at, id)
  ctx.db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...params)
  return ctx.users.get(id)
}

export function createAgent(ctx: WriteContext, input: AgentInput): Agent {
  const at = ctx.stamp.at
  insertAgentRow(ctx.db, {
    id: input.id,
    name: input.name,
    parent_id: input.parent_id ?? null,
    domains: input.domains ? JSON.stringify(input.domains) : null,
    description: input.description ?? null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    created_at: at,
  })
  return ctx.agents.get(input.id)!
}

export function updateAgent(ctx: WriteContext, id: string, patch: AgentUpdate): Agent | null {
  const existing = ctx.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any
  if (!existing) return null

  const fields: string[] = []
  const params: any[] = []

  if (patch.name !== undefined)              { fields.push('name = ?');              params.push(patch.name) }
  if (patch.parent_id !== undefined)         { fields.push('parent_id = ?');         params.push(patch.parent_id) }
  if (patch.domains !== undefined)           { fields.push('domains = ?');           params.push(JSON.stringify(patch.domains)) }
  if (patch.description !== undefined)       { fields.push('description = ?');       params.push(patch.description) }
  if (patch.metadata !== undefined)          { fields.push('metadata = ?');          params.push(JSON.stringify(patch.metadata)) }

  if (fields.length === 0) return ctx.agents.rowToAgent(existing)

  params.push(id)
  ctx.db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...params)
  return ctx.agents.get(id)
}

/**
 * Register a tag. The slug id is derived from `name`. Re-creating an existing
 * slug is a no-op that returns the existing tag (reuse, not duplicate) — this
 * is what lets the write-side recall-first discipline stay cheap.
 */
export function createTag(ctx: WriteContext, input: TagInput): Tag {
  const at = ctx.stamp.at
  const id = slugifyTag(input.name)
  if (!id) {
    throw new Error(
      `invalid tag name "${input.name}" — must contain at least one letter or digit`
    )
  }
  const existing = ctx.tags.get(id)
  if (existing) return existing
  insertTagRow(ctx.db, { id, name: input.name.trim(), description: input.description ?? null, status: 'active', created_at: at })
  return ctx.tags.get(id)!
}

/**
 * v0.19: rename (the id stays), describe, archive or restore. An archived tag
 * stays on the engrams that carry it but cannot be assigned anew.
 */
export function updateTag(ctx: WriteContext, id: string, patch: TagUpdate): Tag | null {
  if (!ctx.tags.exists(id)) return null
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
  if (fields.length > 0) ctx.db.prepare(`UPDATE tags SET ${fields.join(', ')} WHERE id = ?`).run(...params, id)
  return ctx.tags.get(id)
}

/**
 * Register a subject. The slug id is derived from `name`. Re-creating an
 * existing slug is a no-op that returns the existing subject (reuse, not
 * duplicate) — it neither reopens a closed subject nor overwrites its description.
 */
export function createSubject(ctx: WriteContext, input: SubjectInput): Subject {
  const at = ctx.stamp.at
  const id = slugifySubject(input.name)
  if (!id) {
    throw new Error(
      `invalid subject name "${input.name}" — must contain at least one letter or digit`
    )
  }
  const existing = ctx.subjects.get(id)
  if (existing) return existing
  insertSubjectRow(ctx.db, { id, name: input.name.trim(), description: input.description ?? null, status: 'active', created_at: at, updated_at: at })
  return ctx.subjects.get(id)!
}

/**
 * Update name / description / status (close or reopen). The id (slug) is
 * stable — renaming changes the display name only, never the reference.
 * Throws on an unknown subject.
 */
export function updateSubject(ctx: WriteContext, id: string, patch: SubjectUpdate): Subject {
  const at = ctx.stamp.at
  const slug = slugifySubject(id)
  if (!ctx.subjects.exists(slug)) throw new Error(`subject "${id}" not found`)
  const fields: string[] = []
  const params: any[] = []
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) throw new Error('subject name must not be empty')
    fields.push('name = ?'); params.push(name)
  }
  if (patch.description !== undefined) { fields.push('description = ?'); params.push(patch.description) }
  if (patch.status !== undefined) {
    if (patch.status !== 'active' && patch.status !== 'closed') {
      throw new Error(`invalid subject status "${patch.status}" — must be active or closed`)
    }
    fields.push('status = ?'); params.push(patch.status)
  }
  if (fields.length > 0) {
    fields.push('updated_at = ?')
    ctx.db.prepare(`UPDATE subjects SET ${fields.join(', ')} WHERE id = ?`).run(...params, at, slug)
  }
  return ctx.subjects.get(slug)!
}
