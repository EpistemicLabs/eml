import { extractWikilinkTargets } from '../engrams'
import { slugifyTag } from '../tags'
import type { WriteContext } from './context'
import { insertRelation } from './insert'

/**
 * v0.14 Cluster C: resolve one wikilink target to an engram id.
 * Matches an exact title, the slugified title (so `[[V014T-Target]]` finds
 * `v014t-target` — case-insensitive, consistent with tag/subject filters), an
 * exact id, or an id-prefix (≥8 chars so a short token can't fan out).
 * Ordering: the source engram's own scope first, then active, then most-recent
 * — so a `[[link]]` in a project note prefers the same-project engram over a
 * same-named one elsewhere. May resolve to the source itself; the caller skips
 * a self-match. `ambiguous` = the matches span more than one scope (a genuine
 * cross-scope collision worth a warning; a same-scope thread is not ambiguous).
 */
export function resolveWikilinkTarget(ctx: WriteContext, target: string, sourceScope: string): { id: string | null; ambiguous: boolean } {
  const slug = slugifyTag(target)          // same slugify as tags/subjects: lowercased kebab
  const low = target.toLowerCase()         // ids are lowercase hex → case-insensitive id match
  const rows = ctx.db.prepare(`
    SELECT id, scope FROM engrams
    WHERE title = ? OR title = ? OR id = ? OR (length(?) >= 8 AND id LIKE ? || '%')
    ORDER BY (scope = ?) DESC, (status = 'active') DESC, updated_at DESC, ord DESC
  `).all(target, slug, low, low, low, sourceScope) as Array<{ id: string; scope: string }>
  if (rows.length === 0) return { id: null, ambiguous: false }
  return { id: rows[0].id, ambiguous: new Set(rows.map(r => r.scope)).size > 1 }
}

/**
 * v0.14 Cluster C: materialize `[[target]]` links in `content` into idempotent
 * `related_to` edges (sourceId → resolved id, detection_method 'agent_declared',
 * metadata {source:'wikilink'} so they stay distinguishable from manual
 * eml_relate edges). ADD-ONLY: it upserts, never deletes — so a later content
 * edit that ADDS a link accrues its edge (the operative gap, §C.1) without ever
 * clobbering a manually drawn `related_to` edge. Idempotent via ON CONFLICT.
 * MUST run inside the caller's transaction. Returns resolved + unresolved
 * targets (unresolved are logged + surfaced on the write response, never dropped;
 * a cross-scope-ambiguous resolution is warned).
 */
export function materializeWikilinks(ctx: WriteContext, sourceId: string, content: string, sourceScope: string): { resolved: string[]; unresolved: string[] } {
  const resolved: string[] = []
  const unresolved: string[] = []
  // v0.17: related_to is only the fallback — a link to an engram this one is
  // already tied to by a typed edge (refines / derived_from from task_id,
  // supersedes, …) would just repeat it.
  const typed = ctx.db.prepare(
    `SELECT 1 FROM relations WHERE source_id = ? AND target_id = ? AND relation <> 'related_to' LIMIT 1`,
  )
  const META = JSON.stringify({ source: 'wikilink' })
  for (const target of extractWikilinkTargets(content)) {
    const { id: targetId, ambiguous } = resolveWikilinkTarget(ctx, target, sourceScope)
    if (!targetId) { unresolved.push(target); continue }
    if (targetId === sourceId) continue   // self-reference (only self matched) → skip silently
    if (ambiguous) {
      console.warn(`[EML] ambiguous wikilink [[${target}]] in engram ${sourceId} → ${targetId} (matches span multiple scopes; use an id to disambiguate)`)
    }
    if (!typed.get(sourceId, targetId)) insertRelation(ctx, { source_id: sourceId, target_id: targetId, relation: 'related_to', detection_method: 'agent_declared', metadata: META })
    resolved.push(targetId)
  }
  return { resolved, unresolved }
}

/**
 * v0.17: a typed edge makes the wikilink's related_to for the same pair
 * redundant — drop it. An explicitly drawn related_to (eml_relate) stays.
 */
export function dropWikilinkEcho(ctx: WriteContext, sourceId: string, targetId: string): void {
  ctx.db.prepare(`
    DELETE FROM relations
    WHERE source_id = ? AND target_id = ? AND relation = 'related_to'
      AND json_extract(metadata, '$.source') = 'wikilink'
  `).run(sourceId, targetId)
}
