import { CommandError, inputObject, requireText, type CommandModule } from './types'

// --- relation.move_end (v0.21, spec team-brain-move-project-spec §4) -----------
//
// A cross-brain reference names the brain that holds its remote end
// (source_brain / target_brain, relation-create.ts). When the engrams at that
// end move to another brain — a project leaving a space for a team brain —
// the reference keeps the engram id and gets the brain id rewritten, so a
// learning in an agent brain still finds the task it came from. The command
// names the relations exactly: each must point at from_brain, and every one is
// rewritten or none. It is an op like any write, so a rebuild replays it.
//
// Refused in a shared brain (it holds no reference into another brain) and
// when to_brain is this brain (a reference names another one).

export interface RelationMoveEndInput {
  from_brain: string
  to_brain: string
  relations: string[]
}

export interface RelationMoveEndResult {
  relations: number
}

const KEYS = ['from_brain', 'to_brain', 'relations']
const BRAIN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const relationMoveEnd: CommandModule<RelationMoveEndInput, RelationMoveEndResult> = {
  name: 'relation.move_end',
  validate(input) {
    const o = inputObject('relation.move_end', input)
    const unknown = Object.keys(o).filter(k => !KEYS.includes(k) && o[k] !== undefined)
    if (unknown.length > 0) invalid(`unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} — it takes ${KEYS.join(', ')}`)
    const brains: Record<string, string> = {}
    for (const field of ['from_brain', 'to_brain'] as const) {
      const v = requireText(o, field, `Invalid command: relation.move_end needs ${field}.`)
      if (!BRAIN_ID.test(v)) invalid(`${field} is a brain id (a lowercase UUID)`)
      brains[field] = v
    }
    if (brains.from_brain === brains.to_brain) invalid('from_brain and to_brain must differ')
    const relations = o.relations
    if (!Array.isArray(relations) || relations.length === 0 || !relations.every(r => typeof r === 'string' && r !== '')) invalid('relations is a list of relation ids')
    if (new Set(relations).size !== relations.length) invalid('a relation appears twice in relations')
    return { from_brain: brains.from_brain, to_brain: brains.to_brain, relations: relations as string[] }
  },
  apply(ctx, input) {
    if (ctx.eml.teamBrain() !== null) throw new CommandError('INVALID', 'Invalid command: a shared brain holds no relation into another brain.')
    if (input.to_brain === ctx.eml.brainId()) throw new CommandError('INVALID', `Invalid command: ${input.to_brain} is this brain — a cross-brain reference names another one.`)
    const row = ctx.db.prepare('SELECT source_brain, target_brain FROM relations WHERE id = ?')
    const sides: Array<[string, 'source_brain' | 'target_brain']> = []
    for (const id of input.relations) {
      const r = row.get(id) as { source_brain: string | null, target_brain: string | null } | undefined
      if (!r) throw new CommandError('NOT_FOUND', `relation ${id} not found`)
      const side = r.source_brain === input.from_brain ? 'source_brain' : r.target_brain === input.from_brain ? 'target_brain' : null
      if (!side) throw new CommandError('INVALID', `Invalid command: relation ${id} has no end in ${input.from_brain}.`)
      sides.push([id, side])
    }
    for (const [id, side] of sides) ctx.db.prepare(`UPDATE relations SET ${side} = ? WHERE id = ?`).run(input.to_brain, id)
    return { relations: sides.length }
  },
}

function invalid(message: string): never {
  throw new CommandError('INVALID', `Invalid command: relation.move_end: ${message}.`)
}
