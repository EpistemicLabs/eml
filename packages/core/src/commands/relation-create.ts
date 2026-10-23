import type { RelationInput } from '../types'
import { CommandError, inputObject, type CommandModule } from './types'

/** The relation verbs the DB accepts; supersedes and part_of come from writes, not from here (core says so). */
const RELATION_VERBS: ReadonlySet<string> = new Set([
  'supports', 'contradicts', 'supersedes', 'derived_from', 'refines', 'related_to', 'blocks', 'part_of',
])

/** relation.create — an edge between two engrams. Was EngramStore.relate (checks were in the /relate route). */
export const relationCreate: CommandModule<RelationInput, { created: boolean }> = {
  name: 'relation.create',
  validate(input) {
    const o = inputObject('relation.create', input)
    if (!o.source_id || !o.target_id || !o.relation) throw new CommandError('INVALID', 'source_id, target_id, relation required')
    if (!RELATION_VERBS.has(o.relation as string)) {
      throw new CommandError('INVALID', `invalid relation "${o.relation}" — one of ${[...RELATION_VERBS].join(', ')}`)
    }
    if (o.source_id === o.target_id) throw new CommandError('INVALID', 'source_id and target_id must differ')
    return { ...o, detection_method: o.detection_method ?? 'manual' } as unknown as RelationInput
  },
  apply(ctx, input, stamp) {
    // both endpoints exist, so no dangling edge (relations has no FK)
    for (const id of [input.source_id, input.target_id]) {
      if (!ctx.eml.engrams.exists(id)) throw new CommandError('NOT_FOUND', `engram "${id}" not found`)
    }
    return { created: ctx.engrams.relate(input, stamp) }
  },
}
