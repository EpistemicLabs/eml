import { bumpRev } from '../entries'
import { slugifyTag } from '../tags'
import { insertEngramTagRow, normalizeAndValidateTags, tagsOf } from '../write/tags-subjects'
import { CommandError, inputObject, type CommandContext, type CommandModule } from './types'

/** engram.retag — the /retag body: the engrams, one or many, and the tags to add and to remove. */
export interface EngramRetagInput {
  ids: string[]
  add: string[]
  remove: string[]
}

export interface EngramRetagResult {
  changed: number
  /** Already carried every added tag and none of the removed ones; a repeated run lands here. */
  unchanged: number
}

/** engram.retag — add and remove tags on engrams of any type and status. */
export const engramRetag: CommandModule<EngramRetagInput, EngramRetagResult> = {
  name: 'engram.retag',
  validate(input) {
    const o = inputObject('engram.retag', input)
    const unknown = Object.keys(o).filter(k => !['ids', 'add', 'remove'].includes(k) && o[k] !== undefined)
    if (unknown.length > 0) throw new CommandError('INVALID', `Invalid command: unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} — engram.retag takes ids, add and remove.`)
    const ids = o.ids
    if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string' || id.length === 0)) {
      throw new CommandError('INVALID', 'Invalid command: engram.retag needs ids, a list of at least one engram id.')
    }
    if (new Set(ids).size !== ids.length) throw new CommandError('INVALID', 'Invalid command: an id appears twice in ids.')
    const list = (field: 'add' | 'remove'): string[] => {
      const v = o[field] ?? []
      if (!Array.isArray(v) || v.some(t => typeof t !== 'string')) throw new CommandError('INVALID', `Invalid command: ${field} is a list of tag ids.`)
      return v as string[]
    }
    const add = list('add')
    const remove = list('remove')
    if (add.length === 0 && remove.length === 0) throw new CommandError('INVALID', 'Invalid command: engram.retag needs a tag in add or remove.')
    return { ids: ids as string[], add, remove }
  },
  apply(ctx, input) {
    const missing = input.ids.filter(id => !ctx.eml.engrams.exists(id))
    if (missing.length > 0) throw new CommandError('NOT_FOUND', `engram not found: ${missing.join(', ')}`)
    return retag(ctx, input.ids, input.add, input.remove)
  },
}

/**
 * Add and remove tags on engrams. A tag to add must be registered and active;
 * a tag to remove must be registered, archived ones included, since taking an
 * archived tag off is the point of a re-sort. created_at and updated_at stay;
 * rev goes up once per changed engram.
 */
function retag(ctx: CommandContext, ids: string[], addTags: string[], removeTags: string[]): EngramRetagResult {
  const { db, stamp } = ctx
  const add = normalizeAndValidateTags(ctx, addTags)
  const remove = removeTags.map(t => slugifyTag(t))
  const known = ctx.tags.existingIds(remove.filter((t): t is string => !!t))
  const unknown = removeTags.filter((_, i) => !remove[i] || !known.has(remove[i]!))
  if (unknown.length > 0) throw new Error(`tag "${unknown.join('", "')}" not found — remove takes registered tags`)
  const both = add.filter(t => remove.includes(t))
  if (both.length > 0) throw new Error(`Invalid command: tag "${both.join('", "')}" is in add and remove.`)
  const drop = db.prepare('DELETE FROM engram_tags WHERE engram_id = ? AND tag_id = ?')
  let changed = 0
  for (const id of ids) {
    const current = tagsOf(ctx, id)
    const adding = [...new Set(add)].filter(t => !current.includes(t))
    const removing = (remove as string[]).filter(t => current.includes(t))
    if (adding.length === 0 && removing.length === 0) continue
    for (const t of removing) drop.run(id, t)
    for (const t of adding) insertEngramTagRow(db, { engram_id: id, tag_id: t, created_at: stamp.at })
    bumpRev(db, stamp, id)
    changed++
  }
  return { changed, unchanged: ids.length - changed }
}
