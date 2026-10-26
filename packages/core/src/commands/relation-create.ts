import type { RelationInput } from '../types'
import { dropWikilinkEcho } from '../write/wikilinks'
import { boundTaskOf } from '../write/task-binding'
import { CommandError, inputObject, type CommandContext, type CommandModule } from './types'
import { insertRelation } from '../write/insert'

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
  apply(ctx, input) {
    // both endpoints exist, so no dangling edge (relations has no FK)
    for (const id of [input.source_id, input.target_id]) {
      if (!ctx.eml.engrams.exists(id)) throw new CommandError('NOT_FOUND', `engram "${id}" not found`)
    }
    return { created: relate(ctx, input) }
  },
}

/** Returns true if a new edge was inserted, false if it already existed (idempotent). */
function relate(ctx: CommandContext, input: RelationInput): boolean {
  const { db } = ctx
  // v0.19: supersedes and part_of are not drawn by hand — they come from
  // supersedes on a write and from a task's parent_id.
  if (input.relation === 'supersedes' || input.relation === 'part_of') {
    throw new Error(
      input.relation === 'supersedes'
        ? 'Invalid engram: supersedes is drawn by a write — supersedes on the new engram when you create it, or after the fact eml_update(new_id, supersedes=[old_id]); a task: eml_track_task(new_id, supersedes=[old_id]); a status replaces the previous one by itself.'
        : 'Invalid engram: part_of comes from a task\'s parent — eml_create_task(parent_id) or eml_track_task(parent_id).',
    )
  }
  // A decision or note bound to a task (binding task) belongs to that one task:
  // a second derived_from / refines edge to another task would close it with either.
  if (input.relation === 'derived_from' || input.relation === 'refines') {
    const src = db.prepare('SELECT type, properties FROM engrams WHERE id = ?').get(input.source_id) as { type: string, properties: string | null } | undefined
    const tgt = db.prepare('SELECT type FROM engrams WHERE id = ?').get(input.target_id) as { type: string } | undefined
    const binding = src?.properties ? JSON.parse(src.properties).binding : undefined
    if (tgt?.type === 'task' && (src?.type === 'decision' || src?.type === 'note') && binding === 'task') {
      const current = boundTaskOf(ctx, input.source_id)
      if (current && current.id !== input.target_id) {
        throw new Error(`Invalid engram: ${input.source_id} is bound to task ${current.id} — a ${src.type} is bound to one task. Make it standing first (eml_update binding=standing), or relate it with related_to.`)
      }
    }
  }
  const created = insertRelation(ctx, {
    source_id: input.source_id, target_id: input.target_id,
    relation: input.relation, detection_method: input.detection_method,
    strength: input.strength, explanation: input.explanation,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
  })
  if (input.relation !== 'related_to') dropWikilinkEcho(ctx, input.source_id, input.target_id)
  return created
}
