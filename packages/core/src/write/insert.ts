import type { WriteContext } from './context'

// --- Rows of engrams and relations (v0.21) ---------------------------------------
//
// The one place each table's rows are inserted. A row takes the write's time
// and the next ord — the table's insertion order, the tiebreak wherever rows
// are ordered by time (a write stamps all its rows alike), and kept by a
// rebuild from the log where the rowid is not. Entries insert in entries.ts.

/** An engram row and its search entry; created_at = updated_at = the write's time, rev 1. */
export function insertEngram(ctx: WriteContext, row: {
  id: string, type: string, scope: string, title: string | null, content: string,
  status: string, properties: string | null, origin: string | null,
}): void {
  const { actor, at } = ctx.stamp
  ctx.db.prepare(`
    INSERT INTO engrams (
      id, content, type, scope, title, status, significance, properties,
      origin, ingested_by, ingestion_method, session_id, model, harness,
      created_at, updated_at, rev, ord
    ) VALUES (?, ?, ?, ?, ?, ?, 'normal', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, (SELECT COALESCE(MAX(ord), 0) + 1 FROM engrams))
  `).run(
    row.id, row.content, row.type, row.scope, row.title, row.status, row.properties,
    row.origin, actor.handle, actor.ingestion_method, actor.session_id, actor.model, actor.harness,
    at, at,
  )
  ctx.db.prepare(`INSERT INTO engrams_fts (id, content, scope, title) VALUES (?, ?, ?, ?)`)
    .run(row.id, row.content, row.scope, row.title ?? '')
}

/** A relation, unless the same (source, target, relation) exists; true when it is new. Its id is drawn here. */
export function insertRelation(ctx: WriteContext, rel: {
  source_id: string, target_id: string, relation: string, detection_method: string,
  strength?: number, explanation?: string | null, metadata?: string | null,
}): boolean {
  const info = ctx.db.prepare(`
    INSERT INTO relations (id, source_id, target_id, relation, detection_method, strength, explanation, metadata, created_at, ord)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(ord), 0) + 1 FROM relations))
    ON CONFLICT(source_id, target_id, relation) DO NOTHING
  `).run(
    ctx.stamp.newId(), rel.source_id, rel.target_id, rel.relation, rel.detection_method,
    rel.strength ?? 1.0, rel.explanation ?? null, rel.metadata ?? null, ctx.stamp.at,
  )
  return info.changes > 0
}
