import Database from 'better-sqlite3'
import {
  Project, ProjectInput, ProjectUpdate, ProjectStatus, ProjectBrainState,
  Engram, Relation
} from './types'
import { hydrateEngramTags } from './tags'
import { hydrateReviewDue } from './review-due'
import { hydrateEngramSubjects } from './subjects'
import { type Env, DEFAULT_ENV } from './env'
import { OPEN_TASKS_IN_SCOPE_SQL, OPEN_TASKS_COUNT_SQL, BACKLOG_COUNT_SQL, inactivityCutoff } from './open-tasks'

const MAX_PARENT_DEPTH = 5

export class ProjectStore {
  constructor(
    private db: Database.Database,
    // v0.20: clock, ids and default actor (env.ts); reads use its clock for review_due.
    private env: Env = DEFAULT_ENV,
  ) {}

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

    const now = this.env.now()
    const cutoff = inactivityCutoff(now)
    const open_tasks = this.queryEngrams(OPEN_TASKS_IN_SCOPE_SQL, [scope, cutoff])
    const open_tasks_total = (this.db.prepare(OPEN_TASKS_COUNT_SQL).get(scope, cutoff) as { n: number }).n
    const backlog_tasks = (this.db.prepare(BACKLOG_COUNT_SQL).get(scope, cutoff) as { n: number }).n

    // v0.19.1: recency, as eml_show (engrams.buildBrainState) — significance is no
    // longer written, and old high/critical decisions stayed on top.
    const recent_decisions = this.queryEngrams(`
      SELECT * FROM engrams
      WHERE scope = ? AND type = 'decision'
      ORDER BY created_at DESC
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

    return { project, scope, current_status, open_tasks, open_tasks_total, backlog_tasks, recent_decisions, recent_logs, relations }
  }

  // === Private ===

  assertNoCycle(childId: string, parentId: string): void {
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
    // v0.12/v0.14/v0.20: hydrate tags, subjects and review_due via the shared
    // helpers (same as EngramStore) so brain-state snapshot engrams carry them
    // too — batched, no N+1.
    const engrams = (this.db.prepare(sql).all(...params) as any[]).map(r => this.rowToEngram(r))
    hydrateEngramTags(this.db, engrams)
    hydrateEngramSubjects(this.db, engrams)
    hydrateReviewDue(this.db, engrams, this.env.now())
    return engrams
  }

  rowToProject(row: any): Project {
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

  rowToEngram(row: any): Engram {
    // v0.9 Cluster 1: namespace column dropped.
    // v0.11 team-brains: ingested_by IS exposed (authorship handle) — kept in
    // lockstep with EngramStore.rowToEngram so project/brain-state read paths
    // (getBrainState → eml_show) surface authorship too, not just /engram + /list.
    return {
      ...row,
      properties: row.properties ? JSON.parse(row.properties) : null,
      // v0.12/v0.14/v0.20: defaults; queryEngrams hydrates tags, subjects and review_due.
      tags: [],
      subjects: [],
      review_due: false,
    }
  }

  rowToRelation(row: any): Relation {
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
