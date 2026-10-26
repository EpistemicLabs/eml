import { exportSet, namesCrossing } from '../log/move'
import { CommandError, inputObject, type CommandModule } from './types'

/** What a move_out names: the set, its hash as imported, the crossing relations it drops, and the import in the target. */
export interface EngramMoveOutInput {
  ids: string[]
  set_hash: string
  drop_relations: string[]
  target: { brain: string, op_id: string }
}

export interface EngramMoveOutResult {
  removed: { engrams: number, entries: number, relations: number }
  dropped_relations: string[]
}

const MOVE_OUT_KEYS = ['ids', 'set_hash', 'drop_relations', 'target']

/**
 * engram.move_out — the set leaves this brain for another (spec
 * cross-brain-move-spec). moveEngrams writes it only after finding the import
 * in the target; the command itself checks that the set is unchanged
 * (set_hash) and that drop_relations are exactly the crossing relations. Its
 * tags, subjects and scope objects stay. The removal as an op (decision
 * no-delete-command). Not reachable by agents: no route calls it.
 */
export const engramMoveOut: CommandModule<EngramMoveOutInput, EngramMoveOutResult> = {
  name: 'engram.move_out',
  validate(input) {
    const o = inputObject('engram.move_out', input)
    const extra = Object.keys(o).filter(k => !MOVE_OUT_KEYS.includes(k))
    if (extra.length > 0) invalid(`unknown field${extra.length > 1 ? 's' : ''} ${extra.join(', ')} — it takes ${MOVE_OUT_KEYS.join(', ')}`)
    if (!isTextList(o.ids) || o.ids.length === 0) invalid('ids is a list of engram ids')
    if (new Set(o.ids).size !== o.ids.length) invalid('an id appears twice in ids')
    if (typeof o.set_hash !== 'string' || !/^[0-9a-f]{64}$/.test(o.set_hash)) invalid('set_hash is the set\'s hash as imported')
    if (!isTextList(o.drop_relations)) invalid('drop_relations is a list of relation ids (empty when none cross)')
    const target = o.target as Record<string, unknown> | undefined
    if (!target || typeof target.brain !== 'string' || typeof target.op_id !== 'string') {
      invalid('target is { brain: the target\'s genesis op_id, op_id: the import op there }')
    }
    return {
      ids: o.ids, set_hash: o.set_hash, drop_relations: o.drop_relations,
      target: { brain: target!.brain as string, op_id: target!.op_id as string },
    }
  },
  apply(ctx, input) {
    const { db } = ctx
    const set = exportSet(db, input.ids)
    if (set.set_hash !== input.set_hash) {
      throw new CommandError('CONFLICT', 'engram.move_out refused: the set changed since it was imported (set_hash differs); nothing was removed.')
    }
    const crossing = set.crossing.map(r => r.id).sort()
    if (!namesCrossing(set, input.drop_relations)) {
      throw new CommandError('CONFLICT', `engram.move_out refused: drop_relations must name exactly the relations crossing the set (${crossing.join(', ') || 'none'}); nothing was removed.`, { crossing })
    }

    const json = JSON.stringify(input.ids)
    const S = 'SELECT value FROM json_each(?)'
    db.prepare(`DELETE FROM engram_tags WHERE engram_id IN (${S})`).run(json)
    db.prepare(`DELETE FROM engram_subjects WHERE engram_id IN (${S})`).run(json)
    const entries = db.prepare(`DELETE FROM entries WHERE engram_id IN (${S})`).run(json).changes
    const relations = db.prepare(`DELETE FROM relations WHERE source_id IN (${S}) OR target_id IN (${S})`).run(json, json).changes
    db.prepare(`DELETE FROM engrams_fts WHERE id IN (${S})`).run(json)
    const engrams = db.prepare(`DELETE FROM engrams WHERE id IN (${S})`).run(json).changes
    return { removed: { engrams, entries, relations }, dropped_relations: crossing }
  },
}

function invalid(message: string): never {
  throw new CommandError('INVALID', `Invalid command: engram.move_out: ${message}.`)
}

function isTextList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string' && x !== '')
}
