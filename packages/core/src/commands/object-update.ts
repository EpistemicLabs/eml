import { updateObject } from '../objects'
import { CommandError, inputObject, requireText, type CommandModule } from './types'

/** object.update — the kind, the object's id and the patch. */
export interface ObjectUpdateInput {
  object: string
  id: string
  patch: Record<string, unknown>
}

/** object.update — a project, entity, tag, subject, user or agent. Was updateObject and the stores' update. */
export const objectUpdate: CommandModule<ObjectUpdateInput, { object: unknown, diff: Record<string, [unknown, unknown]> }> = {
  name: 'object.update',
  validate(input) {
    const o = inputObject('object.update', input)
    requireText(o, 'id', 'Invalid object: id is required.')
    if (!o.patch || typeof o.patch !== 'object' || Array.isArray(o.patch)) throw new CommandError('INVALID', 'Invalid object: patch must be an object.')
    return o as unknown as ObjectUpdateInput
  },
  apply(ctx, input, stamp) {
    const r = updateObject(ctx.eml, ctx.objects, input.object, input.id, input.patch, stamp.at)
    if (!r) throw new CommandError('NOT_FOUND', `${input.object} "${input.id}" not found`)
    return r
  },
}
