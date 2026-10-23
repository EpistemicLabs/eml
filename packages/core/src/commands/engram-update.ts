import type { StoredEngram } from '../types'
import type { EngramPatch } from '../engrams'
import { CommandError, inputObject, requireText, type CommandModule } from './types'

/** engram.update — the /update body: the engram and its patch (flat fields already split into properties). */
export interface EngramUpdateInput {
  id: string
  patch: EngramPatch
}

/** engram.update — correct or retire an engram that is not a task. Was EngramStore.update. */
export const engramUpdate: CommandModule<EngramUpdateInput, StoredEngram> = {
  name: 'engram.update',
  validate(input) {
    const o = inputObject('engram.update', input)
    requireText(o, 'id', 'Invalid engram: id is required.')
    if (!o.patch || typeof o.patch !== 'object' || Array.isArray(o.patch)) throw new CommandError('INVALID', 'Invalid engram: patch must be an object.')
    return o as unknown as EngramUpdateInput
  },
  apply(ctx, input, stamp) {
    const r = ctx.engrams.update(input.id, input.patch, stamp)
    if (!r) throw new CommandError('NOT_FOUND', 'engram not found')
    return r
  },
}
