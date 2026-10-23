import type { RelationInput } from '../types'
import { CommandError, inputObject, type CommandModule } from './types'

/** The relation verbs the DB accepts; supersedes and part_of come from writes, not from here (core says so). */
const RELATION_VERBS: ReadonlySet<string> = new Set([
  'supports', 'contradicts', 'supersedes', 'derived_from', 'refines', 'related_to', 'blocks', 'part_of',
])

/** What a relation.create payload takes; any other key is INVALID. */
const RELATION_KEYS = ['source_id', 'target_id', 'relation', 'detection_method', 'strength', 'explanation', 'metadata'] as const
const DETECTION_METHODS: ReadonlySet<string> = new Set(['manual', 'agent_declared', 'auto_temporal', 'auto_semantic'])

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
    const unknown = Object.keys(o).filter(k => !(RELATION_KEYS as readonly string[]).includes(k) && o[k] !== undefined)
    if (unknown.length > 0) {
      throw new CommandError('INVALID', `unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} — a relation takes ${RELATION_KEYS.join(', ')}`)
    }
    const detection = o.detection_method ?? 'manual'
    if (!DETECTION_METHODS.has(detection as string)) {
      throw new CommandError('INVALID', `invalid detection_method "${String(detection)}" — one of ${[...DETECTION_METHODS].join(', ')}`)
    }
    if (o.strength !== undefined && !(typeof o.strength === 'number' && Number.isFinite(o.strength))) {
      throw new CommandError('INVALID', 'strength must be a number')
    }
    if (o.explanation !== undefined && typeof o.explanation !== 'string') throw new CommandError('INVALID', 'explanation must be a string')
    if (o.metadata !== undefined && (o.metadata === null || typeof o.metadata !== 'object' || Array.isArray(o.metadata))) {
      throw new CommandError('INVALID', 'metadata must be an object')
    }
    return {
      source_id: o.source_id, target_id: o.target_id, relation: o.relation, detection_method: detection,
      ...(o.strength !== undefined ? { strength: o.strength } : {}),
      ...(o.explanation !== undefined ? { explanation: o.explanation } : {}),
      ...(o.metadata !== undefined ? { metadata: o.metadata } : {}),
    } as unknown as RelationInput
  },
  apply(ctx, input, stamp) {
    // both endpoints exist, so no dangling edge (relations has no FK)
    for (const id of [input.source_id, input.target_id]) {
      if (!ctx.eml.engrams.exists(id)) throw new CommandError('NOT_FOUND', `engram "${id}" not found`)
    }
    return { created: ctx.engrams.relate(input, stamp) }
  },
}
