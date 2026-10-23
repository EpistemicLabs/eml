import type Database from 'better-sqlite3'
import {
  Project, ProjectInput, ProjectUpdate, Entity, EntityInput, EntityUpdate, User, UserInput, UserUpdate,
  Agent, AgentInput, AgentUpdate, Tag, TagInput, TagUpdate, Subject, SubjectInput, SubjectUpdate,
} from './types'
import type { ProjectStore } from './projects'
import type { EntityStore } from './entities'
import type { UserStore } from './users'
import type { AgentStore } from './agents'
import { TagStore, slugifyTag } from './tags'
import { SubjectStore, slugifySubject } from './subjects'

/**
 * v0.20: the writes of the object stores (project, entity, user, agent, tag,
 * subject) — internal to core. Only the object commands (commands/) call them,
 * inside apply()'s transaction, with the write's one timestamp. The stores on
 * EML keep the reads.
 */
export class ObjectWriter {
  constructor(
    private db: Database.Database,
    private projects: ProjectStore,
    private entities: EntityStore,
    private users: UserStore,
    private agents: AgentStore,
    private tags: TagStore,
    private subjects: SubjectStore,
  ) {}

  createProject(input: ProjectInput, at: string): Project {
    if (input.parent_project) {
      this.projects.assertNoCycle(input.id, input.parent_project)
    }
    this.db.prepare(`
      INSERT INTO projects (
        id, name, status, goal, description, owner,
        parent_project, started_at, ended_at, metadata, status_tracks,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.name,
      input.status ?? 'active',
      input.goal ?? null,
      input.description ?? null,
      input.owner ?? null,
      input.parent_project ?? null,
      input.started_at ?? null,
      input.ended_at ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.status_tracks ?? null,
      at, at,
    )
    return this.projects.get(input.id)!
  }

  updateProject(id: string, patch: ProjectUpdate, at: string): Project | null {
    const existing = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any
    if (!existing) return null

    if (patch.parent_project !== undefined && patch.parent_project !== null) {
      this.projects.assertNoCycle(id, patch.parent_project)
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

    if (fields.length === 0) return this.projects.rowToProject(existing)

    fields.push('updated_at = ?')
    params.push(at, id)
    this.db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...params)
    return this.projects.get(id)
  }

  createEntity(input: EntityInput, at: string): Entity {
    this.db.prepare(`
      INSERT INTO entities (id, name, kind, status, description, metadata, status_tracks, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.name,
      input.kind,
      input.status ?? 'active',
      input.description ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.status_tracks ?? null,
      at, at,
    )
    return this.entities.get(input.id)!
  }

  updateEntity(id: string, patch: EntityUpdate, at: string): Entity | null {
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

    if (fields.length === 0) return this.entities.rowToEntity(existing)

    fields.push('updated_at = ?')
    params.push(at, id)
    this.db.prepare(`UPDATE entities SET ${fields.join(', ')} WHERE id = ?`).run(...params)
    return this.entities.get(id)
  }

  createUser(input: UserInput, at: string): User {
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
    return this.users.get(input.id)!
  }

  updateUser(id: string, patch: UserUpdate, at: string): User | null {
    const existing = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any
    if (!existing) return null

    const fields: string[] = []
    const params: any[] = []

    if (patch.name !== undefined)              { fields.push('name = ?');              params.push(patch.name) }
    if (patch.email !== undefined)             { fields.push('email = ?');             params.push(patch.email) }
    if (patch.description !== undefined)       { fields.push('description = ?');       params.push(patch.description) }
    if (patch.metadata !== undefined)          { fields.push('metadata = ?');          params.push(JSON.stringify(patch.metadata)) }

    if (fields.length === 0) return this.users.rowToUser(existing)

    fields.push('updated_at = ?')
    params.push(at, id)
    this.db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...params)
    return this.users.get(id)
  }

  createAgent(input: AgentInput, at: string): Agent {
    this.db.prepare(`
      INSERT INTO agents (
        id, name, parent_id,
        domains, description, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.name,
      input.parent_id ?? null,
      input.domains ? JSON.stringify(input.domains) : null,
      input.description ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      at,
    )
    return this.agents.get(input.id)!
  }

  updateAgent(id: string, patch: AgentUpdate): Agent | null {
    const existing = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any
    if (!existing) return null

    const fields: string[] = []
    const params: any[] = []

    if (patch.name !== undefined)              { fields.push('name = ?');              params.push(patch.name) }
    if (patch.parent_id !== undefined)         { fields.push('parent_id = ?');         params.push(patch.parent_id) }
    if (patch.domains !== undefined)           { fields.push('domains = ?');           params.push(JSON.stringify(patch.domains)) }
    if (patch.description !== undefined)       { fields.push('description = ?');       params.push(patch.description) }
    if (patch.metadata !== undefined)          { fields.push('metadata = ?');          params.push(JSON.stringify(patch.metadata)) }

    if (fields.length === 0) return this.agents.rowToAgent(existing)

    params.push(id)
    this.db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...params)
    return this.agents.get(id)
  }

  /**
   * Register a tag. The slug id is derived from `name`. Re-creating an existing
   * slug is a no-op that returns the existing tag (reuse, not duplicate) — this
   * is what lets the write-side recall-first discipline stay cheap.
   */
  createTag(input: TagInput, at: string): Tag {
    const id = slugifyTag(input.name)
    if (!id) {
      throw new Error(
        `invalid tag name "${input.name}" — must contain at least one letter or digit`
      )
    }
    const existing = this.tags.get(id)
    if (existing) return existing
    this.db.prepare(
      `INSERT INTO tags (id, name, description, created_at) VALUES (?, ?, ?, ?)`
    ).run(id, input.name.trim(), input.description ?? null, at)
    return this.tags.get(id)!
  }

  /**
   * v0.19: rename (the id stays), describe, archive or restore. An archived tag
   * stays on the engrams that carry it but cannot be assigned anew.
   */
  updateTag(id: string, patch: TagUpdate): Tag | null {
    if (!this.tags.exists(id)) return null
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
    return this.tags.get(id)
  }

  /**
   * Register a subject. The slug id is derived from `name`. Re-creating an
   * existing slug is a no-op that returns the existing subject (reuse, not
   * duplicate) — it neither reopens a closed subject nor overwrites its description.
   */
  createSubject(input: SubjectInput, at: string): Subject {
    const id = slugifySubject(input.name)
    if (!id) {
      throw new Error(
        `invalid subject name "${input.name}" — must contain at least one letter or digit`
      )
    }
    const existing = this.subjects.get(id)
    if (existing) return existing
    this.db.prepare(
      `INSERT INTO subjects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run(id, input.name.trim(), input.description ?? null, at, at)
    return this.subjects.get(id)!
  }

  /**
   * Update name / description / status (close or reopen). The id (slug) is
   * stable — renaming changes the display name only, never the reference.
   * Throws on an unknown subject.
   */
  updateSubject(id: string, patch: SubjectUpdate, at: string): Subject {
    const slug = slugifySubject(id)
    if (!this.subjects.exists(slug)) throw new Error(`subject "${id}" not found`)
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
      this.db.prepare(`UPDATE subjects SET ${fields.join(', ')} WHERE id = ?`).run(...params, at, slug)
    }
    return this.subjects.get(slug)!
  }
}
