import Database from 'better-sqlite3'
import {
  Project, ProjectInput, ProjectUpdate, ProjectStatus, ProjectBrainState,
  Engram, Relation
} from './types'
import { hydrateEngramTags } from './tags'
import { hydrateEngramLabels } from './labels'
import { hydrateEngramSubjects } from './subjects'
import { OPEN_TASKS_IN_SCOPE_SQL, OPEN_TASKS_COUNT_SQL } from './open-tasks'

const MAX_PARENT_DEPTH = 5

export class ProjectStore {
  constructor(private db: Database.Database) {}

  create(input: ProjectInput): Project {
    if (input.parent_project) {
      this.assertNoCycle(input.id, input.parent_project)
    }
    this.db.prepare(`
      INSERT INTO projects (
        id, name, status, goal, description, owner,
        parent_project, started_at, ended_at, metadata, status_tracks,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
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
    )
    return this.get(input.id)!
  }

  get(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any
    if (!row) return null
    return this.rowToProject(row)
  }

  list(filters?: { status?: ProjectStatus }): Project[] {
    let sql = 'SELECT * FROM projects'
    const params: any[] = []
    if (filters?.status) {
      sql += ' WHERE status = ?'
      params.push(filters.status)
    }
    sql += ' ORDER BY created_at DESC'
    return (this.db.prepare(sql).all(...params) as any[]).map(r => this.rowToProject(r))
  }

  update(id: string, patch: ProjectUpdate): Project | null {
    const existing = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any
    if (!existing) return null

    if (patch.parent_project !== undefined && patch.parent_project !== null) {
      this.assertNoCycle(id, patch.parent_project)
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

    if (fields.length === 0) return this.rowToProject(existing)

    fields.push("updated_at = datetime('now')")
    params.push(id)
    this.db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...params)
    return this.get(id)
  }

  exists(id: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)
    return !!row
  }

  /**
   * Curated brain state for a project.
   * v0.9.1 Cluster 1: namespace filter removed — 1 user = 1 brain.
   *
   * - current_status: type=status, scope=project.<id>, top 3 by updated_at DESC
   * - open_tasks: tasks with status in (planned,active), sorted priority DESC, due_date ASC, last activity DESC, limit 10
   * - recent_decisions: top 5 decisions by significance DESC, created_at DESC
   * - recent_logs: top 3 logs by created_at DESC
   * - relations: relations where source or target has scope=project.<id>, limit 20
   */
  getBrainState(id: string): ProjectBrainState | null {
    const project = this.get(id)
    if (!project) return null

    const scope = `project.${id}`

    const current_status = this.queryEngrams(`
      SELECT * FROM engrams
      WHERE scope = ? AND type = 'status'
        AND status = 'active'
      ORDER BY updated_at DESC LIMIT 3
    `, [scope])

    const open_tasks = this.queryEngrams(OPEN_TASKS_IN_SCOPE_SQL, [scope])
    const open_tasks_total = (this.db.prepare(OPEN_TASKS_COUNT_SQL).get(scope) as { n: number }).n

    const recent_decisions = this.queryEngrams(`
      SELECT * FROM engrams
      WHERE scope = ? AND type = 'decision'
      ORDER BY
        CASE significance
          WHEN 'critical' THEN 5
          WHEN 'high'     THEN 4
          WHEN 'normal'   THEN 3
          WHEN 'low'      THEN 2
          WHEN 'trivial'  THEN 1
        END DESC,
        created_at DESC
      LIMIT 5
    `, [scope])

    const recent_logs = this.queryEngrams(`
      SELECT * FROM engrams
      WHERE scope = ? AND type = 'log'
      ORDER BY created_at DESC LIMIT 3
    `, [scope])

    const relations = (this.db.prepare(`
      SELECT r.* FROM relations r
      WHERE
        r.source_id IN (SELECT id FROM engrams WHERE scope = ?)
        OR
        r.target_id IN (SELECT id FROM engrams WHERE scope = ?)
      ORDER BY r.created_at DESC LIMIT 20
    `).all(scope, scope) as any[]).map(r => this.rowToRelation(r))

    return { project, scope, current_status, open_tasks, open_tasks_total, recent_decisions, recent_logs, relations }
  }

  // === Private ===

  private assertNoCycle(childId: string, parentId: string): void {
    if (childId === parentId) {
      throw new Error(`Project cycle: ${childId} cannot be its own parent`)
    }
    let currentId: string | null = parentId
    const visited = new Set<string>([childId])
    let depth = 0
    while (currentId) {
      if (visited.has(currentId)) {
        throw new Error(`Project cycle detected: ${childId} → ... → ${currentId}`)
      }
      visited.add(currentId)
      depth++
      if (depth > MAX_PARENT_DEPTH) {
        console.warn(`[EML] Project parent-chain for "${childId}" exceeds depth ${MAX_PARENT_DEPTH}. Consider flattening.`)
        return
      }
      const row = this.db.prepare('SELECT parent_project FROM projects WHERE id = ?').get(currentId) as any
      currentId = row?.parent_project ?? null
    }
  }

  private queryEngrams(sql: string, params: any[]): Engram[] {
    // v0.12/v0.13: hydrate tags + labels via the shared helpers (same as EngramStore)
    // so brain-state snapshot engrams carry their facets too — batched, no N+1.
    const engrams = (this.db.prepare(sql).all(...params) as any[]).map(r => this.rowToEngram(r))
    hydrateEngramTags(this.db, engrams)
    hydrateEngramLabels(this.db, engrams)
    hydrateEngramSubjects(this.db, engrams)
    return engrams
  }

  private rowToProject(row: any): Project {
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      goal: row.goal ?? null,
      description: row.description ?? null,
      owner: row.owner ?? null,
      parent_project: row.parent_project ?? null,
      started_at: row.started_at ?? null,
      ended_at: row.ended_at ?? null,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      status_tracks: row.status_tracks ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  private rowToEngram(row: any): Engram {
    // v0.9 Cluster 1: namespace column dropped.
    // v0.11 team-brains: ingested_by IS exposed (authorship handle) — kept in
    // lockstep with EngramStore.rowToEngram so project/brain-state read paths
    // (getBrainState → eml_show) surface authorship too, not just /engram + /list.
    return {
      ...row,
      properties: row.properties ? JSON.parse(row.properties) : null,
      // v0.12/v0.13/v0.14: default []; queryEngrams hydrates real tags + labels + subjects.
      tags: [],
      labels: [],
      subjects: [],
    }
  }

  private rowToRelation(row: any): Relation {
    return {
      id: row.id,
      // v0.9.1 Cluster 1: namespace no longer in the TS output (DB column stays until Phase 1.4).
      source_id: row.source_id,
      target_id: row.target_id,
      relation: row.relation,
      detection_method: row.detection_method,
      strength: row.strength,
      explanation: row.explanation ?? null,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      created_at: row.created_at,
    }
  }
}
