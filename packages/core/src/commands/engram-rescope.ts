import { bumpRev } from '../entries'
import { validateScope } from '../write/scope'
import { reindexEngram } from '../write/insert'
import { activeCoreProfileIn } from '../write/supersede'
import { LEARNING_SCOPE, LEARNING_SCOPE_MESSAGE, PROFILE_SCOPE, PROFILE_SCOPE_MESSAGE, RULE_SCOPE, RULE_SCOPE_MESSAGE } from '../validate'
import { CommandError, inputObject, requireText, type CommandContext, type CommandModule } from './types'

/** engram.rescope — the /rescope body: the engrams, one or many, and where they go. */
export interface EngramRescopeInput {
  ids: string[]
  scope: string
}

export interface EngramRescopeResult {
  moved: number
  /** Already in the scope; a repeated run lands here. */
  unchanged: number
}

/** engram.rescope — move engrams of any type and status to another scope of this brain. */
export const engramRescope: CommandModule<EngramRescopeInput, EngramRescopeResult> = {
  name: 'engram.rescope',
  validate(input) {
    const o = inputObject('engram.rescope', input)
    const unknown = Object.keys(o).filter(k => !['ids', 'scope'].includes(k) && o[k] !== undefined)
    if (unknown.length > 0) throw new CommandError('INVALID', `Invalid command: unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} — engram.rescope takes ids and scope.`)
    const scope = requireText(o, 'scope', 'Invalid command: engram.rescope needs scope.')
    const ids = o.ids
    if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string' || id.length === 0)) {
      throw new CommandError('INVALID', 'Invalid command: engram.rescope needs ids, a list of at least one engram id.')
    }
    if (new Set(ids).size !== ids.length) throw new CommandError('INVALID', 'Invalid command: an id appears twice in ids.')
    return { ids: ids as string[], scope }
  },
  apply(ctx, input) {
    const missing = input.ids.filter(id => !ctx.eml.engrams.exists(id))
    if (missing.length > 0) throw new CommandError('NOT_FOUND', `engram not found: ${missing.join(', ')}`)
    return rescope(ctx, input.ids, input.scope)
  },
}

/**
 * Move engrams to another scope of this brain. The scope, the profile, rule and
 * learning scope rules and the one-per-scope rules (active status, core
 * profile) hold for the engrams that move; one already in the scope counts as
 * unchanged, so a legacy rule or learning outside its owner's scope may stay.
 * created_at and updated_at stay; rev goes up once per moved engram.
 */
function rescope(ctx: CommandContext, ids: string[], scope: string): { moved: number, unchanged: number } {
  const { db, stamp } = ctx
  validateScope(ctx, scope)
  const select = db.prepare(`SELECT id, type, status, scope, properties FROM engrams WHERE id = ?`)
  const rows = ids.map(id => select.get(id) as { id: string, type: string, status: string, scope: string, properties: string | null })
  const moving = rows.filter(r => r.scope !== scope)
  const isCore = (r: { properties: string | null }) => !!r.properties && JSON.parse(r.properties).core === true
  if (moving.some(r => r.type === 'profile') && !PROFILE_SCOPE.test(scope)) throw new Error(PROFILE_SCOPE_MESSAGE)
  if (moving.some(r => r.type === 'rule') && !RULE_SCOPE.test(scope)) throw new Error(RULE_SCOPE_MESSAGE)
  if (moving.some(r => r.type === 'learning') && !LEARNING_SCOPE.test(scope)) throw new Error(LEARNING_SCOPE_MESSAGE)
  const statuses = moving.filter(r => r.type === 'status' && r.status === 'active')
  const present = db.prepare(`SELECT 1 FROM engrams WHERE scope = ? AND type = 'status' AND status = 'active' LIMIT 1`).get(scope)
  if (statuses.length > 1 || (statuses.length === 1 && present)) {
    throw new Error(`Invalid engram: scope ${scope} can hold one active status — close the others first (a new status with eml_set_status, or invalidate one).`)
  }
  const cores = moving.filter(r => r.type === 'profile' && r.status === 'active' && isCore(r))
  if (cores.length > 1 || (cores.length === 1 && activeCoreProfileIn(db, scope, cores[0].id))) {
    throw new Error(`Invalid engram: scope ${scope} can hold one core profile — invalidate the others first.`)
  }
  const update = db.prepare(`UPDATE engrams SET scope = ? WHERE id = ?`)
  for (const r of moving) {
    update.run(scope, r.id)
    reindexEngram(db, r.id)
    bumpRev(db, stamp, r.id)
  }
  return { moved: moving.length, unchanged: rows.length - moving.length }
}
