import { slugifyTag } from '../tags'
import { slugifySubject } from '../subjects'
import type { WriteContext } from './context'

/**
 * v0.12: normalize incoming tag ids to slugs (consistent with tag creation, so
 * ["Deploy"] resolves to "deploy") and validate them all against the registry in
 * ONE query. Throws naming EVERY unknown tag; returns the normalized slug list to
 * persist. Enforces "only registered tags are usable" at the write path.
 */
export function normalizeAndValidateTags(ctx: WriteContext, tags: string[], current: readonly string[] = []): string[] {
  const slugs: string[] = []
  const invalid: string[] = []
  for (const t of tags) {
    const s = slugifyTag(t)
    if (s) slugs.push(s)
    else invalid.push(t)               // unslugifiable → reject, never silently drop
  }
  if (invalid.length > 0) {
    throw new Error(
      `invalid tag name "${invalid.join('", "')}" — a tag must contain at least one letter or digit`
    )
  }
  if (slugs.length === 0) return []
  const known = ctx.tags.existingIds(slugs)
  const unknown = [...new Set(slugs)].filter(s => !known.has(s))
  if (unknown.length > 0) {
    throw new Error(
      `tag "${unknown.join('", "')}" not found — create it via the tag registry first`
    )
  }
  // v0.19: an archived tag stays where it is but is not assigned anew.
  const archived = [...ctx.tags.archivedIds(slugs)].filter(t => !current.includes(t))
  if (archived.length > 0) {
    throw new Error(`Invalid engram: tag "${archived.join('", "')}" is archived — it stays on the engrams that carry it but is not assigned anew; pick an active one (eml_read_object object=tag).`)
  }
  return slugs
}

export function tagsOf(ctx: WriteContext, id: string): string[] {
  return (ctx.db.prepare('SELECT tag_id FROM engram_tags WHERE engram_id = ?').all(id) as Array<{ tag_id: string }>).map(r => r.tag_id)
}

export function subjectsOf(ctx: WriteContext, id: string): string[] {
  return (ctx.db.prepare('SELECT subject_id FROM engram_subjects WHERE engram_id = ?').all(id) as Array<{ subject_id: string }>).map(r => r.subject_id)
}

export function insertEngramTags(ctx: WriteContext, engramId: string, tags: string[]): void {
  const ins = ctx.db.prepare(
    'INSERT OR IGNORE INTO engram_tags (engram_id, tag_id, created_at) VALUES (?, ?, ?)'
  )
  for (const t of tags) ins.run(engramId, t, ctx.stamp.at)
}

/**
 * v0.14: normalize incoming subject ids to slugs and validate them against the
 * subject registry in ONE query — the tag rules (unknown → reject, naming every
 * unknown one). A CLOSED subject is accepted: filing an engram into a finished
 * strand after the fact is legitimate; the server surfaces a notice.
 */
export function normalizeAndValidateSubjects(ctx: WriteContext, subjects: string[]): string[] {
  const slugs: string[] = []
  const invalid: string[] = []
  for (const t of subjects) {
    const s = slugifySubject(t)
    if (s) slugs.push(s)
    else invalid.push(t)
  }
  if (invalid.length > 0) {
    throw new Error(
      `invalid subject name "${invalid.join('", "')}" — a subject must contain at least one letter or digit`
    )
  }
  if (slugs.length === 0) return []
  const known = ctx.subjects.statusByIds(slugs)
  const unknown = [...new Set(slugs.filter(s => !known.has(s)))]
  if (unknown.length > 0) {
    throw new Error(
      `subject "${unknown.join('", "')}" not found — create it via the subject registry first`
    )
  }
  return [...new Set(slugs)]
}

export function insertEngramSubjects(ctx: WriteContext, engramId: string, subjects: string[]): void {
  const ins = ctx.db.prepare(
    'INSERT OR IGNORE INTO engram_subjects (engram_id, subject_id, created_at) VALUES (?, ?, ?)'
  )
  for (const t of subjects) ins.run(engramId, t, ctx.stamp.at)
}

/** v0.14: full-set replace of an engram's subject memberships (update semantics). */
export function replaceEngramSubjects(ctx: WriteContext, engramId: string, subjects: string[]): void {
  ctx.db.prepare('DELETE FROM engram_subjects WHERE engram_id = ?').run(engramId)
  insertEngramSubjects(ctx, engramId, subjects)
}

/** v0.12: full-set replace of an engram's tag memberships (update semantics). */
export function replaceEngramTags(ctx: WriteContext, engramId: string, tags: string[]): void {
  ctx.db.prepare('DELETE FROM engram_tags WHERE engram_id = ?').run(engramId)
  insertEngramTags(ctx, engramId, tags)
}

/** A tag or subject set equal to the stored one is no change (no write, no rev). */
export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  return sa.size === sb.size && [...sa].every(x => sb.has(x))
}
