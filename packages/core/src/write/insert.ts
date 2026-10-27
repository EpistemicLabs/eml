import type Database from 'better-sqlite3'
import type { IngestionMethod } from '../types'
import type { WriteContext } from './context'

// --- Rows of engrams and relations (v0.21) ---------------------------------------
//
// The one place each table's rows are inserted. A row takes the next ord — the
// table's insertion order, the tiebreak wherever rows are ordered by time (a
// write stamps all its rows alike), and kept by a rebuild from the log where
// the rowid is not. The row writers take a full row as stored; the stamped
// helpers on top fill in the write's time, actor and ids. Entries insert in
// entries.ts.

/** An engram row as stored, without its ord. */
export interface EngramRow {
  id: string, type: string, scope: string, title: string | null, content: string,
  status: string, significance: string, properties: string | null, origin: string | null,
  ingested_by: string | null, agent: string | null, ingestion_method: IngestionMethod | null,
  session_id: string | null, model: string | null, harness: string | null,
  created_at: string, updated_at: string, rev: number,
}

/** A relation row as stored, without its ord. */
export interface RelationRow {
  id: string, source_id: string, target_id: string, relation: string, detection_method: string,
  strength: number, explanation: string | null, metadata: string | null, created_at: string,
}

/** An engram row as given, its search entry and the next ord. */
export function insertEngramRow(db: Database.Database, row: EngramRow): void {
  db.prepare(`
    INSERT INTO engrams (
      id, content, type, scope, title, status, significance, properties,
      origin, ingested_by, agent, ingestion_method, session_id, model, harness,
      created_at, updated_at, rev, ord
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(ord), 0) + 1 FROM engrams))
  `).run(
    row.id, row.content, row.type, row.scope, row.title, row.status, row.significance, row.properties,
    row.origin, row.ingested_by, row.agent, row.ingestion_method, row.session_id, row.model, row.harness,
    row.created_at, row.updated_at, row.rev,
  )
  db.prepare(`INSERT INTO engrams_fts (id, content, scope, title) VALUES (?, ?, ?, ?)`)
    .run(row.id, row.content, row.scope, row.title ?? '')
}

/** A new engram by this write: created_at = updated_at = the write's time, its actor, rev 1. */
export function insertEngram(ctx: WriteContext, row: {
  id: string, type: string, scope: string, title: string | null, content: string,
  status: string, properties: string | null, origin: string | null,
}): void {
  const { actor, at } = ctx.stamp
  insertEngramRow(ctx.db, {
    ...row, significance: 'normal',
    ingested_by: actor.handle, agent: actor.agent, ingestion_method: actor.ingestion_method,
    session_id: actor.session_id, model: actor.model, harness: actor.harness,
    created_at: at, updated_at: at, rev: 1,
  })
}

/** A relation row as given with the next ord, unless the same (source, target, relation) exists; true when it is new. */
export function insertRelationRow(db: Database.Database, row: RelationRow): boolean {
  const info = db.prepare(`
    INSERT INTO relations (id, source_id, target_id, relation, detection_method, strength, explanation, metadata, created_at, ord)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(ord), 0) + 1 FROM relations))
    ON CONFLICT(source_id, target_id, relation) DO NOTHING
  `).run(
    row.id, row.source_id, row.target_id, row.relation, row.detection_method,
    row.strength, row.explanation, row.metadata, row.created_at,
  )
  return info.changes > 0
}

/** A relation by this write, unless the same (source, target, relation) exists; true when it is new. Its id is drawn here. */
export function insertRelation(ctx: WriteContext, rel: {
  source_id: string, target_id: string, relation: string, detection_method: string,
  strength?: number, explanation?: string | null, metadata?: string | null,
}): boolean {
  return insertRelationRow(ctx.db, {
    id: ctx.stamp.newId(), source_id: rel.source_id, target_id: rel.target_id,
    relation: rel.relation, detection_method: rel.detection_method,
    strength: rel.strength ?? 1.0, explanation: rel.explanation ?? null, metadata: rel.metadata ?? null,
    created_at: ctx.stamp.at,
  })
}
