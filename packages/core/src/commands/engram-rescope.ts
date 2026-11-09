import { CommandError, inputObject, requireText, type CommandModule } from './types'

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
  apply(ctx, input, stamp) {
    const missing = input.ids.filter(id => !ctx.eml.engrams.exists(id))
    if (missing.length > 0) throw new CommandError('NOT_FOUND', `engram not found: ${missing.join(', ')}`)
    return ctx.engrams.rescope(input.ids, input.scope, stamp)
  },
}
